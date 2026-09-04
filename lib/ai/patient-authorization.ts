import "server-only";

import {
  parseCollectedData,
  parsePendingClarification,
  type CollectedData,
  type PendingClarification,
} from "@/lib/ai/collected-state";
import {
  parseBookingStageState,
  type BookingStageState,
} from "@/lib/ai/booking-stage";
import {
  parseCommunicationStyle,
  type CommunicationStyle,
} from "@/lib/ai/communication-style";
import { AiToolAuthorizationError } from "@/lib/ai/errors";
import type { GroundingLedger } from "@/lib/ai/patient-grounding";
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
  /**
   * P11 — the turn's record of which entities the *server* returned.
   *
   * Written by `protectPatientTool` for every tool result and read once, after
   * generation, by the grounding check. It is presentation bookkeeping and
   * carries no authority: nothing reads it to decide what may run, and a turn
   * without one behaves exactly as it did before P11.
   */
  grounding?: GroundingLedger | null;
  /**
   * F-8 / F-11 — the patient's own inbound messages for the current episode,
   * newest last, exactly as the transport stored them.
   *
   * In-memory for the duration of one turn and **never persisted anywhere new**:
   * it is read from `inbound_messages`, which already holds these words, and
   * nothing derived from it is written back. The content-free audit ledger is
   * unchanged — no tool logs a value, a token or a digest of any of this.
   *
   * Two decisions read it, and both can only ever *refuse*:
   *
   *   * `intake-provenance.ts` — a national id, date of birth, email or name
   *     may be committed only if the patient supplied it.
   *   * `argument-provenance.ts` — an unresolvable entity argument the patient
   *     never uttered is treated as absent rather than as a choice.
   *
   * Optional. A caller that does not supply it gets the behaviour that shipped
   * before those gates existed for `argument-provenance`; `intake-provenance`
   * deliberately treats an *empty supplied* transcript as no evidence. See
   * each module for why the two defaults differ.
   */
  episodeUtterances?: readonly string[];
  /** True when the turn was server-classified as a read-only information request. */
  informationalOnly?: boolean;
  /** Display preference resolved with the clinic reply context, never model supplied. */
  timeFormat?: "12h" | "24h";
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
  /** P8: decides how a bare `12/9/2000` is read. From the clinic's own record. */
  clinicCountry: string;
  /** P8: the number on the other end of this conversation, in E.164. */
  participantAddress: string | null;
  /** P8: a staff member has taken this conversation over from the assistant. */
  aiPaused: boolean;
  /**
   * P8B: what the patient has already told us in this conversation, normalized.
   * Conversational memory, never evidence — see `lib/ai/collected-state.ts`.
   */
  collectedData: CollectedData;
  /** P8B: the one clarification currently outstanding, if any. */
  pendingClarification: PendingClarification | null;
  /**
   * P9: the server-owned booking-stage record for this conversation.
   *
   * Persisted metadata as of the end of the previous turn — a stage, the
   * latches that are not derivable from collected fields, and what was actually
   * offered to the patient. It is *not* an authorization input and carries no
   * identity: `parseBookingStageState` rebuilds it against a closed shape for
   * exactly the same reason `parseCollectedData` does. The stage a tool acts on
   * is always re-derived from this turn's facts by `deriveConversationStage`,
   * never read straight out of here.
   */
  bookingStage: BookingStageState;
  /**
   * P10 — the clinic's configured language, Arabic register, tone and style
   * line. Read from `clinics` by the same RPC that resolves everything else, so
   * a turn cannot end up using one clinic's settings with another's data.
   */
  communicationStyle: CommunicationStyle;
  /**
   * P10 — the sender confirmed, *for booking only*, which file this thread is.
   *
   * Deliberately separate from `identityVerifiedAt`, and deliberately weaker.
   * Nothing that discloses clinical, appointment or record data may read this:
   * `authorizePatientConversation({ requireVerified: true })` still checks
   * `identityVerifiedAt` and nothing else, so the booking flow can move on a
   * name confirmation while every disclosure still costs a date-of-birth check.
   */
  bookingIdentityConfirmedAt: string | null;
  /**
   * The linked patient's name, for the one question a booking may ask:
   * "you are X, correct?". Null whenever the thread is not linked to a live
   * patient of this clinic. Never a clinical field and never returned to the
   * model except through `confirm_booking_identity`.
   */
  patientDisplayName: string | null;
  /**
   * P11S — the last four digits of the linked patient's national/civil ID, and
   * never more than that.
   *
   * The full value is not loaded, not held in application memory and not
   * reachable from here: `resolve_patient_ai_context` computes the suffix in
   * SQL. It exists for exactly one sentence — "you're {name}, ID ending 1234,
   * correct?" — which is the confirmation a patient can recognise and a
   * bystander cannot use. Null when the thread is unlinked, or when the ID on
   * file is too short for a suffix to be meaningfully partial.
   */
  patientNationalIdSuffix: string | null;
};

export class PatientIdentityError extends Error {
  constructor(
    public readonly reason:
      | "patient_unlinked"
      | "booking_identity_required"
      | "identity_verification_required"
      | "identity_verification_locked"
      /** P8: a human has this conversation; the assistant does not act on it. */
      | "human_takeover",
  ) {
    super(reason);
    this.name = "PatientIdentityError";
  }
}

/**
 * The narrow identity gate used by appointment creation and availability.
 *
 * A booking-only confirmation intentionally does not unlock appointment lookup,
 * cancellation, or clinical data; those paths still call
 * `authorizePatientConversation({ requireVerified: true })`. This helper only
 * answers whether a linked sender may progress a pending booking. A third-party
 * booking is instead owned by its isolated staged intake.
 */
export function assertPatientBookingIdentity(
  identity: ResolvedPatientAiContext,
  options: { forSomeoneElse?: boolean } = {},
): void {
  if (!identity.linked || options.forSomeoneElse === true) return;
  if (identity.identityVerifiedAt || identity.bookingIdentityConfirmedAt) return;
  throw new PatientIdentityError("booking_identity_required");
}

export async function authorizePatientConversation(
  ctx: PatientToolContext,
  options: {
    requireLinked?: boolean;
    requireVerified?: boolean;
    requireScheduling?: boolean;
    /**
     * P8: refuse when a staff member has taken the conversation over. Set on
     * every tool that *does* something (booking, cancelling, registering) — a
     * paused conversation may still be read from, because staff sometimes want
     * the assistant's draft, but nothing may act on the patient's behalf while a
     * human is mid-sentence.
     */
    refuseIfPaused?: boolean;
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
    clinicCountry: row.clinic_country,
    participantAddress: row.participant_address,
    aiPaused: row.ai_paused === true,
    // Rebuilt field by field rather than cast: this is a jsonb column, and the
    // one thing it must never be able to do is carry a patient id or a
    // verification flag into an authorization decision.
    collectedData: parseCollectedData(row.collected_data),
    pendingClarification: parsePendingClarification(row.pending_clarification),
    bookingStage: parseBookingStageState(
      (row as { booking_stage?: unknown }).booking_stage,
    ),
    // Rebuilt against a closed union for the same reason the two jsonb columns
    // above are: these values reach the system prompt, and an unknown string
    // reaching it is a string a future migration bug could have put there.
    communicationStyle: parseCommunicationStyle(
      row as Record<string, unknown>,
    ),
    bookingIdentityConfirmedAt:
      (row as { booking_identity_confirmed_at?: string | null })
        .booking_identity_confirmed_at ?? null,
    patientDisplayName:
      (row as { patient_display_name?: string | null }).patient_display_name ?? null,
    patientNationalIdSuffix:
      (row as { patient_national_id_suffix?: string | null })
        .patient_national_id_suffix ?? null,
  };

  // Recheck the exact pair even though the RPC filters it. This prevents a
  // future RPC widening from silently becoming a cross-tenant tool mount.
  if (
    resolved.clinicId !== ctx.clinicId ||
    resolved.conversationId !== ctx.conversationId
  ) {
    throw new AiToolAuthorizationError("lookup_failed");
  }
  if (options.refuseIfPaused && resolved.aiPaused) {
    throw new PatientIdentityError("human_takeover");
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
