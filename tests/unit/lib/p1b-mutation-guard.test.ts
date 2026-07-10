import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireActiveSubscription: vi.fn(),
  client: {
    auth: { getUser: vi.fn() },
    from: vi.fn(),
  },
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => mocks.client),
}));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/billing/subscriptions", () => ({
  requireActiveSubscription: mocks.requireActiveSubscription,
}));

import * as rbac from "@/lib/rbac";

const user = {
  id: "user-1",
  email: "user@example.com",
  role: "admin" as const,
  fullName: "User",
  avatarUrl: null,
  clinicId: "clinic-1",
  departmentId: null,
  mustChangePassword: false,
};

beforeEach(() => {
  mocks.requireActiveSubscription.mockReset();
  mocks.client.auth.getUser.mockResolvedValue({ data: { user: { id: user.id, email: user.email } } });
  const builder = {
    select: vi.fn(),
    eq: vi.fn(),
    single: vi.fn(),
  };
  builder.select.mockReturnValue(builder);
  builder.eq.mockReturnValue(builder);
  builder.single.mockResolvedValue({
    data: {
      role: user.role,
      full_name: user.fullName,
      avatar_url: null,
      clinic_id: user.clinicId,
      department_id: null,
      must_change_password: false,
      is_active: true,
      is_deleted: false,
      deleted_at: null,
    },
  });
  mocks.client.from.mockReturnValue(builder);
});

describe("P1B mutation guards", () => {
  it("checks the session-derived clinic before returning a mutating role", async () => {
    await expect(rbac.requireMutationRole("admin")).resolves.toEqual(user);
    expect(mocks.requireActiveSubscription).toHaveBeenCalledWith("clinic-1");
  });

  it("blocks mutation when subscription access rejects", async () => {
    mocks.requireActiveSubscription.mockRejectedValue(new Error("expired"));
    await expect(rbac.requireMutationUser()).rejects.toThrow("expired");
  });
});
