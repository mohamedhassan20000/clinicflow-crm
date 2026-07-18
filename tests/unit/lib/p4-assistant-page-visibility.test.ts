import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  primary: { data: null as unknown, error: null as { code?: string; message?: string } | null },
  fallback: { data: null as unknown, error: null as { code?: string; message?: string } | null },
}));

function builder(result: typeof mocks.primary | typeof mocks.fallback) {
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    maybeSingle: vi.fn(async () => result),
    then: vi.fn(
      <TResult1 = typeof result, TResult2 = never>(
        onfulfilled?: ((value: typeof result) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
      ) => Promise.resolve(result).then(onfulfilled, onrejected),
    ),
  };
  return query;
}

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    from: vi.fn((table: string) =>
      builder(table === "user_page_permissions" ? mocks.primary : mocks.fallback),
    ),
  })),
}));

import {
  getPageVisibilityState,
  getVisiblePageSlugs,
} from "@/lib/server-page-permissions";

const user = {
  id: "user-1",
  clinicId: "clinic-1",
  email: "staff@example.com",
  role: "receptionist" as const,
  fullName: "Staff",
  avatarUrl: null,
  departmentId: null,
  mustChangePassword: false,
};

beforeEach(() => {
  mocks.primary.data = null;
  mocks.primary.error = null;
  mocks.fallback.data = null;
  mocks.fallback.error = null;
});

describe("Assistant persisted page visibility", () => {
  it("uses the saved per-user denial instead of role defaults", async () => {
    mocks.primary.data = { is_visible: false };
    await expect(getPageVisibilityState(user, "assistant")).resolves.toBe("hidden");
  });

  it("removes a saved hidden Assistant from the sidebar source", async () => {
    mocks.primary.data = [{ page_slug: "assistant", is_visible: false }];
    await expect(getVisiblePageSlugs(user)).resolves.not.toContain("assistant");
  });

  it("defaults a supported role to visible only when the lookup succeeds with no override", async () => {
    await expect(getPageVisibilityState(user, "assistant")).resolves.toBe("visible");
  });

  it("fails closed on an unexpected permissions lookup failure", async () => {
    mocks.primary.error = { code: "57014", message: "statement timeout" };
    await expect(getPageVisibilityState(user, "assistant")).resolves.toBe("lookup_failed");
  });

  it("uses the legacy persisted source only when the new table is missing", async () => {
    mocks.primary.error = {
      code: "PGRST205",
      message: "Could not find the table public.user_page_permissions",
    };
    mocks.fallback.data = { access: "hidden" };
    await expect(getPageVisibilityState(user, "assistant")).resolves.toBe("hidden");
  });
});
