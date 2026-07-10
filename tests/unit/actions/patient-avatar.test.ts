import { beforeEach, describe, expect, it, vi } from "vitest";
import { createServerActionMocks } from "../helpers/server-action-mocks";

const PATIENT_ID = "22222222-2222-4222-8222-222222222222";
const CLINIC_ID = "clinic-1";
const AVATAR_PATH = `avatars/${CLINIC_ID}/${PATIENT_ID}/avatar.webp`;

function avatarForm(fileType = "image/webp") {
  const form = new FormData();
  form.set("avatar", new File(["avatar"], "avatar.webp", { type: fileType }));
  return form;
}

async function loadPatientAvatarActions() {
  vi.resetModules();
  const mocks = createServerActionMocks();

  vi.doMock("next/cache", () => ({
    revalidatePath: mocks.state.revalidatePath,
  }));
  vi.doMock("@/lib/rbac", () => ({
    requireRole: mocks.state.requireRole,
    requireMutationRole: mocks.state.requireRole,
  }));
  vi.doMock("@/lib/supabase/server", () => ({
    createClient: vi.fn(async () => mocks.client()),
  }));

  const actions = await import("@/actions/patient-avatar");
  return { ...actions, mocks };
}

describe("patient avatar actions", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("allows admin/receptionist avatar upload and stores the scoped avatar path", async () => {
    const { uploadPatientAvatar, mocks } = await loadPatientAvatarActions();
    mocks.state.authedUser.role = "admin";
    mocks.state.tableResults["patients.select"] = {
      data: { id: PATIENT_ID, avatar_path: null },
      error: null,
    };
    mocks.state.tableResults["patients.update"] = { data: null, error: null };

    const result = await uploadPatientAvatar(PATIENT_ID, avatarForm());

    expect(result).toEqual({ ok: true });
    expect(mocks.state.requireRole).toHaveBeenCalledWith([
      "admin",
      "receptionist",
    ]);
    expect(mocks.state.storageLog).toContainEqual(
      expect.objectContaining({
        bucket: "patient-assets",
        operation: "upload",
        args: [
          AVATAR_PATH,
          expect.any(Uint8Array),
          expect.objectContaining({
            contentType: "image/webp",
            upsert: true,
          }),
        ],
      }),
    );
    expect(mocks.state.queryLog).toContainEqual(
      expect.objectContaining({
        table: "patients",
        operation: "update",
        args: [
          expect.objectContaining({
            avatar_path: AVATAR_PATH,
            updated_by: "user-1",
          }),
        ],
      }),
    );
  });

  it("blocks unauthorized avatar upload before storage access", async () => {
    const { uploadPatientAvatar, mocks } = await loadPatientAvatarActions();
    mocks.state.requireRole.mockRejectedValue(new Error("redirected"));

    await expect(uploadPatientAvatar(PATIENT_ID, avatarForm())).rejects.toThrow(
      "redirected",
    );

    expect(mocks.state.from).not.toHaveBeenCalled();
    expect(mocks.state.storageFrom).not.toHaveBeenCalled();
  });

  it("allows admin/receptionist avatar removal only for the expected patient path", async () => {
    const { removePatientAvatar, mocks } = await loadPatientAvatarActions();
    mocks.state.authedUser.role = "receptionist";
    mocks.state.tableResults["patients.select"] = {
      data: { id: PATIENT_ID, avatar_path: AVATAR_PATH },
      error: null,
    };
    mocks.state.tableResults["patients.update"] = { data: null, error: null };

    const result = await removePatientAvatar(PATIENT_ID);

    expect(result).toEqual({ ok: true });
    expect(mocks.state.requireRole).toHaveBeenCalledWith([
      "admin",
      "receptionist",
    ]);
    expect(mocks.state.queryLog).toContainEqual(
      expect.objectContaining({
        table: "patients",
        operation: "update",
        args: [
          expect.objectContaining({
            avatar_path: null,
            updated_by: "user-1",
          }),
        ],
      }),
    );
    expect(mocks.state.storageLog).toContainEqual(
      expect.objectContaining({
        bucket: "patient-assets",
        operation: "remove",
        args: [[AVATAR_PATH]],
      }),
    );
  });

  it("blocks unauthorized avatar removal before storage access", async () => {
    const { removePatientAvatar, mocks } = await loadPatientAvatarActions();
    mocks.state.requireRole.mockRejectedValue(new Error("redirected"));

    await expect(removePatientAvatar(PATIENT_ID)).rejects.toThrow("redirected");

    expect(mocks.state.from).not.toHaveBeenCalled();
    expect(mocks.state.storageFrom).not.toHaveBeenCalled();
  });

  it("refuses to remove an avatar outside the expected patient avatar prefix", async () => {
    const { removePatientAvatar, mocks } = await loadPatientAvatarActions();
    mocks.state.tableResults["patients.select"] = {
      data: {
        id: PATIENT_ID,
        avatar_path: `avatars/${CLINIC_ID}/different-patient/avatar.webp`,
      },
      error: null,
    };

    const result = await removePatientAvatar(PATIENT_ID);

    expect(result).toEqual({
      error: "Stored avatar path is not valid for this patient.",
    });
    expect(
      mocks.state.queryLog.some(
        (entry) => entry.table === "patients" && entry.operation === "update",
      ),
    ).toBe(false);
    expect(mocks.state.storageRemove).not.toHaveBeenCalled();
  });
});
