/**
 * Deterministic normalization of the two value shapes patients state in words:
 * a clock time and a calendar date.
 *
 * ## Why this is not the interpreter's job
 *
 * The interpreter emits the patient's *words*. Turning «12 وربع» into `12:15`
 * is not a reading of intent — it is arithmetic on a well-known lexicon, and
 * arithmetic belongs in code that a test can pin without paying for a
 * generation. The engine this supports still refuses to *commit* anything these
 * functions produce: a normalized time is only committable if the clinic's own
 * calendar offered it, and a normalized date of birth that could be read two
 * ways comes back as two candidates so the flow asks which.
 *
 * ## The rule both functions obey
 *
 * **Never return one answer where the words support two.** A bare "3" is three
 * in the morning and three in the afternoon; `04/03/1990` is the fourth of
 * March and the third of April. Returning both and letting the caller ask is
 * the difference between a helpful normalizer and a booking on the wrong day.
 *
 * Everything here is pure: no clock, no locale service, no I/O.
 */

import { detectBookingBeneficiary } from "@/lib/ai/booking-beneficiary";

/** Arabic-Indic and Eastern Arabic-Indic digits, folded to ASCII. */
export function foldArabicDigits(text: string): string {
  return text.replace(/[٠-٩۰-۹]/g, (digit) => {
    const code = digit.codePointAt(0)!;
    const base = code >= 0x06f0 ? 0x06f0 : 0x0660;
    return String(code - base);
  });
}

/** Strips Arabic diacritics and collapses whitespace, for stable matching. */
export function foldArabic(text: string): string {
  return foldArabicDigits(text)
    .replace(/[ً-ْٰ]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/**
 * The Egyptian fraction lexicon, in minutes.
 *
 * Written as data so «وربع» and «إلا ربع» are one table rather than two
 * branches, and so adding «وخمسة» is a line rather than a code path.
 */
const FRACTIONS: readonly { pattern: RegExp; minutes: number }[] = [
  { pattern: /الا\s*(?:ربعا|ربع)/u, minutes: -15 },
  { pattern: /الا\s*(?:تلت|ثلث)/u, minutes: -20 },
  { pattern: /الا\s*(?:نصف|نص)/u, minutes: -30 },
  { pattern: /الا\s*(?:عشره|10)/u, minutes: -10 },
  { pattern: /الا\s*(?:خمسه|5)/u, minutes: -5 },
  { pattern: /و\s*(?:ربعا|ربع)/u, minutes: 15 },
  { pattern: /و\s*(?:تلت|ثلث)/u, minutes: 20 },
  { pattern: /و\s*(?:نصف|نص)/u, minutes: 30 },
  { pattern: /و\s*عشره/u, minutes: 10 },
  { pattern: /و\s*خمسه/u, minutes: 5 },
  { pattern: /\bquarter\s+past\b/, minutes: 15 },
  { pattern: /\bhalf\s+past\b/, minutes: 30 },
  { pattern: /\bquarter\s+to\b/, minutes: -15 },
];

/** Words that pin the half of the day. Absent means both halves are candidates. */
const MERIDIEM: readonly { pattern: RegExp; half: "am" | "pm" }[] = [
  { pattern: /(?:^|\s)(?:ص|صباحا|صباح|الصبح|بدري)(?:\s|$)/u, half: "am" },
  {
    pattern:
      /(?:^|\s)(?:م|مساء|مساءا|بالليل|الليل|ليلا|العصر|عصرا|الضهر|الظهر)(?:\s|$)/u,
    half: "pm",
  },
  { pattern: /\bam\b/, half: "am" },
  { pattern: /\bpm\b/, half: "pm" },
];

/** Filler the patient wraps the number in. Removed before parsing. */
const TIME_NOISE =
  /(?:^|\s)(?:الساعه|في|عند|حوالي|يكون|تكون|يبقي|at|around|about|oclock|o'clock)(?=\s|$)/gu;

export type TimeNormalization =
  /** Nothing in the text reads as a clock time. */
  | { kind: "none" }
  /**
   * One or more readings, in `HH:mm` 24-hour form, most likely first.
   *
   * More than one is the ordinary case for an unqualified hour, and the caller
   * is expected to disambiguate against real availability rather than to pick.
   */
  | { kind: "times"; times: readonly string[] };

/**
 * Reads a clock time out of the patient's words.
 *
 * Handles the shapes that actually arrive on WhatsApp: `12:15`, `١٢:١٥`,
 * «12 وربع», «الساعة ٣ العصر», «اتنين ونص», `3 pm`. Returns every reading the
 * words support and no reading they do not.
 */
export function normalizeSpokenTime(spoken: string): TimeNormalization {
  const text = foldArabic(spoken).toLowerCase().replace(TIME_NOISE, " ");
  const half = MERIDIEM.find((entry) => entry.pattern.test(text))?.half ?? null;

  let hour: number | null = null;
  let minute: number | null = null;
  /**
   * The fractional offset, kept apart from the hour it modifies.
   *
   * «واحدة إلا ربع» is a quarter to *one*, and one has two readings — 00:45 and
   * 12:45. Borrowing the hour before the meridiem was applied collapsed the
   * pair: 1 became 0, `hour === 0` is the one-reading midnight case, and the
   * afternoon reading a clinic actually books at was gone. Carrying the offset
   * separately and applying it to each reading keeps both, and keeps every
   * positive form («تسعة وربع») byte-identical to what it produced before.
   */
  let offset = 0;

  const explicit = /(\d{1,2})\s*[:.،,]\s*(\d{2})/.exec(text);
  if (explicit) {
    hour = Number(explicit[1]);
    minute = Number(explicit[2]);
  } else {
    const bare = /(?<!\d)(\d{1,2})(?!\d)/.exec(text);
    const word = bare ? null : hourFromArabicWord(text);
    if (bare) hour = Number(bare[1]);
    else if (word !== null) hour = word;
    if (hour === null) return { kind: "none" };
    minute = 0;
    for (const fraction of FRACTIONS) {
      if (fraction.pattern.test(text)) {
        offset = fraction.minutes;
        break;
      }
    }
  }

  if (hour === null || minute === null) return { kind: "none" };
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return { kind: "none" };
  if (minute < 0 || minute > 59) return { kind: "none" };
  if (hour < 0 || hour > 23) return { kind: "none" };

  // A 24-hour reading the patient stated outright (13:00, 19:30) has exactly
  // one meaning and gains nothing from a second candidate.
  if (hour > 12) {
    const only = shiftClock(hour * 60 + minute, offset);
    return only === null ? { kind: "none" } : { kind: "times", times: [only] };
  }

  const am = shiftClock((hour === 12 ? 0 : hour) * 60 + minute, offset);
  const pm = shiftClock((hour === 12 ? 12 : hour + 12) * 60 + minute, offset);
  if (half === "am") return am === null ? { kind: "none" } : { kind: "times", times: [am] };
  if (half === "pm") return pm === null ? { kind: "none" } : { kind: "times", times: [pm] };
  // A stated midnight hour has one reading; «12 إلا ربع» is the only shape that
  // can reach here with an hour of zero, and it is written as twelve.
  if (hour === 0) return am === null ? { kind: "none" } : { kind: "times", times: [am] };
  // Unqualified. Both readings, daytime first — a clinic books in the day far
  // more often than at night, and the caller filters against real availability
  // anyway, so the order is a tiebreak rather than a decision.
  const daytime = hour === 12 ? pm : am;
  const evening = hour === 12 ? am : pm;
  const times = [daytime, evening].filter((value): value is string => value !== null);
  const unique = [...new Set(times)];
  return unique.length === 0 ? { kind: "none" } : { kind: "times", times: unique };
}

/**
 * A clock reading in minutes-from-midnight, moved by a fractional offset.
 *
 * Returns null rather than wrapping. «12 إلا ربع صباحًا» would land the day
 * before, and a time that fell off the clock is not a time the patient can be
 * offered — the caller matches against real availability, where no such slot
 * exists anyway.
 */
function shiftClock(minutesFromMidnight: number, offset: number): string | null {
  const total = minutesFromMidnight + offset;
  if (total < 0 || total > 24 * 60 - 1) return null;
  return clock(Math.floor(total / 60), total % 60);
}

const ARABIC_HOURS: Readonly<Record<string, number>> = {
  واحده: 1, واحدة: 1, "الواحده": 1, "الواحدة": 1,
  اتنين: 2, اثنين: 2, "التانيه": 2, "الثانية": 2,
  تلاته: 3, ثلاثه: 3, "التالته": 3, "الثالثة": 3,
  اربعه: 4, "الرابعه": 4, "الرابعة": 4,
  خمسه: 5, "الخامسه": 5, "الخامسة": 5,
  سته: 6, "السادسه": 6, "السادسة": 6,
  سبعه: 7, "السابعه": 7, "السابعة": 7,
  تمانيه: 8, ثمانيه: 8, "الثامنه": 8, "الثامنة": 8,
  تسعه: 9, "التاسعه": 9, "التاسعة": 9,
  عشره: 10, "العاشره": 10, "العاشرة": 10,
  حداشر: 11, "الحاديه عشر": 11,
  اتناشر: 12, "الثانيه عشر": 12,
};

function hourFromArabicWord(text: string): number | null {
  for (const [word, hour] of Object.entries(ARABIC_HOURS)) {
    if (text.includes(word)) return hour;
  }
  return null;
}

function clock(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const ARABIC_MONTHS: Readonly<Record<string, number>> = {
  يناير: 1, "كانون الثاني": 1, january: 1, jan: 1,
  فبراير: 2, شباط: 2, february: 2, feb: 2,
  مارس: 3, اذار: 3, march: 3, mar: 3,
  ابريل: 4, نيسان: 4, april: 4, apr: 4,
  مايو: 5, ايار: 5, may: 5,
  يونيو: 6, يونيه: 6, حزيران: 6, june: 6, jun: 6,
  يوليو: 7, يوليه: 7, تموز: 7, july: 7, jul: 7,
  اغسطس: 8, اب: 8, august: 8, aug: 8,
  سبتمبر: 9, ايلول: 9, september: 9, sep: 9,
  اكتوبر: 10, "تشرين الاول": 10, october: 10, oct: 10,
  نوفمبر: 11, "تشرين الثاني": 11, november: 11, nov: 11,
  ديسمبر: 12, "كانون الاول": 12, december: 12, dec: 12,
};

export type DateNormalization =
  | { kind: "none" }
  /**
   * `YYYY-MM-DD` readings the words support.
   *
   * Two entries means the day/month order is genuinely undecidable from the
   * text — `04/03/1990` — and the caller must ask rather than choose. This is
   * the case the brief is most explicit about: confirmation here is good, and
   * a silent pick is a wrong date of birth on a medical file.
   */
  | { kind: "dates"; dates: readonly string[] };

/**
 * Reads a calendar date out of the patient's words.
 *
 * Accepts `15/3/1990`, `1990-03-15`, `١٥-٣-١٩٩٠`, «15 مارس 1990» and
 * «15 march 1990`. A four-digit component is unambiguously the year wherever
 * it sits; a named month removes the ordering question entirely.
 */
export type DateReadingOptions = {
  /**
   * How to read a numeric date whose day/month order the digits do not settle.
   *
   * `"either"` — return both readings and let the caller ask. Correct for
   * *matching*: `08-09-2026` is filtered against the seven days the clinic
   * actually offered, so two readings narrow to one without a question.
   *
   * `"day_first"` — return the day-month-year reading alone, falling back to
   * month-first only when day-first is not a real calendar date (`12/25/1990`).
   * Correct for a value the patient *typed as a date* — a date of birth — in a
   * clinic whose patients write `2.4.2003` and mean the second of April.
   *
   * Manual QA is why this option exists rather than a second parser. `2.4.2003`
   * came back as two candidates, the patient was asked which, and the pair is
   * the *same* semantic date written by two conventions rather than a genuine
   * ambiguity the product cannot resolve: the clinic's own convention resolves
   * it. Asking anyway produced a loop the patient could not escape.
   */
  readonly order?: "either" | "day_first";
};

export function normalizeSpokenDate(
  spoken: string,
  options: DateReadingOptions = {},
): DateNormalization {
  const text = foldArabic(spoken).toLowerCase();

  // A named month settles the order, so it is tried first.
  for (const [name, month] of Object.entries(ARABIC_MONTHS)) {
    if (!text.includes(name)) continue;
    const numbers = [...text.matchAll(/(?<!\d)(\d{1,4})(?!\d)/g)].map((match) =>
      Number(match[1]),
    );
    const year = numbers.find((value) => value >= 1000);
    const day = numbers.find((value) => value >= 1 && value <= 31 && value !== year);
    if (year === undefined || day === undefined) continue;
    const iso = isoDate(year, month, day);
    return iso ? { kind: "dates", dates: [iso] } : { kind: "none" };
  }

  const parts = /(?<!\d)(\d{1,4})\s*[/\-.\\ ]\s*(\d{1,2})\s*[/\-.\\ ]\s*(\d{1,4})(?!\d)/.exec(
    text,
  );
  if (!parts) return { kind: "none" };
  const [a, b, c] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];

  // ISO order — the year leads and there is nothing to decide.
  if (a >= 1000) {
    const iso = isoDate(a, b, c);
    return iso ? { kind: "dates", dates: [iso] } : { kind: "none" };
  }
  if (c < 1000) {
    // A two-digit year is a third unknown on top of two. Refusing is correct:
    // asking one question costs a turn, guessing costs a wrong date of birth.
    return { kind: "none" };
  }
  const dayFirst = isoDate(c, b, a);
  const monthFirst = isoDate(c, a, b);
  // Day-month-year is the convention this clinic's patients write in. When it
  // yields a real date, it *is* the reading — the month-first alternative is
  // the same digits under a different convention, not a second thing the
  // patient might have meant. Month-first survives only as the fallback for
  // digits day-first cannot read at all (`12/25/1990`).
  const readings =
    options.order === "day_first"
      ? [dayFirst ?? monthFirst].filter((value): value is string => value !== null)
      : [dayFirst, monthFirst].filter((value): value is string => value !== null);
  // Identical readings (05/05) collapse to one; distinct ones are both returned
  // and the caller asks which.
  const unique = [...new Set(readings)];
  return unique.length === 0 ? { kind: "none" } : { kind: "dates", dates: unique };
}

function isoDate(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (year < 1900 || year > 2200) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  // Rejects the 31st of a 30-day month rather than silently rolling it over.
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Day-of-month readings for a date the *server* already offered.
 *
 * The booking day step never parses a date — it matches the patient's words
 * against the calendar days the clinic returned. «يوم ١٠» and "10" are the same
 * request and neither is a date until a real available day carries that number.
 */
export function dayOfMonthFromSpoken(spoken: string): number | null {
  const text = foldArabicDigits(spoken);
  const match = /(?<!\d)(\d{1,2})(?!\d)/.exec(text);
  if (!match) return null;
  const day = Number(match[1]);
  return day >= 1 && day <= 31 ? day : null;
}

// ---------------------------------------------------------------------------
// Beneficiary
// ---------------------------------------------------------------------------

/**
 * The canonical values the booking's `beneficiary` slot may hold.
 *
 * They are ids, not words. Nothing patient-facing may ever render one — see
 * the beneficiary step's offer labels, which are prose in the patient's own
 * language precisely so that these two tokens stay inside the server.
 */
export type BeneficiaryValue = "self" | "other";

/**
 * The tokens the *server* uses for the two readings.
 *
 * Accepted as input because manual QA proved a patient can be shown one: a
 * two-option offer whose labels were the raw enum rendered as «self، other»,
 * and the patient answered "Other". Refusing to understand our own vocabulary
 * after putting it in front of somebody is the worst of both worlds, so the
 * canonical form round-trips — while the leak itself is fixed at the source.
 */
const CANONICAL: Readonly<Record<string, BeneficiaryValue>> = {
  self: "self",
  other: "other",
};

/**
 * "Not for me" — the negated *self* clause.
 *
 * `detectBookingBeneficiary` already strips a negated *third-party* clause
 * («مش لشخص تاني») so that «أحجز لنفسي مش لشخص تاني» reads as `self`. The
 * mirror image was missing: «مش ليا» is a perfectly ordinary answer to «الحجز
 * ده ليك إنت ولا لحد تاني؟» and it read as `self`, because the self pattern
 * matched «ليا» and the negation in front of it was invisible.
 *
 * Deliberately excludes a bare «لا» as the negator: «لا، ليا أنا» is a
 * *correction towards* self, and reading its «لا» as a negation of «ليا» would
 * invert the one sentence a patient uses to undo a wrong beneficiary.
 */
const AR_NEGATED_SELF =
  /(?<![ء-ي])(?:مش|مو|ليس|مهو|ماهو)\s+(?:ل\s*)?(?:يا|ي|نفس[يى]|شخص[يى]|انا)\s*(?:انا)?(?![ء-ي])/u;
const EN_NEGATED_SELF =
  /\b(?:not|isn'?t|it'?s\s+not)\s+for\s+(?:me|myself)\b|\bnot\s+(?:me|mine|myself)\b/i;

/** Bare first-person answers the shared lexicon does not carry on their own. */
const EN_BARE_SELF = /^(?:me|myself|my\s?self|for\s+me|mine)$/i;
/** Bare third-party answers, likewise. */
const EN_BARE_OTHER = /^(?:another|another\s+one|third\s+party|not\s+me)$/i;

/**
 * Who a booking is for, from one message, deterministically.
 *
 * The single authority for the `beneficiary` slot: the flow step resolves with
 * it, and the engine's canonical-answer reconciliation reads the patient's own
 * words through it rather than trusting whichever command the interpreter chose
 * to emit. `null` means "this message did not say", which is the only cue for
 * asking again.
 *
 * The lexicon itself is not duplicated here. `detectBookingBeneficiary` is the
 * one that manual QA has been hardening since P12 — prepositions, relationship
 * nouns, negated third-party clauses — and having two of them is how the two
 * engines would come to disagree about the same sentence.
 */
export function normalizeBeneficiary(spoken: string): BeneficiaryValue | null {
  const folded = foldArabic(spoken).trim();
  if (!folded) return null;
  const canonical = CANONICAL[folded.toLowerCase()];
  if (canonical) return canonical;
  if (EN_BARE_SELF.test(folded)) return "self";
  if (EN_BARE_OTHER.test(folded)) return "other";

  // The negated-self clause is removed rather than answered outright, for the
  // same reason the negated-other clause is: a sentence that rules out one
  // person and names another («مش ليا، لمراتي») must still resolve, and it
  // resolves on the half the patient actually meant.
  const withoutNegatedSelf = folded
    .replace(AR_NEGATED_SELF, " ")
    .replace(EN_NEGATED_SELF, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (withoutNegatedSelf !== folded) {
    const rest = detectBookingBeneficiary(withoutNegatedSelf);
    // "Not for me, for my wife" and a bare "not for me" are both `other`. Only
    // a remainder that positively says `self` is left unresolved, because a
    // sentence that negates *and* asserts the same person is not an answer.
    return rest === "self" ? null : "other";
  }
  return detectBookingBeneficiary(folded);
}

// ---------------------------------------------------------------------------
// Day references against an offered calendar
// ---------------------------------------------------------------------------

/**
 * A day-and-month the patient named without a year — «8 سبتمبر», "8 September".
 *
 * Separate from {@link normalizeSpokenDate}, which requires a four-digit year
 * before it will read a named month at all. That is the right rule for a date
 * of birth, where guessing a year is how a medical file acquires a wrong one,
 * and the wrong rule for an appointment: the year is not in question, because
 * the only dates on the table are the ones the clinic's calendar just offered.
 * The caller matches this against those, so no year is ever invented.
 */
export function dayMonthFromSpoken(
  spoken: string,
): { day: number; month: number } | null {
  const text = foldArabic(spoken).toLowerCase();
  for (const [name, month] of Object.entries(ARABIC_MONTHS)) {
    if (!text.includes(name)) continue;
    const numbers = [...text.matchAll(/(?<!\d)(\d{1,4})(?!\d)/g)].map((match) =>
      Number(match[1]),
    );
    const day = numbers.find((value) => value >= 1 && value <= 31);
    if (day === undefined) continue;
    return { day, month };
  }
  return null;
}

/**
 * `YYYY-MM-DD` readings of a date the patient wrote in full.
 *
 * A thin wrapper over {@link normalizeSpokenDate} that also accepts the
 * appointment-shaped year range the birth-date parser refuses. Returns every
 * reading the digits support, so `08-09-2026` produces both the eighth of
 * September and the ninth of August and the caller — which is matching against
 * a real seven-day window — keeps whichever one the clinic actually offered.
 */
export function fullDateReadings(spoken: string): readonly string[] {
  const parsed = normalizeSpokenDate(spoken);
  return parsed.kind === "dates" ? parsed.dates : [];
}

// ---------------------------------------------------------------------------
// Refining an open day request
// ---------------------------------------------------------------------------

/**
 * Words that make a message a *narrowing of the current request* rather than an
 * answer to it.
 *
 * This is the whole discriminator, and it is why «8 سبتمبر» still selects the
 * eighth while «بعد يوم 11» asks for what comes after the eleventh. Without an
 * explicit marker nothing here fires, so an ordinary day answer can never be
 * mistaken for a refinement.
 */
const AFTER_MARKER =
  /(?:بعد|من\s*بعد|ابتداء\s*من|اعتبارا\s*من|starting|after|later\s+than|beyond|from\s+the)/u;
const NEXT_WEEK_MARKER =
  /(?:الاسبوع\s*(?:الجاي|القادم|اللي\s*جاي|اللي\s*بعده|اللي\s*بعد\s*ده)|بعد\s*الاسبوع\s*ده|بعد\s*اسبوع|next\s+week|the\s+week\s+after)/u;
const NEXT_MONTH_MARKER =
  /(?:الشهر\s*(?:الجاي|القادم|اللي\s*جاي)|next\s+month)/u;

/**
 * The lower bound a message sets on an open day request, or null.
 *
 * The QA turn this exists for: the assistant had offered days, the patient
 * paused, and then wrote «ايه الايام المتاحة بعد يوم 11». That is neither a new
 * question nor an answer to the offer — it is the *same* request with a bound
 * on it, and the command vocabulary already had a slot for exactly that
 * (`date_lower_bound`) which nothing could reach because no step owned it.
 *
 * The returned date is **exclusive**, matching `readAvailableDays`, so the
 * eleventh is the last day excluded and the window opens on the twelfth.
 *
 * `today` is the clinic-local calendar date, so a bare day-of-month resolves
 * forwards: the eleventh of this month if it is still ahead, otherwise the
 * eleventh of next month. It never resolves into the past, because a bound in
 * the past bounds nothing.
 */
export function parseDateLowerBound(
  spoken: string,
  today: string,
  options: DateLowerBoundOptions = {},
): { date: string; explicit: boolean } | null {
  const text = foldArabic(spoken).toLowerCase();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) return null;

  if (NEXT_MONTH_MARKER.test(text)) {
    return { date: shiftCalendarDate(today, 29), explicit: true };
  }
  if (NEXT_WEEK_MARKER.test(text)) {
    return { date: shiftCalendarDate(today, 6), explicit: true };
  }
  const explicit = AFTER_MARKER.test(text) || CONTEXTUAL_AFTER_MARKER.test(text);
  if (!explicit) return null;

  // A full date wins: it says exactly which day the patient means.
  const full = fullDateReadings(spoken).filter((date) => date >= today);
  if (full.length === 1) return { date: full[0]!, explicit };

  const dayMonth = dayMonthFromSpoken(spoken);
  if (dayMonth) {
    const resolved = forwardDate(today, dayMonth.day, dayMonth.month);
    if (resolved) return { date: resolved, explicit };
  }

  const dayOfMonth = dayOfMonthFromSpoken(spoken);
  if (dayOfMonth !== null) {
    const resolved = forwardDate(today, dayOfMonth, null);
    if (resolved) return { date: resolved, explicit };
  }

  // «بعد الجمعة» — a weekday, not a number.
  //
  // Last of the readings deliberately: a message carrying a date or a
  // day-of-month has already said which day it means, and «بعد الجمعة 11» must
  // resolve on the eleventh rather than on whichever Friday comes first. What
  // this adds is the case that has no number in it at all, which is how people
  // ordinarily talk about the end of a week they are looking at.
  //
  // The anchor is the clinic's today and the bound is the **next** occurrence
  // of that weekday at or after it — which, for a day list that spans the
  // coming week, is the Friday the patient is looking at. It never resolves
  // backwards, because a bound in the past bounds nothing.
  const weekday = weekdayFromSpoken(spoken);
  if (weekday !== null) {
    const resolved = forwardWeekday(today, weekday);
    if (resolved) return { date: resolved, explicit };
  }

  // «بعد التاريخ ده», «اللي بعدهم», "after these dates".
  //
  // Last of every reading, deliberately: a message that names a date, a
  // day-of-month or a weekday has already said which day it means, and only a
  // sentence that names *none* of them is pointing at the list on the screen.
  //
  // The anchor is `offeredDates` — the days the server minted into the offer
  // the patient is looking at **right now**. Nothing here reads the transcript,
  // and the caller is responsible for passing a live offer or nothing at all:
  // a withdrawn, answered or parked offer contributes no dates, so the phrase
  // resolves to no bound and the step asks rather than guessing (I-2). The
  // latest displayed date is the boundary, and it is exclusive, so the window
  // opens on the first eligible day after everything the patient has seen.
  const offered = (options.offeredDates ?? []).filter((date) =>
    /^\d{4}-\d{2}-\d{2}$/.test(date),
  );
  if (offered.length > 0 && CONTEXTUAL_AFTER_MARKER.test(text)) {
    const latest = offered.reduce((a, b) => (a > b ? a : b));
    return { date: latest, explicit };
  }
  return null;
}

/** Options for {@link parseDateLowerBound}. */
export type DateLowerBoundOptions = {
  /**
   * The `YYYY-MM-DD` days the **currently open** offer put in front of the
   * patient, if any. Empty or absent means a contextual "after these" resolves
   * to nothing, which is the safe answer: a bound has to come from a list the
   * patient can actually see.
   */
  readonly offeredDates?: readonly string[];
};

/**
 * "after these / after that / the ones later" — a bound whose date is on screen.
 *
 * Deliberately narrow, and deliberately demonstrative. Every alternative below
 * points at something already displayed: «بعد التاريخ ده», «بعد دول», «اللي
 * بعدهم», «وريني اللي بعد كده», "after these dates", "show me later dates". A
 * bare «بعد» matches nothing here, because "after" with no referent is not a
 * bound and inventing one from the transcript is exactly what this must not do.
 */
const CONTEXTUAL_AFTER_MARKER =
  /(?:بعد\s*(?:ال)?(?:تاريخ|تواريخ|يوم|ايام|مواعيد|المواعيد)?\s*(?:ده|دا|دي|دول|كده|كدا|هذا|هذه|هؤلاء)|اللي\s*بعد(?:هم|هرم)?|بعدهم|after\s+(?:these|those|that)(?:\s+\w+)?|later\s+dates?|other\s+dates?)/u;

/** The first date on or after `today` falling on `weekday` (0 = Sunday). */
function forwardWeekday(today: string, weekday: number): string | null {
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) return null;
  const at = new Date(`${today}T12:00:00Z`);
  if (!Number.isFinite(at.getTime())) return null;
  const delta = (weekday - at.getUTCDay() + 7) % 7;
  return shiftCalendarDate(today, delta);
}

/** `today` moved by whole calendar days, in UTC, on the calendar date itself. */
function shiftCalendarDate(today: string, days: number): string {
  const date = new Date(`${today}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * The next occurrence of a day-of-month (and optionally a month) at or after
 * `today`, within a year. Null when the words describe no real date.
 */
function forwardDate(today: string, day: number, month: number | null): string | null {
  if (day < 1 || day > 31) return null;
  const [year, currentMonth] = today.split("-").map(Number) as [number, number, number];
  for (let step = 0; step <= 12; step += 1) {
    const absolute = (currentMonth - 1 + step) % 12;
    const targetYear = year + Math.floor((currentMonth - 1 + step) / 12);
    const targetMonth = absolute + 1;
    if (month !== null && targetMonth !== month) continue;
    const candidate = `${String(targetYear).padStart(4, "0")}-${String(targetMonth).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    // Rejects the 31st of a 30-day month rather than rolling it forward.
    const parsed = new Date(`${candidate}T12:00:00Z`);
    if (parsed.getUTCDate() !== day || parsed.getUTCMonth() + 1 !== targetMonth) continue;
    if (candidate >= today) return candidate;
  }
  return null;
}

/** Every written form of a weekday this system will read. Matching only. */
const WEEKDAY_PATTERNS: readonly RegExp[] = [
  /(?:الاحد|احد|sunday|sun)/u,
  /(?:الاتنين|الاثنين|اتنين|اثنين|monday|mon)/u,
  /(?:الثلاثاء|التلات|تلات|ثلاثاء|tuesday|tue)/u,
  /(?:الاربعاء|الاربع|اربعاء|wednesday|wed)/u,
  /(?:الخميس|خميس|thursday|thu)/u,
  /(?:الجمعه|جمعه|friday|fri)/u,
  /(?:السبت|سبت|saturday|sat)/u,
];

/**
 * The weekday a message names, or null.
 *
 * Folded through `foldArabic` first, so «الإثنين», «الاثنين» and «اتنين» are
 * one word. Returns null for a message naming none and — deliberately — for one
 * naming two, because "Monday or Tuesday" is a question rather than an answer.
 */
export function weekdayFromSpoken(spoken: string): number | null {
  const text = foldArabic(spoken).toLowerCase();
  let found: number | null = null;
  for (let index = 0; index < WEEKDAY_PATTERNS.length; index += 1) {
    if (!WEEKDAY_PATTERNS[index]!.test(text)) continue;
    if (found !== null) return null;
    found = index;
  }
  return found;
}


// ---------------------------------------------------------------------------
// Days named relative to now
// ---------------------------------------------------------------------------

/**
 * «النهاردة», «بكرة», «بعد بكرة» and their English equivalents.
 *
 * Read here rather than turned into a date, because the *answer* to "can I come
 * tomorrow?" is a policy decision and not a calendar lookup: online booking has
 * a lead-time floor (see `lib/booking/lead-time.ts`), and a patient who names a
 * day inside it deserves to be told so and given the clinic's number — not to
 * be shown a list that silently does not contain the day they asked for.
 *
 * Order matters: «بعد بكرة» contains «بكرة», so the compound is tested first.
 * A message naming none of them returns null and every other reading proceeds
 * exactly as before.
 */
export function relativeDayFromSpoken(
  spoken: string,
): "today" | "tomorrow" | "day_after_tomorrow" | null {
  const text = foldArabic(spoken).toLowerCase();
  if (
    /(?:بعد\s*بكره|بعد\s*غد|بعد\s*الغد|day\s+after\s+tomorrow)/u.test(text)
  ) {
    return "day_after_tomorrow";
  }
  if (/(?:بكره|غدا|الغد|tomorrow|tmrw)/u.test(text)) return "tomorrow";
  if (/(?:النهارده|انهارده|اليوم|today|tonight)/u.test(text)) return "today";
  return null;
}
