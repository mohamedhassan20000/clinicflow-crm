import { patientSchema } from "@/lib/validations/patient";

/**
 * P11J-2 — the single source of truth for what a new patient file needs, and
 * the only place that decides how those fields are *named to a patient*.
 *
 * ## Why this module exists
 *
 * The P11J manual-QA regression was not a wording bug. At the end of a booking
 * flow the assistant told a patient, in Arabic:
 *
 * ```
 *   أحتاج تصحيح أو استكمال البيانات التالية فقط (national_id, date_of_birth, phone).
 * ```
 *
 * That sentence was not written by the model. It was composed *deterministically*
 * by the server, in `patient-write-commit.ts`, which took the `fields` array the
 * `register_patient` tool returns — an internal, machine-facing list — and
 * `join(", ")`-ed it straight into patient-visible WhatsApp copy. Because that
 * copy is the enforced write-boundary reply, it replaced whatever the model said
 * on *every* turn, which is also why the patient saw the same list repeatedly
 * instead of a question they could answer.
 *
 * So the fix has two halves, and both live here:
 *
 *   1. **A contract, not a hand-written AI schema.** Which fields a new patient
 *      file requires is derived from `patientSchema` — the exact schema the
 *      ClinicFlow New Patient form and `patientCreateSchema` use — unioned with
 *      the not-null columns of the `ai_patient_intakes` staging table. Nothing
 *      here restates a requirement that those two do not already impose, and a
 *      change to the real form propagates without editing this file.
 *
 *   2. **A patient-facing language layer.** Every internal field identifier has
 *      exactly one localized label and one natural question. Tool results,
 *      validation issues and missing-field lists must pass through it before any
 *      of them can become something a patient reads.
 *
 * ## The requirement set, and where it differs from the QA brief
 *
 * The brief asked for: full name, national id, date of birth, department and
 * doctor as required; phone and blood type as optional. The live schema says:
 *
 *   * `full_name`, `national_id`, `date_of_birth` — required. Agrees.
 *   * `email` — **required**, by `patientSchema` (`.email()`, no `.optional()`)
 *     *and* by `ai_patient_intakes.email NOT NULL`. It is not in the brief, but
 *     it is a genuine current requirement, not an invented one, so it is
 *     collected. Removing it is a schema change, not an assistant change.
 *   * `phone` — **required** by `patientSchema` and by
 *     `ai_patient_intakes.phone NOT NULL`. It is nonetheless never *asked* of
 *     the person writing in: their number is channel-owned and the staging RPC
 *     takes it from the verified conversation participant. So it is required by
 *     the schema and un-askable for the sender — which is what the brief
 *     observed as "optional". For somebody being booked *by* the sender there is
 *     no channel to take it from, so it is asked and required.
 *   * `blood_type` — optional in both. Agrees.
 *   * `department_id` / `doctor_id` — optional on `patientSchema`
 *     (`assigned_doctor_id`), but **NOT NULL** on `ai_patient_intakes`. An AI
 *     intake cannot be staged without them, so for this flow they are required —
 *     and they are already chosen during booking, never asked twice.
 */

/**
 * The staging table's not-null columns, as a set this module can reason about.
 *
 * `patientSchema` is authoritative for the patient record. It is *not*
 * authoritative for the AI intake row, which additionally pins the department
 * and the doctor so a staged file cannot reach staff review unassigned. Keeping
 * the two sources separate — rather than hand-merging them into one list — is
 * what makes the union below checkable against the migration.
 *
 * Source: `supabase/migrations/20260822120000_ai_patient_intake_booking_upgrade.sql`
 */
const AI_INTAKE_NOT_NULL = new Set([
  "full_name",
  "national_id",
  "date_of_birth",
  "phone",
  "email",
  "department_id",
  "doctor_id",
]);

/** Intake field key → the key it occupies on the real patient schema. */
const PATIENT_SCHEMA_KEY = {
  full_name: "full_name",
  national_id: "national_id",
  date_of_birth: "date_of_birth",
  email: "email",
  phone: "phone",
  blood_type: "blood_type",
  department_id: "department_id",
  doctor_id: "assigned_doctor_id",
} as const;

/**
 * Asking order. Identity first, contact second, assignment third, optional last
 * — the order a receptionist would use, and the order the questions below read
 * as a conversation rather than a form.
 */
export const PATIENT_INTAKE_FIELDS = [
  "full_name",
  "national_id",
  "date_of_birth",
  "email",
  "phone",
  "department_id",
  "doctor_id",
  "blood_type",
] as const;

export type IntakeField = (typeof PATIENT_INTAKE_FIELDS)[number];

export type IntakeSubject = "self" | "other";

/** True when the live patient schema itself refuses a missing value. */
export function requiredByPatientSchema(field: IntakeField): boolean {
  const shape = patientSchema.shape as Record<string, { isOptional(): boolean }>;
  const entry = shape[PATIENT_SCHEMA_KEY[field]];
  return entry ? !entry.isOptional() : false;
}

/** True when the AI intake staging row refuses a missing value. */
export function requiredByIntakeStaging(field: IntakeField): boolean {
  return AI_INTAKE_NOT_NULL.has(PATIENT_SCHEMA_KEY[field]) || AI_INTAKE_NOT_NULL.has(field);
}

/**
 * Required for *this* flow: a value the server genuinely cannot stage without.
 * Derived, never declared, so it cannot drift from the form it mirrors.
 */
export function isRequiredIntakeField(field: IntakeField): boolean {
  return requiredByPatientSchema(field) || requiredByIntakeStaging(field);
}

/**
 * Whether the assistant may ask the patient for this field at all.
 *
 * The sender's phone is required by the schema and still never asked: it is
 * taken from the verified WhatsApp participant. Asking would invite a number
 * the channel has not proved, which is exactly the substitution the intake RPC
 * exists to prevent.
 */
export function isAskableIntakeField(field: IntakeField, subject: IntakeSubject): boolean {
  if (field === "phone") return subject === "other";
  return true;
}

/** Optional *to the patient*: they may skip it, and skipping blocks nothing. */
export function isSkippableIntakeField(field: IntakeField, subject: IntakeSubject): boolean {
  return isAskableIntakeField(field, subject) && !isRequiredIntakeField(field);
}

/** The fields the assistant actually asks about, in asking order. */
export function askableIntakeFields(subject: IntakeSubject): readonly IntakeField[] {
  return PATIENT_INTAKE_FIELDS.filter((field) => isAskableIntakeField(field, subject));
}

// ---------------------------------------------------------------------------
// The patient-facing language layer
// ---------------------------------------------------------------------------

type Localized = { ar: string; en: string };

/**
 * The one label map in the system.
 *
 * `turn-briefing.ts` used to keep a second copy of this, which is how the
 * assistant ended up with two Arabic names for the national id depending on
 * which code path composed the sentence. It reads from here now. The map is
 * deliberately wider than the intake fields — it covers every `SlotField` the
 * assistant can name — so there is nowhere left for a third copy to be needed.
 */
const FIELD_LABELS: Record<string, Localized> = {
  full_name: { ar: "الاسم الكامل", en: "Full name" },
  national_id: { ar: "رقم الهوية", en: "National ID" },
  date_of_birth: { ar: "تاريخ الميلاد", en: "Date of birth" },
  email: { ar: "البريد الإلكتروني", en: "Email address" },
  phone: { ar: "رقم الموبايل", en: "Phone number" },
  department_id: { ar: "القسم", en: "Department" },
  department_name: { ar: "القسم", en: "Department" },
  doctor_id: { ar: "الدكتور", en: "Doctor" },
  doctor_name: { ar: "الدكتور", en: "Doctor" },
  blood_type: { ar: "فصيلة الدم", en: "Blood type" },
  gender: { ar: "النوع", en: "Gender" },
  appointment_date: { ar: "يوم الموعد", en: "Appointment day" },
  appointment_time: { ar: "وقت الموعد", en: "Appointment time" },
};

/**
 * The generic accessor, for any field the assistant may name.
 *
 * The fallback is a neutral phrase, never the identifier. An unlabelled field
 * reaching a patient as "the detail we still need" is a wording problem; the
 * same field reaching them as `insurance_provider_id` is the bug this module
 * was written to make impossible, and a `?? field` fallback is precisely how
 * that happens.
 */
export function patientFacingLabel(field: string, locale: "ar" | "en"): string {
  const entry = FIELD_LABELS[field];
  if (entry) return entry[locale];
  return locale === "ar" ? "البيان المطلوب" : "the required detail";
}

/** How each field is *asked for*, when it is the only thing outstanding. */
const FIELD_QUESTIONS: Record<IntakeField, Localized> = {
  full_name: { ar: "ممكن الاسم الكامل؟", en: "Could I have the full name, please?" },
  national_id: { ar: "تمام، ورقم الهوية؟", en: "And the National ID, please?" },
  date_of_birth: { ar: "تاريخ الميلاد كام؟", en: "What is the date of birth?" },
  email: { ar: "وإيه الإيميل؟", en: "And what is the email address?" },
  phone: { ar: "وإيه رقم الموبايل بتاعه؟", en: "And what is their phone number?" },
  department_id: {
    ar: "تحب الملف يكون تابع لأنهي قسم؟",
    en: "Which department should the file be under?",
  },
  doctor_id: {
    ar: "ومن دكاترة القسم، تحب تختار مين؟",
    en: "And which of the department's doctors would you like?",
  },
  blood_type: {
    ar: "فصيلة الدم لو تعرفها؟ ودي اختيارية.",
    en: "Your blood type, if you know it? That one is optional.",
  },
};

/** The optional-field questions say so out loud, so skipping is obviously allowed. */
const OPTIONAL_QUESTIONS: Partial<Record<IntakeField, Localized>> = {
  phone: {
    ar: "لو حابب تضيف رقم موبايل للملف ابعتهولي، وده اختياري.",
    en: "If you would like a phone number on the file, send it over — that one is optional.",
  },
  blood_type: FIELD_QUESTIONS.blood_type,
};

/** The one localized name a patient may ever see for an internal field. */
export function patientFacingFieldLabel(field: IntakeField, locale: "ar" | "en"): string {
  return patientFacingLabel(field, locale);
}

/**
 * One natural question for the outstanding fields.
 *
 * At most two are asked at a time, and never more, because three is a form. The
 * fields are re-ordered into asking order so "date of birth then name" is never
 * how it comes out, and un-askable fields are dropped rather than voiced.
 */
export function buildIntakeQuestion(
  fields: readonly string[],
  locale: "ar" | "en",
  options: { subject?: IntakeSubject } = {},
): string | null {
  const subject = options.subject ?? "self";
  const wanted = new Set(fields);
  const ordered = PATIENT_INTAKE_FIELDS.filter(
    (field) => wanted.has(field) && isAskableIntakeField(field, subject),
  );
  if (ordered.length === 0) return null;

  const [first, second] = ordered;
  const questionFor = (field: IntakeField): string =>
    (isSkippableIntakeField(field, subject) ? OPTIONAL_QUESTIONS[field] : undefined)?.[locale] ??
    FIELD_QUESTIONS[field][locale];

  if (ordered.length === 1 || !second) return questionFor(first!);

  // Two outstanding: one sentence naming both, so the patient can answer in one
  // message instead of being walked through two turns of a questionnaire.
  const a = patientFacingFieldLabel(first!, locale);
  const b = patientFacingFieldLabel(second, locale);
  return locale === "ar"
    ? `ممكن ${a} و${b}؟`
    : `Could I have the ${a.toLowerCase()} and the ${b.toLowerCase()}?`;
}

/** A localized enumeration of field labels, for copy that must name several. */
export function patientFacingFieldList(
  fields: readonly string[],
  locale: "ar" | "en",
): string {
  const wanted = new Set(fields);
  const labels = PATIENT_INTAKE_FIELDS.filter((field) => wanted.has(field)).map((field) =>
    patientFacingFieldLabel(field, locale),
  );
  return labels.join(locale === "ar" ? "، " : ", ");
}

// ---------------------------------------------------------------------------
// Leakage prevention
// ---------------------------------------------------------------------------

/**
 * Internal identifiers that must never survive to a patient, mapped to the one
 * thing a patient may be shown instead.
 *
 * Identifiers with no patient-facing meaning at all — ids, reason codes, tool
 * argument names — map to `null`: there is nothing to substitute, so the
 * enclosing parenthetical is removed rather than translated.
 */
const INTERNAL_TOKENS: Record<string, IntakeField | null> = {
  full_name: "full_name",
  full_name_original: "full_name",
  national_id: "national_id",
  national_id_folded: "national_id",
  date_of_birth: "date_of_birth",
  blood_type: "blood_type",
  department_id: "department_id",
  department_name: "department_id",
  doctor_id: "doctor_id",
  doctor_name: "doctor_id",
  assigned_doctor_id: "doctor_id",
  phone: "phone",
  email: "email",
  missing_fields: null,
  unreadable_fields: null,
  collected_fields: null,
  conflicting_details: null,
  assignment_required: null,
  patient_id: null,
  intake_id: null,
  conversation_id: null,
  clinic_id: null,
  appointment_id: null,
  insurance_provider_id: null,
  for_someone_else: null,
  name_spelling_confirmed: null,
  intake_staged: null,
  appointment_date: null,
  appointment_time: null,
};

/**
 * Bare, ordinary-looking words that are also internal keys.
 *
 * `phone` and `email` are real English words, so scrubbing them out of an
 * English sentence would damage correct copy. They only count as a leak when
 * the reply is Arabic — where a bare Latin `phone` can only have come from a
 * schema — or when they appear alongside another identifier, which is the
 * machine-generated list shape this module exists to stop.
 */
const AMBIGUOUS_BARE_TOKENS = new Set(["phone", "email", "gender"]);

const SNAKE_CASE = /[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+/g;

export type FieldLanguageScrub = {
  text: string;
  /** The identifiers that were found, for the audit. Never the sentence. */
  leaked: string[];
};

/**
 * The last gate before a patient reads anything.
 *
 * Deterministic server copy no longer builds identifier lists, and the prompt
 * forbids them — but neither of those is a guarantee, and a schema name in a
 * patient's WhatsApp thread is the kind of failure that should be impossible
 * rather than merely unlikely. So every outbound reply is checked, and any
 * identifier found is replaced with its localized label or removed with its
 * parenthetical.
 */
export function scrubInternalFieldNames(
  text: string,
  locale: "ar" | "en",
): FieldLanguageScrub {
  if (!text) return { text, leaked: [] };
  const leaked: string[] = [];

  let out = text.replace(SNAKE_CASE, (token) => {
    const lower = token.toLowerCase();
    if (!(lower in INTERNAL_TOKENS)) {
      // An identifier we do not own is still an identifier. Report it; leave the
      // characters alone rather than guessing at a replacement.
      leaked.push(lower);
      return token;
    }
    leaked.push(lower);
    const field = INTERNAL_TOKENS[lower];
    return field ? patientFacingFieldLabel(field, locale) : "";
  });

  // Bare words, under the narrow conditions that make them identifiers.
  const bareIsLeak = locale === "ar" || leaked.length > 0;
  if (bareIsLeak) {
    out = out.replace(/\b([A-Za-z]+)\b/g, (word) => {
      const lower = word.toLowerCase();
      if (!AMBIGUOUS_BARE_TOKENS.has(lower)) return word;
      leaked.push(lower);
      const field = INTERNAL_TOKENS[lower];
      return field ? patientFacingFieldLabel(field, locale) : "";
    });
  }

  if (leaked.length === 0) return { text, leaked: [] };

  // Whatever the substitutions left behind: empty brackets, doubled separators,
  // a comma with nothing on either side.
  out = out
    .replace(/[(\[]\s*[,،;؛]*\s*[)\]]/g, "")
    .replace(/([,،])\s*([,،])+/g, "$1")
    .replace(/[(\[]\s*([,،]\s*)+/g, "(")
    .replace(/(\s*[,،])+\s*([)\]])/g, "$2")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([.,،؟?!:;])/g, "$1")
    .replace(/\s+$/gm, "")
    .trim();

  return { text: out, leaked: [...new Set(leaked)] };
}

/** Cheap predicate for tests and guards that only need the yes/no. */
export function containsInternalFieldName(text: string, locale: "ar" | "en"): boolean {
  return scrubInternalFieldNames(text, locale).leaked.length > 0;
}
