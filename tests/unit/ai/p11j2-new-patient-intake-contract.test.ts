import { describe, expect, it } from "vitest";
import { resolveBookingAuthority } from "@/lib/ai/booking-authority";
import { createGroundingLedger } from "@/lib/ai/patient-grounding";
import { enforcePatientWriteReply } from "@/lib/ai/patient-write-commit";
import {
  PATIENT_INTAKE_FIELDS,
  askableIntakeFields,
  buildIntakeQuestion,
  containsInternalFieldName,
  isRequiredIntakeField,
  isSkippableIntakeField,
  patientFacingFieldLabel,
  patientFacingLabel,
  requiredByIntakeStaging,
  requiredByPatientSchema,
  scrubInternalFieldNames,
} from "@/lib/ai/patient-intake-contract";
import {
  parseBookingStageState,
  serializeBookingStageState,
} from "@/lib/ai/booking-stage";
import { patientCreateSchema } from "@/lib/patients/mutations";
import { resolveField } from "@/lib/ai/collected-state";
import { fieldLabel } from "@/lib/ai/turn-briefing";

/**
 * The identifiers the P11J manual QA saw in a patient's WhatsApp thread, plus
 * every other schema key that must never follow them there.
 */
const FORBIDDEN = [
  "national_id",
  "date_of_birth",
  "blood_type",
  "department_id",
  "doctor_id",
  "missing_fields",
  "full_name",
  "assigned_doctor_id",
  "intake_id",
  "patient_id",
] as const;

/**
 * `phone` and `email` are absent from the list above and checked separately,
 * because "your phone number" is correct English copy and "phone" is only an
 * identifier when it stands alone — which is exactly the distinction the
 * production scrubber draws, so the assertion delegates to it.
 */
function expectNoInternalNames(text: string, locale: "ar" | "en" = "en") {
  for (const token of FORBIDDEN) {
    expect(text, `patient-visible copy leaked ${token}`).not.toContain(token);
  }
  // Nothing identifier-shaped at all, named or not.
  expect(text).not.toMatch(/[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9]+/);
  expect(
    containsInternalFieldName(text, locale),
    "patient-visible copy leaked an internal field name",
  ).toBe(false);
  // A bare Latin field word has no business in Arabic copy at all.
  if (locale === "ar") expect(text).not.toMatch(/\b(phone|email|gender)\b/i);
}

function authority(step: "day" | "intake" | "confirm") {
  return resolveBookingAuthority({
    step,
    collected: {},
    offeredDoctorIds: [],
    offeredDays: [],
    offeredSlots: [],
    closing: false,
    terminal: false,
  });
}

// ---------------------------------------------------------------------------

describe("P11J-2 · the intake contract is the real patient schema", () => {
  it("derives required fields from patientCreateSchema, not a hand-written list", () => {
    // If someone makes email optional on the New Patient form, this flips with
    // no edit here — which is the whole point of deriving it.
    for (const field of PATIENT_INTAKE_FIELDS) {
      const derived = requiredByPatientSchema(field) || requiredByIntakeStaging(field);
      expect(isRequiredIntakeField(field)).toBe(derived);
    }
  });

  it("matches what the live schema actually says, including the two brief mismatches", () => {
    // Asked for by the QA brief, and confirmed required.
    expect(isRequiredIntakeField("full_name")).toBe(true);
    expect(isRequiredIntakeField("national_id")).toBe(true);
    expect(isRequiredIntakeField("date_of_birth")).toBe(true);
    // Required by ai_patient_intakes NOT NULL even though patientSchema treats
    // the assignment as optional on the patient record.
    expect(requiredByPatientSchema("department_id")).toBe(false);
    expect(requiredByIntakeStaging("department_id")).toBe(true);
    expect(isRequiredIntakeField("department_id")).toBe(true);
    expect(isRequiredIntakeField("doctor_id")).toBe(true);
    // Mismatch 1: the brief did not list email; the live schema requires it.
    expect(requiredByPatientSchema("email")).toBe(true);
    expect(isRequiredIntakeField("email")).toBe(true);
    // Mismatch 2: the brief called phone optional; the live schema requires it.
    expect(requiredByPatientSchema("phone")).toBe(true);
    // Genuinely optional in both.
    expect(isRequiredIntakeField("blood_type")).toBe(false);
  });

  it("keeps the derivation honest against patientCreateSchema itself", () => {
    const missingEmail = patientCreateSchema.safeParse({
      full_name: "Test Patient",
      national_id: "AB12345",
      date_of_birth: "1990-01-01",
      phone: "+201000000000",
      blood_type: null,
      department_id: null,
      assigned_doctor_id: null,
      insurance_provider_id: null,
    });
    expect(missingEmail.success).toBe(false);
  });

  it("never asks the sender for a phone number, and always asks a third party", () => {
    expect(askableIntakeFields("self")).not.toContain("phone");
    expect(askableIntakeFields("other")).toContain("phone");
    // Optional to the patient means skippable; required-but-un-askable is not
    // "optional", it is taken from the channel.
    expect(isSkippableIntakeField("blood_type", "self")).toBe(true);
    expect(isSkippableIntakeField("phone", "self")).toBe(false);
    expect(isSkippableIntakeField("phone", "other")).toBe(false);
    expect(isSkippableIntakeField("national_id", "self")).toBe(false);
  });
});

describe("P11J-2 · questions, not field lists", () => {
  it("asks in the patient's own language and names nothing internal", () => {
    for (const locale of ["ar", "en"] as const) {
      for (const field of PATIENT_INTAKE_FIELDS) {
        const question = buildIntakeQuestion([field], locale, { subject: "other" });
        expect(question).toBeTruthy();
        expectNoInternalNames(question!, locale);
      }
    }
  });

  it("groups at most two, in asking order, however the fields arrive", () => {
    const question = buildIntakeQuestion(
      ["date_of_birth", "national_id", "full_name"],
      "ar",
    );
    expect(question).toContain("الاسم الكامل");
    expect(question).toContain("رقم الهوية");
    expect(question).not.toContain("تاريخ الميلاد");
  });

  it("says out loud that the optional fields are optional", () => {
    expect(buildIntakeQuestion(["blood_type"], "ar")).toContain("اختيارية");
    expect(buildIntakeQuestion(["blood_type"], "en")).toContain("optional");
    expect(buildIntakeQuestion(["phone"], "ar", { subject: "other" })).not.toContain(
      "اختياري",
    );
  });

  it("drops a field it must not voice rather than voicing it", () => {
    expect(buildIntakeQuestion(["phone"], "ar", { subject: "self" })).toBeNull();
  });

  it("never falls back to the raw identifier for an unlabelled field", () => {
    expect(patientFacingLabel("insurance_provider_id", "en")).toBe("the required detail");
    expect(patientFacingLabel("insurance_provider_id", "ar")).toBe("البيان المطلوب");
  });

  it("keeps one label layer: the turn briefing reads the same map", () => {
    expect(fieldLabel("national_id", "ar")).toBe(patientFacingFieldLabel("national_id", "ar"));
    expect(fieldLabel("date_of_birth", "en")).toBe(
      patientFacingFieldLabel("date_of_birth", "en"),
    );
  });
});

describe("P11J-2 · the exact P11J failure", () => {
  it("no longer stringifies the tool's missing-field list into WhatsApp copy", () => {
    // This is the reproduction. Before the fix, this ledger produced:
    //   "... البيانات التالية فقط (national_id, date_of_birth, phone)."
    const ledger = createGroundingLedger();
    ledger.record("register_patient", {
      registered: false,
      reason: "unreadable_fields",
      for_someone_else: true,
      fields: ["national_id", "date_of_birth", "phone"],
    });
    for (const locale of ["ar", "en"] as const) {
      const result = enforcePatientWriteReply({
        locale,
        text: "One moment.",
        authority: authority("intake"),
        ledger,
      });
      expect(result.outcome).toBe("failed");
      expectNoInternalNames(result.text, locale);
      // And it is a question, not an inventory.
      expect(result.text).toMatch(/[?؟]/);
    }
  });

  it("asks for the department and doctor as a question when assignment is missing", () => {
    const ledger = createGroundingLedger();
    ledger.record("register_patient", {
      registered: false,
      reason: "assignment_required",
    });
    for (const locale of ["ar", "en"] as const) {
      const result = enforcePatientWriteReply({
        locale,
        text: "Saving your file.",
        authority: authority("intake"),
        ledger,
      });
      expectNoInternalNames(result.text, locale);
      expect(result.text).toMatch(/[?؟]/);
    }
  });

  it("names a contradiction in the patient's own words", () => {
    const ledger = createGroundingLedger();
    ledger.record("register_patient", {
      registered: false,
      reason: "conflicting_details",
      fields: ["national_id"],
      patient_facing_details: "رقم الهوية",
    });
    const result = enforcePatientWriteReply({
      locale: "ar",
      text: "…",
      authority: authority("intake"),
      ledger,
    });
    expectNoInternalNames(result.text, "ar");
    expect(result.text).toContain("رقم الهوية");
  });

  it("stops asking, rather than looping, once the loop guard fires", () => {
    const ledger = createGroundingLedger();
    ledger.record("register_patient", {
      registered: false,
      reason: "intake_repeated_question",
    });
    for (const locale of ["ar", "en"] as const) {
      const result = enforcePatientWriteReply({
        locale,
        text: "…",
        authority: authority("intake"),
        ledger,
      });
      expectNoInternalNames(result.text, locale);
      expect(result.text).not.toMatch(/[?؟]/);
    }
  });
});

describe("P11J-2 · the outbound scrubber, as a last resort", () => {
  it("translates the exact leaked sentence", () => {
    const leaked =
      "لم يتم حفظ ملف المريض بعد. أحتاج تصحيح أو استكمال البيانات التالية فقط (national_id, date_of_birth, phone).";
    const scrubbed = scrubInternalFieldNames(leaked, "ar");
    expectNoInternalNames(scrubbed.text, "ar");
    expect(scrubbed.text).toContain("رقم الهوية");
    expect(scrubbed.text).toContain("تاريخ الميلاد");
    expect(scrubbed.text).toContain("رقم الموبايل");
    expect(scrubbed.leaked).toContain("national_id");
  });

  it("catches an English identifier list too", () => {
    const scrubbed = scrubInternalFieldNames(
      "I still need: national_id, date_of_birth, phone.",
      "en",
    );
    expectNoInternalNames(scrubbed.text);
    expect(scrubbed.text).toContain("National ID");
    expect(scrubbed.text).toContain("Phone number");
  });

  it("removes an identifier that has no patient-facing meaning at all", () => {
    const scrubbed = scrubInternalFieldNames(
      "Saved (intake_id, missing_fields).",
      "en",
    );
    expectNoInternalNames(scrubbed.text);
    expect(scrubbed.text).toBe("Saved.");
  });

  it("leaves ordinary English words alone", () => {
    const clean = "Could you send me a phone number and an email address?";
    expect(scrubInternalFieldNames(clean, "en").text).toBe(clean);
    expect(containsInternalFieldName(clean, "en")).toBe(false);
  });

  it("treats a bare Latin field word in Arabic copy as the leak it is", () => {
    const scrubbed = scrubInternalFieldNames("ممكن phone من فضلك؟", "ar");
    expect(scrubbed.leaked).toContain("phone");
    expect(scrubbed.text).toContain("رقم الموبايل");
  });

  it("passes clean copy through untouched", () => {
    const clean = "تمام، ورقم الهوية؟";
    const scrubbed = scrubInternalFieldNames(clean, "ar");
    expect(scrubbed.text).toBe(clean);
    expect(scrubbed.leaked).toEqual([]);
  });
});

describe("P11J-2 · date of birth stays human", () => {
  const forms = [
    ["24,3,2001", "2001-03-24"],
    ["24/3/2001", "2001-03-24"],
    ["24-3-2001", "2001-03-24"],
    ["24.3.2001", "2001-03-24"],
    ["24 مارس 2001", "2001-03-24"],
    ["٢٤/٣/٢٠٠١", "2001-03-24"],
    ["March 24 2001", "2001-03-24"],
    ["2001-03-24", "2001-03-24"],
  ] as const;

  for (const [written, iso] of forms) {
    it(`reads ${written} as ${iso}`, () => {
      const resolution = resolveField({
        field: "date_of_birth",
        raw: written,
        collected: {},
        pending: null,
        country: "EG",
        timeZone: "Africa/Cairo",
        now: new Date("2026-08-28T09:00:00Z"),
      });
      expect(resolution.status).toBe("resolved");
      expect(resolution.status === "resolved" && resolution.value).toBe(iso);
    });
  }

  for (const yes of ["اه", "ايوه", "صح", "yes"]) {
    it(`commits the proposed date on "${yes}" instead of asking again`, () => {
      const resolution = resolveField({
        field: "date_of_birth",
        raw: yes,
        collected: { date_of_birth: "2001-03-24" },
        pending: null,
        country: "EG",
        timeZone: "Africa/Cairo",
        now: new Date("2026-08-28T09:00:00Z"),
      });
      expect(resolution.status).toBe("resolved");
      expect(resolution.status === "resolved" && resolution.value).toBe("2001-03-24");
    });
  }
});

describe("P11J-2 · the repeated-question latch", () => {
  it("survives a round trip through the stage column", () => {
    const state = parseBookingStageState({
      intakeAsk: { signature: "date_of_birth,national_id", repeats: 2 },
    });
    expect(state.intakeAsk).toEqual({
      signature: "date_of_birth,national_id",
      repeats: 2,
    });
    const round = parseBookingStageState(serializeBookingStageState(state));
    expect(round.intakeAsk).toEqual(state.intakeAsk);
  });

  it("refuses a signature carrying anything but field keys", () => {
    expect(
      parseBookingStageState({ intakeAsk: { signature: "Ahmed Ali", repeats: 1 } })
        .intakeAsk,
    ).toBeNull();
    expect(parseBookingStageState({ intakeAsk: { signature: "", repeats: 1 } }).intakeAsk)
      .toBeNull();
  });

  it("defaults to no outstanding question", () => {
    expect(parseBookingStageState({}).intakeAsk).toBeNull();
  });
});
