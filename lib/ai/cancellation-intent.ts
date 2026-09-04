/**
 * F-9 — "عايز ألغي معادي" is not the first rung of a booking.
 *
 * ## The defect this exists for
 *
 * The managed live acceptance run failed `cancellation-verified` and
 * `cancellation-verified#p3` with `never ran: list_my_appointments`, and the
 * reason is structural rather than a model lapse. A cancellation request
 * arrives on a thread that has collected nothing, so `nextBookingStep` returns
 * `department`, so `resolveBookingAuthority` resolved `needs_departments` and
 * **pinned `prepare_booking`** through `toolChoice` on the first step of the
 * turn. The one tool the turn actually needed — `list_my_appointments`, which
 * is mounted at every stage — was the one tool the server had made unreachable
 * on the step that mattered.
 *
 * The ladder is not wrong; it simply has no rung for "this message is not about
 * making an appointment, it is about an appointment that already exists". This
 * module is that reading, computed server-side from the patient's own words
 * before the ladder is consulted.
 *
 * ## What it decides, and what it emphatically does not
 *
 * It decides *which read the turn owes the patient*: their own upcoming
 * appointments, so the assistant can ask which one they mean. It does not
 * cancel anything, does not select an appointment, does not skip the
 * confirmation, and does not touch `cancel_my_appointment` — whose identity
 * checks, ownership check and confirmation requirement are unchanged and
 * continue to live in the tool and the RPC behind it. Reading a list is the
 * safest possible outcome of a misread: the worst case is that a patient who
 * meant something else is shown their own appointments.
 *
 * ## Shape only
 *
 * Nothing here names a clinic, a doctor, a department or an appointment.
 * `word()` uses Unicode lookarounds rather than `\b`, which is defined against
 * `[A-Za-z0-9_]` and therefore never exists between two Arabic letters — the
 * bug that made an earlier generation of Arabic patterns match nothing at all.
 *
 * Pure, so the production turn opener and the acceptance runner call the same
 * decision.
 */

const L = "(?<![\\p{L}\\p{N}])";
const R = "(?![\\p{L}\\p{N}])";
const word = (pattern: string): RegExp => new RegExp(`${L}(?:${pattern})${R}`, "iu");

/**
 * The verbs of cancelling, in Egyptian Arabic, Gulf Arabic, MSA, Arabizi and
 * English — with and without the definite article, and in the first person the
 * patient actually writes.
 */
const CANCEL_VERBS: readonly RegExp[] = [
  word("الغي|ألغي|الغى|ألغى|الغاء|إلغاء|الالغاء|الإلغاء|ملغي|نلغي|تلغي|يلغي|بلغي"),
  word("اكنسل|كنسل|كانسل"),
  word("اشيل|شيل|امسح|احذف|أحذف|احذفلي"),
  word("ابطل|أبطل|بطل"),
  /\bcancel(?:led|ling|lation)?\b/i,
  /\bcall\s*it\s*off\b/i,
  /\bdelete\s+(?:my\s+)?(?:appointment|booking|reservation)\b/i,
  /\b(?:elgh?[ai]|alghi|elgha|kansel|cancell?)\b/i,
];

/**
 * The nouns that make the verb about an appointment.
 *
 * Required alongside a verb for every shape except the ones where the verb
 * itself is unambiguous ("cancel my appointment" carries its own noun; a bare
 * "الغي" does not, and a patient cancelling a *question* rather than a booking
 * would be misread without this).
 */
const APPOINTMENT_NOUNS: readonly RegExp[] = [
  word("معاد|معادي|ميعاد|ميعادي|موعد|موعدي|مواعيدي|المعاد|الميعاد|الموعد"),
  word("حجز|حجزي|الحجز|حجزت|حجزته|الحجزه|الحجزة"),
  word("زيارة|زيارتي|الزيارة|كشف|الكشف|كشفي"),
  /\b(?:appointment|appt|booking|reservation|visit|slot)s?\b/i,
  /\b(?:m[ea]{1,2}ad|maw3ed|maw3ad|m3ad|hagz|7agz)\b/i,
];

/**
 * Shapes where the cancellation is stated whole, so no separate noun is needed.
 *
 * Kept explicit rather than loosening the verb-plus-noun rule, because
 * loosening it is how "الغي" in "الغي السؤال ده" becomes an appointment
 * cancellation.
 */
const SELF_CONTAINED: readonly RegExp[] = [
  /\bcancel\s+(?:my\s+|the\s+|that\s+|this\s+)?(?:appointment|appt|booking|reservation|visit)\b/i,
  /\b(?:i\s+)?(?:want|need|would\s+like)\s+to\s+cancel\b/i,
];

/**
 * Shapes that mention cancelling in order to ask *about* it rather than to ask
 * *for* it, and shapes that are explicitly about rescheduling instead.
 *
 * A reschedule is a different act with a different tool path, and reading it as
 * a cancellation would put the wrong question in front of the patient.
 */
const NOT_A_CANCELLATION: readonly RegExp[] = [
  /\b(?:policy|policies|fee|fees|charge|refund|rules?)\b/i,
  word("سياسة|رسوم|غرامة|شروط"),
  /\b(?:re-?schedul(?:e|ing)|postpone|move|change)\s+(?:my\s+)?(?:appointment|booking)\b/i,
  word("اجل|أجل|أأجل|اأجل|اجلها|اؤجل|أؤجل|تأجيل|التأجيل|اغير|أغير|غير\\s*الميعاد"),
];

export type CancellationIntent = {
  /** The patient is asking to cancel an existing appointment. */
  cancel: boolean;
  /** Which reading produced the decision. Labels only, for the audit trace. */
  reason: "self_contained" | "verb_and_noun" | "none" | "excluded";
};

/**
 * Does this message ask to cancel an existing appointment?
 *
 * Deliberately conservative in the "excluded" direction and deliberately
 * generous about *register*: the same request arrives as "عايز ألغي معادي",
 * "أبي ألغي موعدي", "أرغب في إلغاء الحجز", "3ayez alghi el maw3ad" and "I want
 * to cancel my appointment", and a suite that recognised one of them would be
 * measuring the phrase rather than the intent.
 */
export function detectCancellationIntent(
  value: string | null | undefined,
): CancellationIntent {
  const text = (value ?? "").trim();
  if (text.length === 0) return { cancel: false, reason: "none" };
  if (NOT_A_CANCELLATION.some((pattern) => pattern.test(text))) {
    return { cancel: false, reason: "excluded" };
  }
  if (SELF_CONTAINED.some((pattern) => pattern.test(text))) {
    return { cancel: true, reason: "self_contained" };
  }
  const hasVerb = CANCEL_VERBS.some((pattern) => pattern.test(text));
  if (!hasVerb) return { cancel: false, reason: "none" };
  const hasNoun = APPOINTMENT_NOUNS.some((pattern) => pattern.test(text));
  return hasNoun
    ? { cancel: true, reason: "verb_and_noun" }
    : { cancel: false, reason: "none" };
}

/** Convenience predicate for the call sites that only need the boolean. */
export function isCancellationRequest(value: string | null | undefined): boolean {
  return detectCancellationIntent(value).cancel;
}
