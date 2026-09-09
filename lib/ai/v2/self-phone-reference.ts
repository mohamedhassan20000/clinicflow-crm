/**
 * "Use my number" — reading a reference to the number this conversation is
 * being held on.
 *
 * ## The defect this exists for
 *
 * From manual QA. A requester was opening a file for his wife, and the intake
 * asked for *her* contact number:
 *
 * ```
 *   assistant: ممكن رقم تليفون المريض؟
 *   patient:   خلي رقمها رقمي لأنها مراتي
 *   assistant: ممكن رقم تليفون المريض؟
 * ```
 *
 * The intake's phone branch is digit extraction and nothing else, so a sentence
 * with no digits in it resolved to nothing and the same question came back. The
 * reference was not merely misread — it was **unresolvable by construction**:
 * the turn context did not carry the conversation's own participant address at
 * all, so there was no value for any reading of the sentence to land on.
 *
 * ## What this module decides, and what it does not
 *
 * It decides one thing, purely and synchronously: *does this sentence name the
 * number the patient is messaging from?* It resolves nothing, reads nothing,
 * and knows nothing about who the number belongs to.
 *
 * In particular it says nothing about identity. A phone number on a patient
 * file is **contact data**: two files may carry the same number, and the intake
 * has never matched a patient by phone — discovery is the national id plus the
 * canonical name, and it is unchanged. Accepting the requester's number as the
 * beneficiary's contact number does not link, verify, or select anybody, and
 * `stage_patient_intake_from_conversation` would have written that very number
 * as its own last-resort fallback. The difference this makes is that the
 * patient asked for it.
 *
 * ## Why the lexicon is this small
 *
 * Because the failure mode of a loose one is filing somebody's WhatsApp number
 * onto a stranger's medical record. Every alternative below requires either a
 * **first-person possessive** on the word for a number — «رقمي», "my number" —
 * or an explicit reference to **this conversation's** number — «نفس الرقم اللي
 * بكلمك منه», "this number". A third-person possessive («رقمها», "her number"),
 * a bare «الرقم», and anything that merely mentions a phone are not matched, so
 * an under-specified request still asks rather than choosing a number for the
 * patient.
 */

import { foldArabic } from "@/lib/ai/v2/normalize";

/**
 * The ways a patient says "the number I am writing to you from".
 *
 * Read against `foldArabic`-folded, lower-cased text, so «رقمى» and «رقمي» are
 * one word and «إيه» and «ايه» are one word.
 *
 * Two families, and both are anchored:
 *
 *   * **mine** — the possessive suffix is part of the pattern. «رقمي»,
 *     «نمرتي», «تليفوني», "my number", "my mobile". «رقمها» does not match
 *     any of them.
 *   * **this one** — an explicit deixis onto the live thread. «نفس الرقم»,
 *     «الرقم ده», «الرقم اللي بكلمك منه», "this number", "the same number".
 *     A bare «الرقم» is deliberately absent: "use the number" does not say
 *     which one.
 */
const OWN_NUMBER = [
  // «رقمي» / «رقمى» / «نمرتي» / «تليفوني» / «موبايلي» / «هاتفي» / «خطي»
  /(?:رقمي|نمرتي|تليفوني|تلفوني|موبايلي|محمولي|هاتفي)/u,
  // «نفس الرقم» / «نفس رقم» — the same number as the one in hand.
  /نفس\s*(?:ال)?(?:رقم|نمره|تليفون|موبايل)/u,
  // «الرقم ده» / «الرقم دا» / «الرقم هذا» — this one, pointed at.
  /(?:ال)?(?:رقم|نمره|تليفون|موبايل)\s*(?:ده|دا|هذا|دي)/u,
  // «الرقم اللي بكلمك منه» / «الرقم اللي بكتب منه» / «الرقم اللي براسلك منه»
  /(?:ال)?(?:رقم|نمره|تليفون|موبايل)\s*(?:اللي|الي|ال)\s*(?:\S+\s+){0,2}(?:بكلمك|بكلمكم|بكتب|بكتبلك|براسلك|بتواصل|بتكلم|بيكلمك)/u,
  // English, with the possessive or the deixis carried by the pattern itself.
  /\bmy\s+(?:own\s+)?(?:number|phone|mobile|cell|cellphone|whatsapp)\b/u,
  /\b(?:this|the\s+same)\s+(?:number|phone|mobile|whatsapp)\b/u,
  /\bthe\s+number\s+(?:i'?m|i\s+am|im)\s+(?:messaging|writing|texting|chatting|contacting|talking)\b/u,
] as const;

/**
 * True when this message names the conversation's own number.
 *
 * Pure. The caller decides whether such a reference is permitted where it
 * arrived, and the caller supplies the number — this function has no access to
 * one and cannot invent one.
 */
export function readsAsOwnNumberReference(spoken: string): boolean {
  const text = foldArabic(spoken).toLowerCase();
  if (!text) return false;
  return OWN_NUMBER.some((pattern) => pattern.test(text));
}

/**
 * The conversation's participant address as a phone value, or null.
 *
 * The same reduction the digit branch of the intake applies to what a patient
 * types, so a number that arrives this way is stored in exactly the shape a
 * typed one is. An address that carries fewer than seven digits — a group jid,
 * a placeholder, an empty column — is not a phone number and produces null,
 * which leaves the intake asking rather than filing a fragment.
 */
export function participantPhone(address: string | null | undefined): string | null {
  const value = foldArabic(address ?? "").replace(/[^0-9+]/gu, "");
  const digits = value.replace(/[^0-9]/gu, "");
  if (digits.length < 7) return null;
  // A leading `+` is kept where the address carries one; nothing is prepended.
  return value.startsWith("+") ? `+${digits}` : digits;
}
