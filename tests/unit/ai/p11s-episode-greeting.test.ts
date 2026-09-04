/**
 * P11S — the mandatory opening of a conversation episode.
 *
 * Every assertion here is about a property that used to be probabilistic: the
 * prompt asked the model to introduce itself, so it did — most of the time. A
 * clinic's first sentence to a patient is not a thing to get right most of the
 * time, so it is composed from the clinic's own record instead.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  applyEpisodeOpening,
  buildEpisodeOpening,
  detectIslamicGreeting,
  isBareGreeting,
} from "@/lib/ai/episode-greeting";

const CLINIC = "عيادة النيل";

describe("P11S — Islamic greeting", () => {
  it.each([
    "السلام عليكم",
    "السلام عليكم ورحمة الله",
    "سلام عليكم يا دكتور",
    "assalamu alaikum",
    "Salam alaykum, I want to book",
  ])("recognises %s", (message) => {
    expect(detectIslamicGreeting(message)).toBe(true);
  });

  it.each(["أهلا", "hello", "صباح الخير", "عايز أحجز"])(
    "does not read %s as one",
    (message) => {
      expect(detectIslamicGreeting(message)).toBe(false);
    },
  );

  it("answers it with the full response, first, before anything else", () => {
    const opening = buildEpisodeOpening({
      locale: "ar",
      clinicName: CLINIC,
      latestPatientText: "السلام عليكم",
    });
    expect(opening.text.startsWith("وعليكم السلام ورحمة الله وبركاته")).toBe(true);
  });
});

describe("P11S — a bare greeting versus a greeting carrying a request", () => {
  it.each(["السلام عليكم", "أهلا", "hi", "hello there", "صباح الخير", "hey"])(
    "%s is a bare greeting",
    (message) => {
      expect(isBareGreeting(message)).toBe(true);
    },
  );

  it.each([
    "السلام عليكم، عايز أعرف عنوانكم",
    "hi, what are your prices?",
    "أهلا عايز أحجز",
    "عندكم قسم جلدية؟",
  ])("%s is not", (message) => {
    expect(isBareGreeting(message)).toBe(false);
  });
});

describe("P11S — the opening itself", () => {
  it("welcomes by the clinic's real name, introduces the assistant, and offers both paths", () => {
    const opening = buildEpisodeOpening({
      locale: "ar",
      clinicName: CLINIC,
      latestPatientText: "السلام عليكم",
    });
    expect(opening.standalone).toBe(true);
    expect(opening.text).toContain(CLINIC);
    expect(opening.text).toContain("المساعد الآلي للعيادة");
    expect(opening.text).toContain("تحب تحجز موعد، ولا عندك استفسار آخر؟");
  });

  it("never invents a clinic name when the record has none", () => {
    const opening = buildEpisodeOpening({
      locale: "ar",
      clinicName: null,
      latestPatientText: "أهلا",
    });
    expect(opening.text).toContain("أهلًا وسهلًا بك");
    expect(opening.text).not.toMatch(/عيادة\s+\S/);
  });

  it("does the same in English", () => {
    const opening = buildEpisodeOpening({
      locale: "en",
      clinicName: "Nile Care Clinic",
      latestPatientText: "hi",
    });
    expect(opening.text).toContain("Welcome to Nile Care Clinic");
    expect(opening.text).toContain("automated assistant");
    expect(opening.text).toContain("book an appointment");
  });
});

describe("P11S — a first message that already says what the patient wants", () => {
  it("greets, introduces, then answers in the same message — no extra turn", () => {
    const reply = applyEpisodeOpening({
      locale: "ar",
      clinicName: CLINIC,
      latestPatientText: "السلام عليكم، عايز أعرف عنوانكم",
      replyText: "عنوان العيادة: ١٢ كورنيش النيل، القاهرة. ورقم الهاتف: ٠٢١٢٣٤٥٦٧٨",
    });
    expect(reply).toContain("وعليكم السلام ورحمة الله وبركاته");
    expect(reply).toContain(CLINIC);
    expect(reply).toContain("١٢ كورنيش النيل");
    // The redundant "what would you like?" is exactly what must not appear when
    // the patient has already said what they would like.
    expect(reply).not.toContain("تحب تحجز موعد، ولا عندك استفسار آخر؟");
  });

  it("replaces a bare-greeting turn entirely, so the patient is not greeted twice", () => {
    const reply = applyEpisodeOpening({
      locale: "ar",
      clinicName: CLINIC,
      latestPatientText: "السلام عليكم",
      replyText: "أهلًا بيك في العيادة، أقدر أساعدك في إيه؟",
    });
    expect(reply).not.toContain("أقدر أساعدك في إيه؟");
    expect(reply).toContain("تحب تحجز موعد، ولا عندك استفسار آخر؟");
    expect(reply.match(/أهلًا وسهلًا/g)).toHaveLength(1);
  });

  it("stands alone when the turn produced no reply at all", () => {
    const reply = applyEpisodeOpening({
      locale: "en",
      clinicName: "Nile Care Clinic",
      latestPatientText: "I need the address",
      replyText: "   ",
    });
    expect(reply).toContain("Welcome to Nile Care Clinic");
  });
});
