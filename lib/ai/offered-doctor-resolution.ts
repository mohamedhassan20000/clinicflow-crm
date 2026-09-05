/**
 * P11D — reading a doctor reply against the roster that was actually offered.
 *
 * ## The turn this exists for
 *
 * The assistant offered a department's authoritative roster and asked "تحب
 * تحجز مع مين؟". The patient answered with one word — a first name, an
 * ordinal, a transliteration. That word is not a clinic-wide search query. It
 * is a *selection from a list the server just put in front of them*, and the
 * only correct place to resolve it is against that list.
 *
 * Resolving it clinic-wide instead is what produces the two failures this
 * module removes: a first name that matches nobody in the whole clinic falls
 * through to "I didn't understand", and a first name shared by two doctors in
 * different departments becomes ambiguous even when only one of them was ever
 * offered.
 *
 * ## What it is not allowed to do
 *
 * This module is **pure** and it is **closed-world**. It takes the offered
 * roster as an argument and returns one of its members or nothing at all.
 * There is no database handle, no clinic id, no directory load, and therefore
 * no way for it to name a doctor who was not offered — the same property
 * `assertRosterAuthority` enforces for the presentation layer, obtained here
 * structurally rather than by a check.
 *
 * It also knows no doctor names, no department names and no clinic's
 * vocabulary. Every judgement is made by `resolveNamedEntity`, against
 * candidates supplied by the caller, so a clinic that hires somebody tomorrow
 * is handled by the same code path as one that hired somebody last year.
 */

import {
  normalizeEntityText,
  resolveNamedEntity,
  resolveOptionIndex,
  stripEntityTitles,
  type NamedEntity,
} from "@/lib/ai/entity-resolution";

export type OfferedDoctorResolution =
  /** Exactly one offered doctor is meant. */
  | { status: "resolved"; doctor: NamedEntity }
  /** More than one offered doctor fits; only these need disambiguating. */
  | { status: "ambiguous"; candidates: readonly NamedEntity[] }
  /**
   * Nothing in the offered roster fits.
   *
   * Deliberately distinct from "ambiguous", because the two have different
   * correct answers: ambiguity asks a narrow question, no-match re-states the
   * authoritative roster. Neither one restarts the department flow — that is
   * the whole point of the distinction.
   */
  | { status: "no_match" };

/**
 * Which offered doctor the patient just chose, if any.
 *
 * The order of the two passes matters and is the specification:
 *
 *   1. **Ordinal**, against the roster *in the order it was offered*. "الأول"
 *      means the first name in the sentence the patient read, and that is the
 *      only reading of it that can ever be right. Titles are stripped first so
 *      that "الدكتور التاني" still reads as an ordinal rather than as a
 *      hopeless name query.
 *   2. **Name**, against the offered members only.
 *
 * An ordinal that points past the end of the roster is *not* silently clamped
 * and is *not* treated as a name — "رقم 5" against a two-doctor roster is a
 * misunderstanding, and answering it with doctor two would be inventing a
 * choice the patient did not make. It falls through to `no_match`, which
 * re-states the real roster.
 */
export function resolveOfferedDoctor(input: {
  patientText: string | null | undefined;
  /** The roster as offered, in the order it was presented. */
  offered: readonly NamedEntity[];
}): OfferedDoctorResolution {
  const text = (input.patientText ?? "").trim();
  if (!text || input.offered.length === 0) return { status: "no_match" };

  const ordinal = resolveOptionIndex(stripEntityTitles(text) || text);
  if (ordinal !== null) {
    const picked = input.offered[ordinal];
    return picked ? { status: "resolved", doctor: picked } : { status: "no_match" };
  }

  const resolution = resolveNamedEntity(text, [...input.offered]);
  if (resolution.status === "resolved") {
    return { status: "resolved", doctor: resolution.entity };
  }
  if (resolution.status === "ambiguous") {
    // `resolveNamedEntity` returns its candidates already filtered to the ones
    // that actually scored; a single survivor is a selection, not a question.
    const candidates = resolution.candidates.map((item) => ({
      id: item.id,
      name: item.name,
    }));
    if (candidates.length === 1) {
      return { status: "resolved", doctor: candidates[0]! };
    }
    return candidates.length > 1
      ? { status: "ambiguous", candidates }
      : { status: "no_match" };
  }
  return skeletonPass(text, input.offered);
}

/**
 * The consonant skeleton of a transliterated name.
 *
 * Arabic script writes long vowels and omits short ones, so `يوسف`
 * transliterates to `ywsf` while the clinic stored the Latin spelling
 * `Youssef` — an edit distance wide enough that literal scoring returns 0.25
 * and the name does not match itself across the two scripts. The vowels are
 * exactly the information the Arabic spelling never had, so the fix is to stop
 * comparing them: drop `a e i o u`, drop the `w`/`y` that stand in for `و`/`ي`
 * when they are not word-initial, and collapse doubled letters (`ss` → `s`).
 *
 *   `ywsf`    → `ysf`
 *   `youssef` → `ysf`
 *
 * ## Why this is safe here and is deliberately not in `literalScore`
 *
 * A skeleton is a *lossy* key: it will happily equate two genuinely different
 * names. That is unacceptable for clinic-wide resolution, where the candidate
 * set is every doctor and every department and a false match reaches a
 * stranger's record. It is acceptable here for one structural reason — the
 * candidate set is the roster the server offered on the previous turn, at most
 * a couple of dozen entries the patient has just read. The worst outcome is
 * selecting the wrong doctor *from a list the patient was shown*, which they
 * can see in the reply and correct. It can never name somebody who was not
 * offered, because it only ever returns members of `offered`.
 *
 * Collisions are handled rather than ignored: two offered doctors sharing a
 * skeleton produce `ambiguous`, not an arbitrary pick.
 */
function nameSkeleton(value: string): string {
  const normalized = normalizeEntityText(value);
  if (!normalized) return "";
  return normalized
    .split(/\s+/)
    .map((word) =>
      word
        .split("")
        .filter((letter, index) =>
          index === 0 ? true : !"aeiouwy".includes(letter),
        )
        .join("")
        .replace(/(.)\1+/g, "$1"),
    )
    .filter(Boolean)
    .join(" ");
}

/**
 * The cross-script pass, run only after literal and concept scoring have both
 * failed. Matches the query against each offered doctor's *whole* name and
 * against each of its parts, so a patient answering the roster with a bare
 * first name resolves the same way a full name does.
 */
function skeletonPass(
  text: string,
  offered: readonly NamedEntity[],
): OfferedDoctorResolution {
  const query = nameSkeleton(text);
  if (!query) return { status: "no_match" };
  const hits = offered.filter((doctor) => {
    const full = nameSkeleton(doctor.name);
    if (full === query) return true;
    return full.split(" ").some((part) => part === query);
  });
  if (hits.length === 1) return { status: "resolved", doctor: hits[0]! };
  if (hits.length > 1) return { status: "ambiguous", candidates: hits };
  return { status: "no_match" };
}

/**
 * Whether the patient's message asks to *change department*, as opposed to
 * naming a doctor.
 *
 * This is the one and only condition under which the booking flow is allowed
 * to move backwards from `selecting_doctor` to `selecting_department`, so it is
 * written to be hard to satisfy by accident. Two things must both be true:
 *
 *   1. The message resolves to one of the clinic's departments, and
 *   2. that department is not the one already selected.
 *
 * A bare doctor name cannot satisfy (1) — it resolves against departments and
 * finds nothing — which is the structural reason "حنين" can no longer restart
 * the flow. A patient who names the department they are *already* in ("أيوه
 * علاج طبيعي") cannot satisfy (2), so confirming the current department is a
 * no-op rather than a reset.
 */
export function resolveDepartmentChange(input: {
  patientText: string | null | undefined;
  departments: readonly NamedEntity[];
  currentDepartmentId: string | null;
}): NamedEntity | null {
  const text = (input.patientText ?? "").trim();
  if (!text || input.departments.length === 0) return null;
  // A bare ordinal is never a department choice.
  //
  // `resolveNamedEntity` reads an ordinal positionally against whatever list it
  // is handed, so "الأول" against the department list resolves to *department
  // one* — and a patient who types it is almost always answering the roster
  // question that was actually asked ("تحب تحجز مع مين؟"). Letting the ordinal
  // through here reintroduced the exact defect P11D exists to remove: a reply
  // meant to pick a doctor silently switched department instead.
  if (resolveOptionIndex(stripEntityTitles(text) || text) !== null) return null;
  const resolution = resolveNamedEntity(text, [...input.departments]);
  if (resolution.status !== "resolved") return null;
  if (resolution.entity.id === input.currentDepartmentId) return null;
  return resolution.entity;
}
