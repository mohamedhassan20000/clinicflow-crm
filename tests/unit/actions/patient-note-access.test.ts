import { beforeEach, describe, expect, it, vi } from "vitest";
import { createServerActionMocks } from "../helpers/server-action-mocks";

const PATIENT_ID = "22222222-2222-4222-8222-222222222222";
const NOTE_ID = "44444444-4444-4444-8444-444444444444";
const DOCTOR_ID = "55555555-5555-4555-8555-555555555555";
const OTHER_DOCTOR_ID = "66666666-6666-4666-8666-666666666666";
const DEPARTMENT_ID = "77777777-7777-4777-8777-777777777777";
const INSURANCE_PROVIDER_ID = "88888888-8888-4888-8888-888888888888";

function patientForm(overrides: Record<string, string> = {}) {
  const form = new FormData();
  form.set("full_name", "Patient User");
  form.set("national_id", "ABC12345");
  form.set("date_of_birth", "1990-01-01");
  form.set("phone", "0555 123 45 67");
  form.set("email", "patient@example.com");
  form.set("blood_type", "A+");
  form.set("department_id", "");
  form.set("assigned_doctor_id", "");
  for (const [key, value] of Object.entries(overrides)) {
    form.set(key, value);
  }
  return form;
}

function noteForm(overrides: Record<string, string> = {}) {
  const form = new FormData();
  form.set("patient_id", PATIENT_ID);
  form.set("note", "Clinical note");
  for (const [key, value] of Object.entries(overrides)) {
    form.set(key, value);
  }
  return form;
}

function noteRow(overrides: Record<string, unknown> = {}) {
  return {
    id: NOTE_ID,
    patient_id: PATIENT_ID,
    doctor_id: OTHER_DOCTOR_ID,
    created_by: OTHER_DOCTOR_ID,
    created_at: "2026-05-01T00:00:00Z",
    note: "Existing server note",
    ...overrides,
  };
}

async function loadPatientsActions() {
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

describe("patient action permissions", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("creates patients only through admin/receptionist authorization", async () => {
    const { createPatient, mocks } = await loadPatientsActions();
    mocks.state.authedUser.role = "receptionist";
    mocks.state.tableResults["patients.select"] = [
      { data: [], error: null },
      { data: { id: PATIENT_ID }, error: null },
    ];

    const result = await createPatient(null, patientForm());

    expect(mocks.state.requireRole).toHaveBeenCalledWith([
      "admin",
      "receptionist",
    ]);
    expect(result).toMatchObject({ success: true, patientId: PATIENT_ID });
  });

  it("normalizes Turkish patient phones before insert", async () => {
    const { createPatient, mocks } = await loadPatientsActions();
    mocks.state.tableResults["patients.select"] = [
      { data: [], error: null },
      { data: { id: PATIENT_ID }, error: null },
    ];

    await createPatient(null, patientForm({ phone: "0555 123 45 67" }));

    expect(mocks.state.queryLog).toContainEqual(
      expect.objectContaining({
        table: "patients",
        operation: "insert",
        args: [
          expect.objectContaining({
            phone: "+905551234567",
          }),
        ],
      }),
    );
  });

  it("accepts international patient phones before update", async () => {
    const { updatePatient, mocks } = await loadPatientsActions();
    mocks.state.tableResults["patients.update"] = { data: null, error: null };

    await updatePatient(PATIENT_ID, null, patientForm({ phone: "+1 415 555 2671" }));

    expect(mocks.state.queryLog).toContainEqual(
      expect.objectContaining({
        table: "patients",
        operation: "update",
        args: [
          expect.objectContaining({
            phone: "+14155552671",
          }),
        ],
      }),
    );
  });

  it("rejects obviously invalid patient phones before patient write", async () => {
    const { createPatient, mocks } = await loadPatientsActions();

    const result = await createPatient(null, patientForm({ phone: "123" }));

    expect(result).toEqual({
      fieldErrors: {
        phone: ["Enter a valid phone number"],
      },
    });
    expect(
      mocks.state.queryLog.some(
        (entry) => entry.table === "patients" && entry.operation === "insert",
      ),
    ).toBe(false);
  });

  it("updates patients only through admin/receptionist authorization", async () => {
    const { updatePatient, mocks } = await loadPatientsActions();
    mocks.state.authedUser.role = "admin";
    mocks.state.tableResults["patients.update"] = { data: null, error: null };

    await updatePatient(PATIENT_ID, null, patientForm());

    expect(mocks.state.requireRole).toHaveBeenCalledWith([
      "admin",
      "receptionist",
    ]);
    expect(mocks.state.revalidatePath).toHaveBeenCalledWith(
      `/patients/${PATIENT_ID}`,
    );
    expect(mocks.state.redirect).toHaveBeenCalledWith(`/patients/${PATIENT_ID}`);
  });

  it("soft-deletes patients through the scoped RPC without touching related records", async () => {
    const { softDeletePatient, mocks } = await loadPatientsActions();
    mocks.state.authedUser.role = "admin";
    mocks.state.rpcResults.soft_delete_patient = { data: true, error: null };

    await softDeletePatient(PATIENT_ID);

    expect(mocks.state.requireRole).toHaveBeenCalledWith([
      "admin",
      "receptionist",
    ]);
    expect(mocks.state.rpc).toHaveBeenCalledWith("soft_delete_patient", {
      p_patient_id: PATIENT_ID,
    });
    // softDeletePatient now stamps deleted_at via adminClient — verify it only
    // touches patients, not medical_notes, appointments, or other records.
    const affectedTables = mocks.state.queryLog.map((q) => q.table);
    for (const table of affectedTables) {
      expect(table).toBe("patients");
    }
    expect(mocks.state.queryLog).toContainEqual(
      expect.objectContaining({
        table: "patients",
        operation: "update",
        args: [expect.objectContaining({ deleted_at: expect.any(String) })],
      }),
    );
    expect(mocks.state.storageLog).toEqual([]);
    expect(mocks.state.revalidatePath).toHaveBeenCalledWith("/patients");
    expect(mocks.state.redirect).toHaveBeenCalledWith("/patients");
  });

  it("allows receptionists to soft-delete patients through the scoped RPC", async () => {
    const { softDeletePatient, mocks } = await loadPatientsActions();
    mocks.state.authedUser.role = "receptionist";
    mocks.state.rpcResults.soft_delete_patient = { data: true, error: null };

    await softDeletePatient(PATIENT_ID);

    expect(mocks.state.requireRole).toHaveBeenCalledWith([
      "admin",
      "receptionist",
    ]);
    expect(mocks.state.rpc).toHaveBeenCalledWith("soft_delete_patient", {
      p_patient_id: PATIENT_ID,
    });
    expect(mocks.state.redirect).toHaveBeenCalledWith("/patients");
  });

  it("does not call the patient soft-delete RPC for managers or doctors", async () => {
    for (const role of ["manager", "doctor"] as const) {
      const { softDeletePatient, mocks } = await loadPatientsActions();
      mocks.state.authedUser.role = role;
      mocks.state.requireRole.mockImplementation(async (allowed) => {
        const allowedRoles = Array.isArray(allowed) ? allowed : [allowed];
        if (!allowedRoles.includes(mocks.state.authedUser.role)) {
          throw new Error("not authorized");
        }
        return mocks.state.authedUser;
      });

      await expect(softDeletePatient(PATIENT_ID)).rejects.toThrow(
        "not authorized",
      );

      expect(mocks.state.rpc).not.toHaveBeenCalled();
    }
  });

  it("returns a clear error when the patient soft-delete RPC cannot find the row", async () => {
    const { softDeletePatient, mocks } = await loadPatientsActions();
    mocks.state.authedUser.role = "admin";
    mocks.state.rpcResults.soft_delete_patient = { data: false, error: null };

    const result = await softDeletePatient(PATIENT_ID);

    expect(result).toEqual({ error: "Patient not found." });
    expect(mocks.state.redirect).not.toHaveBeenCalled();
  });

  it("logs structured diagnostics when patient soft-delete RPC fails", async () => {
    const { softDeletePatient, mocks } = await loadPatientsActions();
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    mocks.state.authedUser.role = "admin";
    mocks.state.rpcResults.soft_delete_patient = {
      data: null,
      error: {
        code: "42501",
        message: "rls rejected",
        details: "policy mismatch",
        hint: "check patients update policy",
      },
    };

    const result = await softDeletePatient(PATIENT_ID);

    expect(result).toEqual({ error: "Failed to delete patient." });
    expect(consoleError).toHaveBeenCalledWith(
      "patient_soft_delete_failed",
      expect.objectContaining({
        code: "42501",
        message: "rls rejected",
        details: "policy mismatch",
        hint: "check patients update policy",
        patientId: PATIENT_ID,
      }),
    );
    expect(mocks.state.redirect).not.toHaveBeenCalled();
  });

  it("saves an active same-clinic insurance provider when creating a patient", async () => {
    const { createPatient, mocks } = await loadPatientsActions();
    mocks.state.tableResults["insurance_providers.select"] = {
      data: { id: INSURANCE_PROVIDER_ID },
      error: null,
    };
    mocks.state.tableResults["patients.select"] = [
      { data: [], error: null },
      { data: { id: PATIENT_ID }, error: null },
    ];

    await createPatient(
      null,
      patientForm({ insurance_provider_id: INSURANCE_PROVIDER_ID }),
    );

    expect(mocks.state.queryLog).toContainEqual(
      expect.objectContaining({
        table: "patients",
        operation: "insert",
        args: [
          expect.objectContaining({
            insurance_provider_id: INSURANCE_PROVIDER_ID,
          }),
        ],
      }),
    );
  });

  it("rejects inactive or cross-clinic insurance providers before patient write", async () => {
    const { createPatient, mocks } = await loadPatientsActions();
    mocks.state.tableResults["insurance_providers.select"] = {
      data: null,
      error: null,
    };

    const result = await createPatient(
      null,
      patientForm({ insurance_provider_id: INSURANCE_PROVIDER_ID }),
    );

    expect(result).toEqual({
      fieldErrors: {
        insurance_provider_id: ["Select an active insurance provider."],
      },
    });
    expect(
      mocks.state.queryLog.some(
        (entry) => entry.table === "patients" && entry.operation === "insert",
      ),
    ).toBe(false);
  });

  it("stores explicit no-insurance selections as null", async () => {
    const { updatePatient, mocks } = await loadPatientsActions();
    mocks.state.tableResults["patients.update"] = { data: null, error: null };

    await updatePatient(
      PATIENT_ID,
      null,
      patientForm({ insurance_provider_id: "none" }),
    );

    expect(mocks.state.queryLog).toContainEqual(
      expect.objectContaining({
        table: "patients",
        operation: "update",
        args: [
          expect.objectContaining({
            insurance_provider_id: null,
          }),
        ],
      }),
    );
  });

  it("does not continue patient creation when role authorization fails", async () => {
    const { createPatient, mocks } = await loadPatientsActions();
    mocks.state.requireRole.mockRejectedValue(new Error("redirected"));

    await expect(createPatient(null, patientForm())).rejects.toThrow(
      "redirected",
    );

    expect(mocks.state.from).not.toHaveBeenCalled();
  });
});

describe("medical note patient scope", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("allows doctors to create notes for assigned patients", async () => {
    const { addMedicalNote, mocks } = await loadPatientsActions();
    mocks.state.authedUser = {
      id: DOCTOR_ID,
      clinicId: "clinic-1",
      role: "doctor",
      departmentId: null,
    };
    mocks.state.tableResults["patients.select"] = {
      data: {
        id: PATIENT_ID,
        department_id: null,
        assigned_doctor_id: DOCTOR_ID,
      },
      error: null,
    };
    mocks.state.tableResults["medical_notes.insert"] = {
      data: null,
      error: null,
    };

    const result = await addMedicalNote(null, noteForm());

    expect(result).toEqual({});
    expect(mocks.state.queryLog).toContainEqual(
      expect.objectContaining({
        table: "medical_notes",
        operation: "insert",
        args: [
          expect.objectContaining({
            patient_id: PATIENT_ID,
            doctor_id: DOCTOR_ID,
            created_by: DOCTOR_ID,
          }),
        ],
      }),
    );
  });

  it("allows doctors to create notes for patients in their department", async () => {
    const { addMedicalNote, mocks } = await loadPatientsActions();
    mocks.state.authedUser = {
      id: DOCTOR_ID,
      clinicId: "clinic-1",
      role: "doctor",
      departmentId: DEPARTMENT_ID,
    };
    mocks.state.tableResults["patients.select"] = {
      data: {
        id: PATIENT_ID,
        department_id: DEPARTMENT_ID,
        assigned_doctor_id: OTHER_DOCTOR_ID,
      },
      error: null,
    };
    mocks.state.tableResults["medical_notes.insert"] = {
      data: null,
      error: null,
    };

    const result = await addMedicalNote(null, noteForm());

    expect(result).toEqual({});
    expect(mocks.state.revalidatePath).toHaveBeenCalledWith(
      `/patients/${PATIENT_ID}`,
    );
  });

  it("blocks unrelated doctors from creating notes", async () => {
    const { addMedicalNote, mocks } = await loadPatientsActions();
    mocks.state.authedUser = {
      id: DOCTOR_ID,
      clinicId: "clinic-1",
      role: "doctor",
      departmentId: DEPARTMENT_ID,
    };
    mocks.state.tableResults["patients.select"] = {
      data: {
        id: PATIENT_ID,
        department_id: "88888888-8888-4888-8888-888888888888",
        assigned_doctor_id: OTHER_DOCTOR_ID,
      },
      error: null,
    };

    const result = await addMedicalNote(null, noteForm());

    expect(result).toEqual({
      error: "Patient not found or you do not have permission.",
    });
    expect(
      mocks.state.queryLog.some(
        (entry) =>
          entry.table === "medical_notes" && entry.operation === "insert",
      ),
    ).toBe(false);
  });
});

describe("medical note author boundaries", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("allows doctors to edit their own notes using server-fetched note data", async () => {
    const { updateMedicalNote, mocks } = await loadPatientsActions();
    mocks.state.authedUser = {
      id: DOCTOR_ID,
      clinicId: "clinic-1",
      role: "doctor",
      departmentId: DEPARTMENT_ID,
    };
    mocks.state.tableResults["medical_notes.select"] = {
      data: [noteRow({ created_by: DOCTOR_ID })],
      error: null,
    };
    mocks.state.tableResults["patients.select"] = {
      data: [{ id: PATIENT_ID }],
      error: null,
    };
    mocks.state.tableResults["medical_notes.update"] = {
      data: null,
      error: null,
    };

    const result = await updateMedicalNote(NOTE_ID, " Updated note ");

    expect(result).toEqual({});
    expect(mocks.state.queryLog).toContainEqual(
      expect.objectContaining({
        table: "medical_notes",
        operation: "update",
        args: [{ note: "Updated note" }],
      }),
    );
    expect(mocks.state.queryLog).toContainEqual(
      expect.objectContaining({
        table: "medical_notes",
        operation: "update",
        args: ["eq", "id", NOTE_ID],
      }),
    );
    expect(mocks.state.revalidatePath).toHaveBeenCalledWith(
      `/patients/${PATIENT_ID}`,
    );
  });

  it("blocks doctors from editing or deleting notes they did not author", async () => {
    const { updateMedicalNote, deleteMedicalNote, mocks } =
      await loadPatientsActions();
    mocks.state.authedUser = {
      id: DOCTOR_ID,
      clinicId: "clinic-1",
      role: "doctor",
      departmentId: DEPARTMENT_ID,
    };
    mocks.state.tableResults["medical_notes.select"] = [
      { data: [noteRow({ doctor_id: DOCTOR_ID, created_by: OTHER_DOCTOR_ID })], error: null },
      { data: [noteRow({ doctor_id: DOCTOR_ID, created_by: OTHER_DOCTOR_ID })], error: null },
    ];
    mocks.state.tableResults["patients.select"] = [
      { data: [{ id: PATIENT_ID }], error: null },
      { data: [{ id: PATIENT_ID }], error: null },
    ];

    const updateResult = await updateMedicalNote(NOTE_ID, "Updated note");
    const deleteResult = await deleteMedicalNote(NOTE_ID);

    expect(updateResult).toEqual({
      error: "You can only edit your own medical notes.",
    });
    expect(deleteResult).toEqual({
      error: "You can only delete your own medical notes.",
    });
    expect(
      mocks.state.queryLog.some(
        (entry) =>
          entry.table === "medical_notes" &&
          (entry.operation === "update" || entry.operation === "delete"),
      ),
    ).toBe(false);
  });

  it("allows admins to edit and delete clinic notes regardless of author", async () => {
    const { updateMedicalNote, deleteMedicalNote, mocks } =
      await loadPatientsActions();
    mocks.state.authedUser.role = "admin";
    mocks.state.tableResults["medical_notes.select"] = [
      { data: [noteRow()], error: null },
      { data: [noteRow()], error: null },
    ];
    mocks.state.tableResults["patients.select"] = [
      { data: [{ id: PATIENT_ID }], error: null },
      { data: [{ id: PATIENT_ID }], error: null },
    ];
    mocks.state.tableResults["medical_notes.update"] = {
      data: null,
      error: null,
    };
    mocks.state.tableResults["medical_notes.delete"] = {
      data: null,
      error: null,
    };

    await expect(updateMedicalNote(NOTE_ID, "Admin edit")).resolves.toEqual({});
    await expect(deleteMedicalNote(NOTE_ID)).resolves.toEqual({
      success: true,
    });
  });
});
