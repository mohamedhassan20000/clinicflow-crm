import { normalizePhone } from "@/lib/phone/registry";

/**
 * P8 — understanding what people actually type.
 *
 * A patient writing to a clinic on WhatsApp is not filling in a form. They write
 * `12/9/2000`, `١٢-٩-٢٠٠٠`, `12 sept 2000`, `الساعة ٥ العصر`, `٠١٠٠ ١٢٣ ٤٥٦٧`.
 * Every one of those is a perfectly clear answer to "when were you born?" or
 * "what time suits you?", and an assistant that replies "please use DD/MM/YYYY"
 * is making its own convenience the patient's problem.
 *
 * So the parsing lives here, in one place, deterministic and testable, and the
 * model is never asked to do the normalization itself — it passes the patient's
 * words through and receives a canonical value or a specific reason it could not
 * produce one.
 *
 * Two rules run through all of it:
 *
 * **One canonical form.** Dates leave as `YYYY-MM-DD`, times as minutes past
 * midnight, phones as E.164. Nothing downstream ever sees the patient's spelling.
 *
 * **Guessing is not allowed.** `12/9/2000` has two readings, and picking one
 * silently is how a patient ends up with a stranger's chart on a date-of-birth
 * check. The clinic's own date convention resolves it where there is one, and
 * where the alternative reading is *also* a real date the result says so, so the
 * caller can ask one short question instead of quietly being wrong.
 */

// ---------------------------------------------------------------------------
// Digits and text normalization
// ---------------------------------------------------------------------------

const ARABIC_INDIC_OFFSET = 0x0660;
const EXTENDED_ARABIC_INDIC_OFFSET = 0x06f0;

/**
 * Arabic-Indic (٠١٢…) and Extended Arabic-Indic (۰۱۲…) digits to ASCII.
 *
 * Exported because it is useful on its own: every other parser in this file runs
 * input through it first, and so does anything that wants to compare what a
 * patient typed against a stored value.
 */
export function normalizeDigits(value: string): string {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= ARABIC_INDIC_OFFSET && code <= ARABIC_INDIC_OFFSET + 9) {
      out += String(code - ARABIC_INDIC_OFFSET);
    } else if (code >= EXTENDED_ARABIC_INDIC_OFFSET && code <= EXTENDED_ARABIC_INDIC_OFFSET + 9) {
      out += String(code - EXTENDED_ARABIC_INDIC_OFFSET);
    } else if (char === "٫" || char === "٬") {
      // Arabic decimal/thousands separators, which appear inside typed numbers.
      out += char === "٫" ? "." : "";
    } else {
      out += char;
    }
  }
  return out;
}

/**
 * Everything a string has to survive before it is looked at: Arabic digits
 * folded, Arabic-Indic tatweel and diacritics dropped, invisible direction marks
 * removed (they otherwise sit inside "١٢/٩" and break every pattern below), and
 * whitespace collapsed.
 */
export function normalizeHumanText(value: string): string {
  return normalizeDigits(value)
    .replace(/[\u0600-\u0605\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g, "")
    .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/** Which component a bare `12/9` names first. */
export type DateOrder = "dmy" | "mdy";

/**
 * The clinic's date convention, from its country.
 *
 * Month-first is a US, Philippine and Micronesian habit; everywhere ClinicFlow
 * operates writes the day first. This is a two-entry decision rather than a
 * library because getting it wrong in either direction is a patient-safety
 * question, and a short explicit list is auditable.
 */
export function dateOrderForCountry(country: string | null | undefined): DateOrder {
  return (country ?? "").trim().toUpperCase() === "US" ? "mdy" : "dmy";
}

const MONTH_NAMES: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
  // Modern Standard / Egyptian Arabic month names.
  يناير: 1, فبراير: 2, مارس: 3, ابريل: 4, أبريل: 4, مايو: 5, يونيو: 6, يونيه: 6,
  يوليو: 7, يوليه: 7, اغسطس: 8, أغسطس: 8, سبتمبر: 9, اكتوبر: 10, أكتوبر: 10,
  نوفمبر: 11, ديسمبر: 12,
  // Levantine/Iraqi names, which Gulf and Levant patients also use.
  "كانون الثاني": 1, شباط: 2, اذار: 3, آذار: 3, نيسان: 4, ايار: 5, أيار: 5,
  حزيران: 6, تموز: 7, اب: 8, آب: 8, ايلول: 9, أيلول: 9,
  "تشرين الاول": 10, "تشرين الأول": 10, "تشرين الثاني": 11, "كانون الاول": 12, "كانون الأول": 12,
};

export type ParsedDate = {
  /** The canonical value, `YYYY-MM-DD`. */
  iso: string;
  /**
   * The other reading, when the input is a bare numeric date whose day and month
   * are both plausible and produce a different day. Null when the input can only
   * mean one thing (an ISO date, a month name, a day above 12).
   */
  alternativeIso: string | null;
  /** True when `alternativeIso` is set — the caller should confirm, not guess. */
  ambiguous: boolean;
};

export type DateParseFailure =
  | "empty"
  | "unrecognized"
  | "impossible_date"
  | "out_of_range";

export type DateParseResult =
  | ({ ok: true } & ParsedDate)
  | { ok: false; reason: DateParseFailure };

function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
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
 * Two-digit years, resolved the way every form on earth resolves them: a year
 * that would put the person in the future is in the previous century.
 */
function expandYear(value: number, now: Date): number {
  if (value >= 100) return value;
  const century = Math.floor(now.getUTCFullYear() / 100) * 100;
  const candidate = century + value;
  return candidate > now.getUTCFullYear() ? candidate - 100 : candidate;
}

/**
 * A date, from however the patient wrote it.
 *
 * Accepts `2000-09-12`, `12/9/2000`, `12-09-2000`, `12.9.2000`, `12 9 2000`,
 * `12 Sep 2000`, `Sep 12 2000`, `١٢/٩/٢٠٠٠`, `١٢ سبتمبر ٢٠٠٠`, and the same
 * shapes with a two-digit year.
 *
 * `order` decides a bare numeric date; the result still reports the alternative
 * reading whenever there is one, so a caller doing something consequential (a
 * date-of-birth identity check, a registration) can ask rather than assume.
 */
export function parseHumanDate(
  input: string,
  options: { order?: DateOrder; now?: Date; minYear?: number; maxYear?: number } = {},
): DateParseResult {
  const order = options.order ?? "dmy";
  const now = options.now ?? new Date();
  const minYear = options.minYear ?? 1900;
  const maxYear = options.maxYear ?? now.getUTCFullYear() + 5;

  const text = normalizeHumanText(input).toLowerCase();
  if (text.length === 0) return { ok: false, reason: "empty" };

  const bounded = (candidate: ParsedDate): DateParseResult => {
    const year = Number(candidate.iso.slice(0, 4));
    if (year < minYear || year > maxYear) return { ok: false, reason: "out_of_range" };
    return { ok: true, ...candidate };
  };

  // ISO first: `2000-09-12` has exactly one meaning, and a patient who writes it
  // should never be asked to confirm anything.
  const isoMatch = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(text);
  if (isoMatch) {
    const [, y, m, d] = isoMatch.map(Number) as [number, number, number, number];
    if (!isRealDate(y, m, d)) return { ok: false, reason: "impossible_date" };
    return bounded({ iso: iso(y, m, d), alternativeIso: null, ambiguous: false });
  }

  // A month written as a word is unambiguous whichever side of the number it is.
  const monthWord = matchMonthName(text);
  if (monthWord) {
    const numbers = text.match(/\d{1,4}/g)?.map(Number) ?? [];
    const day = numbers.find((value) => value >= 1 && value <= 31);
    const yearRaw = numbers.find((value) => value !== day && value >= 1 && value <= 9999);
    if (day === undefined || yearRaw === undefined) return { ok: false, reason: "unrecognized" };
    const year = expandYear(yearRaw, now);
    if (!isRealDate(year, monthWord, day)) return { ok: false, reason: "impossible_date" };
    return bounded({ iso: iso(year, monthWord, day), alternativeIso: null, ambiguous: false });
  }

  // Three numbers with any of the separators people actually use.
  //
  // The comma is in that set because people type it. `24,3,2001` arrived from a
  // real patient and was refused as unreadable — the assistant then asked for
  // the date again, which is precisely the machine-shaped exchange this parser
  // exists to prevent. The Arabic comma is here for the same reason: it is what
  // an Arabic keyboard produces.
  const numeric =
    /^(\d{1,4})\s*[-/.,، ]\s*(\d{1,2})\s*[-/.,، ]\s*(\d{1,4})$/.exec(text);
  if (!numeric) return { ok: false, reason: "unrecognized" };
  const first = Number(numeric[1]);
  const middle = Number(numeric[2]);
  const last = Number(numeric[3]);

  // A four-digit group can only be the year, wherever it sits.
  if (String(numeric[1]).length === 4) {
    if (!isRealDate(first, middle, last)) return { ok: false, reason: "impossible_date" };
    return bounded({ iso: iso(first, middle, last), alternativeIso: null, ambiguous: false });
  }

  const year = expandYear(last, now);
  const dayFirst = isRealDate(year, middle, first) ? iso(year, middle, first) : null;
  const monthFirst = isRealDate(year, first, middle) ? iso(year, first, middle) : null;
  if (!dayFirst && !monthFirst) return { ok: false, reason: "impossible_date" };

  const preferred = order === "dmy" ? dayFirst ?? monthFirst! : monthFirst ?? dayFirst!;
  const other = order === "dmy" ? monthFirst : dayFirst;
  // Only a genuinely different second reading counts. `5/5/2000` and any date
  // whose day is above 12 have one meaning, and asking about them would be
  // exactly the pedantry this function exists to remove.
  const alternativeIso = other && other !== preferred ? other : null;
  return bounded({ iso: preferred, alternativeIso, ambiguous: alternativeIso !== null });
}

/**
 * The month a word names, in either language, or null.
 *
 * Exported because a *fragment* of an answer — a patient replying just
 * "سبتمبر" to "September or December?" — has to be understood on its own, with
 * no date around it. See `lib/ai/collected-state.ts`.
 */
export function parseMonthName(input: string): number | null {
  return matchMonthName(normalizeHumanText(input).toLowerCase());
}

function matchMonthName(text: string): number | null {
  for (const [name, month] of Object.entries(MONTH_NAMES)) {
    // Word-boundary matching in Arabic needs the space test rather than \b,
    // which does not treat Arabic letters as word characters consistently.
    const pattern = new RegExp(`(^|[^\\p{L}])${escapeRegExp(name)}([^\\p{L}]|$)`, "u");
    if (pattern.test(text)) return month;
  }
  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A date of birth, with the extra bounds a birthday has: it is in the past, and
 * nobody alive was born before 1900.
 */
export function parseDateOfBirth(
  input: string,
  options: { order?: DateOrder; now?: Date } = {},
): DateParseResult {
  const now = options.now ?? new Date();
  const parsed = parseHumanDate(input, {
    order: options.order,
    now,
    minYear: 1900,
    maxYear: now.getUTCFullYear(),
  });
  if (!parsed.ok) return parsed;
  const today = now.toISOString().slice(0, 10);
  if (parsed.iso > today) {
    // The preferred reading is in the future but the other one may not be — a
    // real case for `4/13/2001` typed by a patient in a day-first clinic.
    if (parsed.alternativeIso && parsed.alternativeIso <= today) {
      return { ok: true, iso: parsed.alternativeIso, alternativeIso: null, ambiguous: false };
    }
    return { ok: false, reason: "out_of_range" };
  }
  if (parsed.alternativeIso && parsed.alternativeIso > today) {
    // Only one reading can be a birthday, so there is nothing to ask about.
    return { ok: true, iso: parsed.iso, alternativeIso: null, ambiguous: false };
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Relative and spoken dates, for appointments
// ---------------------------------------------------------------------------

const RELATIVE_DAYS: Array<{ words: readonly string[]; offset: number }> = [
  { words: ["today", "tonight", "اليوم", "النهارده", "النهاردة", "الليلة"], offset: 0 },
  { words: ["tomorrow", "غدا", "غدًا", "بكرة", "بكرا", "بكره"], offset: 1 },
  { words: ["after tomorrow", "بعد بكرة", "بعد بكرا", "بعد غد"], offset: 2 },
];

/**
 * A day the patient named relative to now — "tomorrow", "بكرا", "بعد بكرة".
 *
 * Returned in the clinic's own timezone, because "tomorrow" is a fact about
 * where the clinic is, not about where the server is.
 */
export function parseRelativeDay(
  input: string,
  options: { now?: Date; timeZone?: string } = {},
): string | null {
  const text = normalizeHumanText(input).toLowerCase();
  if (text.length === 0) return null;
  const nextWeekday = parseNextWeekday(text, options);
  if (nextWeekday) return nextWeekday;
  // Longest phrases first: "بعد بكرة" contains "بكرة".
  const ordered = [...RELATIVE_DAYS].sort((a, b) => b.offset - a.offset);
  for (const entry of ordered) {
    if (entry.words.some((word) => text.includes(word))) {
      return shiftClinicDay(entry.offset, options.now ?? new Date(), options.timeZone ?? "UTC");
    }
  }
  return null;
}

function parseNextWeekday(
  text: string,
  options: { now?: Date; timeZone?: string },
): string | null {
  const weekdays: Array<[RegExp, number]> = [
    [/(?:next\s+sunday|الأحد\s+(?:الجاي|القادم)|الاحد\s+(?:الجاي|القادم))/i, 0],
    [/(?:next\s+monday|الاثنين\s+(?:الجاي|القادم)|الإثنين\s+(?:الجاي|القادم))/i, 1],
    [/(?:next\s+tuesday|الثلاثاء\s+(?:الجاي|القادم))/i, 2],
    [/(?:next\s+wednesday|الأربعاء\s+(?:الجاي|القادم)|الاربعاء\s+(?:الجاي|القادم))/i, 3],
    [/(?:next\s+thursday|الخميس\s+(?:الجاي|القادم))/i, 4],
    [/(?:next\s+friday|الجمعة\s+(?:الجاي|القادم))/i, 5],
    [/(?:next\s+saturday|السبت\s+(?:الجاي|القادم))/i, 6],
  ];
  const requested = weekdays.find(([pattern]) => pattern.test(text))?.[1];
  if (requested === undefined) return null;
  const today = shiftClinicDay(0, options.now ?? new Date(), options.timeZone ?? "UTC");
  const todayWeekday = new Date(`${today}T12:00:00Z`).getUTCDay();
  const offset = ((requested - todayWeekday + 7) % 7) || 7;
  return shiftClinicDay(offset, options.now ?? new Date(), options.timeZone ?? "UTC");
}

function shiftClinicDay(offsetDays: number, now: Date, timeZone: string): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const todayLocal = formatter.format(now);
  const shifted = new Date(`${todayLocal}T00:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() + offsetDays);
  return shifted.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Times
// ---------------------------------------------------------------------------

export type ParsedTime = { minutes: number; ambiguous: boolean };

const ARABIC_MERIDIEM: Array<{ words: readonly string[]; period: "am" | "pm" }> = [
  { words: ["صباحا", "صباح", "الصبح", "ص"], period: "am" },
  { words: ["مساء", "مساءا", "بالليل", "الليل", "م"], period: "pm" },
  { words: ["ظهرا", "الظهر", "بعد الظهر"], period: "pm" },
  { words: ["العصر", "عصرا"], period: "pm" },
];

/**
 * A clock time from ordinary speech: `17:00`, `5pm`, `5 م`, `الساعة ٥ العصر`,
 * `٣ ونص` (half past three).
 *
 * `ambiguous` marks a bare hour with no am/pm and no 24-hour form — `at 5` could
 * be either. The caller decides what to do with that; for appointments the clinic
 * schedule usually resolves it, and where it does not the assistant asks.
 */
export function parseHumanTime(input: string): ParsedTime | null {
  const text = normalizeHumanText(input).toLowerCase();
  if (text.length === 0) return null;

  const hhmm = /(\d{1,2})\s*[:.٫]\s*(\d{2})/.exec(text);
  let hour: number;
  let minute: number;
  let explicit24 = false;
  if (hhmm) {
    hour = Number(hhmm[1]);
    minute = Number(hhmm[2]);
    explicit24 = hour > 12;
  } else {
    const bare = /(?:^|[^\d])(\d{1,2})(?![\d:.])/.exec(text);
    if (!bare) return null;
    hour = Number(bare[1]);
    minute = 0;
    explicit24 = hour > 12;
    // "ونص" / "and a half" and "الا ربع" / "quarter to".
    if (/(ونص|و نص|half)/.test(text)) minute = 30;
    else if (/(وربع|و ربع|quarter past)/.test(text)) minute = 15;
    else if (/(الا ربع|إلا ربع|quarter to)/.test(text)) {
      minute = 45;
      hour -= 1;
    }
  }
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (minute < 0 || minute > 59) return null;

  let period: "am" | "pm" | null = null;
  // Not `\bpm\b`: in "5pm" there is no word boundary between the digit and the
  // "p", so the obvious spelling of this test silently never matches. The
  // letter-lookaround pair is what distinguishes "5am" from "exam".
  if (/(?<![a-z])p\.?m\.?(?![a-z])/.test(text)) period = "pm";
  else if (/(?<![a-z])a\.?m\.?(?![a-z])/.test(text)) period = "am";
  else {
    for (const entry of ARABIC_MERIDIEM) {
      if (entry.words.some((word) => new RegExp(`(^|[^\\p{L}])${word}([^\\p{L}]|$)`, "u").test(text))) {
        period = entry.period;
        break;
      }
    }
  }

  if (explicit24) {
    if (hour > 23) return null;
    return { minutes: hour * 60 + minute, ambiguous: false };
  }
  if (hour < 1 || hour > 12) return null;
  if (period === "pm") return { minutes: ((hour % 12) + 12) * 60 + minute, ambiguous: false };
  if (period === "am") return { minutes: (hour % 12) * 60 + minute, ambiguous: false };
  // No period given: report the morning reading and say it is a guess.
  return { minutes: (hour % 12) * 60 + minute, ambiguous: true };
}

// ---------------------------------------------------------------------------
// Phones, names, and the other short fields
// ---------------------------------------------------------------------------

/**
 * A phone number the way people write it: Arabic digits, spaces, dashes,
 * parentheses, a leading `00`, or a bare local number.
 *
 * `country` is the clinic's, which is what makes `01001234567` resolvable at all.
 * Returns E.164 or null; `libphonenumber-js` does the validation, so this is a
 * normalizer rather than a second opinion about what a valid number is.
 */
export function parseHumanPhone(input: string, country: string): string | null {
  const text = normalizeDigits(input)
    .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, "")
    .replace(/[()\-.\s]/g, "")
    .replace(/^00/, "+")
    .trim();
  if (!/^\+?\d{6,20}$/.test(text)) return null;
  return normalizePhone(text, (country || "EG").toUpperCase());
}

/**
 * A person's name, reduced to something storable without changing it.
 *
 * Deliberately conservative: no case folding, no transliteration, no reordering.
 * An Arabic name is not improved by being title-cased, and a patient's own
 * spelling of their name is the correct one. Only invisible characters, digits
 * and stray punctuation are removed.
 */
export function parseHumanName(input: string): string | null {
  const cleaned = normalizeHumanText(input)
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/[0-9]/g, "")
    .replace(/[!@#$%^&*()_+=[\]{}|\\:;"<>,?/~`]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length < 2 || cleaned.length > 100) return null;
  // At least one letter, so "..." and "- -" are not names.
  if (!/\p{L}/u.test(cleaned)) return null;
  return cleaned;
}

/** A national/civil id: letters and digits, however the patient spaced it. */
export function parseNationalId(input: string): string | null {
  const cleaned = normalizeDigits(input).replace(/[\s\-_./]/g, "").trim();
  return /^[A-Za-z0-9]{5,32}$/.test(cleaned) ? cleaned : null;
}

/** An email address, with the spacing and casing people add to them. */
export function parseHumanEmail(input: string): string | null {
  const cleaned = normalizeHumanText(input)
    .replace(/\s+/g, "")
    .replace(/^mailto:/i, "")
    .toLowerCase();
  if (cleaned.length === 0 || cleaned.length > 320) return null;
  return /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(cleaned) ? cleaned : null;
}
