import {
  dateOrderForCountry,
  normalizeDigits,
  normalizeHumanText,
  parseDateOfBirth,
  parseHumanDate,
  parseHumanEmail,
  parseHumanName,
  parseHumanPhone,
  parseHumanTime,
  parseMonthName,
  parseNationalId,
  parseRelativeDay,
  type DateOrder,
} from "@/lib/ai/human-input";
import {
  readDayOfMonthReference,
  resolveUpcomingDayOfMonth,
} from "@/lib/ai/day-of-month";
import { patientFacingLabel } from "@/lib/ai/patient-intake-contract";

/**
 * P8B — understanding an answer that arrives in pieces.
 *
 * `human-input.ts` already reads one complete answer written any way a person
 * writes it. What it cannot do — because it is given one string and no memory —
 * is understand an answer *spread over several messages*, which is how people
 * actually reply on WhatsApp:
 *
 * ```
 *   patient   12/9/2000
 *   clinic    Do you mean September or December?
 *   patient   سبتمبر
 *   patient   نعم 2000
 * ```
 *
 * By the third line the value is fully determined — 12 September 2000 — and the
 * old behaviour was to ask a fourth time, because every tool call started from
 * nothing. That is the defect this module removes, and it removes it *generally*
 * rather than for dates: the same three-part shape (what is already established,
 * what is currently being clarified, what the patient just said) is what every
 * field the assistant collects needs.
 *
 * ## The model
 *
 * Three pieces of state, all normalized, all per-conversation:
 *
 *   * **collected** — values already established, in canonical form. Dates are
 *     `YYYY-MM-DD`, times are minutes past midnight, phones are E.164. The
 *     patient's own spelling is never kept.
 *   * **pending** — the single question currently outstanding, carrying the
 *     competing readings that made it necessary. There is at most one, because
 *     asking two things at once is how a conversation becomes a form.
 *   * **the current message** — passed through untouched by the model.
 *
 * ## The rules that do not bend
 *
 * **Never guess.** A fragment that leaves more than one reading alive returns
 * `ambiguous` again rather than picking. A fragment that matches none of them
 * returns `unresolved`, not the nearest one.
 *
 * **Never re-ask what is settled.** A value in `collected` is returned straight
 * back when the new message is an acknowledgement, a restatement, or a fragment
 * that agrees with it.
 *
 * **A contradiction is a question, not a merge.** "2000" after a date already
 * read as 1999 produces `conflict`, with both readings named, so the assistant
 * asks once. Silently taking either one is how a patient ends up with the wrong
 * date on their record.
 *
 * **This is not identity evidence.** Everything here is conversational memory.
 * `collected.date_of_birth` being present says the patient told us a date; it
 * says nothing about whether it is *their* date. Every identity decision still
 * runs through `verify_patient_conversation_dob` /
 * `stage_patient_intake_from_conversation`, still rate-limited, still failing
 * closed. Resolution happens strictly *before* those are called, so a value this
 * module could not resolve costs no verification attempt — and a value it did
 * resolve buys no verification either.
 */

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/**
 * The fields the assistant collects. Adding one is a matter of adding a parser
 * branch below; the state, persistence, merge and clarification machinery is
 * field-agnostic on purpose.
 */
export const SLOT_FIELDS = [
  "date_of_birth",
  "appointment_date",
  "appointment_time",
  "full_name",
  "phone",
  "national_id",
  "email",
  "gender",
  "blood_type",
  "department_id",
  "department_name",
  "doctor_id",
  "doctor_name",
] as const;

export type SlotField = (typeof SLOT_FIELDS)[number];

/** Canonical values only: `YYYY-MM-DD`, minutes past midnight, E.164, ... */
export type CollectedData = Partial<Record<SlotField, string | number>>;

/**
 * What is currently being asked about.
 *
 * `candidates` are the competing *canonical* readings, so a follow-up fragment
 * is matched against real values rather than re-parsed out of remembered text.
 * `partial` carries the components that were legible when the value itself was
 * not — "12/9" with no year, "at 5" with no am/pm.
 */
export type PendingClarification = {
  field: SlotField;
  kind: "which_reading" | "missing_component" | "which_meridiem";
  candidates: string[];
  partial?: { day?: number; month?: number; year?: number; hour?: number; minute?: number };
  askedAt: string;
};

export type FieldResolution =
  | { status: "resolved"; field: SlotField; value: string | number; fromMemory: boolean }
  | {
      status: "ambiguous";
      field: SlotField;
      candidates: string[];
      pending: PendingClarification;
    }
  | {
      status: "incomplete";
      field: SlotField;
      missing: "year" | "meridiem";
      pending: PendingClarification;
    }
  | {
      status: "conflict";
      field: SlotField;
      established: string | number;
      offered: string | number;
    }
  | { status: "unresolved"; field: SlotField; reason: UnresolvedReason };

export type UnresolvedReason =
  | "empty"
  | "unrecognized"
  | "impossible_date"
  | "out_of_range"
  /**
   * P12 — the message named a *boundary* ("بعد يوم ٨"), not a day. Deliberately
   * its own reason rather than `unrecognized`: nothing failed to parse, and the
   * caller's next move is an availability search after that day rather than
   * another question about which day the patient meant.
   */
  | "date_boundary"
  | "clarification_unmatched";

export type ResolveOptions = {
  field: SlotField;
  /** The patient's words for this turn, exactly as they wrote them. */
  raw: string;
  collected: CollectedData;
  pending: PendingClarification | null;
  /** The clinic's country, which decides `12/9` and normalizes a local number. */
  country?: string | null;
  timeZone?: string | null;
  now?: Date;
  /**
   * P10 — the days this conversation was actually shown, `YYYY-MM-DD`.
   *
   * Only ever read for `appointment_date`, and only ever to disambiguate: a
   * bare "28" is not a date and this module will not invent one, but if the
   * server put exactly one day ending in 28 in front of this patient a moment
   * ago, "28" is that day and asking which year they meant is absurd. Matching
   * two offered days resolves nothing and falls through to the ordinary
   * question. Never used for `date_of_birth`: a birthday has no offer list and
   * nothing about a booking may inform an identity value.
   */
  offeredDays?: readonly string[];
};

// ---------------------------------------------------------------------------
// Reading state off the wire
// ---------------------------------------------------------------------------

const SLOT_FIELD_SET = new Set<string>(SLOT_FIELDS);

/**
 * Rebuilds collected state from the jsonb column, field by field.
 *
 * Nothing is passed through. The column is written only by this application, but
 * it is also the one place a malformed value could survive a deploy and reach a
 * date comparison, so an unknown key, a wrong type or an out-of-shape date is
 * dropped rather than trusted.
 */
export function parseCollectedData(value: unknown): CollectedData {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: CollectedData = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!SLOT_FIELD_SET.has(key)) continue;
    const field = key as SlotField;
    if (field === "appointment_time") {
      if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw < 1440) {
        out[field] = raw;
      }
      continue;
    }
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (trimmed.length === 0 || trimmed.length > 320) continue;
    if (
      (field === "date_of_birth" || field === "appointment_date") &&
      !/^\d{4}-\d{2}-\d{2}$/.test(trimmed)
    ) {
      continue;
    }
    out[field] = trimmed;
  }
  return out;
}

export function parsePendingClarification(value: unknown): PendingClarification | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const field = typeof raw.field === "string" ? raw.field : "";
  if (!SLOT_FIELD_SET.has(field)) return null;
  const kind = raw.kind;
  if (kind !== "which_reading" && kind !== "missing_component" && kind !== "which_meridiem") {
    return null;
  }
  const candidates = Array.isArray(raw.candidates)
    ? raw.candidates
        .filter((item): item is string => typeof item === "string" && item.length > 0)
        .slice(0, 4)
    : [];
  const partialRaw =
    raw.partial && typeof raw.partial === "object" && !Array.isArray(raw.partial)
      ? (raw.partial as Record<string, unknown>)
      : null;
  const partial = partialRaw
    ? {
        ...(Number.isInteger(partialRaw.day) ? { day: partialRaw.day as number } : {}),
        ...(Number.isInteger(partialRaw.month) ? { month: partialRaw.month as number } : {}),
        ...(Number.isInteger(partialRaw.year) ? { year: partialRaw.year as number } : {}),
        ...(Number.isInteger(partialRaw.hour) ? { hour: partialRaw.hour as number } : {}),
        ...(Number.isInteger(partialRaw.minute) ? { minute: partialRaw.minute as number } : {}),
      }
    : undefined;
  return {
    field: field as SlotField,
    kind,
    candidates,
    ...(partial && Object.keys(partial).length > 0 ? { partial } : {}),
    askedAt: typeof raw.askedAt === "string" ? raw.askedAt : new Date(0).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Fragments
// ---------------------------------------------------------------------------

/**
 * "Yes", in the forms patients actually send.
 *
 * An affirmation on its own carries no new information — it confirms whatever
 * was last proposed. It is listed rather than inferred because treating an
 * unrecognised word as agreement is the one direction this must never fail in.
 */
const AFFIRMATIONS = [
  "yes", "yeah", "yep", "yup", "correct", "right", "exactly", "true", "ok", "okay", "sure",
  "نعم", "ايوه", "ايوة", "أيوه", "أيوة", "اه", "أه", "تمام", "صح", "صحيح", "مضبوط", "بالظبط", "اكيد", "أكيد",
];

const NEGATIONS = [
  "no", "nope", "not", "wrong", "incorrect",
  "لا", "لأ", "مش", "غلط", "خطا", "خطأ", "ليس",
];

function isAffirmation(text: string): boolean {
  const words = text.split(/[^\p{L}]+/u).filter(Boolean);
  if (words.length === 0) return false;
  if (words.some((word) => NEGATIONS.includes(word))) return false;
  return words.some((word) => AFFIRMATIONS.includes(word));
}

function isNegation(text: string): boolean {
  const words = text.split(/[^\p{L}]+/u).filter(Boolean);
  return words.some((word) => NEGATIONS.includes(word));
}

/**
 * What a short follow-up message actually says, when it is not a whole answer.
 *
 * Numbers are classified by magnitude rather than by position, because a
 * fragment has no position: a bare `2000` is a year, a bare `9` in answer to a
 * month question is a month, and `12` could be either — which is precisely why
 * every consumer below checks it against the *candidates* rather than acting on
 * it alone.
 */
type Fragment = {
  month: number | null;
  year: number | null;
  day: number | null;
  affirmation: boolean;
  negation: boolean;
  /** True when the message contains nothing but agreement/refusal words. */
  bare: boolean;
};

function readFragment(raw: string): Fragment {
  const text = normalizeHumanText(raw).toLowerCase();
  const month = parseMonthName(text);
  const numbers = (normalizeDigits(text).match(/\d{1,4}/g) ?? []).map(Number);
  const year = numbers.find((value) => value >= 1900 && value <= 2200) ?? null;
  const smalls = numbers.filter((value) => value !== year && value >= 1 && value <= 31);
  return {
    month: month ?? (smalls.find((value) => value >= 1 && value <= 12) ?? null),
    year,
    day: smalls.find((value) => value >= 1 && value <= 31) ?? null,
    affirmation: isAffirmation(text),
    negation: isNegation(text),
    bare: numbers.length === 0 && month === null,
  };
}

const monthOf = (isoDate: string) => Number(isoDate.slice(5, 7));
const dayOf = (isoDate: string) => Number(isoDate.slice(8, 10));
const yearOf = (isoDate: string) => Number(isoDate.slice(0, 4));

// ---------------------------------------------------------------------------
// The resolver
// ---------------------------------------------------------------------------

/**
 * Turns whatever the patient just said, plus what is already known, into a
 * canonical value — or into exactly one question.
 *
 * The order of the branches is the whole design:
 *
 *   1. **A complete answer wins outright.** Someone who rewrites the value has
 *      corrected themselves, and a fresh unambiguous reading replaces both the
 *      pending question and any earlier value.
 *   2. **Otherwise, resolve against the outstanding question.** This is the
 *      "سبتمبر" case: not a date, but a decisive answer to the one that was
 *      asked.
 *   3. **Otherwise, check what is already established.** This is the "نعم 2000"
 *      case: nothing new, and nothing to ask.
 *   4. **Only then give up**, naming why.
 */
export function resolveField(options: ResolveOptions): FieldResolution {
  const { field, raw, collected, pending } = options;
  const now = options.now ?? new Date();
  const order: DateOrder = dateOrderForCountry(options.country);
  const text = normalizeHumanText(raw ?? "");
  if (text.length === 0) {
    // An empty turn cannot contradict anything, so an established value stands.
    const established = collected[field];
    if (established !== undefined) {
      return { status: "resolved", field, value: established, fromMemory: true };
    }
    return { status: "unresolved", field, reason: "empty" };
  }

  const relevantPending = pending && pending.field === field ? pending : null;

  switch (field) {
    case "date_of_birth":
    case "appointment_date":
      return resolveDate({ ...options, now, order, text, pending: relevantPending });
    case "appointment_time":
      return resolveTime({ ...options, text, pending: relevantPending });
    case "full_name":
      return resolveSimple(field, parseHumanName(raw), collected, "unrecognized");
    case "national_id":
      return resolveSimple(field, parseNationalId(raw), collected, "unrecognized");
    case "email":
      return resolveSimple(field, parseHumanEmail(raw), collected, "unrecognized");
    case "phone":
      return resolveSimple(
        field,
        parseHumanPhone(raw, (options.country ?? "EG").toUpperCase()),
        collected,
        "unrecognized",
      );
    case "gender":
      return resolveSimple(field, parseGender(text), collected, "unrecognized");
    case "blood_type":
      return resolveSimple(field, parseBloodType(text), collected, "unrecognized");
    case "department_id":
    case "doctor_id":
      return resolveSimple(
        field,
        /^[0-9a-f]{8}-[0-9a-f-]{28}$/i.test(text) ? text.toLowerCase() : null,
        collected,
        "unrecognized",
      );
    case "department_name":
    case "doctor_name":
      return resolveSimple(field, parseHumanName(raw), collected, "unrecognized");
  }
}

/**
 * The fields with exactly one reading or none.
 *
 * They still need the memory branch — a patient who repeats their name should
 * not be asked for it again — and they still need the conflict branch, because
 * "actually, it's Ahmad not Ahmed" is a correction the assistant must notice
 * rather than silently keep the first of.
 */
function resolveSimple(
  field: SlotField,
  parsed: string | null,
  collected: CollectedData,
  reason: UnresolvedReason,
): FieldResolution {
  const established = collected[field];
  if (parsed === null) {
    if (established !== undefined) {
      return { status: "resolved", field, value: established, fromMemory: true };
    }
    return { status: "unresolved", field, reason };
  }
  if (established !== undefined && established !== parsed) {
    // A freshly readable value for a field that already had one is a
    // correction, and corrections are the patient's to make: take the new one.
    // (Dates are the exception — see resolveDate — because there the two
    // readings may be the *same* utterance read two ways.)
    return { status: "resolved", field, value: parsed, fromMemory: false };
  }
  return { status: "resolved", field, value: parsed, fromMemory: established !== undefined };
}

/**
 * A blood type, in the forms people write it.
 *
 * "O+", "o positive", "او بوجيتيف", "زمرة O موجب". The enum the database stores
 * is eight values, so this is a recogniser rather than a parser: it either
 * finds one of the eight or returns null, and a null simply means the assistant
 * asks once more or moves on — blood type is optional on the patient file and
 * an intake must never be blocked by it.
 */
const BLOOD_GROUPS: readonly string[] = ["ab", "a", "b", "o"];

function parseBloodType(text: string): string | null {
  const normalized = text
    .toLocaleLowerCase("en")
    // Arabic and English words for the sign, and the Arabic "او" for O.
    .replace(/(?:positive|\+ve|موجب|بوزيتيف|بوجيتيف)/g, "+")
    .replace(/(?:negative|-ve|سالب|نيجاتيف|نيجيتيف)/g, "-")
    // Arabic spellings of the group letters themselves. "بي سالب" is B-, and a
    // patient typing it is not writing English.
    .replace(/(?:ايه\s*بي|أيه\s*بي|ا\s*ب)/g, " ab ")
    .replace(/(?:^|[^a-z])(?:او|أو|o)(?![a-z])/g, " o ")
    .replace(/(?:^|[^a-z])(?:بي|ب)(?![a-z])/g, " b ")
    .replace(/(?:^|[^a-z])(?:ايه|أيه)(?![a-z])/g, " a ")
    .replace(/[^a-z+-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // "ab" before "a" and "b": otherwise "ab+" reads as "a".
  for (const group of BLOOD_GROUPS) {
    const match = new RegExp(`(?:^|[^a-z])${group}\\s*([+-])`).exec(normalized);
    if (match) return `${group.toUpperCase()}${match[1]}`;
  }
  return null;
}

function parseGender(text: string): string | null {
  if (/(^|[^\p{L}])(male|man|boy|ذكر|رجل|ولد)([^\p{L}]|$)/u.test(text)) return "male";
  if (/(^|[^\p{L}])(female|woman|girl|انثى|أنثى|امراة|امرأة|بنت|ست)([^\p{L}]|$)/u.test(text)) {
    return "female";
  }
  return null;
}

/**
 * The year a patient means by "28 August" or "يوم 28 أغسطس".
 *
 * Nobody books last year. The clinic-local today decides: a day/month that has
 * not passed yet is this year, one that has is next year. This is inference from
 * the calendar, not a guess about the patient — which is why it is confined to
 * `appointment_date` and never touches a date of birth, where the equivalent
 * shortcut would be a fabricated identity value.
 */
function inferAppointmentYear(
  day: number,
  month: number,
  now: Date,
  timeZone: string,
): number | null {
  const localToday = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const year = Number(localToday.slice(0, 4));
  if (!Number.isInteger(year)) return null;
  const candidate = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  if (!isRealCalendarDate(year, month, day)) {
    // 29 February of a non-leap year: the patient means the next leap year, not
    // a date that does not exist.
    return isRealCalendarDate(year + 1, month, day) ? year + 1 : null;
  }
  if (candidate >= localToday) return year;
  return isRealCalendarDate(year + 1, month, day) ? year + 1 : null;
}

function isRealCalendarDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

type DateArgs = ResolveOptions & {
  now: Date;
  order: DateOrder;
  text: string;
  pending: PendingClarification | null;
};

function resolveDate(args: DateArgs): FieldResolution {
  const { field, raw, collected, pending, now, order, text } = args;
  const established = collected[field];
  const establishedIso = typeof established === "string" ? established : null;

  // ---- 1. A complete, self-contained date -------------------------------
  //
  // Appointment dates additionally accept "tomorrow"/"بكرا", which are complete
  // answers even though they contain no numbers at all.
  if (field === "appointment_date") {
    const relative = parseRelativeDay(raw, { now, timeZone: args.timeZone ?? "UTC" });
    if (relative) {
      return { status: "resolved", field, value: relative, fromMemory: false };
    }
  }
  const parsed =
    field === "date_of_birth"
      ? parseDateOfBirth(raw, { order, now })
      : parseHumanDate(raw, { order, now, minYear: now.getUTCFullYear() - 1 });

  if (parsed.ok && !parsed.ambiguous) {
    return { status: "resolved", field, value: parsed.iso, fromMemory: false };
  }
  if (parsed.ok && parsed.ambiguous && parsed.alternativeIso) {
    const candidates = [parsed.iso, parsed.alternativeIso];
    // The patient may have re-sent the same ambiguous date after being asked.
    // Asking the identical question again is the loop this module exists to
    // break — but there is genuinely nothing else to do with two live readings,
    // so the question is re-issued rather than one being picked.
    return {
      status: "ambiguous",
      field,
      candidates,
      pending: {
        field,
        kind: "which_reading",
        candidates,
        askedAt: now.toISOString(),
      },
    };
  }

  const fragment = readFragment(raw);

  // ---- 1a-bis. A boundary is not an answer -------------------------------
  //
  // "بعد يوم ٨" names a day the patient will *not* come on or before. Every
  // reader below is looking for a day the patient chose, and each of them has a
  // way to find one in that sentence: the offer reader matches the 8th if it
  // happens to have been offered, the bare-day reader returns the 8th, and the
  // day/month fragment reader — which is what manual QA actually hit — reads
  // the single number as both and lands on a date a year away. None of those is
  // what the patient said. The message is a lower bound and belongs to
  // `list_available_days`, which searches after it and offers real days.
  if (field === "appointment_date" && readDayOfMonthReference(raw)?.boundary === true) {
    return { status: "unresolved", field, reason: "date_boundary" };
  }

  // ---- 1b. A day the server just offered ---------------------------------
  //
  // "طيب يوم 28؟" answering a list of real days. A bare day is not a date and
  // the parser above correctly refuses to make one up — but the server put
  // these exact days in front of this patient on the previous turn, so if the
  // number selects exactly one of them there is nothing left to ask about.
  // Two matches (the 28th of this month and of the next, both offered) select
  // nothing and fall through to the ordinary question.
  if (field === "appointment_date" && args.offeredDays && args.offeredDays.length > 0) {
    const offered = resolveDayFromOffers(args.offeredDays, text, fragment);
    if (offered) {
      return { status: "resolved", field, value: offered, fromMemory: false };
    }
  }

  // ---- 1c. A bare day of the month --------------------------------------
  //
  // "يوم 16 الجاي" names a day and no month, which the parser above correctly
  // refuses to complete and the offer reader above can only answer when the
  // server happened to have listed that exact day. Neither held for the real
  // QA thread, so the day resolved to nothing at all. There is only one
  // sensible reading of a bare day — the next time that number comes round —
  // and `day-of-month.ts` produces it from the clinic's own calendar. An
  // explicit day marker is required, so a bare "16" is still nobody's day.
  if (field === "appointment_date") {
    const upcoming = resolveUpcomingDayOfMonth(raw, {
      now,
      timeZone: args.timeZone ?? "UTC",
    });
    if (upcoming) {
      return { status: "resolved", field, value: upcoming, fromMemory: false };
    }
  }

  // ---- 2. Answer to the outstanding question ----------------------------
  if (pending) {
    if (pending.kind === "which_reading" && pending.candidates.length > 0) {
      const matched = pending.candidates.filter((candidate) => {
        if (fragment.month !== null && monthOf(candidate) === fragment.month) return true;
        // A bare day only discriminates when it is not also a plausible month —
        // otherwise "12" for `12/9` vs `9/12` matches both, which is no answer.
        if (
          fragment.month === null &&
          fragment.day !== null &&
          dayOf(candidate) === fragment.day
        ) {
          return true;
        }
        return false;
      });
      if (matched.length === 1) {
        if (fragment.year !== null && yearOf(matched[0]!) !== fragment.year) {
          return { status: "conflict", field, established: matched[0]!, offered: fragment.year };
        }
        return { status: "resolved", field, value: matched[0]!, fromMemory: false };
      }
      if (matched.length > 1) {
        return { status: "ambiguous", field, candidates: matched, pending };
      }
      // Agreement with no discriminator confirms the reading that was offered
      // first, which is the one the clinic's own convention prefers and the one
      // the assistant will have named first.
      if (fragment.affirmation && !fragment.negation && fragment.month === null) {
        const first = pending.candidates[0]!;
        if (fragment.year !== null && yearOf(first) !== fragment.year) {
          return { status: "conflict", field, established: first, offered: fragment.year };
        }
        return { status: "resolved", field, value: first, fromMemory: false };
      }
      // "No" rules out the reading that was offered first.
      if (fragment.negation && pending.candidates.length === 2) {
        return { status: "resolved", field, value: pending.candidates[1]!, fromMemory: false };
      }
      return { status: "unresolved", field, reason: "clarification_unmatched" };
    }

    if (pending.kind === "missing_component" && pending.partial) {
      const year = fragment.year ?? null;
      const day = pending.partial.day ?? fragment.day ?? null;
      const month = pending.partial.month ?? fragment.month ?? null;
      if (year !== null && day !== null && month !== null) {
        const completed = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
        const verified =
          field === "date_of_birth"
            ? parseDateOfBirth(completed, { order, now })
            : parseHumanDate(completed, { order, now });
        if (!verified.ok) return { status: "unresolved", field, reason: verified.reason };
        return { status: "resolved", field, value: verified.iso, fromMemory: false };
      }
      return {
        status: "incomplete",
        field,
        missing: "year",
        pending: { ...pending, partial: { ...pending.partial, ...(day !== null ? { day } : {}), ...(month !== null ? { month } : {}) } },
      };
    }
  }

  // ---- 3. Nothing new: is it already settled? ---------------------------
  if (establishedIso) {
    // A fragment that agrees with what is on file — the "نعم 2000" line — is a
    // confirmation. Nothing is asked, and the established value is returned.
    const agrees =
      fragment.bare ||
      (fragment.affirmation && fragment.month === null && fragment.year === null) ||
      (fragment.year !== null && fragment.year === yearOf(establishedIso)) ||
      (fragment.month !== null && fragment.month === monthOf(establishedIso));
    if (agrees && !fragment.negation) {
      return { status: "resolved", field, value: establishedIso, fromMemory: true };
    }
    // A fragment that disagrees is a correction the assistant must confirm
    // rather than apply — one wrong digit in a date of birth is an identity
    // failure, not a typo to smooth over.
    if (fragment.year !== null && fragment.year !== yearOf(establishedIso)) {
      return { status: "conflict", field, established: establishedIso, offered: fragment.year };
    }
    if (fragment.month !== null && fragment.month !== monthOf(establishedIso)) {
      return { status: "conflict", field, established: establishedIso, offered: fragment.month };
    }
    return { status: "resolved", field, value: establishedIso, fromMemory: true };
  }

  // ---- 4. A day and a month with no year --------------------------------
  //
  // "12/9" is not a failure, it is three quarters of an answer. Asked for the
  // missing piece, it completes on the next message.
  //
  // For an appointment the year is not missing information at all — it is the
  // calendar's to supply. "يوم 28" and "28 أغسطس" mean the next 28 August that
  // has not happened yet, and asking a patient which year they are booking in
  // is the kind of question that makes an assistant feel like a form. A date of
  // birth keeps the question, because there the year carries the whole meaning
  // and inferring it would be inventing an identity value.
  const missingYear = (day: number, month: number): FieldResolution => {
    if (field === "appointment_date") {
      const year = inferAppointmentYear(day, month, now, args.timeZone ?? "UTC");
      if (year !== null) {
        const completed = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
        const verified = parseHumanDate(completed, { order, now });
        if (verified.ok) {
          return { status: "resolved", field, value: verified.iso, fromMemory: false };
        }
      }
    }
    return {
      status: "incomplete",
      field,
      missing: "year",
      pending: {
        field,
        kind: "missing_component",
        candidates: [],
        partial: { day, month },
        askedAt: now.toISOString(),
      },
    };
  };

  const twoPart = /^(\d{1,2})\s*[-/.,، ]\s*(\d{1,2})$/.exec(normalizeDigits(text));
  if (twoPart) {
    const first = Number(twoPart[1]);
    const second = Number(twoPart[2]);
    const day = order === "dmy" ? first : second;
    const month = order === "dmy" ? second : first;
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return missingYear(day, month);
    }
  }
  if (fragment.month !== null && fragment.day !== null && fragment.year === null) {
    return missingYear(fragment.day, fragment.month);
  }

  return {
    status: "unresolved",
    field,
    reason: parsed.ok ? "unrecognized" : parsed.reason,
  };
}

/**
 * Which offered day a short reply selects, or null.
 *
 * Reads only the days the server itself offered, so it can never turn a number
 * into a day nobody mentioned. An exact ISO match wins; otherwise a single bare
 * number that is the day-of-month of exactly one offered day is that day. A
 * message carrying two numbers is a date ("24/9") and belongs to the parser.
 */
function resolveDayFromOffers(
  offeredDays: readonly string[],
  text: string,
  fragment: Fragment,
): string | null {
  const trimmed = text.trim();
  if (offeredDays.includes(trimmed)) return trimmed;
  if (fragment.negation) return null;
  const digits = normalizeDigits(trimmed).match(/\d{1,2}/g);
  if (!digits || digits.length !== 1) return null;
  const day = Number(digits[0]);
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;
  const matches = offeredDays.filter((iso) => Number(iso.slice(8, 10)) === day);
  return matches.length === 1 ? matches[0]! : null;
}

function resolveTime(
  args: ResolveOptions & { text: string; pending: PendingClarification | null },
): FieldResolution {
  const { field, raw, collected, pending } = args;
  const established = collected[field];
  const parsed = parseHumanTime(raw);
  const fragment = readFragment(raw);

  // A pending meridiem question that the patient has now answered: "مساء",
  // "pm", "in the morning". The hour came from the earlier message.
  if (pending?.kind === "which_meridiem" && pending.partial?.hour !== undefined) {
    const hour = pending.partial.hour;
    const minute = pending.partial.minute ?? 0;
    const meridiem = readMeridiem(args.text);
    if (meridiem) {
      const hour12 = hour % 12;
      return {
        status: "resolved",
        field,
        value: (meridiem === "pm" ? hour12 + 12 : hour12) * 60 + minute,
        fromMemory: false,
      };
    }
    if (parsed && !parsed.ambiguous) {
      return { status: "resolved", field, value: parsed.minutes, fromMemory: false };
    }
    return { status: "unresolved", field, reason: "clarification_unmatched" };
  }

  if (parsed && !parsed.ambiguous) {
    return { status: "resolved", field, value: parsed.minutes, fromMemory: false };
  }
  if (parsed && parsed.ambiguous) {
    const hour = Math.floor(parsed.minutes / 60);
    const minute = parsed.minutes % 60;
    return {
      status: "incomplete",
      field,
      missing: "meridiem",
      pending: {
        field,
        kind: "which_meridiem",
        candidates: [String(parsed.minutes), String(((hour % 12) + 12) * 60 + minute)],
        partial: { hour, minute },
        askedAt: (args.now ?? new Date()).toISOString(),
      },
    };
  }
  if (established !== undefined && !fragment.negation) {
    return { status: "resolved", field, value: established, fromMemory: true };
  }
  return { status: "unresolved", field, reason: "unrecognized" };
}

function readMeridiem(text: string): "am" | "pm" | null {
  if (/(?<![a-z])p\.?m\.?(?![a-z])/.test(text)) return "pm";
  if (/(?<![a-z])a\.?m\.?(?![a-z])/.test(text)) return "am";
  if (/(^|[^\p{L}])(مساء|مساءا|بالليل|الليل|ظهرا|الظهر|العصر|عصرا|م)([^\p{L}]|$)/u.test(text)) {
    return "pm";
  }
  if (/(^|[^\p{L}])(صباحا|صباح|الصبح|ص)([^\p{L}]|$)/u.test(text)) return "am";
  return null;
}

// ---------------------------------------------------------------------------
// What the model is told
// ---------------------------------------------------------------------------

const MONTH_NAMES_EN = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * The clarification the assistant should ask, in words rather than in formats.
 *
 * Returned as guidance for the model, not as copy to send verbatim: the
 * assistant writes in the patient's language and register, and a canned string
 * in the wrong one is worse than no string. What this pins down is *what to
 * ask* and, more importantly, what not to — no format specification ever
 * reaches a patient.
 */
export function clarificationGuidance(resolution: FieldResolution): string | null {
  if (resolution.status === "ambiguous") {
    const months = [...new Set(resolution.candidates.map((iso) => MONTH_NAMES_EN[monthOf(iso) - 1]))];
    return (
      `That date could mean ${months.join(" or ")}. Ask the patient which month they meant, ` +
      "naming the months in words in their own language. Ask once, do not name a date format, " +
      "and do not repeat anything they have already told you."
    );
  }
  if (resolution.status === "incomplete") {
    return resolution.missing === "year"
      ? "The day and month are clear but the year is missing. Ask only for the year."
      : "The hour is clear but not whether it is morning or evening. Ask only that.";
  }
  if (resolution.status === "conflict") {
    return (
      "This contradicts what the patient said earlier. Ask them once, plainly, which is correct — " +
      "do not choose one yourself and do not accuse them of a mistake."
    );
  }
  if (resolution.status === "unresolved") {
    return resolution.reason === "clarification_unmatched"
      ? "That did not answer the question that was asked. Ask it once more, more simply, " +
          "and do not name a format."
      : "That did not read as a valid answer. Ask once, conversationally, in ordinary words — " +
          "do not name a format and do not quote one back to the patient.";
  }
  return null;
}

/**
 * The one-line summary of established state handed to the model each turn.
 *
 * Explicitly framed as "already known — do not ask again", because the failure
 * being fixed is an assistant that had the answer and asked anyway.
 */
export function describeCollectedData(collected: CollectedData): string | null {
  const entries = Object.entries(collected).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return null;
  // P11J-2 — labels, not schema keys, even here. This string goes into the
  // model's prompt, and every raw identifier put in front of a model is one it
  // can echo. The Arabic branch of the briefing has always used labels; this is
  // the English one catching up.
  const parts = entries.map(([key, value]) => {
    const label = patientFacingLabel(key, "en");
    if (key === "appointment_time" && typeof value === "number") {
      const hour = Math.floor(value / 60);
      const minute = value % 60;
      return `${label}: ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    }
    return `${label}: ${String(value)}`;
  });
  return (
    `Already established in this conversation — do not ask for any of it again: ${parts.join("; ")}. ` +
    "These are values the patient supplied; they are not proof of who the patient is."
  );
}
