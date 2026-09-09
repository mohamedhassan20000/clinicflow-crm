/**
 * Reading a *partial* correction of a name that is already on the table.
 *
 * ## The defect this exists for
 *
 * From manual QA. The assistant had proposed an English spelling and asked the
 * patient to confirm it:
 *
 * ```
 *   assistant: كتبت الاسم كده: Saad Ibrahim — صح كده؟
 *   patient:   اسمه Soad اما Ibrahim انت كاتبها صح
 * ```
 *
 * The patient corrected **one component** and confirmed the other. Nothing in
 * the intake could represent that. `resolveIntakeField`'s `full_name_latin`
 * branch is a pure scrub of the current message — it keeps every Latin token in
 * the sentence and joins them — so it has no notion of the name it is
 * correcting. On this sentence it happened to produce the right string by
 * accident; on the shape the same patient used a moment later it does not:
 *
 * ```
 *   on file:   Mohamed Ahmed Hassan Ali
 *   patient:   Ahmed غلط، هو Ahmad والباقي صح
 *   scrubbed:  "Ahmed Ahmad"        ← filed as the patient's name
 * ```
 *
 * The only way out was to make the patient retype all four components.
 *
 * ## What this module is, and what it is not
 *
 * It is **interpretation**: pure, synchronous, no I/O, no model, no state. It
 * answers one question — *given the name currently on the table and this
 * sentence, which single component is being replaced, and by what?* — and it
 * answers it in one of three ways:
 *
 *   * `corrected` — the sentence pins exactly one component and exactly one
 *     replacement. The caller commits the substituted name through the ordinary
 *     slot path, with the ordinary validation behind it.
 *   * `ambiguous` — the sentence is plainly a partial correction and does *not*
 *     pin which component. The caller answers with the existing clarification,
 *     and nothing is written. **Never a guess.**
 *   * `none` — this is not a partial correction at all. The caller's existing
 *     behaviour is untouched, which is what keeps a full restatement of the
 *     name («لا خليه Ali Al Zahrani») working exactly as it did.
 *
 * ## Why it can be narrow enough to be safe
 *
 * Because it never fires on the message alone. Three independent things have to
 * be true before a substitution is even considered:
 *
 *   1. a multi-part name is already on the table;
 *   2. the message names at least one of *its own* components back — so a
 *      sentence that has nothing to do with the stored name cannot reach it;
 *   3. exactly one name-shaped token in the message is **not** one of those
 *      components — the replacement — and the message carries a correction or
 *      confirmation marker («غلط», «صح», "wrong", "correct").
 *
 * Two or more new tokens is a restatement, not a partial correction, and is
 * left to the caller. No marker at all is a restatement too.
 */

import { foldArabic } from "@/lib/ai/v2/normalize";

export type PartialNameCorrection =
  /** Not a partial correction. The caller's existing reading stands. */
  | { readonly kind: "none" }
  /** One component replaced. The whole name, with the substitution applied. */
  | { readonly kind: "corrected"; readonly value: string }
  /** Plainly a correction, and which component is not decidable. Ask. */
  | { readonly kind: "ambiguous" };

type Script = "latin" | "arabic";
type MarkerKind = "wrong" | "keep";

/**
 * How far from a name token a marker may sit and still be about it.
 *
 * Three words either side. «Ahmed غلط» is one away; «Ibrahim انت كاتبها صح» is
 * three. A marker further off than that is about something else in the
 * sentence, and reading it as this token's verdict is the guess this module
 * exists not to make.
 */
const MARKER_WINDOW = 3;

/** The script a name is written in. Decides which tokens can be part of it. */
function scriptOf(text: string): Script | null {
  if (/\p{Script=Latin}/u.test(text)) return "latin";
  if (/[؀-ۿ]/u.test(text)) return "arabic";
  return null;
}

/** A token reduced to the form two spellings of the same word share. */
function fold(token: string, script: Script): string {
  return script === "latin"
    ? token.toLowerCase().replace(/[^\p{Script=Latin}\p{Nd}]/gu, "")
    // Tatweel is decorative elongation and never distinguishes two words, but
    // it lives inside the Arabic block and so survives the class below. «لـ»
    // has to fold to «ل» or the link word in «عدل Omer لـ Omar» is unreadable.
    : foldArabic(token).replace(/\u0640/gu, "").replace(/[^؀-ۿ0-9]/gu, "");
}

/** Words, with the punctuation that separates them removed. */
function words(text: string): readonly string[] {
  return text
    .split(/[\s,،.؛;:!؟?"“”'‘’()[\]{}«»/\\|]+/u)
    .map((word) => word.trim())
    .filter(Boolean);
}

/**
 * The words that say a component is wrong, and the words that say it is right.
 *
 * Deliberately small and deliberately unambiguous. «لا» is not here: a bare
 * "no" precedes a full restatement at least as often as a partial correction,
 * and admitting it would turn «لا خليه Ali Al Zahrani» into a substitution.
 */
const WRONG_AR = new Set([
  "غلط",
  "غلطان",
  "غلطانه",
  "خطا",
  "مغلوط",
  "مغلوطه",
  "مش",
  "ليس",
  "مو",
]);
const KEEP_AR = new Set([
  "صح",
  "صحيح",
  "صحيحه",
  "تمام",
  "مظبوط",
  "مضبوط",
  "سليم",
  "سليمه",
  "الباقي",
  "باقي",
  "ماشي",
]);
const WRONG_EN = new Set([
  "wrong",
  "not",
  "isnt",
  "incorrect",
  "typo",
  "mistake",
  "misspelled",
  "mistyped",
  "misspelt",
]);
const KEEP_EN = new Set([
  "correct",
  "correctly",
  "right",
  "fine",
  "ok",
  "okay",
  "unchanged",
  "rest",
  "others",
  "stays",
  "same",
]);

/**
 * Words that are in the name's own script and are still not part of a name.
 *
 * Without this list «اسمه» would be scored as a fresh Arabic name token and
 * every Arabic sentence would look like a restatement. It holds the pronouns,
 * the verbs of writing, and the connectives a correction is phrased with —
 * nothing that could plausibly be somebody's given name.
 */
const NOT_A_NAME_AR = new Set([
  "اسمه",
  "اسمها",
  "اسمي",
  "الاسم",
  "اسم",
  "هو",
  "هي",
  "انا",
  "انت",
  "انتا",
  "انتي",
  "احنا",
  "كاتبها",
  "كاتبه",
  "كاتب",
  "كاتبين",
  "كتبتها",
  "كتبته",
  "كتبت",
  "اكتب",
  "اكتبها",
  "خليه",
  "خليها",
  "خلي",
  "غير",
  "غيرها",
  "عدل",
  "عدلها",
  "اما",
  "لكن",
  "بس",
  "يعني",
  "ده",
  "دا",
  "دي",
  "لا",
  "لأ",
  "ايوه",
  "اه",
  "في",
  "من",
  "على",
  "مع",
  "الاول",
  "الاولاني",
  "التاني",
  "الثاني",
  "التالت",
  "الثالث",
  "الاخير",
  "الرابع",
  "جزء",
  "الجزء",
  "كده",
  "كدا",
  "زي",
  "معلش",
  "طيب",
  "ممكن",
  "لو",
  "سمحت",
  "عايز",
  "عاوز",
  "و",
]);
const NOT_A_NAME_EN = new Set([
  "the",
  "a",
  "an",
  "is",
  "it",
  "its",
  "his",
  "her",
  "their",
  "my",
  "your",
  "you",
  "name",
  "names",
  "spelling",
  "spelled",
  "spelt",
  "wrote",
  "write",
  "written",
  "should",
  "be",
  "keep",
  "kept",
  "change",
  "fix",
  "just",
  "only",
  "and",
  "but",
  "no",
  "yes",
  "please",
  "first",
  "second",
  "third",
  "fourth",
  "last",
  "middle",
  "part",
  "all",
  "one",
  "of",
  "to",
  "as",
  "was",
  "are",
]);

function markerKind(folded: string, script: Script): MarkerKind | null {
  if (script === "latin") {
    if (WRONG_EN.has(folded)) return "wrong";
    if (KEEP_EN.has(folded)) return "keep";
    return null;
  }
  // «والباقي» is «الباقي» with the connective glued on, which is how the phrase
  // is actually typed. Stripping one leading و is not a guess about the word.
  const bare = folded.startsWith("و") && folded.length > 2 ? folded.slice(1) : folded;
  if (WRONG_AR.has(folded) || WRONG_AR.has(bare)) return "wrong";
  if (KEEP_AR.has(folded) || KEEP_AR.has(bare)) return "keep";
  return null;
}

/**
 * The words that *direct* a substitution rather than merely judging one.
 *
 * The marker reading below answers "which component did the patient say was
 * wrong?". This answers a different and much commoner sentence: "replace this
 * component with that one". «خليه», «عدل», «غير», "change", "make it" — an
 * imperative that names its own target, with no «غلط» and no «صح» anywhere in
 * the sentence.
 *
 * That shape was unreadable before. «عدل Omer لـ Omar» carries no marker at
 * all, so the marker reading declined it and the caller filed the whole
 * sentence; «Omer صح بس Alfarooq خليه Al Farouk» carries one, but the
 * replacement is *two* words and the marker reading admits exactly one.
 *
 * Small and imperative-only, for the same reason the marker lexicon is small:
 * a verb that is merely *about* names («كتبت», «اسمه», "spelled") does not
 * direct anything, and reading one as an instruction is the guess this module
 * exists not to make.
 */
const VERB_AR = new Set([
  "خليه",
  "خليها",
  "خلي",
  "خليهم",
  "عدل",
  "عدله",
  "عدلها",
  "غير",
  "غيره",
  "غيرها",
  "بدل",
  "بدله",
  "بدلها",
  "صحح",
  "صححه",
  "صححها",
  "اجعله",
  "اجعلها",
  "يبقي",
  "تبقي",
]);
const VERB_EN = new Set([
  "change",
  "changed",
  "make",
  "made",
  "replace",
  "replaced",
  "fix",
  "edit",
  "update",
  "should",
  "swap",
]);

/**
 * The words that may stand between a directed verb and its replacement.
 *
 * «لـ» in «عدل Omer لـ Omar», "to" in "change Ahmed to Ahmad", "be" in
 * "Alfarooq should be Al Farouk". They carry no meaning of their own here —
 * they are the join — and the leading form *requires* one, which is what keeps
 * «غير الاسم لـ Ali Al Zahrani» a restatement of the whole name rather than a
 * substitution of its first component.
 */
const LINK = new Set([
  "ل",
  "لل",
  "الي",
  "لتبقي",
  "لتصبح",
  "تبقي",
  "يبقي",
  "to",
  "into",
  "as",
  "be",
  "is",
  "it",
  "with",
]);

/** How far from a directed verb its target and its link may sit. */
const DIRECTIVE_WINDOW = 3;

function verbKind(folded: string, script: Script): boolean {
  if (script === "latin") return VERB_EN.has(folded);
  const bare = folded.startsWith("و") && folded.length > 2 ? folded.slice(1) : folded;
  return VERB_AR.has(folded) || VERB_AR.has(bare);
}

/**
 * One table for both scripts, deliberately.
 *
 * A join word is read in its own script and the two sets cannot collide — no
 * Arabic word folds to "to" and no Latin one to «ل» — so splitting them would
 * be two tables to keep in step for no gain.
 */
function isLink(folded: string): boolean {
  return LINK.has(folded);
}

function isNameShaped(folded: string, script: Script): boolean {
  if (folded.length < 2) return false;
  if (/\d/u.test(folded)) return false;
  return script === "latin" ? !NOT_A_NAME_EN.has(folded) : !NOT_A_NAME_AR.has(folded);
}

/**
 * Reads this message as a partial correction of `current`, or declines to.
 *
 * `current` is the name the assistant put in front of the patient — the value
 * committed to the slot, or the spelling it is holding an open proposal for.
 * The caller supplies it; this function never goes looking for one.
 */
export function readPartialNameCorrection(input: {
  current: string;
  spoken: string;
}): PartialNameCorrection {
  const current = input.current.replace(/\s+/gu, " ").trim();
  const components = current ? current.split(" ") : [];
  // A single-part name has no "which part" to be wrong about.
  if (components.length < 2) return { kind: "none" };
  const script = scriptOf(current);
  if (!script) return { kind: "none" };

  const foldedComponents = components.map((component) => fold(component, script));
  const spokenWords = words(input.spoken);
  if (spokenWords.length === 0) return { kind: "none" };

  /** Every word, in order, classified once so adjacency can be read off it. */
  const scanned = spokenWords.map((word) => {
    const inScript = scriptOf(word) === script;
    const folded = fold(word, script);
    // Markers, verbs and links are read in the word's *own* script, not the
    // name's, so «عدل» and «لـ» are still an instruction and a join when the
    // name being corrected is written in Latin.
    const ownScript = scriptOf(word) ?? script;
    const ownFolded = fold(word, ownScript);
    const marker = markerKind(ownFolded, ownScript);
    const verb = verbKind(ownFolded, ownScript);
    const link = isLink(ownFolded);
    return {
      folded,
      marker,
      verb,
      link,
      // A name token has to be in the name's own script, has to look like a
      // name, and must not itself be one of the marker or instruction words.
      // Without the verb exclusion "make" and "replace" are scored as fresh
      // English name tokens, and "change Ahmed to Ahmad" looks like a
      // restatement carrying two new names.
      isName: inScript && marker === null && !verb && isNameShaped(folded, script),
    };
  });

  // Reading zero: an explicit instruction. «Alfarooq خليه Al Farouk», «عدل
  // Omer لـ Omar», "change Ahmed to Ahmad". Read first because it pins its own
  // target and delimits its own replacement, so it is both stricter than the
  // marker reading below and able to accept a replacement of more than one
  // word — which the marker reading cannot, and must not.
  const directed = readDirectedCorrection({
    components,
    foldedComponents,
    spokenWords,
    scanned,
    script,
  });
  if (directed) return directed;

  const matched: { at: number; folded: string }[] = [];
  const fresh: string[] = [];
  scanned.forEach((entry, at) => {
    if (!entry.isName) return;
    if (foldedComponents.includes(entry.folded)) matched.push({ at, folded: entry.folded });
    else fresh.push(entry.folded);
  });

  // Gate one: the message has to name part of the stored name back. Without
  // this, any sentence at all could reach the substitution below.
  if (matched.length === 0) return { kind: "none" };
  // Gate two: exactly one replacement. None is a bare confirmation; two or more
  // is a restatement of the whole name, which the caller already handles.
  if (fresh.length !== 1) return { kind: "none" };
  // Gate three: the patient has to have said that something is wrong or that
  // something is right. Two bare name tokens are a restatement, not a verdict.
  if (!scanned.some((entry) => entry.marker !== null)) return { kind: "none" };

  const replacementIndex = spokenWords.findIndex(
    (word) => scriptOf(word) === script && fold(word, script) === fresh[0],
  );
  const replacement = replacementIndex >= 0 ? spokenWords[replacementIndex]! : null;
  if (!replacement) return { kind: "none" };

  const verdicts = matched.map((entry) => ({
    ...entry,
    verdict: nearestMarker(scanned, entry.at),
  }));

  // Reading one: the patient named the wrong component. «Ahmed غلط، هو Ahmad».
  const condemned = verdicts.filter((entry) => entry.verdict === "wrong");
  if (condemned.length === 1) {
    return substitute(components, foldedComponents, condemned[0]!.folded, replacement);
  }
  if (condemned.length > 1) return { kind: "ambiguous" };

  // Reading two: the patient named the components that are *right*, and the
  // one they did not name is the one being replaced. «Ibrahim انت كاتبها صح».
  if (verdicts.every((entry) => entry.verdict === "keep")) {
    const confirmed = new Set(verdicts.map((entry) => entry.folded));
    const remaining = foldedComponents.filter((component) => !confirmed.has(component));
    if (remaining.length === 1) {
      return substitute(components, foldedComponents, remaining[0]!, replacement);
    }
    // More than one component unaccounted for: the sentence does not say which
    // of them the replacement is for.
    return { kind: "ambiguous" };
  }

  // A marker is present and it attaches to nothing this function can pin.
  return { kind: "ambiguous" };
}

/**
 * The nearest marker within {@link MARKER_WINDOW}, or null.
 *
 * Nearest rather than first, because «Ahmed غلط، هو Ahmad والباقي صح» carries
 * both verdicts and only one of them is about `Ahmed`.
 */
function nearestMarker(
  scanned: readonly { marker: MarkerKind | null }[],
  at: number,
): MarkerKind | null {
  let best: MarkerKind | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = at - MARKER_WINDOW; index <= at + MARKER_WINDOW; index += 1) {
    if (index === at || index < 0 || index >= scanned.length) continue;
    const marker = scanned[index]!.marker;
    if (!marker) continue;
    const distance = Math.abs(index - at);
    if (distance < bestDistance) {
      best = marker;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Puts `replacement` where the named component was, and returns the whole name.
 *
 * A folded form that matches two components — a name that genuinely repeats a
 * part — pins nothing, and is answered by asking rather than by picking the
 * first one.
 */
function substitute(
  components: readonly string[],
  foldedComponents: readonly string[],
  target: string,
  replacement: string,
): PartialNameCorrection {
  const positions = foldedComponents.flatMap((component, index) =>
    component === target ? [index] : [],
  );
  if (positions.length !== 1) return { kind: "ambiguous" };
  const next = [...components];
  next[positions[0]!] = replacement;
  return { kind: "corrected", value: next.join(" ") };
}

/** One word, as {@link readPartialNameCorrection} classified it. */
type Scanned = {
  readonly folded: string;
  readonly marker: MarkerKind | null;
  readonly verb: boolean;
  readonly link: boolean;
  readonly isName: boolean;
};

/**
 * Reads an explicit instruction to replace one component, or declines to.
 *
 * ## The two shapes, and why each needs its own guard
 *
 * **Trailing** — the component comes first: «Alfarooq خليه Al Farouk»,
 * "Alfarooq should be Al Farouk". The verb sits between the target and the
 * replacement, so the target is the nearest stored component *before* it and
 * the replacement is the run of new words after it.
 *
 * **Leading** — the verb comes first: «عدل Omer لـ Omar», "change Ahmed to
 * Ahmad". Here the verb is followed by the target, and a **link word is
 * required** between the target and the replacement. That requirement is the
 * whole guard: without it «غير الاسم لـ Ali Al Zahrani» — a restatement of the
 * entire name — reads as "replace Ali with Al Zahrani" and files
 * "Al Zahrani Alzahrani". With it, the sentence has no link after its target
 * and falls through to the caller's existing full-restatement reading, which is
 * correct and unchanged.
 *
 * ## Why the replacement may be more than one word here
 *
 * Because this shape delimits it and the marker shape does not. «Alfarooq خليه
 * Al Farouk» says where the replacement starts — immediately after the
 * instruction — and it runs until a word that is not a new name-shaped token.
 * The marker reading has no such boundary: two new tokens in «Ahmed غلط، هو
 * Ahmad Hassan» could be one two-word replacement or a restatement of two
 * components, so it still admits exactly one and is deliberately untouched.
 *
 * ## What it returns
 *
 *   * a substitution, when one component is pinned and a replacement is found;
 *   * `ambiguous` when the instruction pins a component that appears **twice**
 *     in the stored name, and when it names a target but supplies no
 *     replacement at all. Both ask; neither guesses;
 *   * `null` when this is not a directed correction, leaving every existing
 *     reading exactly as it was.
 */
function readDirectedCorrection(input: {
  components: readonly string[];
  foldedComponents: readonly string[];
  spokenWords: readonly string[];
  scanned: readonly Scanned[];
  script: Script;
}): PartialNameCorrection | null {
  const { components, foldedComponents, spokenWords, scanned } = input;
  const isComponent = (at: number): boolean =>
    scanned[at]!.isName && foldedComponents.includes(scanned[at]!.folded);
  const isFreshName = (at: number): boolean =>
    scanned[at]!.isName && !foldedComponents.includes(scanned[at]!.folded);

  for (let verbAt = 0; verbAt < scanned.length; verbAt += 1) {
    if (!scanned[verbAt]!.verb) continue;

    // Trailing: the nearest stored component before the verb.
    let target: number | null = null;
    let from: number | null = null;
    for (let at = verbAt - 1; at >= Math.max(0, verbAt - DIRECTIVE_WINDOW); at -= 1) {
      if (isComponent(at)) {
        target = at;
        from = verbAt + 1;
        break;
      }
    }

    // Leading: the verb, then the component, then the link that joins it to the
    // replacement. Only tried when the trailing shape found nothing, so a
    // sentence that is both is read the way it was written.
    let bare = false;
    if (target === null) {
      for (
        let at = verbAt + 1;
        at < Math.min(scanned.length, verbAt + 1 + DIRECTIVE_WINDOW);
        at += 1
      ) {
        if (!isComponent(at)) continue;
        let joined = false;
        let blocked = false;
        for (let l = at + 1; l < Math.min(scanned.length, at + 3); l += 1) {
          if (scanned[l]!.link) {
            target = at;
            from = l + 1;
            joined = true;
            break;
          }
          // A new name before the link is a restatement, not a join.
          if (scanned[l]!.isName) {
            blocked = true;
            break;
          }
        }
        // «عدل Alfarooq» — the instruction names a component of the stored name
        // and then stops. There is nothing to substitute, and the sentence is
        // still plainly a correction: falling through would let the caller
        // scrub it and file the instruction itself as the patient's name.
        if (!joined && !blocked && at + 1 >= scanned.length) bare = true;
        break;
      }
    }
    if (bare) return { kind: "ambiguous" };
    if (target === null || from === null) continue;

    // Step over the join words — «لـ», "to", "be" — to reach the replacement.
    // Landing on a stored component instead means the sentence restates the
    // name rather than substituting into it, and this reading declines.
    let start = from;
    let skipped = 0;
    while (start < scanned.length && !isFreshName(start) && skipped < DIRECTIVE_WINDOW) {
      if (isComponent(start)) return null;
      start += 1;
      skipped += 1;
    }
    if (start >= scanned.length || !isFreshName(start)) {
      // «عدل الاسم» — an instruction with no value in it. Asking is the answer;
      // falling through would let the caller file the instruction as a name.
      return { kind: "ambiguous" };
    }

    // The replacement: consecutive new name-shaped words, capped so a whole
    // trailing sentence cannot become one component.
    const parts: string[] = [];
    for (let at = start; at < scanned.length && parts.length < 3; at += 1) {
      if (!isFreshName(at)) break;
      parts.push(spokenWords[at]!);
    }
    return substitute(components, foldedComponents, scanned[target]!.folded, parts.join(" "));
  }
  return null;
}
