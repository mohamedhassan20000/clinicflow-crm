/**
 * P11F — the label a patient reads, as opposed to the label a clinic stored.
 *
 * ## The defect
 *
 * A production Arabic conversation, every sentence composed by the server:
 *
 * ```
 *   الأقسام المتاحة عندنا: <three department rows, all spelled in English>
 *   الدكاترة المتاحين في <the same, again> : ...
 * ```
 *
 * Nothing was *wrong* — those are the clinic's own department rows, spelled the
 * way the clinic spelled them. But `departments.name` is one column with one
 * value, and a reply that interpolates it verbatim inherits whatever script the
 * clinic happened to type into an admin form. The patient asked "عربي؟" and the
 * assistant answered in Arabic with three English nouns still in it, which is
 * not "the clinic's canonical name" to a patient — it is the assistant failing
 * to speak their language halfway through a sentence.
 *
 * ## The rule
 *
 * A *stored label* and a *presented label* are different things, and only the
 * first belongs to the database. So every sentence the server composes for a
 * patient runs its entity labels through here first.
 *
 * The mapping is not a translation engine and deliberately does not try to be:
 *
 *   1. If the label already contains Arabic letters, it is left exactly alone.
 *      A clinic that named its department "الأسنان" already answered this
 *      question, and a clinic that wrote "قسم Gamma" is telling us the Latin
 *      part is a proper name.
 *   2. Otherwise the label is looked up in the *same* concept lexicon
 *      `entity-resolution.ts` already uses to understand what a patient typed.
 *      That table is the clinic-agnostic specialty vocabulary; reading it in
 *      the other direction gives the ordinary Arabic name of the specialty for
 *      free, with no new data and nothing to keep in sync.
 *   3. If the lexicon has nothing to say — a department named "Gamma Unit", a
 *      brand, a franchise name, anything a clinic invented — the stored label
 *      is presented **unchanged**. That is the "genuinely intended to remain
 *      untranslated" case, and guessing at it with character transliteration
 *      would turn a clinic's own brand into nonsense.
 *
 * The lexicon is a *specialty* vocabulary, so rule 3 is the honest default for
 * everything else. Nothing here names a clinic, a department row or an id, and
 * a department created tomorrow is covered tomorrow by exactly the same three
 * rules.
 *
 * ## Person names are not labels
 *
 * `formatPersonName` localizes the *title* and never the name. "Dr. <name>"
 * becomes "د. <name>" in an Arabic sentence, because the title is a word and
 * the name is a person's name — the one thing in this file that is
 * genuinely intended to remain as stored. It is also the name every downstream
 * grounding check compares against, and a reply that renamed a real doctor
 * would be indistinguishable from a reply that invented one.
 */

import { conceptKeys } from "@/lib/ai/entity-resolution";

const ARABIC_SCRIPT =
  /[\u0620-\u064A\u066E-\u06D3\u06D5\u06EE-\u06EF\u06FA-\u06FF\u0750-\u077F\u08A0-\u08BF\uFB50-\uFDFF\uFE70-\uFEFF]/;

/**
 * The ordinary Arabic name of each specialty the concept lexicon knows.
 *
 * Keyed by the lexicon's own concept values, so this table cannot name a
 * concept the resolver does not have and the resolver cannot grow a concept
 * this table silently ignores — `p11f-language-consistency.test.ts` asserts the
 * two key sets are identical.
 */
const CONCEPT_LABELS_AR: Readonly<Record<string, string>> = {
  cardiology: "القلب",
  dentistry: "الأسنان",
  dermatology: "الجلدية",
  ophthalmology: "العيون",
  pediatrics: "الأطفال",
  orthopedics: "العظام",
  gynecology: "النساء والتوليد",
  ent: "الأنف والأذن والحنجرة",
  physicaltherapy: "العلاج الطبيعي",
  neurology: "المخ والأعصاب",
  psychiatry: "الطب النفسي",
  urology: "المسالك البولية",
  gastroenterology: "الجهاز الهضمي",
  endocrinology: "الغدد الصماء",
  pulmonology: "الصدرية",
  generalmedicine: "الطب العام",
  nutrition: "التغذية",
  plasticsurgery: "التجميل",
  surgery: "الجراحة",
  radiology: "الأشعة",
  laboratory: "المعمل",
};

/** Exported for the test that pins it against the resolver's concept set. */
export function arabicConceptLabels(): Readonly<Record<string, string>> {
  return CONCEPT_LABELS_AR;
}

/**
 * How a department, service or specialty label should be written in a reply
 * that is being composed in `locale`.
 *
 * Total and never throws: the worst case is that the stored label comes back
 * trimmed and otherwise untouched, which is the pre-P11F behaviour.
 */
export function localizeEntityLabel(
  name: string | null | undefined,
  locale: "ar" | "en",
): string {
  const label = (name ?? "").trim().replace(/\s+/g, " ");
  if (label.length === 0) return "";
  if (locale !== "ar") return label;
  // Already Arabic, or a mixed label whose Arabic half is the clinic's answer.
  if (ARABIC_SCRIPT.test(label)) return label;

  const concepts = [...conceptKeys(label)];
  // Exactly one concept, or the label is ambiguous between two specialties and
  // the clinic's own spelling is the only unambiguous thing available.
  if (concepts.length !== 1) return label;
  return CONCEPT_LABELS_AR[concepts[0]!] ?? label;
}

/** The same, for a list. */
export function localizeEntityLabels(
  names: readonly (string | null | undefined)[],
  locale: "ar" | "en",
): string[] {
  return names.map((name) => localizeEntityLabel(name, locale)).filter(Boolean);
}

/**
 * Titles a stored staff name may carry, and how each is written in Arabic.
 *
 * Only the leading title is touched, and only when it is one of these: this is
 * a rewrite of a *word*, and the set of words it may rewrite is closed.
 */
const LEADING_TITLE =
  /^\s*(?:(dr|doctor|prof|professor)\.?|(د|دكتور|دكتورة|الدكتور|الدكتورة|أ\.د|ا\.د))\s*\.?\s+/i;

const AR_TITLES: Readonly<Record<string, string>> = {
  dr: "د.",
  doctor: "د.",
  prof: "أ.د.",
  professor: "أ.د.",
};

const EN_TITLES: Readonly<Record<string, string>> = {
  د: "Dr.",
  دكتور: "Dr.",
  دكتورة: "Dr.",
  الدكتور: "Dr.",
  الدكتورة: "Dr.",
  "أ.د": "Prof.",
  "ا.د": "Prof.",
};

/**
 * A stored staff name, written for a reply in `locale`.
 *
 * The person's name is returned byte-for-byte as stored. Only a leading title
 * is rewritten, and a name with no title is returned with no title added — an
 * assistant that promoted every name to "Dr." would be making a claim about
 * somebody's credentials that the row did not make.
 */
export function formatPersonName(
  name: string | null | undefined,
  locale: "ar" | "en",
): string {
  const value = (name ?? "").trim().replace(/\s+/g, " ");
  if (value.length === 0) return "";
  const match = LEADING_TITLE.exec(value);
  if (!match) return value;
  const rest = value.slice(match[0].length).trim();
  if (rest.length === 0) return value;
  const latin = match[1]?.toLowerCase() ?? null;
  const arabic = match[2] ?? null;
  const title =
    locale === "ar"
      ? latin
        ? (AR_TITLES[latin] ?? null)
        : arabic
      : arabic
        ? (EN_TITLES[arabic] ?? null)
        : latin === "prof" || latin === "professor"
          ? "Prof."
          : "Dr.";
  if (!title) return value;
  return `${title} ${rest}`;
}

/** The same, for a list. */
export function formatPersonNames(
  names: readonly (string | null | undefined)[],
  locale: "ar" | "en",
): string[] {
  return names.map((name) => formatPersonName(name, locale)).filter(Boolean);
}
