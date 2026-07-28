import "server-only";

import * as Sentry from "@sentry/nextjs";
import { decryptChannelCredentials } from "@/lib/messaging/crypto";
import { reconcileMetaChannel } from "@/lib/messaging/meta-reconcile";
import {
  configureDialog360Webhook,
  fetchDialog360Templates,
  getDialog360WebhookConfiguration,
} from "@/lib/messaging/whatsapp-dialog360";
import {
  getMetaWabaSubscription,
  subscribeMetaWabaWebhook,
  testMetaConnectivity,
} from "@/lib/messaging/whatsapp-meta";
import {
  getWebhookRouteTelemetry,
  type WhatsAppWebhookProvider,
} from "@/lib/messaging/webhook-telemetry";
import {
  applyMessageTemplateProviderStatus,
  applyWhatsAppWebhookHealth,
  claimWhatsAppChannelsForHealthCheck,
  createClinicScopedAdminClient,
  getWhatsAppChannelStateRow,
  logMessagingEvent,
} from "@/lib/supabase/admin";
import type { Json } from "@/types/database";

export type WhatsAppHealthStatus = "unknown" | "healthy" | "degraded";
export type WhatsAppHealthAction =
  | "refresh_status"
  | "sync_templates"
  | "repair_webhook"
  | "test_connectivity";
export type WhatsAppHealthActionCode =
  | "ok"
  | "channel_unavailable"
  | "credentials_unavailable"
  | "configuration_unavailable"
  | "provider_unavailable"
  | "not_available";

export type WhatsAppReadinessCheck = {
  key:
    | "channel"
    | "webhook"
    | "template"
    | "business_verification"
    | "quality";
  status: "passed" | "failed" | "unavailable";
  value: string | null;
  href: string;
};

export type WhatsAppHealthTimelineEvent = {
  id: string;
  type:
    | "connection"
    | "template"
    | "webhook"
    | "recovery"
    | "inbound"
    | "outbound"
    | "sync";
  occurredAt: string;
  provider: WhatsAppWebhookProvider | null;
  value: string | null;
  action: WhatsAppHealthAction | null;
};

export type WhatsAppHealthSnapshot = {
  configured: boolean;
  provider: WhatsAppWebhookProvider | null;
  channelStatus: "pending" | "active" | "error" | null;
  connectionState: string | null;
  connectionReason: string | null;
  webhook: {
    status: WhatsAppHealthStatus;
    reason: string | null;
    lastVerifiedAt: string | null;
    lastCheckedAt: string | null;
    signatureFailures: number | null;
    rateLimitRejections: number | null;
    telemetryWindowHours: 24;
  };
  lastIncomingAt: string | null;
  lastOutgoing: {
    occurredAt: string;
    status: string;
  } | null;
  templates: {
    total: number;
    draft: number;
    submitted: number;
    approved: number;
    rejected: number;
  };
  lastSyncedAt: string | null;
  meta: {
    businessVerificationStatus: string | null;
    accountReviewStatus: string | null;
    phoneStatus: string | null;
    qualityRating: string | null;
    messagingLimitTier: string | null;
  } | null;
  readiness: {
    ready: boolean;
    checks: WhatsAppReadinessCheck[];
  };
  timeline: WhatsAppHealthTimelineEvent[];
};

type ChannelRow = {
  id: string;
  provider: WhatsAppWebhookProvider;
  status: "pending" | "active" | "error";
  connection_state: string | null;
  last_state_reason: string | null;
  business_verification_status: string | null;
  account_review_status: string | null;
  phone_status: string | null;
  quality_rating: string | null;
  messaging_limit_tier: string | null;
  last_synced_at: string | null;
  webhook_health_status: string;
  webhook_health_reason: string | null;
  last_verified_webhook_at: string | null;
  last_webhook_check_at: string | null;
};

const EMPTY_TEMPLATES = {
  total: 0,
  draft: 0,
  submitted: 0,
  approved: 0,
  rejected: 0,
};

const EMPTY: WhatsAppHealthSnapshot = {
  configured: false,
  provider: null,
  channelStatus: null,
  connectionState: null,
  connectionReason: null,
  webhook: {
    status: "unknown",
    reason: null,
    lastVerifiedAt: null,
    lastCheckedAt: null,
    signatureFailures: null,
    rateLimitRejections: null,
    telemetryWindowHours: 24,
  },
  lastIncomingAt: null,
  lastOutgoing: null,
  templates: EMPTY_TEMPLATES,
  lastSyncedAt: null,
  meta: null,
  readiness: {
    ready: false,
    checks: [
      {
        key: "channel",
        status: "failed",
        value: null,
        href: "/settings/messaging",
      },
      {
        key: "webhook",
        status: "failed",
        value: null,
        href: "/settings/messaging/health#diagnostics",
      },
      {
        key: "template",
        status: "failed",
        value: "0",
        href: "/settings/templates",
      },
      {
        key: "business_verification",
        status: "unavailable",
        value: null,
        href: "/settings/messaging",
      },
      {
        key: "quality",
        status: "unavailable",
        value: null,
        href: "/settings/messaging/health#provider-health",
      },
    ],
  },
  timeline: [],
};

function asObject(value: Json | null): Record<string, Json | undefined> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, Json | undefined>)
    : {};
}

function safeText(value: Json | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized &&
    normalized.length <= 64 &&
    /^[A-Za-z0-9 _-]+$/.test(normalized)
    ? normalized
    : null;
}

function safeOperationalValue(value: string | null): string | null {
  return safeText(value);
}

function safeProvider(value: Json | undefined): WhatsAppWebhookProvider | null {
  return value === "meta" || value === "dialog360" ? value : null;
}

function safeHealthStatus(value: string): WhatsAppHealthStatus {
  return value === "healthy" || value === "degraded" ? value : "unknown";
}

function selectChannel(rows: ChannelRow[]): ChannelRow | null {
  return (
    rows.find((row) => row.provider === "meta" && row.status === "active") ??
    rows.find((row) => row.provider === "dialog360" && row.status === "active") ??
    rows.find((row) => row.provider === "meta") ??
    rows.find((row) => row.provider === "dialog360") ??
    null
  );
}

function countTemplates(
  rows: Array<{ approval_status: string }> | null | undefined,
): WhatsAppHealthSnapshot["templates"] {
  const counts = { ...EMPTY_TEMPLATES };
  for (const row of rows ?? []) {
    if (
      row.approval_status === "draft" ||
      row.approval_status === "submitted" ||
      row.approval_status === "approved" ||
      row.approval_status === "rejected"
    ) {
      counts[row.approval_status] += 1;
      counts.total += 1;
    }
  }
  return counts;
}

const APPROVED_META_BUSINESS_STATES = new Set(["approved", "verified"]);
const HEALTHY_META_QUALITY_STATES = new Set(["green", "yellow"]);

function normalizedState(value: string | null): string {
  return value?.trim().toLowerCase() ?? "";
}

function isApproved(value: string | null): boolean {
  return APPROVED_META_BUSINESS_STATES.has(normalizedState(value));
}

function isQualityHealthy(value: string | null): boolean {
  return HEALTHY_META_QUALITY_STATES.has(normalizedState(value));
}

function readiness(
  channel: ChannelRow,
  templates: WhatsAppHealthSnapshot["templates"],
): WhatsAppHealthSnapshot["readiness"] {
  const meta = channel.provider === "meta";
  const businessSignal =
    channel.business_verification_status ?? channel.account_review_status;
  const checks: WhatsAppReadinessCheck[] = [
    {
      key: "channel",
      status:
        channel.status === "active" &&
        (!meta || channel.connection_state === "connected")
          ? "passed"
          : "failed",
      value: channel.connection_state ?? channel.status,
      href: "/settings/messaging",
    },
    {
      key: "webhook",
      status: channel.last_verified_webhook_at ? "passed" : "failed",
      value: channel.last_verified_webhook_at,
      href: "/settings/messaging/health#diagnostics",
    },
    {
      key: "template",
      status: templates.approved >= 1 ? "passed" : "failed",
      value: String(templates.approved),
      href: "/settings/templates",
    },
    {
      key: "business_verification",
      status: meta
        ? isApproved(businessSignal)
          ? "passed"
          : "failed"
        : "unavailable",
      value: meta ? businessSignal : null,
      href: "/settings/messaging",
    },
    {
      key: "quality",
      status: meta
        ? isQualityHealthy(channel.quality_rating)
          ? "passed"
          : "failed"
        : "unavailable",
      value: meta ? channel.quality_rating : null,
      href: "/settings/messaging/health#provider-health",
    },
  ];
  return {
    ready: checks.every((check) => check.status !== "failed"),
    checks,
  };
}

function auditTimeline(
  rows:
    | Array<{
        id: string;
        action: string;
        new_data: Json | null;
        created_at: string;
      }>
    | null,
): WhatsAppHealthTimelineEvent[] {
  const events: WhatsAppHealthTimelineEvent[] = [];
  for (const row of rows ?? []) {
    const summary = asObject(row.new_data);
    const provider = safeProvider(summary.provider);
    if (row.action === "messaging:connection_state") {
      events.push({
        id: `audit:${row.id}`,
        type: "connection",
        occurredAt: row.created_at,
        provider: provider ?? "meta",
        value: safeText(summary.to),
        action: null,
      });
      continue;
    }
    if (row.action === "messaging:template_status") {
      events.push({
        id: `audit:${row.id}`,
        type: "template",
        occurredAt: row.created_at,
        provider,
        value: safeText(summary.status),
        action: null,
      });
      continue;
    }
    if (row.action === "messaging:webhook_health") {
      events.push({
        id: `audit:${row.id}`,
        type: "webhook",
        occurredAt: row.created_at,
        provider,
        value: safeText(summary.to),
        action: null,
      });
      continue;
    }
    if (row.action === "messaging:health_action") {
      const action = safeText(summary.action);
      if (
        action !== "refresh_status" &&
        action !== "sync_templates" &&
        action !== "repair_webhook" &&
        action !== "test_connectivity"
      ) {
        continue;
      }
      events.push({
        id: `audit:${row.id}`,
        type: "recovery",
        occurredAt: row.created_at,
        provider,
        value: null,
        action,
      });
      continue;
    }
    if (
      row.action === "messaging:connected" ||
      row.action === "messaging:disconnected"
    ) {
      events.push({
        id: `audit:${row.id}`,
        type: "connection",
        occurredAt: row.created_at,
        provider,
        value: row.action.slice("messaging:".length),
        action: null,
      });
    }
  }
  return events;
}

function mergedTimeline(input: {
  audits: WhatsAppHealthTimelineEvent[];
  provider: WhatsAppWebhookProvider;
  lastIncomingAt: string | null;
  lastOutgoing: WhatsAppHealthSnapshot["lastOutgoing"];
  lastSyncedAt: string | null;
}): WhatsAppHealthTimelineEvent[] {
  const events = [...input.audits];
  if (input.lastIncomingAt) {
    events.push({
      id: "derived:last-inbound",
      type: "inbound",
      occurredAt: input.lastIncomingAt,
      provider: input.provider,
      value: null,
      action: null,
    });
  }
  if (input.lastOutgoing) {
    events.push({
      id: "derived:last-outbound",
      type: "outbound",
      occurredAt: input.lastOutgoing.occurredAt,
      provider: input.provider,
      value: input.lastOutgoing.status,
      action: null,
    });
  }
  if (input.lastSyncedAt) {
    events.push({
      id: "derived:last-sync",
      type: "sync",
      occurredAt: input.lastSyncedAt,
      provider: input.provider,
      value: null,
      action: null,
    });
  }
  return events
    .toSorted(
      (left, right) =>
        new Date(right.occurredAt).valueOf() -
        new Date(left.occurredAt).valueOf(),
    )
    .slice(0, 50);
}

/**
 * Admin+Manager safe-metadata read. Every query is clinic-scoped on the server;
 * credential envelopes, message bodies, senders, recipients, and raw errors are
 * never selected or serialized.
 */
export async function getWhatsAppHealthSnapshot(
  clinicId: string,
): Promise<WhatsAppHealthSnapshot> {
  const client = createClinicScopedAdminClient(clinicId);
  const channels = await client
    .from("clinic_channels")
    .select(
      "id, provider, status, connection_state, last_state_reason, business_verification_status, account_review_status, phone_status, quality_rating, messaging_limit_tier, last_synced_at, webhook_health_status, webhook_health_reason, last_verified_webhook_at, last_webhook_check_at",
    )
    .eq("channel", "whatsapp")
    .in("provider", ["dialog360", "meta"]);
  if (channels.error || !channels.data) return EMPTY;
  const channel = selectChannel(channels.data as ChannelRow[]);
  if (!channel) return EMPTY;

  const [inbound, outbound, bindings, legacyTemplates, audits, telemetry] =
    await Promise.all([
      client
        .from("inbound_messages")
        .select("received_at")
        .eq("channel", "whatsapp")
        .order("received_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      client
        .from("outbound_messages")
        .select("status, status_updated_at")
        .eq("channel", "whatsapp")
        .eq("provider", channel.provider)
        .order("status_updated_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      client
        .from("message_template_provider_bindings")
        .select("approval_status")
        .eq("provider", channel.provider),
      channel.provider === "dialog360"
        ? client
            .from("message_templates")
            .select("approval_status")
            .eq("channel", "whatsapp")
        : Promise.resolve({ data: null, error: null }),
      client
        .from("audit_logs")
        .select("id, action, new_data, created_at")
        .like("action", "messaging:%")
        .order("created_at", { ascending: false })
        .limit(50),
      getWebhookRouteTelemetry(channel.provider),
    ]);

  const templateRows =
    bindings.data && bindings.data.length > 0
      ? bindings.data
      : legacyTemplates.data;
  const templates = countTemplates(templateRows);
  const safeChannel: ChannelRow = {
    ...channel,
    connection_state: safeOperationalValue(channel.connection_state),
    last_state_reason: safeOperationalValue(channel.last_state_reason),
    business_verification_status: safeOperationalValue(
      channel.business_verification_status,
    ),
    account_review_status: safeOperationalValue(
      channel.account_review_status,
    ),
    phone_status: safeOperationalValue(channel.phone_status),
    quality_rating: safeOperationalValue(channel.quality_rating),
    messaging_limit_tier: safeOperationalValue(
      channel.messaging_limit_tier,
    ),
    webhook_health_reason: safeOperationalValue(
      channel.webhook_health_reason,
    ),
  };
  const lastIncomingAt = inbound.data?.received_at ?? null;
  const lastOutgoing = outbound.data
    ? {
        occurredAt: outbound.data.status_updated_at,
        status: outbound.data.status,
      }
    : null;
  const auditEvents = audits.error ? [] : auditTimeline(audits.data);

  return {
    configured: true,
    provider: channel.provider,
    channelStatus: channel.status,
    connectionState: safeChannel.connection_state,
    connectionReason: safeChannel.last_state_reason,
    webhook: {
      status: safeHealthStatus(channel.webhook_health_status),
      reason: safeChannel.webhook_health_reason,
      lastVerifiedAt: channel.last_verified_webhook_at,
      lastCheckedAt: channel.last_webhook_check_at,
      signatureFailures: telemetry.signatureFailures,
      rateLimitRejections: telemetry.rateLimitRejections,
      telemetryWindowHours: telemetry.windowHours,
    },
    lastIncomingAt,
    lastOutgoing,
    templates,
    lastSyncedAt: channel.last_synced_at,
    meta:
      channel.provider === "meta"
        ? {
            businessVerificationStatus:
              safeChannel.business_verification_status,
            accountReviewStatus: safeChannel.account_review_status,
            phoneStatus: safeChannel.phone_status,
            qualityRating: safeChannel.quality_rating,
            messagingLimitTier: safeChannel.messaging_limit_tier,
          }
        : null,
    readiness: readiness(safeChannel, templates),
    timeline: mergedTimeline({
      audits: auditEvents,
      provider: channel.provider,
      lastIncomingAt,
      lastOutgoing,
      lastSyncedAt: channel.last_synced_at,
    }),
  };
}

function callbackUrl(): string | null {
  const raw = process.env.NEXT_PUBLIC_SITE_URL;
  if (!raw) return null;
  try {
    const base = new URL(raw);
    if (base.protocol !== "https:" && base.hostname !== "localhost") return null;
    return new URL("/api/webhooks/whatsapp", base).toString();
  } catch {
    return null;
  }
}

function authorizationHeader(
  headers: Record<string, string> | undefined,
): string | null {
  if (!headers) return null;
  const entry = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === "authorization",
  );
  return entry?.[1] ?? null;
}

async function configuredChannel(
  clinicId: string,
  provider?: WhatsAppWebhookProvider,
) {
  const client = createClinicScopedAdminClient(clinicId);
  const rows = await client
    .from("clinic_channels")
    .select(
      "id, provider, status, credentials_encrypted, connection_state, updated_at",
    )
    .eq("channel", "whatsapp")
    .in("provider", ["dialog360", "meta"]);
  if (rows.error || !rows.data) return null;
  if (provider) {
    return rows.data.find((row) => row.provider === provider) ?? null;
  }
  return (
    rows.data.find((row) => row.provider === "meta" && row.status === "active") ??
    rows.data.find(
      (row) => row.provider === "dialog360" && row.status === "active",
    ) ??
    rows.data.find((row) => row.provider === "meta") ??
    rows.data.find((row) => row.provider === "dialog360") ??
    null
  );
}

async function persistWebhookCheck(input: {
  clinicId: string;
  channelId: string;
  status: WhatsAppHealthStatus;
  reason: string | null;
  verifiedAt?: string | null;
}) {
  const written = await applyWhatsAppWebhookHealth({
    clinicId: input.clinicId,
    channelId: input.channelId,
    status: input.status,
    reason: input.reason,
    checkedAt: new Date().toISOString(),
    verifiedAt: input.verifiedAt,
  });
  return !written.error && Boolean(written.data?.[0]?.applied);
}

export async function recordVerifiedWhatsAppWebhook(input: {
  clinicId: string;
  provider: WhatsAppWebhookProvider;
  occurredAt?: string;
}): Promise<void> {
  const channel = await getWhatsAppChannelStateRow(
    input.clinicId,
    input.provider,
  );
  if (channel.error || !channel.data) return;
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  await applyWhatsAppWebhookHealth({
    clinicId: input.clinicId,
    channelId: channel.data.id,
    status: "healthy",
    reason: null,
    verifiedAt: occurredAt,
  });
}

async function checkWebhook(input: {
  clinicId: string;
  repair: boolean;
  provider?: WhatsAppWebhookProvider;
}): Promise<{ ok: boolean; code: WhatsAppHealthActionCode }> {
  const channel = await configuredChannel(input.clinicId, input.provider);
  if (!channel) return { ok: false, code: "channel_unavailable" };
  if (!channel.credentials_encrypted) {
    await persistWebhookCheck({
      clinicId: input.clinicId,
      channelId: channel.id,
      status: "degraded",
      reason: "credentials_unavailable",
    });
    return { ok: false, code: "credentials_unavailable" };
  }
  let credentials;
  try {
    credentials = decryptChannelCredentials(channel.credentials_encrypted);
  } catch {
    await persistWebhookCheck({
      clinicId: input.clinicId,
      channelId: channel.id,
      status: "degraded",
      reason: "credentials_unavailable",
    });
    return { ok: false, code: "credentials_unavailable" };
  }

  if (channel.provider === "meta") {
    let subscription = await getMetaWabaSubscription(credentials);
    if (
      input.repair &&
      subscription.ok &&
      !subscription.subscribed
    ) {
      const repaired = await subscribeMetaWabaWebhook(credentials);
      if (repaired.ok) subscription = await getMetaWabaSubscription(credentials);
    }
    const healthy = subscription.ok && subscription.subscribed;
    await persistWebhookCheck({
      clinicId: input.clinicId,
      channelId: channel.id,
      status: healthy ? "healthy" : "degraded",
      reason: healthy
        ? null
        : subscription.ok
          ? "configuration_drift"
          : "provider_unavailable",
    });
    return healthy
      ? { ok: true, code: "ok" }
      : {
          ok: false,
          code: subscription.ok
            ? "configuration_unavailable"
            : "provider_unavailable",
        };
  }

  const expectedUrl = callbackUrl();
  if (
    !expectedUrl ||
    !credentials.apiKey ||
    !credentials.webhookUsername ||
    !credentials.webhookSecret
  ) {
    await persistWebhookCheck({
      clinicId: input.clinicId,
      channelId: channel.id,
      status: "degraded",
      reason: "configuration_unavailable",
    });
    return { ok: false, code: "configuration_unavailable" };
  }
  const expectedAuthorization = `Basic ${Buffer.from(
    `${credentials.webhookUsername}:${credentials.webhookSecret}`,
  ).toString("base64")}`;
  let configuration = await getDialog360WebhookConfiguration(credentials.apiKey);
  const matches = () =>
    configuration.ok &&
    configuration.configuration.url === expectedUrl &&
    authorizationHeader(configuration.configuration.headers) ===
      expectedAuthorization;
  if (input.repair && !matches()) {
    const repaired = await configureDialog360Webhook({
      apiKey: credentials.apiKey,
      url: expectedUrl,
      username: credentials.webhookUsername,
      password: credentials.webhookSecret,
    });
    if (repaired.ok) {
      configuration = await getDialog360WebhookConfiguration(credentials.apiKey);
    }
  }
  const healthy = matches();
  await persistWebhookCheck({
    clinicId: input.clinicId,
    channelId: channel.id,
    status: healthy ? "healthy" : "degraded",
    reason: healthy
      ? null
      : configuration.ok
        ? "configuration_drift"
        : "provider_unavailable",
  });
  return healthy
    ? { ok: true, code: "ok" }
    : {
        ok: false,
        code: configuration.ok
          ? "configuration_unavailable"
          : "provider_unavailable",
      };
}

async function syncDialog360Templates(
  clinicId: string,
): Promise<{ ok: boolean; code: WhatsAppHealthActionCode }> {
  const channel = await configuredChannel(clinicId);
  if (
    !channel ||
    channel.provider !== "dialog360" ||
    !channel.credentials_encrypted
  ) {
    return { ok: false, code: "channel_unavailable" };
  }
  let credentials;
  try {
    credentials = decryptChannelCredentials(channel.credentials_encrypted);
  } catch {
    return { ok: false, code: "credentials_unavailable" };
  }
  const remote = await fetchDialog360Templates(credentials);
  if (!remote.ok) return { ok: false, code: "provider_unavailable" };
  const client = createClinicScopedAdminClient(clinicId);
  const [local, bindings] = await Promise.all([
    client
      .from("message_templates")
      .select("id, name, language")
      .eq("channel", "whatsapp"),
    client
      .from("message_template_provider_bindings")
      .select(
        "id, template_id, provider_template_id, approval_status",
      )
      .eq("provider", "dialog360"),
  ]);
  if (local.error || bindings.error) {
    return { ok: false, code: "configuration_unavailable" };
  }
  for (const providerTemplate of remote.templates) {
    const template = local.data?.find(
      (candidate) =>
        candidate.name === providerTemplate.name &&
        (candidate.language === providerTemplate.language ||
          providerTemplate.language.startsWith(`${candidate.language}_`)),
    );
    if (!template) continue;
    const existing = bindings.data?.find(
      (binding) => binding.template_id === template.id,
    );
    if (!existing) {
      const inserted = await client
        .from("message_template_provider_bindings")
        .insert({
          clinic_id: clinicId,
          template_id: template.id,
          provider: "dialog360",
          provider_template_id: providerTemplate.providerTemplateId,
          approval_status: providerTemplate.status,
        });
      if (inserted.error) {
        return { ok: false, code: "configuration_unavailable" };
      }
      continue;
    }
    if (existing.provider_template_id !== providerTemplate.providerTemplateId) {
      const updated = await client
        .from("message_template_provider_bindings")
        .update({
          provider_template_id: providerTemplate.providerTemplateId,
        })
        .eq("id", existing.id);
      if (updated.error) {
        return { ok: false, code: "configuration_unavailable" };
      }
    }
    if (existing.approval_status !== providerTemplate.status) {
      const applied = await applyMessageTemplateProviderStatus({
        provider: "dialog360",
        providerTemplateId: providerTemplate.providerTemplateId,
        status: providerTemplate.status,
        allowedFrom: ["draft", "submitted", "approved", "rejected"],
      });
      if (applied.error) {
        return { ok: false, code: "configuration_unavailable" };
      }
    }
  }
  const synced = await client
    .from("clinic_channels")
    .update({ last_synced_at: new Date().toISOString() })
    .eq("id", channel.id);
  return synced.error
    ? { ok: false, code: "configuration_unavailable" }
    : { ok: true, code: "ok" };
}

async function testConnectivity(
  clinicId: string,
): Promise<{ ok: boolean; code: WhatsAppHealthActionCode }> {
  const channel = await configuredChannel(clinicId);
  if (!channel?.credentials_encrypted) {
    return {
      ok: false,
      code: channel ? "credentials_unavailable" : "channel_unavailable",
    };
  }
  let credentials;
  try {
    credentials = decryptChannelCredentials(channel.credentials_encrypted);
  } catch {
    return { ok: false, code: "credentials_unavailable" };
  }
  if (channel.provider === "meta") {
    const result = await testMetaConnectivity(credentials);
    return result.ok
      ? { ok: true, code: "ok" }
      : { ok: false, code: "provider_unavailable" };
  }
  if (!credentials.apiKey) {
    return { ok: false, code: "credentials_unavailable" };
  }
  const result = await getDialog360WebhookConfiguration(credentials.apiKey);
  return result.ok
    ? { ok: true, code: "ok" }
    : { ok: false, code: "provider_unavailable" };
}

/**
 * Executes one closed-registry read/retry diagnostic. The audit row is written
 * before provider I/O so every requested action has a durable, content-free
 * record even if the provider call fails or times out.
 */
export async function runWhatsAppHealthAction(input: {
  clinicId: string;
  action: WhatsAppHealthAction;
}): Promise<{ ok: boolean; code: WhatsAppHealthActionCode }> {
  const channel = await configuredChannel(input.clinicId);
  const audit = await logMessagingEvent({
    clinicId: input.clinicId,
    event: "health_action",
    recordId: channel?.id ?? null,
    summary: {
      action: input.action,
      provider: channel?.provider ?? "none",
    },
  });
  if (audit.error) {
    return { ok: false, code: "configuration_unavailable" };
  }
  if (!channel) return { ok: false, code: "channel_unavailable" };

  if (input.action === "refresh_status") {
    if (channel.provider !== "meta") {
      return { ok: false, code: "not_available" };
    }
    const result = await reconcileMetaChannel(input.clinicId);
    return result.ok
      ? { ok: true, code: "ok" }
      : { ok: false, code: "provider_unavailable" };
  }
  if (input.action === "sync_templates") {
    if (channel.provider === "meta") {
      const result = await reconcileMetaChannel(input.clinicId);
      return result.ok
        ? { ok: true, code: "ok" }
        : { ok: false, code: "provider_unavailable" };
    }
    return syncDialog360Templates(input.clinicId);
  }
  if (input.action === "repair_webhook") {
    return checkWebhook({ clinicId: input.clinicId, repair: true });
  }
  return testConnectivity(input.clinicId);
}

/** Daily read-only drift detection; guided repair remains a user action. */
export async function runWhatsAppHealthChecks(): Promise<{
  scanned: number;
  healthy: number;
  degraded: number;
  failed: number;
}> {
  const claimed = await claimWhatsAppChannelsForHealthCheck();
  if (claimed.error || !claimed.data) {
    throw new Error("WHATSAPP_HEALTH_CLAIM_FAILED");
  }
  let healthy = 0;
  let degraded = 0;
  let failed = 0;
  const queue = [...claimed.data];
  const worker = async () => {
    while (queue.length > 0) {
      const channel = queue.shift();
      if (!channel) return;
      try {
        if (
          channel.provider !== "meta" &&
          channel.provider !== "dialog360"
        ) {
          failed += 1;
          continue;
        }
        const result = await checkWebhook({
          clinicId: channel.clinic_id,
          repair: false,
          provider: channel.provider,
        });
        if (result.ok) healthy += 1;
        else degraded += 1;
      } catch (error) {
        failed += 1;
        Sentry.captureException(error, {
          tags: {
            scope: "whatsapp-health-check",
            provider: channel.provider,
          },
        });
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(8, queue.length) }, worker),
  );
  return { scanned: claimed.data.length, healthy, degraded, failed };
}
