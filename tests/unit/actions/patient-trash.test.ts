import { beforeEach, describe, expect, it, vi } from "vitest";
import { createServerActionMocks } from "../helpers/server-action-mocks";

const PATIENT_ID = "33333333-3333-4333-8333-333333333333";
const CLINIC_ID = "clinic-1";

async function loadPatientActions() {
  vi.resetModules();
  const mocks = createServerActionMocks();

  vi.doMock("next/cache", () => ({
    revalidatePath: mocks.state.revalidatePath,
  }));
  vi.doMock("next/navigation", () => ({
    redirect: mocks.state.redirect,
  }));
  vi.doMock("@/lib/rbac", () => ({
    requireRole: mocks.state.requireRole,
  }));
  vi.doMock("@/lib/supabase/server", () => ({
    createClient: vi.fn(async () => mocks.client()),
  }));
  vi.doMock("@/lib/supabase/admin", () => ({
    createAdminClient: vi.fn(() => mocks.client()),
  }));

  const patients = await import("@/actions/patients");
  return { ...patients, mocks };
}

function adminUser() {
  return { id: "user-1", clinicId: CLINIC_ID, role: "admin" as const };
}

function receptionistUser() {
  return { id: "user-2", clinicId: CLINIC_ID, role: "receptionist" as const };
}

// ── getTrashPatients ──────────────────────────────────────────────────────────

describe("getTrashPatients", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("returns deleted, non-archived patients for the clinic", async () => {
    const { getTrashPatients, mocks } = await loadPatientActions();
    mocks.state.requireRole.mockResolvedValue(adminUser());
    mocks.state.tableResults["patients"] = {
      data: [
        { id: PATIENT_ID, full_name: "Test Patient", is_deleted: true, is_archived: false, deleted_at: "2026-05-01T00:00:00Z" },
      ],
      error: null,
    };

    const result = await getTrashPatients();

    expect(result.error).toBeUndefined();
    expect(result.data).toHaveLength(1);
    expect(result.data?.[0]?.id).toBe(PATIENT_ID);
  });

  it("allows receptionist to fetch trash", async () => {
    const { getTrashPatients, mocks } = await loadPatientActions();
    mocks.state.requireRole.mockResolvedValue(receptionistUser());
    mocks.state.tableResults["patients"] = { data: [], error: null };

    const result = await getTrashPatients();

    expect(result.error).toBeUndefined();
  });

  it("returns error when DB query fails", async () => {
    const { getTrashPatients, mocks } = await loadPatientActions();
    mocks.state.requireRole.mockResolvedValue(adminUser());
    mocks.state.tableResults["patients"] = { data: null, error: { message: "db error" } };

    const result = await getTrashPatients();

    expect(result.error).toMatch(/trash/i);
  });
});

// ── getArchivePatients ────────────────────────────────────────────────────────

describe("getArchivePatients", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("returns archived patients for the clinic", async () => {
    const { getArchivePatients, mocks } = await loadPatientActions();
    mocks.state.requireRole.mockResolvedValue(adminUser());
    mocks.state.tableResults["patients"] = {
      data: [
        { id: PATIENT_ID, full_name: "Archived Patient", is_archived: true, archived_at: "2026-04-01T00:00:00Z" },
      ],
      error: null,
    };

    const result = await getArchivePatients();

    expect(result.error).toBeUndefined();
    expect(result.data).toHaveLength(1);
  });

  it("returns error when DB query fails", async () => {
    const { getArchivePatients, mocks } = await loadPatientActions();
    mocks.state.requireRole.mockResolvedValue(adminUser());
    mocks.state.tableResults["patients"] = { data: null, error: { message: "db error" } };

    const result = await getArchivePatients();

    expect(result.error).toMatch(/archive/i);
  });
});

// ── archivePatient ────────────────────────────────────────────────────────────

describe("archivePatient", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("sets is_archived=true and archived_at for the patient", async () => {
    const { archivePatient, mocks } = await loadPatientActions();
    mocks.state.requireRole.mockResolvedValue(adminUser());
    mocks.state.tableResults["patients"] = { data: null, error: null };

    const result = await archivePatient(PATIENT_ID);

    expect(result.error).toBeUndefined();
    expect(mocks.state.queryLog).toContainEqual(
      expect.objectContaining({
        table: "patients",
        operation: "update",
        args: [expect.objectContaining({ is_archived: true })],
      }),
    );
    expect(mocks.state.revalidatePath).toHaveBeenCalledWith("/patients/trash");
    expect(mocks.state.revalidatePath).toHaveBeenCalledWith("/patients/archive");
  });

  it("requires admin role", async () => {
    const { archivePatient, mocks } = await loadPatientActions();
    mocks.state.requireRole.mockRejectedValue(new Error("admin only"));

    await expect(archivePatient(PATIENT_ID)).rejects.toThrow("admin only");
  });

  it("returns error when DB update fails", async () => {
    const { archivePatient, mocks } = await loadPatientActions();
    mocks.state.requireRole.mockResolvedValue(adminUser());
    mocks.state.tableResults["patients"] = { data: null, error: { message: "db error" } };

    const result = await archivePatient(PATIENT_ID);

    expect(result.error).toMatch(/archive/i);
  });
});

// ── archiveAllTrashPatients ───────────────────────────────────────────────────

describe("archiveAllTrashPatients", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("archives all trash patients for the clinic", async () => {
    const { archiveAllTrashPatients, mocks } = await loadPatientActions();
    mocks.state.requireRole.mockResolvedValue(adminUser());
    mocks.state.tableResults["patients"] = { data: null, error: null };

    const result = await archiveAllTrashPatients();

    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(mocks.state.queryLog).toContainEqual(
      expect.objectContaining({
        table: "patients",
        operation: "update",
        args: [expect.objectContaining({ is_archived: true })],
      }),
    );
  });

  it("requires admin role", async () => {
    const { archiveAllTrashPatients, mocks } = await loadPatientActions();
    mocks.state.requireRole.mockRejectedValue(new Error("admin only"));

    await expect(archiveAllTrashPatients()).rejects.toThrow("admin only");
  });

  it("returns error on DB failure", async () => {
    const { archiveAllTrashPatients, mocks } = await loadPatientActions();
    mocks.state.requireRole.mockResolvedValue(adminUser());
    mocks.state.tableResults["patients"] = { data: null, error: { message: "db error" } };

    const result = await archiveAllTrashPatients();

    expect(result.error).toMatch(/archive/i);
  });
});

// ── restoreArchivedPatient ────────────────────────────────────────────────────

describe("restoreArchivedPatient", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("clears is_deleted, is_archived, deleted_at, and archived_at", async () => {
    const { restoreArchivedPatient, mocks } = await loadPatientActions();
    mocks.state.requireRole.mockResolvedValue(adminUser());
    mocks.state.tableResults["patients"] = { data: null, error: null };

    const result = await restoreArchivedPatient(PATIENT_ID);

    expect(result.error).toBeUndefined();
    expect(mocks.state.queryLog).toContainEqual(
      expect.objectContaining({
        table: "patients",
        operation: "update",
        args: [
          expect.objectContaining({
            is_deleted: false,
            is_archived: false,
            deleted_at: null,
            archived_at: null,
          }),
        ],
      }),
    );
    expect(mocks.state.revalidatePath).toHaveBeenCalledWith("/patients/trash");
    expect(mocks.state.revalidatePath).toHaveBeenCalledWith("/patients/archive");
  });

  it("requires admin role", async () => {
    const { restoreArchivedPatient, mocks } = await loadPatientActions();
    mocks.state.requireRole.mockRejectedValue(new Error("admin only"));

    await expect(restoreArchivedPatient(PATIENT_ID)).rejects.toThrow("admin only");
  });
});
