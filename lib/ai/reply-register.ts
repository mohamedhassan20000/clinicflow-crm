/**
 * P11F — friendly is a register, not a licence.
 *
 * ## The defect
 *
 * Production, Arabic, tone `friendly`, mid-intake:
 *
 * ```
 *   تمام يا عم!
 *   الآن احتاج تاريخ ميلاده والبريد الإلكتروني بتاعه…
 * ```
 *
 * "يا عم" is street address between men who know each other. Said by a clinic
 * to a parent registering their child, it is not warm — it is a stranger being
 * over-familiar about a medical record. Nothing produced it deliberately: the
 * style block asked for "ودّي ودافئ" and the model supplied the most colloquial
 * Egyptian reading of "warm" it had, because nothing anywhere said where warm
 * stops.
 *
 * ## What this module is, and why it is not only a prompt line
 *
 * The prompt now says it (see `communication-style.ts`), and a prompt rule is a
 * request. This is the check, and it is the same shape as the doctor-grounding
 * check next door: a pure predicate over the finished string, run server-side
 * on **every** patient-facing sentence — model-written, regenerated, or
 * server-composed — so a deterministic reply and a generated one cannot drift
 * apart on register any more than they can on entity membership.
 *
 * The remedy is deliberately *excision*, not refusal and not regeneration. Every
 * form below is a vocative or an interjection: it attaches to a sentence and
 * carries no information, so removing it leaves a reply that is still complete,
 * still warm, and still answers the question. "تمام يا عم!" → "تمام!". Asking
 * the model again would cost a round trip to fix a word we can simply not say.
 *
 * ## What it must not become
 *
 * Not a profanity filter, not a politeness scorer, not a dialect police. The
 * list is small, closed, and contains only *forms of address*: the friendly
 * Egyptian and Gulf vocabulary a clinic actually wants — تمام، حاضر، أكيد، تحت
 * أمرك، تحب — is untouched, and `p11f-professional-tone.test.ts` pins that
 * both ways. A clinic that genuinely wants one of these forms can have it: see
 * `clinicPermitsInformalAddress`.
 */

import type { CommunicationStyle } from "@/lib/ai/communication-style";

/** Unicode-safe word edges. `\b` does not exist between two Arabic letters. */
const L = "(?<![\\p{L}\\p{N}])";
const R = "(?![\\p{L}\\p{N}])";

/**
 * One prohibited form of address: a label for the audit, and the pattern that
 * finds it together with the punctuation and spacing it leans on.
 *
 * The label is what reaches `audit_logs` — never the sentence, and never the
 * patient's words.
 */
type AddressForm = { label: string; pattern: RegExp };

function vocative(label: string, body: string): AddressForm {
  return {
    label,
    // Leading separator is consumed so "تمام يا عم!" closes up to "تمام!", and
    // a trailing comma is consumed so "يا عم، تحب…" does not leave one behind.
    pattern: new RegExp(`[\\s،,\\-–—]*${L}(?:${body})${R}[\\s]*[،,!]?`, "giu"),
  };
}

/**
 * The closed list.
 *
 * Egyptian and Gulf street vocatives, plus the two English ones that turn up in
 * a bilingual thread. Each is a form of *address*; none is a content word, which
 * is what makes deleting it safe.
 */
const ADDRESS_FORMS: readonly AddressForm[] = [
  vocative("ya_amm", "يا\\s*عم|ياعم"),
  vocative("ya_me3allem", "يا\\s*مع?لّ?م|يامعلم|يا\\s*أسطى|يا\\s*اسطى"),
  vocative("ya_basha", "يا\\s*باشا|يابا?شا|يا\\s*بيه|يا\\s*باشمهندس"),
  vocative("ya_kbir", "يا\\s*كبير|يا\\s*زعيم|يا\\s*نجم|يا\\s*وحش"),
  vocative("habibi", "يا\\s*حبيبي|حبيبي|حبيبتي|يا\\s*قلبي|يا\\s*روحي|يا\\s*حلو"),
  vocative("ya_gada3", "يا\\s*جدع|يا\\s*صاحبي|يا\\s*صديقي\\s*العزيز"),
  vocative("gulf_informal", "يا\\s*خوي|يا\\s*الغالي|يالغالي|يا\\s*طيب\\s*القلب"),
  vocative("bro", "bro|bruh|dude|mate|buddy|pal|fam|homie"),
];

export type RegisterFinding = {
  /** Enumerated labels only. Safe for the audit trail. */
  labels: readonly string[];
};

/**
 * Which prohibited forms of address a finished reply contains.
 *
 * Labels, in the order they are declared above, de-duplicated. An empty array
 * means the reply is clean.
 */
export function detectUnprofessionalAddress(
  text: string | null | undefined,
): readonly string[] {
  const value = text ?? "";
  if (value.trim().length === 0) return [];
  const found: string[] = [];
  for (const form of ADDRESS_FORMS) {
    // `g` regexes carry `lastIndex`; a fresh one per test keeps this pure.
    if (new RegExp(form.pattern.source, "iu").test(value)) found.push(form.label);
  }
  return found;
}

/**
 * The clinic explicitly asked for it.
 *
 * The only override, and it requires no new column: a clinic that wants
 * "حبيبي" has typed the word into its own style instruction, which is the
 * strongest possible statement of intent and one an administrator makes on
 * purpose. Absence of a setting is not consent, so the default is the
 * prohibition — which is the way round a clinic assistant has to fail.
 */
export function clinicPermitsInformalAddress(
  style: Pick<CommunicationStyle, "styleInstruction">,
  labels: readonly string[],
): boolean {
  const instruction = style.styleInstruction;
  if (!instruction) return false;
  const permitted = new Set(detectUnprofessionalAddress(instruction));
  return labels.length > 0 && labels.every((label) => permitted.has(label));
}

/** Cleans up what excision leaves behind: doubled spaces, orphaned commas. */
function tidy(text: string): string {
  return text
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([،,.!؟?])/g, "$1")
    .replace(/([،,])\s*([،,])/g, "$1")
    .replace(/^[ \t،,]+/gm, "")
    .replace(/[ \t]+$/gm, "")
    .trim();
}

export type RegisterEnforcement = {
  text: string;
  /** True when at least one form was removed. */
  changed: boolean;
  /** Labels only, for the audit line. */
  labels: readonly string[];
};

/**
 * The finished reply, with any prohibited form of address removed.
 *
 * Applied to *every* patient-facing sentence, whoever composed it. Returns the
 * input untouched when the reply is clean or when the clinic has explicitly
 * asked for exactly the forms found.
 */
export function enforceReplyRegister(input: {
  text: string;
  style: Pick<CommunicationStyle, "styleInstruction">;
}): RegisterEnforcement {
  const text = input.text ?? "";
  const labels = detectUnprofessionalAddress(text);
  if (labels.length === 0) return { text, changed: false, labels: [] };
  if (clinicPermitsInformalAddress(input.style, labels)) {
    return { text, changed: false, labels };
  }
  let out = text;
  for (const form of ADDRESS_FORMS) {
    out = out.replace(new RegExp(form.pattern.source, "giu"), (match) => {
      // A form that ended a clause keeps that clause's punctuation.
      if (/[!،,]$/.test(match)) return match.slice(-1);
      // A form that sat *between* two words leaves the word gap behind, so
      // "Sure thing, mate — which day?" does not close up into "thing— which".
      return /\s$/.test(match) ? " " : "";
    });
  }
  const cleaned = tidy(out);
  // Never hand back an empty reply: a sentence that was *only* a vocative is
  // left as it was, because saying nothing is worse than saying it casually.
  if (cleaned.length === 0) return { text, changed: false, labels };
  return { text: cleaned, changed: cleaned !== text, labels };
}
