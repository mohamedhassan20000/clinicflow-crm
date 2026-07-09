import { beforeEach, describe, expect, it, vi } from "vitest";
import { createServerActionMocks } from "../helpers/server-action-mocks";

const PATIENT_ID = "22222222-2222-4222-8222-222222222222";

function patientForm(overrides: Record<string, string> = {}) {
  const form = new FormData();
  form.set("full_name", "Test Patient");
  form.set("national_id", "TC12345");
  form.set("date_of_birth", "1990-01-01");
  form.set("phone", "+905551234567");
  form.set("email", "patient@clinic.com");
  form.set("blood_type", "");
  form.set("department_id", "");
  form.set("assigned_doctor_id", "");
  form.set("insurance_provider_id", "");
  for (const [key, value] of Object.entries(overrides)) {
    form.set(key, value);
  }
  return form;
}

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
    createClinicScopedAdminClient: vi.fn(() => mocks.client()),
  }));

  const patients = await import("@/actions/patients");
  return { ...patients, mocks };
}

describe("createPatient", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("creates a patient, assigns a file number, and returns the patient ID", async () => {
    const { createPatient, mocks } = await loadPatientActions();
    // First call: generateFileNumber (select from patients)
    // Second call: insert().select("id").single() — resolves as "select" in mock
    mocks.state.tableResults["patients.select"] = [
      { data: [], error: null },
      { data: { id: PATIENT_ID }, error: null },
    ];

    const result = await createPatient(null, patientForm());

    expect(result).toMatchObject({ success: true, patientId: PATIENT_ID });
    expect(mocks.state.redirect).not.toHaveBeenCalled();
    expect(mocks.state.revalidatePath).toHaveBeenCalledWith("/patients");
    expect(mocks.state.queryLog).toContainEqual(
      expect.objectContaining({
        table: "patients",
        operation: "insert",
        args: [
          expect.objectContaining({
            clinic_id: "clinic-1",
          }),
        ],
      }),
    );
  });

  it("generates sequential file numbers using the CF-NNNN format", async () => {
    const { createPatient, mocks } = await loadPatientActions();
    mocks.state.tableResults["patients.select"] = [
      { data: [{ file_number: "CF-0005" }], error: null },
      { data: { id: PATIENT_ID }, error: null },
    ];

    await createPatient(null, patientForm());

    expect(mocks.state.queryLog).toContainEqual(
      expect.objectContaining({
        table: "patients",
        operation: "insert",
        args: [expect.objectContaining({ file_number: "CF-0006" })],
      }),
    );
  });

  it("rejects a form with a missing required field before hitting the database", async () => {
    const { createPatient, mocks } = await loadPatientActions();

    const result = await createPatient(null, patientForm({ full_name: "x" }));

    expect(result?.fieldErrors?.full_name).toBeDefined();
    expect(mocks.state.from).not.toHaveBeenCalled();
  });

  it("rejects an invalid phone number before hitting the database", async () => {
    const { createPatient, mocks } = await loadPatientActions();

    const result = await createPatient(null, patientForm({ phone: "not-a-phone" }));

    expect(result?.fieldErrors?.phone).toBeDefined();
    expect(mocks.state.from).not.toHaveBeenCalled();
  });

  it("rejects an invalid email before hitting the database", async () => {
    const { createPatient, mocks } = await loadPatientActions();

    const result = await createPatient(null, patientForm({ email: "not-an-email" }));

    expect(result?.fieldErrors?.email).toBeDefined();
    expect(mocks.state.from).not.toHaveBeenCalled();
  });

  it("returns a DB error message when insertion fails", async () => {
    const { createPatient, mocks } = await loadPatientActions();
    mocks.state.tableResults["patients.select"] = [
      { data: [], error: null },
      { data: null, error: { message: "unique constraint violated", code: "23505" } },
    ];

    const result = await createPatient(null, patientForm());

    expect(result?.error).toBeTruthy();
    expect(mocks.state.redirect).not.toHaveBeenCalled();
  });
});

describe("updatePatient", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("updates a patient record and redirects to the patient page", async () => {
    const { updatePatient, mocks } = await loadPatientActions();

    await updatePatient(PATIENT_ID, null, patientForm({ full_name: "Updated Name" }));

    expect(mocks.state.queryLog).toContainEqual(
      expect.objectContaining({
        table: "patients",
        operation: "update",
        args: [expect.objectContaining({ full_name: "Updated Name" })],
      }),
    );
    expect(mocks.state.redirect).toHaveBeenCalledWith(`/patients/${PATIENT_ID}`);
  });

  it("rejects an invalid update form before hitting the database", async () => {
    const { updatePatient, mocks } = await loadPatientActions();

    const result = await updatePatient(
      PATIENT_ID,
      null,
      patientForm({ national_id: "x" }),
    );

    expect(result?.fieldErrors?.national_id).toBeDefined();
    expect(mocks.state.from).not.toHaveBeenCalled();
  });

  it("returns an error when the update DB call fails", async () => {
    const { updatePatient, mocks } = await loadPatientActions();
    mocks.state.tableResults["patients.update"] = {
      data: null,
      error: { message: "patient not found" },
    };

    const result = await updatePatient(PATIENT_ID, null, patientForm());

    expect(result?.error).toBeTruthy();
    expect(mocks.state.redirect).not.toHaveBeenCalled();
  });
});

describe("softDeletePatient", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("calls the soft_delete_patient RPC and redirects to /patients", async () => {
    const { softDeletePatient, mocks } = await loadPatientActions();
    mocks.state.rpcResults.soft_delete_patient = { data: true, error: null };

    await softDeletePatient(PATIENT_ID);

    expect(mocks.state.rpc).toHaveBeenCalledWith("soft_delete_patient", {
      p_patient_id: PATIENT_ID,
    });
    expect(mocks.state.redirect).toHaveBeenCalledWith("/patients");
    expect(mocks.state.revalidatePath).toHaveBeenCalledWith("/patients");
  });

  it("returns an error when the RPC reports the patient was not found", async () => {
    const { softDeletePatient, mocks } = await loadPatientActions();
    mocks.state.rpcResults.soft_delete_patient = { data: false, error: null };

    const result = await softDeletePatient(PATIENT_ID);

    expect(result?.error).toMatch(/not found/i);
    expect(mocks.state.redirect).not.toHaveBeenCalled();
  });

  it("returns a generic error and logs when the RPC fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { softDeletePatient, mocks } = await loadPatientActions();
    mocks.state.rpcResults.soft_delete_patient = {
      data: null,
      error: { message: "rpc_error", code: "42501" },
    };

    const result = await softDeletePatient(PATIENT_ID);

    expect(result?.error).toBe("Failed to delete patient.");
    expect(consoleError).toHaveBeenCalled();
    expect(mocks.state.redirect).not.toHaveBeenCalled();
  });
});

describe("restorePatient", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("requires the admin role to restore a patient", async () => {
    const { restorePatient, mocks } = await loadPatientActions();
    mocks.state.requireRole.mockRejectedValue(new Error("admin only"));

    await expect(restorePatient(PATIENT_ID)).rejects.toThrow("admin only");
    expect(mocks.state.from).not.toHaveBeenCalled();
  });

  it("sets is_deleted to false and revalidates the patient page", async () => {
    const { restorePatient, mocks } = await loadPatientActions();
    mocks.state.requireRole.mockResolvedValue({
      id: "user-1",
      clinicId: "clinic-1",
      role: "admin",
    });

    const result = await restorePatient(PATIENT_ID);

    expect(result).not.toHaveProperty("error");
    expect(mocks.state.queryLog).toContainEqual(
      expect.objectContaining({
        table: "patients",
        operation: "update",
        args: [expect.objectContaining({ is_deleted: false })],
      }),
    );
    expect(mocks.state.revalidatePath).toHaveBeenCalledWith(`/patients/${PATIENT_ID}`);
  });
});
