/**
 * F-8 — intake provenance: an identity value may only be committed if the
 * patient actually supplied it.
 *
 * ## The defect this exists for
 *
 * The managed live acceptance run (`docs/reviews/artifacts/patient-assistant-
 * live-acceptance.json`, case `incomplete-intake`) recorded a **committed**
 * `create_preliminary_booking` for a stranger who had given exactly one piece
 * of personal information — their name. The national id, the date of birth and
 * the email that unlocked the write were produced by the model, passed to
 * `register_patient`, validated as *well-formed*, staged, and the booking then
 * went in behind the staged intake.
 *
 * Every check on that path was a **format** check. `parseNationalId` asks "is
 * this 5–32 alphanumerics?", `parseHumanDate` asks "is this a real calendar
 * date?", `parseHumanEmail` asks "does this have an @ and a dot?". A fabricated
 * value passes all three, because a fabricated value is well-formed by
 * construction — that is what makes it a fabrication rather than a typo.
 *
 * Nothing in the pipeline asked the only question that separates the two:
 *
 * > **Did this value come from the patient?**
 *
 * ## The rule
 *
 * A required intake field may be committed only when its value is *traceable*
 * to something the patient typed in the current episode. The episode's inbound
 * messages are the evidence; the field value is the claim; this module is the
 * comparison.
 *
 * It is deliberately a **gate, not a parser**. It never produces a value, never
 * corrects one, and never chooses between two. It answers one question about a
 * value somebody else already resolved, and the only thing it can do is refuse.
 *
 * ## Why it cannot be talked around
 *
 * The comparison runs server-side, after the model's arguments have been
 * resolved and before the write, over text the model does not author. A model
 * that invents a national id cannot also invent the patient's message that
 * would justify it: the utterances come from `inbound_messages`, which only the
 * transport writes. There is no prompt, no tool argument and no tool result
 * that reaches this decision.
 *
 * ## What it must not break
 *
 * Legitimate normalization is the whole point of `human-input.ts` and is
 * preserved exactly:
 *
 *   * `٢٩٠٠٤١٢١٢٠٠٣٤٥` typed, `29004121200345` committed — digits are folded on
 *     both sides before they are compared.
 *   * `١٢/٤/١٩٩٠`, `12 April 1990` or `١٢ ابريل ١٩٩٠` typed, `1990-04-12`
 *     committed — every calendar reading of every date-shaped fragment in the
 *     episode is admitted as evidence, so whichever one the resolver chose is
 *     traceable.
 *   * `Omar  Hassan ` typed, `Omar Hassan` committed — names compare as token
 *     sets over normalized, transliterated words, so spacing, diacritics,
 *     Arabic article and the Arabic→Latin transliteration the file name goes
 *     through are all free.
 *   * ` OMAR@Example.COM ` typed, `omar@example.com` committed — case and
 *     spacing folded.
 *
 * What is *not* free is a token, a digit run, an address or a calendar date
 * that appears nowhere in what the patient wrote. That is the fabrication, and
 * that is what this refuses.
 *
 * Pure. No `server-only`, no database, no clock beyond what the caller passes,
 * so the production tools and the acceptance harness run the identical
 * decision.
 */

import {
  normalizeDigits,
  normalizeHumanText,
  parseHumanDate,
  parseHumanEmail,
  parseNationalId,
  type DateOrder,
} from "@/lib/ai/human-input";
import { normalizeEntityText } from "@/lib/ai/entity-resolution";

/** The intake fields this gate has an opinion about. */
export type ProvenanceField =
  | "full_name"
  | "national_id"
  | "date_of_birth"
  | "email"
  | "phone";

export const PROVENANCE_FIELDS: readonly ProvenanceField[] = [
  "full_name",
  "national_id",
  "date_of_birth",
  "email",
  "phone",
];

/**
 * Everything the patient actually typed this episode, reduced to the shapes an
 * intake value can be compared against.
 *
 * Derived once per turn and carried as data, so the comparison itself is a set
 * membership test rather than a re-parse per field.
 */
export type IntakeEvidence = {
  /** Digit runs of length >= 4, digits folded. National ids and phones. */
  digitRuns: ReadonlySet<string>;
  /** Every calendar reading of every date-shaped fragment, `YYYY-MM-DD`. */
  dates: ReadonlySet<string>;
  /** Email addresses, lower-cased. */
  emails: ReadonlySet<string>;
  /** Name-ish word tokens, normalized and transliterated. */
  nameTokens: ReadonlySet<string>;
  /** How many utterances went in. Zero means "no evidence", not "everything is fine". */
  utterances: number;
};

export type ProvenanceOutcome = {
  /** True when every checked field traced back to the patient's own words. */
  ok: boolean;
  /** The fields whose values the patient never supplied, in field order. */
  untraceable: readonly ProvenanceField[];
  /** The fields that were checked and passed. For the audit trace. */
  traceable: readonly ProvenanceField[];
  /**
   * False when the caller supplied no evidence source at all, so nothing was
   * checked.
   *
   * The distinction is deliberate and is the reason `evidence: null` is a
   * separate input from `evidence: <empty>`. A caller that has an episode
   * transcript and finds it empty is telling this gate that the patient has
   * said nothing, and every value is then untraceable — which is correct, and
   * is the safe direction. A caller that has *no* transcript (a unit test
   * exercising the identity RPC, a call site predating this gate) is not making
   * a claim about the patient at all, and refusing it would replace a real
   * safety property with a wiring accident.
   *
   * The wiring itself is asserted separately, so "the gate is not configured"
   * cannot become the silent production default. See
   * `tests/unit/ai/intake-provenance.test.ts`.
   */
  configured: boolean;
};

const MIN_DIGIT_RUN = 4;

/**
 * Words that are never part of a name and that a patient writes constantly.
 *
 * Kept small on purpose. Its only job is to stop a fabricated name being
 * "traced" to filler the patient happened to type ("عايز احجز" does not make
 * "Ahmed" traceable). It cannot make a real name untraceable, because a real
 * name's tokens are not in it.
 */
const NAME_STOP_WORDS: readonly string[] = [
  // Arabic booking / intake / courtesy filler, written the way patients type it.
  "عايز", "عاوز", "عايزة", "عاوزة", "محتاج", "محتاجة", "اريد", "أريد", "ابغى",
  "أبغى", "بدي", "ممكن", "احجز", "أحجز", "حجز", "موعد", "مواعيد", "ميعاد",
  "معاد", "عند", "مع", "في", "لو", "سمحت", "من", "فضلك", "رجاء", "شكرا",
  "شكراً", "تمام", "ايوه", "أيوه", "نعم", "لا", "اسمي", "أسمي", "اسمه", "انا",
  "أنا", "هو", "هي", "الرقم", "رقم", "القومي", "تاريخ", "ميلادي", "ميلاد",
  "البريد", "ايميل", "إيميل", "بريد", "الالكتروني", "الإلكتروني", "يوم",
  "شهر", "سنة", "الغاء", "إلغاء", "الغي", "ألغي", "دكتور", "دكتورة", "قسم",
  "الساعة", "ساعة", "اول", "أول", "تاني", "ثاني", "متاح", "المتاح",
  // Latin filler.
  "i", "we", "my", "me", "am", "is", "are", "the", "a", "an", "to", "for",
  "with", "want", "need", "would", "like", "book", "booking", "appointment",
  "please", "yes", "no", "ok", "okay", "thanks", "thank", "you", "your",
  "name", "email", "mail", "id", "national", "date", "birth", "dob", "born",
  "of", "and", "it", "its", "that", "this", "hi", "hello", "doctor", "dr",
  "cancel", "day", "time", "first", "second", "available",
];

/**
 * Built by running the words through the same normalizer the comparison uses,
 * rather than by hand-writing their transliterations. A hand-written table
 * drifts the moment `normalizeEntityText` changes, and a stop word that no
 * longer matches silently widens what counts as a name.
 */
const NAME_STOP_TOKENS: ReadonlySet<string> = new Set(
  NAME_STOP_WORDS.flatMap((word) =>
    normalizeEntityText(word)
      .split(" ")
      .filter((token) => token.length > 0),
  ),
);

/**
 * Reduces the episode's patient messages to comparable evidence.
 *
 * `order` decides how a bare `12/9/2000` is read — but both readings are kept
 * regardless, because this is evidence collection and not resolution: the point
 * is that whatever reading the *resolver* settled on is recognised as having
 * come from the patient.
 */
export function collectIntakeEvidence(
  utterances: readonly string[],
  options: { order?: DateOrder; now?: Date } = {},
): IntakeEvidence {
  const digitRuns = new Set<string>();
  const dates = new Set<string>();
  const emails = new Set<string>();
  const nameTokens = new Set<string>();

  for (const raw of utterances) {
    if (typeof raw !== "string") continue;
    const text = normalizeHumanText(raw);
    if (text.length === 0) continue;

    // -- digit runs --------------------------------------------------------
    for (const run of text.match(/\d+/g) ?? []) {
      if (run.length >= MIN_DIGIT_RUN) digitRuns.add(run);
    }
    // A national id or phone written with separators — "2900 4121 2003 45",
    // "0100-000-0001" — is one run to a human and several to a regex. The
    // separator-stripped join of a whole message is admitted as one more
    // candidate run, never as anything else.
    const joined = text.replace(/[^\d]/g, "");
    if (joined.length >= MIN_DIGIT_RUN) digitRuns.add(joined);

    // -- emails ------------------------------------------------------------
    for (const token of text.split(/\s+/)) {
      const email = parseHumanEmail(token);
      if (email) emails.add(email);
    }

    // -- dates -------------------------------------------------------------
    for (const iso of dateReadings(text, options)) dates.add(iso);

    // -- name tokens -------------------------------------------------------
    for (const token of normalizeEntityText(text).split(" ")) {
      if (token.length < 2) continue;
      if (NAME_STOP_TOKENS.has(token)) continue;
      if (/^\d+$/.test(token)) continue;
      nameTokens.add(token);
    }
  }

  return {
    digitRuns,
    dates,
    emails,
    nameTokens,
    utterances: utterances.filter((item) => typeof item === "string" && item.trim().length > 0)
      .length,
  };
}

/**
 * Every calendar date a message could be stating.
 *
 * Both readings of an ambiguous numeric date are admitted, and every
 * date-shaped fragment in a longer message is tried, so a patient who wrote
 * their birthday inside a sentence is still the source of it.
 */
function dateReadings(
  text: string,
  options: { order?: DateOrder; now?: Date },
): string[] {
  const out: string[] = [];
  const push = (value: string) => {
    const parsed = parseHumanDate(value, {
      ...(options.order ? { order: options.order } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
    if (parsed.ok) {
      out.push(parsed.iso);
      if (parsed.alternativeIso) out.push(parsed.alternativeIso);
    }
  };
  push(text);
  // Fragments, so "اسمي عمر ومواليد ١٢/٤/١٩٩٠" is read as well as a bare date.
  for (const fragment of text.match(/\d{1,4}\s*[-/.]\s*\d{1,2}\s*[-/.]\s*\d{1,4}/g) ?? []) {
    push(fragment);
  }
  // A date written with a month name, with up to three words of run-in either
  // side, so it survives being embedded in a sentence.
  for (const fragment of
    text.match(/(?:\d{1,4}\s+)?[\p{L}]{3,12}\s+\d{1,2}(?:\s*,)?\s+\d{2,4}/gu) ?? []) {
    push(fragment);
  }
  for (const fragment of text.match(/\d{1,2}\s+[\p{L}]{3,12}\s+\d{2,4}/gu) ?? []) {
    push(fragment);
  }
  return out;
}

/** The value of one field, as the caller is about to commit it. */
export type ProvenanceClaim = Partial<Record<ProvenanceField, string | null | undefined>>;

/**
 * Which of the supplied field values the patient did not actually supply.
 *
 * A field whose value is absent is not checked: "not given" is the intake
 * contract's problem (`unreadable_fields`), not this one. Only a value that is
 * about to be **committed** is asked to prove where it came from.
 */
export function checkIntakeProvenance(input: {
  /** The episode's evidence, or `null` when the caller has no transcript. */
  evidence: IntakeEvidence | null;
  claim: ProvenanceClaim;
}): ProvenanceOutcome {
  if (input.evidence === null) {
    return { ok: true, untraceable: [], traceable: [], configured: false };
  }
  const evidence = input.evidence;
  const untraceable: ProvenanceField[] = [];
  const traceable: ProvenanceField[] = [];
  for (const field of PROVENANCE_FIELDS) {
    const value = input.claim[field];
    if (typeof value !== "string" || value.trim().length === 0) continue;
    if (isTraceable(field, value, evidence)) traceable.push(field);
    else untraceable.push(field);
  }
  return {
    ok: untraceable.length === 0,
    untraceable,
    traceable,
    configured: true,
  };
}

/** Whether one resolved value traces back to the patient's own words. */
export function isTraceable(
  field: ProvenanceField,
  value: string,
  evidence: IntakeEvidence,
): boolean {
  switch (field) {
    case "national_id":
    case "phone": {
      const digits = normalizeDigits(parseNationalId(value) ?? value).replace(/\D/g, "");
      if (digits.length < MIN_DIGIT_RUN) return false;
      for (const run of evidence.digitRuns) {
        // `includes` rather than equality: a phone the patient wrote with a
        // country code and the tool normalized without one (or the reverse) is
        // the same number, and a run that *contains* the committed digits was
        // still typed by the patient. It can never admit digits they did not
        // type, which is the only direction that matters here.
        if (run === digits || run.includes(digits) || digits.includes(run)) return true;
      }
      return false;
    }
    case "date_of_birth": {
      const iso = normalizeDigits(value.trim()).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
      if (evidence.dates.has(iso)) return true;
      // The digits of the date, however the patient wrote them: "12041990",
      // "١٢٤١٩٩٠". Admitted only when every component is present, so a bare
      // year can never carry a whole date of birth.
      const [y, m, d] = [iso.slice(0, 4), iso.slice(5, 7), iso.slice(8, 10)];
      for (const run of evidence.digitRuns) {
        if (
          run.includes(y) &&
          (run.includes(m) || run.includes(String(Number(m)))) &&
          (run.includes(d) || run.includes(String(Number(d))))
        ) {
          return true;
        }
      }
      return false;
    }
    case "email": {
      const email = parseHumanEmail(value);
      return email !== null && evidence.emails.has(email);
    }
    case "full_name": {
      const tokens = normalizeEntityText(value)
        .split(" ")
        .filter((token) => token.length >= 2);
      if (tokens.length === 0) return false;
      // EVERY token must have been typed. A name is not traceable because one
      // of its three parts happens to appear somewhere: an assistant that
      // turned "عمر" into "Omar Hassan Mohamed" would be inventing two thirds
      // of a medical record.
      return tokens.every((token) => evidence.nameTokens.has(token));
    }
    default:
      return false;
  }
}

/**
 * The refusal a tool returns when a value could not be traced.
 *
 * Says nothing about *which* value looked invented and quotes nothing back:
 * the patient is simply asked for the detail again, which is the same thing
 * they see when a value was genuinely unreadable. The distinction matters to
 * the audit trail, never to the person on WhatsApp.
 */
export const INTAKE_PROVENANCE_GUIDANCE =
  "These details were not supplied by the patient in this conversation, so nothing was saved. " +
  "Ask the patient for them, in ordinary words, and call this tool again with exactly what they " +
  "write. Never supply a value the patient has not typed — an example, a placeholder, a value " +
  "carried over from another conversation, or one you have inferred. If they have already " +
  "written it, use their exact words.";
