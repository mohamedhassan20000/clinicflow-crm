/**
 * PHI/PII minimization for the **audit trail** (§6.6, §9.3).
 *
 * Originally this module also shaped tool payloads on their way to the model:
 * `redactPatientIdentity` reduced a patient row to name/age/blood type for
 * `get_patient_summary`, and `ageFromDateOfBirth` existed to avoid emitting a
 * raw date of birth. Both were removed in Phase 7 along with their only caller.
 * They were not merely unused — they encoded a *narrower* contract than the one
 * the plan settled on: §7.2 makes the readable field set equal to what RLS
 * grants, so `date_of_birth` and `blood_type` are returned outright to any role
 * authorized for them, and the field policy (not a redactor) is where a
 * narrowing must be declared and justified. Leaving the helpers here would have
 * suggested a minimization that no longer runs.
 *
 * What remains is the audit path, which is unchanged: `toolAuditSummary` still
 * strips emails and long digit runs from the parameters written to
 * `audit_logs`, so the trail is safe for a clinic admin to read.
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
