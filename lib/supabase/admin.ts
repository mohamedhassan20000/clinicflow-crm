import "server-only";
import { createClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/types/database";
import type { FxSnapshot } from "@/lib/currency/provider";
import { requirePlatformAdmin } from "@/lib/rbac";
import { resolveSubscriptionAccess } from "@/lib/billing/access";
import { resolveEffectiveAiFeature } from "@/lib/ai/commercial-policy";

/**
 * Service-role Supabase client. Server-only.
 * Use ONLY for privileged flows: staff provisioning, auth admin operations.
 * Never import this in a Client Component.
 */
export function createAdminClient() {
  return createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    },
  );
}

/** Platform-managed FX write boundary. Never accepts tenant financial data. */
export async function storeFxSnapshot(snapshot: FxSnapshot) {
  return createAdminClient().from("fx_rates").upsert(
    Object.entries(snapshot.rates).map(([currency_code, rate]) => ({
      currency_code,
      base_currency: snapshot.baseCurrency,
      rate,
      provider: snapshot.provider,
      provider_timestamp: snapshot.providerTimestamp,
      fetched_at: snapshot.fetchedAt,
      updated_at: snapshot.fetchedAt,
    })),
    { onConflict: "currency_code" },
  );
}

export async function provisionClinicOwner(input: {
  ownerId: string;
  tokenHash: string | null;
  clinicName: string;
  country: string;
  phone: string;
  ownerName: string;
  ownerEmail: string;
  locale: string;
}) {
  const admin = createAdminClient();
  return admin.rpc("create_clinic_with_owner", {
    p_owner_id: input.ownerId,
    p_invitation_token_hash: input.tokenHash ?? undefined,
    p_clinic_name: input.clinicName,
    p_country: input.country,
    p_phone: input.phone,
    p_owner_name: input.ownerName,
    p_owner_email: input.ownerEmail,
    p_locale: input.locale,
  });
}

export async function deleteSignupAuthUser(userId: string) {
  return createAdminClient().auth.admin.deleteUser(userId);
}

export type ResumableSignupUser = {
  userId: string;
  emailConfirmed: boolean;
};

export async function findResumableSignupUser(email: string): Promise<
  | { data: ResumableSignupUser | null; error: null }
  | { data: null; error: { message: string; code?: string } }
> {
  const result = await createAdminClient().rpc("find_resumable_clinic_owner", {
    p_email: email,
  });
  if (result.error) return { data: null, error: result.error };
  const row = result.data?.[0];
  return {
    data: row
      ? { userId: row.user_id, emailConfirmed: row.email_confirmed }
      : null,
    error: null,
  };
}

/**
 * Resets the password of an orphaned, unconfirmed clinic-owner signup user.
 * Callers must have verified the orphan via findResumableSignupUser AND hold
 * an invitation token bound to the orphan's email — never call this for a
 * confirmed account.
 */
export async function setSignupUserPassword(userId: string, password: string) {
  return createAdminClient().auth.admin.updateUserById(userId, { password });
}

export async function requestClinicInvitation(input: {
  clinicName: string;
  ownerName: string;
  phone: string;
  email: string;
}) {
  return createAdminClient().rpc("request_clinic_invitation", {
    p_clinic_name: input.clinicName,
    p_owner_name: input.ownerName,
    p_phone: input.phone,
    p_email: input.email,
  });
}

/**
 * Reviewed service-role boundary for the atomic increment_usage RPC (P1A).
 * The messaging send path (lib/messaging/send.ts) counts every successful
 * send here; the RPC itself resolves the plan-limit snapshot server-side and
 * rejects non-service callers.
 */
export async function incrementClinicUsage(
  clinicId: string,
  metric: Database["public"]["Enums"]["usage_metric"],
  amount = 1,
  periodStart?: string,
) {
  return createAdminClient().rpc("increment_usage", {
    p_clinic_id: clinicId,
    p_metric: metric,
    p_amount: amount,
    p_period_start: periodStart,
  });
}

export type ReserveDocumentIssueInput = {
  clinicId: string;
  actorId: string;
  documentType: string;
  idempotencyKey: string;
  locale: "ar" | "en";
  numberingPrefix: string;
  periodKey: string;
  sequencePadding: number;
  params: Json;
  snapshot: Json;
  watermark: string | null;
  patientId?: string | null;
  staffId?: string | null;
  doctorId?: string | null;
  appointmentId?: string | null;
  invoiceId?: string | null;
  regeneratedFrom?: string | null;
};

/**
 * Reviewed P7-0 service boundary for idempotent document reservation. The
 * caller must first run the catalog's billing-aware mutation guard and resolve
 * the snapshot through RLS. The RPC re-validates actor/tenant references,
 * serializes the idempotency key, and allocates at most one number.
 */
export async function reserveDocumentIssue(input: ReserveDocumentIssueInput) {
  return createAdminClient().rpc("reserve_document_issue", {
    p_clinic_id: input.clinicId,
    p_actor_id: input.actorId,
    p_doc_type: input.documentType,
    p_idempotency_key: input.idempotencyKey,
    p_locale: input.locale,
    p_numbering_prefix: input.numberingPrefix,
    p_period_key: input.periodKey,
    p_sequence_padding: input.sequencePadding,
    p_params: input.params,
    p_snapshot: input.snapshot,
    p_watermark_snapshot: input.watermark,
    p_patient_id: input.patientId ?? undefined,
    p_staff_id: input.staffId ?? undefined,
    p_doctor_id: input.doctorId ?? undefined,
    p_appointment_id: input.appointmentId ?? undefined,
    p_invoice_id: input.invoiceId ?? undefined,
    p_regenerated_from: input.regeneratedFrom ?? undefined,
  });
}

/** Find an immutable completed artifact before retrying a natural idempotency key. */
export async function findCompletedClinicDocument(input: {
  clinicId: string;
  documentType: string;
  idempotencyKey: string;
}) {
  return createAdminClient()
    .from("documents")
    .select("id, document_number, verification_token, status")
    .eq("clinic_id", input.clinicId)
    .eq("doc_type", input.documentType)
    .eq("idempotency_key", input.idempotencyKey)
    .in("status", ["issued", "cancelled", "void"])
    .maybeSingle();
}

export async function completeDocumentIssue(input: {
  clinicId: string;
  actorId: string;
  documentId: string;
  storagePath: string;
  pageCount: number;
}) {
  return createAdminClient().rpc("complete_document_issue", {
    p_clinic_id: input.clinicId,
    p_actor_id: input.actorId,
    p_document_id: input.documentId,
    p_pdf_storage_path: input.storagePath,
    p_page_count: input.pageCount,
  });
}

export async function failDocumentIssue(input: {
  clinicId: string;
  actorId: string;
  documentId: string;
  failureCode: string;
}) {
  return createAdminClient().rpc("fail_document_issue", {
    p_clinic_id: input.clinicId,
    p_actor_id: input.actorId,
    p_document_id: input.documentId,
    p_failure_code: input.failureCode,
  });
}

export type SaveDocumentDraftInput = {
  draftId?: string | null;
  clinicId: string;
  actorId: string;
  documentType: string;
  locale: "ar" | "en";
  params: Json;
  patientId?: string | null;
  staffId?: string | null;
  doctorId?: string | null;
  appointmentId?: string | null;
};

/**
 * Server-only mutable authoring boundary. Drafts deliberately live outside the
 * immutable numbered `documents` ledger and may be updated only before issue.
 */
export async function saveClinicDocumentDraft(input: SaveDocumentDraftInput) {
  const admin = createAdminClient();
  const values = {
    clinic_id: input.clinicId,
    doc_type: input.documentType,
    locale: input.locale,
    params: input.params,
    patient_id: input.patientId ?? null,
    staff_id: input.staffId ?? null,
    doctor_id: input.doctorId ?? null,
    appointment_id: input.appointmentId ?? null,
    updated_by: input.actorId,
  };

  if (input.draftId) {
    return admin
      .from("document_drafts")
      .update(values)
      .eq("id", input.draftId)
      .eq("clinic_id", input.clinicId)
      .eq("status", "not_issued")
      .select("*")
      .single();
  }

  return admin
    .from("document_drafts")
    .insert({ ...values, created_by: input.actorId })
    .select("*")
    .single();
}

export async function resolveClinicDocumentDraft(input: {
  draftId: string;
  clinicId: string;
  actorId: string;
  documentId: string;
}) {
  return createAdminClient()
    .from("document_drafts")
    .update({
      status: "issued",
      issued_document_id: input.documentId,
      resolved_at: new Date().toISOString(),
      updated_by: input.actorId,
    })
    .eq("id", input.draftId)
    .eq("clinic_id", input.clinicId)
    .eq("status", "not_issued")
    .select("id")
    .maybeSingle();
}

export function clinicDocumentStoragePath(input: {
  clinicId: string;
  documentType: string;
  documentId: string;
}): string {
  return `documents/${input.clinicId}/${input.documentType}/${input.documentId}.pdf`;
}

/**
 * Reviewed P7-9 metadata-only read for the Documents Settings numbering view.
 * `document_counters` is a server-only table (no authenticated SELECT policy;
 * allocation is SECURITY DEFINER-only, doc 06). The Documents Settings page must
 * still show admins the current prefix and the next sequence per type (doc 09
 * §1.2), so this bounded helper reads only the non-sensitive counter columns
 * (doc_type, period_key, next_seq — no PHI, no financial data) for one clinic.
 * Callers must have passed the primary-admin gate first.
 */
export async function loadClinicDocumentCounters(clinicId: string) {
  return createAdminClient()
    .from("document_counters")
    .select("doc_type, period_key, next_seq")
    .eq("clinic_id", clinicId)
    .order("doc_type", { ascending: true });
}

/**
 * Reviewed P7-6 service boundary for reading a responsible physician's private
 * signature asset. Callers cannot choose another tenant or staff directory.
 */
export async function downloadClinicianSignatureAsset(input: {
  clinicId: string;
  physicianId: string;
  signaturePath: string;
}) {
  const expectedPrefix = `staff/${input.clinicId}/${input.physicianId}/signature/`;
  if (
    !input.signaturePath.startsWith(expectedPrefix)
    || input.signaturePath.includes("..")
  ) {
    return { data: null, error: new Error("Invalid clinician signature path") };
  }

  return createAdminClient().storage
    .from("clinic-assets")
    .download(input.signaturePath);
}

/** Canonical PDFs are private and server-written; authenticated users read via RLS. */
export async function uploadClinicDocumentPdf(input: {
  clinicId: string;
  documentType: string;
  documentId: string;
  pdf: Uint8Array;
}) {
  const storagePath = clinicDocumentStoragePath(input);
  const result = await createAdminClient().storage
    .from("clinic-documents")
    .upload(storagePath, input.pdf, {
      contentType: "application/pdf",
      upsert: true,
    });
  return { ...result, storagePath };
}

/** Reads a canonical document PDF for server-side delivery (e.g. invoice email). */
export async function downloadClinicDocumentPdf(input: {
  clinicId: string;
  documentType: string;
  documentId: string;
}) {
  const storagePath = clinicDocumentStoragePath(input);
  const result = await createAdminClient().storage
    .from("clinic-documents")
    .download(storagePath);
  return { ...result, storagePath };
}

export async function removeClinicDocumentPdf(input: {
  clinicId: string;
  documentType: string;
  documentId: string;
}) {
  const storagePath = clinicDocumentStoragePath(input);
  const result = await createAdminClient().storage
    .from("clinic-documents")
    .remove([storagePath]);
  return { ...result, storagePath };
}

/**
 * P4.5A service boundary for the durable AI reservation transaction. The RPC
 * atomically claims the legacy ai_messages unit and the managed-cost ceiling;
 * callers never write reservation or ledger tables directly.
 */
export async function reserveAiBudget(input: {
  requestId: string;
  leaseToken: string;
  clinicId: string;
  actorId: string;
  periodStart: string;
  surface: string;
  persona: string;
  task: string;
  transport: string;
  expectedProvider: string;
  expectedModel: string;
  modelAlias: string;
  fallbackModelAliases: string[];
  policyVersion: string;
  certificationVersion: string;
  privacyPolicyVersion: string;
  reservedCostMicros: number;
  budgetLimitMicros: number;
  leaseSeconds: number;
  credentialMode: "managed" | "byok_strict" | "hybrid";
}) {
  return createAdminClient().rpc("reserve_ai_budget", {
    p_request_id: input.requestId,
    p_lease_token: input.leaseToken,
    p_clinic_id: input.clinicId,
    p_actor_id: input.actorId,
    p_period_start: input.periodStart,
    p_surface: input.surface,
    p_persona: input.persona,
    p_task: input.task,
    p_transport: input.transport,
    p_expected_provider: input.expectedProvider,
    p_expected_model: input.expectedModel,
    p_model_alias: input.modelAlias,
    p_fallback_model_aliases: input.fallbackModelAliases,
    p_policy_version: input.policyVersion,
    p_certification_version: input.certificationVersion,
    p_privacy_policy_version: input.privacyPolicyVersion,
    p_reserved_cost_micros: input.reservedCostMicros,
    p_budget_limit_micros: input.budgetLimitMicros,
    p_lease_seconds: input.leaseSeconds,
    p_credential_mode: input.credentialMode,
  });
}

/**
 * Durable, idempotent claim on one included-usage threshold notice.
 *
 * Returns true exactly once per (clinic, billing period, threshold), even under
 * concurrent turns — the RPC is an INSERT ... ON CONFLICT DO NOTHING behind the
 * service-role guard. Callers emit the notification only when it returns true.
 */
export async function claimAiUsageThresholdNotice(input: {
  clinicId: string;
  periodStart: string;
  threshold: number;
  usedPercent: number;
}) {
  return createAdminClient().rpc("claim_ai_usage_threshold_notice", {
    p_clinic_id: input.clinicId,
    p_period_start: input.periodStart,
    p_threshold: input.threshold,
    p_used_percent: input.usedPercent,
  });
}

/** Clinic-admin toggle for the automatic managed→BYOK handover (P12/G1). */
export async function setAiAutoByokFallback(input: {
  clinicId: string;
  actorId: string;
  enabled: boolean;
}) {
  return createAdminClient().rpc("set_ai_auto_byok_fallback", {
    p_clinic_id: input.clinicId,
    p_actor_id: input.actorId,
    p_enabled: input.enabled,
  });
}

/** Platform-owner allowance console source (plan default + per-clinic override). */
export async function loadOperatorAiAllowanceReport(input: {
  periodStart: string;
  clinicId?: string;
}) {
  return createAdminClient().rpc("operator_ai_allowance_report", {
    p_period_start: input.periodStart,
    p_clinic_id: input.clinicId ?? undefined,
  });
}

/** Atomic P4.5B credential activation/rotation plus metadata-only audit. */
export async function activateAiProviderConnection(input: {
  connectionId: string;
  clinicId: string;
  actorId: string;
  provider: "anthropic";
  credentialEncrypted: string;
  encryptionKeyVersion: number;
  maskedFingerprint: string;
}) {
  return createAdminClient().rpc("activate_ai_provider_connection", {
    p_connection_id: input.connectionId,
    p_clinic_id: input.clinicId,
    p_actor_id: input.actorId,
    p_provider: input.provider,
    p_credential_encrypted: input.credentialEncrypted,
    p_encryption_key_version: input.encryptionKeyVersion,
    p_masked_fingerprint: input.maskedFingerprint,
  });
}

/** Stores only a typed, sanitized provider-health result and its audit row. */
export async function recordAiProviderConnectionTest(input: {
  connectionId: string;
  clinicId: string;
  actorId: string;
  healthStatus: "valid" | "invalid" | "insufficient_scope" | "quota" | "provider_unavailable";
  errorCode: "invalid" | "insufficient_scope" | "quota" | "provider_unavailable" | null;
}) {
  return createAdminClient().rpc("record_ai_provider_connection_test", {
    p_connection_id: input.connectionId,
    p_clinic_id: input.clinicId,
    p_actor_id: input.actorId,
    p_health_status: input.healthStatus,
    p_error_code: input.errorCode,
  });
}

/** Persists one explicit managed/strict/hybrid policy change with audit. */
export async function setAiProviderPolicy(input: {
  clinicId: string;
  actorId: string;
  credentialMode: "managed" | "byok_strict" | "hybrid";
  hybridDisclosureVersion: "p45b-hybrid-disclosure-v1" | null;
}) {
  return createAdminClient().rpc("set_ai_provider_policy", {
    p_clinic_id: input.clinicId,
    p_actor_id: input.actorId,
    p_credential_mode: input.credentialMode,
    p_hybrid_disclosure_version: input.hybridDisclosureVersion,
  });
}

/** Destroys active tenant ciphertext and atomically returns routing to managed. */
export async function revokeAiProviderConnection(input: {
  connectionId: string;
  clinicId: string;
  actorId: string;
}) {
  return createAdminClient().rpc("revoke_ai_provider_connection", {
    p_connection_id: input.connectionId,
    p_clinic_id: input.clinicId,
    p_actor_id: input.actorId,
  });
}

/** Required audit boundary before a hybrid request may spend managed credits. */
export async function logAiProviderFallback(input: {
  clinicId: string;
  actorId: string;
  requestId: string;
  provider: "anthropic";
  errorClass: "authentication" | "permission" | "quota" | "rate_limit" | "timeout" | "provider_unavailable" | "request_failed";
}) {
  return createAdminClient().rpc("log_ai_provider_fallback", {
    p_clinic_id: input.clinicId,
    p_actor_id: input.actorId,
    p_request_id: input.requestId,
    p_provider: input.provider,
    p_error_class: input.errorClass,
  });
}

/**
 * P4.5A service boundary for atomic reservation finalization. The database
 * inserts content-free immutable attempts, reconciles reserved/actual cost,
 * and compensates the legacy request unit for failed or aborted executions.
 */
export async function reconcileAiBudget(input: {
  reservationId: string;
  leaseToken: string;
  outcome: "success" | "failed" | "aborted";
  attempts: Json;
  actualCostMicros: number;
  managedCostMicros: number;
  errorClass: string | null;
}) {
  return createAdminClient().rpc("reconcile_ai_budget", {
    p_reservation_id: input.reservationId,
    p_lease_token: input.leaseToken,
    p_outcome: input.outcome,
    p_attempts: input.attempts,
    p_actual_cost_micros: input.actualCostMicros,
    p_managed_cost_micros: input.managedCostMicros,
    p_error_class: input.errorClass,
  });
}

/**
 * Reviewed service-role boundary for the log_agent_tool_call RPC (P4A, §6.6).
 * Every AI tool invocation is audited here. The RPC is service-role only and
 * writes a redacted summary into audit_logs; clinic admins read it through the
 * existing audit_logs_select_admin_manager policy. Raw note bodies and direct
 * identifiers never reach this boundary — callers pass a redacted summary.
 */
export async function logAgentToolCall(input: {
  clinicId: string;
  actorId: string | null;
  tool: string;
  tableName?: string | null;
  recordId?: string | null;
  summary?: Record<string, unknown>;
}) {
  return createAdminClient().rpc("log_agent_tool_call", {
    p_clinic_id: input.clinicId,
    p_tool: input.tool,
    p_actor_id: input.actorId ?? undefined,
    p_table_name: input.tableName ?? undefined,
    p_record_id: input.recordId ?? undefined,
    p_summary: (input.summary ?? {}) as Database["public"]["Tables"]["audit_logs"]["Row"]["new_data"],
  });
}

/**
 * Phase 3 reviewed service boundary for confirmation/receipt control-plane
 * state. These RPCs never execute a clinic-domain mutation and never receive
 * action arguments, previews, prompts, completions, or free text. The actual
 * action handler continues to run with the authenticated caller and RLS.
 */
export async function issueAiActionConfirmation(input: {
  tokenHash: string;
  clinicId: string;
  actorId: string;
  conversationId: string;
  actionId: string;
  inputDigest: string;
  expiresAt: string;
  riskClass?: string;
  privilegedBinding?: {
    targetUserId: string;
    beforeDigest: string;
    afterDigest: string;
  };
}) {
  return createAdminClient().rpc("issue_ai_action_confirmation", {
    p_token_hash: input.tokenHash,
    p_clinic_id: input.clinicId,
    p_actor_id: input.actorId,
    p_conversation_id: input.conversationId,
    p_action_id: input.actionId,
    p_input_digest: input.inputDigest,
    p_expires_at: input.expiresAt,
    p_risk_class: input.riskClass ?? "normal",
    p_target_user_id: input.privilegedBinding?.targetUserId ?? null,
    p_before_digest: input.privilegedBinding?.beforeDigest ?? null,
    p_after_digest: input.privilegedBinding?.afterDigest ?? null,
  });
}

export async function verifyAiActionStepUp(input: {
  tokenHash: string;
  clinicId: string;
  actorId: string;
  reauthNonceHash: string;
  verifiedAt: string;
}) {
  return createAdminClient().rpc("verify_ai_action_step_up", {
    p_token_hash: input.tokenHash,
    p_clinic_id: input.clinicId,
    p_actor_id: input.actorId,
    p_reauth_nonce_hash: input.reauthNonceHash,
    p_verified_at: input.verifiedAt,
  });
}

export async function claimAiActionConfirmation(input: {
  tokenHash: string;
  clinicId: string;
  actorId: string;
  conversationId: string;
  actionId: string;
  inputDigest: string;
  consumedAt: string;
  privilegedBinding?: {
    targetUserId: string;
    beforeDigest: string;
    afterDigest: string;
  };
  reauthNonceHash?: string;
}) {
  return createAdminClient().rpc("claim_ai_action_confirmation", {
    p_token_hash: input.tokenHash,
    p_clinic_id: input.clinicId,
    p_actor_id: input.actorId,
    p_conversation_id: input.conversationId,
    p_action_id: input.actionId,
    p_input_digest: input.inputDigest,
    p_consumed_at: input.consumedAt,
    p_target_user_id: input.privilegedBinding?.targetUserId ?? null,
    p_before_digest: input.privilegedBinding?.beforeDigest ?? null,
    p_after_digest: input.privilegedBinding?.afterDigest ?? null,
    p_reauth_nonce_hash: input.reauthNonceHash ?? null,
  });
}

export async function consumeAiPrivilegedActionRateLimit(input: {
  clinicId: string;
  actorId: string;
  conversationId: string;
  phase: string;
  occurredAt: string;
}) {
  return createAdminClient().rpc("consume_ai_privileged_action_rate_limit", {
    p_clinic_id: input.clinicId,
    p_actor_id: input.actorId,
    p_conversation_id: input.conversationId,
    p_phase: input.phase,
    p_occurred_at: input.occurredAt,
  });
}

export async function beginAiActionReceipt(input: {
  clinicId: string;
  actorId: string;
  conversationId: string;
  aiRequestId: string | null;
  actionId: string;
  riskClass: string;
  phase: string;
  inputDigest: string;
}) {
  return createAdminClient().rpc("begin_ai_action_receipt", {
    p_clinic_id: input.clinicId,
    p_actor_id: input.actorId,
    p_conversation_id: input.conversationId,
    p_ai_request_id: input.aiRequestId,
    p_action_id: input.actionId,
    p_risk_class: input.riskClass,
    p_phase: input.phase,
    p_input_digest: input.inputDigest,
  });
}

export async function finalizeAiActionReceipt(input: {
  receiptId: string;
  clinicId: string;
  actorId: string;
  authorizationOutcome: string;
  denialReason: string | null;
  targetTable: string | null;
  targetRecordIds: readonly string[];
  beforeDigest: string | null;
  afterDigest: string | null;
  outcome: string;
  errorCode: string | null;
}) {
  return createAdminClient().rpc("finalize_ai_action_receipt", {
    p_receipt_id: input.receiptId,
    p_clinic_id: input.clinicId,
    p_actor_id: input.actorId,
    p_authorization_outcome: input.authorizationOutcome,
    p_denial_reason: input.denialReason,
    p_target_table: input.targetTable,
    p_target_record_ids: [...input.targetRecordIds],
    p_before_digest: input.beforeDigest,
    p_after_digest: input.afterDigest,
    p_outcome: input.outcome,
    p_error_code: input.errorCode,
  });
}

/**
 * Phase 6 retention purge. Service-role only, like every other AI control-plane
 * RPC; the windows are supplied by `lib/ai/retention.ts` rather than being
 * literals in SQL, so the policy has exactly one home.
 */
export async function purgeAiRetentionData(input: {
  messageRetentionDays: number;
  receiptRetentionDays: number;
  confirmationRetentionDays: number;
  batchLimit: number;
  now?: string;
}) {
  return createAdminClient().rpc("purge_ai_retention_data", {
    p_message_retention_days: input.messageRetentionDays,
    p_receipt_retention_days: input.receiptRetentionDays,
    p_confirmation_retention_days: input.confirmationRetentionDays,
    p_batch_limit: input.batchLimit,
    ...(input.now ? { p_now: input.now } : {}),
  });
}

/**
 * P5B (§6.2): the clinic fields the patient-reply orchestrator needs to resolve
 * mode, locale, and canned escalation copy. `clinics` has no clinic_id column,
 * so it is read by primary key here rather than through the auto-scoping client.
 */
export async function getClinicAiReplyContext(clinicId: string) {
  return createAdminClient()
    .from("clinics")
    // P10: the configured register travels with the mode, so the orchestrator
    // can resolve the reply language before it builds the agent rather than
    // after. Kept as one literal: PostgREST infers the row type from the
    // select string, and a concatenated one infers nothing.
    .select(
      "name, locale, country, phone, time_format, ai_reply_mode, ai_language_mode, ai_arabic_style, ai_tone, ai_style_instruction",
    )
    .eq("id", clinicId)
    .maybeSingle();
}

/**
 * P10 — the clinic's stored currency code, for quoting a configured price.
 *
 * `clinics` carries no `clinic_id` column, so it is read by primary key here
 * rather than through the auto-scoping client — the same reason
 * `getClinicAiReplyContext` lives here. A missing or unreadable value returns
 * null, and the assistant then states the amount without a currency rather
 * than failing the answer.
 */
export async function getClinicCurrency(clinicId: string): Promise<string | null> {
  const result = await createAdminClient()
    .from("clinics")
    .select("currency")
    .eq("id", clinicId)
    .maybeSingle();
  return result.data?.currency ?? null;
}

/** Public clinic settings exposed to the patient assistant. */
export async function getPatientClinicPublicInfo(clinicId: string) {
  const admin = createAdminClient();
  const [clinic, workingHours] = await Promise.all([
    admin
      .from("clinics")
      .select(
        "name, address, phone, website, timezone, locale, working_hours_start, working_hours_end",
      )
      .eq("id", clinicId)
      .eq("is_active", true)
      .maybeSingle(),
    admin
      .from("clinic_working_hours")
      .select("day_of_week, shift_start, shift_end")
      .eq("clinic_id", clinicId)
      .order("day_of_week")
      .order("shift_start"),
  ]);
  const error = clinic.error ?? workingHours.error;
  if (error || !clinic.data) return { data: null, error };
  return {
    data: {
      name: clinic.data.name,
      address: clinic.data.address,
      phone: clinic.data.phone,
      website: clinic.data.website,
      timezone: clinic.data.timezone,
      locale: clinic.data.locale,
      working_hours: workingHours.data ?? [],
      default_working_hours:
        clinic.data.working_hours_start && clinic.data.working_hours_end
          ? {
              start: clinic.data.working_hours_start,
              end: clinic.data.working_hours_end,
            }
          : null,
    },
    error: null,
  };
}

/** P5B (§6.2): update the per-clinic patient AI reply mode. `clinics` is keyed
 * by `id`, so it is written by primary key rather than the auto-scoping client. */
export async function setClinicAiReplyMode(
  clinicId: string,
  mode: "off" | "suggest" | "auto",
) {
  return createAdminClient()
    .from("clinics")
    .update({ ai_reply_mode: mode })
    .eq("id", clinicId)
    .select("id")
    .maybeSingle();
}

/** P5A conversation-bound patient identity resolution. The RPC rechecks the
 * clinic/conversation pair and patient entitlement; callers never provide or
 * receive a model-visible patient id. */
export async function resolvePatientAiContext(input: {
  clinicId: string;
  conversationId: string;
}) {
  return createAdminClient().rpc("resolve_patient_ai_context", {
    p_clinic_id: input.clinicId,
    p_conversation_id: input.conversationId,
  });
}

/**
 * Atomically detaches an unavailable patient and clears only the conversation's
 * episode-scoped Assistant state. The RPC is idempotent and leaves a valid
 * active patient link untouched.
 */
export async function normalizeStalePatientConversationEpisode(input: {
  clinicId: string;
  conversationId: string;
}) {
  return createAdminClient().rpc("normalize_stale_patient_conversation_episode", {
    p_clinic_id: input.clinicId,
    p_conversation_id: input.conversationId,
  });
}

/**
 * P11T — the conversation's active episode, opened if the thread was resting.
 *
 * Idempotent, and the episode's `started_at` is always the P11O context
 * boundary, so the durable record and the cut every reader already uses cannot
 * disagree. Called once at the top of an assistant turn, before anything that
 * feeds the model is read.
 */
export async function resolveConversationEpisode(input: {
  clinicId: string;
  conversationId: string;
  startedAt?: string | null;
}) {
  return createAdminClient().rpc("resolve_conversation_episode", {
    p_clinic_id: input.clinicId,
    p_conversation_id: input.conversationId,
    p_started_at: input.startedAt ?? undefined,
  });
}

/**
 * P11T — ends the thread's active episode with a stated reason and clears the
 * current-episode pointer. Idempotent; a thread with no active episode is
 * already ended, which is a normal outcome rather than an error.
 */
export async function closeConversationEpisode(input: {
  clinicId: string;
  conversationId: string;
  reason: "manual_close" | "assistant_close" | "idle_timeout" | "superseded";
  endedAt?: string;
}) {
  return createAdminClient().rpc("close_conversation_episode", {
    p_clinic_id: input.clinicId,
    p_conversation_id: input.conversationId,
    p_end_reason: input.reason,
    p_ended_at: input.endedAt ?? undefined,
  });
}

/** Rate-limited-in-database DOB verification for one conversation. */
export async function verifyPatientConversationDob(input: {
  clinicId: string;
  conversationId: string;
  dateOfBirth: string;
}) {
  return createAdminClient().rpc("verify_patient_conversation_dob", {
    p_clinic_id: input.clinicId,
    p_conversation_id: input.conversationId,
    p_date_of_birth: input.dateOfBirth,
  });
}

/** Atomic P5A preliminary-booking boundary (identity, caps, TTL, and audit). */
export async function createPatientPreliminaryBooking(input: {
  clinicId: string;
  conversationId: string;
  doctorId: string;
  scheduledAt: string;
  durationMinutes: number;
  serviceId?: string | null;
}) {
  return createAdminClient().rpc("create_patient_preliminary_booking", {
    p_clinic_id: input.clinicId,
    p_conversation_id: input.conversationId,
    p_doctor_id: input.doctorId,
    p_scheduled_at: input.scheduledAt,
    p_duration_minutes: input.durationMinutes,
    p_service_id: input.serviceId ?? undefined,
  });
}

export async function listPatientAiAppointments(input: {
  clinicId: string;
  conversationId: string;
}) {
  return createAdminClient().rpc("list_patient_ai_appointments", {
    p_clinic_id: input.clinicId,
    p_conversation_id: input.conversationId,
  });
}

export async function cancelPatientAiAppointment(input: {
  clinicId: string;
  conversationId: string;
  appointmentId: string;
}) {
  return createAdminClient().rpc("cancel_patient_ai_appointment", {
    p_clinic_id: input.clinicId,
    p_conversation_id: input.conversationId,
    p_appointment_id: input.appointmentId,
  });
}

export async function preparePatientAiReschedule(input: {
  clinicId: string;
  conversationId: string;
  appointmentId: string;
}) {
  return createAdminClient().rpc("prepare_patient_ai_reschedule", {
    p_clinic_id: input.clinicId,
    p_conversation_id: input.conversationId,
    p_appointment_id: input.appointmentId,
  });
}

export async function reschedulePatientAiAppointment(input: {
  clinicId: string;
  conversationId: string;
  appointmentId: string;
  scheduledAt: string;
}) {
  return createAdminClient().rpc("reschedule_patient_ai_appointment", {
    p_clinic_id: input.clinicId,
    p_conversation_id: input.conversationId,
    p_appointment_id: input.appointmentId,
    p_scheduled_at: input.scheduledAt,
  });
}

export async function searchPatientClinicFaq(input: {
  clinicId: string;
  conversationId: string;
  question: string;
  language: "ar" | "en";
}) {
  return createAdminClient().rpc("search_patient_clinic_faq", {
    p_clinic_id: input.clinicId,
    p_conversation_id: input.conversationId,
    p_question: input.question,
    p_language: input.language,
  });
}

/** Daily P3D cron sub-job. Expiry is terminal, transition-checked, and audited. */
export async function expireAiPendingBookings(now = new Date(), limit = 500) {
  return createAdminClient().rpc("expire_ai_pending_bookings", {
    p_now: now.toISOString(),
    p_limit: limit,
  });
}

/** Expires provisional intake requests so stale rows cannot block rebooking. */
export async function expireAiAppointmentRequests(now = new Date(), limit = 500) {
  return createAdminClient().rpc("expire_ai_appointment_requests", {
    p_now: now.toISOString(),
    p_limit: limit,
  });
}

/** Atomic webhook boundary: one inbound event creates/repairs one sender thread. */
export async function persistWhatsAppInbound(input: {
  clinicId: string;
  sender: string;
  body: string;
  providerMessageId: string;
  receivedAt: string;
  /** P8: WhatsApp's own label for the contact. Never identity, never matched. */
  displayName?: string | null;
  /** P8: a message from the history sync — persisted, but with no live effects. */
  historical?: boolean;
}) {
  return createAdminClient().rpc("persist_whatsapp_inbound", {
    p_clinic_id: input.clinicId,
    p_sender: input.sender,
    p_body: input.body,
    p_provider_message_id: input.providerMessageId,
    p_received_at: input.receivedAt,
    p_display_name: input.displayName ?? undefined,
    p_historical: input.historical ?? false,
  });
}

/** Linked-device inbound persistence, isolated by authenticated account. */
export async function persistLinkedDeviceInbound(input: {
  clinicId: string;
  authenticatedAccountId: string;
  sender: string;
  body: string;
  providerMessageId: string;
  receivedAt: string;
  displayName?: string | null;
  historical?: boolean;
}) {
  return createAdminClient().rpc("persist_linked_device_inbound", {
    p_clinic_id: input.clinicId,
    p_authenticated_account_id: input.authenticatedAccountId,
    p_sender: input.sender,
    p_body: input.body,
    p_provider_message_id: input.providerMessageId,
    p_received_at: input.receivedAt,
    p_display_name: input.displayName ?? undefined,
    p_historical: input.historical ?? false,
  });
}

/**
 * P8: opens (or renames) the inbox thread for a chat the history sync listed.
 *
 * Deliberately free of every live-message side effect — no service window, no
 * status change, no notification — because importing a year of conversation must
 * not look like a year of patients writing in at once.
 */
/**
 * P8 — the private bucket holding inbound WhatsApp attachments.
 *
 * Storage has no per-clinic client the way PostgREST does, so these two helpers
 * live here (the one module allowed to hold the raw service-role client) and take
 * the clinic id explicitly. Both refuse any path outside `<clinicId>/`: a signed
 * URL is a bearer token for a file, and a single bad row must not be enough to
 * mint one for another tenant.
 */
export const WHATSAPP_ATTACHMENT_BUCKET = "whatsapp-inbound";

export async function signWhatsAppAttachmentUrls(input: {
  clinicId: string;
  paths: readonly string[];
  expiresInSeconds: number;
}) {
  const scoped = input.paths.filter(
    (path) => path.startsWith(`${input.clinicId}/`) && !path.includes(".."),
  );
  if (scoped.length === 0) return { data: [], error: null };
  return createAdminClient()
    .storage.from(WHATSAPP_ATTACHMENT_BUCKET)
    .createSignedUrls(scoped, input.expiresInSeconds);
}

export async function downloadWhatsAppAttachment(input: {
  clinicId: string;
  storagePath: string;
}) {
  if (!input.storagePath.startsWith(`${input.clinicId}/`) || input.storagePath.includes("..")) {
    return { data: null, error: new Error("FOREIGN_ATTACHMENT_PATH") };
  }
  return createAdminClient()
    .storage.from(WHATSAPP_ATTACHMENT_BUCKET)
    .download(input.storagePath);
}

/**
 * P8B §5 — the bucket staff-supplied outbound files live in.
 *
 * Separate from `whatsapp-inbound` deliberately. The two have different
 * lifecycles, different retention questions and different threat models: one
 * holds what strangers sent us, the other holds what our own staff chose to
 * send out. Mixing them would make either one's policy the other's ceiling.
 */
export const WHATSAPP_OUTBOUND_BUCKET = "whatsapp-outbound";

/**
 * Buckets a WhatsApp send may read from, and the tenant rule for each.
 *
 * This is the single place that decides whether a stored object can leave the
 * building over WhatsApp. `whatsapp-outbound` is clinic-partitioned at the path
 * root; the two document buckets are partitioned one level in, which is the
 * layout their own migrations established. A bucket that is not named here
 * cannot be sent from at all, whatever a row says.
 */
const SENDABLE_BUCKET_PREFIX: Record<string, (clinicId: string) => readonly string[]> = {
  "whatsapp-outbound": (clinicId) => [`${clinicId}/`],
  "patient-assets": (clinicId) => [`documents/${clinicId}/`],
  "clinic-documents": (clinicId) => [`documents/${clinicId}/`],
};

/**
 * Is this exact object one this clinic may send?
 *
 * Path containment only — the *record-level* authorization (is this staff member
 * allowed to see this patient's file?) happens before a row is ever written, in
 * the action that prepares the send. This is the second of the two checks, and
 * it is the one that holds even if the first is wrong: a path outside the
 * clinic's own prefix is refused regardless of what any row claims.
 */
export function isSendableStoragePath(
  bucket: string,
  storagePath: string,
  clinicId: string,
): boolean {
  const prefixes = SENDABLE_BUCKET_PREFIX[bucket];
  if (!prefixes) return false;
  if (storagePath.includes("..") || storagePath.startsWith("/")) return false;
  return prefixes(clinicId).some((prefix) => storagePath.startsWith(prefix));
}

/** Writes one staff-supplied file into the private outbound bucket. */
export async function uploadOutboundMedia(input: {
  clinicId: string;
  path: string;
  bytes: Buffer;
  contentType: string;
}) {
  if (!isSendableStoragePath(WHATSAPP_OUTBOUND_BUCKET, input.path, input.clinicId)) {
    return { data: null, error: new Error("FOREIGN_OUTBOUND_PATH") };
  }
  return createAdminClient()
    .storage.from(WHATSAPP_OUTBOUND_BUCKET)
    .upload(input.path, input.bytes, {
      contentType: input.contentType,
      // A prepared file is written exactly once, under a fresh identifier. No
      // caller can overwrite bytes another send is already carrying.
      upsert: false,
    });
}

/** Signs outbound files for the thread view, one clinic at a time. */
export async function signOutboundMediaUrls(input: {
  clinicId: string;
  paths: readonly string[];
  expiresInSeconds: number;
}) {
  const scoped = input.paths.filter((path) =>
    isSendableStoragePath(WHATSAPP_OUTBOUND_BUCKET, path, input.clinicId),
  );
  if (scoped.length === 0) return { data: [], error: null };
  return createAdminClient()
    .storage.from(WHATSAPP_OUTBOUND_BUCKET)
    .createSignedUrls(scoped, input.expiresInSeconds);
}

/**
 * Signs already-authorized outbound-media references for the Inbox thread.
 * Each bucket is handled separately and every path is checked again before a
 * bearer URL is minted.
 */
export async function signSendableMediaUrls(input: {
  clinicId: string;
  items: readonly { bucket: string; storagePath: string }[];
  expiresInSeconds: number;
}): Promise<Map<string, string>> {
  const byBucket = new Map<string, string[]>();
  for (const item of input.items) {
    if (!isSendableStoragePath(item.bucket, item.storagePath, input.clinicId)) continue;
    const paths = byBucket.get(item.bucket) ?? [];
    if (!paths.includes(item.storagePath)) paths.push(item.storagePath);
    byBucket.set(item.bucket, paths);
  }

  const signed = new Map<string, string>();
  await Promise.all(
    [...byBucket.entries()].map(async ([bucket, paths]) => {
      const result = await createAdminClient()
        .storage.from(bucket)
        .createSignedUrls(paths, input.expiresInSeconds);
      if (result.error) return;
      for (const row of result.data ?? []) {
        if (row.signedUrl) signed.set(`${bucket}\u0000${row.path}`, row.signedUrl);
      }
    }),
  );
  return signed;
}

/** Reads any sendable object's bytes, after the bucket/prefix check. */
export async function downloadSendableObject(input: {
  clinicId: string;
  bucket: string;
  storagePath: string;
}) {
  if (!isSendableStoragePath(input.bucket, input.storagePath, input.clinicId)) {
    return { data: null, error: new Error("FOREIGN_MEDIA_PATH") };
  }
  return createAdminClient().storage.from(input.bucket).download(input.storagePath);
}

/** Removes a prepared file that was never sent, or whose send failed. */
export async function removeOutboundMedia(input: {
  clinicId: string;
  paths: readonly string[];
}) {
  const scoped = input.paths.filter((path) =>
    isSendableStoragePath(WHATSAPP_OUTBOUND_BUCKET, path, input.clinicId),
  );
  if (scoped.length === 0) return { data: [], error: null };
  return createAdminClient().storage.from(WHATSAPP_OUTBOUND_BUCKET).remove(scoped);
}

/**
 * P11S — one sweep of the five-minute patient-episode idle close.
 *
 * The whole decision lives in `close_idle_patient_ai_episodes`, so the pg_cron
 * job and the cron route cannot disagree about what "finished" means. Here only
 * because the service-role client is confined to this file.
 */
export async function closeIdlePatientAiEpisodes(now?: Date) {
  return createAdminClient().rpc("close_idle_patient_ai_episodes", {
    ...(now ? { p_now: now.toISOString() } : {}),
  });
}

export async function upsertWhatsAppHistoryChat(input: {
  clinicId: string;
  participant: string;
  displayName: string | null;
  lastMessageAt: string | null;
}) {
  return createAdminClient().rpc("upsert_whatsapp_history_chat", {
    p_clinic_id: input.clinicId,
    p_participant: input.participant,
    p_display_name: input.displayName ?? undefined,
    p_last_message_at: input.lastMessageAt ?? undefined,
  });
}

export async function upsertLinkedDeviceHistoryChat(input: {
  clinicId: string;
  authenticatedAccountId: string;
  participant: string;
  displayName: string | null;
  lastMessageAt: string | null;
}) {
  return createAdminClient().rpc("upsert_linked_device_history_chat", {
    p_clinic_id: input.clinicId,
    p_authenticated_account_id: input.authenticatedAccountId,
    p_participant: input.participant,
    p_display_name: input.displayName ?? undefined,
    p_last_message_at: input.lastMessageAt ?? undefined,
  });
}

/**
 * P8: the human-takeover switch. Conditional inside the function, so two staff
 * members flipping it at once produce one transition; `changed = false` means
 * somebody else got there first.
 */
export async function setConversationAiPause(input: {
  clinicId: string;
  conversationId: string;
  paused: boolean;
  actorId: string;
  reason?: string | null;
}) {
  return createAdminClient().rpc("set_conversation_ai_pause", {
    p_clinic_id: input.clinicId,
    p_conversation_id: input.conversationId,
    p_paused: input.paused,
    p_actor_id: input.actorId,
    // `p_reason` defaults to null in SQL and the function coalesces it, so
    // omitting the key is exactly equivalent to sending null — and the
    // generated signature only admits the omission.
    p_reason: input.reason ?? undefined,
  });
}

/**
 * P8B §1: persists what the assistant has established in a conversation.
 *
 * `collected` is *merged* by the RPC, never replaced, so a turn that settles a
 * date of birth cannot erase a name settled two turns earlier. `pending` is
 * singular by design — one outstanding question at a time — and
 * `clearPending: true` is how "nothing is outstanding any more" is said, since
 * a null argument already means "leave it alone".
 *
 * Nothing written here is ever an authorization input: see
 * `lib/ai/collected-state.ts` for why the shape is deliberately incapable of
 * carrying a patient id or a verification flag.
 */
export async function setConversationAiState(input: {
  clinicId: string;
  conversationId: string;
  collected?: Record<string, string | number> | null;
  pending?: Record<string, unknown> | null;
  clearPending?: boolean;
  /**
   * P9: the whole booking-stage snapshot, replaced rather than merged. Unlike
   * `collected`, this object is internally consistent — a stage, when it was
   * entered, and the offers that belong to it — so merging two partial
   * snapshots could produce a record that was never true. Callers always send
   * the complete object they just derived.
   */
  stage?: Record<string, unknown> | null;
}) {
  return createAdminClient().rpc("set_conversation_ai_state", {
    p_clinic_id: input.clinicId,
    p_conversation_id: input.conversationId,
    p_collected: (input.collected ?? null) as never,
    p_pending: (input.pending ?? null) as never,
    p_clear_pending: input.clearPending ?? false,
    p_stage: (input.stage ?? null) as never,
  });
}

/**
 * P8B §3: opens (or re-opens) the WhatsApp thread for one number.
 *
 * Takes a number and never a patient id. It cannot create a patient — there is
 * no branch in the function that touches `public.patients` — and an existing
 * thread is returned rather than duplicated, so a staff member pressing "New
 * conversation" for a number that already has one lands in it.
 */
export async function openWhatsAppConversation(input: {
  clinicId: string;
  participantAddress: string;
  displayName?: string | null;
  actorId?: string | null;
}) {
  return createAdminClient().rpc("open_whatsapp_conversation", {
    p_clinic_id: input.clinicId,
    p_participant: input.participantAddress,
    p_display_name: input.displayName ?? undefined,
    p_actor_id: input.actorId ?? undefined,
  });
}

export async function openLinkedDeviceConversation(input: {
  clinicId: string;
  authenticatedAccountId: string;
  participantAddress: string;
  displayName?: string | null;
  actorId?: string | null;
}) {
  return createAdminClient().rpc("open_linked_device_conversation", {
    p_clinic_id: input.clinicId,
    p_authenticated_account_id: input.authenticatedAccountId,
    p_participant: input.participantAddress,
    p_display_name: input.displayName ?? undefined,
    p_actor_id: input.actorId ?? undefined,
  });
}

/**
 * P8B §3: records the contacts the linked device reports.
 *
 * Observed WhatsApp contact data and nothing more. A row says the linked
 * session reported this number/name; it implies no patient and links none.
 */
export async function upsertWhatsAppContacts(input: {
  clinicId: string;
  contacts: ReadonlyArray<{ participantAddress: string; displayName: string | null }>;
}) {
  return createAdminClient().rpc("upsert_whatsapp_contacts", {
    p_clinic_id: input.clinicId,
    p_contacts: input.contacts as never,
  });
}

/**
 * P8B §5/§7: takes one prepared outbound file for a send.
 *
 * A claim, not a read: exactly one caller moves the draft out of `draft`, so a
 * prepared file can never be attached to two messages, and a replayed send
 * finds nothing to claim rather than sending twice.
 */
export async function claimOutboundMedia(input: {
  clinicId: string;
  mediaId: string;
  conversationId: string;
}) {
  return createAdminClient().rpc("claim_outbound_media", {
    p_clinic_id: input.clinicId,
    p_media_id: input.mediaId,
    p_conversation_id: input.conversationId,
  });
}

/** P8B §5/§7: closes out a claimed file, against the message it went with. */
export async function finalizeOutboundMedia(input: {
  clinicId: string;
  mediaId: string;
  outboundMessageId?: string | null;
  failureReason?: string | null;
}) {
  return createAdminClient().rpc("finalize_outbound_media", {
    p_clinic_id: input.clinicId,
    p_media_id: input.mediaId,
    p_outbound_message_id: input.outboundMessageId ?? undefined,
    p_failure_reason: input.failureReason ?? undefined,
  });
}

/**
 * Releases a deterministic pre-send media failure for another attempt.
 *
 * The compare-and-set is the concurrency guard: only the caller holding the
 * current `sending` claim can return it to `draft`. Uploaded bytes stay in the
 * private bucket, so retry never depends on the browser uploading them again.
 */
export async function releaseOutboundMedia(input: {
  clinicId: string;
  mediaId: string;
  failureReason: string;
}) {
  return createClinicScopedAdminClient(input.clinicId)
    .from("outbound_message_media")
    .update({
      status: "draft",
      outbound_message_id: null,
      failure_reason: input.failureReason.slice(0, 120),
    })
    .eq("id", input.mediaId)
    .eq("status", "sending")
    .select("id")
    .maybeSingle();
}

/** Keeps an uncertain provider outcome single-use until delivery resolves it. */
export async function holdOutboundMedia(input: {
  clinicId: string;
  mediaId: string;
  outboundMessageId: string;
  failureReason: string;
}) {
  return createClinicScopedAdminClient(input.clinicId)
    .from("outbound_message_media")
    .update({
      outbound_message_id: input.outboundMessageId,
      failure_reason: input.failureReason.slice(0, 120),
    })
    .eq("id", input.mediaId)
    .eq("status", "sending")
    .select("id")
    .maybeSingle();
}

/** Stages an unknown WhatsApp sender without creating a public patient row. */
export async function stagePatientIntakeFromConversation(input: {
  clinicId: string;
  conversationId: string;
  fullName: string;
  nationalId: string;
  dateOfBirth: string;
  email: string;
  departmentId: string;
  doctorId: string;
  /** P9C: the staged person is not the sender ("ممكن احجز لصاحبي"). */
  forThirdParty?: boolean;
  /** Only read for a third party, and only as a contact number. */
  phone?: string | null;
  /** P10: optional, one of the eight stored blood groups. Never blocks an intake. */
  bloodType?: string | null;
  /**
   * P10: the name exactly as the patient typed it, when `fullName` is a Latin
   * transliteration of it. Kept beside the transliteration, never instead of it.
   */
  fullNameOriginal?: string | null;
}) {
  return createAdminClient().rpc("stage_patient_intake_from_conversation", {
    p_clinic_id: input.clinicId,
    p_conversation_id: input.conversationId,
    p_full_name: input.fullName,
    p_national_id: input.nationalId,
    p_date_of_birth: input.dateOfBirth,
    p_email: input.email,
    p_department_id: input.departmentId,
    p_doctor_id: input.doctorId,
    p_for_third_party: input.forThirdParty === true,
    p_phone: input.phone ?? undefined,
    p_blood_type: input.bloodType ?? undefined,
    p_full_name_original: input.fullNameOriginal ?? undefined,
  });
}

/**
 * P10 — the clinic's patient-assistant communication style.
 *
 * `clinics` is keyed by `id` and carries no `clinic_id`, so this goes through
 * the reviewed service-role RPC rather than the auto-scoping client, exactly as
 * `setClinicAiReplyMode` does.
 */
export async function setClinicAiCommunicationStyle(input: {
  clinicId: string;
  languageMode: string;
  arabicStyle: string;
  tone: string;
  styleInstruction: string | null;
}) {
  return createAdminClient().rpc("set_clinic_ai_communication_style", {
    p_clinic_id: input.clinicId,
    p_language_mode: input.languageMode,
    p_arabic_style: input.arabicStyle,
    p_tone: input.tone,
    // The generated signature types this as non-nullable text while the SQL
    // function nullifs an empty string back to null, so an unset style line
    // travels as "" and is stored as null by the function itself.
    p_style_instruction: input.styleInstruction ?? "",
  });
}

/**
 * P10 — booking-scope identity for a thread already linked by its own number.
 *
 * Writes `booking_identity_confirmed_at` and nothing else. It cannot set
 * `identity_verified_at`, so no disclosure path can be reached through it.
 */
export async function confirmPatientBookingIdentity(input: {
  clinicId: string;
  conversationId: string;
}) {
  return createAdminClient().rpc("confirm_patient_booking_identity", {
    p_clinic_id: input.clinicId,
    p_conversation_id: input.conversationId,
  });
}

/**
 * P10 — a returning patient writing from a number that is not on their file.
 *
 * Exact normalized name AND national id, rate-limited on the same counter as
 * the date-of-birth check, and incapable of reporting which half failed.
 */
export async function identifyPatientForBooking(input: {
  clinicId: string;
  conversationId: string;
  fullName: string;
  nationalId: string;
}) {
  return createAdminClient().rpc("identify_patient_for_booking", {
    p_clinic_id: input.clinicId,
    p_conversation_id: input.conversationId,
    p_full_name: input.fullName,
    p_national_id: input.nationalId,
  });
}

/**
 * P11 — "عايز أعرف ميعادي" from a name and a national id.
 *
 * Deliberately not a variant of `listPatientAiAppointments`: that one reads the
 * thread's own `patient_id`, and the whole security property here is that the
 * answer comes from the two supplied values and from nothing else. The RPC
 * links nothing, verifies nothing, and reports every failure identically.
 */
export async function lookupPatientAppointmentsByIdentity(input: {
  clinicId: string;
  conversationId: string;
  fullName: string;
  nationalId: string;
}) {
  return createAdminClient().rpc("lookup_patient_appointments_by_identity", {
    p_clinic_id: input.clinicId,
    p_conversation_id: input.conversationId,
    p_full_name: input.fullName,
    p_national_id: input.nationalId,
  });
}

/**
 * P9C — the pending intake this conversation is currently working on, if any.
 *
 * `create_preliminary_booking` needs it to answer one question the conversation
 * cannot answer for itself: is this appointment for the sender, or for the
 * person they are booking on behalf of? Getting that wrong means an appointment
 * filed under the wrong patient, so it is read from the staged row rather than
 * inferred from anything the model said.
 */
/**
 * Item #3 — the clinic's own file for this beneficiary, when it has one.
 *
 * Thin on purpose: every part of the identity decision — the exact folded
 * national/civil id, the folded name as confirmation, ambiguity failing closed,
 * the clinic scope — is in `find_clinic_patient_by_identity`, next to the data
 * it decides about and reachable only by `service_role`. This is the call.
 */
export async function findClinicPatientByIdentity(input: {
  clinicId: string;
  nationalId: string;
  fullName: string;
}) {
  return createAdminClient().rpc("find_clinic_patient_by_identity", {
    p_clinic_id: input.clinicId,
    p_national_id: input.nationalId,
    p_full_name: input.fullName,
  });
}

/**
 * Item #3 — stages a third-party intake that points at the beneficiary's
 * existing file rather than proposing a second one.
 *
 * Takes no patient id: `stage_matched_third_party_intake` re-proves the
 * identity from the id and the name itself, so no caller can name the record an
 * appointment lands on.
 */
export async function stageMatchedThirdPartyIntake(input: {
  clinicId: string;
  conversationId: string;
  fullName: string;
  nationalId: string;
  phone?: string | null;
  departmentId: string;
  doctorId: string;
}) {
  return createAdminClient().rpc("stage_matched_third_party_intake", {
    p_clinic_id: input.clinicId,
    p_conversation_id: input.conversationId,
    p_full_name: input.fullName,
    p_national_id: input.nationalId,
    p_phone: input.phone ?? null,
    p_department_id: input.departmentId,
    p_doctor_id: input.doctorId,
  });
}

export async function getPendingConversationIntake(input: {
  clinicId: string;
  conversationId: string;
}) {
  return createClinicScopedAdminClient(input.clinicId)
    .from("ai_patient_intakes")
    .select("id, full_name, doctor_id, department_id, is_third_party")
    .eq("conversation_id", input.conversationId)
    .eq("review_status", "pending_review")
    .maybeSingle();
}

/** Creates a real-slot pending request owned by a provisional intake. */
export async function createProvisionalAiAppointmentRequest(input: {
  clinicId: string;
  conversationId: string;
  doctorId: string;
  scheduledAt: string;
  durationMinutes: number;
  serviceId?: string | null;
}) {
  return createAdminClient().rpc("create_provisional_ai_appointment_request", {
    p_clinic_id: input.clinicId,
    p_conversation_id: input.conversationId,
    p_doctor_id: input.doctorId,
    p_scheduled_at: input.scheduledAt,
    p_duration_minutes: input.durationMinutes,
    p_service_id: input.serviceId ?? undefined,
  });
}

/** Atomic inbox-triage boundary; null is a durable explicit unlink decision. */
export async function setInboxConversationPatient(input: {
  clinicId: string;
  conversationId: string;
  patientId: string | null;
}) {
  return createAdminClient().rpc("set_conversation_patient", {
    p_clinic_id: input.clinicId,
    p_conversation_id: input.conversationId,
    p_patient_id: input.patientId,
  });
}

/** Persists provider acceptance/failure and conversation activity together. */
export async function finalizeOutboundMessage(input: {
  clinicId: string;
  outboundMessageId: string;
  status: "sent" | "failed";
  providerMessageId: string | null;
  error: string | null;
  costMicro: number | null;
  occurredAt: string;
}) {
  return createAdminClient().rpc("finalize_outbound_message", {
    p_clinic_id: input.clinicId,
    p_outbound_message_id: input.outboundMessageId,
    p_status: input.status,
    p_provider_message_id: input.providerMessageId,
    p_error: input.error,
    p_cost_micro: input.costMicro,
    p_occurred_at: input.occurredAt,
  });
}

/** Monotonic delivery callback boundary with opaque-reference correlation repair. */
export async function advanceOutboundMessageStatus(input: {
  provider: Database["public"]["Enums"]["messaging_provider"];
  providerMessageId: string;
  clientReference: string | null;
  expectedClinicId: string | null;
  status: Database["public"]["Enums"]["outbound_message_status"];
  error: string | null;
  occurredAt: string | null;
}) {
  return createAdminClient().rpc("advance_outbound_message_status", {
    p_provider: input.provider,
    p_provider_message_id: input.providerMessageId,
    p_client_reference: input.clientReference,
    p_expected_clinic_id: input.expectedClinicId,
    p_status: input.status,
    p_error: input.error,
    p_occurred_at: input.occurredAt,
  });
}

/**
 * Reviewed cross-tenant lookup for public provider callbacks. The untrusted
 * sender identity is used only to locate one channel; callers must decrypt
 * that row and authenticate the webhook before processing any event.
 */
export async function findClinicChannelForWebhook(
  provider: Database["public"]["Enums"]["messaging_provider"],
  senderIdentity: string,
) {
  return createAdminClient()
    .from("clinic_channels")
    .select(
      "id, clinic_id, channel, provider, credentials_encrypted, sender_identity, status, connected_at, created_at, updated_at",
    )
    .eq("provider", provider)
    .eq("sender_identity", senderIdentity)
    .in("status", ["pending", "active", "error"])
    .maybeSingle();
}

/** Preflight for provider configuration so a tenant cannot claim another channel's identity. */
export async function findClinicChannelIdentityOwner(
  _provider: Database["public"]["Enums"]["messaging_provider"],
  senderIdentity: string,
) {
  return createAdminClient()
    .from("clinic_channels")
    .select("id, clinic_id")
    .eq("channel", "whatsapp")
    .eq("sender_identity", senderIdentity)
    .maybeSingle();
}

/** Routes WABA-scoped Meta callbacks that do not contain a phone-number id. */
export async function findClinicChannelByProviderAccount(
  provider: Database["public"]["Enums"]["messaging_provider"],
  providerAccountId: string,
) {
  return createAdminClient()
    .from("clinic_channels")
    // credentials_encrypted is selected so a P7D manual channel's own app
    // secret can verify the signature of a WABA-routed callback, exactly as it
    // does for a phone-routed one.
    .select("id, clinic_id, sender_identity, status, credentials_encrypted")
    .eq("channel", "whatsapp")
    .eq("provider", provider)
    .eq("provider_account_id", providerAccountId)
    .in("status", ["pending", "active", "error"])
    .maybeSingle();
}

/** Status callbacks do not carry clinic identity; provider ids are globally unique. */
export async function findOutboundMessageForWebhook(
  provider: Database["public"]["Enums"]["messaging_provider"],
  providerMessageId: string,
) {
  return createAdminClient()
    .from("outbound_messages")
    .select("id, clinic_id")
    .eq("provider", provider)
    .eq("provider_message_id", providerMessageId)
    .maybeSingle();
}

/**
 * Reviewed cross-tenant read for the P3D reminders cron. The RPC restricts
 * the bounded window to appointments with at least one actionable offset
 * (due, unsent, not under a fresh claim), so fully-reminded rows can never
 * starve later eligible appointments (P3-H2). All subsequent reads/writes go
 * through createClinicScopedAdminClient.
 */
export async function listReminderCandidateAppointments(
  nowIso: string,
  horizonIso: string,
) {
  return createAdminClient().rpc("list_reminder_candidates", {
    p_now: nowIso,
    p_horizon: horizonIso,
  });
}

/**
 * Reviewed cross-tenant read for the daily reminder cron (§7.2b). Selects
 * confirmed appointments for reminder-enabled clinics whose scheduled_at falls
 * on the clinic-local calendar date of today or tomorrow and still has an
 * actionable 'daily' lease. The clinic-local window is computed in SQL.
 */
export async function listDailyReminderCandidates(
  nowIso: string,
  horizonIso: string,
) {
  return createAdminClient().rpc("list_daily_reminder_candidates", {
    p_now: nowIso,
    p_horizon: horizonIso,
  });
}

/**
 * Per-channel idempotency ledger (2026-07-19 flow revision). Email and WhatsApp
 * are independent channels: each (clinic, dedupe_key, channel) is claimed before
 * a send so a duplicate is never dispatched, and a failed channel is released
 * for retry without touching the channel that succeeded. A 'claimed' row older
 * than the 15-minute lease is re-claimable, so a crash never suppresses a
 * message permanently. Only finalizeMessageDispatch records a real send.
 */
export async function claimMessageDispatch(input: {
  clinicId: string;
  dedupeKey: string;
  channel: "whatsapp" | "email";
  claimedAt: string;
}) {
  return createAdminClient().rpc("claim_message_dispatch", {
    p_clinic_id: input.clinicId,
    p_dedupe_key: input.dedupeKey,
    p_channel: input.channel,
    p_now: input.claimedAt,
  });
}

/** Terminal sent marker for one channel, written only after provider acceptance. */
export async function finalizeMessageDispatch(input: {
  clinicId: string;
  dedupeKey: string;
  channel: "whatsapp" | "email";
  sentAt: string;
  outboundMessageId: string | null;
}) {
  return createAdminClient().rpc("finalize_message_dispatch", {
    p_clinic_id: input.clinicId,
    p_dedupe_key: input.dedupeKey,
    p_channel: input.channel,
    p_sent_at: input.sentAt,
    // The RPC accepts NULL (uuid param); the generated type over-narrows to string.
    p_outbound_message_id: input.outboundMessageId as string,
  });
}

/** Compensation when a claimed channel send fails: the next attempt retries it. */
export async function releaseMessageDispatch(input: {
  clinicId: string;
  dedupeKey: string;
  channel: "whatsapp" | "email";
}) {
  return createAdminClient().rpc("release_message_dispatch", {
    p_clinic_id: input.clinicId,
    p_dedupe_key: input.dedupeKey,
    p_channel: input.channel,
  });
}

/** Reviewed cross-tenant read for the P3D invoice follow-up cron. */
export async function listDueFollowupSequences(nowIso: string) {
  return createAdminClient()
    .from("followup_sequences")
    .select("id, clinic_id, appointment_id, step, next_run_at, status, created_at")
    .eq("status", "active")
    .lte("next_run_at", nowIso)
    .order("next_run_at", { ascending: true })
    .limit(500);
}

/**
 * Reviewed read of one clinic's messaging-relevant settings for cron sends.
 * The clinics table has no clinic_id column, so the scoped wrapper cannot
 * express it; this helper stays metadata-only.
 */
export async function getClinicReminderSettings(clinicId: string) {
  return createAdminClient()
    .from("clinics")
    .select(
      "id, name, timezone, locale, time_format, digits, currency, reminder_offsets, reminders_enabled, invoice_followups_enabled, invoice_followup_first_days, invoice_followup_second_days, invoice_followup_email_subject, invoice_followup_email_body",
    )
    .eq("id", clinicId)
    .maybeSingle();
}

/**
 * Atomic claim-before-send lease for one (appointment, offset) — §7.2
 * idempotency. Stale claims (crashed runs) become re-claimable after the
 * lease window; only finalizeAppointmentReminder records a real send.
 */
export async function claimAppointmentReminder(input: {
  clinicId: string;
  appointmentId: string;
  offsetHours: number;
  claimedAt: string;
}) {
  return createAdminClient().rpc("claim_appointment_reminder", {
    p_clinic_id: input.clinicId,
    p_appointment_id: input.appointmentId,
    p_offset_hours: input.offsetHours,
    p_claimed_at: input.claimedAt,
  });
}

/** Terminal sent marker, written only after a successful dispatch. */
export async function finalizeAppointmentReminder(input: {
  clinicId: string;
  appointmentId: string;
  offsetHours: number;
  sentAt: string;
}) {
  return createAdminClient().rpc("finalize_appointment_reminder", {
    p_clinic_id: input.clinicId,
    p_appointment_id: input.appointmentId,
    p_offset_hours: input.offsetHours,
    p_sent_at: input.sentAt,
  });
}

/** Compensation when a claimed reminder send fails: the next run retries it. */
export async function releaseAppointmentReminder(input: {
  clinicId: string;
  appointmentId: string;
  offsetHours: number;
}) {
  return createAdminClient().rpc("release_appointment_reminder", {
    p_clinic_id: input.clinicId,
    p_appointment_id: input.appointmentId,
    p_offset_hours: input.offsetHours,
  });
}

/**
 * Atomic notification fan-out (§7.5). The RPC inserts one row per recipient
 * with ON CONFLICT DO NOTHING against the partial unique
 * (recipient_id, dedupe_key) WHERE read_at IS NULL index, so concurrent
 * emitters cannot double-insert (P3-M2). The composite recipient FK rejects
 * recipients outside the clinic.
 */
export async function emitClinicNotificationRows(input: {
  clinicId: string;
  recipientIds: readonly string[];
  type: string;
  link: string | null;
  data: Record<string, string>;
  dedupeKey: string | null;
}) {
  return createAdminClient().rpc("emit_clinic_notifications", {
    p_clinic_id: input.clinicId,
    p_recipient_ids: [...input.recipientIds],
    p_type: input.type,
    p_link: input.link,
    p_data: input.data,
    p_dedupe_key: input.dedupeKey,
  });
}

/**
 * Template callbacks may omit phone_number_id. Meta template ids are global,
 * so this reviewed helper resolves exactly one owning clinic before a scoped
 * update is made.
 */
export async function findMessageTemplateForWebhook(providerTemplateId: string) {
  return createAdminClient()
    .from("message_templates")
    .select("id, clinic_id")
    .eq("provider_template_id", providerTemplateId)
    .maybeSingle();
}

/** Provider-scoped template callback routing for parallel 360dialog/Meta bindings. */
export async function findMessageTemplateBindingForWebhook(
  provider: Database["public"]["Enums"]["messaging_provider"],
  providerTemplateId: string,
) {
  return createAdminClient()
    .from("message_template_provider_bindings")
    .select("id, template_id, clinic_id, approval_status")
    .eq("provider", provider)
    .eq("provider_template_id", providerTemplateId)
    .maybeSingle();
}

/**
 * P6C (§6.6, plan line 1310): service-role audit boundary for a connection-state
 * transition or template approval-status change. Writes exactly one clinic-scoped
 * `messaging:<event>` audit_logs row (callers invoke this only when a stored signal
 * actually changed — never one row per callback). The summary is PHI-free metadata
 * (states, sanitized reason codes) only. Read by the P6D activity timeline through
 * the existing audit_logs_select_admin_manager policy.
 */
export async function logMessagingEvent(input: {
  clinicId: string;
  event: string;
  recordId?: string | null;
  summary?: Record<string, unknown>;
}) {
  return createAdminClient().rpc("log_messaging_event", {
    p_clinic_id: input.clinicId,
    p_event: input.event,
    p_record_id: input.recordId ?? undefined,
    p_summary: (input.summary ?? {}) as Database["public"]["Tables"]["audit_logs"]["Row"]["new_data"],
  });
}

/**
 * P6C safe-metadata boundary: the WhatsApp channel's operational state columns plus
 * its encrypted credentials, for the connection-state machine and reconciliation
 * poll. The non-secret status columns live outside the encrypted envelope; the
 * caller decrypts credentials only to call the provider. Scoped to one clinic.
 */
export async function getWhatsAppChannelStateRow(
  clinicId: string,
  provider: Database["public"]["Enums"]["messaging_provider"] = "meta",
) {
  return createClinicScopedAdminClient(clinicId)
    .from("clinic_channels")
    .select(
      "id, provider, provider_account_id, status, credentials_encrypted, connection_state, business_verification_status, account_review_status, phone_status, quality_rating, messaging_limit_tier, webhook_subscribed, last_synced_at, last_signal_at, last_state_reason, connected_at, updated_at, onboarding_flow, history_sync_requested_at",
    )
    .eq("channel", "whatsapp")
    .eq("provider", provider)
    .maybeSingle();
}

/** Approved-template count for the `templates_pending → connected` transition (P3B sync). */
export async function countApprovedTemplates(
  clinicId: string,
  provider: Database["public"]["Enums"]["messaging_provider"] = "meta",
  providerAccountId?: string | null,
): Promise<number> {
  let query = createClinicScopedAdminClient(clinicId)
    .from("message_template_provider_bindings")
    .select("id", { count: "exact", head: true })
    .eq("provider", provider)
    .eq("approval_status", "approved");
  if (providerAccountId) query = query.eq("provider_account_id", providerAccountId);
  const result = await query;
  return result.error ? 0 : result.count ?? 0;
}

/** Atomic P6C operational-state compare-and-set plus transition audit. */
export async function applyMetaChannelState(input: {
  clinicId: string;
  channelId: string;
  expectedUpdatedAt: string;
  status: Database["public"]["Enums"]["clinic_channel_status"];
  connectionState: string;
  businessVerificationStatus: string | null;
  accountReviewStatus: string | null;
  phoneStatus: string | null;
  qualityRating: string | null;
  messagingLimitTier: string | null;
  webhookSubscribed: boolean;
  lastStateReason: string | null;
  lastSyncedAt?: string | null;
  lastSignalAt?: string | null;
}) {
  return createAdminClient().rpc("apply_meta_channel_state", {
    p_clinic_id: input.clinicId,
    p_channel_id: input.channelId,
    p_expected_updated_at: input.expectedUpdatedAt,
    p_status: input.status,
    p_connection_state: input.connectionState,
    p_business_verification_status: input.businessVerificationStatus,
    p_account_review_status: input.accountReviewStatus,
    p_phone_status: input.phoneStatus,
    p_quality_rating: input.qualityRating,
    p_messaging_limit_tier: input.messagingLimitTier,
    p_webhook_subscribed: input.webhookSubscribed,
    p_last_state_reason: input.lastStateReason,
    p_last_synced_at: input.lastSyncedAt ?? undefined,
    p_last_signal_at: input.lastSignalAt ?? undefined,
  });
}

export async function applyMessageTemplateProviderStatus(input: {
  provider: Database["public"]["Enums"]["messaging_provider"];
  providerTemplateId: string;
  status: Database["public"]["Enums"]["template_approval_status"];
  allowedFrom: Database["public"]["Enums"]["template_approval_status"][];
}) {
  return createAdminClient().rpc("apply_message_template_provider_status", {
    p_provider: input.provider,
    p_provider_template_id: input.providerTemplateId,
    p_status: input.status,
    p_allowed_from: input.allowedFrom,
  });
}

export async function activateWhatsAppProvider(
  clinicId: string,
  provider: "dialog360" | "meta",
) {
  return createAdminClient().rpc("activate_whatsapp_provider", {
    p_clinic_id: clinicId,
    p_provider: provider,
  });
}

/**
 * Cross-tenant list of active Meta-direct WhatsApp channels for the low-frequency
 * reconciliation cron (P3D precedent). Reviewed platform read: non-secret state
 * columns + the encrypted credential envelope only; bounded. The cron decrypts and
 * polls each per its clinic through the scoped boundary.
 */
export async function listActiveMetaChannels(limit = 64) {
  return createAdminClient().rpc("claim_meta_channels_for_reconciliation", {
    p_limit: limit,
  });
}

/** Atomic P6D webhook-health write plus transition-only clinic audit. */
export async function applyWhatsAppWebhookHealth(input: {
  clinicId: string;
  channelId: string;
  status: "unknown" | "healthy" | "degraded";
  reason?: string | null;
  checkedAt?: string | null;
  verifiedAt?: string | null;
}) {
  return createAdminClient().rpc("apply_whatsapp_webhook_health", {
    p_clinic_id: input.clinicId,
    p_channel_id: input.channelId,
    p_status: input.status,
    p_reason: input.reason ?? undefined,
    p_checked_at: input.checkedAt ?? undefined,
    p_verified_at: input.verifiedAt ?? undefined,
  });
}

/** Fair bounded daily P6D self-check claim across both WhatsApp providers. */
export async function claimWhatsAppChannelsForHealthCheck(limit = 120) {
  return createAdminClient().rpc("claim_whatsapp_channels_for_health_check", {
    p_limit: limit,
  });
}

/** P6D platform-safe report source; contains no credentials, PII, or message bodies. */
export async function loadOperatorWhatsAppHealthReport() {
  return createAdminClient().rpc("operator_whatsapp_health_report");
}

/**
 * Detail lists in the operator panel are explicitly bounded; headline totals
 * use the exact count returned alongside so they never depend on row-array
 * length (PostgREST caps each response at max_rows).
 */
export const OPERATOR_CLINIC_LIST_LIMIT = 500;

/**
 * Operator-panel clinic directory. `clinics` RLS is intentionally
 * clinic-members-only, so the platform-admin panel reads tenant *metadata*
 * (never clinical tables) through this reviewed helper. Callers must have
 * passed requirePlatformAdmin() first. Returns an exact total count plus the
 * newest OPERATOR_CLINIC_LIST_LIMIT rows.
 */
export async function listOperatorClinics(filters: { search?: string; country?: string } = {}) {
  let query = createAdminClient()
    .from("clinics")
    .select("id, name, phone, country, locale, timezone, onboarding_completed_at, created_at", {
      count: "exact",
    });

  if (filters.search) query = query.ilike("name", `%${filters.search}%`);
  if (filters.country) query = query.eq("country", filters.country);

  return query.order("created_at", { ascending: false }).limit(OPERATOR_CLINIC_LIST_LIMIT);
}

/** Reviewed metadata-only read for executive growth and registry reports. */
export async function listOperatorClinicMetadata() {
  return createAdminClient().from("clinics").select("id, name, country, created_at").order("created_at", { ascending: false }).limit(1000);
}

type OperatorClinicReportInput = {
  country?: string;
  onboarding?: "complete" | "incomplete";
  createdFrom?: string;
  createdToExclusive?: string;
  sort: "name" | "country" | "created_at";
  ascending: boolean;
  from: number;
  to: number;
  count?: boolean;
};

/**
 * Reviewed metadata-only WS7 query. The caller must re-guard with
 * requirePlatformAdmin(); this helper exists because clinic RLS deliberately
 * grants platform admins no direct tenant-row access.
 */
export async function queryOperatorClinicReport(input: OperatorClinicReportInput) {
  let query = createAdminClient()
    .from("clinics")
    .select("id, name, country, onboarding_completed_at, created_at", {
      count: input.count === false ? undefined : "exact",
    });
  if (input.country) query = query.eq("country", input.country);
  if (input.onboarding === "complete") {
    query = query.not("onboarding_completed_at", "is", null);
  } else if (input.onboarding === "incomplete") {
    query = query.is("onboarding_completed_at", null);
  }
  if (input.createdFrom) query = query.gte("created_at", input.createdFrom);
  if (input.createdToExclusive) query = query.lt("created_at", input.createdToExclusive);
  return query
    .order(input.sort, { ascending: input.ascending })
    .range(input.from, input.to);
}

export async function countAllOperatorClinics() {
  return createAdminClient().from("clinics").select("id", { count: "exact", head: true });
}

const OPERATOR_REPORT_SOURCE_CHUNK = 1_000;

async function collectOperatorRows<Row>(
  limit: number,
  load: (from: number, to: number) => PromiseLike<{
    data: Row[] | null;
    error: { message: string } | null;
    count: number | null;
  }>,
): Promise<
  | { data: Row[]; count: number; truncated: boolean; error: null }
  | { data: null; count: number; truncated: false; error: { message: string } }
> {
  const rows: Row[] = [];
  let exactCount = 0;
  for (let from = 0; from < limit; from += OPERATOR_REPORT_SOURCE_CHUNK) {
    const to = Math.min(limit, from + OPERATOR_REPORT_SOURCE_CHUNK) - 1;
    const result = await load(from, to);
    if (result.error) {
      return { data: null, count: 0, truncated: false, error: result.error };
    }
    if (from === 0) exactCount = result.count ?? result.data?.length ?? 0;
    rows.push(...(result.data ?? []));
    if ((result.data?.length ?? 0) < to - from + 1) break;
  }
  return {
    data: rows,
    count: exactCount,
    truncated: exactCount > rows.length,
    error: null,
  };
}

/**
 * Bounded aggregate inputs for the Users report. PostgREST aggregates are
 * disabled in the local/production-compatible configuration (PGRST123), so
 * this keeps the existing no-PHI shape while refusing an unbounded profile
 * materialization. Only clinic ids/names and profile clinic/timestamps cross
 * this boundary.
 */
export async function loadOperatorUserAggregateSource(input: {
  clinicId?: string;
  limit: number;
}) {
  const db = createAdminClient();
  const clinics = await collectOperatorRows(input.limit, (from, to) => {
    let query = db
      .from("clinics")
      .select("id, name", { count: "exact" })
      .order("name", { ascending: true });
    if (input.clinicId) query = query.eq("id", input.clinicId);
    return query.range(from, to);
  });
  if (clinics.error) return { data: null, error: clinics.error };

  const profiles = await collectOperatorRows(input.limit, (from, to) => {
    let query = db
      .from("profiles")
      .select("clinic_id, created_at", { count: "exact" })
      .order("created_at", { ascending: false });
    if (input.clinicId) query = query.eq("clinic_id", input.clinicId);
    return query.range(from, to);
  });
  if (profiles.error) return { data: null, error: profiles.error };

  return {
    data: {
      clinics: clinics.data,
      profiles: profiles.data,
      truncated: clinics.truncated || profiles.truncated,
    },
    error: null,
  };
}

/** Bounded clinic timestamps used only to derive month-level Growth rows. */
export async function loadOperatorGrowthSource(input: {
  createdFrom?: string;
  createdToExclusive?: string;
  limit: number;
}) {
  const db = createAdminClient();
  return collectOperatorRows(input.limit, (from, to) => {
    let query = db
      .from("clinics")
      .select("created_at", { count: "exact" })
      .order("created_at", { ascending: true });
    if (input.createdFrom) query = query.gte("created_at", input.createdFrom);
    if (input.createdToExclusive) query = query.lt("created_at", input.createdToExclusive);
    return query.range(from, to);
  });
}

/** Content-free P4.5C usage/cost aggregate for an already-authorized operator path. */
export async function loadOperatorAiUsageReport(input: {
  periodFrom: string;
  periodTo: string;
  clinicId?: string;
}) {
  return createAdminClient().rpc("operator_ai_usage_report", {
    p_period_from: input.periodFrom,
    p_period_to: input.periodTo,
    p_clinic_id: input.clinicId ?? undefined,
  });
}

/**
 * Provider operations projection. The selected columns intentionally exclude
 * credential ciphertext, key version, fingerprint, actor ids, and audit data.
 */
export async function loadOperatorAiProviderHealthSource() {
  const db = createAdminClient();
  const [clinics, subscriptions, policies, connections, terms, overrides] = await Promise.all([
    db.from("clinics").select("id, name").order("name"),
    db
      .from("subscriptions")
      .select(
        "clinic_id, status, trial_ends_at, current_period_end, plans(is_active, features)",
      ),
    db
      .from("ai_clinic_provider_policies")
      .select("clinic_id, credential_mode, updated_at"),
    db
      .from("ai_provider_connections")
      .select("clinic_id, provider, health_status, last_error_code, tested_at, rotated_at")
      .eq("lifecycle_status", "active"),
    db.from("ai_commercial_terms").select("clinic_id, accepted_at"),
    db
      .from("clinic_feature_overrides")
      .select("clinic_id, enabled")
      .eq("feature_key", "ai_assistant"),
  ]);
  const error = clinics.error
    ?? subscriptions.error
    ?? policies.error
    ?? connections.error
    ?? terms.error
    ?? overrides.error;
  if (error) return { data: null, error };
  const policyByClinic = new Map((policies.data ?? []).map((row) => [row.clinic_id, row]));
  const connectionByClinic = new Map((connections.data ?? []).map((row) => [row.clinic_id, row]));
  const acceptedTermsClinics = new Set(
    (terms.data ?? [])
      .filter((row) => row.accepted_at != null)
      .map((row) => row.clinic_id),
  );
  const umbrellaOverrideByClinic = new Map(
    (overrides.data ?? []).map((row) => [row.clinic_id, row.enabled]),
  );
  const entitledClinicIds = new Set(
    (subscriptions.data ?? [])
      .filter((subscription) => {
        const planFeatures = subscription.plans?.features;
        const planUmbrella = Boolean(planFeatures
          && typeof planFeatures === "object"
          && !Array.isArray(planFeatures)
          && planFeatures.ai_assistant === true);
        return subscription.plans?.is_active === true
          && resolveEffectiveAiFeature({
            subscriptionAllowed: resolveSubscriptionAccess(subscription).allowed,
            termsAccepted: acceptedTermsClinics.has(subscription.clinic_id),
            features: {
              ai_assistant:
                umbrellaOverrideByClinic.get(subscription.clinic_id) ?? planUmbrella,
            },
            featureKey: "ai_assistant",
          });
      })
      .map((subscription) => subscription.clinic_id),
  );
  return {
    data: (clinics.data ?? [])
      .filter(
        (clinic) =>
          entitledClinicIds.has(clinic.id) ||
          policyByClinic.has(clinic.id) ||
          connectionByClinic.has(clinic.id),
      )
      .map((clinic) => {
        const policy = policyByClinic.get(clinic.id);
        const connection = connectionByClinic.get(clinic.id);
        return {
          clinic_id: clinic.id,
          clinic_name: clinic.name,
          credential_mode: policy?.credential_mode ?? "managed",
          provider: connection?.provider ?? null,
          health_status: connection?.health_status ?? null,
          last_error_code: connection?.last_error_code ?? null,
          tested_at: connection?.tested_at ?? null,
          rotated_at: connection?.rotated_at ?? null,
          policy_updated_at: policy?.updated_at ?? null,
        };
      }),
    error: null,
  };
}

/**
 * P6B content-free messaging cost source. Reads only aggregate-safe columns
 * from `usage_counters` (billed WA/email counts) and `outbound_messages`
 * (cost_micro, status, channel — never `body_preview`, recipient, or provider
 * ids) for an already-authorized operator path. Bounded per source; aggregation
 * happens in the report registry via `aggregateMessagingCost`.
 */
export async function loadOperatorMessagingCostSource(input: {
  periodFromMonth: string; // YYYY-MM (inclusive)
  periodToMonth: string; // YYYY-MM (inclusive)
  clinicId?: string;
  limit: number;
}) {
  const db = createAdminClient();
  const periodFromDate = `${input.periodFromMonth}-01`;
  const [year, month] = input.periodToMonth.split("-").map(Number);
  const periodToExclusiveDate = new Date(Date.UTC(year!, month!, 1))
    .toISOString()
    .slice(0, 10);
  const outboundToExclusiveIso = new Date(Date.UTC(year!, month!, 1)).toISOString();

  const clinics = await collectOperatorRows<{ id: string; name: string }>(
    input.limit,
    (from, to) => {
      let query = db
        .from("clinics")
        .select("id, name", { count: "exact" })
        .order("name", { ascending: true });
      if (input.clinicId) query = query.eq("id", input.clinicId);
      return query.range(from, to);
    },
  );
  if (clinics.error) return { data: null, error: clinics.error };

  const counters = await collectOperatorRows<{
    clinic_id: string;
    period_start: string;
    metric: string;
    used: number;
  }>(input.limit, (from, to) => {
    let query = db
      .from("usage_counters")
      .select("clinic_id, period_start, metric, used", { count: "exact" })
      .in("metric", ["wa_messages", "emails"])
      .gte("period_start", periodFromDate)
      .lt("period_start", periodToExclusiveDate)
      .order("period_start", { ascending: false });
    if (input.clinicId) query = query.eq("clinic_id", input.clinicId);
    return query.range(from, to);
  });
  if (counters.error) return { data: null, error: counters.error };

  const outbound = await collectOperatorRows<{
    clinic_id: string;
    channel: string;
    status: string;
    cost_micro: number | null;
    created_at: string;
  }>(input.limit, (from, to) => {
    let query = db
      .from("outbound_messages")
      .select("clinic_id, channel, status, cost_micro, created_at", { count: "exact" })
      .gte("created_at", periodFromDate)
      .lt("created_at", outboundToExclusiveIso)
      .order("created_at", { ascending: false });
    if (input.clinicId) query = query.eq("clinic_id", input.clinicId);
    return query.range(from, to);
  });
  if (outbound.error) return { data: null, error: outbound.error };

  return {
    data: {
      clinics: clinics.data,
      counters: counters.data,
      outbound: outbound.data,
      truncated: clinics.truncated || counters.truncated || outbound.truncated,
    },
    error: null,
  };
}

export async function getOperatorAggregateInputs() {
  const db=createAdminClient(), now=new Date(), nowIso=now.toISOString();
  const monthStart=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),1)).toISOString(), previousStart=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()-1,1)).toISOString(), sixMonthsStart=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()-5,1)).toISOString();
  return Promise.all([
    db.from("subscriptions").select("clinic_id",{count:"exact",head:true}).eq("status","active").or(`current_period_end.is.null,current_period_end.gt.${nowIso}`),
    db.from("subscriptions").select("clinic_id",{count:"exact",head:true}).eq("status","trialing").gt("trial_ends_at",nowIso),
    db.from("clinics").select("id",{count:"exact",head:true}).gte("created_at",monthStart),
    db.from("clinics").select("id",{count:"exact",head:true}).gte("created_at",previousStart).lt("created_at",monthStart),
    db.from("profiles").select("id",{count:"exact",head:true}).gte("created_at",monthStart),
    db.from("profiles").select("id",{count:"exact",head:true}).gte("created_at",previousStart).lt("created_at",monthStart),
    db.from("clinics").select("id, created_at").gte("created_at",sixMonthsStart).order("created_at"),
  ]);
}

export async function listOperatorUserCounts() {
  const db=createAdminClient(); const [clinics,profiles]=await Promise.all([db.from("clinics").select("id, name"),db.from("profiles").select("clinic_id, created_at")]);
  if(clinics.error||profiles.error)return{data:null,error:clinics.error??profiles.error};
  const grouped=new Map<string,{count:number;latest:string|null}>();
  for(const row of profiles.data??[]){const item=grouped.get(row.clinic_id)??{count:0,latest:null};item.count++;if(!item.latest||row.created_at>item.latest)item.latest=row.created_at;grouped.set(row.clinic_id,item)}
  return{data:(clinics.data??[]).map(c=>({clinic_name:c.name,user_count:grouped.get(c.id)?.count??0,latest_signup:grouped.get(c.id)?.latest??null})),error:null};
}

export async function getExactActiveRevenueUsd() {
  const db=createAdminClient(),nowIso=new Date().toISOString();
  const plans=await db.from("plans").select("id, monthly_price_usd");
  if(plans.error)return{data:null,error:plans.error};
  let revenue=0;
  for(const plan of plans.data??[]){const count=await db.from("subscriptions").select("id",{count:"exact",head:true}).eq("plan_id",plan.id).eq("status","active").or(`current_period_end.is.null,current_period_end.gt.${nowIso}`);if(count.error)return{data:null,error:count.error};revenue+=(count.count??0)*Number(plan.monthly_price_usd)}
  return{data:revenue,error:null};
}

/**
 * Single-clinic variant of listOperatorClinics for the operator detail page —
 * same reviewed metadata column list, never clinical tables. Callers must have
 * passed requirePlatformAdmin() first.
 */
export async function getOperatorClinic(clinicId: string) {
  return createAdminClient()
    .from("clinics")
    .select("id, name, phone, country, locale, timezone, onboarding_completed_at, created_at")
    .eq("id", clinicId)
    .maybeSingle();
}

export const OPERATOR_CLINIC_USAGE_PAGE_SIZES = [25, 50, 100] as const;
export const OPERATOR_CLINIC_USAGE_METRICS = [
  "ai_messages",
  "wa_messages",
  "sms_messages",
  "emails",
] as const satisfies readonly Database["public"]["Enums"]["usage_metric"][];

export type OperatorClinicUsageParams = {
  metric: Database["public"]["Enums"]["usage_metric"] | "all";
  page: number;
  pageSize: (typeof OPERATOR_CLINIC_USAGE_PAGE_SIZES)[number];
};

export function parseOperatorClinicUsageParams(input: {
  usageMetric?: string;
  usagePage?: string;
  usagePageSize?: string;
}): OperatorClinicUsageParams {
  const metric = OPERATOR_CLINIC_USAGE_METRICS.includes(
    input.usageMetric as (typeof OPERATOR_CLINIC_USAGE_METRICS)[number],
  )
    ? (input.usageMetric as OperatorClinicUsageParams["metric"])
    : "all";
  const parsedPage = Number.parseInt(input.usagePage ?? "1", 10);
  const parsedPageSize = Number.parseInt(input.usagePageSize ?? "25", 10);
  const pageSize = OPERATOR_CLINIC_USAGE_PAGE_SIZES.includes(
    parsedPageSize as OperatorClinicUsageParams["pageSize"],
  )
    ? (parsedPageSize as OperatorClinicUsageParams["pageSize"])
    : 25;
  return {
    metric,
    page: Number.isSafeInteger(parsedPage) && parsedPage > 0 ? parsedPage : 1,
    pageSize,
  };
}

const SAFE_OPERATOR_CLINIC_AUDIT_ACTIONS = [
  "subscription.granted",
  "subscription.cancelled",
  "feature_override.upserted",
  "feature_override.removed",
  "invitation.issued",
  "invitation.revoked",
  "invitation.email_sent",
  "coupon.redeemed",
  "ai_commercial_terms.updated",
  "subscription.extended",
  "subscription.paused",
  "subscription.reactivated",
  "ai_allowance_override.set",
  "ai_allowance_override.removed",
] as const;
const OPERATOR_CLINIC_AUDIT_SOURCE_LIMIT = 10_000;

function auditPayload(payload: Database["public"]["Tables"]["platform_audit_logs"]["Row"]["payload"]) {
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {};
}

export function safeAuditSummary(row: {
  id: string;
  action: string;
  target_type: string;
  target_id: string | null;
  payload: Database["public"]["Tables"]["platform_audit_logs"]["Row"]["payload"];
  created_at: string;
}) {
  const payload = auditPayload(row.payload);
  switch (row.action) {
    case "subscription.granted": {
      const plan = typeof payload.planSlug === "string" ? payload.planSlug : null;
      const months = typeof payload.months === "number" ? `${payload.months} months` : "unbounded";
      return {
        id: row.id,
        title: "Manual subscription granted or extended",
        detail: [plan ? `Plan: ${plan}` : null, `Duration: ${months}`].filter(Boolean).join(" · "),
        createdAt: row.created_at,
      };
    }
    case "subscription.cancelled":
      return { id: row.id, title: "Manual subscription cancelled", detail: null, createdAt: row.created_at };
    case "feature_override.upserted":
      return {
        id: row.id,
        title: "Feature override changed",
        detail: `${row.target_id ?? "Feature"}: ${payload.enabled === true ? "enabled" : "disabled"}`,
        createdAt: row.created_at,
      };
    case "feature_override.removed":
      return {
        id: row.id,
        title: "Feature override removed",
        detail: row.target_id,
        createdAt: row.created_at,
      };
    case "invitation.issued":
      return {
        id: row.id,
        title: payload.force === true ? "Invitation reissued" : "Invitation issued",
        detail: typeof payload.expiresAt === "string" ? `Expires ${payload.expiresAt}` : null,
        createdAt: row.created_at,
      };
    case "invitation.revoked":
      return { id: row.id, title: "Invitation revoked", detail: null, createdAt: row.created_at };
    case "invitation.email_sent":
      return { id: row.id, title: "Invitation email sent", detail: null, createdAt: row.created_at };
    case "coupon.redeemed":
      return {
        id: row.id,
        title: "Coupon redeemed",
        detail: typeof payload.kind === "string" ? `Kind: ${payload.kind.replaceAll("_", " ")}` : null,
        createdAt: row.created_at,
      };
    case "subscription.extended": {
      const days = typeof payload.days === "number" ? payload.days : null;
      return {
        id: row.id,
        title: "Subscription extended",
        detail: days === null ? null : `Added ${days} days`,
        createdAt: row.created_at,
      };
    }
    case "subscription.paused":
      return { id: row.id, title: "Clinic access paused", detail: null, createdAt: row.created_at };
    case "subscription.reactivated":
      return { id: row.id, title: "Clinic access reactivated", detail: null, createdAt: row.created_at };
    case "ai_allowance_override.set": {
      const micros = typeof payload.includedBudgetMicros === "number" ? payload.includedBudgetMicros : null;
      return {
        id: row.id,
        title: "AI allowance override set",
        detail: micros === null ? null : `Included allowance: $${(micros / 1_000_000).toFixed(2)}`,
        createdAt: row.created_at,
      };
    }
    case "ai_allowance_override.removed":
      return {
        id: row.id,
        title: "AI allowance override removed",
        detail: "Plan default restored",
        createdAt: row.created_at,
      };
    case "ai_commercial_terms.updated": {
      const overageMode = typeof payload.overageMode === "string" ? payload.overageMode : "hard_cap";
      return {
        id: row.id,
        title: "AI commercial terms updated",
        detail: `Policy: ${overageMode.replaceAll("_", " ")}`,
        createdAt: row.created_at,
      };
    }
    default:
      return null;
  }
}

/**
 * Read-only WS8 clinic-history boundary. Every field is clinic metadata,
 * platform commercial data, or a count/limit. Patient and clinical tables are
 * deliberately unreachable from this query path. Audit payloads are converted
 * to an allowlisted summary before leaving this server-only module.
 */
export async function getOperatorClinicHistory(
  clinicId: string,
  usage: OperatorClinicUsageParams,
) {
  await requirePlatformAdmin();
  const db = createAdminClient();

  async function loadUsagePage() {
    let countQuery = db
      .from("usage_counters")
      .select("id", { count: "exact", head: true })
      .eq("clinic_id", clinicId);
    if (usage.metric !== "all") countQuery = countQuery.eq("metric", usage.metric);
    const countResult = await countQuery;
    if (countResult.error) return { data: null, error: countResult.error };

    const total = countResult.count ?? 0;
    const pageCount = Math.max(1, Math.ceil(total / usage.pageSize));
    const page = Math.min(usage.page, pageCount);
    const from = (page - 1) * usage.pageSize;
    let rowsQuery = db
      .from("usage_counters")
      .select("id, period_start, metric, used, limit_snapshot, created_at, updated_at")
      .eq("clinic_id", clinicId);
    if (usage.metric !== "all") rowsQuery = rowsQuery.eq("metric", usage.metric);
    const rows = await rowsQuery
      .order("period_start", { ascending: false })
      .order("metric", { ascending: true })
      .range(from, from + usage.pageSize - 1);
    if (rows.error) return { data: null, error: rows.error };
    return {
      data: {
        rows: rows.data ?? [],
        total,
        page,
        pageSize: usage.pageSize,
        pageCount,
        metric: usage.metric,
      },
      error: null,
    };
  }

  const currentPeriodStart = `${new Date().getUTCFullYear()}-${String(new Date().getUTCMonth() + 1).padStart(2, "0")}-01`;
  const [clinic, subscription, workingHours, invitations, redemptions, overrides, usageRows, plans, aiTerms, aiBudget, effectiveAiAssistant] =
    await Promise.all([
      db
        .from("clinics")
        .select(
          "id, name, country, timezone, locale, currency, created_at, onboarding_completed_at, working_hours_start, working_hours_end",
        )
        .eq("id", clinicId)
        .maybeSingle(),
      db
        .from("subscriptions")
        .select(
          "id, status, trial_ends_at, current_period_start, current_period_end, provider, provider_subscription_id, created_at, updated_at, plans(slug, name_en)",
        )
        .eq("clinic_id", clinicId)
        .maybeSingle(),
      db
        .from("clinic_working_hours")
        .select("id, day_of_week, shift_start, shift_end")
        .eq("clinic_id", clinicId)
        .order("day_of_week")
        .order("shift_start"),
      db
        .from("clinic_invitations")
        .select("id, status, created_at, expires_at, email_sent_at, accepted_at, revoked_at, updated_at")
        .eq("accepted_clinic_id", clinicId)
        .order("created_at", { ascending: false }),
      db
        .from("coupon_redemptions")
        .select("id, redeemed_at, coupon_id, coupons(code, kind, months, percent, expires_at, is_active)")
        .eq("clinic_id", clinicId)
        .order("redeemed_at", { ascending: false }),
      db
        .from("clinic_feature_overrides")
        .select("id, feature_key, enabled, created_at, updated_at")
        .eq("clinic_id", clinicId)
        .order("feature_key"),
      loadUsagePage(),
      db.from("plans").select("slug, name_en").eq("is_active", true).order("slug"),
      db
        .from("ai_commercial_terms")
        .select("included_budget_override_micros, addon_budget_micros, overage_mode, overage_budget_micros, change_reason, accepted_at, updated_at")
        .eq("clinic_id", clinicId)
        .maybeSingle(),
      db
        .from("ai_budget_periods")
        .select("budget_limit_micros, reserved_micros, spent_micros")
        .eq("clinic_id", clinicId)
        .eq("period_start", currentPeriodStart)
        .maybeSingle(),
      db.rpc("effective_ai_feature", {
        p_clinic_id: clinicId,
        p_feature_key: "ai_assistant",
      }),
    ]);

  if (clinic.error) return { data: null, error: clinic.error };
  if (!clinic.data) return { data: null, error: null };
  const firstError = [subscription, workingHours, invitations, redemptions, overrides, usageRows, plans, aiTerms, aiBudget, effectiveAiAssistant]
    .map((result) => result.error)
    .find(Boolean);
  if (firstError) return { data: null, error: firstError };

  const invitationIds = (invitations.data ?? []).map((invitation) => invitation.id);
  const clinicAudit = await collectOperatorRows(OPERATOR_CLINIC_AUDIT_SOURCE_LIMIT, (from, to) =>
    db
      .from("platform_audit_logs")
      .select("id, action, target_type, target_id, payload, created_at", { count: "exact" })
      .eq("clinic_id", clinicId)
      .in("action", [...SAFE_OPERATOR_CLINIC_AUDIT_ACTIONS])
      .order("created_at", { ascending: false })
      .range(from, to),
  );
  if (clinicAudit.error) return { data: null, error: clinicAudit.error };

  const invitationAudit = invitationIds.length > 0
    ? await collectOperatorRows(OPERATOR_CLINIC_AUDIT_SOURCE_LIMIT, (from, to) =>
        db
          .from("platform_audit_logs")
          .select("id, action, target_type, target_id, payload, created_at", { count: "exact" })
          .eq("target_type", "clinic_invitation")
          .in("target_id", invitationIds)
          .in("action", ["invitation.issued", "invitation.revoked", "invitation.email_sent"])
          .order("created_at", { ascending: false })
          .range(from, to),
      )
    : { data: [], count: 0, truncated: false, error: null };
  if (invitationAudit.error) return { data: null, error: invitationAudit.error };

  const safeAudit = new Map<string, NonNullable<ReturnType<typeof safeAuditSummary>>>();
  for (const row of [...clinicAudit.data, ...invitationAudit.data]) {
    const event = safeAuditSummary(row);
    if (event) safeAudit.set(event.id, event);
  }

  return {
    data: {
      clinic: clinic.data,
      subscription: subscription.data,
      workingHours: workingHours.data ?? [],
      invitations: invitations.data ?? [],
      redemptions: redemptions.data ?? [],
      overrides: overrides.data ?? [],
      usage: usageRows.data!,
      plans: plans.data ?? [],
      aiTerms: aiTerms.data,
      aiBudget: aiBudget.data,
      effectiveAiAssistant: effectiveAiAssistant.data === true,
      auditEvents: [...safeAudit.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      auditTruncated: clinicAudit.truncated || invitationAudit.truncated,
    },
    error: null,
  };
}

// Safety bound for the Auth-user scan below: 500 pages × 100 users. The scan
// walks every page until the API reports a short (final) page; the bound only
// exists to keep a pathological directory from hanging the panel, and hitting
// it is surfaced as `truncated: true`, which Mission Control renders as an
// explicit warning instead of silently narrowing the orphan list.
const ORPHAN_SCAN_PER_PAGE = 100;
const ORPHAN_SCAN_MAX_PAGES = 500;

/**
 * Operational backstop for the P1C signup compensation path: Auth users that
 * carry the clinic-owner signup marker but never received a profile.
 */
export async function listOrphanedSignupUsers(): Promise<
  | { data: { orphans: Array<{ id: string; email: string | null; created_at: string }>; truncated: boolean }; error: null }
  | { data: null; error: { message: string } }
> {
  const admin = createAdminClient();
  const orphans: Array<{ id: string; email: string | null; created_at: string }> = [];
  let truncated = true;
  for (let page = 1; page <= ORPHAN_SCAN_MAX_PAGES; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: ORPHAN_SCAN_PER_PAGE });
    if (error) return { data: null, error };
    const marked = data.users.filter(
      (user) => user.user_metadata?.signup_flow === "clinic_owner",
    );
    if (marked.length > 0) {
      const profiles = await admin
        .from("profiles")
        .select("id")
        .in("id", marked.map((user) => user.id));
      if (profiles.error) return { data: null, error: profiles.error };
      const withProfile = new Set((profiles.data ?? []).map((row) => row.id));
      for (const user of marked) {
        if (!withProfile.has(user.id)) {
          orphans.push({ id: user.id, email: user.email ?? null, created_at: user.created_at });
        }
      }
    }
    if (data.users.length < ORPHAN_SCAN_PER_PAGE) {
      truncated = false;
      break;
    }
  }
  return { data: { orphans, truncated }, error: null };
}

const CLINIC_SCOPED_TABLES = new Set([
  "ai_suggested_replies",
  // P11Q: both carry clinic_id and are written only through the bulk-send
  // server path, so the scoped client's automatic clinic filter is the correct
  // and sufficient boundary for them.
  "bulk_message_jobs",
  "bulk_message_recipients",
  "ai_usage_events",
  "ai_workflow_runs",
  "ai_budget_periods",
  "ai_clinic_provider_policies",
  "ai_commercial_terms",
  "ai_provider_connections",
  "appointment_services",
  "appointments",
  "audit_logs",
  "clinic_channels",
  "clinic_faq",
  "clinic_working_hours",
  "clinic_feature_overrides",
  "conversations",
  "coupon_redemptions",
  "departments",
  "doctor_schedules",
  "document_drafts",
  "follow_ups",
  "followup_sequences",
  "inbound_messages",
  "insurance_providers",
  "medical_note_attachments",
  "message_template_provider_bindings",
  "message_templates",
  "notifications",
  "outbound_messages",
  "outstanding_settlements",
  "package_templates",
  "patient_deposits",
  "patient_documents",
  "patient_packages",
  "patients",
  "profiles",
  "services",
  "staff_invitations",
  "staff_shift_templates",
  "subscriptions",
  "usage_counters",
  "user_ai_permissions",
  "user_customizations",
  "user_page_permissions",
  "user_report_permissions",
  // P7E: the linked-device pairing. The worker owns the happy path; the app
  // reads the status projection and, when the worker is unreachable, still has
  // to be able to tear its own clinic's pairing down.
  "whatsapp_linked_device_auth",
  "whatsapp_linked_device_sessions",
  // The durable per-clinic ledger of WhatsApp accounts this clinic has proved.
  // Read (never written) here by `resolveWhatsAppAccountBoundary`, which needs
  // the boundary to survive a disconnect that has already removed the channel
  // row and rebuilt the session row. `clinic_id` scopes it like every other
  // entry above; the worker remains the only writer.
  "whatsapp_linked_accounts",
  // P8B §5: prepared and sent outbound files. Written by the reviewed inbox
  // actions on this client — the MIME sniff, the size cap and the document
  // authorization all run there — and never by a browser: the table has no
  // authenticated write policy at all.
  "outbound_message_media",
  // P8: files a patient sent on WhatsApp. Written by the verified linked-device
  // callback and read by the Inbox, both strictly within one clinic.
  "inbound_message_attachments",
  // P8C: verified linked-device callbacks hold unresolved history here until a
  // WhatsApp-asserted LID mapping arrives. No authenticated client can write or
  // read these service-only rows.
  "whatsapp_lid_mappings",
  "whatsapp_pending_history_chats",
  "whatsapp_pending_history_messages",
]);

// These tables may be read through the tenant-scoped service client, but their
// writes must retain their narrower boundary: Assistant placement writes use
// the authenticated primary admin's JWT, supervision writes use the atomic
// replacement RPC, and activity events remain append-only.
const READ_ONLY_CLINIC_SCOPED_TABLES = new Set([
  "ai_action_receipts",
  "activity_events",
  "assistant_doctor_assignments",
  "assistant_launcher_settings",
  "assistant_launcher_user_overrides",
  "document_events",
  "document_settings",
  "documents",
  // P8B §3: the linked device's observed contact directory. Read-only here —
  // the only writer is the verified worker callback, through
  // `upsert_whatsapp_contacts`. Staff pick from it; nothing here edits it.
  "whatsapp_contacts",
  // P9C: the staged intake this conversation is working on. Read-only, and
  // deliberately so — every write to it goes through
  // `stage_patient_intake_from_conversation`, which is where the identity rules
  // live. The read exists to answer one question the booking path cannot answer
  // any other way: is this appointment for the sender, or for the person they
  // staged? Getting that wrong files an appointment under the wrong patient, so
  // it is read from the row rather than inferred. Without the allow-list entry
  // `assertKnownTable` throws, and a throw on the booking path is exactly the
  // bare technical error this whole change exists to remove.
  "ai_patient_intakes",
  // Doctor leave and blocked ranges. `computeAvailability` is shared by the
  // staff appointment form (an RLS client) and by the WhatsApp patient booking
  // path (this client), and the second one could not read the table at all:
  // every patient availability call threw "unclassified table" out of
  // `assertKnownTable` and reached the patient as a bare technical error.
  // Read-only is the correct boundary — leave is created and edited by staff
  // through their own authenticated client, never by the assistant.
  "doctor_unavailability",
]);

const JOIN_SCOPED_TABLES = new Set([
  "feedback",
  "medical_notes",
]);

// These tables mix global and tenant-assigned rows. Callers must apply the
// reviewed assignment predicate explicitly; automatic clinic_id injection
// would make global and invitation-assigned rows unreachable.
const EXPLICIT_SCOPE_TABLES = new Set([
  "coupons",
]);

const INSERT_METHODS = new Set(["insert", "upsert"]);
const SCOPED_METHODS = new Set(["select", "update", "delete"]);
const BLOCKED_METHODS = new Set(["rpc", "schema"]);

type AdminClient = ReturnType<typeof createAdminClient>;

function assertKnownTable(table: string) {
  if (
    CLINIC_SCOPED_TABLES.has(table)
    || READ_ONLY_CLINIC_SCOPED_TABLES.has(table)
    || JOIN_SCOPED_TABLES.has(table)
    || EXPLICIT_SCOPE_TABLES.has(table)
  ) {
    return;
  }

  throw new Error(
    `createClinicScopedAdminClient cannot access unclassified table "${table}". Add it to a reviewed scope allow-list first.`,
  );
}

function assertNoMismatchedClinicId(payload: unknown, clinicId: string): void {
  if (Array.isArray(payload)) {
    payload.forEach((row) => assertNoMismatchedClinicId(row, clinicId));
    return;
  }

  if (payload && typeof payload === "object") {
    const row = payload as Record<string, unknown>;
    if (
      row.clinic_id !== undefined &&
      row.clinic_id !== null &&
      row.clinic_id !== clinicId
    ) {
      throw new Error("Clinic-scoped admin write attempted with a different clinic_id.");
    }
  }
}

function withClinicId(payload: unknown, clinicId: string): unknown {
  assertNoMismatchedClinicId(payload, clinicId);

  if (Array.isArray(payload)) {
    return payload.map((row) => withClinicId(row, clinicId));
  }

  if (payload && typeof payload === "object") {
    return { ...(payload as Record<string, unknown>), clinic_id: clinicId };
  }

  return payload;
}

function scopeQueryResult(result: unknown, table: string, clinicId: string) {
  if (
    !CLINIC_SCOPED_TABLES.has(table)
    && !READ_ONLY_CLINIC_SCOPED_TABLES.has(table)
  ) return result;

  if (result && typeof result === "object" && "eq" in result) {
    return (result as { eq: (column: string, value: string) => unknown }).eq(
      "clinic_id",
      clinicId,
    );
  }

  return result;
}

/**
 * Service-role client with tenant scoping guardrails for data-table access.
 * Auth admin APIs remain available, but table reads/writes for tenant tables are
 * automatically constrained to the provided clinic id. Tables without their own
 * clinic_id must be explicitly allow-listed as join-scoped and verified by the
 * caller before mutation. Tables with global-or-assigned rows are explicitly
 * scoped by each caller. RPC, schema, and storage access are intentionally not
 * exposed through this wrapper.
 */
export function createClinicScopedAdminClient(clinicId: string): AdminClient {
  const adminClient = createAdminClient();

  return new Proxy(adminClient, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && BLOCKED_METHODS.has(prop)) {
        throw new Error(
          `${prop}() is not available on createClinicScopedAdminClient; use an RLS client or an explicitly reviewed admin path.`,
        );
      }
      if (prop === "storage") {
        throw new Error(
          "storage is not available on createClinicScopedAdminClient; use an RLS client or an explicitly reviewed admin path.",
        );
      }
      if (prop !== "from") {
        return Reflect.get(target, prop, receiver);
      }

      return (table: string) => {
        assertKnownTable(table);
        const builder = target.from(
          table as Parameters<AdminClient["from"]>[0],
        );

        return new Proxy(builder, {
          get(builderTarget, builderProp, builderReceiver) {
            const value = Reflect.get(
              builderTarget,
              builderProp,
              builderReceiver,
            );

            if (typeof builderProp !== "string" || typeof value !== "function") {
              return value;
            }

            if (
              READ_ONLY_CLINIC_SCOPED_TABLES.has(table)
              && (INSERT_METHODS.has(builderProp)
                || builderProp === "update"
                || builderProp === "delete")
            ) {
              return () => {
                throw new Error(
                  `createClinicScopedAdminClient provides read-only access to "${table}"; use an authenticated RLS client for placement mutations.`,
                );
              };
            }

            if (INSERT_METHODS.has(builderProp)) {
              return (payload: unknown, ...args: unknown[]) =>
                value.apply(builderTarget, [
                  CLINIC_SCOPED_TABLES.has(table)
                    ? withClinicId(payload, clinicId)
                    : payload,
                  ...args,
                ]);
            }

            if (builderProp === "update") {
              return (payload: unknown, ...args: unknown[]) => {
                if (CLINIC_SCOPED_TABLES.has(table)) {
                  assertNoMismatchedClinicId(payload, clinicId);
                }
                return scopeQueryResult(
                  value.apply(builderTarget, args.length ? [payload, ...args] : [payload]),
                  table,
                  clinicId,
                );
              };
            }

            if (SCOPED_METHODS.has(builderProp)) {
              return (...args: unknown[]) => {
                return scopeQueryResult(
                  value.apply(builderTarget, args),
                  table,
                  clinicId,
                );
              };
            }

            return value.bind(builderTarget);
          },
        });
      };
    },
  });
}

/**
 * Aggregate-only operational counts for one clinic, for the owner clinic page.
 *
 * Platform-admin authorization is re-checked here and the query layer is
 * `lib/analytics/clinic-metrics`, whose every query is a `head: true` count —
 * so this boundary returns numbers and cannot return a patient, appointment,
 * document, invoice, or message row even if a future caller asks it to.
 */
export async function getOperatorClinicMetrics(clinicId: string, now = new Date()) {
  await requirePlatformAdmin();
  const { getClinicMetrics } = await import("@/lib/analytics/clinic-metrics");
  return getClinicMetrics(createAdminClient(), clinicId, now);
}

/**
 * Reviewed source rows for the owner AI-allowance console fallback.
 *
 * This exists because `createAdminClient` is deliberately restricted to this
 * module: the fallback needs a cross-clinic read of plan, commercial-terms and
 * monthly-aggregate rows, which is exactly the sort of query that has to be
 * reviewed here rather than assembled in a feature module.
 *
 * Every column below is a plan limit, an operator-entered commercial figure, a
 * monthly aggregate, or a provider-mode flag. No patient, appointment, message,
 * document, credential ciphertext, fingerprint, or actor identity is selected.
 * `requirePlatformAdmin()` is re-checked here; the caller has already checked it
 * and the RPC checks it again inside the database.
 */
export async function loadOperatorAiAllowanceFallbackSources(input: {
  periodStart: string;
  clinicId?: string;
}) {
  await requirePlatformAdmin();
  const db = createAdminClient();

  let subscriptionQuery = db
    .from("subscriptions")
    .select("clinic_id, clinics(name), plans(slug, features, limits)");
  if (input.clinicId) subscriptionQuery = subscriptionQuery.eq("clinic_id", input.clinicId);
  const subscriptions = await subscriptionQuery;
  if (subscriptions.error) throw subscriptions.error;

  const clinicIds = (subscriptions.data ?? []).map((row) => row.clinic_id);
  if (clinicIds.length === 0) {
    return {
      subscriptions: subscriptions.data ?? [],
      terms: [],
      periods: [],
      counters: [],
      policies: [],
      byokClinicIds: [] as string[],
      byokSpend: [] as { clinic_id: string; byok_spent_micros: number | null }[],
      autoFallback: [] as { clinic_id: string; auto_byok_fallback_enabled: boolean | null }[],
    };
  }

  const [terms, periods, counters, policies, connections] = await Promise.all([
    db
      .from("ai_commercial_terms")
      .select("clinic_id, included_budget_override_micros, addon_budget_micros, overage_mode, overage_budget_micros")
      .in("clinic_id", clinicIds),
    db
      .from("ai_budget_periods")
      .select("clinic_id, spent_micros, reserved_micros")
      .in("clinic_id", clinicIds)
      .eq("period_start", input.periodStart),
    db
      .from("usage_counters")
      .select("clinic_id, used, limit_snapshot")
      .in("clinic_id", clinicIds)
      .eq("period_start", input.periodStart)
      .eq("metric", "ai_messages"),
    db.from("ai_clinic_provider_policies").select("clinic_id, credential_mode").in("clinic_id", clinicIds),
    db
      .from("ai_provider_connections")
      .select("clinic_id")
      .in("clinic_id", clinicIds)
      .eq("lifecycle_status", "active")
      .eq("health_status", "valid"),
  ]);
  for (const result of [terms, periods, counters, policies, connections]) {
    if (result.error) throw result.error;
  }

  // These two columns ship in the same migration as the RPC the fallback stands
  // in for, so they may not exist here. Read them opportunistically and let the
  // caller apply the documented defaults rather than failing the whole report.
  const [byokSpend, autoFallback] = await Promise.all([
    db
      .from("ai_budget_periods")
      .select("clinic_id, byok_spent_micros")
      .in("clinic_id", clinicIds)
      .eq("period_start", input.periodStart),
    db
      .from("ai_clinic_provider_policies")
      .select("clinic_id, auto_byok_fallback_enabled")
      .in("clinic_id", clinicIds),
  ]);

  return {
    subscriptions: subscriptions.data ?? [],
    terms: terms.data ?? [],
    periods: periods.data ?? [],
    counters: counters.data ?? [],
    policies: policies.data ?? [],
    byokClinicIds: (connections.data ?? []).map((row) => row.clinic_id),
    byokSpend: byokSpend.error ? [] : byokSpend.data ?? [],
    autoFallback: autoFallback.error ? [] : autoFallback.data ?? [],
  };
}

/**
 * P15 — the per-conversation exception to the clinic-wide AI setting.
 *
 * `override` is a tri-state on purpose: `null` puts the thread back under the
 * clinic setting, which is a different decision from "never here" and must not
 * collapse into it. Decided inside the RPC under a row lock, so two staff
 * members clicking at once produce one transition.
 */
export async function setConversationAiOverride(input: {
  clinicId: string;
  conversationId: string;
  override: boolean | null;
  actorId: string;
}) {
  return createAdminClient().rpc("set_conversation_ai_override", {
    p_clinic_id: input.clinicId,
    p_conversation_id: input.conversationId,
    p_override: input.override as boolean,
    p_actor_id: input.actorId,
  });
}

/**
 * P15 (§2F) — record that the assistant hit a genuine technical fault on a
 * live turn, and end the episode.
 *
 * Returns `latched: true` only for the call that actually recorded the fault.
 * That return value is the whole idempotency mechanism for the patient-facing
 * fallback message: the caller sends the one apology when and only when it is
 * told it latched, so retries cannot apologise twice.
 */
export async function latchConversationAiTechnicalFailure(input: {
  clinicId: string;
  conversationId: string;
  reason: "provider_failure" | "orchestration_failure" | "backend_failure" | "send_failure";
}) {
  return createAdminClient().rpc("latch_conversation_ai_technical_failure", {
    p_clinic_id: input.clinicId,
    p_conversation_id: input.conversationId,
    p_reason: input.reason,
  });
}

/** P15 — clear the technical-failure latch so the Problem badge self-heals. */
export async function clearConversationAiTechnicalFailure(input: {
  clinicId: string;
  conversationId: string;
}) {
  return createAdminClient().rpc("clear_conversation_ai_technical_failure", {
    p_clinic_id: input.clinicId,
    p_conversation_id: input.conversationId,
  });
}

/**
 * P15 (§5) — a person at the clinic answered this thread from their own
 * handset, live.
 *
 * Only disarms the assistant's idle close. It deliberately does not pause the
 * AI: one reply is evidence somebody answered, not a declaration that they are
 * taking the thread over, and only a person may make that declaration through
 * the Pause AI control.
 */
export async function markConversationHumanReply(input: {
  clinicId: string;
  conversationId: string;
  occurredAt: string;
}) {
  return createAdminClient().rpc("mark_conversation_human_reply", {
    p_clinic_id: input.clinicId,
    p_conversation_id: input.conversationId,
    p_occurred_at: input.occurredAt,
  });
}

// ---------------------------------------------------------------------------
// V2 patient assistant
//
// The RPC wrappers for the new engine live here with every other one, so
// "which functions does the service role call?" keeps a single answer and the
// tenant-scoping rule has a single place to be enforced.
//
// The `as never` casts below exist because `types/database.ts` is generated
// from the *applied* schema and the migration these belong to is authored but
// deliberately not applied. `flowStateAvailable` proves the objects exist
// before any of them is used, and regenerating the types after the migration
// is applied removes every cast.
// ---------------------------------------------------------------------------

type UnappliedRpc = (
  name: string,
  args: Record<string, unknown>,
) => PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;

function unappliedRpc(): UnappliedRpc {
  return createAdminClient().rpc as unknown as UnappliedRpc;
}

/** Replaces the V2 flow stack under a row lock. See `lib/ai/v2/store.ts`. */
export async function setConversationFlowState(input: {
  clinicId: string;
  conversationId: string;
  flowState: Record<string, unknown> | null;
}) {
  return unappliedRpc()("set_conversation_flow_state", {
    p_clinic_id: input.clinicId,
    p_conversation_id: input.conversationId,
    p_flow_state: input.flowState,
  });
}

/** Clears the V2 flow stack at an episode boundary. */
export async function resetConversationFlowState(input: {
  clinicId: string;
  conversationId: string;
}) {
  return unappliedRpc()("reset_conversation_flow_state", {
    p_clinic_id: input.clinicId,
    p_conversation_id: input.conversationId,
  });
}

/** The clinic's package offering, as a member of the public may ask about it. */
export async function listClinicPublicPackages(input: {
  clinicId: string;
  departmentId?: string | null;
}) {
  return unappliedRpc()("list_clinic_public_packages", {
    p_clinic_id: input.clinicId,
    p_department_id: input.departmentId ?? null,
  });
}

/**
 * One patient's usable packages, resolved from the conversation's own linkage.
 * Takes no patient id, so no caller can ask for somebody else's.
 */
export async function listPatientAiPackages(input: {
  clinicId: string;
  conversationId: string;
  departmentId?: string | null;
  serviceId?: string | null;
}) {
  return unappliedRpc()("list_patient_ai_packages", {
    p_clinic_id: input.clinicId,
    p_conversation_id: input.conversationId,
    p_department_id: input.departmentId ?? null,
    p_service_id: input.serviceId ?? null,
  });
}

/**
 * Documents already issued to this conversation's patient.
 *
 * Retrieval only: the function selects `status = 'issued'` rows with a
 * non-null issuer, and there is no companion that creates one.
 */
export async function listPatientAiDocuments(input: {
  clinicId: string;
  conversationId: string;
  docType?: string | null;
  limit?: number;
}) {
  return unappliedRpc()("list_patient_ai_documents", {
    p_clinic_id: input.clinicId,
    p_conversation_id: input.conversationId,
    p_doc_type: input.docType ?? null,
    p_limit: input.limit ?? 10,
  });
}

/** A short-lived signed URL for one issued document's stored PDF. */
export async function signClinicDocumentUrl(input: {
  storagePath: string;
  expiresInSeconds?: number;
}) {
  return createAdminClient()
    .storage.from("documents")
    .createSignedUrl(input.storagePath, input.expiresInSeconds ?? 15 * 60);
}

/** `create_patient_preliminary_booking`, with an optional package session. */
export async function createPatientPreliminaryBookingWithPackage(input: {
  clinicId: string;
  conversationId: string;
  doctorId: string;
  scheduledAt: string;
  durationMinutes: number;
  serviceId?: string | null;
  packageId: string;
}) {
  return unappliedRpc()("create_patient_preliminary_booking_v2", {
    p_clinic_id: input.clinicId,
    p_conversation_id: input.conversationId,
    p_doctor_id: input.doctorId,
    p_scheduled_at: input.scheduledAt,
    p_duration_minutes: input.durationMinutes,
    p_service_id: input.serviceId ?? null,
    p_package_id: input.packageId,
  });
}

/** Probes whether the V2 flow-state column exists. Tenant-scoped. */
export async function probeConversationFlowStateColumn(clinicId: string) {
  return (
    createClinicScopedAdminClient(clinicId).from("conversations") as unknown as {
      select: (columns: string) => {
        limit: (n: number) => PromiseLike<{ error: { code?: string } | null }>;
      };
    }
  )
    .select("ai_flow_state")
    .limit(1);
}

/** Reads one conversation's V2 flow stack. Tenant-scoped. */
export async function getConversationFlowState(input: {
  clinicId: string;
  conversationId: string;
}) {
  return (
    createClinicScopedAdminClient(input.clinicId).from(
      "conversations",
    ) as unknown as {
      select: (columns: string) => {
        eq: (
          column: string,
          value: string,
        ) => {
          maybeSingle: () => PromiseLike<{
            data: { ai_flow_state: unknown } | null;
            error: unknown;
          }>;
        };
      };
    }
  )
    .select("ai_flow_state")
    .eq("id", input.conversationId)
    .maybeSingle();
}
