import "server-only";

import { AiToolAuthorizationError } from "@/lib/ai/errors";
import { getEntitlements, hasFeature } from "@/lib/entitlements";
import { resolvePatientAiContext } from "@/lib/supabase/admin";

export const AI_PATIENT_SUGGEST_FEATURE = "ai.patient_suggest" as const;
export const AI_SCHEDULING_FEATURE = "ai.scheduling" as const;

/**
 * Trusted patient surface context. Both ids come from verified channel routing,
 * never from the model. In particular, patient_id is intentionally absent.
 */
export type PatientToolContext = {
  clinicId: string;
  conversationId: string;
  locale: "ar" | "en";
  aiRequestId?: string | null;
};

export type ResolvedPatientAiContext = {
  clinicId: string;
  conversationId: string;
  patientId: string | null;
  linked: boolean;
  identityVerifiedAt: string | null;
  identityLockedUntil: string | null;
  clinicName: string;
  clinicLocale: "ar" | "en";
  clinicTimezone: string;
};

export class PatientIdentityError extends Error {
  constructor(
    public readonly reason:
      | "patient_unlinked"
      | "identity_verification_required"
      | "identity_verification_locked",
  ) {
    super(reason);
    this.name = "PatientIdentityError";
  }
}

export async function authorizePatientConversation(
  ctx: PatientToolContext,
  options: {
    requireLinked?: boolean;
    requireVerified?: boolean;
    requireScheduling?: boolean;
  } = {},
): Promise<ResolvedPatientAiContext> {
  const entitlements = await getEntitlements(ctx.clinicId);
  if (!entitlements.subscriptionAllowed) {
    throw new AiToolAuthorizationError("subscription_inactive");
  }
  if (
    !hasFeature(entitlements, "ai_assistant") ||
    !hasFeature(entitlements, AI_PATIENT_SUGGEST_FEATURE) ||
    (options.requireScheduling &&
      !hasFeature(entitlements, AI_SCHEDULING_FEATURE))
  ) {
    throw new AiToolAuthorizationError("feature_not_entitled");
  }

  const { data, error } = await resolvePatientAiContext({
    clinicId: ctx.clinicId,
    conversationId: ctx.conversationId,
  });
  const row = data?.[0];
  if (error || !row) {
    throw new AiToolAuthorizationError(
      "lookup_failed",
      "The patient conversation could not be authorized.",
    );
  }

  const resolved: ResolvedPatientAiContext = {
    clinicId: row.clinic_id,
    conversationId: row.conversation_id,
    patientId: row.patient_id,
    linked: row.linked,
    identityVerifiedAt: row.identity_verified_at,
    identityLockedUntil: row.identity_locked_until,
    clinicName: row.clinic_name,
    clinicLocale: row.clinic_locale === "ar" ? "ar" : "en",
    clinicTimezone: row.clinic_timezone,
  };

  // Recheck the exact pair even though the RPC filters it. This prevents a
  // future RPC widening from silently becoming a cross-tenant tool mount.
  if (
    resolved.clinicId !== ctx.clinicId ||
    resolved.conversationId !== ctx.conversationId
  ) {
    throw new AiToolAuthorizationError("lookup_failed");
  }
  if (options.requireLinked && (!resolved.linked || !resolved.patientId)) {
    throw new PatientIdentityError("patient_unlinked");
  }
  if (options.requireVerified && !resolved.identityVerifiedAt) {
    throw new PatientIdentityError(
      resolved.identityLockedUntil &&
        new Date(resolved.identityLockedUntil).getTime() > Date.now()
        ? "identity_verification_locked"
        : "identity_verification_required",
    );
  }
  return resolved;
}
