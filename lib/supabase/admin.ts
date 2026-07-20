import "server-only";
import { createClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/types/database";
import type { FxSnapshot } from "@/lib/currency/provider";
import { requirePlatformAdmin } from "@/lib/rbac";

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

/** Atomic webhook boundary: one inbound event creates/repairs one sender thread. */
export async function persistWhatsAppInbound(input: {
  clinicId: string;
  sender: string;
  body: string;
  providerMessageId: string;
  receivedAt: string;
}) {
  return createAdminClient().rpc("persist_whatsapp_inbound", {
    p_clinic_id: input.clinicId,
    p_sender: input.sender,
    p_body: input.body,
    p_provider_message_id: input.providerMessageId,
    p_received_at: input.receivedAt,
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
    .eq("status", "active")
    .maybeSingle();
}

/** Preflight for provider configuration so a tenant cannot claim another channel's identity. */
export async function findClinicChannelIdentityOwner(
  provider: Database["public"]["Enums"]["messaging_provider"],
  senderIdentity: string,
) {
  return createAdminClient()
    .from("clinic_channels")
    .select("id, clinic_id")
    .eq("provider", provider)
    .eq("sender_identity", senderIdentity)
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
  const [clinics, subscriptions, policies, connections] = await Promise.all([
    db.from("clinics").select("id, name").order("name"),
    db.from("subscriptions").select("clinic_id, plans(slug)"),
    db
      .from("ai_clinic_provider_policies")
      .select("clinic_id, credential_mode, updated_at"),
    db
      .from("ai_provider_connections")
      .select("clinic_id, provider, health_status, last_error_code, tested_at, rotated_at")
      .eq("lifecycle_status", "active"),
  ]);
  const error = clinics.error ?? subscriptions.error ?? policies.error ?? connections.error;
  if (error) return { data: null, error };
  const policyByClinic = new Map((policies.data ?? []).map((row) => [row.clinic_id, row]));
  const connectionByClinic = new Map((connections.data ?? []).map((row) => [row.clinic_id, row]));
  const proAiClinicIds = new Set(
    (subscriptions.data ?? [])
      .filter((subscription) => subscription.plans?.slug === "pro_ai")
      .map((subscription) => subscription.clinic_id),
  );
  return {
    data: (clinics.data ?? [])
      .filter(
        (clinic) =>
          proAiClinicIds.has(clinic.id) ||
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
  const [clinic, subscription, workingHours, invitations, redemptions, overrides, usageRows, plans, aiTerms, aiBudget] =
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
        .select("included_budget_override_micros, addon_budget_micros, overage_mode, overage_budget_micros, change_reason, updated_at")
        .eq("clinic_id", clinicId)
        .maybeSingle(),
      db
        .from("ai_budget_periods")
        .select("budget_limit_micros, reserved_micros, spent_micros")
        .eq("clinic_id", clinicId)
        .eq("period_start", currentPeriodStart)
        .maybeSingle(),
    ]);

  if (clinic.error) return { data: null, error: clinic.error };
  if (!clinic.data) return { data: null, error: null };
  const firstError = [subscription, workingHours, invitations, redemptions, overrides, usageRows, plans, aiTerms, aiBudget]
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
  "ai_usage_events",
  "ai_budget_periods",
  "ai_clinic_provider_policies",
  "ai_commercial_terms",
  "ai_provider_connections",
  "appointment_services",
  "appointments",
  "audit_logs",
  "clinic_channels",
  "clinic_working_hours",
  "clinic_feature_overrides",
  "conversations",
  "coupon_redemptions",
  "departments",
  "doctor_schedules",
  "follow_ups",
  "followup_sequences",
  "inbound_messages",
  "insurance_providers",
  "medical_note_attachments",
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
  "subscriptions",
  "usage_counters",
  "user_customizations",
  "user_page_permissions",
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
  if (!CLINIC_SCOPED_TABLES.has(table)) return result;

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
