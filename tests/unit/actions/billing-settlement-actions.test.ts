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
    createClinicScopedAdminClient: vi.fn(() => mocks.client()),
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

  it("keeps zero previous settlement on the existing billing RPC", async () => {
    const { updateAppointmentStatus, mocks } = await loadActions();
    mocks.state.tableResults["appointments.select"] = {
      data: { status: "confirmed", patient_id: PATIENT_ID },
      error: null,
    };

    const result = await updateAppointmentStatus(
      APPOINTMENT_ID,
      "completed",
      billingPayload({
        previous_settlement_amount: 0,
        previous_payment_method: null,
      }) as never,
    );

    expect(result).toEqual({});
    expect(mocks.state.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.state.rpc).toHaveBeenCalledWith("complete_appointment_billing", {
      p_appointment_id: APPOINTMENT_ID,
      p_line_items: [{ name: "Consultation", price: 100, quantity: 1 }],
      p_paid_amount: 100,
      p_payment_method: "cash",
      p_insurance_amount: 0,
      p_secondary_amount: 0,
      p_secondary_payment_method: undefined,
      p_deposit_amount: 0,
      p_payment_note: undefined,
    });
  });

  it("uses the previous outstanding billing RPC when previous settlement is positive", async () => {
    const { updateAppointmentStatus, mocks } = await loadActions();
    mocks.state.tableResults["appointments.select"] = {
      data: { status: "confirmed", patient_id: PATIENT_ID },
      error: null,
    };

    const result = await updateAppointmentStatus(
      APPOINTMENT_ID,
      "completed",
      billingPayload({
        previous_settlement_amount: 25,
        previous_payment_method: "cash",
        previous_note: "Old balance on this receipt",
      }) as never,
    );

    expect(result).toEqual({});
    expect(mocks.state.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.state.rpc).toHaveBeenCalledWith(
      "complete_appointment_billing_with_previous_settlement",
      {
        p_appointment_id: APPOINTMENT_ID,
        p_line_items: [{ name: "Consultation", price: 100, quantity: 1 }],
        p_paid_amount: 100,
        p_payment_method: "cash",
        p_insurance_amount: 0,
        p_secondary_amount: 0,
        p_secondary_payment_method: undefined,
        p_deposit_amount: 0,
        p_payment_note: undefined,
        p_previous_settlement_amount: 25,
        p_previous_payment_method: "cash",
        p_previous_note: "Old balance on this receipt",
      },
    );
  });

  it("keeps previous settlement separate from service line items", async () => {
    const { updateAppointmentStatus, mocks } = await loadActions();
    mocks.state.tableResults["appointments.select"] = {
      data: { status: "confirmed", patient_id: PATIENT_ID },
      error: null,
    };

    await updateAppointmentStatus(
      APPOINTMENT_ID,
      "completed",
      billingPayload({
        previous_settlement_amount: 25,
        previous_payment_method: "cash",
      }) as never,
    );

    const [, args] = mocks.state.rpc.mock.calls[0];
    expect(args).toMatchObject({
      p_line_items: [{ name: "Consultation", price: 100, quantity: 1 }],
      p_previous_settlement_amount: 25,
    });
  });

  it("rejects negative previous settlement before calling the billing RPC", async () => {
    const { updateAppointmentStatus, mocks } = await loadActions();
    mocks.state.tableResults["appointments.select"] = {
      data: { status: "confirmed", patient_id: PATIENT_ID },
      error: null,
    };

    const result = await updateAppointmentStatus(
      APPOINTMENT_ID,
      "completed",
      billingPayload({ previous_settlement_amount: -1 }) as never,
    );

    expect(result.error).toBe("Previous settlement amount cannot be negative.");
    expect(mocks.state.rpc).not.toHaveBeenCalled();
  });

  it("requires a previous payment method before calling the previous settlement RPC", async () => {
    const { updateAppointmentStatus, mocks } = await loadActions();
    mocks.state.tableResults["appointments.select"] = {
      data: { status: "confirmed", patient_id: PATIENT_ID },
      error: null,
    };

    const result = await updateAppointmentStatus(
      APPOINTMENT_ID,
      "completed",
      billingPayload({
        previous_settlement_amount: 25,
        previous_payment_method: null,
      }) as never,
    );

    expect(result.error).toBe("Select a payment method for previous balance.");
    expect(mocks.state.rpc).not.toHaveBeenCalled();
  });

  it("rejects overly long previous settlement notes before calling the billing RPC", async () => {
    const { updateAppointmentStatus, mocks } = await loadActions();
    mocks.state.tableResults["appointments.select"] = {
      data: { status: "confirmed", patient_id: PATIENT_ID },
      error: null,
    };

    const result = await updateAppointmentStatus(
      APPOINTMENT_ID,
      "completed",
      billingPayload({
        previous_settlement_amount: 25,
        previous_payment_method: "cash",
        previous_note: "x".repeat(501),
      }) as never,
    );

    expect(result.error).toBe("Previous note must be 500 characters or less.");
    expect(mocks.state.rpc).not.toHaveBeenCalled();
  });

  it("returns previous settlement RPC errors cleanly", async () => {
    const { updateAppointmentStatus, mocks } = await loadActions();
    mocks.state.tableResults["appointments.select"] = {
      data: { status: "confirmed", patient_id: PATIENT_ID },
      error: null,
    };
    mocks.state.rpcResults.complete_appointment_billing_with_previous_settlement = {
      data: null,
      error: { message: "Previous settlement exceeds previous outstanding balance" },
    };

    const result = await updateAppointmentStatus(
      APPOINTMENT_ID,
      "completed",
      billingPayload({
        previous_settlement_amount: 25,
        previous_payment_method: "cash",
      }) as never,
    );

    expect(result).toEqual({
      error: "Previous settlement exceeds previous outstanding balance",
    });
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

  it("returns previous outstanding balance in billing context", async () => {
    const { getBillingContext, mocks } = await loadActions();
    mocks.state.tableResults["appointments.select"] = [
      {
        data: {
          id: APPOINTMENT_ID,
          patient_id: PATIENT_ID,
          department_id: "dept-1",
          insurance_provider_id: null,
          patients: { full_name: "Billing Patient" },
          departments: { name: "General", color: "#0891b2" },
          insurance_providers: null,
        },
        error: null,
      },
      {
        data: [{ outstanding_amount: 20 }, { outstanding_amount: 30.5 }],
        error: null,
      },
      { data: [{ deposit_amount: 0 }], error: null },
    ];
    mocks.state.tableResults["patient_deposits.select"] = {
      data: [],
      error: null,
    };
    mocks.state.tableResults["services.select"] = {
      data: [],
      error: null,
    };

    const result = await getBillingContext(APPOINTMENT_ID);

    expect(result.data?.previousOutstandingBalance).toBe(50.5);
    expect(mocks.state.queryLog).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: "appointments",
          operation: "select",
          args: ["neq", "id", APPOINTMENT_ID],
        }),
      ]),
    );
  });

  it("undoes invoice completion through the billing undo RPC", async () => {
    const { undoInvoiceCompletion, mocks } = await loadActions();
    mocks.state.tableResults["appointments.select"] = [
      { data: { patient_id: PATIENT_ID }, error: null },
    ];
    mocks.state.tableResults["outstanding_settlements.select"] = {
      data: [],
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

  it("undoes invoice completion through the previous settlement undo RPC when provenance exists", async () => {
    const { undoInvoiceCompletion, mocks } = await loadActions();
    mocks.state.tableResults["appointments.select"] = [
      { data: { patient_id: PATIENT_ID }, error: null },
    ];
    mocks.state.tableResults["outstanding_settlements.select"] = {
      data: [{ id: "settlement-1" }],
      error: null,
    };

    const result = await undoInvoiceCompletion(APPOINTMENT_ID, "confirmed");

    expect(result).toEqual({});
    expect(mocks.state.rpc).toHaveBeenCalledWith(
      "undo_appointment_billing_with_previous_settlement",
      {
        p_appointment_id: APPOINTMENT_ID,
        p_target_status: "confirmed",
      },
    );
    expect(mocks.state.rpc).not.toHaveBeenCalledWith(
      "undo_appointment_billing",
      expect.anything(),
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
