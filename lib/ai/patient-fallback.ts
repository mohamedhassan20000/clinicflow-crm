import "server-only";

import { getPatientClinicPublicInfo } from "@/lib/supabase/admin";

/**
 * The one thing the assistant says when something genuinely broke.
 *
 * Two rules shape this. First, the patient is on WhatsApp with no other way in,
 * so an unexpected failure has to end with a way to reach a human — the clinic's
 * *own* stored number, read at the moment of failure, never a constant compiled
 * into the app. Second, whatever broke is ours: the reason, the table, the
 * stack, and the tool name all stay on this side of the boundary.
 *
 * A clinic that has not stored a phone number degrades to the same apology
 * without one. Inventing a number, or falling back to a support line the clinic
 * does not answer, would be worse than saying nothing.
 */
export type PatientTechnicalFallback = {
  technical_error: true;
  retryable: true;
  clinic_phone: string | null;
  guidance: string;
};

function guidanceFor(phone: string | null): string {
  const contact = phone
    ? `Give the patient this exact clinic phone number so they can reach staff: ${phone}. ` +
      "Do not alter or reformat it."
    : "The clinic has not stored a phone number, so do not give one and do not invent one. " +
      "Offer to try again instead.";
  return (
    "A temporary technical problem stopped this step. Apologise briefly in the patient's own " +
    "language, say it was a temporary technical problem, and invite them to try again. " +
    `${contact} ` +
    "Never mention tools, errors, ids, or anything about what failed internally, and never " +
    "state or imply that a booking, cancellation, or registration succeeded."
  );
}

/**
 * Builds the patient-facing fallback for an unexpected failure.
 *
 * Best-effort by construction: if even the clinic lookup fails, the fallback is
 * still returned without a number rather than throwing a second time on top of
 * the first failure.
 */
export async function buildPatientTechnicalFallback(
  clinicId: string,
): Promise<PatientTechnicalFallback> {
  const clinic = await getPatientClinicPublicInfo(clinicId).catch(() => null);
  const phone = clinic?.data?.phone?.trim() || null;
  return {
    technical_error: true,
    retryable: true,
    clinic_phone: phone,
    guidance: guidanceFor(phone),
  };
}
