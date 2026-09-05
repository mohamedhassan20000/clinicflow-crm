import { normalizeDigits, normalizeHumanText } from "@/lib/ai/human-input";

export type NamedEntity = { id: string; name: string };

export type EntityResolution =
  | { status: "resolved"; entity: NamedEntity; score: number }
  | { status: "ambiguous"; candidates: Array<NamedEntity & { score: number }> }
  | { status: "not_found"; candidates: Array<NamedEntity & { score: number }> };

const TITLE_WORDS = new Set([
  "dr", "doctor", "doc", "د", "دكتور", "دكتورة", "الدكتور", "الدكتورة",
  "department", "dept", "clinic", "قسم", "عيادة",
]);

/**
 * A cross-language concept lexicon. It **adds** score; it can never replace,
 * rewrite or veto a clinic's real department name.
 *
 * Read the direction carefully, because it is the whole reason this table is
 * allowed to exist: it maps **the words a patient might type** onto a shared
 * concept key. It is *not* a list of departments. Nothing here is ever offered
 * to a patient, nothing here can create a department, and a concept with no
 * matching row in `public.departments` resolves to nothing at all. The candidate
 * set is always, only, the clinic's own active departments loaded that turn — so
 * a department added in Settings this morning is bookable this morning, a
 * renamed one answers to its new name, and a deactivated one stops being
 * offered, none of which requires a code change.
 *
 * What it fixes is narrow and was a real failure: a clinic whose departments are
 * named in English ("Physical Therapy") could not be reached by a patient typing
 * Arabic ("علاج طبيعي"), because character transliteration turns that into
 * `alaj tbyay`, which has no edit-distance relationship to `physical therapy`
 * whatsoever. Cross-language matching needs a shared key, and this is it.
 *
 * ---------------------------------------------------------------------------
 * P11 — why this is no longer allowed to *substitute*.
 *
 * Until P11 the alias pass rewrote the normalized text in place, so the concept
 * key became the only thing compared. That turned a convenience into a hard
 * dependency and produced two failures that no amount of extending the table
 * could fix, because both are caused by the table being consulted at all:
 *
 *   * **Collision.** Two real departments whose names map to one concept became
 *     permanently unresolvable *against their own literal names*. A clinic with
 *     "General Medicine", "Internal Medicine" and "Family Medicine" — an
 *     entirely ordinary configuration — collapsed all three onto
 *     `generalmedicine`, so a patient typing "Internal Medicine" exactly got
 *     `ambiguous` forever. Same for "Nutrition" and "Diet Clinic", and for
 *     "Physical Therapy" beside "Rehabilitation".
 *
 *   * **Erasure.** A department name the table does not cover, addressed by a
 *     word the table *does* cover, was rewritten away from its own name. A
 *     department stored as "الأسنان" normalized to `alasnan` while the patient's
 *     "اسنان" was rewritten to `dentistry`, and the two no longer resembled each
 *     other at all: `not_found`, for an exact-in-Arabic match.
 *
 * So scoring is now the maximum of two independent measurements — the literal
 * one and the concept one — and the literal score breaks every tie. A clinic
 * name always wins against itself, a concept only ever lifts a pair that the
 * letters alone could not connect, and a genuine two-way concept collision
 * degrades to one clarifying question instead of a wrong department.
 *
 * Extending the table is therefore cheap, optional and non-destructive. Leaving
 * a specialty out costs one clarifying question, never a wrong department, and
 * never a department that cannot be reached by its own name.
 */
const CONCEPT_LEXICON: Record<string, string> = {
  // Cardiology
  heart: "cardiology", cardiac: "cardiology", cardio: "cardiology",
  قلب: "cardiology", قلبية: "cardiology", القلب: "cardiology", كارديو: "cardiology",
  // Dentistry
  teeth: "dentistry", tooth: "dentistry", dental: "dentistry", dentist: "dentistry",
  اسنان: "dentistry", الاسنان: "dentistry", سنان: "dentistry",
  // Dermatology
  skin: "dermatology", derma: "dermatology", dermatologist: "dermatology",
  جلد: "dermatology", جلدية: "dermatology", الجلدية: "dermatology", جلديه: "dermatology",
  بشرة: "dermatology", بشره: "dermatology",
  // Ophthalmology
  eye: "ophthalmology", eyes: "ophthalmology", optha: "ophthalmology",
  عيون: "ophthalmology", العيون: "ophthalmology", عين: "ophthalmology", رمد: "ophthalmology",
  // Paediatrics
  child: "pediatrics", children: "pediatrics", kids: "pediatrics",
  paediatrics: "pediatrics", paediatric: "pediatrics", pediatric: "pediatrics",
  اطفال: "pediatrics", الاطفال: "pediatrics", طفل: "pediatrics",
  // Orthopaedics
  bones: "orthopedics", bone: "orthopedics", ortho: "orthopedics",
  orthopaedics: "orthopedics", orthopaedic: "orthopedics", orthopedic: "orthopedics",
  عظام: "orthopedics", العظام: "orthopedics", عضام: "orthopedics",
  // Obstetrics and gynaecology
  women: "gynecology", gynaecology: "gynecology", gynaecologist: "gynecology",
  obstetrics: "gynecology", obgyn: "gynecology", maternity: "gynecology",
  نساء: "gynecology", نسا: "gynecology", النساء: "gynecology", ولادة: "gynecology",
  ولاده: "gynecology", توليد: "gynecology", حمل: "gynecology",
  // ENT
  nose: "ent", ear: "ent", throat: "ent", otolaryngology: "ent",
  انف: "ent", اذن: "ent", حنجره: "ent", حنجرة: "ent", الانف: "ent", الاذن: "ent",
  // ---------------------------------------------------------------------
  // The specialties below are the ones the P10 device testing actually hit.
  // Physical therapy is the one that failed outright.
  // ---------------------------------------------------------------------
  physiotherapy: "physicaltherapy", physio: "physicaltherapy",
  physical: "physicaltherapy", rehab: "physicaltherapy",
  rehabilitation: "physicaltherapy", kinesiotherapy: "physicaltherapy",
  علاج: "physicaltherapy", طبيعي: "physicaltherapy", طبيعى: "physicaltherapy",
  الطبيعي: "physicaltherapy", تاهيل: "physicaltherapy", التاهيل: "physicaltherapy",
  علاجطبيعي: "physicaltherapy", فيزيو: "physicaltherapy",
  // Neurology
  neurology: "neurology", neuro: "neurology", nerves: "neurology", brain: "neurology",
  مخ: "neurology", اعصاب: "neurology", الاعصاب: "neurology", عصبية: "neurology",
  // Psychiatry
  psychiatry: "psychiatry", psychiatric: "psychiatry", mental: "psychiatry",
  psychology: "psychiatry",
  نفسية: "psychiatry", نفسيه: "psychiatry", نفسي: "psychiatry", الطبالنفسي: "psychiatry",
  // Urology
  urology: "urology", urologist: "urology", kidney: "urology", kidneys: "urology",
  مسالك: "urology", المسالك: "urology", بولية: "urology", كلى: "urology", الكلى: "urology",
  // Gastroenterology
  gastroenterology: "gastroenterology", gastro: "gastroenterology",
  stomach: "gastroenterology", digestive: "gastroenterology",
  هضمي: "gastroenterology", الهضمي: "gastroenterology", معدة: "gastroenterology",
  معده: "gastroenterology", باطنة: "gastroenterology", باطنه: "gastroenterology",
  // Endocrinology
  endocrinology: "endocrinology", endocrine: "endocrinology", diabetes: "endocrinology",
  hormones: "endocrinology",
  غدد: "endocrinology", الغدد: "endocrinology", سكر: "endocrinology", صماء: "endocrinology",
  // Pulmonology
  pulmonology: "pulmonology", chest: "pulmonology", lungs: "pulmonology",
  respiratory: "pulmonology",
  صدر: "pulmonology", الصدر: "pulmonology", صدرية: "pulmonology", رئة: "pulmonology",
  // General / family medicine
  general: "generalmedicine", family: "generalmedicine", gp: "generalmedicine",
  internal: "generalmedicine",
  عام: "generalmedicine", عامة: "generalmedicine", اسرة: "generalmedicine",
  // Nutrition
  nutrition: "nutrition", dietician: "nutrition", dietitian: "nutrition", diet: "nutrition",
  تغذية: "nutrition", تغذيه: "nutrition", التغذية: "nutrition", رجيم: "nutrition",
  // Plastic / cosmetic
  plastic: "plasticsurgery", cosmetic: "plasticsurgery", aesthetic: "plasticsurgery",
  تجميل: "plasticsurgery", التجميل: "plasticsurgery",
  // Surgery
  surgery: "surgery", surgical: "surgery", surgeon: "surgery",
  جراحة: "surgery", جراحه: "surgery", الجراحة: "surgery",
  // Radiology and laboratory
  radiology: "radiology", imaging: "radiology", xray: "radiology", scan: "radiology",
  اشعة: "radiology", اشعه: "radiology", الاشعة: "radiology",
  laboratory: "laboratory", lab: "laboratory", labs: "laboratory",
  تحاليل: "laboratory", معمل: "laboratory", مختبر: "laboratory",
};

const ARABIC_LATIN: Record<string, string> = {
  ا: "a", أ: "a", إ: "a", آ: "a", ب: "b", ت: "t", ث: "th", ج: "j",
  ح: "h", خ: "kh", د: "d", ذ: "th", ر: "r", ز: "z", س: "s", ش: "sh",
  ص: "s", ض: "d", ط: "t", ظ: "z", ع: "a", غ: "gh", ف: "f", ق: "q",
  ك: "k", ل: "l", م: "m", ن: "n", ه: "h", و: "w", ي: "y", ى: "y",
  ة: "h", ء: "", ئ: "y", ؤ: "w",
};

function transliterate(value: string): string {
  return [...value].map((char) => ARABIC_LATIN[char] ?? char).join("");
}

/**
 * The words of a text, lower-cased, punctuation- and title-stripped, digits
 * folded. No concept substitution happens here — see `CONCEPT_LEXICON`.
 */
function entityWords(value: string): string[] {
  return normalizeDigits(normalizeHumanText(value))
    .toLocaleLowerCase("en")
    .replace(/[’']/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .filter((word) => {
      const bare = stripArticle(word);
      return !TITLE_WORDS.has(word) && !TITLE_WORDS.has(bare);
    });
}

/** The Arabic definite article, when the word still has letters left without it. */
function stripArticle(word: string): string {
  if (!word.startsWith("ال") || word.length <= 3) return word;
  return word.slice(2);
}

/**
 * The literal reading of a name: what the clinic actually stored, or what the
 * patient actually typed, with nothing swapped for anything else.
 *
 * Exported because the ordinal parser and the tests read it, and because "what
 * did this text normalize to?" is the first question asked whenever a match
 * looks wrong.
 */
export function normalizeEntityText(value: string): string {
  return transliterate(entityWords(value).join(" ")).replace(/\s+/g, " ").trim();
}

/**
 * The same text with the Arabic definite article removed from every word.
 *
 * A second *variant*, never a replacement: a department stored as "الأسنان" and
 * a patient typing "اسنان" are the same word, and a department stored as
 * "قسم ألفا" must still be reachable from "Department Alpha" — which it would
 * not be if `ألفا` were unconditionally shortened to `فا`. Scoring takes the
 * best of the variants, so neither case can cost the other anything.
 */
function normalizeEntityTextBare(value: string): string {
  return transliterate(entityWords(value).map(stripArticle).join(" "))
    .replace(/\s+/g, " ")
    .trim();
}

/** Every literal reading of a text, de-duplicated. */
function literalVariants(value: string): string[] {
  const full = normalizeEntityText(value);
  const bare = normalizeEntityTextBare(value);
  return bare && bare !== full ? [full, bare] : [full];
}

/**
 * The concepts a text names, if any. An empty set means "the lexicon has
 * nothing to say about this text", which is the normal case for an arbitrary
 * department name and is deliberately *not* an error.
 */
export function conceptKeys(value: string): Set<string> {
  const keys = new Set<string>();
  for (const word of entityWords(value)) {
    const bare = stripArticle(word);
    // A concept key is also a word a clinic may literally have named a
    // department. "Dermatology" is the canonical key *and* the most likely
    // stored name, so it has to name its own concept — otherwise the clinic
    // whose departments are spelled canonically is the one clinic the lexicon
    // cannot help, which is precisely backwards.
    const concept =
      CONCEPT_LEXICON[word] ??
      CONCEPT_LEXICON[bare] ??
      (CONCEPT_VALUES.has(word) ? word : CONCEPT_VALUES.has(bare) ? bare : null);
    if (concept) keys.add(concept);
  }
  return keys;
}

const CONCEPT_VALUES: ReadonlySet<string> = new Set(Object.values(CONCEPT_LEXICON));

/**
 * A crude consonant skeleton, for spellings that sound the same.
 *
 * `j → g` is here for the same reason `kh → x` is: it is a property of
 * transliteration, not of any particular word. Arabic ج is written `j` by the
 * table in this file and `g` by most of the Arab world, so "قسم جاما" and
 * "Gamma Unit" are the same department spelled by two conventions — and a
 * clinic that names its departments in one script while its patients type the
 * other is the ordinary case, not the exotic one.
 */
function phoneticKey(value: string): string {
  return value
    .replace(/ph/g, "f")
    .replace(/ou|oo/g, "u")
    .replace(/kh/g, "x")
    .replace(/gh/g, "g")
    .replace(/j/g, "g")
    .replace(/q/g, "k")
    .replace(/[aeiouy]/g, "")
    .replace(/(.)\1+/g, "$1");
}

/** How alike two single words are. */
function tokenSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const keyA = phoneticKey(a);
  const keyB = phoneticKey(b);
  if (keyA && keyA === keyB) return 0.96;
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length, 1);
}

const SOFT_TOKEN_MATCH = 0.9;

/**
 * The fuzzy analogue of substring containment: every word of the shorter name
 * has a near-identical word in the longer one.
 *
 * `a.includes(b)` already gives "Gamma" inside "Gamma Unit". This gives the
 * same answer when the two were typed in different scripts — "قسم جاما"
 * normalizes to `jama`, which is not a substring of `gamma unit` but is the
 * same word. Without it, a clinic can configure a department that its own
 * patients cannot name, which is exactly the class of failure this phase is
 * about.
 */
function softContains(a: string, b: string): boolean {
  const at = a.split(" ").filter(Boolean);
  const bt = b.split(" ").filter(Boolean);
  if (at.length === 0 || bt.length === 0) return false;
  const [short, long] = at.length <= bt.length ? [at, bt] : [bt, at];
  return short.every((token) =>
    long.some((other) => tokenSimilarity(token, other) >= SOFT_TOKEN_MATCH),
  );
}

function levenshtein(source: string, target: string): number {
  if (source === target) return 0;
  if (!source.length) return target.length;
  if (!target.length) return source.length;
  const previous = Array.from({ length: target.length + 1 }, (_, index) => index);
  for (let i = 1; i <= source.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= target.length; j += 1) {
      current[j] = Math.min(
        (current[j - 1] ?? 0) + 1,
        (previous[j] ?? 0) + 1,
        (previous[j - 1] ?? 0) + (source[i - 1] === target[j - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[target.length] ?? Math.max(source.length, target.length);
}

/** How alike two already-normalized literal strings are. */
function literalSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const keyA = phoneticKey(a);
  const keyB = phoneticKey(b);
  if (keyA && keyA === keyB) return 0.96;
  const distance = levenshtein(a, b);
  const edit = 1 - distance / Math.max(a.length, b.length);
  const aTokens = new Set(a.split(" "));
  const bTokens = new Set(b.split(" "));
  const overlap = [...aTokens].filter((token) => bTokens.has(token)).length;
  const tokenScore = overlap / Math.max(aTokens.size, bTokens.size, 1);
  const contains =
    a.includes(b) || b.includes(a) || softContains(a, b) ? 0.88 : 0;
  return Math.max(edit, tokenScore, contains);
}

/**
 * How alike two texts are *as written*: the best score over every literal
 * reading of each, and nothing else. The clinic's own name for a department
 * always scores 1 against itself here, whatever the lexicon thinks.
 */
export function literalScore(source: string, target: string): number {
  let best = 0;
  for (const a of literalVariants(source)) {
    for (const b of literalVariants(target)) {
      best = Math.max(best, literalSimilarity(a, b));
      if (best === 1) return 1;
    }
  }
  return best;
}

/**
 * How much the concept lexicon connects two texts, on a 0–1 scale.
 *
 * Zero whenever either side names no concept at all, which is the ordinary case
 * for an arbitrary department name — and, crucially, is not a penalty: this
 * number is only ever taken as a *maximum* against the literal score.
 */
function conceptScore(source: string, target: string): number {
  const a = conceptKeys(source);
  const b = conceptKeys(target);
  if (a.size === 0 || b.size === 0) return 0;
  const shared = [...a].filter((key) => b.has(key)).length;
  if (shared === 0) return 0;
  return shared / Math.max(a.size, b.size);
}

type Scored = { literal: number; score: number };

function scoreEntity(query: string, name: string): Scored {
  const literal = literalScore(query, name);
  return { literal, score: Math.max(literal, conceptScore(query, name)) };
}

function ordinalIndex(value: string): number | null {
  const raw = normalizeDigits(normalizeHumanText(value)).toLocaleLowerCase("en")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\b(?:option|choice|available|appointment|slot)\b/gu, "")
    .replace(/(?:الخيار|اختيار|متاح|موعد)/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  const normalized = normalizeEntityText(value);
  const map: Record<string, number> = {
    // Masculine, feminine and article-less spellings all mean the same
    // position. Egyptian Arabic writes ث as ت ("التاني", "التالت"), which is
    // how patients actually type it and was the spelling this table missed.
    first: 0, one: 0,
    الاول: 0, الأول: 0, اول: 0, أول: 0, الاولى: 0, الأولى: 0, اولى: 0, أولى: 0,
    second: 1, two: 1,
    الثاني: 1, ثاني: 1, الثانية: 1, ثانية: 1,
    التاني: 1, تاني: 1, التانية: 1, تانية: 1,
    third: 2, three: 2,
    الثالث: 2, ثالث: 2, الثالثة: 2, ثالثة: 2,
    التالت: 2, تالت: 2, التالتة: 2, تالتة: 2,
    fourth: 3, four: 3,
    الرابع: 3, رابع: 3, الرابعة: 3, رابعة: 3,
    // F-15 — Arabizi. A large share of patients type Egyptian Arabic in Latin
    // script, and "awel yom" is the single most ordinary way to answer a list of
    // days in it. Without these the whole register resolved to nothing and the
    // turn asked the same question again.
    awel: 0, awal: 0, "2awel": 0, el2awel: 0, elawel: 0,
    tany: 1, tani: 1, eltany: 1, altany: 1,
    talt: 2, talet: 2, eltalt: 2, altalt: 2,
    rabe3: 3, rabea: 3, elrabe3: 3,
  };
  if (raw in map) return map[raw]!;
  // "رقم ٢", "number 2", "no. 3" — a counting word in front of a digit is a
  // position, not a name. Stripped here so the digit below can be read.
  const counted = raw.replace(/^(?:رقم|نمرة|number|num|no)\s+/u, "").trim();
  if (counted !== raw && counted in map) return map[counted]!;
  const digits = normalizeDigits(counted).match(/^([1-9])(?:st|nd|rd|th)?$/)?.[1];
  if (digits) return Number(digits) - 1;
  const numeric = Number(normalized.match(/^([1-9])(?:st|nd|rd|th)?(?: option)?$/)?.[1]);
  return Number.isInteger(numeric) ? numeric - 1 : null;
}

/** Zero-based option selection for "second option", "أول موعد", or "٣". */
export function resolveOptionIndex(value: string): number | null {
  return ordinalIndex(value);
}

export function resolveNamedEntity(
  query: string,
  entities: readonly NamedEntity[],
): EntityResolution {
  const ordinal = ordinalIndex(query);
  if (ordinal !== null && entities[ordinal]) {
    return { status: "resolved", entity: entities[ordinal], score: 1 };
  }
  const ranked = entities
    .map((entity) => ({ ...entity, ...scoreEntity(query, entity.name) }))
    // The literal score is the tie-breaker, not a decoration. Two departments
    // the lexicon collapses onto one concept — "General Medicine" beside
    // "Internal Medicine" — are separated here and nowhere else, which is what
    // makes a department reachable by typing its own name.
    .sort(
      (a, b) =>
        b.score - a.score || b.literal - a.literal || a.name.localeCompare(b.name),
    );
  const best = ranked[0];
  if (!best || best.score < 0.58) {
    return { status: "not_found", candidates: ranked.slice(0, 3).map(publicScore) };
  }
  const second = ranked[1];
  const contested =
    Boolean(second) &&
    second!.score >= best.score - 0.1 &&
    second!.literal >= best.literal - 0.1;
  if (best.score < 0.78 || contested) {
    return {
      status: "ambiguous",
      candidates: ranked
        .filter((item) => item.score >= 0.58)
        .slice(0, 3)
        .map(publicScore),
    };
  }
  return { status: "resolved", entity: { id: best.id, name: best.name }, score: best.score };
}

function publicScore(item: NamedEntity & Scored): NamedEntity & { score: number } {
  return { id: item.id, name: item.name, score: item.score };
}

// ---------------------------------------------------------------------------
// P11C — the words a clinic's own rows put into play
// ---------------------------------------------------------------------------

/**
 * The vocabulary this clinic's departments occupy, as a set of lookup keys.
 *
 * P11C exists because of one production turn: a patient wrote
 * "عايز احجز لابني علاج طبيعي" — *"I want to book physical therapy for my son"*
 * — and the deterministic pre-model escalation classifier matched the bare noun
 * `علاج` ("treatment") and handed the thread to a human before the agent ever
 * ran. The word was not a request for clinical judgment. It was half the name
 * of a department the clinic sells appointments in.
 *
 * This function is how the classifier learns that, without learning anything
 * about physical therapy in particular. It takes whatever names the clinic's
 * `departments` rows actually carry — today's, and every one added later — and
 * returns the keys those names occupy: every normalized literal word, plus
 * every concept the lexicon maps those words onto. Nothing is hard-coded, no
 * department is privileged, and a clinic with no departments produces an empty
 * set, which suppresses nothing.
 *
 * It answers only "is this word part of what this clinic calls its own
 * departments?". It never grants a capability, never selects a doctor and never
 * chooses a department — `resolveNamedEntity` still does all of that, on the
 * same inputs, unchanged.
 */
export function buildClinicVocabulary(
  names: readonly (string | null | undefined)[],
): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const name of names) {
    if (typeof name !== "string" || !name.trim()) continue;
    for (const word of entityWords(name)) {
      const bare = stripArticle(word);
      keys.add(transliterate(word));
      keys.add(transliterate(bare));
    }
    for (const concept of conceptKeys(name)) keys.add(concept);
  }
  keys.delete("");
  return keys;
}

/** Whether a single word of free text belongs to `vocabulary`. */
export function isClinicVocabularyWord(
  word: string,
  vocabulary: ReadonlySet<string>,
): boolean {
  if (vocabulary.size === 0) return false;
  const words = entityWords(word);
  if (words.length === 0) return false;
  for (const item of words) {
    const bare = stripArticle(item);
    if (vocabulary.has(transliterate(item)) || vocabulary.has(transliterate(bare))) {
      return true;
    }
    const concept =
      CONCEPT_LEXICON[item] ??
      CONCEPT_LEXICON[bare] ??
      (CONCEPT_VALUES.has(item) ? item : CONCEPT_VALUES.has(bare) ? bare : null);
    if (concept && vocabulary.has(concept)) return true;
  }
  return false;
}

/**
 * The same text with every clinic-vocabulary word blanked out, character for
 * character, so offsets and lengths are preserved and nothing downstream has to
 * know masking happened.
 *
 * The blanks are spaces rather than a sentinel on purpose: a sentinel is a
 * token, and a token can be matched. A space cannot be mistaken for content.
 */
export function maskClinicVocabulary(
  text: string,
  vocabulary: ReadonlySet<string>,
): string {
  if (vocabulary.size === 0) return text;
  return text.replace(/[\p{L}\p{N}]+/gu, (word) =>
    isClinicVocabularyWord(word, vocabulary) ? " ".repeat(word.length) : word,
  );
}

/**
 * P11D — the same text with honorifics and category nouns removed, still in the
 * script the patient wrote it in.
 *
 * `normalizeEntityText` also transliterates, which is right for scoring a name
 * against a stored name and wrong for reading an ordinal: `التاني` becomes
 * `altany`, which no Arabic ordinal table can match. The offered-doctor
 * resolver needs the title stripped *without* the script changing, so that
 * "الدكتور التاني" reduces to "التاني" and reads as "the second one".
 *
 * Words only, never names: this cannot add, remove or substitute a doctor. It
 * returns a string, and every candidate it is used against still comes from the
 * authoritative roster.
 */
export function stripEntityTitles(value: string): string {
  return entityWords(value).join(" ");
}
