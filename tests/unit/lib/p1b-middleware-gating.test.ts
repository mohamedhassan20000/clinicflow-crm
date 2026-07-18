import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  queriedTables: [] as string[],
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
  clinic: {
    data: { onboarding_completed_at: "2026-01-01T00:00:00.000Z" } as Record<string, unknown> | null,
    error: null as { message: string } | null,
  },
  platformAdmin: {
    data: null as Record<string, unknown> | null,
    error: null as { message: string } | null,
  },
  pagePermissions: {
    data: [] as { page_slug: string; is_visible: boolean }[],
    error: null as { message: string; code?: string } | null,
  },
}));

function resultBuilder(result: {
  data: unknown;
  error: { message: string; code?: string } | null;
}) {
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    single: vi.fn(async () => result),
    maybeSingle: vi.fn(async () => result),
    then: vi.fn(
      <TResult1 = typeof result, TResult2 = never>(
        onfulfilled?: ((value: typeof result) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
      ) => Promise.resolve(result).then(onfulfilled, onrejected),
    ),
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
      state.queriedTables.push(table);
      if (table === "profiles") return resultBuilder(state.profile);
      if (table === "subscriptions") return resultBuilder(state.subscription);
      if (table === "clinics") return resultBuilder(state.clinic);
      if (table === "platform_admins") return resultBuilder(state.platformAdmin);
      if (table === "user_page_permissions") return resultBuilder(state.pagePermissions);
      return resultBuilder({ data: [], error: null });
    }),
  })),
}));

import { updateSession } from "@/lib/supabase/middleware";

function request(path: string, method = "GET", cookie?: string) {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: cookie ? { cookie } : undefined,
  });
}

function redirectPath(response: Response) {
  const location = response.headers.get("location");
  return location ? new URL(location).pathname + new URL(location).search : null;
}

beforeEach(() => {
  state.queriedTables = [];
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
  state.clinic.data = { onboarding_completed_at: "2026-01-01T00:00:00.000Z" };
  state.clinic.error = null;
  state.platformAdmin.data = null;
  state.platformAdmin.error = null;
  state.pagePermissions.data = [];
  state.pagePermissions.error = null;
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
    expect(state.queriedTables).not.toContain("subscriptions");
    expect(state.queriedTables).not.toContain("clinics");
  });

  it("fails closed when the profile is missing or errors", async () => {
    state.profile.data = null;
    expect(redirectPath(await updateSession(request("/patients")))).toBe("/login");
    expect(redirectPath(await updateSession(request("/dashboard")))).toBe("/login");
    state.profile.error = { message: "profile lookup failed" };
    expect(redirectPath(await updateSession(request("/patients")))).toBe("/login");
  });

  it("routes a profileless platform admin to operator from login and clinic paths", async () => {
    state.profile.data = null;
    state.platformAdmin.data = { user_id: "user-1" };
    expect(redirectPath(await updateSession(request("/login")))).toBe("/operator");
    expect(redirectPath(await updateSession(request("/dashboard")))).toBe("/operator");
  });

  it("signs a true profileless orphan out instead of creating a redirect loop", async () => {
    state.profile.data = null;
    state.platformAdmin.data = null;
    expect(redirectPath(await updateSession(request("/login")))).toBe("/login");
    expect(redirectPath(await updateSession(request("/dashboard")))).toBe("/login");
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

  it.each(["admin", "manager", "doctor", "receptionist"])(
    "allows the saved Assistant route for an active %s",
    async (role) => {
      state.profile.data = {
        role,
        clinic_id: "clinic-1",
        must_change_password: false,
        is_active: true,
      };
      state.subscription.data = {
        status: "active",
        trial_ends_at: null,
        current_period_end: null,
      };
      state.pagePermissions.data = [{ page_slug: "assistant", is_visible: true }];

      await expect(updateSession(request("/assistant"))).resolves.toMatchObject({ status: 200 });
    },
  );

  it("enforces a saved hidden Assistant route even when its old visibility cookie is forged", async () => {
    state.profile.data = {
      role: "receptionist",
      clinic_id: "clinic-1",
      must_change_password: false,
      is_active: true,
    };
    state.subscription.data = {
      status: "active",
      trial_ends_at: null,
      current_period_end: null,
    };
    state.pagePermissions.data = [{ page_slug: "assistant", is_visible: false }];

    const response = await updateSession(
      request(
        "/assistant",
        "GET",
        "cf_page_visibility=user-1:receptionist:dashboard,assistant",
      ),
    );

    expect(redirectPath(response)).toBe("/dashboard");
    expect(state.queriedTables).toContain("user_page_permissions");
  });

  it("fails closed when saved Assistant visibility cannot be resolved", async () => {
    state.profile.data = {
      role: "doctor",
      clinic_id: "clinic-1",
      must_change_password: false,
      is_active: true,
    };
    state.subscription.data = {
      status: "active",
      trial_ends_at: null,
      current_period_end: null,
    };
    state.pagePermissions.error = { message: "temporary permissions failure" };

    expect(redirectPath(await updateSession(request("/assistant")))).toBe("/dashboard");
  });

  it("gates an active clinic on onboarding without looping an expired clinic", async () => {
    state.subscription.data = {
      status: "active",
      trial_ends_at: null,
      current_period_end: null,
    };
    state.clinic.data = { onboarding_completed_at: null };
    expect(redirectPath(await updateSession(request("/patients")))).toBe("/onboarding");
    await expect(updateSession(request("/onboarding"))).resolves.toMatchObject({ status: 200 });

    state.subscription.data = {
      status: "trialing",
      trial_ends_at: "2020-01-01T00:00:00.000Z",
      current_period_end: null,
    };
    await expect(updateSession(request("/dashboard"))).resolves.toMatchObject({ status: 200 });
  });

  it.each(["receptionist", "doctor"])(
    "does not redirect an incomplete %s clinic member into the admin wizard",
    async (role) => {
      state.profile.data = {
        role,
        clinic_id: "clinic-1",
        must_change_password: false,
        is_active: true,
      };
      state.subscription.data = {
        status: "active",
        trial_ends_at: null,
        current_period_end: null,
      };
      state.clinic.data = { onboarding_completed_at: null };

      await expect(updateSession(request("/patients"))).resolves.toMatchObject({ status: 200 });
      expect(state.queriedTables).not.toContain("clinics");
    },
  );

  it("admits platform admins to operator routes without any clinic billing gate", async () => {
    state.platformAdmin.data = { user_id: "user-1" };
    state.profile.data = null; // platform admins hold no clinic profile

    await expect(updateSession(request("/operator"))).resolves.toMatchObject({ status: 200 });
    await expect(updateSession(request("/operator/settings", "POST"))).resolves.toMatchObject({
      status: 200,
    });
    expect(state.queriedTables).not.toContain("subscriptions");
    expect(state.queriedTables).not.toContain("clinics");
  });

  it("admits a dual-role platform admin whose clinic profile is active and settled", async () => {
    state.platformAdmin.data = { user_id: "user-1" };
    state.profile.data = {
      role: "admin",
      clinic_id: "clinic-1",
      must_change_password: false,
      is_active: true,
    };

    await expect(updateSession(request("/operator"))).resolves.toMatchObject({ status: 200 });
    expect(state.queriedTables).not.toContain("subscriptions");
  });

  it("denies a dual-role platform admin whose clinic profile is deactivated", async () => {
    state.platformAdmin.data = { user_id: "user-1" };
    state.profile.data = {
      role: "admin",
      clinic_id: "clinic-1",
      must_change_password: false,
      is_active: false,
    };

    expect(redirectPath(await updateSession(request("/operator")))).toBe("/login");
    expect(redirectPath(await updateSession(request("/operator/settings", "POST")))).toBe("/login");
  });

  it("forces a dual-role platform admin through a pending password change first", async () => {
    state.platformAdmin.data = { user_id: "user-1" };
    state.profile.data = {
      role: "admin",
      clinic_id: "clinic-1",
      must_change_password: true,
      is_active: true,
    };

    expect(redirectPath(await updateSession(request("/operator")))).toBe("/change-password");
  });

  it("redirects non-platform-admins away from every operator route", async () => {
    expect(redirectPath(await updateSession(request("/operator")))).toBe("/dashboard");
    expect(redirectPath(await updateSession(request("/operator/coupons", "POST")))).toBe(
      "/dashboard",
    );
  });

  it("does not turn a transient clinic lookup error into an onboarding redirect", async () => {
    state.subscription.data = {
      status: "active",
      trial_ends_at: null,
      current_period_end: null,
    };
    state.clinic.data = null;
    state.clinic.error = { message: "temporary clinic lookup failure" };

    await expect(updateSession(request("/dashboard"))).resolves.toMatchObject({ status: 200 });
  });
});
