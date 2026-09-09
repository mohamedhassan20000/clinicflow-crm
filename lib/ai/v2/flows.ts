/**
 * The flow definitions: ClinicFlow's business logic, as data.
 *
 * ## How to read this file
 *
 * Each flow is an ordered list of steps. The engine runs the first step whose
 * slot is empty, after checking that step's declared preconditions against the
 * frame's own committed slots and the proven identity level. A step's `run`
 * asks an authoritative tool a question and returns what to put in front of the
 * patient; it never decides what the patient meant and never writes flow state.
 *
 * ## The rule that keeps this from becoming the next patch surface
 *
 * **A step's `run` may branch on server facts. It may never branch on the
 * patient's words.** Reading the message is the interpreter's job and it has
 * already happened; by the time any code here executes, the turn is a validated
 * command list. Every `if` below is therefore about data — is this patient
 * linked, did that read return rows, has the summary been affirmed — and none
 * of them is about phrasing. That is the difference from the engine this
 * replaces, where twelve regex readers ran before the model and five of them
 * could mutate the conversation.
 */

import "server-only";

import type {
  FlowDefinition,
  SlotResolution,
  StepOutcome,
} from "@/lib/ai/v2/flow-definition";
import type { FlowRegistry } from "@/lib/ai/v2/engine";
import { activeFrame, type FlowFrame } from "@/lib/ai/v2/flow-state";
import type { TurnContext } from "@/lib/ai/v2/context";
import * as tools from "@/lib/ai/v2/tools";
// Imported directly rather than through `tools`, because it is pure and a test
// that stubs the tool layer must still exercise the real name matching.
import {
  resolveInsuranceProvider,
  resolvePackageNamed,
} from "@/lib/ai/v2/catalog";
import { proposeLatinName } from "@/lib/ai/name-transliteration";
import { readPartialNameCorrection } from "@/lib/ai/v2/name-correction";
import {
  contactEmailValue,
  readsAsOwnEmailReference,
} from "@/lib/ai/v2/self-email-reference";
import {
  participantPhone,
  readsAsOwnNumberReference,
} from "@/lib/ai/v2/self-phone-reference";
import {
  dayMonthFromSpoken,
  dayOfMonthFromSpoken,
  foldArabic,
  fullDateReadings,
  normalizeBeneficiary,
  normalizeSpokenDate,
  normalizeSpokenTime,
  parseDateLowerBound,
  relativeDayFromSpoken,
  weekdayFromSpoken,
} from "@/lib/ai/v2/normalize";
import {
  formatOfferedDay,
  formatOfferedTime,
  renderInsuranceList,
  renderPackageDetail,
  renderPackageGroups,
  renderServiceGroups,
  renderSummary,
  weekdayIndex,
} from "@/lib/ai/v2/present";
import { tooSoonReason } from "@/lib/booking/lead-time";
import { formatInTimeZone } from "date-fns-tz";

/** Reads a committed slot's canonical value, or null. */
function slot(frame: FlowFrame, name: Parameters<typeof frameSlot>[1]): string | null {
  return frameSlot(frame, name);
}
function frameSlot(
  frame: FlowFrame,
  name:
    | "department"
    | "doctor"
    | "day"
    | "time"
    | "beneficiary"
    | "beneficiary_name"
    | "date_lower_bound"
    | "full_name"
    | "full_name_latin"
    | "national_id"
    | "date_of_birth"
    | "email"
    | "phone"
    | "gender"
    | "blood_type"
    | "service"
    | "package"
    | "document"
    | "appointment",
): string | null {
  const value = frame.slots[name]?.value;
  return value === undefined ? null : String(value);
}

/**
 * Matches the patient's words against the times the *server* offered.
 *
 * Normalization proposes readings; this decides nothing on its own. A reading
 * that no offered slot carries is not a time, and two offered slots matching
 * two readings of the same words is an ambiguity the flow asks about. That
 * ordering is the whole safety property: «12 وربع» can only ever become a
 * booking at a moment the clinic's calendar already had free.
 */
function matchOfferedTimes<T extends { value: string; label: string }>(
  times: readonly T[],
  spoken: string,
): T[] {
  const wanted = spoken.trim();
  const literal = times.filter(
    (time) => time.value === wanted || time.label === wanted,
  );
  if (literal.length > 0) return literal;
  const normalized = normalizeSpokenTime(spoken);
  if (normalized.kind !== "times") return [];
  const candidates = new Set(normalized.times);
  return times.filter(
    (time) => candidates.has(time.value) || candidates.has(time.label),
  );
}

/**
 * The same discipline for days, over every way a patient names one.
 *
 * The rule is unchanged and is the whole safety property: **the words have to
 * land on a day the calendar returned before they are a day at all.** Nothing
 * below constructs a date; each reading is a filter over the offered set, so a
 * weekday the doctor does not work, a date outside the window and a month the
 * patient guessed all match nothing rather than becoming a booking.
 *
 * The readings are tried in order of how specific they are, and the first one
 * that matches anything wins. That ordering is what keeps a full date from
 * being overruled by the bare number inside it: «08-09-2026» is a date, not the
 * eighth of whatever month happens to be on offer.
 *
 *   1. the exact canonical value, or the exact label the patient was shown;
 *   2. a full date — `2026-09-08`, `08-09-2026`, `8/9/2026`;
 *   3. a day and a named month — «8 سبتمبر»;
 *   4. a weekday — «الثلاثاء», «يوم الثلاثاء», "Tuesday";
 *   5. a bare day-of-month — «يوم ١٠», "10".
 *
 * A reading that matches two offered days returns both, and the engine asks
 * which. Numeric *selection from the open offer* — "2" meaning the second line
 * of the list — is resolved before any of this, by the engine, against the
 * offer itself; see `resolveOfferIndex`.
 */
function matchOfferedDays<T extends { value: string; label: string }>(
  days: readonly T[],
  spoken: string,
): T[] {
  const wanted = spoken.trim();
  const literal = days.filter((day) => day.value === wanted || day.label === wanted);
  if (literal.length > 0) return literal;

  const fullDates = new Set(fullDateReadings(spoken));
  if (fullDates.size > 0) {
    const matches = days.filter((day) => fullDates.has(day.value));
    if (matches.length > 0) return matches;
  }

  const dayMonth = dayMonthFromSpoken(spoken);
  if (dayMonth) {
    const matches = days.filter(
      (day) =>
        Number(day.value.slice(5, 7)) === dayMonth.month &&
        Number(day.value.slice(8, 10)) === dayMonth.day,
    );
    if (matches.length > 0) return matches;
  }

  const weekday = weekdayFromSpoken(spoken);
  if (weekday !== null) {
    const matches = days.filter((day) => weekdayIndex(day.value) === weekday);
    if (matches.length > 0) return matches;
  }

  const dayOfMonth = dayOfMonthFromSpoken(spoken);
  if (dayOfMonth === null) return [];
  return days.filter((day) => Number(day.value.slice(-2)) === dayOfMonth);
}

/**
 * A committed day or time, written the way the patient was shown it.
 *
 * The slot's own `label` when it has one — it was minted by the offer the
 * patient answered — and the same formatter otherwise, so a value that arrived
 * by any other route still reads as a date rather than as an ISO string.
 */
function bookingDayLabel(frame: FlowFrame, context: TurnContext): string | null {
  const value = frameSlot(frame, "day");
  if (!value) return null;
  return frame.slots.day?.label ?? formatOfferedDay(value, context.turn.locale);
}

function bookingTimeLabel(frame: FlowFrame, context: TurnContext): string | null {
  const value = frameSlot(frame, "time");
  if (!value) return null;
  return (
    frame.slots.time?.label ??
    formatOfferedTime(value, context.turn.locale, context.clinic.timeFormat)
  );
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

/**
 * Validation for the intake fields, per slot.
 *
 * Shared by the booking flow's intake step and the registration flow, so a name
 * is accepted on the same terms wherever it is asked for. Every branch is a
 * *shape* check — the authority on whether a national id names anybody is the
 * database, and the authority on whether a date of birth is the right one is
 * the patient, who is shown the normalized reading and asked.
 */
async function resolveIntakeField(input: {
  spoken: string;
  slot: string;
  /**
   * Present whenever a step calls this as its `resolveValue`, absent when a
   * test calls it directly. Read by the date-of-birth branch for the clinic's
   * own today, by the two name branches for the name currently on the table
   * (see `nameOnTheTable`), and by the phone branch for the address this
   * conversation is being held on.
   */
  context?: TurnContext;
  /**
   * The live frame, as the engine holds it while resolving. Read only by the
   * phone branch, and only to confirm that this is an explicit third-party
   * intake before an own-number reference means anything.
   */
  frame?: FlowFrame;
}): Promise<SlotResolution> {
  const spoken = input.spoken.trim();
  switch (input.slot) {
    case "full_name": {
      // A correction of one component of the name already on the table, when
      // the sentence pins which one. See `partialNameCorrection` — a message
      // that is not one of those falls straight through to the reading below,
      // so a name given for the first time and a full restatement are both
      // unchanged.
      const partial = partialNameCorrection(input);
      if (partial) return partial;
      // Two parts, because a clinic file needs a name a person can be called
      // by and "احمد" alone is not one.
      const cleaned = spoken.replace(/\s+/g, " ");
      if (cleaned.length < 3 || cleaned.split(" ").length < 2) {
        return { kind: "unresolved" };
      }
      if (!/[\p{L}]/u.test(cleaned)) return { kind: "unresolved" };
      return { kind: "resolved", value: cleaned, label: cleaned };
    }
    case "full_name_latin": {
      // «اسمه Soad اما Ibrahim انت كاتبها صح» — one component wrong, the rest
      // confirmed. Read before the scrub below, which keeps *every* Latin word
      // in the sentence and would therefore file «Ahmed غلط، هو Ahmad» as
      // "Ahmed Ahmad". Only fires when the sentence names part of the proposal
      // back and pins a single replacement; everything else falls through.
      const partial = partialNameCorrection(input);
      if (partial) return partial;
      // The English spelling, out of a sentence that may be mostly Arabic.
      //
      // «لا خليه Ali Al Zahrani» is a correction of the proposal and its
      // answer is the Latin part alone: storing the whole sentence would put
      // «لا خليه» in the English name column of a medical file. Only
      // Latin-script words survive, so a reply with no English in it at all is
      // unresolved — which re-asks for the spelling instead of filing the
      // refusal as a name.
      const latin = spoken
        .replace(/[^\p{Script=Latin}\p{Nd}'\-. ]+/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (latin.length < 3 || latin.split(" ").length < 2) {
        return { kind: "unresolved" };
      }
      if (!/\p{Script=Latin}/u.test(latin)) return { kind: "unresolved" };
      return { kind: "resolved", value: latin, label: latin };
    }
    case "national_id": {
      const digits = foldArabic(spoken).replace(/[^0-9]/g, "");
      return digits.length >= 10 && digits.length <= 20
        ? { kind: "resolved", value: digits }
        : { kind: "unresolved" };
    }
    case "date_of_birth": {
      // Day-month-year, because that is how this clinic's patients write a
      // date. `2.4.2003` is the second of April and nothing else; offering it
      // back beside `2003-02-04` asked the patient to choose between their own
      // convention and a foreign one, and manual QA produced the loop that
      // follows — the same two lines, four times, with no exit.
      //
      // Month-first is still reachable, as the fallback for digits day-first
      // cannot read (`12/25/1990`). See `DateReadingOptions`.
      const parsed = normalizeSpokenDate(spoken, { order: "day_first" });
      if (parsed.kind !== "dates") return { kind: "unresolved" };
      const date = parsed.dates[0];
      if (!date) return { kind: "unresolved" };
      // A birth date in the future is not a reading the patient can confirm
      // into a file: `stage_patient_intake_from_conversation` rejects it
      // outright, and a hard staging failure is a handoff. Refusing it here is
      // one more question instead.
      const today = input.context
        ? formatInTimeZone(
            input.context.now,
            input.context.clinic.timeZone,
            "yyyy-MM-dd",
          )
        : null;
      if (today && date > today) return { kind: "unresolved" };
      // Exactly one reading, so the slot is committed and the intake advances
      // once. There is no second candidate to choose between and no question
      // to re-ask.
      return { kind: "resolved", value: date, label: date };
    }
    case "email": {
      // An address the patient typed, taken as a *token* out of the sentence.
      //
      // Reading it as a token rather than as the whole message is what makes
      // "an explicit address always wins" true. The branch used to strip every
      // space and test the result, which is correct for «ali @ example.com»
      // and wrong for «مش إيميلي، إيميلها soad@example.com»: stripping glues
      // the Arabic onto the address, and the glued string still satisfies the
      // shape check — so the sentence that most clearly supplies a beneficiary
      // address filed a value that was not one. The token match is tried
      // first, and the whole-message reading is kept behind it so a spaced-out
      // address still resolves exactly as it did.
      const folded = foldArabic(spoken);
      const token = folded.match(/[^\s@،,;:()<>"'«»]+@[^\s@،,;:()<>"'«»]+\.[a-z]{2,}/iu);
      if (token) {
        const typed = token[0].toLowerCase();
        return { kind: "resolved", value: typed, label: typed };
      }
      const value = folded.replace(/\s+/g, "");
      if (EMAIL.test(value)) {
        return { kind: "resolved", value: value.toLowerCase(), label: value.toLowerCase() };
      }
      // «نفس إيميلي», «استخدم إيميلي», «الإيميل اللي عندكم ليا», "use my email".
      //
      // A reference rather than a value, and the exact counterpart of the phone
      // branch below. Three conditions, all of them the server's own facts:
      //
      //   * the frame says this is an explicit third-party intake, so a sender
      //     opening their *own* file cannot reach it — «إيميلي» answered to the
      //     self-intake's own email question is a tautology, not an answer, and
      //     resolving it would file whatever is already on the record instead
      //     of the correction the patient is plainly trying to make;
      //   * the sentence names *the requester's own* address, by a lexicon that
      //     requires a first-person possessive or an explicit reference to the
      //     address the clinic already holds for them — «إيميله» and a bare
      //     «الإيميل» are not matched;
      //   * the requester's record actually carries a usable address.
      //
      // What is written is `frame.slots.email`, which reaches `stageIntake` as
      // contact data and nothing else. It links nobody, verifies nobody and
      // matches nobody: identity discovery is the national id plus the
      // canonical name and takes no email argument. Two files sharing one
      // address is the ordinary shape for a parent and a child.
      const own = await ownEmailForThirdParty(input);
      if (own) return { kind: "resolved", value: own, label: own };
      return { kind: "unresolved" };
    }
    case "phone": {
      const digits = foldArabic(spoken).replace(/[^0-9+]/g, "");
      if (digits.replace(/[^0-9]/g, "").length >= 7) {
        // A number the patient typed. Unchanged, and still first: an explicit
        // third-party number wins over every reading below it.
        return { kind: "resolved", value: digits };
      }
      // «استخدم رقمي», «خلي رقمها رقمي لأنها مراتي», «نفس الرقم اللي بكلمك منه».
      //
      // A reference rather than a value, and resolvable only because the server
      // already knows the address this conversation arrived on. Three
      // conditions, all of them the server's own facts:
      //
      //   * the frame says this is an explicit third-party intake — the only
      //     place the phone question is ever asked (see `intakeFieldsFor`), so
      //     a self-booking cannot reach this branch at all;
      //   * the sentence names *the requester's own* number, by a lexicon that
      //     requires a first-person possessive or an explicit deixis onto this
      //     thread — «رقمها» and a bare «الرقم» are not matched;
      //   * the conversation actually carries a usable address.
      //
      // What is written is `frame.slots.phone`, which reaches
      // `stageIntake` as contact data and nothing else. It links nobody,
      // verifies nobody and matches nobody: identity discovery is the national
      // id plus the canonical name and does not take a phone. Two files sharing
      // a number is expected, and the staging RPC would have written this very
      // number as its own fallback — the difference is that the patient asked.
      const own = ownNumberForThirdParty(input);
      if (own) return { kind: "resolved", value: own };
      return { kind: "unresolved" };
    }
    case "blood_type": {
      // Total by construction, because the question is optional.
      //
      // A readable group is recorded; «مش عارف», «تخطي», "skip", "don't know"
      // and anything else that is not a blood group are all recorded as
      // unknown. Returning `unresolved` for the last of those would re-ask an
      // optional question the patient has already declined to answer, and the
      // step has no way past a slot it cannot fill — which would turn a
      // convenience field into a wall in front of a booking.
      const value = foldArabic(spoken).toUpperCase().replace(/\s+/g, "");
      const sign = /[+]|موجب|POSITIVE|POS/u.test(value)
        ? "+"
        : /[-]|سالب|NEGATIVE|NEG/u.test(value)
          ? "-"
          : null;
      // Order matters, and it is not alphabetical. «او» — the Arabic O — begins
      // with `ا`, which is also the Arabic A, so testing A first read every
      // «او موجب» as A+ and wrote the wrong blood group onto a medical file.
      // Longest and most specific first: AB, then O, then the two single
      // letters that cannot now be confused with either.
      const group = /^(?:AB|ايه\s*بي|أيه\s*بي)/u.test(value)
        ? "AB"
        : /^(?:O|او|أو|و)/u.test(value)
          ? "O"
          : /^(?:A|ايه|أيه|ا)/u.test(value)
            ? "A"
            : /^(?:B|بي|ب)/u.test(value)
              ? "B"
              : null;
      return group && sign
        ? { kind: "resolved", value: `${group}${sign}` }
        : { kind: "resolved", value: BLOOD_TYPE_UNKNOWN };
    }
    default:
      return { kind: "unresolved" };
  }
}

/**
 * The name the assistant has actually put in front of the patient, for `slot`.
 *
 * Read off the state **as it was when the message arrived** — `context.flows`,
 * not the working frame — for one reason: `correct_slot` clears its slot before
 * the resolver runs, so by then the value being corrected is gone. The pre-turn
 * state is also the honest referent: it is what the patient was looking at.
 *
 * Two sources, in the order a patient would mean them:
 *
 *   * the committed slot, when there is one;
 *   * the option the frame's **live** offer is holding for that slot, which is
 *     where a proposed Latin spelling sits before anybody accepts it. An offer
 *     that was withdrawn — a parked frame, a correction, an answer — is not on
 *     the frame and so is not reachable here.
 *
 * Returns null when there is nothing on the table, which is what makes a name
 * given for the first time impossible to read as a correction of one.
 */
function nameOnTheTable(
  context: TurnContext | undefined,
  slotName: "full_name" | "full_name_latin",
): string | null {
  const frame = context ? activeFrame(context.flows) : null;
  if (!frame) return null;
  const committed = frame.slots[slotName]?.value;
  if (typeof committed === "string" && committed.trim()) return committed;
  const offer = frame.offer;
  if (!offer || offer.slot !== slotName || offer.kind !== "slot_value") return null;
  const option =
    offer.options.find((entry) => entry.id === offer.primaryOptionId) ?? offer.options[0];
  const proposed = option ? String(option.value) : "";
  return proposed.trim() ? proposed : null;
}

/**
 * The name branches' shared reading of a partial correction.
 *
 * Returns a resolution when the sentence *is* one, and `null` when it is not —
 * in which case the caller's existing reading runs untouched. The two outcomes
 * it can produce are the two the engine already knows what to do with:
 *
 *   * `resolved` with the whole name, one component substituted. It goes
 *     through `setSlot` like every other value, with the same provenance and
 *     the same cascade;
 *   * `unresolved` when the sentence is plainly a correction and does not say
 *     which component — the existing clarification, which re-asks and commits
 *     nothing. Guessing a component would silently rewrite a name on a medical
 *     file, and that is the one outcome that must not be reachable.
 *
 * No identity consequence of any kind. A display name is not matched against
 * anything: `resolveIdentity` takes the national id and the canonical
 * `full_name`, and a corrected spelling reaches the record the same way a
 * retyped one always did.
 */
function partialNameCorrection(input: {
  spoken: string;
  slot: string;
  context?: TurnContext;
}): SlotResolution | null {
  if (input.slot !== "full_name" && input.slot !== "full_name_latin") return null;
  const current = nameOnTheTable(input.context, input.slot);
  if (!current) return null;
  const correction = readPartialNameCorrection({ current, spoken: input.spoken.trim() });
  if (correction.kind === "corrected") {
    return { kind: "resolved", value: correction.value, label: correction.value };
  }
  return correction.kind === "ambiguous" ? { kind: "unresolved" } : null;
}

/**
 * The conversation's own number, when a third-party intake asked for a phone
 * and the patient answered with a reference to it.
 *
 * Null everywhere else, including — deliberately — for a self-intake, which
 * never asks the question. See the phone branch of `resolveIntakeField` for
 * why using this number changes nothing about who the patient is.
 */
function ownNumberForThirdParty(input: {
  spoken: string;
  context?: TurnContext;
  frame?: FlowFrame;
}): string | null {
  if (input.frame?.slots.beneficiary?.value !== "other") return null;
  if (!readsAsOwnNumberReference(input.spoken)) return null;
  return participantPhone(input.context?.participantAddress ?? null);
}

/**
 * The requester's own email, when a third-party intake asked for the
 * beneficiary's and the patient answered with a reference to it.
 *
 * Null everywhere else — including, deliberately, for a self-intake, and
 * including when the requester's record carries nothing usable in that column.
 * A null here is not a fallback to something else: it is the intake asking for
 * the beneficiary's address, which is the only honest answer when there is no
 * address to share. Nothing in this function can produce a value the clinic was
 * not already storing for the sender's own file.
 *
 * Using the address changes nothing about who the beneficiary is. See the email
 * branch of `resolveIntakeField`.
 */
async function ownEmailForThirdParty(input: {
  spoken: string;
  context?: TurnContext;
  frame?: FlowFrame;
}): Promise<string | null> {
  if (input.frame?.slots.beneficiary?.value !== "other") return null;
  if (!readsAsOwnEmailReference(input.spoken)) return null;
  const load = input.context?.requesterContactEmail;
  if (!load) return null;
  return contactEmailValue(await load());
}

/**
 * A name to file as the *Arabic* display name, or null.
 *
 * The intake's `full_name` slot holds whatever the patient typed, which is
 * usually Arabic and sometimes not. Filing "Ali Alzahrani" as an Arabic display
 * name would make the Arabic conversation show a Latin string it had been told
 * was the Arabic one, so a name with no Arabic letters in it is not an Arabic
 * display name and the column stays empty — the same rule the clinic's own
 * display-name columns follow, where absent means "fall back to canonical".
 */
function arabicNameOrNull(typed: string | null): string | null {
  if (!typed) return null;
  return /[\u0600-\u06FF]/u.test(typed) ? typed : null;
}

/**
 * The English spelling of a name the patient gave in Arabic, asked for once.
 *
 * ## Why it is a question and not a derivation
 *
 * A patient record carries a name in each language, and the Arabic one is
 * whatever the patient typed. The English one cannot be: a transliteration is a
 * *proposal about* a name, and a proposal filed without being seen is
 * indistinguishable, a week later, from a spelling the patient chose. So the
 * rule is the one the display-name columns already follow — a patient-facing
 * name is either one a person authored or the canonical stored text, never a
 * machine rendering that nobody looked at.
 *
 * Three exits, and which one is taken is decided by the name rather than by a
 * branch anybody has to remember:
 *
 *   * **already Latin** — the patient wrote "Ali Alzahrani". There is nothing
 *     to propose and nothing to confirm; it is filed as typed and costs no
 *     turn.
 *   * **nothing readable** — no letters at all. The English spelling is asked
 *     for outright rather than guessed at.
 *   * **Arabic** — the proposal is *offered*, with the Arabic name beside it,
 *     and the patient answers «اه» to accept it or writes the spelling they
 *     want. Both answers land on `full_name_latin`: the first through
 *     `affirm_offer` against the option the server minted, the second through
 *     this step's own resolver, which reads the Latin part out of «لا خليه Ali
 *     Al Zahrani» and drops the Arabic around it.
 *
 * Shared by the registration flow and the booking flow's intake step, so a
 * name is asked for on the same terms wherever the file is opened.
 */
function latinNameOutcome(typed: string, forThirdParty: boolean): StepOutcome {
  const suffix = forThirdParty ? ".other" : "";
  const proposal = proposeLatinName(typed);
  if (!proposal) {
    // Nothing readable to propose. Ask outright rather than file a guess.
    return {
      kind: "ask",
      slot: "full_name_latin",
      say: `intake.ask_latin_name${suffix}`,
    };
  }
  if (proposal.alreadyLatin) {
    // The patient wrote it in English themselves. Filing what they typed is
    // not a proposal about anything, so there is nothing to confirm.
    return {
      kind: "fill",
      slot: "full_name_latin",
      value: proposal.proposed,
      label: proposal.proposed,
    };
  }
  // An Arabic name. The rendering is shown beside the original and confirmed,
  // *including* when every part had a curated reading — a curated reading is
  // still this system's choice of spelling for somebody's name, and "Gehad"
  // versus "Jihad" is not a formatting preference.
  return {
    kind: "offer",
    slot: "full_name_latin",
    offerKind: "slot_value",
    options: [
      {
        value: proposal.proposed,
        label: proposal.proposed,
        source: "clinic_directory" as const,
      },
    ],
    // A single-option offer, so a bare «اه» has an unambiguous referent and
    // `affirm_offer` accepts it without asking which one.
    primary: 0,
    say: `intake.confirm_latin_name${suffix}`,
    facts: {
      proposed: proposal.proposed,
      typed,
      uncertain_parts: proposal.uncertainParts,
    },
  };
}

/** Which question each intake field is asked with. Copy keys, never prose. */
const INTAKE_COPY: Readonly<Record<string, string>> = {
  full_name: "intake.ask_name",
  national_id: "intake.ask_national_id",
  date_of_birth: "intake.ask_dob",
  email: "intake.ask_email",
  phone: "intake.ask_phone",
  blood_type: "intake.ask_blood_type",
};

/**
 * The fields a booking intake asks for, in the order it asks them.
 *
 * ## The third-party phone, and why it is on this list
 *
 * `stage_patient_intake_from_conversation` fills a missing third-party phone
 * from the conversation's `participant_address` — the number of the person
 * *sending* the message. Nothing in V2 ever asked for the patient's own number,
 * so every third-party file opened by the assistant carried the sender's
 * mobile: manual QA produced exactly that, a new patient record whose phone
 * belonged to somebody else entirely. The sender is the requester and the
 * contact; the patient is a different person and their number is theirs.
 *
 * Asking for it is the fix, and `tools.stageIntake` refuses a third-party
 * staging without one, so the fallback is unreachable rather than merely
 * unused.
 *
 * ## Blood type, and why it is last
 *
 * Optional, useful, and never a reason to lose a file. It is asked after
 * everything the record actually requires, so a patient who ignores the
 * question, says «مش عارف» or says «تخطي» has already given the clinic
 * everything it needs — see `resolveIntakeField`, where anything that is not a
 * readable blood group is recorded as unknown rather than re-asked.
 *
 * A self-booking is unchanged: the sender's own contact number is already the
 * thread's, and asking a linked patient to type the number they are messaging
 * from is the kind of question that makes an assistant feel broken.
 */
function intakeFieldsFor(
  forThirdParty: boolean,
): readonly (
  | "full_name"
  | "full_name_latin"
  | "national_id"
  | "date_of_birth"
  | "email"
  | "phone"
  | "blood_type"
)[] {
  // `full_name_latin` sits immediately after the name it is a spelling of, so
  // the two questions about one person's name are asked together rather than
  // separated by an id and a date of birth. See `latinNameOutcome` — the step
  // renders this field itself rather than through `INTAKE_COPY`, because its
  // question carries a proposal.
  return forThirdParty
    ? [
        "full_name",
        "full_name_latin",
        "national_id",
        "date_of_birth",
        "email",
        "phone",
        "blood_type",
      ]
    // The sender's own file. `phone` is still absent — the thread's own number
    // is theirs and asking a patient to type the number they are messaging from
    // is the kind of question that makes an assistant feel broken — but
    // `blood_type` belongs on every new file, not only a third party's. It
    // shipped on the third-party list alone, so a stranger opening their own
    // file was never asked, and the field the review screen now shows was
    // always empty for exactly the patients most likely to know it.
    : ["full_name", "full_name_latin", "national_id", "date_of_birth", "email", "blood_type"];
}

/**
 * The value recorded when the patient does not know their blood group, or
 * would rather not say.
 *
 * A real value, not a blank: the difference between "we asked and they don't
 * know" and "we never asked" is a thing the intake step needs in order not to
 * ask twice. It is mapped back to `null` at the write in `tools.stageIntake`,
 * so nothing that is not one of the eight stored groups reaches the file.
 */
export const BLOOD_TYPE_UNKNOWN = "unknown";

/** The intake fields a booking may have to collect for a person with no file. */
const INTAKE_SLOTS = [
  "full_name",
  "full_name_latin",
  "national_id",
  "date_of_birth",
  "email",
  "phone",
  "blood_type",
] as const;

/**
 * The clinic contact settings, one topic at a time, as a finished string.
 *
 * Returns `null` when the clinic has not configured that field, which the
 * caller says out loud. There is deliberately no branch that substitutes a
 * different field for a missing one: a patient who asked for the address and is
 * given the phone number has been answered a question they did not ask, and a
 * patient who is given a plausible address has been lied to.
 */
function clinicDetail(
  topic: string,
  info: {
    name?: string | null;
    address?: string | null;
    email?: string | null;
    phone?: string | null;
    website?: string | null;
    working_hours?: readonly {
      day_of_week: number;
      shift_start: string;
      shift_end: string;
    }[];
    default_working_hours?: { start: string; end: string } | null;
  },
  context: TurnContext,
): string | null {
  const text = (value: unknown): string | null => {
    const trimmed = typeof value === "string" ? value.trim() : "";
    return trimmed.length > 0 ? trimmed : null;
  };
  switch (topic) {
    case "address":
      return text(info.address);
    case "phone":
      return text(info.phone);
    case "website":
      return text(info.website);
    case "email":
      return text(info.email);
    case "opening_hours":
      return describeWorkingHours(info, context);
    default:
      // `clinic_other` never reaches here — it is answered from the clinic's
      // own FAQ above — so this is the honest answer for a topic nobody has
      // taught this function about yet.
      return null;
  }
}

/** Day names in the clinic's own language, indexed as `day_of_week` stores them. */
const DAY_NAMES: Record<"ar" | "en", readonly string[]> = {
  ar: ["الأحد", "الإثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"],
  en: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
};

/**
 * The clinic's working hours, written the way its own settings store them.
 *
 * Per-day shifts when `clinic_working_hours` has rows, because that is the
 * schedule staff actually maintain; the single default range otherwise. A
 * clinic with neither gets `null`, and the caller says the hours are not
 * listed rather than inventing a nine-to-five.
 *
 * Times are rendered against `context.clinic.timeFormat` — the stored
 * `time_format` setting, which V2 has loaded into the turn context since
 * `assemble.ts` was written and until now read nowhere.
 */
function describeWorkingHours(
  info: {
    working_hours?: readonly {
      day_of_week: number;
      shift_start: string;
      shift_end: string;
    }[];
    default_working_hours?: { start: string; end: string } | null;
  },
  context: TurnContext,
): string | null {
  const locale = context.turn.locale;
  const rows = info.working_hours ?? [];
  if (rows.length > 0) {
    const byDay = new Map<number, string[]>();
    for (const row of rows) {
      const day = Number(row.day_of_week);
      if (!Number.isInteger(day) || day < 0 || day > 6) continue;
      const shift = `${formatClockValue(row.shift_start, context)}–${formatClockValue(row.shift_end, context)}`;
      byDay.set(day, [...(byDay.get(day) ?? []), shift]);
    }
    const lines = [...byDay.entries()]
      .sort(([a], [b]) => a - b)
      .map(([day, shifts]) => `${DAY_NAMES[locale][day]}: ${shifts.join("، ")}`);
    if (lines.length > 0) return lines.join("\n");
  }
  const fallback = info.default_working_hours;
  if (fallback?.start && fallback.end) {
    return `${formatClockValue(fallback.start, context)}–${formatClockValue(fallback.end, context)}`;
  }
  return null;
}

/**
 * A stored `HH:MM[:SS]` value in the clinic's configured clock.
 *
 * Pure string work on a value the database already validated — no timezone
 * conversion, because a working-hours row is a wall-clock time at the clinic
 * and converting it would move it.
 */
function formatClockValue(raw: string | null | undefined, context: TurnContext): string {
  const match = /^(\d{1,2}):(\d{2})/.exec(String(raw ?? "").trim());
  if (!match) return String(raw ?? "").trim();
  const hour = Number(match[1]);
  const minute = match[2]!;
  if (context.clinic.timeFormat !== "12h") {
    return `${String(hour).padStart(2, "0")}:${minute}`;
  }
  const suffix =
    context.turn.locale === "ar" ? (hour < 12 ? "ص" : "م") : hour < 12 ? "AM" : "PM";
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve}:${minute} ${suffix}`;
}

/**
 * The package catalog answer, in whichever shape the question asked for.
 *
 * One function for all three intent families, because they are one question
 * asked at three widths and answering them in three places is how the service
 * catalog grew two layouts before this module existed:
 *
 *   * **all packages** — every active template, grouped under its department;
 *   * **one department's packages** — the same shape, one group;
 *   * **one named package** — its own detail block.
 *
 * `scope` is the patient's own words, and it is resolved *twice and in order*:
 * first against the clinic's departments, then — only if that matches nothing —
 * against the package names themselves. That order is the one that reads
 * «باكيدجات الجلدية» as a department and «باكيدج علاج حب الشباب» as a package
 * without either having to be signalled by the patient. Neither resolution ever
 * constructs a name: a scope that matches nothing at all falls back to the full
 * catalog, which is an answer, rather than to a package described from its
 * words, which is not.
 */
async function packageAnswer(input: {
  context: TurnContext;
  scope: string | null;
  departmentId: string | null;
}): Promise<StepOutcome> {
  const { context, scope } = input;
  let departmentId = input.departmentId;
  if (scope && !departmentId) {
    const matches = await tools.resolveDepartmentSpoken({ context, spoken: scope });
    if (matches.length === 1) departmentId = matches[0]!.value;
    else if (matches.length > 1) {
      return {
        kind: "offer",
        slot: "department",
        offerKind: "slot_value",
        options: matches,
        say: "info.which_department",
      };
    }
  }
  const catalog = await tools.readPublicPackages({ context, departmentId });
  if (catalog.total === 0) {
    return {
      kind: "complete",
      say: "info.packages_none",
      facts: { scoped: Boolean(departmentId) },
    };
  }
  // A named package, when the scope was not a department. Resolved against the
  // catalog that was just read, so a package the clinic deactivated is not in
  // the candidate set and cannot be confirmed to exist.
  if (scope && !departmentId) {
    const named = resolvePackageNamed({ packages: catalog.all, spoken: scope });
    if (named.kind === "matched") {
      return {
        kind: "complete",
        say: "info.package_detail",
        facts: {
          package: renderPackageDetail(named.entry, catalog.currency, context.turn.locale),
        },
      };
    }
    if (named.kind === "ambiguous") {
      return {
        kind: "offer",
        slot: null,
        offerKind: "slot_value",
        options: named.candidates.map((entry) => ({
          value: entry.id,
          label: entry.name,
          source: "clinic_directory" as const,
        })),
        say: "clarify.which_one",
      };
    }
    // Named nothing this clinic sells. Saying so plainly and then showing what
    // it does sell is the honest answer; the alternative is a package invented
    // to match the words.
    return {
      kind: "complete",
      say: "info.package_unknown",
      facts: {
        packages: renderPackageGroups(
          catalog.groups,
          catalog.currency,
          context.turn.locale,
        ),
      },
    };
  }
  return {
    kind: "complete",
    say: "info.packages",
    facts: {
      packages: renderPackageGroups(
        catalog.groups,
        catalog.currency,
        context.turn.locale,
      ),
    },
  };
}

/**
 * The insurance answer, for both widths of the question.
 *
 * «بتتعاملوا مع تأمينات ايه؟» lists the clinic's configured insurers.
 * «بتقبلوا AXA؟» is a yes/no about one of them, resolved against that same
 * list by {@link tools.resolveInsuranceProvider}.
 *
 * Three properties the brief requires, all of them properties of the read
 * rather than of the copy:
 *
 *   * only active, non-deleted providers are ever in the candidate set, so a
 *     deactivated insurer is neither confirmed nor listed;
 *   * a provider that is not configured returns a plain no plus the real list,
 *     never a hedge and never a guess from general knowledge;
 *   * no answer here states coverage. ClinicFlow stores which insurers the
 *     clinic works with and not which services a policy covers, so the copy
 *     says the first and the difference is stated out loud.
 */
async function insuranceAnswer(input: {
  context: TurnContext;
  scope: string | null;
}): Promise<StepOutcome> {
  const providers = await tools.readClinicInsurance(input.context);
  if (providers.length === 0) {
    return { kind: "complete", say: "info.insurance_none" };
  }
  const labels = providers.map((provider) => provider.label);
  if (input.scope) {
    const resolved = resolveInsuranceProvider({
      providers,
      spoken: input.scope,
    });
    if (resolved.kind === "matched") {
      return {
        kind: "complete",
        say: "info.insurance_accepted",
        facts: { insurer: resolved.provider.label },
      };
    }
    if (resolved.kind === "ambiguous") {
      return {
        kind: "offer",
        slot: null,
        offerKind: "slot_value",
        options: resolved.candidates.map((provider) => ({
          value: provider.id,
          label: provider.label,
          source: "clinic_directory" as const,
        })),
        say: "clarify.which_one",
      };
    }
    return {
      kind: "complete",
      say: "info.insurance_not_accepted",
      facts: { insurers: renderInsuranceList(labels) },
    };
  }
  return {
    kind: "complete",
    say: "info.insurance",
    facts: { insurers: renderInsuranceList(labels) },
  };
}

// ---------------------------------------------------------------------------
// book_appointment
// ---------------------------------------------------------------------------

/**
 * The booking flow.
 *
 * The ladder looks like the old one and is a completely different thing: it
 * belongs to a frame that is actually running. `nextBookingStep` answered
 * "which rung?" for every conversation that had ever existed, including one
 * whose patient had only said hello, and that answer was what pinned a tool.
 * Here there is no frame unless `start_flow` created one, so there is no rung
 * to force.
 */
/**
 * The two answers to «الحجز ده ليك إنت ولا لحد تاني؟», as the patient reads them.
 *
 * `value` is the canonical token the whole booking is branched on; `label` is
 * the only thing that can ever reach a message, and it is written in the
 * language of the turn. The `source` is unchanged from what this step has
 * always minted: it is bookkeeping for the audit line, and no value here was
 * read from anywhere.
 */
function beneficiaryOptions(
  locale: TurnContext["turn"]["locale"],
): readonly { value: string; label: string; source: "clinic_directory" }[] {
  return locale === "ar"
    ? [
        { value: "self", label: "ليك إنت", source: "clinic_directory" },
        { value: "other", label: "لحد تاني", source: "clinic_directory" },
      ]
    : [
        { value: "self", label: "for you", source: "clinic_directory" },
        { value: "other", label: "for someone else", source: "clinic_directory" },
      ];
}

/**
 * The refusal a day step owes a patient who named a day that is too soon.
 *
 * Two ways in, one answer:
 *
 *   * the words name a relative day — «بكرة», "today" — which is a policy
 *     question and never a calendar lookup;
 *   * the words parse to a real calendar date that the lead-time floor
 *     excludes, which is the same refusal arriving by a different route (a
 *     patient typing «07-09-2026» for tomorrow must not get a different answer
 *     from one typing «بكرة»).
 *
 * A day *after* the floor is not this function's business and returns null, so
 * the ordinary matching path below is untouched. So is a day in the past: that
 * is a misreading, not a policy refusal, and answering it with the clinic's
 * phone number would be answering a question nobody asked.
 *
 * The clinic's real phone number comes from settings, never from copy — a
 * hardcoded number in a message template is a number that is wrong for every
 * clinic but one.
 */
async function leadTimeRefusal(input: {
  spoken: string;
  context: TurnContext;
}): Promise<Extract<SlotResolution, { kind: "refused" }> | null> {
  const { spoken, context } = input;
  const timeZone = context.clinic.timeZone;
  const relative = relativeDayFromSpoken(spoken);
  let reason: ReturnType<typeof tooSoonReason> = null;
  if (relative === "today" || relative === "tomorrow") {
    reason = relative;
  } else if (relative === null) {
    // A named calendar date. `fullDateReadings` returns every reading of an
    // ambiguous one — «06-09-2026» is both the sixth of September and the ninth
    // of June — and the refusal has to be true of the date as a whole.
    //
    // Two conditions, and both are needed. **No reading may be bookable**, or
    // the step still has a real day to offer and refusing would throw it away.
    // And **at least one reading must be too soon**, or this is not a policy
    // matter at all: a date entirely in the past is a misreading, and answering
    // it with the clinic's phone number would answer a question nobody asked.
    const reasons = fullDateReadings(spoken).map((date) =>
      tooSoonReason(date, context.now, timeZone),
    );
    if (reasons.length > 0 && reasons.every((entry) => entry !== null)) {
      reason = reasons.find((entry) => entry !== "past") ?? null;
    }
  }
  // A day in the past is a misreading, not a policy refusal — `tooSoonReason`
  // reports it separately and `reason` is only ever assigned the too-soon
  // readings above, so reaching here means the rule genuinely applies.
  if (!reason) return null;
  const info = await tools.readClinicInfo(context);
  const phone = typeof info?.phone === "string" ? info.phone.trim() : "";
  return {
    kind: "refused",
    say: phone ? "booking.lead_time" : "booking.lead_time_no_phone",
    facts: phone ? { clinic_phone: phone } : {},
  };
}

/**
 * The booking summary a patient reads before consenting to the write.
 *
 * ## Whose appointment this is
 *
 * `patient` is the **beneficiary**, and on a third-party booking that is the
 * name the sender typed for their friend — never the sender's own. A summary
 * that says "Patient: <sender>" above an appointment being made for somebody
 * else is not a formatting defect; it is asking for consent to the wrong thing.
 * For a self-booking the canonical name on file is used when identity has
 * established one, and the line is simply absent when it has not: a blank
 * labelled field is worse than no field.
 *
 * ## Every value here was already shown to the patient
 *
 * Each field is the *label* from the offer the patient answered — the doctor
 * with their honorific, the day with its weekday, the time in the clinic's
 * configured clock. Nothing is re-derived, nothing is an id, and nothing is a
 * canonical enum. A field the flow has no value for does not appear.
 */
async function bookingSummary(input: {
  context: TurnContext;
  frame: FlowFrame;
}): Promise<string> {
  const { context, frame } = input;
  const forThirdParty = frame.slots.beneficiary?.value === "other";
  const patient = forThirdParty
    ? (frameSlot(frame, "beneficiary_name") ?? frameSlot(frame, "full_name"))
    : await context.durable.canonicalName().catch(() => null);
  const service = await bookingServiceLine({ context, frame });
  return renderSummary(
    {
      patient: patient ?? null,
      department: frame.slots.department?.label ?? null,
      doctor: frame.slots.doctor?.label ?? null,
      day: bookingDayLabel(frame, context),
      time: bookingTimeLabel(frame, context),
      service: service?.name ?? null,
      price: service?.price ?? null,
    },
    context.turn.locale,
  );
}

/**
 * The service line, when the booking committed one.
 *
 * Read from the catalog rather than carried on the slot, so the price is the
 * clinic's configured price at the moment of confirmation and the name is the
 * clinic's own display name in the conversation's language. A booking with no
 * service selected returns null and the two lines are omitted — there is no
 * placeholder, and no price is ever inferred from a department.
 */
async function bookingServiceLine(input: {
  context: TurnContext;
  frame: FlowFrame;
}): Promise<{ name: string; price: string | null } | null> {
  const serviceId = frameSlot(input.frame, "service");
  if (!serviceId || !/^[0-9a-f-]{36}$/i.test(serviceId)) return null;
  const services = await tools.readServices({
    context: input.context,
    departmentId: frameSlot(input.frame, "department"),
  });
  for (const group of services.groups) {
    const match = group.services.find((entry) => entry.id === serviceId);
    if (!match) continue;
    return {
      name: match.name,
      price:
        match.price === null || !Number.isFinite(match.price)
          ? null
          : services.currency
            ? `${match.price} ${services.currency}`
            : String(match.price),
    };
  }
  return null;
}

/**
 * The offered times, minus any the write has already refused on this frame.
 *
 * `computeAvailability` blocks on `confirmed`/`arrived`/`in_session` only, so a
 * *pending* AI request somebody else holds is invisible to it while the booking
 * RPC refuses on it. Without this filter the sequence is: the patient picks
 * 12:15, the write is refused, the slot is dropped, the calendar is re-read,
 * 12:15 is still in the list, the patient picks it again. Recording the refusal
 * (see `StepOutcome.invalidate.reject`) is what turns that into a single clean
 * refresh with the refused time gone from it.
 *
 * Frame-scoped and booking-scoped: nothing here is stored, and a later booking
 * reads the same calendar with no memory of this one.
 */
function offerableTimes<T extends { value: string }>(
  times: readonly T[],
  frame: FlowFrame,
): T[] {
  const refused = new Set(frame.rejected.time ?? []);
  return times.filter((time) => !refused.has(time.value));
}

const bookAppointment: FlowDefinition = {
  name: "book_appointment",
  onAbandon: "confirm",
  public: false,
  steps: [
    {
      // Who the appointment is for, asked once and before anything is
      // collected. Never inferred from the thread's linkage: a linked sender
      // typing "عايز احجز" may well be booking for somebody else, and the old
      // engine's collapse of those two facts is how an appointment landed on
      // the wrong file.
      id: "beneficiary",
      fills: "beneficiary",
      pre: { slots: [], identity: "none" },
      invalidates: ["department", "doctor", "day", "time"],
      // The one slot in the system whose options are *canonical values* rather
      // than clinic records, and whose resolver is therefore total over the
      // patient's own words. See `FlowStep.canonicalAnswer`: it is what lets
      // the engine read «لحد تاني» as the answer it obviously is, whichever
      // command the interpreter happened to emit for it.
      canonicalAnswer: true,
      resolveValue: async ({ spoken }) => {
        // One lexicon, shared with the legacy engine and hardened by the same
        // manual QA — «لحد تاني», «لشخص تاني», «مش ليا», «لمراتي», "someone
        // else", "for my wife" — plus the canonical `self`/`other` tokens,
        // because a patient who was once shown one must not be told it is not
        // a word. Nothing is matched here that is not in `normalizeBeneficiary`.
        const value = normalizeBeneficiary(spoken);
        return value ? { kind: "resolved", value } : { kind: "unresolved" };
      },
      run: async ({ context }) => ({
        kind: "offer",
        slot: "beneficiary",
        offerKind: "slot_value",
        // Labels are prose, in the patient's language, and never the canonical
        // value beside them.
        //
        // Manual QA: they *were* the canonical values, and a turn the engine
        // could not settle rendered `clarify.which_one` from these labels — so
        // the clinic's assistant asked a patient «تقصد أنهي واحد في دول: self،
        // other؟». An internal enum reached a patient over WhatsApp. The offer
        // is the only place these options are ever written down, so it is the
        // only place that can be fixed; `value` stays `self`/`other`, which is
        // what every slot, memo and downstream branch already reads.
        options: beneficiaryOptions(context.turn.locale),
        say: "booking.who_is_this_for",
      }),
    },
    {
      id: "department",
      fills: "department",
      pre: { slots: ["beneficiary"], identity: "none" },
      invalidates: ["doctor", "day", "time"],
      // Substring containment is what this used to be, and it could not read
      // «الجلدية» against a department the clinic stored as "Dermatology" —
      // which is the ordinary configuration for an Arabic-speaking clinic with
      // an English admin UI. `resolveDepartmentNamed` is the clinic's own
      // cross-language matcher, already trusted for this by the legacy engine.
      resolveValue: async ({ spoken, context }) => {
        const resolved = await tools.resolveDepartmentNamed({ context, spoken });
        return resolved.kind === "resolved"
          ? { kind: "resolved", value: resolved.value, label: resolved.label }
          : resolved.kind === "ambiguous"
            ? { kind: "ambiguous", options: resolved.options }
            : { kind: "unresolved" };
      },
      run: async ({ context, frame }) => {
        // The one place a durable fact is allowed near a booking, and it enters
        // as an offer. A returning patient booking for themself is offered the
        // department they are known in *alongside* the full list; the offer is
        // a suggestion, and the slot stays empty until they answer (I-5).
        const departments = await tools.readDepartments(context);
        if (departments.length === 0) {
          return { kind: "handoff", say: "booking.no_departments" };
        }
        const known =
          frame.slots.beneficiary?.value === "self"
            ? await context.durable.knownDepartments()
            : [];
        const knownIds = new Set(known.map((entry) => entry.value));
        const ordered = [
          ...departments.filter((entry) => knownIds.has(entry.value)),
          ...departments.filter((entry) => !knownIds.has(entry.value)),
        ];
        return {
          kind: "offer",
          slot: "department",
          offerKind: "slot_value",
          options: ordered,
          say: "booking.choose_department",
          facts: { previously_seen: known.length > 0 },
        };
      },
    },
    {
      id: "doctor",
      fills: "doctor",
      pre: { slots: ["department"], identity: "none" },
      invalidates: ["day", "time"],
      resolveValue: async ({ spoken, frame, context }) => {
        const resolved = await tools.resolveDoctorSpoken({
          context,
          spoken,
          departmentId: slot(frame, "department"),
          // The negative constraint, applied at the point of resolution: a
          // doctor the patient ruled out cannot be re-selected even by name.
          excluding: frame.rejected.doctor ?? [],
        });
        return resolved.kind === "resolved"
          ? { kind: "resolved", value: resolved.value, label: resolved.label }
          : resolved.kind === "ambiguous"
            ? { kind: "ambiguous", options: resolved.options }
            : { kind: "unresolved" };
      },
      run: async ({ context, frame }) => {
        const departmentId = slot(frame, "department")!;
        const rejected = frame.rejected.doctor ?? [];
        const roster = await tools.readDoctors({
          context,
          departmentId,
          excluding: rejected,
        });
        if (roster.length === 0) {
          // A question, not a report. `inform` re-advances, and this step fills
          // a slot that nothing has filled — so the flow selected it again on
          // every re-entry. Every "there is nothing available, shall we try X?"
          // below is an `ask` for the same reason: the copy asks the patient
          // something, so the turn has to stop and let them answer it.
          return { kind: "ask", slot: null, say: "booking.no_doctors_left" };
        }
        // The treating doctor is offered *first*, and only for a self-booking,
        // and only when the patient has not already ruled them out. This is the
        // convenience the brief asks for and the exact behaviour the old
        // `prepare_booking` write destroyed by committing it.
        const treating =
          frame.slots.beneficiary?.value === "self"
            ? (await context.durable.treatingDoctors()).filter(
                (doctor) =>
                  !rejected.includes(doctor.value) &&
                  roster.some((entry) => entry.value === doctor.value),
              )
            : [];
        const ordered = [
          ...treating,
          ...roster.filter(
            (entry) => !treating.some((doctor) => doctor.value === entry.value),
          ),
        ];
        return {
          kind: "offer",
          slot: "doctor",
          offerKind: "slot_value",
          options: ordered,
          say: treating.length > 0 ? "booking.choose_doctor_with_previous" : "booking.choose_doctor",
          // The copy for a returning patient asks a yes/no about the first
          // name — "that's the one you saw before, shall we keep them?" — so a
          // bare «اه» has an unambiguous referent and is accepted. The plain
          // roster copy asks no such question and sets no primary, so a yes
          // against it is answered with "which one?", which is correct.
          ...(treating.length > 0 ? { primary: 0 } : {}),
          facts: { has_previous_doctor: treating.length > 0 },
        };
      },
    },
    {
      // The worked precondition from the brief. Unreachable until department
      // and doctor are *committed slots on this live frame*.
      id: "day",
      fills: "day",
      pre: { slots: ["department", "doctor"], identity: "none" },
      invalidates: ["time"],
      /**
       * The bound the patient puts on this step's own question.
       *
       * `date_lower_bound` has been in the command vocabulary and in the
       * interpreter's slot list since V2 shipped, and this step has always read
       * it — but **no step declared it**, so `stepForSlot` returned null,
       * `set_slot` fell through to `slot_not_in_flow`, and the command was
       * discarded without an effect. A refinement of an open day request was
       * therefore unrepresentable end to end, which is why «ايه الايام المتاحة
       * بعد يوم 11» came back as a generic "how can I help?" and, on the repeat,
       * as an identity challenge from a patient-records topic the model reached
       * for instead.
       *
       * Declaring it here is the whole fix on the engine side: the value lands
       * on this step, `day` is still empty, so the engine re-advances into
       * `run` below and the *same* step re-reads availability with the new
       * bound. No new command kind, no second frame, no identity check — the
       * step's precondition is unchanged at `identity: "none"`.
       */
      collects: ["date_lower_bound"],
      resolveValue: async ({ spoken, slot: name, frame, context }) => {
        if (name === "date_lower_bound") {
          // Clinic-local today, from the same timezone every availability read
          // uses, so "after the 11th" means the clinic's 11th.
          const today = formatInTimeZone(
            context.now,
            context.clinic.timeZone,
            "yyyy-MM-dd",
          );
          // The days the *live* offer is showing, so «بعد التاريخ ده» is
          // bounded by the last date the patient can actually see. An offer
          // that was withdrawn is not on the frame and contributes nothing,
          // which is what keeps a stale list from authorising a window.
          const offeredDates =
            frame.offer && frame.offer.slot === "day" && frame.offer.kind === "slot_value"
              ? frame.offer.options
                  .map((option) => String(option.value))
                  .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value))
              : [];
          const bound = parseDateLowerBound(spoken, today, { offeredDates });
          // Unresolved rather than guessed. A bound nobody can read is not a
          // bound, and the step re-asks with the days it already has.
          return bound
            ? { kind: "resolved", value: bound.date, label: bound.date }
            : { kind: "unresolved" };
        }
        // A day the clinic does not sell online is refused, not misread.
        //
        // The lead-time rule (see `lib/booking/lead-time.ts`) removes today and
        // tomorrow from every list this step produces, so «بكرة» matches
        // nothing and used to come back as «ما قدرتش أحدد اللي تقصده» — which
        // blames the patient's wording for a policy they were never told
        // about, and on the second attempt escalates into showing the same
        // list again. Reading it explicitly turns that into the answer the
        // brief asks for: online booking needs a later date, and here is the
        // clinic's number if tomorrow is what you need.
        const refusal = await leadTimeRefusal({ spoken, context });
        if (refusal) return refusal;
        const result = await tools.readAvailableDays({
          context,
          doctorId: slot(frame, "doctor")!,
          after: slot(frame, "date_lower_bound"),
        });
        if (!result.ok) return { kind: "unresolved" };
        // A day is committable only if it is a day the server actually offered.
        // The patient's words are matched against real calendar days, never
        // parsed into one. «يوم ١٠» and "10" reach the same offered day because
        // the *number* is matched against the offered dates — not because a
        // date was constructed from the words.
        const matches = matchOfferedDays(result.days, spoken);
        if (matches.length === 1) {
          return { kind: "resolved", value: matches[0]!.value, label: matches[0]!.label };
        }
        if (matches.length > 1) return { kind: "ambiguous", options: matches };
        return { kind: "unresolved" };
      },
      run: async ({ context, frame }) => {
        const result = await tools.readAvailableDays({
          context,
          doctorId: slot(frame, "doctor")!,
          after: slot(frame, "date_lower_bound"),
        });
        if (!result.ok) {
          return { kind: "ask", slot: null, say: "booking.calendar_unavailable" };
        }
        if (result.days.length === 0) {
          // A real answer about the clinic, not a failure. The patient is told
          // plainly and offered a wider search or another doctor.
          return {
            kind: "ask",
            slot: null,
            say: "booking.no_days",
            facts: { window_start: result.windowStart, window_end: result.windowEnd },
          };
        }
        return {
          kind: "offer",
          slot: "day",
          offerKind: "slot_value",
          options: result.days,
          say: "booking.choose_day",
          facts: { window_start: result.windowStart, window_end: result.windowEnd },
        };
      },
    },
    {
      id: "time",
      fills: "time",
      pre: { slots: ["department", "doctor", "day"], identity: "none" },
      resolveValue: async ({ spoken, frame, context }) => {
        const result = await tools.readAvailableSlots({
          context,
          doctorId: slot(frame, "doctor")!,
          date: slot(frame, "day")!,
        });
        if (!result.ok) return { kind: "unresolved" };
        const matches = matchOfferedTimes(offerableTimes(result.times, frame), spoken);
        if (matches.length === 1) {
          return { kind: "resolved", value: matches[0]!.value, label: matches[0]!.label };
        }
        // Two readings of the same hour — 10 in the morning and 10 at night —
        // is an ambiguity the server owes a question about, not a coin toss.
        if (matches.length > 1) return { kind: "ambiguous", options: matches };
        return { kind: "unresolved" };
      },
      run: async ({ context, frame }) => {
        const result = await tools.readAvailableSlots({
          context,
          doctorId: slot(frame, "doctor")!,
          date: slot(frame, "day")!,
        });
        const times = result.ok ? offerableTimes(result.times, frame) : [];
        if (!result.ok || times.length === 0) {
          return { kind: "ask", slot: null, say: "booking.no_times" };
        }
        return {
          kind: "offer",
          slot: "time",
          offerKind: "slot_value",
          options: times,
          say: "booking.choose_time",
        };
      },
    },
    {
      /**
       * The package offer, and the decision it records.
       *
       * Runs once, after the appointment is fully specified and before the
       * summary, so the patient is asked about payment for something concrete.
       *
       * **`fills: null`, deliberately.** This step does not settle a slot; it
       * settles a *question*, and the two are not the same. It shipped as
       * `fills: "package"` with `inform` exits, which meant the only way past
       * it was for a real package to be selected — so a patient who owned none,
       * or who declined the one they had, could never reach the summary. Every
       * exit below therefore either asks (and returns next turn to read the
       * answer) or records the decision with `inform`, which is what
       * `nextStep` reads to move on. Nothing here fills `package` with a
       * sentinel: a slot that says a package was chosen when none was is a lie
       * the confirmation step would go on to repeat.
       *
       * **Ownership is a disclosure; booking is not.** Knowing which packages
       * somebody owns is patient-record data and stays at `verified`. But
       * needing that answer must not become a precondition for an ordinary
       * booking — the step's own precondition is `identity: "none"` and the
       * disclosure gate is the check inside `run`, so a `linked` patient books
       * exactly as before and is simply never offered a package. Gating the
       * step itself at `verified` stopped every linked patient at "we need to
       * verify your identity first" on a turn that was about neither.
       *
       * Three properties the brief requires, all structural:
       *
       *   * ownership never selects — the package arrives as an offer and the
       *     slot stays empty unless the patient affirms it;
       *   * a decline is recorded (`package_declined`), so the question is not
       *     asked again on every subsequent turn;
       *   * the offer is skipped entirely when the patient owns no applicable
       *     package, which is the ordinary case and costs nothing.
       */
      id: "package_offer",
      fills: null,
      pre: { slots: ["department", "doctor", "day", "time"], identity: "none" },
      run: async ({ context, frame }) => {
        if (frame.memo.package_accepted === true) {
          // Answered, and answered yes. The `package` slot and the memo were
          // both written by `affirm_offer`; recording the step done is what
          // carries the flow to the summary.
          return { kind: "inform", say: "booking.package_accepted" };
        }
        if (frame.memo.package_declined === true) {
          return { kind: "inform", say: "booking.package_skipped" };
        }
        // A package belongs to the patient record that holds it, and this
        // booking is for somebody else.
        //
        // `readPatientPackages` takes a `context` and no beneficiary: it can
        // only ever return the *sender's* packages. Offering one while A is
        // booking for his son proposes spending A's sessions on C's
        // appointment, which is not a thing the clinic sells and not a
        // question the patient should be asked.
        //
        // It was also unanswerable. `commitBooking` fails closed on
        // `forThirdParty && packageId` — the third-party write goes through
        // `create_provisional_ai_appointment_request`, which has no argument
        // for a package and books a beneficiary who has no `patients` row to
        // decrement against — so a patient who said yes here reached a
        // guaranteed `failed` and a handoff. Skipping the question turns that
        // dead end into an ordinary booking.
        //
        // Read from `frame.slots.beneficiary`, the same expression the intake
        // and commit steps use, because the frame is the authority on who the
        // appointment is for. The `commitBooking` guard stays exactly where it
        // is: this makes the bad combination unreachable, and that keeps it
        // impossible.
        if (frame.slots.beneficiary?.value === "other") {
          return { kind: "inform", say: "booking.package_not_offered" };
        }
        if (context.identity !== "verified") {
          // The disclosure gate. Not an error and not a question: a booking at
          // `linked` proceeds without a package, and the patient is told
          // nothing about what they may or may not own — including whether
          // there was anything to tell.
          return { kind: "inform", say: "booking.package_not_offered" };
        }
        const packages = await tools.readPatientPackages({
          context,
          departmentId: slot(frame, "department"),
          serviceId: slot(frame, "service"),
        });
        if (packages.length === 0) {
          return { kind: "inform", say: "booking.package_none" };
        }
        return {
          kind: "offer",
          slot: "package",
          // A distinct offer kind, because accepting it is permission to
          // consume a session and must not be confusable with choosing a value.
          offerKind: "package_use",
          options: packages,
          say: "booking.package_offer",
        };
      },
    },
    {
      /**
       * The intake, for a patient with no file.
       *
       * Reached only when the beneficiary has no record here — a stranger, or
       * the friend a linked patient is booking for. `stageIntake` requires a
       * department and a doctor, which this step's precondition guarantees, and
       * it stages for review rather than creating a file outright.
       */
      id: "intake",
      fills: null,
      pre: {
        slots: ["department", "doctor", "day", "time"],
        identity: "none",
      },
      // The answers to this step's own questions. Declaring them is what makes
      // «احمد محمد» land in `full_name` instead of being dropped for belonging
      // to no step — the defect behind the repeated name prompt, the missing
      // third-party file and the booking that was never written for one.
      collects: INTAKE_SLOTS,
      resolveValue: resolveIntakeField,
      run: async ({ context, frame }) => {
        const needsFile =
          frame.slots.beneficiary?.value === "other" || context.identity === "anonymous";
        if (
          !needsFile ||
          frame.memo.intake_staged === true ||
          frame.memo.booking_patient_known === true
        ) {
          return { kind: "inform", say: "booking.intake_not_needed" };
        }
        const forThirdParty = frame.slots.beneficiary?.value === "other";
        const missing = intakeFieldsFor(forThirdParty).filter(
          (field) => !frame.slots[field],
        );
        if (missing.length > 0) {
          // One field at a time, and only the ones still missing. A slot that
          // has been answered is never in this list, so an answered question
          // cannot come back — a property of the slots rather than of the copy.
          const field = missing[0]!;
          // The English spelling is a proposal about the name already given,
          // not a question with a blank answer, so it is rendered by the same
          // helper the registration flow uses rather than by a copy key.
          if (field === "full_name_latin") {
            return latinNameOutcome(slot(frame, "full_name")!, forThirdParty);
          }
          return {
            kind: "ask",
            slot: field,
            say: `${INTAKE_COPY[field]}${forThirdParty ? ".other" : ""}`,
            facts: { field, remaining: missing.length },
          };
        }

        // Everything the file needs is in hand. Discovery first, creation only
        // if discovery finds nothing — the order the brief sets out, and the
        // order that keeps a returning patient from getting a second file.
        //
        // Both branches finish this step in one `run`. Splitting them across
        // two turns would not work: `inform` records the step done, so an
        // intermediate report would carry the flow past the staging it was
        // meant to precede.
        const resolution = await tools.resolveIdentity({
          context,
          nationalId: slot(frame, "national_id")!,
          fullName: slot(frame, "full_name")!,
        });
        if (resolution.kind === "matched") {
          // An existing file, found by exact id within this clinic. Nothing is
          // created. Every miss below is the same `none`, so this cannot be
          // used to ask whether some other person has a record here.
          // No `canonical_name` in the facts. The sender proved an id and a
          // name; being told the clinic's stored spelling of somebody else's
          // name is a disclosure they have not earned, and a fact that reaches
          // the facts here also reaches the polish prompt.
          //
          // `booking_patient_known` rather than `intake_staged`: nothing was
          // staged, so nothing is pending review, and `hasStagedWork` must not
          // start asking whether to discard a file that was never opened.
          return {
            kind: "inform",
            say: "intake.existing_file",
            memo: { booking_patient_known: true } as Readonly<
              Record<string, string | number | boolean>
            >,
          };
        }
        const staged = await tools.stageIntake({
          context,
          fullName: slot(frame, "full_name_latin") ?? slot(frame, "full_name")!,
          fullNameOriginal: slot(frame, "full_name"),
          // The two display names, each from the slot that actually holds one.
          // `full_name` is the Arabic only when the patient wrote Arabic — a
          // patient who typed "Ali Alzahrani" has the same string in both
          // slots, and `arabicNameOrNull` is what keeps that from being filed
          // as an Arabic display name.
          fullNameAr: arabicNameOrNull(slot(frame, "full_name")),
          fullNameEn: slot(frame, "full_name_latin"),
          nationalId: slot(frame, "national_id")!,
          dateOfBirth: slot(frame, "date_of_birth")!,
          email: slot(frame, "email")!,
          departmentId: slot(frame, "department")!,
          doctorId: slot(frame, "doctor")!,
          forThirdParty,
          // The patient's own number, never the sender's. `stageIntake` refuses
          // a third-party staging without one rather than letting the RPC fall
          // back to `conversations.participant_address`.
          phone: slot(frame, "phone"),
          // "We asked and they don't know" is recorded on the frame so the
          // question is not repeated, and dropped at the write so nothing that
          // is not one of the eight stored groups reaches the file.
          bloodType:
            slot(frame, "blood_type") === BLOOD_TYPE_UNKNOWN
              ? null
              : slot(frame, "blood_type"),
        });
        // A staging that failed is not a staged file, and the flow says so
        // rather than continuing to a booking with no patient behind it.
        if (!staged.ok) return { kind: "handoff", say: "intake.failed" };
        // `intake_staged` is what `hasStagedWork` reads, and what the booking
        // write reads downstream to know this appointment belongs to the
        // staged person rather than to the sender.
        return {
          kind: "inform",
          say: forThirdParty ? "intake.staged_other" : "intake.staged",
          memo: { intake_staged: true } as Readonly<
            Record<string, string | number | boolean>
          >,
        };
      },
    },
    {
      /**
       * The summary and the write.
       *
       * Two turns, always. The first composes the review and offers it; the
       * second — and only after `affirm_offer` has written `confirmed` — calls
       * the booking. There is no path that reaches the write on the same turn
       * as the summary, which is what "no booking before confirmation" means
       * when it is a property rather than a prompt instruction.
       */
      id: "confirm",
      fills: null,
      pre: {
        slots: ["department", "doctor", "day", "time"],
        // `identity: "none"`, and the check moved into `run` below.
        //
        // It shipped as `"linked"`, which is stricter than the domain and was
        // the dead end manual QA hit. A stranger with no file books like this:
        // the `intake` step collects their details and stages them, and staging
        // deliberately does **not** link the conversation — only a staff
        // approval does that, in `approve_ai_patient_intake`. So the very next
        // step demanded a linkage that could not exist yet and answered a
        // patient who had just typed out their whole file with «لازم نتأكد من
        // هويتك الأول. فريق العيادة هيساعدك في ده» — an identity challenge
        // about a topic that was never raised, and the end of the conversation.
        //
        // The domain has always supported this case:
        // `createPatientPendingBooking` takes the linked branch only for a
        // linked, non-third-party sender and otherwise writes a *provisional*
        // AI appointment request, which is the same pending-review artefact the
        // staged file is. Nothing here is being loosened to make that work; the
        // precondition was simply narrower than the write it guards.
        //
        // What replaces it is the assertion below, which is strictly stronger
        // than "linked" for the property that actually matters (I-4): every
        // booking must have a real patient behind it, and a *linked* sender
        // booking for somebody else satisfied the old gate while satisfying
        // nothing.
        identity: "none",
      },
      run: async ({ context, frame }) => {
        // I-4, asserted before the patient is asked to consent to anything.
        //
        // A booking needs a patient. There are exactly three ways to have one,
        // and all three are facts on this frame or on this conversation:
        //
        //   * the sender is linked or verified and the booking is theirs;
        //   * a file was discovered for the beneficiary (`booking_patient_known`);
        //   * a file was staged for the beneficiary on this frame
        //     (`intake_staged`).
        //
        // The third is the same-conversation trust the brief describes, and it
        // is deliberately frame-scoped: `intake_staged` is a memo on *this*
        // booking frame, minted by the step that just wrote the row, so it says
        // "this conversation supplied these details a moment ago" and nothing
        // more. It is not an identity, it does not survive into another
        // conversation, it grants no access to any record, and it is read only
        // here — the identity firewall, the disclosure gates on `my_packages`,
        // `my_appointments` and `my_documents`, and every `verified` step are
        // all untouched by it.
        const forThirdParty = frame.slots.beneficiary?.value === "other";
        const senderIsPatient =
          !forThirdParty &&
          (context.identity === "linked" || context.identity === "verified");
        const hasPatient =
          senderIsPatient ||
          frame.memo.intake_staged === true ||
          frame.memo.booking_patient_known === true;
        if (!hasPatient) {
          // Reaching here means the intake step neither staged nor matched a
          // file, which is a failure of that step rather than something to ask
          // the patient about. Writing the appointment against the sender's
          // record is the substitution the whole beneficiary distinction exists
          // to prevent, so it hands over instead.
          return { kind: "handoff", say: "intake.failed" };
        }
        if (frame.memo.confirmed !== true) {
          return {
            kind: "offer",
            slot: null,
            offerKind: "summary",
            options: [{ value: "confirm", label: "confirm", source: "clinic_directory" }],
            say: "booking.review",
            // The labels, not the canonical values. The summary is the last
            // thing a patient reads before consenting to a write, so it has to
            // say «الاثنين — 07-09-2026، 9:00 صباحًا» and not «2026-09-07،
            // 09:00» — the same rendering the offer they answered used.
            //
            // Rendered here as one block rather than as five placeholders in a
            // sentence: see `renderSummary`. The composer receives a finished
            // body and a question, which is what keeps the layout out of the
            // copy table and out of the polish pass.
            facts: {
              summary: await bookingSummary({ context, frame }),
              uses_package: frame.memo.package_accepted === true,
            },
          };
        }
        // The assertion above already ran on this turn and on the turn that
        // produced the summary, so by here the booking is known to have a
        // patient behind it. Nothing between the two can change that: a
        // correction clears `confirmed` and comes back through the top.
        const result = await tools.commitBooking({
          context,
          doctorId: slot(frame, "doctor")!,
          date: slot(frame, "day")!,
          time: slot(frame, "time")!,
          durationMinutes: 30,
          serviceId: slot(frame, "service"),
          // Who this is for, read off the frame at the moment of the write and
          // carried into it. The write used to re-derive this from a database
          // lookup and would file a third-party appointment on the sender's own
          // record whenever that lookup came back empty; the beneficiary the
          // patient actually stated is not something the write should have to
          // rediscover. Same expression as `forThirdParty` above, and it is
          // deliberately re-read from the frame rather than closed over: this
          // line is the one the invariant depends on.
          forThirdParty: frame.slots.beneficiary?.value === "other",
          // A session is consumed only on an affirmed `package_use` offer.
          // Ownership alone reaches neither this argument nor the decrement.
          packageId:
            frame.memo.package_accepted === true ? String(frame.memo.package_id) : null,
        });
        if (!result.ok) {
          // Four different things happened, and telling a patient the wrong
          // one is how the QA loop was built. See
          // `tools.classifyBookingFailure` for where the vocabulary comes from.
          if (result.reason === "already_pending") {
            // Idempotency, expressed as a conversation.
            //
            // The clinic allows one pending AI request per patient, so a second
            // confirmation — a repeated tap, a redelivered webhook, a patient
            // saying «اه» twice — is refused by the database and **nothing is
            // created**. Reporting that as "the slot was taken" was the loop:
            // the re-offer listed the same free time (a pending row does not
            // block `computeAvailability`), the patient picked it again, and
            // the turn repeated. The truthful answer is that their request is
            // already in, so the flow completes rather than restarting.
            return {
              kind: "complete",
              say: "booking.already_requested",
              facts: { summary: await bookingSummary({ context, frame }) },
            };
          }
          if (result.reason === "lead_time") {
            // Free, but too soon to book online. Offering other times on the
            // same day cannot help; the day has to move, so the day goes with
            // the time and the step re-reads a window that starts at the floor.
            const info = await tools.readClinicInfo(context);
            const phone = typeof info?.phone === "string" ? info.phone.trim() : "";
            return {
              kind: "invalidate",
              slots: ["day", "time"],
              memo: ["confirmed", "confirmed_at"],
              say: phone ? "booking.lead_time" : "booking.lead_time_no_phone",
              facts: phone ? { clinic_phone: phone } : {},
            };
          }
          if (result.reason === "not_ready" || result.reason === "failed") {
            // Nothing about the slot is wrong, so nothing about the slot is
            // said. A booking that cannot be written is a person's job.
            return { kind: "handoff", say: "flow.stuck", reason: "booking_failed" };
          }
          // The slot went while the patient was confirming it. Nothing was
          // created — `create_patient_preliminary_booking` refuses and the
          // package decrement rolls back with it — so the booking is not
          // finished, it is one step behind where it thought it was.
          //
          // `time` goes, and `confirmed` goes with it: the patient consented to
          // a specific appointment, and that consent cannot be carried over to
          // a different one. The engine re-advances straight into the time step,
          // so the same message that says "that one's taken" also offers the
          // times that are not — and because the write genuinely failed on
          // contention, the taken slot is gone from that list.
          //
          // Everything upstream survives — department, doctor, day, and the
          // package the patient accepted, which was never consumed. They are
          // not asked to build the booking again.
          return {
            kind: "invalidate",
            slots: ["time"],
            memo: ["confirmed", "confirmed_at"],
            // The refused time, recorded so the refresh cannot offer it back.
            // See `offerableTimes`.
            reject: [{ slot: "time" as const, value: slot(frame, "time")! }],
            say: "booking.slot_gone",
            facts: { reason: result.reason },
          };
        }
        return {
          kind: "complete",
          say: "booking.created",
          facts: {
            summary: await bookingSummary({ context, frame }),
            package_session: result.packageSessionNumber,
          },
        };
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// register_patient — the unified identity workflow
// ---------------------------------------------------------------------------

/**
 * Registration, and the one place identity is decided.
 *
 * The rules the brief sets out, in the order they are enforced:
 *
 *   1. **the national/civil id is the strongest discovery key.** It is asked
 *      for first and matched exactly, by `find_clinic_patient_by_identity`;
 *   2. **an exact id plus a plausible rendering of the name continues the
 *      existing file** rather than opening a second one. `resolveIdentity`
 *      returning `matched` ends the flow — there is no branch below it that
 *      creates anything;
 *   3. **a genuinely new file with an uncertain name asks for the Latin
 *      spelling before it is created**, using the existing `proposeLatinName`
 *      and the P10 behaviour of keeping the original beside it;
 *   4. **nothing is disclosed about anyone else.** Every non-match is the same
 *      `none`, so a caller cannot tell "no such id" from "that id belongs to
 *      somebody whose name you got wrong". The anti-existence-oracle property
 *      is a consequence of the RPC's shape, not of a check here.
 */
const registerPatient: FlowDefinition = {
  name: "register_patient",
  onAbandon: "confirm",
  public: true,
  steps: [
    {
      id: "full_name",
      fills: "full_name",
      pre: { slots: [], identity: "none" },
      invalidates: ["full_name_latin"],
      resolveValue: resolveIntakeField,
      run: async () => ({ kind: "ask", slot: "full_name", say: "intake.ask_name" }),
    },
    {
      id: "national_id",
      fills: "national_id",
      pre: { slots: ["full_name"], identity: "none" },
      resolveValue: async ({ spoken }) => {
        const digits = spoken.replace(/[^0-9]/g, "");
        // Length is the only shape check here. Whether it names anybody is the
        // database's question, and asking it is the next step.
        return digits.length >= 10 && digits.length <= 20
          ? { kind: "resolved", value: digits }
          : { kind: "unresolved" };
      },
      run: async () => ({ kind: "ask", slot: "national_id", say: "intake.ask_national_id" }),
    },
    {
      id: "identity_check",
      fills: null,
      pre: { slots: ["full_name", "national_id"], identity: "none" },
      run: async ({ context, frame }) => {
        if (frame.memo.identity_checked === true) {
          return { kind: "inform", say: "identity.already_checked" };
        }
        const resolution = await tools.resolveIdentity({
          context,
          nationalId: slot(frame, "national_id")!,
          fullName: slot(frame, "full_name")!,
        });
        if (resolution.kind === "matched") {
          // The existing file, continued. Nothing is created, and the canonical
          // name on record is what the assistant may greet them by — the name
          // ClinicFlow stores, never the one the patient typed.
          return {
            kind: "complete",
            say: "identity.existing_patient",
            facts: { canonical_name: resolution.canonicalName },
          };
        }
        if (resolution.kind === "ambiguous_department") {
          return {
            kind: "offer",
            slot: "department",
            offerKind: "identity_match",
            options: resolution.departments.map((department) => ({
              value: department.id,
              label: department.name,
              source: "identity_match" as const,
            })),
            say: "identity.which_department",
            facts: { canonical_name: resolution.canonicalName },
          };
        }
        return { kind: "inform", say: "identity.new_patient" };
      },
    },
    {
      /**
       * The Latin spelling, asked before a new file is created.
       *
       * Only on the *new patient* path — step 3 above ends the flow for a
       * matched one, so this can never fire for somebody who already has a
       * record. `proposeLatinName` returns null when the name is already
       * unambiguous Latin, and the step is skipped.
       */
      id: "full_name_latin",
      fills: "full_name_latin",
      pre: { slots: ["full_name", "national_id"], identity: "none" },
      resolveValue: resolveIntakeField,
      run: async ({ frame }) => latinNameOutcome(slot(frame, "full_name")!, false),
    },
    {
      id: "date_of_birth",
      fills: "date_of_birth",
      pre: { slots: ["full_name", "national_id"], identity: "none" },
      // Normalized deterministically, and offered back rather than assumed
      // whenever the day/month order is genuinely undecidable.
      resolveValue: resolveIntakeField,
      run: async () => ({ kind: "ask", slot: "date_of_birth", say: "intake.ask_dob" }),
    },
    {
      id: "email",
      fills: "email",
      pre: { slots: ["full_name", "national_id", "date_of_birth"], identity: "none" },
      resolveValue: resolveIntakeField,
      run: async () => ({ kind: "ask", slot: "email", say: "intake.ask_email" }),
    },
    {
      id: "done",
      fills: null,
      pre: {
        slots: ["full_name", "full_name_latin", "national_id", "date_of_birth", "email"],
        identity: "none",
      },
      // Registration on its own stages nothing: a file exists to hold a
      // request, and the booking flow's intake step is what stages it against
      // one. Ending here rather than writing keeps a single staging path.
      run: async () => ({ kind: "complete", say: "intake.collected" }),
    },
  ],
};

// ---------------------------------------------------------------------------
// answer_question — every read-only topic
// ---------------------------------------------------------------------------

const answerQuestion: FlowDefinition = {
  name: "answer_question",
  onAbandon: "discard",
  public: true,
  steps: [
    {
      id: "answer",
      fills: null,
      // The department a scoping question is answered with, so "which
      // department?" can actually be answered — `set_slot` resolves a slot's
      // owner by `fills` or by `collects`, and this step fills nothing.
      collects: ["department", "service"],
      resolveValue: async ({ spoken, slot: name, context }) => {
        if (name !== "department") return { kind: "resolved", value: spoken };
        const matches = await tools.resolveDepartmentSpoken({ context, spoken });
        if (matches.length === 1) {
          return { kind: "resolved", value: matches[0]!.value, label: matches[0]!.label };
        }
        return matches.length > 1
          ? { kind: "ambiguous", options: matches }
          : { kind: "unresolved" };
      },
      // `identity: "none"` is correct for the flow; the three patient-scoped
      // topics check identity themselves below and refuse rather than
      // disclosing, because the requirement varies per topic rather than per
      // flow.
      pre: { slots: [], identity: "none" },
      run: async ({ context, frame }) => {
        // Null is `clinic_other`, resolved once and here, so that no branch
        // below has to spell the fallback and no branch can spell it
        // differently. A `say` key is derived from this value, and a topic that
        // reached the composer as `info.null` would render nothing.
        const topic = frame.topic ?? "clinic_other";
        switch (topic) {
          case "departments": {
            const departments = await tools.readDepartments(context);
            return {
              kind: "complete",
              say: "info.departments",
              facts: { departments: departments.map((entry) => entry.label) },
            };
          }
          case "doctors": {
            const departmentId = slot(frame, "department");
            if (!departmentId) {
              const departments = await tools.readDepartments(context);
              return {
                kind: "offer",
                slot: "department",
                offerKind: "slot_value",
                options: departments,
                say: "info.which_department",
              };
            }
            const doctors = await tools.readDoctors({ context, departmentId });
            return {
              kind: "complete",
              say: "info.doctors",
              facts: { doctors: doctors.map((entry) => entry.label) },
            };
          }
          case "packages": {
            // A stranger's package question is answered from clinic
            // configuration. A patient's own packages are `my_packages`, a
            // different topic with a different identity requirement — the two
            // are separate so no argument mistake can turn one into the other.
            //
            // `scope` is the narrowing the patient wrote — «الجلدية»,
            // «باكيدج التأهيل» — and `packageAnswer` decides which of the
            // three widths it names. Rendered there rather than in the
            // composer: the composer fills placeholders and must never have to
            // know the shape of a domain row.
            return packageAnswer({
              context,
              scope: slot(frame, "service"),
              departmentId: slot(frame, "department"),
            });
          }
          case "my_packages": {
            if (context.identity !== "verified") {
              return { kind: "ask", slot: null, say: "identity.required", facts: { level: "verified" } };
            }
            const packages = await tools.readPatientPackages({ context });
            return {
              kind: "complete",
              say: "info.my_packages",
              facts: { packages: packages.map((entry) => entry.label) },
            };
          }
          case "my_appointments": {
            if (context.identity !== "verified") {
              return { kind: "ask", slot: null, say: "identity.required", facts: { level: "verified" } };
            }
            const appointments = await tools.readMyAppointments(context);
            return {
              kind: "complete",
              say: "info.my_appointments",
              facts: { count: appointments.length, appointments },
            };
          }
          case "my_documents":
            // Delegated rather than duplicated: retrieving a document is a flow
            // with a selection step in it, not a one-shot answer.
            return { kind: "complete", say: "info.see_documents_flow" };
          case "privacy":
            return { kind: "complete", say: "info.privacy" };
          case "capabilities":
            // A fixed, server-authored list of what this assistant actually
            // does. No read and no facts: every line below names a flow or a
            // topic that exists in `FLOW_REGISTRY` / `QUESTION_TOPICS`, and the
            // two lines that touch a patient's own record say out loud that
            // identity is verified first — the gate itself is unchanged and
            // still lives on those topics.
            return { kind: "complete", say: "info.capabilities" };
          case "prices":
          case "services": {
            // The authoritative catalog, or nothing.
            //
            // A service name and a price are structured ClinicFlow data, and
            // the only thing that may reach the patient is a row this read
            // returned. When the patient named a department, the answer is
            // scoped to it; when they named one that does not resolve, they
            // are asked which rather than shown a different one; and an empty
            // catalog is reported as empty. There is no branch here that
            // produces a service, and the composer downstream is given the
            // rendered lines rather than the shape of a row, so there is
            // nothing for it to complete either.
            const scope = slot(frame, "service");
            let departmentId: string | null = null;
            if (scope) {
              const matches = await tools.resolveDepartmentSpoken({
                context,
                spoken: scope,
              });
              if (matches.length === 1) departmentId = matches[0]!.value;
              else if (matches.length > 1) {
                return {
                  kind: "offer",
                  slot: "department",
                  offerKind: "slot_value",
                  options: matches,
                  say: "info.which_department",
                };
              }
            }
            const committed = slot(frame, "department");
            const catalog = await tools.readServices({
              context,
              departmentId: departmentId ?? committed,
            });
            if (catalog.total === 0) {
              return {
                kind: "complete",
                say: "info.services_none",
                facts: { scoped: Boolean(departmentId ?? committed) },
              };
            }
            // Grouped under department headings, with each price on the line of
            // the service it belongs to. Rendered here rather than in the
            // composer for the reason every other catalog is: the composer
            // fills placeholders and must never have to know the shape of a
            // domain row. Asking about one department produces one group, in
            // the same shape — there is no second layout for the scoped case.
            return {
              kind: "complete",
              say: "info.services",
              facts: {
                services: renderServiceGroups(catalog.groups, catalog.currency),
              },
            };
          }
          case "insurance": {
            // The clinic's own `insurance_providers`, not its contact row. This
            // branch used to fall through to `default:`, which read the clinic
            // address and labelled it `info.insurance` — a key with no copy, so
            // the patient received the generic opening instead.
            //
            // `scope` carries the insurer the patient named, when they named
            // one, so «بتقبلوا AXA؟» is a yes/no about this clinic's own
            // configuration rather than the full list with the question
            // unanswered.
            return insuranceAnswer({ context, scope: slot(frame, "service") });
          }
          case "clinic_other": {
            // Anything the clinic wrote an answer for. `clinic_other` is the
            // interpreter's "a question about this clinic that is not one of
            // the structured topics", and the clinic's own FAQ is exactly the
            // thing that answers it — the one settings surface V2 could not
            // reach at all, because `readClinicFaq` existed and nothing called
            // it.
            //
            // The patient's words are the query and nothing else: no history,
            // no durable facts. The rows come back as untrusted, clinic-authored
            // text and are quoted, never followed as instructions.
            const matches = await tools.readClinicFaq({
              context,
              question: context.turn.text,
            });
            const best = matches[0];
            if (!best) return { kind: "complete", say: "info.faq_none" };
            return {
              kind: "complete",
              say: "info.faq_answer",
              facts: { answer: String(best.answer ?? "").trim() },
            };
          }
          case "address":
          case "phone":
          case "website":
          case "email":
          case "opening_hours":
          default: {
            // The clinic's stored contact settings.
            //
            // Every one of these topics already loaded this row and then threw
            // it away: the step said `say: \`info.${topic}\`` and the composer
            // had no such key, so `composeDeterministic` skipped the effect and
            // fell through to `clarify.open` — «اتفضل، أقدر أساعدك في إيه؟».
            // That is the greeting a patient received when they asked for the
            // address inside a live episode.
            //
            // The field is rendered here rather than in the composer, following
            // the same rule the services and packages branches follow: the
            // composer fills placeholders and must never know the shape of a
            // domain row.
            const info = await tools.readClinicInfo(context);
            if (!info) return { kind: "inform", say: "info.unavailable" };
            const detail = clinicDetail(topic, info, context);
            if (!detail) {
              // The clinic has not configured this one. Saying so is an answer;
              // inventing a plausible address is the one thing that must never
              // happen here.
              return {
                kind: "complete",
                say: "info.detail_unset",
                facts: { clinic_name: info.name ?? "" },
              };
            }
            return {
              kind: "complete",
              say: `info.${topic}`,
              facts: { value: detail },
            };
          }
        }
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// package_inquiry, retrieve_document, cancel, reschedule, relationship lookup
// ---------------------------------------------------------------------------

const packageInquiry: FlowDefinition = {
  name: "package_inquiry",
  onAbandon: "discard",
  public: true,
  steps: [
    {
      id: "list",
      fills: null,
      pre: { slots: [], identity: "none" },
      // The narrowing the patient wrote, declared so `set_slot` has a step to
      // land on. Without it a scope reaches no step, is dropped as
      // `slot_not_in_flow`, and «قولي باكيدجات الجلدية» answers with the whole
      // catalog — the same defect the `date_lower_bound` declaration fixed on
      // the booking day step.
      collects: ["department", "service"],
      resolveValue: async ({ spoken, slot: name, context }) => {
        if (name !== "department") return { kind: "resolved", value: spoken };
        const matches = await tools.resolveDepartmentSpoken({ context, spoken });
        if (matches.length === 1) {
          return { kind: "resolved", value: matches[0]!.value, label: matches[0]!.label };
        }
        return matches.length > 1
          ? { kind: "ambiguous", options: matches }
          : { kind: "unresolved" };
      },
      // The same answer the `packages` topic gives, from the same function.
      // A dedicated flow and a topic are two doors into one question, and the
      // moment they render it differently the clinic has two package layouts.
      run: async ({ context, frame }) =>
        packageAnswer({
          context,
          scope: slot(frame, "service"),
          departmentId: slot(frame, "department"),
        }),
    },
  ],
};

/**
 * Document retrieval — delivery only, never issuance.
 *
 * `verified` on every step, because a document is the patient's own record.
 * The list comes from `list_patient_ai_documents`, which selects only
 * `status = 'issued'` rows belonging to the conversation's own patient, so
 * there is no argument by which another person's document could be listed and
 * no branch anywhere that creates one. A patient asking to be *issued*
 * something new never reaches this flow: the interpreter is instructed to emit
 * `request_handoff`, and even if it did not, no step here can write.
 */
const retrieveDocument: FlowDefinition = {
  name: "retrieve_document",
  onAbandon: "discard",
  public: false,
  steps: [
    {
      id: "choose",
      fills: "document",
      pre: { slots: [], identity: "verified" },
      run: async ({ context }) => {
        const documents = await tools.readPatientDocuments({ context });
        if (documents.length === 0) {
          return { kind: "complete", say: "documents.none" };
        }
        return {
          kind: "offer",
          slot: "document",
          offerKind: "document_choice",
          options: documents,
          say: "documents.choose",
        };
      },
    },
    {
      id: "deliver",
      fills: null,
      pre: { slots: ["document"], identity: "verified" },
      run: async ({ context, frame }) => {
        const link = await tools.readDocumentLink({
          context,
          documentId: slot(frame, "document")!,
        });
        if (!link) return { kind: "inform", say: "documents.unavailable" };
        return {
          kind: "complete",
          say: "documents.delivered",
          facts: { url: link.url, label: link.label },
        };
      },
    },
  ],
};

/**
 * Grounds a spoken appointment reference against the patient's own list.
 *
 * Shared by cancel and reschedule. Without it, `set_slot(appointment, …)`
 * committed whatever the patient said as an appointment id — the same
 * ungrounded-commit class as the reschedule date. The write behind it would
 * have refused, so nothing unsafe reached the database; but "I couldn't cancel
 * that, the team will help" is a much worse answer than "which one?", and a
 * slot that holds a phrase where an id belongs is a lie the rest of the flow
 * reads as truth.
 */
async function resolveSpokenAppointment(input: {
  spoken: string;
  context: TurnContext;
}): Promise<SlotResolution> {
  const appointments = await tools.readMyAppointments(input.context);
  const options = appointments.map((appointment) => ({
    value: String(appointment.appointment_id ?? appointment.id),
    label: String(appointment.scheduled_at ?? ""),
    source: "patient_appointments" as const,
  }));
  const wanted = input.spoken.trim();
  const matches = options.filter(
    (option) => option.value === wanted || option.label === wanted,
  );
  if (matches.length === 1) {
    return { kind: "resolved", value: matches[0]!.value, label: matches[0]!.label };
  }
  if (matches.length > 1) return { kind: "ambiguous", options: matches };
  return { kind: "unresolved" };
}

const cancelAppointment: FlowDefinition = {
  name: "cancel_appointment",
  onAbandon: "discard",
  public: false,
  steps: [
    {
      id: "choose",
      fills: "appointment",
      pre: { slots: [], identity: "linked" },
      resolveValue: resolveSpokenAppointment,
      run: async ({ context }) => {
        const appointments = await tools.readMyAppointments(context);
        if (appointments.length === 0) {
          return { kind: "complete", say: "appointments.none" };
        }
        return {
          kind: "offer",
          slot: "appointment",
          offerKind: "slot_value",
          options: appointments.map((appointment) => ({
            value: String(appointment.appointment_id ?? appointment.id),
            label: String(appointment.scheduled_at ?? ""),
            source: "patient_appointments" as const,
          })),
          say: "cancel.choose",
        };
      },
    },
    {
      id: "confirm",
      fills: null,
      pre: { slots: ["appointment"], identity: "linked" },
      run: async ({ context, frame }) => {
        if (frame.memo.confirmed !== true) {
          return {
            kind: "offer",
            slot: null,
            offerKind: "summary",
            options: [{ value: "cancel", label: "cancel", source: "clinic_directory" }],
            say: "cancel.review",
          };
        }
        const result = await tools.commitCancellation({
          context,
          appointmentId: slot(frame, "appointment")!,
        });
        // The copy says the clinic team will help. Before, nothing made that
        // true: `inform` ended the turn with a promise nobody was on the other
        // end of. A failed write here is not something the patient can retry
        // their way out of, so it hands over — which is what the sentence has
        // always claimed.
        return result.ok
          ? { kind: "complete", say: "cancel.done" }
          : { kind: "handoff", say: "cancel.failed" };
      },
    },
  ],
};

/**
 * Reschedule — the same grounding discipline as booking, for the same reason.
 *
 * Days and times come from the clinic's own calendar, read against the doctor
 * `prepare_patient_ai_reschedule` reports for this appointment, and the
 * patient's words are *matched* against what was offered rather than parsed
 * into a date. The version this replaces had no resolver on `day` at all, so
 * "بكرة" was committed verbatim and handed to an RPC that does not take a date;
 * the `time` step then offered the appointment row itself as a time option.
 *
 * `memo.reschedule_*` holds the server-issued identifiers between turns —
 * scalars the server put there, never anything the model wrote — so the
 * calendar reads on the day and time steps ask about the same doctor the
 * confirmation will move.
 */
const rescheduleAppointment: FlowDefinition = {
  name: "reschedule_appointment",
  onAbandon: "discard",
  public: false,
  steps: [
    {
      id: "choose",
      fills: "appointment",
      pre: { slots: [], identity: "linked" },
      resolveValue: resolveSpokenAppointment,
      invalidates: ["day", "time"],
      run: async ({ context }) => {
        const appointments = await tools.readMyAppointments(context);
        if (appointments.length === 0) {
          return { kind: "complete", say: "appointments.none" };
        }
        return {
          kind: "offer",
          slot: "appointment",
          offerKind: "slot_value",
          options: appointments.map((appointment) => ({
            value: String(appointment.appointment_id ?? appointment.id),
            label: String(appointment.scheduled_at ?? ""),
            source: "patient_appointments" as const,
          })),
          say: "reschedule.choose",
        };
      },
    },
    {
      id: "day",
      fills: "day",
      pre: { slots: ["appointment"], identity: "linked" },
      invalidates: ["time"],
      resolveValue: async ({ spoken, frame, context }) => {
        const result = await rescheduleDays(context, frame);
        if (!result.ok) return { kind: "unresolved" };
        // Committable only if the server offered it. Same rule as booking.
        const matches = matchOfferedDays(result.days, spoken);
        if (matches.length === 1) {
          return { kind: "resolved", value: matches[0]!.value, label: matches[0]!.label };
        }
        if (matches.length > 1) return { kind: "ambiguous", options: matches };
        return { kind: "unresolved" };
      },
      run: async ({ context, frame }) => {
        const result = await rescheduleDays(context, frame);
        // The appointment could not be resolved at all — a cancelled row, a
        // verification that lapsed. Nothing the patient can answer, so a person
        // takes it rather than the flow asking a question with no answer.
        if (!result.ok) return { kind: "handoff", say: "reschedule.unavailable" };
        if (result.days.length === 0) {
          return { kind: "ask", slot: null, say: "reschedule.no_days" };
        }
        return {
          kind: "offer",
          slot: "day",
          offerKind: "slot_value",
          options: result.days,
          say: "reschedule.choose_day",
        };
      },
    },
    {
      id: "time",
      fills: "time",
      pre: { slots: ["appointment", "day"], identity: "linked" },
      resolveValue: async ({ spoken, frame, context }) => {
        const result = await rescheduleTimes(context, frame);
        if (!result.ok) return { kind: "unresolved" };
        const matches = matchOfferedTimes(result.times, spoken);
        if (matches.length === 1) {
          return { kind: "resolved", value: matches[0]!.value, label: matches[0]!.label };
        }
        if (matches.length > 1) return { kind: "ambiguous", options: matches };
        return { kind: "unresolved" };
      },
      run: async ({ context, frame }) => {
        const result = await rescheduleTimes(context, frame);
        if (!result.ok || result.times.length === 0) {
          return { kind: "ask", slot: null, say: "reschedule.no_times" };
        }
        return {
          kind: "offer",
          slot: "time",
          offerKind: "slot_value",
          options: result.times,
          say: "reschedule.choose_time",
        };
      },
    },
    {
      id: "confirm",
      fills: null,
      pre: { slots: ["appointment", "day", "time"], identity: "linked" },
      run: async ({ context, frame }) => {
        if (frame.memo.confirmed !== true) {
          return {
            kind: "offer",
            slot: null,
            offerKind: "summary",
            options: [{ value: "reschedule", label: "reschedule", source: "clinic_directory" }],
            say: "reschedule.review",
            facts: { day: slot(frame, "day"), time: slot(frame, "time") },
          };
        }
        // Day and time are separate committed slots and the RPC takes one
        // instant. The tool composes them *in the clinic's timezone* — see
        // `commitReschedule`; joining them here into a naive string was how a
        // confirmed 12:15 reached the calendar as 12:15 UTC.
        const result = await tools.commitReschedule({
          context,
          appointmentId: slot(frame, "appointment")!,
          date: slot(frame, "day")!,
          time: slot(frame, "time")!,
        });
        return result.ok
          ? {
              kind: "complete",
              say: "reschedule.done",
              facts: { day: slot(frame, "day"), time: slot(frame, "time") },
            }
          : { kind: "handoff", say: "reschedule.failed" };
      },
    },
  ],
};

/**
 * The appointment this reschedule is about, resolved from the committed slot.
 *
 * Read on every calendar access rather than cached on the frame. Caching it
 * would create a staleness class the flow has no way to invalidate: `choose`
 * declares `invalidates: ["day", "time"]`, but the correction cascade clears
 * *slots*, not memo entries, so a patient who changed their mind about which
 * appointment to move would have kept the previous one's doctor and been shown
 * the wrong diary. One extra read per calendar step is the cheaper side of that
 * trade by a wide margin.
 */
async function rescheduleTarget(context: TurnContext, frame: FlowFrame) {
  const appointmentId = slot(frame, "appointment");
  if (!appointmentId) return null;
  const target = await tools.readRescheduleTarget({ context, appointmentId });
  return target.ok ? target : null;
}

async function rescheduleDays(context: TurnContext, frame: FlowFrame) {
  const target = await rescheduleTarget(context, frame);
  if (!target) return { ok: false as const, reason: "no_target" };
  return tools.readAvailableDays({
    context,
    doctorId: target.doctorId,
    serviceId: target.serviceId,
    durationMinutes: target.durationMinutes,
  });
}

async function rescheduleTimes(context: TurnContext, frame: FlowFrame) {
  const target = await rescheduleTarget(context, frame);
  const date = slot(frame, "day");
  if (!target || !date) return { ok: false as const, reason: "no_target" };
  return tools.readAvailableSlots({
    context,
    doctorId: target.doctorId,
    date,
    serviceId: target.serviceId,
    durationMinutes: target.durationMinutes,
  });
}

/**
 * "مين الدكتور اللي كنت بتابع معاه؟" — the explicit history question.
 *
 * A flow of its own precisely because it is the one turn on which the patient's
 * treating doctor is *the answer* rather than a suggestion. It requires
 * `verified`, because naming the doctor somebody has been seeing is a
 * disclosure about their record. It starts no booking and offers nothing.
 */
const patientRelationshipLookup: FlowDefinition = {
  name: "patient_relationship_lookup",
  onAbandon: "discard",
  public: false,
  steps: [
    {
      id: "lookup",
      fills: null,
      pre: { slots: [], identity: "verified" },
      run: async ({ context }) => {
        const doctors = await context.durable.treatingDoctors();
        if (doctors.length === 0) {
          return { kind: "complete", say: "relationship.none" };
        }
        return {
          kind: "complete",
          say: "relationship.doctors",
          facts: { doctors: doctors.map((doctor) => doctor.label) },
        };
      },
    },
  ],
};

export const FLOW_REGISTRY: FlowRegistry = {
  book_appointment: bookAppointment,
  register_patient: registerPatient,
  answer_question: answerQuestion,
  package_inquiry: packageInquiry,
  retrieve_document: retrieveDocument,
  cancel_appointment: cancelAppointment,
  reschedule_appointment: rescheduleAppointment,
  patient_relationship_lookup: patientRelationshipLookup,
};
