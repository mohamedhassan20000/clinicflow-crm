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
    insurance_calculation_mode: "amount",
    insurance_percentage: null,
    patient_responsibility: 100,
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

function recentCompletionEvent(previousStatus = "confirmed") {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    action: "appointment.completed",
    occurred_at: new Date().toISOString(),
    previous_state: { status: previousStatus },
  };
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
    requireUser: mocks.state.requireRole,
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
        patient_responsibility: 90,
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
      p_insurance_calculation_mode: "amount",
      p_insurance_percentage: null,
      p_patient_responsibility: 90,
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
      p_insurance_calculation_mode: "amount",
      p_insurance_percentage: null,
      p_patient_responsibility: 100,
      p_secondary_amount: 0,
      p_secondary_payment_method: null,
      p_deposit_amount: 0,
      p_payment_note: null,
    });
  });

  it("persists percentage insurance metadata and the reconciled responsibility", async () => {
    const { updateAppointmentStatus, mocks } = await loadActions();
    mocks.state.tableResults["appointments.select"] = {
      data: { status: "confirmed", patient_id: PATIENT_ID },
      error: null,
    };

    const result = await updateAppointmentStatus(
      APPOINTMENT_ID,
      "completed",
      billingPayload({
        paid_amount: 85,
        insurance_amount: 15,
        insurance_calculation_mode: "percentage",
        insurance_percentage: 15,
        patient_responsibility: 85,
      }) as never,
    );

    expect(result).toEqual({});
    expect(mocks.state.rpc).toHaveBeenCalledWith(
      "complete_appointment_billing",
      expect.objectContaining({
        p_insurance_amount: 15,
        p_insurance_calculation_mode: "percentage",
        p_insurance_percentage: 15,
        p_patient_responsibility: 85,
      }),
    );
  });

  it("submits the exact screenshot allocation to the percentage insurance RPC", async () => {
    const { updateAppointmentStatus, mocks } = await loadActions();
    mocks.state.tableResults["appointments.select"] = {
      data: { status: "confirmed", patient_id: PATIENT_ID },
      error: null,
    };

    const result = await updateAppointmentStatus(
      APPOINTMENT_ID,
      "completed",
      billingPayload({
        line_items: [{ name: "Treatment", price: 5800, quantity: 1 }],
        paid_amount: 2800,
        insurance_amount: 870,
        insurance_calculation_mode: "percentage",
        insurance_percentage: 15,
        patient_responsibility: 4930,
        secondary_payment_method: "credit_card",
        secondary_amount: 2130,
      }) as never,
    );

    expect(result).toEqual({});
    expect(mocks.state.rpc).toHaveBeenCalledWith(
      "complete_appointment_billing",
      {
        p_appointment_id: APPOINTMENT_ID,
        p_line_items: [{ name: "Treatment", price: 5800, quantity: 1 }],
        p_paid_amount: 2800,
        p_payment_method: "cash",
        p_insurance_amount: 870,
        p_insurance_calculation_mode: "percentage",
        p_insurance_percentage: 15,
        p_patient_responsibility: 4930,
        p_secondary_amount: 2130,
        p_secondary_payment_method: "credit_card",
        p_deposit_amount: 0,
        p_payment_note: null,
      },
    );
  });

  it("rejects insurance above the invoice total", async () => {
    const { updateAppointmentStatus, mocks } = await loadActions();
    mocks.state.tableResults["appointments.select"] = {
      data: { status: "confirmed", patient_id: PATIENT_ID },
      error: null,
    };

    const result = await updateAppointmentStatus(
      APPOINTMENT_ID,
      "completed",
      billingPayload({
        paid_amount: 0,
        insurance_amount: 110,
        patient_responsibility: 0,
      }) as never,
    );

    expect(result.error).toBe(
      "Insurance contribution cannot exceed the invoice total.",
    );
    expect(mocks.state.rpc).not.toHaveBeenCalled();
  });

  it("rejects split patient payments above patient responsibility", async () => {
    const { updateAppointmentStatus, mocks } = await loadActions();
    mocks.state.tableResults["appointments.select"] = {
      data: { status: "confirmed", patient_id: PATIENT_ID },
      error: null,
    };

    const result = await updateAppointmentStatus(
      APPOINTMENT_ID,
      "completed",
      billingPayload({
        paid_amount: 50,
        insurance_amount: 30,
        patient_responsibility: 70,
        secondary_payment_method: "credit_card",
        secondary_amount: 30,
      }) as never,
    );

    expect(result.error).toBe(
      "Patient payments cannot exceed patient responsibility.",
    );
    expect(mocks.state.rpc).not.toHaveBeenCalled();
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
        p_insurance_calculation_mode: "amount",
        p_insurance_percentage: null,
        p_patient_responsibility: 100,
        p_secondary_amount: 0,
        p_secondary_payment_method: null,
        p_deposit_amount: 0,
        p_payment_note: null,
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
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
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
      error: "We could not complete this request. Please try again.",
    });
    expect(consoleError).toHaveBeenCalledWith(
      "appointment_billing_transaction_failed",
      expect.objectContaining({
        appointmentId: APPOINTMENT_ID,
        rpc: "complete_appointment_billing_with_previous_settlement",
        message: "Previous settlement exceeds previous outstanding balance",
        stack: expect.stringContaining(
          "Appointment billing transaction failed",
        ),
      }),
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

    expect(result.error).toBe(
      "Patient payments cannot exceed patient responsibility.",
    );
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
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const { updateAppointmentStatus, mocks } = await loadActions();
    mocks.state.tableResults["appointments.select"] = {
      data: { status: "confirmed", patient_id: PATIENT_ID },
      error: null,
    };
    mocks.state.rpcResults.complete_appointment_billing = {
      data: null,
      error: {
        code: "PGRST202",
        message: "Could not find the function public.complete_appointment_billing",
        details: "No exact 12-argument overload exists in the schema cache.",
        hint: "Perhaps you meant the legacy 9-argument function.",
      },
    };

    const result = await updateAppointmentStatus(
      APPOINTMENT_ID,
      "completed",
      billingPayload() as never,
    );

    expect(result).toEqual({
      error: "We could not complete this request. Please try again.",
    });
    expect(consoleError).toHaveBeenCalledWith(
      "appointment_billing_transaction_failed",
      expect.objectContaining({
        appointmentId: APPOINTMENT_ID,
        rpc: "complete_appointment_billing",
        code: "PGRST202",
        message:
          "Could not find the function public.complete_appointment_billing",
        details: "No exact 12-argument overload exists in the schema cache.",
        hint: "Perhaps you meant the legacy 9-argument function.",
        financialContext: {
          submitted: {
            paidAmount: 100,
            insuranceAmount: 0,
            insuranceCalculationMode: "amount",
            insurancePercentage: null,
            patientResponsibility: 100,
            secondaryAmount: 0,
            depositAmount: 0,
          },
          normalized: {
            invoiceTotal: 100,
            paidAmount: 100,
            insuranceAmount: 0,
            insuranceCalculationMode: "amount",
            insurancePercentage: null,
            patientResponsibility: 100,
            secondaryAmount: 0,
            depositAmount: 0,
            grossAllocated: 100,
            outstandingAmount: 0,
          },
          rpcArguments: expect.objectContaining({
            p_paid_amount: 100,
            p_insurance_amount: 0,
            p_patient_responsibility: 100,
          }),
        },
        stack: expect.stringContaining(
          "Appointment billing transaction failed",
        ),
      }),
    );
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
    mocks.state.tableResults["appointments.select"] = {
      data: { patient_id: PATIENT_ID, status: "completed" },
      error: null,
    };
    mocks.state.tableResults["activity_events.select"] = {
      data: recentCompletionEvent(),
      error: null,
    };
    mocks.state.tableResults["outstanding_settlements.select"] = {
      data: [],
      error: null,
    };

    const result = await undoInvoiceCompletion(APPOINTMENT_ID);

    expect(result).toMatchObject({
      success: true,
      targetStatus: "confirmed",
      rpc: "undo_appointment_billing",
      eligibility: {
        canUndo: true,
        reason: "eligible",
        targetStatus: "confirmed",
      },
    });
    expect(mocks.state.rpc).toHaveBeenCalledWith("undo_appointment_billing", {
      p_appointment_id: APPOINTMENT_ID,
      p_target_status: "confirmed",
    });
    expect(mocks.state.revalidatePath).toHaveBeenCalledWith("/appointments");
    expect(mocks.state.revalidatePath).toHaveBeenCalledWith(
      `/patients/${PATIENT_ID}`,
    );
    expect(mocks.state.revalidatePath).toHaveBeenCalledWith("/revenue");
    expect(mocks.state.revalidatePath).toHaveBeenCalledWith("/reports/revenue");
  });

  it("undoes invoice completion through the previous settlement undo RPC when provenance exists", async () => {
    const { undoInvoiceCompletion, mocks } = await loadActions();
    mocks.state.tableResults["appointments.select"] = {
      data: { patient_id: PATIENT_ID, status: "completed" },
      error: null,
    };
    mocks.state.tableResults["activity_events.select"] = {
      data: recentCompletionEvent("in_session"),
      error: null,
    };
    mocks.state.tableResults["outstanding_settlements.select"] = {
      data: [{ id: "settlement-1" }],
      error: null,
    };

    const result = await undoInvoiceCompletion(APPOINTMENT_ID);

    expect(result).toMatchObject({
      success: true,
      targetStatus: "in_session",
      rpc: "undo_appointment_billing_with_previous_settlement",
    });
    expect(mocks.state.rpc).toHaveBeenCalledWith(
      "undo_appointment_billing_with_previous_settlement",
      {
        p_appointment_id: APPOINTMENT_ID,
        p_target_status: "in_session",
      },
    );
    expect(mocks.state.rpc).not.toHaveBeenCalledWith(
      "undo_appointment_billing",
      expect.anything(),
    );
  });

  it("does not call the Undo RPC after the grace window expires", async () => {
    const { undoInvoiceCompletion, mocks } = await loadActions();
    mocks.state.tableResults["appointments.select"] = {
      data: { patient_id: PATIENT_ID, status: "completed" },
      error: null,
    };
    mocks.state.tableResults["activity_events.select"] = {
      data: {
        ...recentCompletionEvent(),
        occurred_at: new Date(Date.now() - 10_001).toISOString(),
      },
      error: null,
    };

    const result = await undoInvoiceCompletion(APPOINTMENT_ID);

    expect(result).toMatchObject({
      error: "The 10-second billing Undo window has expired.",
      eligibility: {
        canUndo: false,
        reason: "expired",
      },
    });
    expect(mocks.state.rpc).not.toHaveBeenCalled();
  });

  it("orders semantic billing events deterministically before Undo", async () => {
    const { getInvoiceUndoEligibility, mocks } = await loadActions();
    mocks.state.tableResults["appointments.select"] = {
      data: { patient_id: PATIENT_ID, status: "completed" },
      error: null,
    };
    mocks.state.tableResults["activity_events.select"] = {
      data: recentCompletionEvent(),
      error: null,
    };

    const result = await getInvoiceUndoEligibility(APPOINTMENT_ID);

    expect(result.canUndo).toBe(true);
    expect(mocks.state.queryLog).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: "activity_events",
          operation: "select",
          args: ["order", "occurred_at", { ascending: false }],
        }),
        expect.objectContaining({
          table: "activity_events",
          operation: "select",
          args: ["order", "id", { ascending: false }],
        }),
      ]),
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
