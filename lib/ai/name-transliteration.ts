/**
 * P10 — "علي ابراهيم محمد" → "Ali Ibrahim Mohamed", or a question.
 *
 * ClinicFlow's patient files are keyed on a Latin-script name: that is the
 * convention the file numbers, the search index, the printed documents and the
 * staff-facing tables were all built around. A patient on WhatsApp writes their
 * name in Arabic, which left the AI intake staging a record whose name did not
 * match the convention every other patient's does.
 *
 * Transliterating it is the obvious fix and also the dangerous one, so this
 * module is built around the distinction between the two cases:
 *
 *   * **Every part of the name is a name we know.** `محمد` is Mohamed, `ابراهيم`
 *     is Ibrahim, `علي` is Ali — not because a character mapping says so, but
 *     because they are in the curated table `entity-search.ts` already keeps for
 *     patient search, where each Arabic name carries its Latin variants with the
 *     *conventional* spelling first. That is a lookup, not a guess, and the
 *     result is proposed without a question.
 *
 *   * **Some part of it is not.** Then the only thing available is generic
 *     character mapping, which produces plausible-but-arbitrary spellings —
 *     `ثريا` has at least Thoraya, Soraya and Suraya alive, and choosing one
 *     silently writes a spelling of somebody's name that they did not choose
 *     onto their medical file. So the proposal is returned marked
 *     `needsConfirmation`, and the caller asks the patient once whether the
 *     spelling is right.
 *
 * Two invariants the callers depend on:
 *
 *   1. **A Latin name is never touched beyond casing.** Somebody who wrote
 *      "Ahmed Ali" gets "Ahmed Ali". There is nothing to transliterate and
 *      nothing to ask about.
 *   2. **The original is never destroyed.** This module returns it alongside the
 *      proposal, and `register_patient` persists it to
 *      `ai_patient_intakes.full_name_original` so the reviewing staff member
 *      sees what the patient actually typed next to what we propose to file.
 *
 * Nothing here participates in identity. A transliterated name is never matched
 * against another patient's record, never used to find a file, and never passed
 * to a duplicate check — the staging RPC folds and compares the *stored* names
 * itself, exactly as it did before.
 */

import { normalizeHumanText } from "@/lib/ai/human-input";
import { arabicNameVariants } from "@/lib/ai/entity-search";

const ARABIC_SCRIPT = /[؀-ۿݐ-ݿ]/;

/** Particles that stay lowercase inside a name, as the convention writes them. */
const LOWERCASE_PARTICLES = new Set(["bin", "bint", "al", "el", "abu", "abd", "van", "de", "der"]);

export type NameProposal = {
  /** The Latin-script name to file, in Title Case. */
  proposed: string;
  /** What the patient wrote, unchanged. */
  original: string;
  /** True when the input was already Latin script and only casing changed. */
  alreadyLatin: boolean;
  /**
   * True when at least one part of the name had no curated reading and the
   * spelling below is a character-level guess. The caller must confirm it once
   * with the patient before filing it.
   */
  needsConfirmation: boolean;
  /** The parts that had to be guessed, for the question the caller asks. */
  uncertainParts: string[];
};

function titleCasePart(part: string): string {
  const lower = part.toLocaleLowerCase("en");
  if (LOWERCASE_PARTICLES.has(lower)) return lower;
  // "abdel-rahman" and "al-sayed" title-case on both sides of the hyphen.
  return lower
    .split("-")
    .map((chunk) =>
      chunk.length === 0
        ? chunk
        : chunk.charAt(0).toLocaleUpperCase("en") + chunk.slice(1),
    )
    .join("-");
}

/** Title Case, with the particles the convention keeps lowercase left alone. */
export function toTitleCaseName(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((part, index) => {
      const cased = titleCasePart(part);
      // A leading particle is still the start of the name and is capitalised:
      // "Al Sayed", not "al Sayed".
      return index === 0 && LOWERCASE_PARTICLES.has(cased)
        ? cased.charAt(0).toLocaleUpperCase("en") + cased.slice(1)
        : cased;
    })
    .join(" ");
}

/**
 * The Latin-script name to file for what the patient wrote.
 *
 * Returns null only when the input has no letters at all — every other input
 * produces a proposal, with `needsConfirmation` saying whether it is safe to
 * file without asking.
 */
export function proposeLatinName(input: string): NameProposal | null {
  const original = normalizeHumanText(input ?? "").trim();
  if (original.length === 0 || !/\p{L}/u.test(original)) return null;

  if (!ARABIC_SCRIPT.test(original)) {
    return {
      proposed: toTitleCaseName(original),
      original,
      alreadyLatin: true,
      needsConfirmation: false,
      uncertainParts: [],
    };
  }

  const parts = original.split(/\s+/).filter(Boolean);
  const uncertainParts: string[] = [];
  const rendered = parts.map((part) => {
    const variants = arabicNameVariants(part);
    if (variants && variants.length > 0) return variants[0]!;
    const fallback = transliterateUnknownPart(part);
    // A part with no curated reading is exactly the case that must be asked
    // about. A part that transliterates to nothing at all (a stray "ال", a
    // lone hamza) is not a name part and is dropped rather than questioned.
    if (fallback.length > 0) uncertainParts.push(part);
    return fallback;
  });

  const proposed = toTitleCaseName(rendered.filter(Boolean).join(" "));
  if (proposed.length === 0) return null;
  return {
    proposed,
    original,
    alreadyLatin: false,
    needsConfirmation: uncertainParts.length > 0,
    uncertainParts,
  };
}

/**
 * Character-level Arabic → Latin for a name part nothing curated covers.
 *
 * Deliberately plain. A cleverer mapping would produce a more convincing
 * spelling, and a more convincing spelling is *worse* here: the whole point of
 * flagging this path is that the result is a proposal to be confirmed, not an
 * answer. Making it look authoritative would invite the caller to skip the
 * question.
 */
const NAME_LETTERS: Record<string, string> = {
  ا: "a", أ: "a", إ: "i", آ: "aa", ب: "b", ت: "t", ث: "th", ج: "g",
  ح: "h", خ: "kh", د: "d", ذ: "dh", ر: "r", ز: "z", س: "s", ش: "sh",
  ص: "s", ض: "d", ط: "t", ظ: "z", ع: "a", غ: "gh", ف: "f", ق: "q",
  ك: "k", ل: "l", م: "m", ن: "n", ه: "h", و: "o", ي: "y", ى: "a",
  ة: "a", ء: "", ئ: "y", ؤ: "w", پ: "p", چ: "ch", ژ: "zh", ڤ: "v", گ: "g",
};

function transliterateUnknownPart(part: string): string {
  let out = "";
  for (const char of part) {
    out += NAME_LETTERS[char] ?? (/[A-Za-z]/.test(char) ? char : "");
  }
  return out.replace(/(.)\1+/g, "$1$1").trim();
}
