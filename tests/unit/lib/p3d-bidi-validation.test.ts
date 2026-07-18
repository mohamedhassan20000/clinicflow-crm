import { describe, expect, it } from "vitest";
import {
  hasUnsafeBidiControls,
  inboxReplySchema,
  messageTemplateSchema,
} from "@/lib/validations/messaging";

// Unicode bidi control characters, by name.
const LRE = "‪";
const RLE = "‫";
const PDF = "‬";
const LRO = "‭";
const RLO = "‮";
const LRI = "⁦";
const RLI = "⁧";
const FSI = "⁨";
const PDI = "⁩";
const LRM = "‎";
const RLM = "‏";
const ALM = "؜";

describe("hasUnsafeBidiControls (P3-L1)", () => {
  it("flags every embedding, override, isolate, and mark control", () => {
    for (const control of [LRE, RLE, PDF, LRO, RLO, LRI, RLI, FSI, PDI, LRM, RLM, ALM]) {
      expect(hasUnsafeBidiControls(`hello${control}world`)).toBe(true);
    }
  });

  it("passes normal Arabic, English, digits, and whitespace", () => {
    for (const value of [
      "مرحباً بك في العيادة",
      "موعدك غداً الساعة ١٠:٠٠",
      "Hello, your appointment is tomorrow.",
      "Line one\nLine two\tTabbed",
      "اسم المريض: Sara — 2026",
    ]) {
      expect(hasUnsafeBidiControls(value)).toBe(false);
    }
  });
});

describe("shared schema boundary", () => {
  it("messageTemplateSchema rejects a bidi-laced body but accepts Arabic", () => {
    const bad = messageTemplateSchema.safeParse({
      channel: "email",
      name: "reminder",
      language: "ar",
      body: `مرحبا ${RLO}evil${PDF}`,
      variables: [],
    });
    expect(bad.success).toBe(false);

    const good = messageTemplateSchema.safeParse({
      channel: "email",
      name: "reminder",
      language: "ar",
      body: "مرحباً، نذكّرك بموعدك.",
      variables: [],
    });
    expect(good.success).toBe(true);
  });

  it("inboxReplySchema rejects bidi controls in the body", () => {
    const result = inboxReplySchema.safeParse({
      conversationId: "11111111-1111-4111-8111-111111111111",
      body: `hi ${LRI}spoof${PDI}`,
      templateId: null,
      templateParameters: [],
    });
    expect(result.success).toBe(false);
  });
});
