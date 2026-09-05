import { describe, expect, it } from "vitest";

/**
 * P11F §1 — an Arabic conversation stays Arabic.
 *
 * Two independent defects, reproduced from one production thread:
 *
 *   1. **The whole reply flipped.** Eight Arabic turns, then an intake answer —
 *      a date of birth, an email and a blood type — and `auto` mode read the
 *      Latin characters as "this patient writes English". The next reply was
 *      "The departments we have are…". The patient answered "عربي؟".
 *
 *   2. **The labels stayed English.** Once it was Arabic again, three stored
 *      department names were still interpolated verbatim into Arabic sentences.
 *
 * The department names below are test data. Production knows none of them: the
 * mapping is the clinic-agnostic specialty lexicon `entity-resolution.ts`
 * already uses to *understand* what a patient typed, read backwards.
 */

import {
  conversationScript,
  resolveReplyLocale,
  scriptEvidence,
  DEFAULT_COMMUNICATION_STYLE,
  buildCommunicationStylePrompt,
} from "@/lib/ai/communication-style";
import {
  arabicConceptLabels,
  formatPersonName,
  localizeEntityLabel,
} from "@/lib/ai/entity-labels";
import { conceptKeys } from "@/lib/ai/entity-resolution";
import { buildDeterministicRosterReply } from "@/lib/ai/patient-grounding";

const AUTO = DEFAULT_COMMUNICATION_STYLE;
const AR = { ...DEFAULT_COMMUNICATION_STYLE, language: "ar" as const };
const EN = { ...DEFAULT_COMMUNICATION_STYLE, language: "en" as const };

// ---------------------------------------------------------------------------
// §1a — what counts as evidence about language
// ---------------------------------------------------------------------------

describe("P11F §1a · an intake answer is not a language", () => {
  const weak: Array<[string, string]> = [
    ["the exact production message", "2,12,2015\nOmar@clinic.com\nAb+"],
    ["an email alone", "omar@clinic.com"],
    ["a blood type", "Ab+"],
    ["a national id", "303090876514"],
    ["a date", "2,12,2015"],
    ["an order code", "REF7741"],
  ];
  for (const [label, text] of weak) {
    it(`treats ${label} as weak evidence`, () => {
      expect(scriptEvidence(text).strength).not.toBe("strong");
    });
  }

  it("treats real English words as strong evidence", () => {
    expect(scriptEvidence("yes please, tomorrow morning")).toEqual({
      script: "en",
      strength: "strong",
    });
  });

  it("treats real Arabic words as strong evidence", () => {
    expect(scriptEvidence("عايز احجز لابني")).toEqual({ script: "ar", strength: "strong" });
  });

  it("reads no evidence at all from digits or an emoji", () => {
    expect(scriptEvidence("٢٤").strength).toBe("none");
    expect(scriptEvidence("👍").strength).toBe("none");
  });
});

// ---------------------------------------------------------------------------
// §1b — the resolved locale
// ---------------------------------------------------------------------------

describe("P11F §1b · the language of the turn", () => {
  it("does NOT flip an Arabic thread on an intake answer — the production bug", () => {
    expect(
      resolveReplyLocale({
        style: AUTO,
        clinicLocale: "en",
        patientText: "2,12,2015\nOmar@clinic.com\nAb+",
        conversationScript: conversationScript([
          "2,12,2015\nOmar@clinic.com\nAb+",
          "عمر الفارق حسن",
          "عايز احجز لابني علاج طبيعي",
        ]),
      }),
    ).toBe("ar");
  });

  it("follows the patient when they genuinely switch to English", () => {
    expect(
      resolveReplyLocale({
        style: AUTO,
        clinicLocale: "ar",
        patientText: "sorry, can we continue in English please",
        conversationScript: "ar",
      }),
    ).toBe("en");
  });

  it("follows the patient when they genuinely switch to Arabic", () => {
    expect(
      resolveReplyLocale({
        style: AUTO,
        clinicLocale: "en",
        patientText: "ممكن نكمل بالعربي",
        conversationScript: "en",
      }),
    ).toBe("ar");
  });

  it("falls back to the clinic locale on the opening turn only", () => {
    expect(
      resolveReplyLocale({ style: AUTO, clinicLocale: "ar", patientText: "👍" }),
    ).toBe("ar");
  });

  it("a configured Arabic clinic never answers in English", () => {
    expect(
      resolveReplyLocale({
        style: AR,
        clinicLocale: "en",
        patientText: "hello, are you open today?",
        conversationScript: "en",
      }),
    ).toBe("ar");
  });

  it("a configured English clinic never answers in Arabic", () => {
    expect(
      resolveReplyLocale({
        style: EN,
        clinicLocale: "ar",
        patientText: "عايز احجز",
        conversationScript: "ar",
      }),
    ).toBe("en");
  });

  it("conversationScript ignores a run of intake answers", () => {
    expect(
      conversationScript(["Ab+", "omar@clinic.com", "2,12,2015", "عايز احجز لابني"]),
    ).toBe("ar");
  });
});

// ---------------------------------------------------------------------------
// §1c — stored labels do not choose the language
// ---------------------------------------------------------------------------

describe("P11F §1c · a stored label is data, not a language", () => {
  it("presents a specialty the lexicon knows in Arabic", () => {
    expect(localizeEntityLabel("Physical Therapy", "ar")).toBe("العلاج الطبيعي");
    expect(localizeEntityLabel("Dermatology", "ar")).toBe("الجلدية");
    expect(localizeEntityLabel("Cardiology", "ar")).toBe("القلب");
  });

  it("leaves a stored Arabic label exactly alone", () => {
    expect(localizeEntityLabel("الأسنان", "ar")).toBe("الأسنان");
    expect(localizeEntityLabel("قسم Gamma", "ar")).toBe("قسم Gamma");
  });

  it("leaves a brand or invented name untranslated — the honest default", () => {
    expect(localizeEntityLabel("Gamma Unit", "ar")).toBe("Gamma Unit");
    expect(localizeEntityLabel("Qorvex Clinic Suite", "ar")).toBe("Qorvex Clinic Suite");
  });

  it("never rewrites a label in an English reply", () => {
    expect(localizeEntityLabel("Physical Therapy", "en")).toBe("Physical Therapy");
    expect(localizeEntityLabel("الأسنان", "en")).toBe("الأسنان");
  });

  it("trims the stored spelling, which is what produced 'Physical Therapy :'", () => {
    expect(localizeEntityLabel("  Physical  Therapy  ", "en")).toBe("Physical Therapy");
  });

  it("localizes a doctor's title and never their name", () => {
    expect(formatPersonName("Dr. Nadia Fouad", "ar")).toBe("د. Nadia Fouad");
    expect(formatPersonName("د. Nadia Fouad", "en")).toBe("Dr. Nadia Fouad");
    expect(formatPersonName("Nadia Fouad", "ar")).toBe("Nadia Fouad");
  });

  it("every concept the resolver knows has an Arabic display name", () => {
    const labelled = new Set(Object.keys(arabicConceptLabels()));
    // Every concept reachable from the lexicon's own canonical spellings.
    for (const concept of labelled) {
      expect([...conceptKeys(concept)]).toContain(concept);
    }
    expect(labelled.size).toBeGreaterThan(15);
  });
});

// ---------------------------------------------------------------------------
// §1d — the deterministic replies obey the same rule as the model's
// ---------------------------------------------------------------------------

describe("P11F §1d · deterministic replies respect the configured style", () => {
  const DEPARTMENTS = ["Dermatology", "Cardiology", "Physical Therapy "];

  it("the exact production sentence is now Arabic end to end", () => {
    const text = buildDeterministicRosterReply({
      locale: "ar",
      departmentName: null,
      doctors: [],
      departments: DEPARTMENTS,
    });
    expect(text).toContain("الجلدية");
    expect(text).toContain("القلب");
    expect(text).toContain("العلاج الطبيعي");
    expect(text).not.toMatch(/[A-Za-z]/);
  });

  it("the roster sentence names the department in Arabic", () => {
    const text = buildDeterministicRosterReply({
      locale: "ar",
      departmentName: "Physical Therapy ",
      doctors: ["Dr. Nadia Fouad"],
      departments: DEPARTMENTS,
    });
    expect(text).toContain("العلاج الطبيعي");
    expect(text).not.toContain("Physical Therapy");
    // The person's name is the one thing that stays as stored.
    expect(text).toContain("Nadia Fouad");
    expect(text).toContain("د.");
  });

  it("an English conversation stays English", () => {
    const text = buildDeterministicRosterReply({
      locale: "en",
      departmentName: "Physical Therapy",
      doctors: ["Dr. Nadia Fouad"],
      departments: DEPARTMENTS,
    });
    expect(text).toContain("Physical Therapy");
    expect(text).not.toMatch(/[ؠ-ي]/);
  });
});

// ---------------------------------------------------------------------------
// §1e — the prompt says it too
// ---------------------------------------------------------------------------

describe("P11F §1e · the model is told the same rule", () => {
  it("the Arabic style block carries the label rule", () => {
    const prompt = buildCommunicationStylePrompt(AUTO, "ar");
    expect(prompt).toContain("لا تجعل لغة البيانات تغيّر لغة ردّك");
  });

  it("the English style block carries the label rule", () => {
    const prompt = buildCommunicationStylePrompt(AUTO, "en");
    expect(prompt).toContain("Never let a stored label change");
  });
});
