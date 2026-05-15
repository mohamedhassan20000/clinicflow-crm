import { beforeEach, describe, expect, it, vi } from "vitest";
import { createServerActionMocks } from "../helpers/server-action-mocks";

const APPOINTMENT_ID = "11111111-1111-4111-8111-111111111111";
const PATIENT_ID = "22222222-2222-4222-8222-222222222222";
const DOCTOR_ID = "33333333-3333-4333-8333-333333333333";
const DEPARTMENT_ID = "44444444-4444-4444-8444-444444444444";
const INSURANCE_ID = "55555555-5555-4555-8555-555555555555";

function appointmentForm(overrides: Record<string, string> = {}) {
  const form = new FormData();
  form.set("patient_id", PATIENT_ID);
  form.set("doctor_id", DOCTOR_ID);
  form.set("department_id", DEPARTMENT_ID);
  form.set("scheduled_at", "2099-01-01T10:00:00.000Z");
  form.set("duration_minutes", "30");
  form.set("insurance_provider_id", INSURANCE_ID);
  form.set("notes", "");
  for (const [key, value] of Object.entries(overrides)) {
    form.set(key, value);
  }
  return form;
}

function allowValidReferences(
  mocks: ReturnType<typeof createServerActionMocks>,
  overrides: {
    patient?: unknown;
    doctor?: unknown;
    department?: unknown;
    insurance?: unknown;
    sameDay?: unknown[];
  } = {},
) {
  mocks.state.tableResults["patients.select"] = {
    data: Object.hasOwn(overrides, "patient")
      ? overrides.patient
      : { id: PATIENT_ID },
    error: null,
  };
  mocks.state.tableResults["profiles.select"] = {
    data: Object.hasOwn(overrides, "doctor")
      ? overrides.doctor
      : {
        id: DOCTOR_ID,
        department_id: DEPARTMENT_ID,
        },
    error: null,
  };
  mocks.state.tableResults["departments.select"] = {
    data: Object.hasOwn(overrides, "department")
      ? overrides.department
      : { id: DEPARTMENT_ID },
    error: null,
  };
  mocks.state.tableResults["insurance_providers.select"] = {
    data: Object.hasOwn(overrides, "insurance")
      ? overrides.insurance
      : { id: INSURANCE_ID },
    error: null,
  };
  mocks.state.tableResults["appointments.select"] = {
    data: overrides.sameDay ?? [],
    error: null,
  };
  mocks.state.tableResults["appointments.insert"] = {
    data: null,
    error: null,
  };
}

async function loadAppointmentsActions() {
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
  vi.doMock("@/actions/patients", () => ({
    getPatientAccountBalance: vi.fn(async () => 0),
  }));

  const appointments = await import("@/actions/appointments");
  return { ...appointments, mocks };
}

function wroteAppointments(mocks: ReturnType<typeof createServerActionMocks>) {
  return mocks.state.queryLog.some(
    (entry) =>
      entry.table === "appointments" &&
      (entry.operation === "insert" || entry.operation === "update"),
  );
}

describe("appointment reference validation", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("creates appointments only after validating same-clinic active references", async () => {
    const { createAppointment, mocks } = await loadAppointmentsActions();
    mocks.state.authedUser.role = "receptionist";
    allowValidReferences(mocks);

    await createAppointment(null, appointmentForm());

    expect(mocks.state.requireRole).toHaveBeenCalledWith([
      "admin",
      "receptionist",
    ]);
    expect(mocks.state.queryLog).toContainEqual(
      expect.objectContaining({
        table: "patients",
        operation: "select",
        args: ["eq", "clinic_id", "clinic-1"],
      }),
    );
    expect(mocks.state.queryLog).toContainEqual(
      expect.objectContaining({
        table: "profiles",
        operation: "select",
        args: ["eq", "role", "doctor"],
      }),
    );
    expect(mocks.state.queryLog).toContainEqual(
      expect.objectContaining({
        table: "profiles",
        operation: "select",
        args: ["eq", "is_active", true],
      }),
    );
    expect(mocks.state.queryLog).toContainEqual(
      expect.objectContaining({
        table: "departments",
        operation: "select",
        args: ["eq", "clinic_id", "clinic-1"],
      }),
    );
    expect(mocks.state.queryLog).toContainEqual(
      expect.objectContaining({
        table: "insurance_providers",
        operation: "select",
        args: ["eq", "clinic_id", "clinic-1"],
      }),
    );
    expect(mocks.state.redirect).toHaveBeenCalledWith("/appointments");
  });

  it("rejects invalid patient references before DB write", async () => {
    const { createAppointment, mocks } = await loadAppointmentsActions();
    allowValidReferences(mocks, { patient: null });

    const result = await createAppointment(null, appointmentForm());

    expect(result).toEqual({
      error: "Select an active patient in this clinic.",
    });
    expect(wroteAppointments(mocks)).toBe(false);
  });

  it("rejects inactive or non-doctor staff references before DB write", async () => {
    const { createAppointment, mocks } = await loadAppointmentsActions();
    allowValidReferences(mocks, { doctor: null });

    const result = await createAppointment(null, appointmentForm());

    expect(result).toEqual({
      error: "Select an active doctor in this clinic.",
    });
    expect(wroteAppointments(mocks)).toBe(false);
  });

  it("rejects department and insurance references outside the clinic before DB write", async () => {
    const { createAppointment, mocks } = await loadAppointmentsActions();
    allowValidReferences(mocks, { department: null, insurance: null });

    const result = await createAppointment(null, appointmentForm());

    expect(result).toEqual({
      error: "Select an active department in this clinic.",
    });
    expect(wroteAppointments(mocks)).toBe(false);
  });
});

describe("appointment conflict prevention", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects overlapping appointments including the required buffer", async () => {
    const { createAppointment, mocks } = await loadAppointmentsActions();
    allowValidReferences(mocks, {
      sameDay: [
        {
          scheduled_at: "2099-01-01T10:30:00.000Z",
          duration_minutes: 30,
        },
      ],
    });

    const result = await createAppointment(
      null,
      appointmentForm({ scheduled_at: "2099-01-01T10:00:00.000Z" }),
    );

    expect(result).toEqual({
      error:
        "This doctor needs a 15-minute recovery/buffer window between appointments. Please choose a different time slot.",
    });
    expect(wroteAppointments(mocks)).toBe(false);
  });

  it("rejects same-doctor session overlaps with a clear booked message", async () => {
    const { createAppointment, mocks } = await loadAppointmentsActions();
    allowValidReferences(mocks, {
      sameDay: [
        {
          scheduled_at: "2099-01-01T10:00:00.000Z",
          duration_minutes: 30,
        },
      ],
    });

    const result = await createAppointment(
      null,
      appointmentForm({ scheduled_at: "2099-01-01T10:15:00.000Z" }),
    );

    expect(result).toEqual({
      error:
        "This doctor is already booked during the selected session time. Please choose a different time slot.",
    });
    expect(wroteAppointments(mocks)).toBe(false);
  });

  it("allows different doctors in the same department at the same time", async () => {
    const { createAppointment, mocks } = await loadAppointmentsActions();
    allowValidReferences(mocks, { sameDay: [] });

    await createAppointment(
      null,
      appointmentForm({ scheduled_at: "2099-01-01T10:00:00.000Z" }),
    );

    expect(mocks.state.queryLog).toContainEqual(
      expect.objectContaining({
        table: "appointments",
        operation: "select",
        args: ["eq", "doctor_id", DOCTOR_ID],
      }),
    );
    expect(mocks.state.redirect).toHaveBeenCalledWith("/appointments");
  });

  it("allows appointments exactly at the 15-minute buffer boundary", async () => {
    const { createAppointment, mocks } = await loadAppointmentsActions();
    allowValidReferences(mocks, {
      sameDay: [
        {
          scheduled_at: "2099-01-01T10:00:00.000Z",
          duration_minutes: 30,
        },
      ],
    });

    await createAppointment(
      null,
      appointmentForm({ scheduled_at: "2099-01-01T10:45:00.000Z" }),
    );

    expect(mocks.state.redirect).toHaveBeenCalledWith("/appointments");
  });

  it("allows appointments ending exactly at the 15-minute buffer boundary before another session", async () => {
    const { createAppointment, mocks } = await loadAppointmentsActions();
    allowValidReferences(mocks, {
      sameDay: [
        {
          scheduled_at: "2099-01-01T10:45:00.000Z",
          duration_minutes: 30,
        },
      ],
    });

    await createAppointment(
      null,
      appointmentForm({ scheduled_at: "2099-01-01T10:00:00.000Z" }),
    );

    expect(mocks.state.redirect).toHaveBeenCalledWith("/appointments");
  });

  it("rejects appointments one minute inside the buffer boundary", async () => {
    const { createAppointment, mocks } = await loadAppointmentsActions();
    allowValidReferences(mocks, {
      sameDay: [
        {
          scheduled_at: "2099-01-01T10:00:00.000Z",
          duration_minutes: 30,
        },
      ],
    });

    const result = await createAppointment(
      null,
      appointmentForm({ scheduled_at: "2099-01-01T10:44:00.000Z" }),
    );

    expect(result.error).toContain("15-minute recovery/buffer window");
    expect(wroteAppointments(mocks)).toBe(false);
  });

  it("conflict query excludes cancelled appointments so their slot can be rebooked", async () => {
    const { createAppointment, mocks } = await loadAppointmentsActions();
    // Cancelled appointment is not returned by the conflict query (excluded by status filter)
    allowValidReferences(mocks, { sameDay: [] });

    await createAppointment(
      null,
      appointmentForm({ scheduled_at: "2099-01-01T10:00:00.000Z" }),
    );

    expect(mocks.state.queryLog).toContainEqual(
      expect.objectContaining({
        table: "appointments",
        operation: "select",
        args: ["not", "status", "in", '("cancelled","no_show")'],
      }),
    );
    expect(mocks.state.redirect).toHaveBeenCalledWith("/appointments");
  });

  it("conflict query excludes no_show appointments so their slot can be rebooked", async () => {
    const { createAppointment, mocks } = await loadAppointmentsActions();
    // No-show appointment is not returned by the conflict query (excluded by status filter)
    allowValidReferences(mocks, { sameDay: [] });

    await createAppointment(
      null,
      appointmentForm({ scheduled_at: "2099-01-01T11:00:00.000Z" }),
    );

    expect(mocks.state.queryLog).toContainEqual(
      expect.objectContaining({
        table: "appointments",
        operation: "select",
        args: ["not", "status", "in", '("cancelled","no_show")'],
      }),
    );
    expect(mocks.state.redirect).toHaveBeenCalledWith("/appointments");
  });

  it("conflict query excludes soft-deleted appointments via deleted_at IS NULL filter", async () => {
    const { createAppointment, mocks } = await loadAppointmentsActions();
    allowValidReferences(mocks, { sameDay: [] });

    await createAppointment(
      null,
      appointmentForm({ scheduled_at: "2099-01-01T10:00:00.000Z" }),
    );

    expect(mocks.state.queryLog).toContainEqual(
      expect.objectContaining({
        table: "appointments",
        operation: "select",
        args: ["is", "deleted_at", null],
      }),
    );
  });

  it("allows booking the same slot when the existing appointment is soft-deleted (deleted_at set)", async () => {
    const { createAppointment, mocks } = await loadAppointmentsActions();
    // Simulate the conflict query returning no rows — as it would when the
    // only appointment at that slot has deleted_at set and is filtered out.
    allowValidReferences(mocks, { sameDay: [] });

    await createAppointment(
      null,
      appointmentForm({ scheduled_at: "2099-01-01T10:00:00.000Z" }),
    );

    expect(mocks.state.redirect).toHaveBeenCalledWith("/appointments");
    expect(wroteAppointments(mocks)).toBe(true);
  });

  it("still blocks booking when an active (non-deleted) appointment occupies the slot", async () => {
    const { createAppointment, mocks } = await loadAppointmentsActions();
    allowValidReferences(mocks, {
      sameDay: [
        {
          scheduled_at: "2099-01-01T10:00:00.000Z",
          duration_minutes: 30,
        },
      ],
    });

    const result = await createAppointment(
      null,
      appointmentForm({ scheduled_at: "2099-01-01T10:15:00.000Z" }),
    );

    expect(result.error).toBe(
      "This doctor is already booked during the selected session time. Please choose a different time slot.",
    );
    expect(wroteAppointments(mocks)).toBe(false);
  });
});

describe("appointment status and role boundaries", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("allows admin and receptionist appointment status management", async () => {
    const { updateAppointmentStatus, mocks } = await loadAppointmentsActions();
    mocks.state.authedUser.role = "admin";
    mocks.state.tableResults["appointments.select"] = {
      data: { status: "pending", patient_id: PATIENT_ID },
      error: null,
    };
    mocks.state.tableResults["appointments.update"] = {
      data: null,
      error: null,
    };

    const result = await updateAppointmentStatus(APPOINTMENT_ID, "confirmed");

    expect(result).toEqual({});
    expect(mocks.state.requireRole).toHaveBeenCalledWith([
      "admin",
      "receptionist",
    ]);
    expect(mocks.state.revalidatePath).toHaveBeenCalledWith("/appointments");
    expect(mocks.state.revalidatePath).toHaveBeenCalledWith(
      `/patients/${PATIENT_ID}`,
    );
  });

  it("blocks doctors from appointment mutation actions", async () => {
    const { createAppointment, updateAppointmentStatus, mocks } =
      await loadAppointmentsActions();
    mocks.state.authedUser.role = "doctor";
    mocks.state.requireRole.mockRejectedValue(new Error("redirected"));

    await expect(createAppointment(null, appointmentForm())).rejects.toThrow(
      "redirected",
    );
    await expect(
      updateAppointmentStatus(APPOINTMENT_ID, "confirmed"),
    ).rejects.toThrow("redirected");
    expect(mocks.state.from).not.toHaveBeenCalled();
  });

  it("rejects invalid appointment status transitions before DB update", async () => {
    const { updateAppointmentStatus, mocks } = await loadAppointmentsActions();
    mocks.state.tableResults["appointments.select"] = {
      data: { status: "completed", patient_id: PATIENT_ID },
      error: null,
    };

    const result = await updateAppointmentStatus(APPOINTMENT_ID, "confirmed");

    expect(result).toEqual({
      error: "Cannot transition from completed to confirmed.",
    });
    expect(wroteAppointments(mocks)).toBe(false);
  });

  it("undoes confirmed status back to pending via the undo_appointment_status RPC", async () => {
    const { undoAppointmentStatus, mocks } = await loadAppointmentsActions();
    mocks.state.tableResults["appointments.select"] = {
      data: { patient_id: PATIENT_ID },
      error: null,
    };

    const result = await undoAppointmentStatus(APPOINTMENT_ID, "pending");

    expect(result).toEqual({});
    expect(mocks.state.rpc).toHaveBeenCalledWith("undo_appointment_status", {
      p_appointment_id: APPOINTMENT_ID,
      p_target_status: "pending",
    });
    expect(mocks.state.revalidatePath).toHaveBeenCalledWith("/appointments");
    expect(mocks.state.revalidatePath).toHaveBeenCalledWith(
      `/patients/${PATIENT_ID}`,
    );
  });
});

describe("checkSameDayPatient", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns hasSameDay true when the patient has an active appointment on that day", async () => {
    const { checkSameDayPatient, mocks } = await loadAppointmentsActions();
    mocks.state.tableResults["appointments.select"] = {
      data: [{ id: APPOINTMENT_ID }],
      error: null,
    };

    const result = await checkSameDayPatient(PATIENT_ID, "2099-01-01T10:00:00.000Z");

    expect(result).toEqual({ hasSameDay: true });
    expect(mocks.state.queryLog).toContainEqual(
      expect.objectContaining({
        table: "appointments",
        operation: "select",
        args: ["eq", "patient_id", PATIENT_ID],
      }),
    );
    expect(mocks.state.queryLog).toContainEqual(
      expect.objectContaining({
        table: "appointments",
        operation: "select",
        args: ["is", "deleted_at", null],
      }),
    );
    expect(mocks.state.queryLog).toContainEqual(
      expect.objectContaining({
        table: "appointments",
        operation: "select",
        args: ["not", "status", "in", '("cancelled","no_show")'],
      }),
    );
  });

  it("returns hasSameDay false when the patient has no active appointment on that day", async () => {
    const { checkSameDayPatient, mocks } = await loadAppointmentsActions();
    mocks.state.tableResults["appointments.select"] = {
      data: [],
      error: null,
    };

    const result = await checkSameDayPatient(PATIENT_ID, "2099-01-01T10:00:00.000Z");

    expect(result).toEqual({ hasSameDay: false });
  });

  it("returns hasSameDay false on DB error so booking is never blocked by a check failure", async () => {
    const { checkSameDayPatient, mocks } = await loadAppointmentsActions();
    mocks.state.tableResults["appointments.select"] = {
      data: null,
      error: { message: "connection error" },
    };

    const result = await checkSameDayPatient(PATIENT_ID, "2099-01-01T10:00:00.000Z");

    expect(result).toEqual({ hasSameDay: false });
  });
});
