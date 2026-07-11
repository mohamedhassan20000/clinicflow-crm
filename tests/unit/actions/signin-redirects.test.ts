import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  queriedTables: [] as string[],
  profile: {
    data: null as Record<string, unknown> | null,
    error: null as { message: string } | null,
  },
  clinic: {
    data: null as Record<string, unknown> | null,
    error: null as { message: string } | null,
  },
  platformAdmin: {
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

async function loadAction() {
  vi.resetModules();
  vi.doMock("next/cache", () => ({ revalidatePath: vi.fn() }));
  vi.doMock("next/navigation", () => ({ redirect: vi.fn() }));
  vi.doMock("next/headers", () => ({
    headers: vi.fn(async () => new Headers({ host: "localhost:3000" })),
  }));
  vi.doMock("@/lib/rate-limit", () => ({
    checkRateLimit: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0, backendAvailable: true })),
  }));
  vi.doMock("@/lib/supabase/admin", () => ({
    provisionClinicOwner: vi.fn(),
    deleteSignupAuthUser: vi.fn(),
    findResumableSignupUser: vi.fn(),
    setSignupUserPassword: vi.fn(),
  }));
  vi.doMock("@/lib/supabase/server", () => ({
    createClient: vi.fn(async () => ({
      auth: {
        signInWithPassword: vi.fn(async () => ({
          data: { user: { id: "user-1" } },
          error: null,
        })),
        signOut: vi.fn(async () => ({ error: null })),
      },
      rpc: vi.fn(async () => ({ data: null, error: null })),
      from: vi.fn((table: string) => {
        state.queriedTables.push(table);
        if (table === "profiles") return resultBuilder(state.profile);
        if (table === "clinics") return resultBuilder(state.clinic);
        if (table === "platform_admins") return resultBuilder(state.platformAdmin);
        return resultBuilder({ data: null, error: null });
      }),
    })),
  }));
  vi.doMock("@supabase/supabase-js", () => ({ createClient: vi.fn() }));
  return import("@/actions/auth");
}

function form() {
  const data = new FormData();
  data.set("email", "owner@example.com");
  data.set("password", "OwnerPass123");
  return data;
}

function activeProfile(overrides: Record<string, unknown> = {}) {
  return {
    role: "admin",
    clinic_id: "clinic-1",
    must_change_password: false,
    is_active: true,
    is_deleted: false,
    deleted_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  state.queriedTables = [];
  state.profile = { data: activeProfile(), error: null };
  state.clinic = { data: { onboarding_completed_at: "2026-01-01T00:00:00.000Z" }, error: null };
  state.platformAdmin = { data: null, error: null };
});

describe("signIn post-login destination", () => {
  it("routes a forced password change first, without an onboarding lookup", async () => {
    state.profile.data = activeProfile({ must_change_password: true });
    const { signIn } = await loadAction();

    const result = await signIn(form());

    expect(result).toMatchObject({ ok: true, redirectTo: "/change-password" });
    expect(state.queriedTables).not.toContain("clinics");
  });

  it("routes an admin of a never-onboarded clinic to /onboarding", async () => {
    state.clinic.data = { onboarding_completed_at: null };
    const { signIn } = await loadAction();

    const result = await signIn(form());

    expect(result).toMatchObject({ ok: true, redirectTo: "/onboarding" });
  });

  it("routes an admin of an onboarded clinic to /dashboard", async () => {
    const { signIn } = await loadAction();

    const result = await signIn(form());

    expect(result).toMatchObject({ ok: true, redirectTo: "/dashboard" });
  });

  it("never routes non-admin staff into the onboarding wizard", async () => {
    state.profile.data = activeProfile({ role: "receptionist" });
    state.clinic.data = { onboarding_completed_at: null };
    const { signIn } = await loadAction();

    const result = await signIn(form());

    expect(result).toMatchObject({ ok: true, redirectTo: "/dashboard" });
    expect(state.queriedTables).not.toContain("clinics");
  });

  it("falls back to /dashboard when the clinic lookup errors, leaving middleware as backstop", async () => {
    state.clinic = { data: null, error: { message: "transient lookup failure" } };
    const { signIn } = await loadAction();

    const result = await signIn(form());

    expect(result).toMatchObject({ ok: true, redirectTo: "/dashboard" });
  });

  it("still routes a profileless platform admin to /operator", async () => {
    state.profile = { data: null, error: { message: "0 rows" } };
    state.platformAdmin = { data: { user_id: "user-1" }, error: null };
    const { signIn } = await loadAction();

    const result = await signIn(form());

    expect(result).toMatchObject({ ok: true, redirectTo: "/operator" });
  });
});
