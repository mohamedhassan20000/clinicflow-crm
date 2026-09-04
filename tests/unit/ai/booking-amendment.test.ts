import { describe, expect, it } from "vitest";
import { parseBookingAmendment } from "@/lib/ai/booking-amendment";

/**
 * The review is the last step of a booking. Answering it by moving the time is
 * an edit to the draft, and this is the pure half that says what was asked for.
 * Nothing here checks availability; the caller must.
 */
const CAIRO = "Africa/Cairo";
// A Tuesday.
const NOW = new Date("2026-09-08T09:00:00Z");

function parse(text: string, currentDate = "2026-09-09") {
  return parseBookingAmendment({
    text,
    currentDate,
    now: NOW,
    timeZone: CAIRO,
    resolveDate: (value) => {
      const match = /(\d{1,2})\s*(?:سبتمبر|september|sep)/i.exec(value);
      return match ? `2026-09-${String(Number(match[1])).padStart(2, "0")}` : null;
    },
  });
}

describe("time-only amendments", () => {
  it("reads the new time and ignores the one being replaced", () => {
    const result = parse("خليه الساعة 4 بدل 3:15");
    expect(result.kind).toBe("time");
    expect(result.kind === "time" && result.times).toContain("16:00");
    expect(result.kind === "time" && result.times).not.toContain("03:15");
  });

  it("reads a polite question as an amendment", () => {
    const result = parse("ممكن الساعة 5؟");
    expect(result.kind).toBe("time");
    expect(result.kind === "time" && result.times).toContain("17:00");
  });

  it("reads a replacement written with the verb, not the preposition", () => {
    const result = parse("بدلها 4:30");
    expect(result).toEqual({ kind: "time", times: ["04:30", "16:30"] });
  });

  it("reads a time named after the date is approved", () => {
    const result = parse("التاريخ تمام بس الوقت 6");
    expect(result.kind).toBe("time");
    expect(result.kind === "time" && result.times).toContain("18:00");
  });
});

describe("date-only amendments", () => {
  it("reads a bare weekday as the next one, never today", () => {
    const result = parse("غير اليوم للخميس");
    expect(result).toEqual({ kind: "date", date: "2026-09-10" });
  });

  it("never returns the day the booking already holds", () => {
    // The draft is on Thursday the 10th; "الخميس" means the following one.
    const result = parse("خليها الخميس", "2026-09-10");
    expect(result).toEqual({ kind: "date", date: "2026-09-17" });
  });

  it("reads an explicit calendar day through the caller's resolver", () => {
    expect(parse("خليه يوم 10 سبتمبر")).toEqual({ kind: "date", date: "2026-09-10" });
  });
});

describe("date and time together", () => {
  it("reads both from one sentence", () => {
    const result = parse("خليها الخميس الساعة 5");
    expect(result.kind).toBe("date_time");
    expect(result.kind === "date_time" && result.date).toBe("2026-09-10");
    expect(result.kind === "date_time" && result.times).toContain("17:00");
  });
});

describe("relative moves and non-amendments", () => {
  it("reads 'the one after it' as a relative move", () => {
    expect(parse("عايز الموعد اللي بعده")).toEqual({ kind: "next_slot" });
  });

  it("is silent on a message that asks for no change", () => {
    expect(parse("أيوه").kind).toBe("none");
    expect(parse("تمام").kind).toBe("none");
    expect(parse("شكرا جدا ليك").kind).toBe("none");
  });

  it("refuses a paragraph", () => {
    expect(parse("a ".repeat(40) + "الساعة 5").kind).toBe("none");
  });
});
