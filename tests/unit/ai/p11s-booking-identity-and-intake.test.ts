/**
 * P11S — who the booking is for, and confirming which file it lands on.
 *
 * Both questions are about which record a pending appointment is written
 * against, which is why the server owns their wording rather than leaving them
 * to the prompt: a model that guesses "for me" from "عايز أحجز" writes a
 * patient's mother's appointment onto the patient's own file.
 *
 * The privacy property asserted here is the load-bearing one. The assistant is
 * never given a national ID — `resolve_patient_ai_context` computes the last
 * four digits in SQL — so there is no path by which a full one can reach a
 * WhatsApp thread, however the model is prompted or provoked.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { buildTurnBriefing } from "@/lib/ai/turn-briefing";
import { resolveField } from "@/lib/ai/collected-state";
import { buildPatientSystemPrompt } from "@/lib/ai/prompts/patient";

const base = {
  locale: "ar" as const,
  stage: "idle" as const,
  collected: {},
  pending: null,
  missingRequired: [],
  missingOptional: [],
  intakeStaged: false,
  closure: { isClosing: false } as never,
};

describe("P11S — asking who the appointment is for", () => {
  it("puts the question in the briefing when the booking target is unsettled", () => {
    const briefing = buildTurnBriefing({ ...base, askBookingTarget: true });
    expect(briefing).toContain("الحجز ليك ولا لشخص تاني؟");
    expect(briefing).toContain("مرة واحدة فقط");
  });

  it("says nothing when it is already settled", () => {
    const briefing = buildTurnBriefing({ ...base, askBookingTarget: false });
    expect(briefing ?? "").not.toContain("الحجز لحضرتك ولا لشخص آخر؟");
  });

  it("is in the prompt in both languages, with the 'already answered' exemption", () => {
    expect(buildPatientSystemPrompt("ar")).toContain("الحجز لحضرتك ولا لشخص آخر؟");
    expect(buildPatientSystemPrompt("ar")).toContain("«لوالدتي»");
    expect(buildPatientSystemPrompt("en")).toContain(
      "Is the appointment for you, or for someone else?",
    );
  });
});

describe("P11S — confirming a linked patient's identity", () => {
  it("gives the name and only the last four digits of the ID", () => {
    const briefing = buildTurnBriefing({
      ...base,
      identityConfirmation: { name: "أحمد نبيل", nationalIdSuffix: "1234" },
    });
    expect(briefing).toContain("أحمد نبيل");
    expect(briefing).toContain("1234");
    expect(briefing).toContain("ولا تذكر رقم الهوية كاملًا أبدًا");
  });

  it("confirms on the name alone when the record has no usable suffix", () => {
    const briefing = buildTurnBriefing({
      ...base,
      identityConfirmation: { name: "أحمد نبيل", nationalIdSuffix: null },
    });
    expect(briefing).toContain("أحمد نبيل");
    expect(briefing).not.toContain("رقم هوية منتهٍ");
  });

  it("forbids a full national ID in the prompt, in both languages", () => {
    expect(buildPatientSystemPrompt("ar")).toContain(
      "لا تكتب رقم هوية أو رقمًا قوميًا كاملًا في أي رسالة أبدًا",
    );
    expect(buildPatientSystemPrompt("en")).toContain(
      "Never write a full national or civil ID in a message",
    );
  });
});

describe("P11S — blood type stays optional and is never invented", () => {
  it.each([
    ["O+", "O+"],
    ["o positive", "O+"],
    ["بي سالب", "B-"],
    ["AB+", "AB+"],
  ])("reads %s as %s", (written, expected) => {
    const outcome = resolveField({ field: "blood_type", raw: written, collected: {}, pending: null });
    expect(outcome).toMatchObject({ status: "resolved", value: expected });
  });

  it.each(["لا أعرف", "مش عارف", "I don't know", "معرفش"])(
    "never guesses a value from %s",
    (written) => {
      const outcome = resolveField({ field: "blood_type", raw: written, collected: {}, pending: null });
      expect(outcome.status).not.toBe("resolved");
    },
  );

  it("is listed as optional to the model, asked once, and never insisted on", () => {
    const briefing = buildTurnBriefing({
      ...base,
      missingRequired: ["email"],
      missingOptional: ["blood_type"],
    });
    expect(briefing).toContain("اختياري");
    expect(briefing).toContain("فصيلة الدم");
    expect(briefing).toContain("أكمل بدونه ولا تعد السؤال");
  });
});
