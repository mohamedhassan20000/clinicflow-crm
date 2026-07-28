import "server-only";
import * as Sentry from "@sentry/nextjs";
import {
  applyMetaChannelState,
  countApprovedTemplates,
  createClinicScopedAdminClient,
  getWhatsAppChannelStateRow,
  listActiveMetaChannels,
} from "@/lib/supabase/admin";
import { decryptChannelCredentials } from "@/lib/messaging/crypto";
import {
  deriveConnectionState,
  type ChannelStateSignals,
  type ConnectionState,
} from "@/lib/messaging/connection-state";
import {
  fetchMetaChannelState,
  fetchMetaTemplates,
  getMetaWabaSubscription,
  subscribeMetaWabaWebhook,
} from "@/lib/messaging/whatsapp-meta";

/**
 * P6C hybrid state refresh (plan line 1311) — the single transition applier shared
 * by the webhook (partial signals) and the reconciliation poll (full Graph
 * snapshot). It is idempotent: the same signals over the same stored row derive the
 * same state and write nothing, so a replayed webhook or a repeated poll produces
 * one state and one audit row, never duplicates. Every connection-state transition
 * writes exactly one clinic-scoped `messaging:connection_state` audit row (plan
 * line 1310) — only when the derived state actually changes.
 */

export type ApplyChannelStateResult = {
  applied: boolean;
  /** True when the *derived connection state* changed (an audit row was written). */
  transitioned: boolean;
  state: ConnectionState | null;
  reason: string | null;
};

const NO_CHANNEL: ApplyChannelStateResult = {
  applied: false,
  transitioned: false,
  state: null,
  reason: null,
};

function pick(incoming: string | null | undefined, stored: string | null): string | null {
  // Only a provided, non-empty signal overwrites what we already knew; a webhook
  // that carries one field must never wipe the others.
  return incoming === undefined || incoming === null ? stored : incoming;
}

function pickOrderedState(
  incoming: string | null | undefined,
  stored: string | null,
  hasProviderTimestamp: boolean,
): string | null {
  const selected = pick(incoming, stored);
  if (selected === stored || hasProviderTimestamp || !stored) return selected;
  const previous = stored.toLowerCase();
  const next = selected?.toLowerCase() ?? "";
  const isFailure = (value: string) =>
    /reject|fail|ban|restrict|disable|revoke/.test(value);
  const isSettledSuccess = (value: string) =>
    /approved|verified|connected/.test(value);
  const isPending = (value: string) =>
    /pending|review|onboarding|unverified/.test(value);

  // A failure may always supersede success. Recovery from a stored failure and
  // regressions from a settled success require an ordered provider timestamp or
  // the current Graph snapshot, preventing an old callback from winning merely
  // because it arrived last.
  if (isFailure(previous) && !isFailure(next)) return stored;
  if (isSettledSuccess(previous) && isPending(next)) return stored;
  return selected;
}

/**
 * Merges incoming provider signals over the stored operational columns, re-derives
 * the connection state (folding in the live approved-template count), and persists
 * the result. When `markSynced` is set (reconciliation poll), `last_synced_at` is
 * stamped even if nothing else changed, so "last synchronized" is honest.
 */
export async function applyChannelStateSignals(input: {
  clinicId: string;
  signals: ChannelStateSignals;
  markSynced?: boolean;
  observedAt?: string | null;
}): Promise<ApplyChannelStateResult> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const channel = await getWhatsAppChannelStateRow(input.clinicId, "meta");
    if (channel.error || !channel.data) return NO_CHANNEL;
    const row = channel.data;
    if (
      input.observedAt &&
      row.last_signal_at &&
      new Date(input.observedAt).valueOf() < new Date(row.last_signal_at).valueOf()
    ) {
      return {
        applied: false,
        transitioned: false,
        state: row.connection_state as ConnectionState | null,
        reason: row.last_state_reason,
      };
    }

    const businessVerificationStatus = pickOrderedState(
      input.signals.businessVerificationStatus,
      row.business_verification_status,
      Boolean(input.observedAt) || Boolean(input.markSynced),
    );
    const accountReviewStatus = pickOrderedState(
      input.signals.accountReviewStatus,
      row.account_review_status,
      Boolean(input.observedAt) || Boolean(input.markSynced),
    );
    const phoneStatus = pickOrderedState(
      input.signals.phoneStatus,
      row.phone_status,
      Boolean(input.observedAt) || Boolean(input.markSynced),
    );
    const qualityRating = pick(input.signals.qualityRating, row.quality_rating);
    const messagingLimitTier = pick(
      input.signals.messagingLimitTier,
      row.messaging_limit_tier,
    );
    const webhookSubscribed =
      input.signals.webhookSubscribed ?? row.webhook_subscribed;

    const approvedTemplateCount = await countApprovedTemplates(
      input.clinicId,
      "meta",
      row.provider_account_id,
    );
    const derived = deriveConnectionState({
      channelStatus: row.status,
      businessVerificationStatus,
      phoneStatus,
      accountReviewStatus,
      webhookSubscribed,
      approvedTemplateCount,
      failureReason: input.signals.failureReason,
    });

  // A send is only allowed once the channel is fully connected; a failed
  // verification is surfaced as `error`. Everything in between stays `pending`,
  // so hasActiveWhatsAppChannel never dispatches through a half-connected number.
    const nextStatus: "active" | "pending" | "error" =
      derived.state === "connected"
        ? "active"
        : derived.state === "verification_failed"
          ? "error"
          : "pending";
    const written = await applyMetaChannelState({
      clinicId: input.clinicId,
      channelId: row.id,
      expectedUpdatedAt: row.updated_at,
      status: nextStatus,
      connectionState: derived.state,
      businessVerificationStatus,
      accountReviewStatus,
      phoneStatus,
      qualityRating,
      messagingLimitTier,
      webhookSubscribed,
      lastStateReason: derived.reason,
      lastSyncedAt: input.markSynced ? new Date().toISOString() : null,
      lastSignalAt: input.observedAt ?? null,
    });
    if (written.error) throw new Error("CHANNEL_STATE_WRITE_FAILED");
    const result = written.data?.[0];
    if (!result) continue;
    return {
      applied: result.applied,
      transitioned: result.transitioned,
      state: (result.connection_state as ConnectionState | null) ?? derived.state,
      reason: result.state_reason ?? derived.reason,
    };
  }
  throw new Error("CHANNEL_STATE_CONCURRENT_UPDATE");
}

/**
 * Re-derives connection state from stored signals only (no provider call). Used
 * after a template approval-status change so `templates_pending → connected` is
 * reflected the moment the approved-template count crosses one.
 */
export async function refreshConnectionStateAfterTemplateChange(
  clinicId: string,
): Promise<ApplyChannelStateResult> {
  return applyChannelStateSignals({ clinicId, signals: {} });
}

/**
 * Reconciliation poll for one clinic: decrypts credentials, fetches the Graph
 * snapshot, and applies it (stamping last_synced_at). A missing/dialog360 channel
 * or a provider error is a no-op result, never a throw the cron cannot survive.
 */
export async function reconcileMetaChannel(
  clinicId: string,
): Promise<ApplyChannelStateResult & { ok: boolean; error?: string }> {
  const channel = await getWhatsAppChannelStateRow(clinicId, "meta");
  if (channel.error || !channel.data?.credentials_encrypted) {
    return { ...NO_CHANNEL, ok: false, error: "channel_unavailable" };
  }
  let credentials;
  try {
    credentials = decryptChannelCredentials(channel.data.credentials_encrypted);
  } catch {
    return { ...NO_CHANNEL, ok: false, error: "credentials_unavailable" };
  }
  const [snapshot, templates] = await Promise.all([
    fetchMetaChannelState(credentials),
    fetchMetaTemplates(credentials),
  ]);
  if (!snapshot.ok) {
    return { ...NO_CHANNEL, ok: false, error: snapshot.error };
  }
  if (!templates.ok) {
    return { ...NO_CHANNEL, ok: false, error: templates.error };
  }

  let webhookSubscribed = snapshot.snapshot.webhookSubscribed;
  if (!webhookSubscribed) {
    const retried = await subscribeMetaWabaWebhook(credentials);
    if (retried.ok) {
      const verified = await getMetaWabaSubscription(credentials);
      webhookSubscribed = verified.ok && verified.subscribed;
    }
  }

  const client = createClinicScopedAdminClient(clinicId);
  const localTemplates = await client
    .from("message_templates")
    .select("id, name, language")
    .eq("channel", "whatsapp");
  if (localTemplates.error) {
    return { ...NO_CHANNEL, ok: false, error: "template_lookup_failed" };
  }
  for (const providerTemplate of templates.templates) {
    const local = localTemplates.data?.find(
      (candidate) =>
        candidate.name === providerTemplate.name &&
        (candidate.language === providerTemplate.language ||
          providerTemplate.language.startsWith(`${candidate.language}_`)),
    );
    if (!local) continue;
    const binding = await client
      .from("message_template_provider_bindings")
      .upsert(
        {
          clinic_id: clinicId,
          template_id: local.id,
          provider: "meta",
          provider_account_id: credentials.wabaId ?? null,
          provider_template_id: providerTemplate.providerTemplateId,
          approval_status: providerTemplate.status,
        },
        { onConflict: "template_id,provider" },
      );
    if (binding.error) {
      return { ...NO_CHANNEL, ok: false, error: "template_sync_failed" };
    }
  }
  const result = await applyChannelStateSignals({
    clinicId,
    signals: {
      businessVerificationStatus: snapshot.snapshot.businessVerificationStatus,
      phoneStatus: snapshot.snapshot.phoneStatus,
      qualityRating: snapshot.snapshot.qualityRating,
      messagingLimitTier: snapshot.snapshot.messagingLimitTier,
      accountReviewStatus: snapshot.snapshot.accountReviewStatus,
      webhookSubscribed,
    },
    markSynced: true,
  });
  return { ...result, ok: true };
}

/**
 * Low-frequency cron job (P3D pattern): reconciles every active Meta-direct
 * channel. Best-effort per clinic — one clinic's provider failure is captured to
 * Sentry and never blocks the others. Returns a PHI-free summary.
 */
export async function runChannelStateReconciliation(): Promise<{
  scanned: number;
  transitioned: number;
  failed: number;
}> {
  const channels = await listActiveMetaChannels();
  if (channels.error || !channels.data) {
    return { scanned: 0, transitioned: 0, failed: 0 };
  }
  let transitioned = 0;
  let failed = 0;
  const queue = [...channels.data];
  const worker = async () => {
    while (queue.length > 0) {
      const channel = queue.shift();
      if (!channel) return;
      try {
        const result = await reconcileMetaChannel(channel.clinic_id);
        if (result.transitioned) transitioned += 1;
        if (!result.ok) failed += 1;
      } catch (error) {
        failed += 1;
        Sentry.captureException(error, {
          tags: { scope: "channel-reconcile", provider: "meta" },
        });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, queue.length) }, worker));
  return { scanned: channels.data.length, transitioned, failed };
}
