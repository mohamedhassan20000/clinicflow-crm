import { describe, expect, it } from "vitest";

/**
 * P11F §2 — friendly is a register, not a licence.
 *
 * Production, Arabic, tone `friendly`, mid-intake: **"تمام يا عم!"** — said by a
 * clinic to a parent registering their child. Nothing produced it deliberately.
 * The style block asked for "ودّي ودافئ" and the model supplied the most
 * colloquial reading of "warm" it had, because nothing anywhere said where warm
 * stops.
 *
 * Two halves are tested here, and both are required: the prompt now says it,
 * and — because a prompt rule is a request — `reply-register.ts` checks the
 * finished sentence, whoever composed it.
 *
 * The second half of every group matters as much as the first: an assistant
 * that stopped saying "تمام" would be a worse assistant, not a more
 * professional one.
 */

import {
  buildCommunicationStylePrompt,
  DEFAULT_COMMUNICATION_STYLE,
  type AiTone,
} from "@/lib/ai/communication-style";
import {
  clinicPermitsInformalAddress,
  detectUnprofessionalAddress,
  enforceReplyRegister,
} from "@/lib/ai/reply-register";

const NO_INSTRUCTION = { styleInstruction: null };
const clean = (text: string) => enforceReplyRegister({ text, style: NO_INSTRUCTION });

// ---------------------------------------------------------------------------
// §2a — what is prohibited
// ---------------------------------------------------------------------------

describe("P11F §2a · slang forms of address are removed", () => {
  const prohibited: Array<[string, string]> = [
    ["the exact production sentence", "تمام يا عم!"],
    ["يا معلم", "حاضر يا معلم، نكمل؟"],
    ["يا باشا", "تمام يا باشا"],
    ["يا بيه", "أهلاً يا بيه"],
    ["حبيبي", "تمام حبيبي، هحجزلك"],
    ["يا حبيبي", "أكيد يا حبيبي"],
    ["يا زعيم", "تحت أمرك يا زعيم"],
    ["يا كبير", "تمام يا كبير"],
    ["يا خوي", "أبشر يا خوي"],
    ["يالغالي", "تم يالغالي"],
    ["bro", "Sure bro, which day?"],
    ["mate", "No worries mate"],
    ["dude", "Alright dude"],
  ];

  for (const [label, text] of prohibited) {
    it(`removes ${label}`, () => {
      const result = clean(text);
      expect(result.labels.length).toBeGreaterThan(0);
      expect(result.changed).toBe(true);
      expect(detectUnprofessionalAddress(result.text)).toEqual([]);
    });
  }

  it("removes the form without destroying the sentence", () => {
    expect(clean("تمام يا عم!\n\nالآن احتاج تاريخ ميلاده.").text).toBe(
      "تمام!\n\nالآن احتاج تاريخ ميلاده.",
    );
  });

  it("leaves a sentence that is only a vocative alone rather than sending nothing", () => {
    expect(clean("يا عم").text).toBe("يا عم");
  });
});

// ---------------------------------------------------------------------------
// §2b — what stays. Not robotic.
// ---------------------------------------------------------------------------

describe("P11F §2b · friendly Egyptian and Gulf warmth is untouched", () => {
  const acceptable = [
    "تمام، هحجزلك.",
    "حاضر، ثانية واحدة.",
    "أكيد! تحت أمرك.",
    "خلينا نكمل، تحب أنهي يوم؟",
    "تحب نختار معاد تاني؟",
    "أبشر، المواعيد المتاحة كالتالي:",
    "على الرحب والسعة.",
    "Of course — which day suits you?",
    "Certainly, happy to help.",
    "No problem at all, shall we continue?",
  ];
  for (const text of acceptable) {
    it(`leaves ${JSON.stringify(text)} exactly as written`, () => {
      const result = clean(text);
      expect(result.changed).toBe(false);
      expect(result.text).toBe(text);
      expect(result.labels).toEqual([]);
    });
  }

  it("does not fire on ordinary words that merely contain a prohibited substring", () => {
    // "عمر" is a name and "عمّان" is a city; neither is "يا عم".
    expect(detectUnprofessionalAddress("تمام يا عمر، هحجزلك")).toEqual([]);
    expect(detectUnprofessionalAddress("العيادة في عمّان")).toEqual([]);
    // "brother" is a noun, not the vocative "bro".
    expect(detectUnprofessionalAddress("Is this for your brother?")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// §2c — the one override
// ---------------------------------------------------------------------------

describe("P11F §2c · a clinic may explicitly configure otherwise", () => {
  it("honours a clinic that typed the form into its own style instruction", () => {
    const style = { styleInstruction: "خاطب المرضى بود شديد وقول لهم حبيبي" };
    const result = enforceReplyRegister({ text: "تمام حبيبي", style });
    expect(result.changed).toBe(false);
    expect(result.text).toBe("تمام حبيبي");
    expect(clinicPermitsInformalAddress(style, ["habibi"])).toBe(true);
  });

  it("an unrelated style instruction is not consent", () => {
    const style = { styleInstruction: "كن مختصرًا ومباشرًا" };
    expect(enforceReplyRegister({ text: "تمام يا عم", style }).labels).toEqual(["ya_amm"]);
    expect(clinicPermitsInformalAddress(style, ["ya_amm"])).toBe(false);
  });

  it("permission for one form is not permission for another", () => {
    const style = { styleInstruction: "قول حبيبي" };
    const result = enforceReplyRegister({ text: "تمام يا باشا وحبيبي", style });
    expect(result.changed).toBe(true);
  });

  it("no instruction at all is never consent", () => {
    expect(clinicPermitsInformalAddress(NO_INSTRUCTION, ["ya_amm"])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §2d — the prompt, in every mode
// ---------------------------------------------------------------------------

describe("P11F §2d · every tone is told where warm stops", () => {
  const tones: AiTone[] = ["friendly", "neutral", "formal"];
  for (const tone of tones) {
    it(`the Arabic ${tone} prompt prohibits slang address`, () => {
      const prompt = buildCommunicationStylePrompt(
        { ...DEFAULT_COMMUNICATION_STYLE, tone },
        "ar",
      );
      expect(prompt).toContain("يا عم");
      expect(prompt).toContain("يا معلم");
      expect(prompt).toContain("يا باشا");
      expect(prompt).toContain("حبيبي");
      // …and names the warmth that is wanted, so it does not read as "be cold".
      expect(prompt).toContain("تمام");
      expect(prompt).toContain("حاضر");
      expect(prompt).toContain("تحت أمرك");
      expect(prompt).toContain("لا تكن آليًا");
    });

    it(`the English ${tone} prompt prohibits slang address`, () => {
      const prompt = buildCommunicationStylePrompt(
        { ...DEFAULT_COMMUNICATION_STYLE, tone },
        "en",
      );
      expect(prompt).toContain('"bro"');
      expect(prompt).toContain('"mate"');
      expect(prompt).toContain("never robotic");
    });
  }

  for (const arabicStyle of ["egyptian", "gulf", "saudi", "msa", "levantine"] as const) {
    it(`the ${arabicStyle} register keeps the professional constraint`, () => {
      const prompt = buildCommunicationStylePrompt(
        { ...DEFAULT_COMMUNICATION_STYLE, arabicStyle, tone: "friendly" },
        "ar",
      );
      expect(prompt).toContain("يا عم");
      expect(prompt).toContain("تمام");
    });
  }
});
