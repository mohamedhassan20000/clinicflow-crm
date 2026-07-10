import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  profile: {
    data: {
      role: "admin",
      clinic_id: "clinic-1",
      must_change_password: false,
      is_active: true,
    } as Record<string, unknown> | null,
    error: null as { message: string } | null,
  },
  subscription: {
    data: {
      status: "trialing",
      trial_ends_at: "2020-01-01T00:00:00.000Z",
      current_period_end: null,
    } as Record<string, unknown> | null,
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
      getUser: vi.fn(async () => ({ data: { user: { id: "user-1" } } })),
      signOut: vi.fn(async () => undefined),
    },
    from: vi.fn((table: string) => {
      if (table === "profiles") return resultBuilder(state.profile);
      if (table === "subscriptions") return resultBuilder(state.subscription);
      return resultBuilder({ data: [], error: null });
    }),
  })),
}));

import { updateSession } from "@/lib/supabase/middleware";

function request(path: string, method = "GET") {
  return new NextRequest(`http://localhost${path}`, { method });
}

function redirectPath(response: Response) {
  const location = response.headers.get("location");
  return location ? new URL(location).pathname + new URL(location).search : null;
}

beforeEach(() => {
  state.profile.data = {
    role: "admin",
    clinic_id: "clinic-1",
    must_change_password: false,
    is_active: true,
  };
  state.profile.error = null;
  state.subscription.data = {
    status: "trialing",
    trial_ends_at: "2020-01-01T00:00:00.000Z",
    current_period_end: null,
  };
  state.subscription.error = null;
});

describe("P1B middleware billing behavior", () => {
  it("allows only dashboard GET after expiry", async () => {
    await expect(updateSession(request("/dashboard"))).resolves.toMatchObject({ status: 200 });
    expect(redirectPath(await updateSession(request("/patients")))).toBe(
      "/dashboard?billing=subscription_required",
    );
    expect(redirectPath(await updateSession(request("/dashboard", "POST")))).toBe(
      "/dashboard?billing=subscription_required",
    );
  });

  it("treats auth/public POST paths as explicit middleware exemptions", async () => {
    await expect(updateSession(request("/forgot-password", "POST"))).resolves.toMatchObject({
      status: 200,
    });
    await expect(updateSession(request("/reset-password", "POST"))).resolves.toMatchObject({
      status: 200,
    });
  });

  it("fails closed when the profile is missing or errors", async () => {
    state.profile.data = null;
    expect(redirectPath(await updateSession(request("/patients")))).toBe("/login");
    expect(redirectPath(await updateSession(request("/dashboard")))).toBe("/login");
    state.profile.error = { message: "profile lookup failed" };
    expect(redirectPath(await updateSession(request("/patients")))).toBe("/login");
  });

  it("fails closed when subscription lookup errors", async () => {
    state.subscription.data = null;
    state.subscription.error = { message: "subscription lookup failed" };
    expect(redirectPath(await updateSession(request("/patients")))).toBe(
      "/dashboard?billing=subscription_required",
    );
  });

  it("allows protected reads and writes for an active subscription", async () => {
    state.subscription.data = {
      status: "active",
      trial_ends_at: null,
      current_period_end: null,
    };
    await expect(updateSession(request("/patients"))).resolves.toMatchObject({ status: 200 });
    await expect(updateSession(request("/patients", "POST"))).resolves.toMatchObject({ status: 200 });
  });
});
