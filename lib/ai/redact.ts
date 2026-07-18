/**
 * PHI/PII minimization before tool outputs enter the model context (§9.3).
 *
 * The doctor assistant summarizes clinical history, but the model never needs
 * raw national IDs, file numbers, or contact details to do so — summaries cite
 * notes by date/author, not by identifier dump. These helpers strip direct
 * identifiers from free text and shape structured tool payloads so the minimal
 * necessary data crosses the LLM boundary. This is defense-in-depth on top of
 * RLS scoping, not a substitute for it.
 */

// Gulf/Egypt national ids and clinic file numbers are long digit runs; emails
// and phone numbers are contact details. Kept deliberately broad — over-
// redaction of a summary is safe, leaking an identifier is not.
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const LONG_DIGIT_RE = /\b(?:\d{7,}|\d[\d\s-]{7,}\d)\b/g;

export function redactText(input: string): string {
  if (!input) return input;
  return input
    .replace(EMAIL_RE, "[redacted-email]")
    .replace(LONG_DIGIT_RE, "[redacted-number]");
}

export type RedactedPatientIdentity = {
  full_name: string;
  age: number | null;
  blood_type: string | null;
};

/**
 * Computes an age from a date of birth without exposing the raw DOB (itself a
 * sensitive identifier). Returns null for missing/unparseable values.
 */
export function ageFromDateOfBirth(
  dateOfBirth: string | null | undefined,
  now = new Date(),
): number | null {
  if (!dateOfBirth) return null;
  const dob = new Date(dateOfBirth);
  if (Number.isNaN(dob.getTime())) return null;
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const monthDiff = now.getUTCMonth() - dob.getUTCMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getUTCDate() < dob.getUTCDate())) {
    age -= 1;
  }
  return age >= 0 && age < 200 ? age : null;
}

/**
 * Reduces a patient row to the non-identifying clinical context the assistant
 * needs. national_id, file_number, phone, email and raw DOB are dropped.
 */
export function redactPatientIdentity(patient: {
  full_name: string;
  date_of_birth?: string | null;
  blood_type?: string | null;
}): RedactedPatientIdentity {
  return {
    full_name: patient.full_name,
    age: ageFromDateOfBirth(patient.date_of_birth ?? null),
    blood_type: patient.blood_type ?? null,
  };
}

/**
 * Builds the audit summary payload for a tool call (§6.6). Never contains raw
 * note bodies or identifiers — only counts and the scoping parameters, so the
 * audit trail is safe for admins to read.
 */
export function toolAuditSummary(
  params: Record<string, unknown>,
): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") {
      safe[key] = redactText(value).slice(0, 200);
    } else if (
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === null
    ) {
      safe[key] = value;
    }
    // objects/arrays are intentionally dropped from the summary
  }
  return safe;
}
