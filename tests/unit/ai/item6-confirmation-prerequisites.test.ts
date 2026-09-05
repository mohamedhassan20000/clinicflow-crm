/**
 * Item #6 — a final confirmation is never asked for before it can be executed.
 *
 * ## The loop, as manual QA hit it
 *
 *   review → «موافق» → "the request could not be created" → review → «موافق» →
 *   "ملف الاستقبال المقترح غير محفوظ بعد" → collect data → review → …
 *
 * ## Why it looped
 *
 * Two different facts answered the same question. The ladder reached `confirm`
 * from `intakeStaged` — a *latch* on the stage record, which
 * `register_patient` also sets on the `linked_existing` outcome, where no
 * `ai_patient_intakes` row is created at all. The write refused on
 * `getPendingConversationIntake(...).is_third_party` — a *live row*. For a
 * third-party booking those two can disagree, and when they do the state
 * machine offers a confirmation the write is guaranteed to reject. Nothing
 * about failing the write moved the ladder, so the next turn offered the same
 * confirmation again.
 *
 * The rule pinned here: for a booking that is for somebody else, the confirm
 * rung is reachable only from the same staged third-party record
 * `create_preliminary_booking` requires. When it is missing the patient is
 * asked for the missing thing, not for a confirmation.
 */
import { describe, expect, it } from "vitest";

import { nextBookingStep } from "@/lib/ai/booking-stage";
import type { CollectedData } from "@/lib/ai/collected-state";

const complete: CollectedData = {
  department_id: "33333333-3333-4333-8333-333333333333",
  doctor_id: "44444444-4444-4444-8444-444444444444",
  appointment_date: "2026-09-10",
  appointment_time: 600,
};

const base = {
  collected: complete,
  linked: false,
  bookingForOther: false,
  intakeStaged: false,
  submitted: false,
};

describe("the confirm rung for a third-party booking", () => {
  it("is not reached from the latch alone when no third-party file is staged", () => {
    // Exactly the QA state: the latch is set (register_patient reported
    // `linked_existing` for the sender), the booking is for somebody else, and
    // no third-party intake row exists. The write would refuse this.
    expect(
      nextBookingStep({
        ...base,
        linked: true,
        bookingForOther: true,
        intakeStaged: true,
        thirdPartyIntakeStaged: false,
      }),
    ).toBe("intake");
  });

  it("is reached once the staged third-party record actually exists", () => {
    expect(
      nextBookingStep({
        ...base,
        linked: true,
        bookingForOther: true,
        intakeStaged: true,
        thirdPartyIntakeStaged: true,
      }),
    ).toBe("confirm");
  });

  it("still asks for intake when neither fact is satisfied", () => {
    expect(
      nextBookingStep({
        ...base,
        bookingForOther: true,
        intakeStaged: false,
        thirdPartyIntakeStaged: false,
      }),
    ).toBe("intake");
  });

  it("never regresses a submitted booking back to intake", () => {
    expect(
      nextBookingStep({
        ...base,
        bookingForOther: true,
        intakeStaged: true,
        thirdPartyIntakeStaged: false,
        submitted: true,
      }),
    ).toBe("done");
  });
});

describe("what the unification must not change", () => {
  it("leaves a linked patient booking for themself alone", () => {
    expect(
      nextBookingStep({ ...base, linked: true, bookingForOther: false }),
    ).toBe("confirm");
  });

  it("leaves a staged stranger booking for themself alone", () => {
    expect(
      nextBookingStep({ ...base, linked: false, intakeStaged: true }),
    ).toBe("confirm");
  });

  it("still asks an unstaged stranger for their intake", () => {
    expect(nextBookingStep({ ...base, linked: false, intakeStaged: false })).toBe(
      "intake",
    );
  });

  it("keeps every rung above intake exactly where it was", () => {
    expect(nextBookingStep({ ...base, collected: {} })).toBe("department");
    expect(
      nextBookingStep({ ...base, collected: { department_id: complete.department_id } }),
    ).toBe("doctor");
    expect(
      nextBookingStep({
        ...base,
        collected: { department_id: complete.department_id, doctor_id: complete.doctor_id },
      }),
    ).toBe("day");
    expect(
      nextBookingStep({
        ...base,
        collected: {
          department_id: complete.department_id,
          doctor_id: complete.doctor_id,
          appointment_date: complete.appointment_date,
        },
      }),
    ).toBe("time");
  });

  it("falls back to the latch when the live fact was not supplied", () => {
    // Callers that cannot read the database (the pure acceptance runner, the
    // ladder's own unit tests) keep exactly the pre-existing behaviour rather
    // than being silently forced down to `intake`.
    expect(
      nextBookingStep({ ...base, linked: true, bookingForOther: true, intakeStaged: true }),
    ).toBe("confirm");
  });
});
