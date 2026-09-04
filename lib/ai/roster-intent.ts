/**
 * P11B — is doctor membership the subject of this turn?
 *
 * ## Why this exists as its own decision
 *
 * The phantom-doctor defect was not a bad roster. The roster was never loaded:
 * the model was asked "مين الدكاترة المتاحين؟" on a turn where no roster tool
 * was mounted, so it answered from its own pre-training and produced two people
 * who have never existed in any clinic. Nothing downstream objected, because
 * every check available at that point was a search for a *wrong* name and an
 * invented one looks exactly like an ordinary one.
 *
 * The way out is to stop asking "is this name wrong?" and start asking "is this
 * turn allowed to name anybody at all?". That second question has a server-side
 * answer, and this module is it. When a turn is roster-bearing, the set of
 * people the reply may name is closed: it is whatever `list_doctors` /
 * `prepare_booking` actually returned, and if they returned nothing then the
 * answer is nobody.
 *
 * ## Deliberately department-agnostic
 *
 * Nothing here names a department, a doctor, a specialty or a clinic. It reads
 * the *shape* of a question — "who", "which doctor", "مين الدكاترة" — and the
 * shape of a reply — a doctor title, a list of people. A clinic with three
 * departments and a clinic with a hundred run identical code, and a department
 * created a minute ago is covered the moment its row exists, because the roster
 * itself is always read live from `departments` / `profiles`.
 */

import { isOtherDoctorsRequest } from "@/lib/ai/doctor-directory";

/**
 * Question shapes that ask who the doctors are.
 *
 * `isOtherDoctorsRequest` already covers the follow-up shape ("مين تاني؟",
 * "who else?") and is reused rather than restated, so the two can never drift.
 * These add the *opening* shape, which that function deliberately does not
 * match because it is not a request for the "rest" of anything.
 *
 * Arabic patterns use Unicode boundaries, never `\b`: `\b` is defined against
 * `[A-Za-z0-9_]` and so never exists between two Arabic letters — the exact bug
 * that made an earlier generation of these patterns match nothing at all.
 */
const L = "(?<![\\p{L}\\p{N}])";
const R = "(?![\\p{L}\\p{N}])";
const word = (pattern: string): RegExp => new RegExp(`${L}(?:${pattern})${R}`, "iu");

const ROSTER_QUESTION_PATTERNS: readonly RegExp[] = [
  // English
  /\bwho(?:'s| is| are)?\b[^?.!\n]{0,40}\b(?:doctors?|available|free|there)\b/i,
  /\bwhich\s+doctors?\b/i,
  /\bwhat\s+doctors?\b/i,
  /\b(?:list|show|name|tell me)\b[^?.!\n]{0,30}\bdoctors?\b/i,
  /\bdoctors?\b[^?.!\n]{0,30}\b(?:available|do you have|are there|work)\b/i,
  /\bavailable\s+doctors?\b/i,
  // Arabic — "who are the doctors", "which doctors", "the available doctors",
  // "do you have doctors", written the way people actually type them.
  word("مين\\s*(?:هما|هم|هو)?\\s*(?:ال)?(?:دكاترة|دكتور|اطباء|أطباء|الاطباء|الأطباء)"),
  word("(?:انهي|أنهي|انهى|اي|أي)\\s*(?:دكتور|دكاترة|طبيب)"),
  word("(?:ال)?(?:دكاترة|اطباء|أطباء|الاطباء|الأطباء)\\s*(?:المتاحين|المتاحه|المتاحة|عندكم|عندكو|اللي عندكم)?"),
  word("(?:عايز|عاوز|اريد|أريد|ممكن|محتاج)\\s*(?:اعرف|أعرف|تقولي|اشوف|أشوف)?\\s*(?:مين|ال)?\\s*(?:دكاترة|دكتور|اطباء|أطباء)"),
  word("(?:في|فيه|عندكم|عندكو)\\s*(?:ايه من )?(?:دكاترة|اطباء|أطباء|دكتور)"),
];

/** Does the patient's own message ask who the doctors are? */
export function isRosterQuestion(value: string | null | undefined): boolean {
  const text = (value ?? "").trim();
  if (!text) return false;
  if (isOtherDoctorsRequest(text)) return true;
  return ROSTER_QUESTION_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Reply shapes that *present* a roster, whatever the patient asked.
 *
 * A model can volunteer a doctor list in answer to "عايز احجز" with no roster
 * question anywhere in the turn, and that reply carries exactly the same
 * membership claim. Detecting it from the reply closes the case where the
 * question was phrased in a way no pattern above anticipated — which, for an
 * open-ended natural-language channel, is a case that will always exist.
 */
const REPLY_ROSTER_PATTERNS: readonly RegExp[] = [
  /(?<![\p{L}\p{N}])(?:drs?\.|doctors?|(?:ال)?(?:دكاترة|دكتوره|دكتورة|دكتور)|د\.)(?![\p{L}\p{N}])/iu,
];

/** Does the assistant's draft present or name doctors? */
export function replyPresentsDoctors(value: string | null | undefined): boolean {
  const text = (value ?? "").trim();
  if (!text) return false;
  return REPLY_ROSTER_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * The turn-level decision, from the three independent signals.
 *
 * Any one of them is enough. They are ORed rather than weighed because the
 * consequence of a false positive is that a reply which names only
 * server-returned doctors is checked against a list it already satisfies —
 * costless — while the consequence of a false negative is the defect this
 * whole phase exists to remove.
 */
export function isRosterBearingTurn(input: {
  /** The newest inbound patient message. */
  patientText?: string | null;
  /** The assistant's draft, before it is sent. */
  replyText?: string | null;
  /** Did any tool return a doctor this turn? */
  sawDoctorTool?: boolean;
}): boolean {
  if (input.sawDoctorTool) return true;
  if (isRosterQuestion(input.patientText)) return true;
  return replyPresentsDoctors(input.replyText);
}
