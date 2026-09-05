/**
 * F-2 / F-6 — reading the patient's answer against the offer the server made,
 * as one pure decision both the production turn opener and the acceptance
 * runner call.
 *
 * ## Why it is its own module
 *
 * The pre-commit existed twice: once in `booking-stage-store.ts`
 * (`commitLatestOfferedSelection`, the production path) and once in the
 * acceptance runner. Two copies of a decision are two decisions, and the
 * acceptance pass found the seam — the production copy computed
 * `resolveOfferedDoctor`'s `ambiguous` verdict and threw it away
 * (`if (resolution.status !== "resolved") return identity;`), so the server
 * knew the answer was ambiguous and had nowhere to put that knowledge.
 *
 * This module is that decision, stated once. It is **pure** and **closed-world**
 * in exactly the sense `offered-doctor-resolution.ts` is: it takes the offer as
 * an argument and returns a member of it, an explicit question about members of
 * it, or nothing. There is no database handle, no clinic id and no directory
 * load, so no code path through here can name a doctor, a day or a time the
 * server did not already put in front of this patient.
 *
 * ## The four answers, and why "unresolved" is not "skip"
 *
 * `skip` means *this message is not an answer to the offer* — a question, a
 * closing, a paragraph. Nothing should change.
 *
 * `unresolved` means *this message is shaped like an answer and the server
 * could read nothing from it*. That is the F-6 deadlock: at the day and time
 * steps a still-valid offer made the authority report `satisfied`, so nothing
 * was pinned, so the turn produced no tool call, no clarification and no
 * sentence. The distinction is what lets the authority re-state the offer
 * instead of going silent.
 */

import {
  candidateClockTimes,
  resolveOfferedDay,
  resolveOfferedTime,
  resolveOrdinalOfferedDay,
  type BookingStageState,
  type BookingStep,
  type PendingSelection,
} from "@/lib/ai/booking-stage";
import { readDayOfMonthReference } from "@/lib/ai/day-of-month";
import { resolveOfferedDoctor } from "@/lib/ai/offered-doctor-resolution";
import type { NamedEntity } from "@/lib/ai/entity-resolution";

export type OfferedSelectionOutcome =
  /** Exactly one offered doctor was chosen. */
  | { status: "doctor"; doctor: NamedEntity }
  /** Exactly one offered day was chosen, `YYYY-MM-DD`. */
  | { status: "day"; date: string }
  /** Exactly one offered slot was chosen, `HH:mm`. */
  | { status: "time"; time: string }
  /** More than one offered option fits. The server owes a question. */
  | { status: "ambiguous"; field: "doctor"; candidates: readonly NamedEntity[] }
  /** Shaped like an answer; nothing in the offer matched it. */
  | { status: "unresolved" }
  /** Not an answer to the offer at all. */
  | { status: "skip" };

/**
 * Is this message short enough, and declarative enough, to be a selection?
 *
 * Unchanged from the production pre-commit it replaces: a question is not a
 * selection, and neither is a paragraph.
 */
export function looksLikeChoiceAnswer(value: string | null | undefined): boolean {
  const text = (value ?? "").trim();
  if (!text || text.length > 100 || /[?؟]/.test(text)) return false;
  return text.split(/\s+/u).length <= 10;
}

export type OfferedSelectionInput = {
  step: BookingStep;
  patientText: string | null | undefined;
  state: BookingStageState;
  /**
   * The offered roster, in the order it was presented, already narrowed to the
   * doctors who are still bookable. Empty at every step but `doctor`.
   */
  offeredDoctors: readonly NamedEntity[];
  /** The date this booking currently holds, for the time step. */
  appointmentDate: string | null;
  /**
   * The caller's own extra day reader, tried only after the offered-day passes
   * have failed and required to return a day *from the offered list*.
   *
   * This is where `resolveField`'s conversational date parsing plugs in for the
   * production path. It is optional because it needs a clinic country and
   * timezone, which a pure module has no business holding.
   */
  extraDayResolver?: (text: string) => string | null;
};

export function resolveOfferedSelection(
  input: OfferedSelectionInput,
): OfferedSelectionOutcome {
  if (!looksLikeChoiceAnswer(input.patientText)) return { status: "skip" };
  const text = input.patientText!.trim();
  const { state } = input;

  if (input.step === "doctor") {
    if (input.offeredDoctors.length === 0) return { status: "skip" };
    // F-2 — after a clarification, the question that was actually asked is the
    // one being answered. "الأول" means the first of the two names the patient
    // just read, not the first of the whole roster, so the pending candidates
    // are tried first and the full offer only if they yield nothing.
    const pending = state.pendingSelection;
    if (pending && pending.field === "doctor" && pending.candidates.length > 1) {
      const narrowed = resolveOfferedDoctor({
        patientText: text,
        offered: pending.candidates,
      });
      if (narrowed.status === "resolved") {
        return { status: "doctor", doctor: narrowed.doctor };
      }
    }
    const resolution = resolveOfferedDoctor({
      patientText: text,
      offered: input.offeredDoctors,
    });
    if (resolution.status === "resolved") {
      return { status: "doctor", doctor: resolution.doctor };
    }
    if (resolution.status === "ambiguous") {
      return {
        status: "ambiguous",
        field: "doctor",
        candidates: resolution.candidates,
      };
    }
    // "دكتور احم" is ambiguous; "عايز احجز مع دكتور احم" scored so low against
    // every name that it came back `not_found`, and the ambiguity — the whole
    // reason this patient needs a question — was lost to the request frame
    // wrapped around the name. Retried with that frame removed, and only when
    // the first pass has already failed, so nothing that resolves today can
    // change its answer.
    const bare = stripRequestFrame(text);
    if (bare && bare !== text) {
      const retry = resolveOfferedDoctor({
        patientText: bare,
        offered: input.offeredDoctors,
      });
      if (retry.status === "resolved") return { status: "doctor", doctor: retry.doctor };
      if (retry.status === "ambiguous") {
        return { status: "ambiguous", field: "doctor", candidates: retry.candidates };
      }
    }
    return { status: "unresolved" };
  }

  if (input.step === "day") {
    if (state.offeredDays.length === 0) return { status: "skip" };
    const direct = resolveOfferedDay(state, text);
    if (direct) return { status: "day", date: direct };
    // F-6 — "أول يوم متاح" / "the first available day".
    const ordinal = resolveOrdinalOfferedDay(state, text);
    if (ordinal) return { status: "day", date: ordinal };
    const extra = input.extraDayResolver?.(text) ?? null;
    if (extra && state.offeredDays.includes(extra)) {
      return { status: "day", date: extra };
    }
    return { status: "unresolved" };
  }

  if (input.step === "time") {
    const date = input.appointmentDate;
    if (!date) return { status: "skip" };
    // A day correction arriving at the time rung.
    //
    // "لا قصدي يوم ١٠" is the patient changing the *day*, and the bare "١٠" in
    // it read as an hour: the pre-commit committed 10:00 on the day they had
    // just rejected, the ladder moved to `confirm`, and the booking went in.
    // A correction frame or an explicit day noun is what tells the two apart,
    // and the answer is only accepted when it names a day the server itself
    // offered *and* it is not the day already held — so this can neither invent
    // a day nor loop on the current one.
    if (CORRECTION_FRAME.test(text) || DAY_NOUN.test(text)) {
      const corrected =
        resolveOfferedDay(state, text) ?? resolveOrdinalOfferedDay(state, text);
      if (corrected && corrected !== date) return { status: "day", date: corrected };
      // A day the server never offered is still a day. "لا أنا عايز يوم 12"
      // names the 12th; the booking is on the 10th; and the 12th is not in the
      // offer, so the two passes above found nothing. What used to happen next
      // is the defect: the message fell through to the clock reader, the bare
      // `12` matched the 12:00 the *10th* happened to have free, and the
      // booking was committed to an hour on the day the patient had just
      // rejected. Manual QA saw exactly that — "continued showing day 10".
      //
      // A message that names a day other than the one being timed is not an
      // answer to "which time?" at all, so nothing is resolved from it here.
      // `skip` rather than `unresolved` on purpose: `unresolved` makes the
      // authority re-offer the same day's slots, which is the same wrong day
      // said twice. The turn opener's amendment path picks it up instead and
      // checks the named day against the doctor's real schedule.
      if (namesADifferentDay(text, date)) return { status: "skip" };
    }
    const offeredForDate = state.offeredSlots.filter((slot) =>
      slot.startsWith(`${date}T`),
    );
    if (offeredForDate.length === 0) return { status: "skip" };
    // F-6 — `candidateClockTimes` now reads "الساعة عشرة" as well as "١٠:٠٠".
    const time = resolveOfferedTime(state, date, text);
    if (time) return { status: "time", time };
    // A message with no clock reading in it at all is not an answer to the time
    // question — it is something else, and forcing a re-offer on it would talk
    // over whatever the patient actually said.
    return candidateClockTimes(text).length > 0
      ? { status: "unresolved" }
      : { status: "skip" };
  }

  return { status: "skip" };
}

/** The pending-clarification record for an ambiguous outcome, or null. */
export function pendingSelectionFor(
  outcome: OfferedSelectionOutcome,
): PendingSelection | null {
  if (outcome.status !== "ambiguous") return null;
  return {
    field: outcome.field,
    candidates: outcome.candidates.map((item) => ({ id: item.id, name: item.name })),
  };
}


/**
 * The request frame a patient wraps a selection in — "عايز احجز مع …",
 * "I want to book with …", "ممكن مع …".
 *
 * Shape only: verbs of wanting and booking, the appointment nouns, the
 * prepositions and the courtesies. Not one name, not one department, not one
 * title — `resolveOfferedDoctor` strips titles itself, and it is the only thing
 * that decides which offered doctor a phrase means.
 *
 * Removing a word can only ever *narrow* what is left to match against, and the
 * result is still resolved against the offered roster and nothing else, so this
 * cannot widen the closed world.
 */
const REQUEST_FRAME_WORDS = new RegExp(
  "(?<![\\p{L}\\p{N}])(?:" +
    "عايز|عاوز|عايزة|عاوزة|محتاج|محتاجة|اريد|أريد|ابغى|أبغى|بدي|ممكن|" +
    "احجز|أحجز|احجزلي|أحجزلي|حجز|نحجز|يحجز|موعد|مواعيد|ميعاد|معاد|مع|عند|في|" +
    "لو|سمحت|من|فضلك|رجاء|رجاءً|" +
    "please|i|we|want|need|would|like|to|book|booking|reserve|an|a|the|" +
    "appointment|with|for|slot" +
    ")(?![\\p{L}\\p{N}])",
  "giu",
);

function stripRequestFrame(text: string): string {
  return text.replace(REQUEST_FRAME_WORDS, " ").replace(/\s+/g, " ").trim();
}


/**
 * "لا قصدي…", "no sorry, …", "actually …" — the patient replacing an answer
 * they already gave rather than answering the question in front of them.
 *
 * Shape only, and used solely to decide *which rung* a message is about. It
 * never resolves anything itself: whatever it lets through is still matched
 * against the server's own offer set and nothing else.
 */
const CORRECTION_FRAME =
  /(?:قصدي|أقصد|اقصد|بدل|غيرها|غيره|بدال)|\b(?:actually|instead|i\s*meant|i\s*mean|no\s*sorry|sorry,?\s*i\s*mean|rather)\b/iu;

/** An explicit day noun: "يوم ١٠", "the 10th day", "day 10". */
const DAY_NOUN = /(?<![\p{L}\p{N}])(?:يوم|اليوم|days?)(?![\p{L}\p{N}])/iu;

/**
 * Does this message name a day of the month other than the one being timed?
 *
 * Only the shapes that *name* a day — "يوم 12", "day 12", "the 12th" — which is
 * `readDayOfMonthReference`'s whole job, so the two readers cannot disagree
 * about what a day reference is. A bare number is not one, which is what keeps
 * "12" answering the time question.
 *
 * A boundary ("بعد يوم 9") is excluded: it names no day at all, and the turn
 * opener withdraws the whole turn from this module before it gets here.
 */
function namesADifferentDay(text: string, date: string): boolean {
  const reference = readDayOfMonthReference(text);
  if (!reference || reference.boundary) return false;
  return reference.day !== Number(date.slice(8, 10));
}
