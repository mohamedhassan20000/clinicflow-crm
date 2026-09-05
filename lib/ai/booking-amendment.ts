/**
 * Reading "خليه الساعة 4 بدل 3:15" as an *edit* to the booking on the table,
 * rather than as the start of a new one.
 *
 * ## The defect this exists for
 *
 * The final review — «راجع تفاصيل طلب الحجز… هل تؤكد إرسال الطلب بهذه
 * التفاصيل؟» — is composed by the server and is the right last step. What had
 * no reading at all was the *other* answer to it. A patient who replies to a
 * review by moving the time is not confirming and is not asking a question, so
 * the turn fell through every deterministic path and landed on the model, which
 * has no way to change a booking draft and therefore did the only thing it
 * could: re-opened the funnel and asked again who the appointment is for.
 *
 * So this module answers one question, purely: *which day and which time is the
 * patient asking for instead?* It resolves nothing about availability, touches
 * no database, and can never produce a booking. Its output is a request, and
 * the caller is required to re-check it against the real schedule for the same
 * doctor before anything is written to the draft.
 *
 * ## What it will not do
 *
 * * It never changes the doctor, the department, the service, the patient, or
 *   any intake field. There is no shape here that can express those.
 * * It never confirms. A message that moves the time is an amendment and
 *   nothing else; the explicit-confirmation rules in `patient-turn-intent.ts`
 *   are untouched and are still the only way a booking is submitted.
 * * It never invents a day or a time. Days come from the caller's own
 *   clinic-aware resolver or from a weekday name; times come from
 *   `candidateClockTimes`, the same reader the time rung already uses.
 */

import { candidateClockTimes } from "@/lib/ai/booking-stage";
import { normalizeHumanText } from "@/lib/ai/human-input";

export type BookingAmendmentRequest =
  /** Nothing in this message asks for a different day or time. */
  | { kind: "none" }
  /** Same day, a different time. `times` are the competing clock readings. */
  | { kind: "time"; times: readonly string[] }
  /** A different day, no time named. */
  | { kind: "date"; date: string }
  /** Both, in one sentence. */
  | { kind: "date_time"; date: string; times: readonly string[] }
  /** "عايز الموعد اللي بعده" — the next offered slot after the one held. */
  | { kind: "next_slot" };

/** Long enough to be a paragraph is not a one-line edit to a booking. */
const MAX_AMENDMENT_LENGTH = 140;
const MAX_AMENDMENT_WORDS = 16;

const AR_LETTER = "\\u0621-\\u064A\\u0670-\\u06D3";

/**
 * The clause naming the value being *replaced* — "… بدل 3:15", "instead of 3".
 *
 * Removed before anything is parsed, because `candidateClockTimes` reads an
 * explicit `H:MM` first and would otherwise return the time the patient just
 * rejected. Written so it cannot bite into `بدلها`/`بدله`, which are the verb
 * with a pronoun on it and name no value at all.
 */
const REPLACED_VALUE_CLAUSE = new RegExp(
  `(?:(?<![${AR_LETTER}])(?:بدل|بدال|بدلا|بدلاً)(?![${AR_LETTER}])\\s*(?:من|عن)?\\s*[\\d\\u0660-\\u0669:.\\s]+$` +
    `|\\binstead\\s+of\\b[\\s\\d:.apm]+$)`,
  "iu",
);

/** "عايز الموعد اللي بعده" / "the next one" — a move relative to what is held. */
const NEXT_SLOT =
  /(?:اللي\s*بعده|اللي\s*بعدها|الل[يى]\s*بعد|الموعد\s*الجاي|الميعاد\s*الجاي|اللي\s*وراه)|\b(?:the\s+)?next\s+(?:one|slot|appointment|time)\b/iu;

/** A signal that this message is about a *day*. */
const DATE_SIGNAL = new RegExp(
  // The article and the one-letter prepositions ride on the noun in Arabic:
  // "ليوم 16" is the ordinary way to say it and the bare-stem lookbehind read
  // it as no day signal at all — which is how "غيره ليوم 16" was parsed as a
  // request for four o'clock.
  `(?<![${AR_LETTER}])(?:ال|لل|[لبفوك])?(?:يوم|تاريخ)(?![${AR_LETTER}])` +
    `|(?<![${AR_LETTER}])(?:بكرة|بكرا|بكره|غدا|غدًا|بعد\\s*بكرة|بعد\\s*بكرا)(?![${AR_LETTER}])` +
    "|\\b(?:day|date|tomorrow|today)\\b" +
    "|\\d{1,2}\\s*[/-]\\s*\\d{1,2}" +
    "|(?:يناير|فبراير|مارس|أبريل|ابريل|مايو|يونيو|يوليو|أغسطس|اغسطس|سبتمبر|أكتوبر|اكتوبر|نوفمبر|ديسمبر)" +
    "|\\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\b",
  "iu",
);

/** A signal that this message is about a *time*. */
const TIME_SIGNAL = new RegExp(
  `(?<![${AR_LETTER}])(?:الساعة|الساعه|ساعة|ساعه|الوقت|صباحا|صباحًا|الصبح|مساء|مساءً|المسا|بالليل|الظهر|العصر|ونص|وربع|إلا\\s*ربع|الا\\s*ربع)(?![${AR_LETTER}])` +
    "|\\b(?:time|at|am|pm|a\\.m\\.|p\\.m\\.|o'?clock|noon|morning|evening|afternoon)\\b" +
    "|\\d{1,2}\\s*[:.]\\s*\\d{2}",
  "iu",
);

/**
 * The word that opens the *time* half of "يوم 16 الساعة 10".
 *
 * Without it both numbers were fed to `candidateClockTimes`, which sees two
 * standalone numbers, concludes it is not looking at a time, and returns
 * nothing — so the single most common amendment a patient types resolved to
 * `none` and fell through to the model, which answered it with the whole day's
 * slot list. Splitting on the anchor gives the day reader "خليه يوم 16" and the
 * clock reader "الساعة 10", and each sees exactly one number.
 */
const TIME_ANCHOR = new RegExp(
  `(?<![${AR_LETTER}])(?:الساعة|الساعه|ساعة|ساعه)(?![${AR_LETTER}])` +
    "|\\b(?:at|o'?clock)\\b",
  "iu",
);

/**
 * Weekday names, which `parseRelativeDay` reads only in their "next X" form.
 *
 * The Arabic article is required — `الخميس`, `للخميس`, `وبالخميس` — rather than
 * the bare stem, because `أحد` without it is the ordinary word for "someone"
 * and appears in sentences that have nothing to do with a day.
 */
const AR_DEF = `(?<![${AR_LETTER}])(?:[لوبفك]?ال|لل)`;
const WEEKDAYS: ReadonlyArray<readonly [RegExp, number]> = [
  [new RegExp(`${AR_DEF}(?:أحد|احد)(?![${AR_LETTER}])|\\bsunday\\b`, "iu"), 0],
  [new RegExp(`${AR_DEF}(?:اثنين|إثنين)(?![${AR_LETTER}])|\\bmonday\\b`, "iu"), 1],
  [new RegExp(`${AR_DEF}(?:ثلاثاء|ثلاثا)(?![${AR_LETTER}])|\\btuesday\\b`, "iu"), 2],
  [new RegExp(`${AR_DEF}(?:أربعاء|اربعاء)(?![${AR_LETTER}])|\\bwednesday\\b`, "iu"), 3],
  [new RegExp(`${AR_DEF}(?:خميس)(?![${AR_LETTER}])|\\bthursday\\b`, "iu"), 4],
  [new RegExp(`${AR_DEF}(?:جمعة|جمعه)(?![${AR_LETTER}])|\\bfriday\\b`, "iu"), 5],
  [new RegExp(`${AR_DEF}(?:سبت)(?![${AR_LETTER}])|\\bsaturday\\b`, "iu"), 6],
];

function clinicToday(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function shiftDay(isoDay: string, offset: number): string {
  const shifted = new Date(`${isoDay}T00:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() + offset);
  return shifted.toISOString().slice(0, 10);
}

/**
 * "الخميس" → the next Thursday that is genuinely in the future.
 *
 * Strictly forward, and never the day the booking already holds: a patient
 * saying "خليها الخميس" about a Thursday booking means the *following* one, and
 * returning the day they are trying to leave would silently do nothing.
 */
export function parseUpcomingWeekday(
  text: string,
  options: { now?: Date; timeZone?: string; notBefore?: string | null } = {},
): string | null {
  const requested = WEEKDAYS.find(([pattern]) => pattern.test(text))?.[1];
  if (requested === undefined) return null;
  const today = clinicToday(options.now ?? new Date(), options.timeZone ?? "UTC");
  const todayWeekday = new Date(`${today}T12:00:00Z`).getUTCDay();
  let candidate = shiftDay(today, ((requested - todayWeekday + 7) % 7) || 7);
  const floor = options.notBefore ?? null;
  while (floor && candidate <= floor) candidate = shiftDay(candidate, 7);
  return candidate;
}

export type BookingAmendmentInput = {
  text: string | null | undefined;
  /** The day the draft currently holds, `YYYY-MM-DD`. */
  currentDate: string | null;
  now?: Date;
  timeZone?: string;
  /**
   * The caller's clinic-aware day reader — `resolveField` on the production
   * path. Tried only after the weekday pass, and only when the message actually
   * carries a day signal.
   */
  resolveDate?: (text: string) => string | null;
};

export function parseBookingAmendment(
  input: BookingAmendmentInput,
): BookingAmendmentRequest {
  const raw = normalizeHumanText(input.text ?? "").trim();
  if (!raw || raw.length > MAX_AMENDMENT_LENGTH) return { kind: "none" };
  if (raw.split(/\s+/u).length > MAX_AMENDMENT_WORDS) return { kind: "none" };

  const text = raw.replace(REPLACED_VALUE_CLAUSE, " ").replace(/\s+/gu, " ").trim();
  if (!text) return { kind: "none" };

  if (NEXT_SLOT.test(text)) return { kind: "next_slot" };

  // "خليه يوم 16 الساعة 10" is two clauses, and each half must be read on its
  // own. Everything before the time anchor is about the day; everything from
  // the anchor on is about the clock. With no anchor the whole message is both,
  // exactly as before.
  const anchor = TIME_ANCHOR.exec(text);
  const dateText = anchor ? text.slice(0, anchor.index).trim() : text;
  const timeText = anchor ? text.slice(anchor.index).trim() : text;

  const wantsDate = DATE_SIGNAL.test(dateText);
  const wantsTime = TIME_SIGNAL.test(timeText);
  const weekday = parseUpcomingWeekday(dateText, {
    ...(input.now ? { now: input.now } : {}),
    ...(input.timeZone ? { timeZone: input.timeZone } : {}),
    notBefore: input.currentDate,
  });

  // A weekday name is a day signal in its own right — "غير اليوم للخميس" — and
  // it is read before the general resolver because that resolver would take the
  // bare "اليوم" in the same sentence for *today*.
  let date: string | null = weekday;
  if (!date && wantsDate) {
    date = input.resolveDate?.(dateText) ?? null;
    if (date === input.currentDate) date = null;
  }

  const times =
    wantsTime || (!date && !wantsDate) ? candidateClockTimes(timeText) : [];

  if (date && times.length > 0) return { kind: "date_time", date, times };
  if (date) return { kind: "date", date };
  if (times.length > 0) return { kind: "time", times };
  return { kind: "none" };
}
