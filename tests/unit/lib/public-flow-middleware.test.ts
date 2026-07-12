import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  user: null as { id: string } | null,
  queriedTables: [] as string[],
  profile: {
    data: null as Record<string, unknown> | null,
    error: null as { message: string } | null,
  },
  subscription: {
    data: null as Record<string, unknown> | null,
    error: null as { message: string } | null,
  },
}));

function resultBuilder(result: { data: unknown; error: { message: string } | null }) {
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    single: vi.fn(async () => result),
    maybeSingle: vi.fn(async () => result),
  };
  return builder;
}

vi.mock("@supabase/ssr", () => ({
  createServerClient: vi.fn(() => ({
    auth: {
      getUser: vi.fn(async () => ({ data: { user: state.user } })),
      signOut: vi.fn(async () => undefined),
    },
    from: vi.fn((table: string) => {
      state.queriedTables.push(table);
      if (table === "profiles") return resultBuilder(state.profile);
      if (table === "subscriptions") return resultBuilder(state.subscription);
      return resultBuilder({ data: null, error: null });
    }),
  })),
}));

import { updateSession } from "@/lib/supabase/middleware";

function request(path: string, method = "GET") {
  return new NextRequest(`http://localhost${path}`, { method });
}

function redirectPath(response: Response) {
  const location = response.headers.get("location");
  return location ? new URL(location).pathname : null;
}

beforeEach(() => {
  state.user = null;
  state.queriedTables = [];
  state.profile = { data: null, error: null };
  state.subscription = { data: null, error: null };
});

describe("public-flow middleware pass-through", () => {
  const publicPaths = [
    "/signup",
    "/signup/raw-invitation-token-abc123",
    "/signup/complete",
    "/early-access",
    "/auth/confirm",
    "/forgot-password",
    "/reset-password",
  ];

  it.each(publicPaths)("allows anonymous GET %s without a redirect", async (path) => {
    const response = await updateSession(request(path));
    expect(response.status).toBe(200);
    expect(redirectPath(response)).toBeNull();
  });

  it.each(publicPaths)("allows anonymous POST %s to reach its Server Action", async (path) => {
    const response = await updateSession(request(path, "POST"));
    expect(response.status).toBe(200);
    expect(redirectPath(response)).toBeNull();
  });

  it("lets a stale/profileless session POST the signup form instead of bouncing it to /login", async () => {
    // The production regression: a session cookie (e.g. from a previous
    // half-finished signup or email confirmation) turned POST /signup/[token]
    // into an authenticated mutation, and the missing profile tripped the
    // fail-closed billing gate into a 307 → /login mid-Server-Action.
    state.user = { id: "half-signed-up-user" };
    state.profile = { data: null, error: null };

    const response = await updateSession(
      request("/signup/raw-invitation-token-abc123", "POST"),
    );

    expect(response.status).toBe(200);
    expect(redirectPath(response)).toBeNull();
    expect(state.queriedTables).toHaveLength(0);
  });

  it.each([
    ["anonymous", null, null, null],
    ["profileless", { id: "stale-user" }, null, null],
    [
      "expired subscription",
      { id: "expired-user" },
      { role: "admin", clinic_id: "clinic-1", must_change_password: false, is_active: true },
      { status: "trialing", trial_ends_at: "2020-01-01T00:00:00.000Z", current_period_end: null },
    ],
  ])("allows %s visitors to POST the exact marketing root", async (_label, user, profile, subscription) => {
    state.user = user;
    state.profile = { data: profile, error: null };
    state.subscription = { data: subscription, error: null };

    const response = await updateSession(request("/", "POST"));

    expect(response.status).toBe(200);
    expect(redirectPath(response)).toBeNull();
    expect(state.queriedTables).toHaveLength(0);
  });

  it("does not widen the exact-root exemption to protected routes", async () => {
    state.user = { id: "expired-user" };
    state.profile = {
      data: { role: "admin", clinic_id: "clinic-1", must_change_password: false, is_active: true },
      error: null,
    };
    state.subscription = {
      data: { status: "trialing", trial_ends_at: "2020-01-01T00:00:00.000Z", current_period_end: null },
      error: null,
    };

    expect(redirectPath(await updateSession(request("/patients", "POST")))).toBe("/dashboard");
  });

  it("lets a fully authenticated clinic user open and submit an invite link", async () => {
    state.user = { id: "user-1" };
    state.profile = {
      data: { role: "admin", clinic_id: "clinic-1", must_change_password: false, is_active: true },
      error: null,
    };

    await expect(updateSession(request("/signup/raw-token"))).resolves.toMatchObject({ status: 200 });
    await expect(updateSession(request("/signup/raw-token", "POST"))).resolves.toMatchObject({ status: 200 });
    await expect(updateSession(request("/signup/complete"))).resolves.toMatchObject({ status: 200 });
  });

  it("still sends anonymous users on protected GET and POST routes to /login", async () => {
    expect(redirectPath(await updateSession(request("/patients")))).toBe("/login");
    expect(redirectPath(await updateSession(request("/appointments", "POST")))).toBe("/login");
    expect(redirectPath(await updateSession(request("/dashboard")))).toBe("/login");
    expect(redirectPath(await updateSession(request("/operator")))).toBe("/login");
  });

  it("still fails closed for an authenticated profileless user on protected routes", async () => {
    state.user = { id: "user-1" };
    state.profile = { data: null, error: null };

    expect(redirectPath(await updateSession(request("/patients")))).toBe("/login");
    expect(redirectPath(await updateSession(request("/patients", "POST")))).toBe("/login");
  });

  it("still billing-gates authenticated mutations outside the public flows", async () => {
    state.user = { id: "user-1" };
    state.profile = {
      data: { role: "admin", clinic_id: "clinic-1", must_change_password: false, is_active: true },
      error: null,
    };
    state.subscription = {
      data: { status: "trialing", trial_ends_at: "2020-01-01T00:00:00.000Z", current_period_end: null },
      error: null,
    };

    expect(redirectPath(await updateSession(request("/patients", "POST")))).toBe("/dashboard");
    expect(redirectPath(await updateSession(request("/settings", "POST")))).toBe("/dashboard");
  });

  it("does not treat lookalike prefixes as public flows", async () => {
    // Prefix matching is exact-or-slash: a hypothetical protected route that
    // merely starts with the same characters must not inherit the exemption.
    expect(redirectPath(await updateSession(request("/signup-admin" as string)))).toBeNull();
    // Not protected either, so it passes through — but it must have gone
    // through the session-derived gates, not the early public-flow return.
    state.user = { id: "user-1" };
    state.profile = { data: null, error: null };
    await updateSession(request("/signupx", "POST"));
    expect(state.queriedTables).toContain("profiles");
  });
});
