import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  provision: vi.fn(),
  deleteUser: vi.fn(),
  findOrphan: vi.fn(),
  signUp: vi.fn(),
  rpc: vi.fn(),
}));

function form() {
  const data = new FormData();
  data.set("clinicName", "Compensation Clinic");
  data.set("country", "KW");
  data.set("phone", "50002000");
  data.set("ownerName", "Compensation Owner");
  data.set("email", "compensation@example.com");
  data.set("password", "Compensation123");
  data.set("locale", "ar");
  return data;
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
    provisionClinicOwner: state.provision,
    deleteSignupAuthUser: state.deleteUser,
    findResumableSignupUserId: state.findOrphan,
  }));
  vi.doMock("@/lib/supabase/server", () => ({
    createClient: vi.fn(async () => ({
      auth: { signUp: state.signUp },
      rpc: state.rpc,
    })),
  }));
  vi.doMock("@supabase/supabase-js", () => ({ createClient: vi.fn() }));
  return import("@/actions/auth");
}

describe("P1C signup Auth-user compensation", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    state.rpc.mockResolvedValue({
      data: [{ allowed: true, invitation_id: null, email: null }],
      error: null,
    });
    state.signUp.mockResolvedValue({
      data: {
        user: {
          id: "new-owner-id",
          email: "compensation@example.com",
          identities: [{ id: "identity-id" }],
        },
      },
      error: null,
    });
    state.provision.mockResolvedValue({
      data: null,
      error: { message: "forced provisioning failure" },
    });
    state.deleteUser.mockResolvedValue({ data: {}, error: null });
  });

  it("deletes the newly created Auth user after a forced provisioning RPC failure", async () => {
    const { signUpClinic } = await loadAction();

    const result = await signUpClinic(null, form());

    expect(result.error).toBe("Clinic setup could not be completed. Please retry with the same details.");
    expect(state.provision).toHaveBeenCalledWith(expect.objectContaining({ ownerId: "new-owner-id" }));
    expect(state.deleteUser).toHaveBeenCalledWith("new-owner-id");
  });
});
