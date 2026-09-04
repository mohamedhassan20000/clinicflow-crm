import { describe, expect, it } from "vitest";
import {
  dateOrderForCountry,
  normalizeDigits,
  parseDateOfBirth,
  parseHumanDate,
  parseHumanEmail,
  parseHumanName,
  parseHumanPhone,
  parseHumanTime,
  parseNationalId,
  parseRelativeDay,
} from "@/lib/ai/human-input";

/**
 * P8 §3 — the assistant must understand what people type, not dictate a format.
 *
 * The cases below are written the way patients actually write, including the
 * ones that are *not* meant to be resolved: the ambiguity assertions are the
 * point of the suite, because silently choosing between 12 September and 9
 * December on a date-of-birth check is how somebody is shown another person's
 * appointments.
 */

const NOW = new Date("2026-08-17T09:00:00Z");

describe("P8 flexible date parsing", () => {
  it.each([
    ["12/9/2000", "2000-09-12"],
    ["12/09/2000", "2000-09-12"],
    ["2000-09-12", "2000-09-12"],
    ["12-9-2000", "2000-09-12"],
    ["12.9.2000", "2000-09-12"],
    ["12 9 2000", "2000-09-12"],
    ["12 September 2000", "2000-09-12"],
    ["12 sept 2000", "2000-09-12"],
    ["sep 12 2000", "2000-09-12"],
    ["١٢/٩/٢٠٠٠", "2000-09-12"],
    ["١٢-٠٩-٢٠٠٠", "2000-09-12"],
    ["١٢ سبتمبر ٢٠٠٠", "2000-09-12"],
    ["۱۲/۹/۲۰۰۰", "2000-09-12"],
  ])("reads %s as %s in a day-first clinic", (input, expected) => {
    const parsed = parseDateOfBirth(input, { order: "dmy", now: NOW });
    expect(parsed.ok && parsed.iso).toBe(expected);
  });

  it("respects a month-first clinic convention", () => {
    const parsed = parseDateOfBirth("9/12/2000", { order: "mdy", now: NOW });
    expect(parsed.ok && parsed.iso).toBe("2000-09-12");
  });

  it("normalizes Arabic and extended-Arabic digits on their own", () => {
    expect(normalizeDigits("٠١٢٣٤٥٦٧٨٩")).toBe("0123456789");
    expect(normalizeDigits("۰۱۲۳۴۵۶۷۸۹")).toBe("0123456789");
  });

  it("survives the invisible direction marks WhatsApp inserts around numbers", () => {
    const parsed = parseDateOfBirth("‏12/9/2000‎", { order: "dmy", now: NOW });
    expect(parsed.ok && parsed.iso).toBe("2000-09-12");
  });

  it("flags a genuinely ambiguous date instead of choosing quietly", () => {
    const parsed = parseDateOfBirth("12/9/2000", { order: "dmy", now: NOW });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.ambiguous).toBe(true);
    expect(parsed.alternativeIso).toBe("2000-12-09");
  });

  it("does not manufacture ambiguity where there is none", () => {
    // A day above twelve, an identical day and month, an ISO date, and a month
    // written as a word can each only mean one thing.
    for (const input of ["25/12/1990", "5/5/2000", "2000-09-12", "12 September 2000"]) {
      const parsed = parseDateOfBirth(input, { order: "dmy", now: NOW });
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.ambiguous).toBe(false);
    }
  });

  it("drops a reading that would put the birthday in the future", () => {
    // 4/13 is not a date, so this can only be 13 April — nothing to ask about.
    const parsed = parseDateOfBirth("13/4/2001", { order: "dmy", now: NOW });
    expect(parsed.ok && parsed.iso).toBe("2001-04-13");
    expect(parsed.ok && parsed.ambiguous).toBe(false);
  });

  it("expands a two-digit year into the past", () => {
    const parsed = parseDateOfBirth("12/9/99", { order: "dmy", now: NOW });
    expect(parsed.ok && parsed.iso).toBe("1999-09-12");
  });

  it("refuses impossible and unreadable dates with a specific reason", () => {
    expect(parseDateOfBirth("31/2/2000", { now: NOW })).toEqual({
      ok: false,
      reason: "impossible_date",
    });
    expect(parseDateOfBirth("sometime in the nineties", { now: NOW })).toEqual({
      ok: false,
      reason: "unrecognized",
    });
    expect(parseDateOfBirth("12/9/1850", { now: NOW })).toEqual({
      ok: false,
      reason: "out_of_range",
    });
    expect(parseDateOfBirth("   ", { now: NOW })).toEqual({ ok: false, reason: "empty" });
  });

  it("keeps a future appointment date parseable while a birthday is not", () => {
    expect(parseHumanDate("18/8/2026", { order: "dmy", now: NOW }).ok).toBe(true);
    expect(parseDateOfBirth("18/8/2027", { order: "dmy", now: NOW }).ok).toBe(false);
  });

  it("derives the clinic's date convention from its country", () => {
    expect(dateOrderForCountry("EG")).toBe("dmy");
    expect(dateOrderForCountry("kw")).toBe("dmy");
    expect(dateOrderForCountry("US")).toBe("mdy");
    expect(dateOrderForCountry(null)).toBe("dmy");
  });
});

describe("P8 relative days", () => {
  it.each([
    ["tomorrow", "2026-08-18"],
    ["بكرا", "2026-08-18"],
    ["بكرة", "2026-08-18"],
    ["غدا", "2026-08-18"],
    ["اليوم", "2026-08-17"],
    ["النهاردة", "2026-08-17"],
    ["بعد بكرة", "2026-08-19"],
  ])("resolves %s to %s in the clinic's timezone", (input, expected) => {
    expect(parseRelativeDay(input, { now: NOW, timeZone: "Africa/Cairo" })).toBe(expected);
  });

  it("understands a relative day inside a whole sentence", () => {
    expect(
      parseRelativeDay("عايز احجز بكرا مع دكتور أحمد", { now: NOW, timeZone: "Africa/Cairo" }),
    ).toBe("2026-08-18");
  });

  it("returns null for anything that is not a relative day", () => {
    expect(parseRelativeDay("18/8/2026", { now: NOW })).toBeNull();
  });
});

describe("P8 flexible time parsing", () => {
  it.each([
    ["17:00", 17 * 60, false],
    ["5pm", 17 * 60, false],
    ["5 PM", 17 * 60, false],
    ["5 م", 17 * 60, false],
    ["الساعة ٥ العصر", 17 * 60, false],
    ["9am", 9 * 60, false],
    ["٩ صباحا", 9 * 60, false],
    // A bare `3:30` really could be half past three in the afternoon, so it is
    // reported as a morning reading that the caller should confirm.
    ["3:30", 3 * 60 + 30, true],
    ["٣ ونص", 3 * 60 + 30, true],
  ])("reads %s", (input, minutes, ambiguous) => {
    expect(parseHumanTime(input)).toEqual({ minutes, ambiguous });
  });

  it("marks a bare hour as ambiguous rather than assuming morning silently", () => {
    expect(parseHumanTime("at 5")).toEqual({ minutes: 5 * 60, ambiguous: true });
  });

  it("does not read the 'am' inside an ordinary word as a meridiem", () => {
    // "exam" would otherwise force 4am on "exam at 4".
    expect(parseHumanTime("exam at 4")).toEqual({ minutes: 4 * 60, ambiguous: true });
  });
});

describe("P8 flexible phone, name and field parsing", () => {
  it.each([
    "٠١٠٠١٢٣٤٥٦٧",
    "+20 100 123 4567",
    "0020 100 123 4567",
    "01001234567",
    "(010) 0123-4567",
  ])("normalizes %s to E.164 for the clinic's country", (input) => {
    expect(parseHumanPhone(input, "EG")).toBe("+201001234567");
  });

  it("refuses text that is not a phone number", () => {
    expect(parseHumanPhone("call me later", "EG")).toBeNull();
    expect(parseHumanPhone("123", "EG")).toBeNull();
  });

  it("keeps a patient's own spelling of their name", () => {
    expect(parseHumanName("  محمد   حسن ")).toBe("محمد حسن");
    expect(parseHumanName("Ahmed  Ali")).toBe("Ahmed Ali");
    // No title-casing, no transliteration: the patient's spelling is correct.
    expect(parseHumanName("ahmed ali")).toBe("ahmed ali");
  });

  it("strips invisible direction characters out of a name", () => {
    expect(parseHumanName("‮محمد حسن‬")).toBe("محمد حسن");
  });

  it("refuses things that are not names", () => {
    expect(parseHumanName("123")).toBeNull();
    expect(parseHumanName("-")).toBeNull();
    expect(parseHumanName("a")).toBeNull();
  });

  it("normalizes national ids and emails as written", () => {
    expect(parseNationalId("٢٩٠٠٩١٢٠١٢٣٤٥٦")).toBe("29009120123456");
    expect(parseNationalId("290-0912-0123456")).toBe("29009120123456");
    expect(parseNationalId("abc")).toBeNull();
    expect(parseHumanEmail("  Foo.Bar@Example.COM ")).toBe("foo.bar@example.com");
    expect(parseHumanEmail("not an email")).toBeNull();
  });
});
