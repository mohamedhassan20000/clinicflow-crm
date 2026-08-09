import { beforeEach, describe, expect, it, vi } from "vitest";
import { createServerActionMocks } from "../helpers/server-action-mocks";

async function loadCredentialActions() {
  vi.resetModules();
  const mocks = createServerActionMocks();
  vi.doMock("@/lib/rbac", () => ({
    requireRole: mocks.state.requireRole,
    requireMutationRole: mocks.state.requireMutationRole,
  }));
  vi.doMock("@/lib/supabase/server", () => ({
    createClient: vi.fn(async () => mocks.client()),
  }));
  vi.doMock("next/cache", () => ({
    revalidatePath: mocks.state.revalidatePath,
    revalidateTag: vi.fn(),
  }));
  const actions = await import("@/actions/clinical/credentials");
  return { ...actions, mocks };
}

describe("clinician credential section save", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("updates only credential-owned fields for the current staff member", async () => {
    const { saveClinicianCredentials, mocks } = await loadCredentialActions();
    mocks.state.authedUser.role = "admin";
    mocks.state.tableResults["profiles.select"] = {
      data: { id: "doctor-2", role: "doctor", signature_path: null },
      error: null,
    };
    mocks.state.tableResults["profiles.update"] = {
      data: { id: "doctor-2" },
      error: null,
    };
    const payload = new FormData();
    payload.set("professional_license_no", "LIC-2");
    payload.set("specialty", "Dermatology");
    payload.set("professional_title", "Consultant");
    payload.set("signature_action", "keep");

    const result = await saveClinicianCredentials("doctor-2", payload);

    expect(result.error).toBeUndefined();
    const update = mocks.state.queryLog.find((entry) =>
      entry.table === "profiles" && entry.operation === "update");
    expect(update?.args[0]).toEqual({
      professional_license_no: "LIC-2",
      specialty: "Dermatology",
      professional_title: "Consultant",
    });
    expect(update?.args[0]).not.toHaveProperty("avatar_url");
    expect(update?.args[0]).not.toHaveProperty("full_name");
    expect(update?.args[0]).not.toHaveProperty("role");
    expect(mocks.state.queryLog).toContainEqual(expect.objectContaining({
      table: "profiles",
      args: ["eq", "id", "doctor-2"],
    }));
  });
});
