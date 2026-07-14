import { beforeEach, describe, expect, it, vi } from "vitest";
import { createServerActionMocks } from "../helpers/server-action-mocks";

const APPOINTMENT_ID = "11111111-1111-4111-8111-111111111111";
const APPOINTMENT_ID_2 = "22222222-2222-4222-8222-222222222222";

async function loadActions() {
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
    requireMutationRole: mocks.state.requireRole,
  }));
  vi.doMock("@/lib/supabase/server", () => ({
    createClient: vi.fn(async () => mocks.client()),
  }));
  vi.doMock("@/lib/supabase/admin", () => ({
    createAdminClient: vi.fn(() => mocks.client()),
    createClinicScopedAdminClient: vi.fn(() => mocks.client()),
  }));
  vi.doMock("@/actions/patients", () => ({
    getPatientAccountBalance: vi.fn(async () => 0),
  }));

  const appointments = await import("@/actions/appointments");
  return { ...appointments, mocks };
}

// Appointment fixture that has no billing data attached
function uncharged(status: string = "pending") {
  return { status, paid_at: null, paid_amount: null, total_amount: null };
}

describe("softDeleteAppointment — Phase 6 deletion guard", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("allows soft-deleting a pending appointment", async () => {
    const { softDeleteAppointment, mocks } = await loadActions();
    mocks.state.tableResults["appointments.select"] = {
      data: uncharged("pending"),
      error: null,
    };

    const result = await softDeleteAppointment(APPOINTMENT_ID);

    expect(result).not.toHaveProperty("error");
    expect(mocks.state.queryLog).toContainEqual(
      expect.objectContaining({ table: "appointments", operation: "update" }),
    );
    expect(mocks.state.revalidatePath).toHaveBeenCalledWith("/appointments");
  });

  it("allows soft-deleting a confirmed appointment", async () => {
    const { softDeleteAppointment, mocks } = await loadActions();
    mocks.state.tableResults["appointments.select"] = {
      data: uncharged("confirmed"),
      error: null,
    };

    const result = await softDeleteAppointment(APPOINTMENT_ID);

    expect(result).not.toHaveProperty("error");
    expect(mocks.state.queryLog).toContainEqual(
      expect.objectContaining({ table: "appointments", operation: "update" }),
    );
  });

  it("blocks soft-delete when appointment status is completed", async () => {
    const { softDeleteAppointment, mocks } = await loadActions();
    mocks.state.tableResults["appointments.select"] = {
      data: { status: "completed", paid_at: null, paid_amount: null, total_amount: null },
      error: null,
    };

    const result = await softDeleteAppointment(APPOINTMENT_ID);

    expect(result.error).toMatch(/cannot be deleted/i);
    expect(mocks.state.queryLog).not.toContainEqual(
      expect.objectContaining({ table: "appointments", operation: "update" }),
    );
  });

  it("blocks soft-delete when paid_at is set regardless of status", async () => {
    const { softDeleteAppointment, mocks } = await loadActions();
    mocks.state.tableResults["appointments.select"] = {
      data: { status: "confirmed", paid_at: "2025-01-01T00:00:00Z", paid_amount: null, total_amount: null },
      error: null,
    };

    const result = await softDeleteAppointment(APPOINTMENT_ID);

    expect(result.error).toMatch(/cannot be deleted/i);
    expect(mocks.state.queryLog).not.toContainEqual(
      expect.objectContaining({ table: "appointments", operation: "update" }),
    );
  });

  it("blocks soft-delete when paid_amount is positive", async () => {
    const { softDeleteAppointment, mocks } = await loadActions();
    mocks.state.tableResults["appointments.select"] = {
      data: { status: "confirmed", paid_at: null, paid_amount: 100, total_amount: null },
      error: null,
    };

    const result = await softDeleteAppointment(APPOINTMENT_ID);

    expect(result.error).toMatch(/cannot be deleted/i);
    expect(mocks.state.queryLog).not.toContainEqual(
      expect.objectContaining({ table: "appointments", operation: "update" }),
    );
  });

  it("blocks soft-delete when total_amount is positive", async () => {
    const { softDeleteAppointment, mocks } = await loadActions();
    mocks.state.tableResults["appointments.select"] = {
      data: { status: "confirmed", paid_at: null, paid_amount: null, total_amount: 150 },
      error: null,
    };

    const result = await softDeleteAppointment(APPOINTMENT_ID);

    expect(result.error).toMatch(/cannot be deleted/i);
    expect(mocks.state.queryLog).not.toContainEqual(
      expect.objectContaining({ table: "appointments", operation: "update" }),
    );
  });

  it("returns an error when the appointment does not exist in the clinic", async () => {
    const { softDeleteAppointment, mocks } = await loadActions();
    mocks.state.tableResults["appointments.select"] = {
      data: null,
      error: { message: "No rows found" },
    };

    const result = await softDeleteAppointment(APPOINTMENT_ID);

    expect(result.error).toBeTruthy();
    expect(mocks.state.queryLog).not.toContainEqual(
      expect.objectContaining({ table: "appointments", operation: "update" }),
    );
  });
});

describe("restoreAppointment", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("clears deleted_at to restore the appointment", async () => {
    const { restoreAppointment, mocks } = await loadActions();

    const result = await restoreAppointment(APPOINTMENT_ID);

    expect(result).not.toHaveProperty("error");
    expect(mocks.state.queryLog).toContainEqual(
      expect.objectContaining({
        table: "appointments",
        operation: "update",
        args: [expect.objectContaining({ deleted_at: null })],
      }),
    );
    expect(mocks.state.revalidatePath).toHaveBeenCalledWith("/appointments");
  });
});

describe("permanentDeleteAppointment", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("hard-deletes a trashed appointment and its dependents", async () => {
    const { permanentDeleteAppointment, mocks } = await loadActions();
    mocks.state.tableResults["appointments.select"] = {
      data: { id: APPOINTMENT_ID },
      error: null,
    };

    const result = await permanentDeleteAppointment(APPOINTMENT_ID);

    expect(result).toEqual({ success: true });
    expect(mocks.state.queryLog).toContainEqual(
      expect.objectContaining({ table: "appointments", operation: "delete" }),
    );
    expect(mocks.state.revalidatePath).toHaveBeenCalledWith("/appointments");
  });

  it("propagates errors from dependent table cleanup", async () => {
    const { permanentDeleteAppointment, mocks } = await loadActions();
    mocks.state.tableResults["appointments.select"] = {
      data: { id: APPOINTMENT_ID },
      error: null,
    };
    mocks.state.tableResults["appointment_services.delete"] = {
      data: null,
      error: { message: "cannot delete due to constraint" },
    };

    const result = await permanentDeleteAppointment(APPOINTMENT_ID);

    expect(result.error).toBe("We could not complete this request. Please try again.");
    expect(mocks.state.queryLog).not.toContainEqual(
      expect.objectContaining({ table: "appointments", operation: "delete" }),
    );
  });

  it("does not cascade dependent deletes when the appointment is outside the clinic", async () => {
    const { permanentDeleteAppointment, mocks } = await loadActions();
    mocks.state.tableResults["appointments.select"] = {
      data: null,
      error: null,
    };

    const result = await permanentDeleteAppointment(APPOINTMENT_ID);

    expect(result.error).toBe("Appointment not found.");
    expect(mocks.state.queryLog).not.toContainEqual(
      expect.objectContaining({ table: "feedback", operation: "delete" }),
    );
    expect(mocks.state.queryLog).not.toContainEqual(
      expect.objectContaining({ table: "appointment_services", operation: "delete" }),
    );
  });
});

describe("emptyAppointmentsTrash — Phase 7 batch operations", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns success immediately when the trash is already empty", async () => {
    const { emptyAppointmentsTrash, mocks } = await loadActions();
    mocks.state.tableResults["appointments.select"] = {
      data: [],
      error: null,
    };

    const result = await emptyAppointmentsTrash();

    expect(result).toEqual({ success: true });
    expect(mocks.state.queryLog).not.toContainEqual(
      expect.objectContaining({ table: "appointment_services" }),
    );
    expect(mocks.state.queryLog).not.toContainEqual(
      expect.objectContaining({ table: "appointments", operation: "delete" }),
    );
  });

  it("uses a single batch .in() delete on each dependent table (Phase 7 refactor)", async () => {
    const { emptyAppointmentsTrash, mocks } = await loadActions();
    const ids = [APPOINTMENT_ID, APPOINTMENT_ID_2];
    mocks.state.tableResults["appointments.select"] = {
      data: ids.map((id) => ({ id })),
      error: null,
    };

    const result = await emptyAppointmentsTrash();

    expect(result).toEqual({ success: true });

    for (const table of [
      "appointment_services",
      "feedback",
      "follow_ups",
      "outstanding_settlements",
    ]) {
      expect(mocks.state.queryLog).toContainEqual(
        expect.objectContaining({
          table,
          operation: "delete",
          args: ["in", "appointment_id", ids],
        }),
      );
    }

    // The appointments row is deleted last, in one batch
    expect(mocks.state.queryLog).toContainEqual(
      expect.objectContaining({
        table: "appointments",
        operation: "delete",
        args: ["in", "id", ids],
      }),
    );

    expect(mocks.state.revalidatePath).toHaveBeenCalledWith("/appointments");
  });

  it("aborts and returns an error when a batch dependent delete fails", async () => {
    const { emptyAppointmentsTrash, mocks } = await loadActions();
    mocks.state.tableResults["appointments.select"] = {
      data: [{ id: APPOINTMENT_ID }],
      error: null,
    };
    mocks.state.tableResults["appointment_services.delete"] = {
      data: null,
      error: { message: "foreign key violation" },
    };

    const result = await emptyAppointmentsTrash();

    expect(result.error).toBe("We could not complete this request. Please try again.");
    expect(mocks.state.queryLog).not.toContainEqual(
      expect.objectContaining({ table: "appointments", operation: "delete" }),
    );
  });

  it("propagates errors from the select query before touching any rows", async () => {
    const { emptyAppointmentsTrash, mocks } = await loadActions();
    mocks.state.tableResults["appointments.select"] = {
      data: null,
      error: { message: "permission denied" },
    };

    const result = await emptyAppointmentsTrash();

    expect(result.error).toBe("We could not complete this request. Please try again.");
    expect(mocks.state.queryLog).not.toContainEqual(
      expect.objectContaining({ table: "appointment_services" }),
    );
  });
});
