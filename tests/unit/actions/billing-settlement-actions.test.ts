import { beforeEach, describe, expect, it, vi } from "vitest";
import { createServerActionMocks } from "../helpers/server-action-mocks";

const APPOINTMENT_ID = "11111111-1111-4111-8111-111111111111";
const PATIENT_ID = "22222222-2222-4222-8222-222222222222";

function billingPayload(overrides: Record<string, unknown> = {}) {
  return {
    line_items: [{ name: "Consultation", price: 100, quantity: 1 }],
    paid_amount: 100,
    payment_method: "cash",
    insurance_amount: 0,
    secondary_payment_method: null,
    secondary_amount: 0,
    deposit_amount: 0,
    payment_note: null,
    ...overrides,
  };
}

function settlementForm(overrides: Record<string, string> = {}) {
  const form = new FormData();
  form.set("patient_id", PATIENT_ID);
  form.set("appointment_id", APPOINTMENT_ID);
  form.set("amount", "50");
  form.set("payment_method", "cash");
  form.set("secondary_amount", "0");
  form.set("secondary_payment_method", "");
  form.set("note", "");
  for (const [key, value] of Object.entries(overrides)) {
    form.set(key, value);
  }
  return form;
}

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
  }));
  vi.doMock("@/lib/supabase/server", () => ({
    createClient: vi.fn(async () => mocks.client()),
  }));
  vi.doMock("@/lib/supabase/admin", () => ({
    createAdminClient: vi.fn(() => mocks.client()),
  }));

  const appointments = await import("@/actions/appointments");
  const patients = await import("@/actions/patients");

  return { ...appointments, ...patients, mocks };
}

describe("billing and settlement server actions", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("completes appointment billing through the transactional RPC", async () => {
    const { updateAppointmentStatus, mocks } = await loadActions();
    mocks.state.tableResults["appointments.select"] = {
      data: { status: "confirmed", patient_id: PATIENT_ID },
      error: null,
    };

    const result = await updateAppointmentStatus(
      APPOINTMENT_ID,
      "completed",
      billingPayload({
        paid_amount: 80,
        insurance_amount: 10,
        secondary_payment_method: "credit_card",
        secondary_amount: 10,
        payment_note: "Split payment",
      }) as never,
    );

    expect(result).toEqual({});
    expect(mocks.state.rpc).toHaveBeenCalledWith("complete_appointment_billing", {
      p_appointment_id: APPOINTMENT_ID,
      p_line_items: [{ name: "Consultation", price: 100, quantity: 1 }],
      p_paid_amount: 80,
      p_payment_method: "cash",
      p_insurance_amount: 10,
      p_secondary_amount: 10,
      p_secondary_payment_method: "credit_card",
      p_deposit_amount: 0,
      p_payment_note: "Split payment",
    });
    expect(mocks.state.revalidatePath).toHaveBeenCalledWith("/appointments");
    expect(mocks.state.revalidatePath).toHaveBeenCalledWith(
      `/patients/${PATIENT_ID}`,
    );
  });

  it("rejects overpayment before calling the billing RPC", async () => {
    const { updateAppointmentStatus, mocks } = await loadActions();
    mocks.state.tableResults["appointments.select"] = {
      data: { status: "confirmed", patient_id: PATIENT_ID },
      error: null,
    };

    const result = await updateAppointmentStatus(
      APPOINTMENT_ID,
      "completed",
      billingPayload({ paid_amount: 101 }) as never,
    );

    expect(result.error).toBe("Collected amount exceeds invoice total.");
    expect(mocks.state.rpc).not.toHaveBeenCalled();
  });

  it("rejects deposit above account balance before calling the billing RPC", async () => {
    const { updateAppointmentStatus, mocks } = await loadActions();
    mocks.state.tableResults["appointments.select"] = [
      { data: { status: "confirmed", patient_id: PATIENT_ID }, error: null },
      { data: [{ deposit_amount: 0 }], error: null },
    ];
    mocks.state.tableResults["patient_deposits.select"] = {
      data: [{ amount: 5 }],
      error: null,
    };

    const result = await updateAppointmentStatus(
      APPOINTMENT_ID,
      "completed",
      billingPayload({ paid_amount: 90, deposit_amount: 10 }) as never,
    );

    expect(result.error).toContain("exceeds patient's account balance");
    expect(mocks.state.rpc).not.toHaveBeenCalled();
  });

  it("returns billing RPC errors cleanly", async () => {
    const { updateAppointmentStatus, mocks } = await loadActions();
    mocks.state.tableResults["appointments.select"] = {
      data: { status: "confirmed", patient_id: PATIENT_ID },
      error: null,
    };
    mocks.state.rpcResults.complete_appointment_billing = {
      data: null,
      error: { message: "Appointment was already completed" },
    };

    const result = await updateAppointmentStatus(
      APPOINTMENT_ID,
      "completed",
      billingPayload() as never,
    );

    expect(result).toEqual({ error: "Appointment was already completed" });
  });

  it("undoes invoice completion through the billing undo RPC", async () => {
    const { undoInvoiceCompletion, mocks } = await loadActions();
    mocks.state.tableResults["appointments.select"] = {
      data: { patient_id: PATIENT_ID },
      error: null,
    };

    const result = await undoInvoiceCompletion(APPOINTMENT_ID, "confirmed");

    expect(result).toEqual({});
    expect(mocks.state.rpc).toHaveBeenCalledWith("undo_appointment_billing", {
      p_appointment_id: APPOINTMENT_ID,
      p_target_status: "confirmed",
    });
    expect(mocks.state.revalidatePath).toHaveBeenCalledWith("/appointments");
    expect(mocks.state.revalidatePath).toHaveBeenCalledWith(
      `/patients/${PATIENT_ID}`,
    );
  });

  it("settles outstanding balances through the settlement RPC", async () => {
    const { settleOutstanding, mocks } = await loadActions();

    const result = await settleOutstanding(
      null,
      settlementForm({
        amount: "75",
        payment_method: "cash",
        secondary_amount: "25",
        secondary_payment_method: "credit_card",
        note: "Partial settlement",
      }),
    );

    expect(result).toEqual({});
    expect(mocks.state.rpc).toHaveBeenCalledWith("settle_patient_outstanding", {
      p_patient_id: PATIENT_ID,
      p_appointment_id: APPOINTMENT_ID,
      p_amount: 75,
      p_payment_method: "cash",
      p_secondary_amount: 25,
      p_secondary_payment_method: "credit_card",
      p_note: "Partial settlement",
    });
    expect(mocks.state.revalidatePath).toHaveBeenCalledWith(
      `/patients/${PATIENT_ID}`,
    );
  });

  it("rejects invalid settlement input before calling the settlement RPC", async () => {
    const { settleOutstanding, mocks } = await loadActions();

    const result = await settleOutstanding(
      null,
      settlementForm({ amount: "0" }),
    );

    expect(result).toEqual({ error: "Amount must be greater than zero." });
    expect(mocks.state.rpc).not.toHaveBeenCalled();
  });
});
