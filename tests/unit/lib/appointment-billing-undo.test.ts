import { describe, expect, it } from "vitest";
import {
  APPOINTMENT_UNDO_WINDOW_MS,
  computeBillingUndoEligibility,
  type BillingUndoActivityEvent,
} from "@/lib/appointments/billing-undo";

const COMPLETED_AT = "2026-07-29T12:00:00.000Z";

function completionEvent(
  previousStatus: string = "confirmed",
): BillingUndoActivityEvent {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    action: "appointment.completed",
    occurred_at: COMPLETED_AT,
    previous_state: {
      status: previousStatus,
      total_amount: null,
      insurance_amount: null,
      insurance_calculation_mode: "amount",
      insurance_percentage: null,
      patient_responsibility: null,
      paid_amount: null,
      secondary_amount: 0,
      deposit_amount: 0,
    },
  };
}

describe("billing Undo eligibility", () => {
  it.each(["pending", "confirmed", "arrived", "in_session"] as const)(
    "derives the %s restore target from the semantic completion event",
    (targetStatus) => {
      const result = computeBillingUndoEligibility({
        currentStatus: "completed",
        role: "receptionist",
        latestBillingEvent: completionEvent(targetStatus),
        now: new Date(
          new Date(COMPLETED_AT).getTime() + APPOINTMENT_UNDO_WINDOW_MS - 1,
        ),
      });

      expect(result).toMatchObject({
        canUndo: true,
        reason: "eligible",
        targetStatus,
      });
    },
  );

  it("does not make insurance allocation fields part of eligibility", () => {
    const event = completionEvent();
    event.previous_state = {
      status: "confirmed",
      insurance_amount: null,
      insurance_calculation_mode: null,
      insurance_percentage: null,
      patient_responsibility: null,
    };

    expect(
      computeBillingUndoEligibility({
        currentStatus: "completed",
        role: "manager",
        latestBillingEvent: event,
        now: new Date(COMPLETED_AT),
      }),
    ).toMatchObject({
      canUndo: true,
      targetStatus: "confirmed",
    });
  });

  it("expires at the documented appointment grace window", () => {
    const result = computeBillingUndoEligibility({
      currentStatus: "completed",
      role: "admin",
      latestBillingEvent: completionEvent(),
      now: new Date(
        new Date(COMPLETED_AT).getTime() + APPOINTMENT_UNDO_WINDOW_MS + 1,
      ),
    });

    expect(result).toMatchObject({
      canUndo: false,
      reason: "expired",
      targetStatus: null,
    });
  });

  it("rejects an already-undone latest semantic billing event", () => {
    const result = computeBillingUndoEligibility({
      currentStatus: "completed",
      role: "admin",
      latestBillingEvent: {
        ...completionEvent(),
        action: "appointment.billing_completion_undone",
      },
      now: new Date(COMPLETED_AT),
    });

    expect(result).toMatchObject({
      canUndo: false,
      reason: "completion_already_undone",
    });
  });

  it("fails closed when the completion event has no valid previous status", () => {
    const result = computeBillingUndoEligibility({
      currentStatus: "completed",
      role: "admin",
      latestBillingEvent: completionEvent("completed"),
      now: new Date(COMPLETED_AT),
    });

    expect(result).toMatchObject({
      canUndo: false,
      reason: "invalid_previous_status",
    });
  });

  it.each(["doctor", "assistant"] as const)(
    "does not authorize the %s role",
    (role) => {
      const result = computeBillingUndoEligibility({
        currentStatus: "completed",
        role,
        latestBillingEvent: completionEvent(),
        now: new Date(COMPLETED_AT),
      });

      expect(result).toMatchObject({
        canUndo: false,
        reason: "unauthorized",
      });
    },
  );
});
