/**
 * "Use my email" — reading a reference to the requester's own address.
 *
 * ## The gap this exists for
 *
 * `self-phone-reference.ts` taught the third-party intake to read «استخدم
 * رقمي». The email question sitting one step above it learned nothing, so a
 * requester opening a file for a child who has no address of their own — the
 * ordinary case — had no way to answer it:
 *
 * ```
 *   assistant: ممكن إيميل المريض؟
 *   patient:   نفس إيميلي
 *   assistant: ممكن إيميل المريض؟
 * ```
 *
 * The email branch of `resolveIntakeField` is a shape check on the message and
 * nothing else, so a sentence with no `@` in it resolved to nothing and the
 * same question came back.
 *
 * ## What this module decides, and what it does not
 *
 * One thing, purely and synchronously: *does this sentence name the requester's
 * own email address?* It resolves nothing and reads nothing. It has no access
 * to an address and cannot invent one — the caller supplies it, and the caller
 * decides whether such a reference is permitted where it arrived.
 *
 * ## Why sharing an address is contact data and nothing more
 *
 * The same reason a shared number is. An email on a patient file is a way to
 * reach the person; it is not a way to *find* them. Identity discovery is the
 * national id plus the canonical name (`tools.resolveIdentity`), and it takes
 * neither a phone nor an email argument. Two files carrying one address is the
 * expected shape for a parent and a child, and it links nobody, verifies
 * nobody, moves no conversation and changes no beneficiary.
 *
 * ## Why an email is *not* simply a second phone
 *
 * Because the two facts are not equally available to the server. The phone is
 * the address the message physically arrived on — the server knows it for an
 * anonymous sender, and the sender obviously knows it too. An email is stored
 * on a patient record, so it exists only when this thread already selects a
 * file, and reading one is a read. That difference is why the resolution here
 * is a *lookup the caller performs* rather than a field on the turn context,
 * and why a requester whose record carries no usable address is simply asked
 * for the beneficiary's — see `ownEmailForThirdParty` in `flows.ts`.
 *
 * ## Why the lexicon is this small
 *
 * Because the failure mode of a loose one is filing a stranger's address onto a
 * medical record and then mailing clinic correspondence to it. Every
 * alternative below requires a **first-person possessive** on the word for an
 * address — «إيميلي», «بريدي», "my email" — or an explicit reference to the
 * address **this clinic already holds for the sender** — «الإيميل اللي عندكم
 * ليا», "the email you have for me". A third-person possessive («إيميله»), a
 * bare «الإيميل», and anything that merely mentions email are not matched.
 */

import { foldArabic } from "@/lib/ai/v2/normalize";

/**
 * The ways a requester says "the address you already have for me".
 *
 * Read against `foldArabic`-folded, lower-cased text, so «إيميلى» and «إيميلي»
 * are one word.
 *
 * The Arabic possessive patterns are anchored on a word boundary rather than
 * matched as bare substrings, which the phone lexicon does not need to be:
 * «ميلي» is a real colloquial form for "my email" and is also the tail of
 * «زميلي», "my colleague". Requiring the start of a word keeps the second one
 * out.
 */
const OWN_EMAIL = [
  // «إيميلي» / «ايميلى» / «ميلي» / «بريدي» — the possessive is in the pattern.
  // «إيميله» and «إيميلها» do not match any of them.
  /(?:^|[\s،,.:؛(])(?:ايميلي|ميلي|بريدي|إيميلي)(?:$|[\s،,.:؛)])/u,
  // «الإيميل بتاعي» / «البريد الخاص بيا» / «الإيميل حقي».
  /(?:ال)?(?:ايميل|بريد|ميل)\s*(?:بتاعي|بتاعتي|الخاص\s*بي|الخاص\s*بيا|حقي|ديالي)/u,
  // «نفس الإيميل» / «نفس البريد» — deixis onto the requester's own.
  /نفس\s*(?:ال)?(?:ايميل|بريد|ميل)/u,
  // «الإيميل اللي عندكم ليا» / «البريد اللي مسجل عندكم».
  /(?:ال)?(?:ايميل|بريد|ميل)\s+(?:اللي|الي)\s+(?:\S+\s+){0,3}(?:ليا|ليه|عندي|مسجل|عندكم|مسجله)/u,
  // English, with the possessive or the deixis carried by the pattern itself.
  /\bmy\s+(?:own\s+)?(?:e-?mail|mail)\b/u,
  /\b(?:this|the\s+same)\s+(?:e-?mail)\b/u,
  /\bsame\s+as\s+(?:my|mine)\b/u,
  /\bthe\s+e-?mail\s+you\s+(?:have|hold|got|already\s+have)\b/u,
] as const;

/**
 * True when this message names the requester's own email address.
 *
 * Pure. The caller decides whether such a reference is permitted where it
 * arrived, and the caller supplies the address — this function has no access to
 * one and cannot invent one.
 */
export function readsAsOwnEmailReference(spoken: string): boolean {
  const text = foldArabic(spoken).toLowerCase();
  if (!text) return false;
  return OWN_EMAIL.some((pattern) => pattern.test(text));
}

/** The shape an address has to have before it is written anywhere. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

/**
 * A stored address reduced to the form the intake files, or null.
 *
 * The same reduction the typed branch of the intake applies, so an address that
 * arrives this way is stored in exactly the shape a typed one is. A record
 * whose column holds a placeholder, a fragment or nothing at all produces null,
 * which leaves the intake asking for the beneficiary's address rather than
 * filing something that is not one.
 */
export function contactEmailValue(stored: string | null | undefined): string | null {
  const value = (stored ?? "").trim().toLowerCase();
  return EMAIL_SHAPE.test(value) ? value : null;
}
