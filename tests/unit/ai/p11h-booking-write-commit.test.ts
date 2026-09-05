import { describe, expect, it } from "vitest";
import { resolveBookingAuthority } from "@/lib/ai/booking-authority";
import { createGroundingLedger } from "@/lib/ai/patient-grounding";
import {
  enforcePatientWriteReply,
  hasPatientWriteSuccessClaim,
} from "@/lib/ai/patient-write-commit";

const ID = "11111111-1111-4111-8111-111111111111";

function authority(step: "day" | "intake" | "confirm") {
  return resolveBookingAuthority({
    step,
    collected: {},
    offeredDoctorIds: [],
    offeredDays: [],
    offeredSlots: [],
    closing: false,
    terminal: false,
    explicitBookingConfirmation: step === "confirm",
  });
}

describe("P11H · authoritative write receipts own success copy", () => {
  it("makes the intake rung a forced write boundary", () => {
    expect(authority("intake")).toMatchObject({
      requirement: "write_authority",
      operation: "register_patient",
      reason: "needs_intake",
    });
  });

  it("cannot claim an intake was staged without the returned intake entity", () => {
    const ledger = createGroundingLedger();
    ledger.record("register_patient", {
      registered: false,
      intake_staged: true,
      // The old result shape: success booleans, no returned entity id.
    });
    const result = enforcePatientWriteReply({
      locale: "en",
      text: "I have created the patient file.",
      authority: authority("intake"),
      ledger,
    });
    expect(result.outcome).toBe("failed");
    expect(result.entityId).toBeNull();
    expect(result.text).toMatch(/could not be saved|has not been saved/i);
  });

  it("renders staged-intake copy only from the returned intake entity", () => {
    const ledger = createGroundingLedger();
    ledger.record("register_patient", {
      registered: false,
      intake_staged: true,
      intake_id: ID,
      intake_status: "pending_review",
    });
    const result = enforcePatientWriteReply({
      locale: "en",
      text: "Your appointment is booked.",
      authority: authority("intake"),
      ledger,
    });
    expect(result).toMatchObject({
      outcome: "committed",
      operation: "register_patient",
      entityId: ID,
    });
    expect(result.text).toContain("created successfully and is awaiting clinic review");
    expect(result.text).toContain("continue with choosing an appointment");
    expect(result.text).not.toContain("confirm that you want it submitted");
  });

  it("turns a failed booking write into failure copy even when the model says success", () => {
    const ledger = createGroundingLedger();
    ledger.record("create_preliminary_booking", {
      created: false,
      reason: "slot_unavailable",
    });
    const result = enforcePatientWriteReply({
      locale: "en",
      text: "Done — I have booked the appointment.",
      authority: authority("confirm"),
      ledger,
    });
    expect(result.outcome).toBe("failed");
    expect(result.text).toContain("was not created");
    expect(result.text).not.toMatch(/successfully|is booked/i);
  });

  it("cannot treat a success boolean without a returned booking entity as success", () => {
    const ledger = createGroundingLedger();
    ledger.record("create_preliminary_booking", {
      created: true,
      status: "pending",
      expires_at: "2026-09-01T00:00:00Z",
    });
    const result = enforcePatientWriteReply({
      locale: "en",
      text: "Your appointment is booked.",
      authority: authority("confirm"),
      ledger,
    });
    expect(result.outcome).toBe("failed");
    expect(result.entityId).toBeNull();
  });

  it.each([
    ["third-party provisional request", { request_id: ID, provisional_intake: true }],
    ["self-booking appointment", { appointment_id: ID, provisional_intake: false }],
  ])("renders pending success for a returned %s", (_label, identity) => {
    const provisional = identity.provisional_intake === true;
    const ledger = createGroundingLedger();
    ledger.record("create_preliminary_booking", {
      created: true,
      ...identity,
      status: "pending",
      expires_at: "2026-09-01T00:00:00Z",
      requires_staff_confirmation: true,
      created_entity: {
        id: ID,
        entity: provisional ? "ai_appointment_request" : "appointment",
        status: "pending",
        booking_subject: provisional ? "third_party_intake" : "linked_patient",
        subject_id: "22222222-2222-4222-8222-222222222222",
        doctor: {
          id: "33333333-3333-4333-8333-333333333333",
          name: "Dr. Rana Wasfy",
        },
        department: {
          id: "44444444-4444-4444-8444-444444444444",
          name: "Dermatology",
        },
        scheduled_at: "2026-08-31T06:00:00.000Z",
        scheduled_local_date: "2026-08-31",
        scheduled_local_time: "09:00",
        expires_at: "2026-09-01T00:00:00Z",
      },
    });
    const result = enforcePatientWriteReply({
      locale: "en",
      text: "anything the model wrote",
      authority: authority("confirm"),
      ledger,
    });
    expect(result).toMatchObject({
      outcome: "committed",
      operation: "create_preliminary_booking",
      entityId: ID,
    });
    expect(result.text).toContain("Dr. Rana Wasfy");
    expect(result.text).toContain("2026-08-31 at 09:00");
    expect(result.text).toContain("pending confirmation");
  });

  it("uses accurate recovery copy when the forced booking tool never returned", () => {
    const result = enforcePatientWriteReply({
      locale: "ar",
      text: "تم حجز الموعد بنجاح",
      authority: authority("confirm"),
      ledger: createGroundingLedger(),
    });
    expect(result.outcome).toBe("failed");
    expect(result.text).toContain("الموعد غير محجوز");
  });

  it.each([
    ["ambiguous_date", "could be read in two ways"],
    ["incomplete_date", "complete date of birth"],
    ["conflicting_date", "different dates of birth"],
    ["unrecognized", "complete date of birth"],
    ["unrecognized_input", "complete date of birth"],
  ])("keeps recoverable registration result %s as a clarification", (reason, copy) => {
    const ledger = createGroundingLedger();
    ledger.record("register_patient", {
      registered: false,
      needs_clarification: true,
      reason,
    });
    const result = enforcePatientWriteReply({
      locale: "en",
      text: "The proposed patient file could not be saved.",
      authority: authority("intake"),
      ledger,
    });
    expect(result.outcome).toBe("clarification");
    expect(result.text).toContain(copy);
    expect(result.text).toMatch(/\?$/);
    expect(result.text).not.toMatch(/could not be saved|save failed/i);
  });

  it("uses the tool's localized patient question verbatim when one is present", () => {
    const patientQuestion = "ممكن تكتب اليوم واسم الشهر والسنة؟";
    const ledger = createGroundingLedger();
    ledger.record("register_patient", {
      registered: false,
      needs_clarification: true,
      reason: "unrecognized",
      patient_question: patientQuestion,
    });
    const result = enforcePatientWriteReply({
      locale: "ar",
      text: "تعذر حفظ الملف",
      authority: authority("intake"),
      ledger,
    });
    expect(result).toMatchObject({ outcome: "clarification", text: patientQuestion });
    expect(result.text).not.toContain("تعذر حفظ");
  });

  it("treats every explicitly flagged registration result as recoverable", () => {
    const ledger = createGroundingLedger();
    ledger.record("register_patient", {
      registered: false,
      needs_clarification: true,
      reason: "future_normalizer_reason",
    });
    const result = enforcePatientWriteReply({
      locale: "ar",
      text: "تعذّر حفظ ملف المريض",
      authority: authority("intake"),
      ledger,
    });
    expect(result.outcome).toBe("clarification");
    expect(result.text).toMatch(/[؟?]$/);
    expect(result.text).not.toMatch(/تعذر حفظ|تعذّر حفظ/);
  });

  it("enforces a recoverable result even outside a forced write rung and with no draft", () => {
    const ledger = createGroundingLedger();
    ledger.record("register_patient", {
      registered: false,
      needs_clarification: true,
      reason: "ambiguous_date",
    });
    const result = enforcePatientWriteReply({
      locale: "ar",
      text: "",
      authority: authority("day"),
      ledger,
    });
    expect(result.outcome).toBe("clarification");
    expect(result.text).toMatch(/اسم الشهر/);
    expect(result.text).not.toMatch(/تعذر حفظ|تعذّر حفظ/);
  });

  it("blocks premature bilingual success claims before a write rung", () => {
    for (const text of [
      "I have booked the appointment.",
      "The patient file has been created.",
      "تم حجز الموعد.",
      "فتحنا ملف المريض.",
    ]) {
      expect(hasPatientWriteSuccessClaim(text)).toBe(true);
      const result = enforcePatientWriteReply({
        locale: /[؀-ۿ]/.test(text) ? "ar" : "en",
        text,
        authority: authority("day"),
        ledger: createGroundingLedger(),
      });
      expect(result.outcome).toBe("unbacked_claim");
    }
  });
});
