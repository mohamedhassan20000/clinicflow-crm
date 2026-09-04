/**
 * "يوم 16 الجاي" — the nearest future occurrence of a bare day number.
 *
 * Every case here is frozen against a fixed clinic day, because the whole point
 * of the rule is that it is a function of the calendar and nothing else.
 */
import { describe, expect, it } from "vitest";

import {
  nearestFutureDayOfMonth,
  readDayOfMonthReference,
  resolveUpcomingDayOfMonth,
} from "@/lib/ai/day-of-month";

const CAIRO = "Africa/Cairo";

function at(day: string): Date {
  // Midday local, so the timezone shift can never move the clinic's own day.
  return new Date(`${day}T09:00:00.000Z`);
}

function resolve(today: string, text: string): string | null {
  return resolveUpcomingDayOfMonth(text, { now: at(today), timeZone: CAIRO });
}

describe("reading a bare day of the month", () => {
  it("reads the shapes patients actually type", () => {
    expect(readDayOfMonthReference("يوم 16 الجاي")).toEqual({ day: 16, explicitNext: true, boundary: false });
    expect(readDayOfMonthReference("يوم ١٦ الجاي")).toEqual({ day: 16, explicitNext: true, boundary: false });
    expect(readDayOfMonthReference("عايز يوم 16")).toEqual({ day: 16, explicitNext: false, boundary: false });
    expect(readDayOfMonthReference("غيره ليوم 16")).toEqual({ day: 16, explicitNext: false, boundary: false });
    expect(readDayOfMonthReference("next 16th")).toEqual({ day: 16, explicitNext: true, boundary: false });
    expect(readDayOfMonthReference("the upcoming 16th")).toEqual({ day: 16, explicitNext: true, boundary: false });
    expect(readDayOfMonthReference("day 16")).toEqual({ day: 16, explicitNext: false, boundary: false });
  });

  it("withdraws from anything that is already a complete date", () => {
    expect(readDayOfMonthReference("16/9")).toBeNull();
    expect(readDayOfMonthReference("يوم 16 سبتمبر")).toBeNull();
    expect(readDayOfMonthReference("16-09-2026")).toBeNull();
  });

  it("never reads a bare number as a day", () => {
    expect(readDayOfMonthReference("16")).toBeNull();
    expect(readDayOfMonthReference("الساعة 16")).toBeNull();
    expect(readDayOfMonthReference("")).toBeNull();
  });
});

describe("the nearest future occurrence", () => {
  it("resolves within the current month when the day has not passed", () => {
    expect(resolve("2026-09-01", "يوم 16 الجاي")).toBe("2026-09-16");
    expect(resolve("2026-09-15", "يوم 16 الجاي")).toBe("2026-09-16");
  });

  it("rolls to next month once the day has passed", () => {
    expect(resolve("2026-09-20", "يوم 16 الجاي")).toBe("2026-10-16");
  });

  it("excludes today when the patient explicitly said 'the next one'", () => {
    expect(resolve("2026-09-16", "يوم 16 الجاي")).toBe("2026-10-16");
    expect(resolve("2026-09-16", "next 16th")).toBe("2026-10-16");
    // Without that wording, today is a perfectly good sixteenth.
    expect(resolve("2026-09-16", "عايز يوم 16")).toBe("2026-09-16");
  });

  it("crosses the year boundary", () => {
    expect(resolve("2026-12-20", "يوم 16 الجاي")).toBe("2027-01-16");
  });

  it("skips months that do not contain the day, and never fabricates one", () => {
    // 31 September does not exist: the next real 31st is October's.
    expect(resolve("2026-09-05", "يوم 31")).toBe("2026-10-31");
    // Asked on 31 January with "الجاي": February and April have no 31st.
    expect(resolve("2026-01-31", "يوم 31 الجاي")).toBe("2026-03-31");
    expect(resolve("2026-02-01", "يوم 31")).toBe("2026-03-31");
  });

  it("handles February and leap years", () => {
    // 2026 is not a leap year, 2028 is.
    expect(resolve("2026-02-01", "يوم 29")).toBe("2026-03-29");
    expect(resolve("2028-02-01", "يوم 29")).toBe("2028-02-29");
    expect(resolve("2026-01-30", "يوم 30")).toBe("2026-01-30");
    expect(resolve("2026-02-01", "يوم 30")).toBe("2026-03-30");
  });

  it("treats notBefore as an exclusive floor", () => {
    expect(
      nearestFutureDayOfMonth(16, {
        now: at("2026-09-01"),
        timeZone: CAIRO,
        notBefore: "2026-09-16",
      }),
    ).toBe("2026-10-16");
  });

  it("refuses a day number that is not one", () => {
    expect(nearestFutureDayOfMonth(0, { now: at("2026-09-01") })).toBeNull();
    expect(nearestFutureDayOfMonth(32, { now: at("2026-09-01") })).toBeNull();
  });
});
