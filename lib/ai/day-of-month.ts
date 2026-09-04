/**
 * "يوم 16 الجاي" — a day of the month, with no month and no year attached.
 *
 * ## The defect this exists for
 *
 * Manual WhatsApp QA found that a patient naming a bare day — the single most
 * common way an Egyptian patient names an appointment day — produced nothing at
 * all. `parseHumanDate` correctly refuses to invent a month, `resolveDayFromOffers`
 * only ever matches a day the server had already listed, and everything below
 * that reads two numbers or none. So "يوم 16 الجاي" resolved to no date, the turn
 * fell through to the model, and the model answered with the whole day's slot
 * list or, worse, read the `16` as four o'clock.
 *
 * A bare day-of-month is not ambiguous the way `12/9` is. It has exactly one
 * sensible reading — the *next* time that day number comes round — and this
 * module produces it deterministically, from the clinic's own calendar day.
 *
 * ## The rule, in full
 *
 * * Day number greater than today's → this month.
 * * Day number less than today's → the next month that actually has that day.
 * * Day number equal to today's → today, unless the patient said "الجاي" /
 *   "القادم" / "next" / "upcoming", which explicitly excludes today.
 * * A month that does not contain the day is skipped, never bent: day 31 in
 *   September resolves to 31 October, and 29 February resolves to the next leap
 *   year. Nothing here can return a date that does not exist.
 *
 * ## What it will not do
 *
 * It never reads a *complete* date. A message carrying a month — in words or as
 * a second number — belongs to `parseHumanDate`, and this module withdraws from
 * it entirely, because "16/9" is a September date and reading the 16 out of it
 * would silently move the patient's booking.
 */

import { normalizeHumanText, parseMonthName } from "@/lib/ai/human-input";

/** How far ahead a skipped month may push the answer. 31 February never lands. */
const MAX_MONTHS_AHEAD = 24;

export type DayOfMonthReference = {
  /** 1–31, exactly as the patient said it. */
  day: number;
  /**
   * The patient said "الجاي" / "القادم" / "next" / "upcoming", which rules out
   * today even when today is that day number.
   */
  explicitNext: boolean;
  /**
   * The patient named the day as a *boundary* rather than as a choice — "بعد
   * يوم ٨", "after the 8th", "الأسبوع اللي بعد يوم 8".
   *
   * A boundary is not an answer to "which day?". Manual QA found "بعد يوم ٨"
   * silently resolved to the 9th and the booking moved on with a day the
   * patient never picked; the honest reading is "not before the 8th", which is
   * a lower bound on an availability search and nothing more. See
   * `readDateBoundary`.
   */
  boundary: boolean;
};

/**
 * A day marker, so a bare number is never read as a day.
 *
 * "16" on its own is a time as often as it is a day, and the offered-day and
 * offered-slot readers already own that case with real server offers behind
 * them. What is claimed here is only the shapes that *name* a day: "يوم 16",
 * "ليوم 16", "في يوم ١٦", "day 16", "the 16th", "next 16th".
 */
const AR_LETTER = "\\u0621-\\u064A\\u0670-\\u06D3";
const ARABIC_DAY_MARKER = new RegExp(
  `(?<![${AR_LETTER}])(?:ال|لل|[لبفوك])?(?:يوم|تاريخ)(?![${AR_LETTER}])\\s*(?:ال)?\\s*(\\d{1,2})(?!\\s*[:./\\-,،]\\s*\\d)`,
  "u",
);
const ENGLISH_DAY_MARKER =
  /\b(?:day|the|on)\s+(\d{1,2})(?:st|nd|rd|th)?\b(?!\s*[:./\-,]\s*\d)/i;
const ENGLISH_ORDINAL = /\b(\d{1,2})(?:st|nd|rd|th)\b(?!\s*[:./\-,]\s*\d)/i;

/** "الجاي", "القادم", "next", "upcoming" — an explicit exclusion of today. */
const EXPLICIT_NEXT =
  /(?:الجاي|الجايه|الجاية|الجى|القادم|القادمة|القادمه|المقبل|المقبلة)|\b(?:next|upcoming|coming)\b/iu;

/**
 * "بعد يوم ٨", "بعد تاريخ 8", "after the 8th", "من بعد يوم 8".
 *
 * A day marker preceded by "after". The whole point of matching the *pair* is
 * that "بعد" alone is not a boundary — "بعد الضهر" is a time of day and "بعد
 * بكرة" is a complete relative date that `parseHumanDate` already owns.
 */
const AR_AFTER_DAY = new RegExp(
  `(?<![${AR_LETTER}])(?:من\\s*)?بعد\\s*(?:ال)?(?:يوم|تاريخ)(?![${AR_LETTER}])`,
  "u",
);
const EN_AFTER_DAY = /\bafter\s+(?:the\s+)?(?:day\s+)?\d{1,2}(?:st|nd|rd|th)?\b|\bafter\s+(?:the\s+)?(?:day|date)\b/i;

/**
 * "بعد ٩" / "after 9" — the boundary with the day *marker* left out.
 *
 * Manual QA: a patient answering «أنهي يوم؟» with "بعد 9" had it resolved
 * straight to the 10th and the booking moved on with a day they never chose.
 * The pair reader above deliberately requires "يوم"/"تاريخ", so this shape
 * matched nothing at all and the turn fell through to the model, which picked
 * the next calendar day.
 *
 * A bare number after "بعد" is genuinely two things — a day and an hour — so
 * this claims it only when the message carries no clock signal at all. "بعد
 * الساعة ٩", "بعد ٩ مساءً" and "بعد ٥ م" are time constraints and stay with
 * `parsePatientAfterTime`; "بعد الضهر" and "بعد بكرة" carry no digit and are
 * untouched, exactly as before.
 */
const TIME_QUALIFIER = new RegExp(
  `(?<![${AR_LETTER}])(?:الساعة|الساعه|ساعة|ساعه|ص|صباحا|صباحًا|الصبح|م|مساء|مساءً|المسا|بالليل|الليل|الظهر|الضهر|العصر)(?![${AR_LETTER}])` +
    "|\\b(?:am|pm|a\\.m\\.|p\\.m\\.|o'?clock|noon|morning|evening|afternoon|night|hour)\\b" +
    "|\\d{1,2}\\s*[:.]\\s*\\d{2}",
  "iu",
);
const AR_AFTER_BARE_DAY = new RegExp(
  `(?<![${AR_LETTER}])(?:من\\s*)?بعد\\s*(?:ال)?\\s*(\\d{1,2})(?!\\s*[:./\\-,،]\\s*\\d)`,
  "u",
);
const EN_AFTER_BARE_DAY =
  /\bafter\s+(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?\b(?!\s*[:./\-,]\s*\d)/i;

/**
 * A duration, not a date: "بعد ٣ أيام", "after 2 weeks", "بعد ١٠ دقايق".
 *
 * The number there counts an interval from now; reading it as a day of the
 * month would bound the search on the wrong date entirely.
 */
const DURATION_NOUN = new RegExp(
  `(?<![${AR_LETTER}])(?:يوم|يومين|ايام|أيام|اسبوع|أسبوع|اسبوعين|أسبوعين|اسابيع|أسابيع|شهر|شهرين|شهور|أشهر|اشهر|سنة|سنه|سنين|دقيقة|دقيقه|دقايق|دقائق|ساعات|ساعتين)(?![${AR_LETTER}])` +
    "|\\b(?:days?|weeks?|months?|years?|minutes?|mins?|hours?|hrs?)\\b",
  "iu",
);

/** The bare-number boundary shape, or null when the message is not one. */
function readBareBoundaryDay(text: string): number | null {
  if (TIME_QUALIFIER.test(text)) return null;
  const match = AR_AFTER_BARE_DAY.exec(text) ?? EN_AFTER_BARE_DAY.exec(text);
  if (!match) return null;
  // "بعد ٣ أيام" counts days from today; it names no day of the month.
  const trailing = text.slice(match.index + match[0].length, match.index + match[0].length + 24);
  if (DURATION_NOUN.test(trailing)) return null;
  const day = Number(match[1]);
  return Number.isInteger(day) && day >= 1 && day <= 31 ? day : null;
}

/**
 * "الأسبوع اللي بعد يوم 8", "the week after the 8th" — a boundary that also
 * names how far past it the patient wants to look.
 */
const AR_WEEK_AFTER = /الأسبوع|الاسبوع/u;
const EN_WEEK_AFTER = /\bweek\b/i;

/**
 * The day number this message names, or null.
 *
 * Null whenever the message also carries a month — a month name, or a second
 * number joined to the first by a date separator — because that is a complete
 * date and belongs to the ordinary parser.
 */
export function readDayOfMonthReference(
  input: string | null | undefined,
): DayOfMonthReference | null {
  const text = normalizeHumanText(input ?? "");
  if (!text) return null;
  // A month in words, or a numeric date, is a complete date. Not ours.
  if (parseMonthName(text) !== null) return null;
  if (/\d{1,2}\s*[/.\-]\s*\d{1,2}/.test(text)) return null;

  const match =
    ARABIC_DAY_MARKER.exec(text) ??
    ENGLISH_DAY_MARKER.exec(text) ??
    ENGLISH_ORDINAL.exec(text);
  if (!match) {
    // No day marker. The one shape still worth reading is the bare boundary —
    // "بعد ٩" — and it is only ever a boundary, never a chosen day.
    const bare = readBareBoundaryDay(text);
    return bare === null ? null : { day: bare, explicitNext: false, boundary: true };
  }
  const day = Number(match[1]);
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;
  const boundary =
    AR_AFTER_DAY.test(text) ||
    EN_AFTER_DAY.test(text) ||
    readBareBoundaryDay(text) === day;
  return { day, explicitNext: EXPLICIT_NEXT.test(text) && !boundary, boundary };
}

export type DateBoundary = {
  /** The day the patient wants availability *after*. 1–31. */
  day: number;
  /**
   * The resolved calendar day the search must start after, `YYYY-MM-DD`, or
   * null when the day number cannot land on a real date.
   */
  after: string | null;
  /**
   * The patient asked for a window rather than "the next thing" — "الأسبوع اللي
   * بعد يوم 8". The caller widens the search to that window.
   */
  window: "week" | null;
};

/**
 * "بعد يوم ٨" → a lower bound, never a date.
 *
 * Null when the message names no boundary at all. The `after` day is resolved
 * with exactly the same calendar rule a plain day-of-month uses, so a patient
 * who says "بعد يوم 8" on 20 September is bounded by 8 October rather than by a
 * date in the past.
 */
export function readDateBoundary(
  input: string | null | undefined,
  options: { now?: Date; timeZone?: string } = {},
): DateBoundary | null {
  const text = normalizeHumanText(input ?? "");
  if (!text) return null;
  const reference = readDayOfMonthReference(input);
  if (!reference || !reference.boundary) return null;
  return {
    day: reference.day,
    after: nearestFutureDayOfMonth(reference.day, {
      now: options.now,
      timeZone: options.timeZone,
    }),
    window: AR_WEEK_AFTER.test(text) || EN_WEEK_AFTER.test(text) ? "week" : null,
  };
}

function clinicToday(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function isRealCalendarDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function iso(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * The nearest future occurrence of `day`, in the clinic's own calendar.
 *
 * `notBefore` is a floor, exclusive: an amendment that names the day the draft
 * already holds means the *following* one, exactly as `parseUpcomingWeekday`
 * treats a weekday name.
 */
export function nearestFutureDayOfMonth(
  day: number,
  options: {
    now?: Date;
    timeZone?: string;
    explicitNext?: boolean;
    notBefore?: string | null;
  } = {},
): string | null {
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;
  const today = clinicToday(options.now ?? new Date(), options.timeZone ?? "UTC");
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const todayDay = Number(today.slice(8, 10));
  if (!Number.isInteger(year) || !Number.isInteger(month)) return null;

  // Today itself only counts when the patient did not explicitly exclude it.
  const startsThisMonth = options.explicitNext === true ? day > todayDay : day >= todayDay;
  let cursorYear = year;
  let cursorMonth = month + (startsThisMonth ? 0 : 1);
  for (let step = 0; step <= MAX_MONTHS_AHEAD; step += 1) {
    while (cursorMonth > 12) {
      cursorMonth -= 12;
      cursorYear += 1;
    }
    if (isRealCalendarDate(cursorYear, cursorMonth, day)) {
      const candidate = iso(cursorYear, cursorMonth, day);
      // Strictly after the floor, and never before today.
      if (candidate >= today && (!options.notBefore || candidate > options.notBefore)) {
        return candidate;
      }
    }
    cursorMonth += 1;
  }
  return null;
}

/**
 * "يوم 16 الجاي" → `2026-09-16`, or null when the message names no bare day.
 *
 * The one entry point callers should use. Everything it can return is a real
 * calendar day that is today or later.
 */
export function resolveUpcomingDayOfMonth(
  input: string | null | undefined,
  options: { now?: Date; timeZone?: string; notBefore?: string | null } = {},
): string | null {
  const reference = readDayOfMonthReference(input);
  if (!reference) return null;
  // A boundary is not a choice. "بعد يوم ٨" says the patient will not come on
  // the 8th or before it; it does not say they will come on the 9th, and
  // answering it with a date is the silent selection this refuses to make.
  // `readDateBoundary` is the reader for that shape.
  if (reference.boundary) return null;
  return nearestFutureDayOfMonth(reference.day, {
    ...options,
    explicitNext: reference.explicitNext,
  });
}
