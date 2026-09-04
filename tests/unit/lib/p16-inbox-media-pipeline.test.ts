import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  isMediaPlaceholderBody,
  mediaPlaceholderKind,
  outboundMediaPlaceholderBody,
} from "@/lib/messaging/media-placeholder";
import { conversationScript, resolveReplyLocale, scriptEvidence } from "@/lib/ai/communication-style";
import { patientTechnicalFallbackCopy } from "@/lib/messaging/patient-copy";
import { maxInspectableAttachmentBytes } from "@/lib/ai/patient-reply";

/**
 * P16 — the four manual-QA regressions, at the layer each one actually lives in.
 *
 * The Inbox rendering half is pinned in
 * `tests/unit/components/p16-inbox-media-render.test.tsx`; this file covers the
 * pure decisions the render depends on — what a caption-less send stores, what a
 * marker means, which language a media turn is answered in, and how much of a
 * patient's file the assistant is allowed to put in front of the model.
 */

describe("P16 — a caption-less outbound file is a message, not a blank row", () => {
  it("stores the same marker vocabulary the worker writes for inbound media", () => {
    expect(outboundMediaPlaceholderBody({ kind: "image", voiceNote: false })).toBe("[image]");
    expect(outboundMediaPlaceholderBody({ kind: "document", voiceNote: false })).toBe("[document]");
    expect(outboundMediaPlaceholderBody({ kind: "audio", voiceNote: true })).toBe("[voice message]");
    expect(outboundMediaPlaceholderBody({ kind: "audio", voiceNote: false })).toBe("[audio]");
  });

  it("keeps every marker it writes inside the set the thread already suppresses", () => {
    for (const media of [
      { kind: "image" as const, voiceNote: false },
      { kind: "document" as const, voiceNote: false },
      { kind: "audio" as const, voiceNote: true },
      { kind: "audio" as const, voiceNote: false },
    ]) {
      expect(isMediaPlaceholderBody(outboundMediaPlaceholderBody(media))).toBe(true);
      expect(mediaPlaceholderKind(outboundMediaPlaceholderBody(media))).not.toBeNull();
    }
  });

  it("names the kind a marker stands for, and refuses to name one for prose", () => {
    expect(mediaPlaceholderKind("[image]")).toBe("image");
    expect(mediaPlaceholderKind("[document]")).toBe("document");
    expect(mediaPlaceholderKind("[voice message]")).toBe("voiceMessage");
    expect(mediaPlaceholderKind("ده تحليل الدم بتاعي")).toBeNull();
    expect(mediaPlaceholderKind("")).toBeNull();
    expect(mediaPlaceholderKind(null)).toBeNull();
  });
});

describe("P16 — a media marker is not evidence about language", () => {
  it("reads no script at all from the worker's markers", () => {
    for (const marker of ["[image]", "[document]", "[voice message]", "[video]"]) {
      expect(scriptEvidence(marker)).toEqual({ script: null, strength: "none" });
    }
  });

  it("answers an Arabic conversation in Arabic when the newest turn is a photo", () => {
    // Exactly the production turn: twenty Arabic messages, then one uncaptioned
    // image whose stored body is `[image]`. Read as prose that is five Latin
    // letters, and the reply — including the technical apology — came out in
    // English.
    const locale = resolveReplyLocale({
      style: { language: "auto", arabicStyle: "auto", tone: "friendly", styleInstruction: null },
      clinicLocale: "en",
      patientText: "[image]",
      conversationScript: conversationScript(["[image]", "عربي كلمني", "أهلاً"]),
    });
    expect(locale).toBe("ar");
    expect(patientTechnicalFallbackCopy(locale)).toBe(
      "حصلت مشكلة تقنية مؤقتة. حد من فريق العيادة هيتواصل معاك في أقرب وقت.",
    );
  });

  it("keeps an English conversation in English when the newest turn is a photo", () => {
    const locale = resolveReplyLocale({
      style: { language: "auto", arabicStyle: "auto", tone: "friendly", styleInstruction: null },
      clinicLocale: "ar",
      patientText: "[image]",
      conversationScript: conversationScript(["[image]", "can I book tomorrow please"]),
    });
    expect(locale).toBe("en");
    expect(patientTechnicalFallbackCopy(locale)).toBe(
      "We hit a temporary technical issue. Someone from the clinic team will get back to you as soon as possible.",
    );
  });

  it("still switches language on the patient's own words", () => {
    expect(scriptEvidence("عايز أحجز معاد")).toEqual({ script: "ar", strength: "strong" });
    expect(scriptEvidence("can I book tomorrow")).toEqual({ script: "en", strength: "strong" });
  });
});

describe("P16 — a patient's photo must fit the certified input budget", () => {
  it("refuses a file whose base64 form would blow the per-step byte guard", () => {
    // `patient_booking` funds 16,000 bytes per step and the guard measures the
    // serialized request in bytes, so the 295 KB photograph from manual QA had
    // no chance: it threw before the provider was reached and was latched as a
    // technical failure, every time, for every real photo.
    const budget = maxInspectableAttachmentBytes(16_000);
    expect(budget).toBeGreaterThan(0);
    expect(budget).toBeLessThan(16_000);
    expect(Math.ceil((budget * 4) / 3)).toBeLessThanOrEqual(16_000);
    expect(295_703).toBeGreaterThan(budget);
  });

  it("never exceeds the standing 4 MB inspection ceiling on a roomy policy", () => {
    expect(maxInspectableAttachmentBytes(192_000)).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(maxInspectableAttachmentBytes(100_000_000)).toBe(4 * 1024 * 1024);
  });

  it("clamps to zero rather than going negative on a tiny budget", () => {
    expect(maxInspectableAttachmentBytes(0)).toBe(0);
  });
});
