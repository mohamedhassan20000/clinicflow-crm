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
  asLinkedDeviceStatus,
  type LinkedDeviceStatus,
} from "@/lib/messaging/linked-device-view";
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
    /** Linked device only: the worker holding the pairing socket is alive. */
    | "session"
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

/**
 * How fresh a linked-device worker heartbeat has to be to count as live.
 *
 * The worker stamps `last_heartbeat_at` every 30s and treats a 90s-old stamp as
 * abandoned (`HEARTBEAT_STALE_MS` in services/whatsapp-worker/src/store.ts).
 * Health reports against the same window so this page and the worker's own
 * takeover logic can never disagree about whether a session is being served.
 */
const LINKED_DEVICE_HEARTBEAT_STALE_MS = 90_000;

export type LinkedDeviceHeartbeat = "online" | "stale" | "offline";

/**
 * The linked-device (QR) equivalent of the Meta provider block: what ClinicFlow
 * can actually observe about a pairing. No authentication state, worker address
 * or session identifier crosses — only whether *a* worker is serving the
 * session and how recently it said so.
 */
export type WhatsAppLinkedDeviceHealth = {
  sessionStatus: LinkedDeviceStatus;
  phoneNumber: string | null;
  connectedAt: string | null;
  lastHeartbeatAt: string | null;
  workerAssigned: boolean;
  heartbeat: LinkedDeviceHeartbeat;
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
  linkedDevice: WhatsAppLinkedDeviceHealth | null;
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
  sender_identity: string | null;
  connected_at: string | null;
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
  linkedDevice: null,
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
  return value === "meta" || value === "dialog360" || value === "linked_device"
    ? value
    : null;
}

/**
 * The paired number is the one operational value on this page that is not a
 * status word, so it gets its own narrowing rather than `safeText`'s
 * alphanumeric rule. Anything that is not a plain E.164-shaped number is
 * dropped rather than rendered.
 */
function safePhoneNumber(value: string | null): string | null {
  const normalized = value?.trim() ?? "";
  return /^\+?[0-9]{6,20}$/.test(normalized) ? normalized : null;
}

function safeHealthStatus(value: string): WhatsAppHealthStatus {
  return value === "healthy" || value === "degraded" ? value : "unknown";
}

/**
 * Which channel this page reports on.
 *
 * The linked-device row is checked first, for the same reason
 * `getWhatsAppConnectionView` checks it first: it is the only WhatsApp channel
 * written by the pairing worker, a pairing can only start while no other
 * WhatsApp channel is active, and its presence is therefore decisive. Without
 * this, a paired clinic read as "no channel" and every check failed. The Meta /
 * 360dialog ordering below is unchanged.
 */
function selectChannel(rows: ChannelRow[]): ChannelRow | null {
  return (
    rows.find((row) => row.provider === "linked_device") ??
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

/**
 * Production readiness for a QR / linked-device pairing.
 *
 * A linked device is not a Meta Cloud API account: there is no webhook to
 * verify, no template to get approved, no business review and no quality
 * rating. Those requirements are reported `unavailable` — the same "not
 * applicable" state the Meta-only provider signals already use — so they are
 * never counted against a clinic that will never be able to satisfy them. What
 * is genuinely required is the pair below: the channel is live and a worker is
 * actually holding the socket.
 */
function linkedDeviceReadiness(
  channel: ChannelRow,
  session: WhatsAppLinkedDeviceHealth,
): WhatsAppHealthSnapshot["readiness"] {
  const checks: WhatsAppReadinessCheck[] = [
    {
      key: "channel",
      status:
        channel.status === "active" && session.sessionStatus === "connected"
          ? "passed"
          : "failed",
      value: session.sessionStatus,
      href: "/settings/messaging",
    },
    {
      key: "session",
      // A connected session whose worker stopped reporting is exactly the
      // failure this row exists to surface, so staleness fails even though the
      // stored status still reads "connected".
      status: session.heartbeat === "online" ? "passed" : "failed",
      value: session.lastHeartbeatAt,
      href: "/settings/messaging",
    },
    {
      key: "webhook",
      status: "unavailable",
      value: null,
      href: "/settings/messaging/health#diagnostics",
    },
    {
      key: "template",
      status: "unavailable",
      value: null,
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
  ];
  return {
    ready: checks.every((check) => check.status !== "failed"),
    checks,
  };
}

function readiness(
  channel: ChannelRow,
  templates: WhatsAppHealthSnapshot["templates"],
  linkedDevice: WhatsAppLinkedDeviceHealth | null,
): WhatsAppHealthSnapshot["readiness"] {
  if (channel.provider === "linked_device" && linkedDevice) {
    return linkedDeviceReadiness(channel, linkedDevice);
  }
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

type LinkedDeviceSessionRow = {
  status: string | null;
  phone_number: string | null;
  connected_at: string | null;
  last_heartbeat_at: string | null;
  worker_id: string | null;
};

/**
 * Collapses the pairing session into the operational facts this page reports.
 *
 * The channel row is the fallback for the number: the worker writes the paired
 * number to `clinic_channels.sender_identity` when it claims the channel, which
 * is the same value the messaging settings card shows — so health and settings
 * cannot disagree about which number is connected.
 */
function linkedDeviceHealth(
  channel: ChannelRow,
  row: LinkedDeviceSessionRow | null,
  now: number = Date.now(),
): WhatsAppLinkedDeviceHealth {
  const sessionStatus = asLinkedDeviceStatus(row?.status ?? null);
  const lastHeartbeatAt = row?.last_heartbeat_at ?? null;
  const workerAssigned = Boolean(row?.worker_id);
  const heartbeatAgeMs = lastHeartbeatAt
    ? now - new Date(lastHeartbeatAt).valueOf()
    : null;
  const heartbeat: LinkedDeviceHeartbeat =
    !workerAssigned || heartbeatAgeMs === null || Number.isNaN(heartbeatAgeMs)
      ? "offline"
      : heartbeatAgeMs <= LINKED_DEVICE_HEARTBEAT_STALE_MS
        ? "online"
        : "stale";
  return {
    sessionStatus,
    phoneNumber:
      safePhoneNumber(row?.phone_number ?? null) ??
      safePhoneNumber(channel.sender_identity),
    connectedAt: row?.connected_at ?? channel.connected_at,
    lastHeartbeatAt,
    workerAssigned,
    heartbeat,
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
  linkedDeviceConnectedAt?: string | null;
}): WhatsAppHealthTimelineEvent[] {
  const events = [...input.audits];
  if (input.linkedDeviceConnectedAt) {
    events.push({
      id: "derived:linked-device-connected",
      type: "connection",
      occurredAt: input.linkedDeviceConnectedAt,
      provider: input.provider,
      value: "connected",
      action: null,
    });
  }
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
      "id, provider, status, connection_state, last_state_reason, business_verification_status, account_review_status, phone_status, quality_rating, messaging_limit_tier, last_synced_at, webhook_health_status, webhook_health_reason, last_verified_webhook_at, last_webhook_check_at, sender_identity, connected_at",
    )
    .eq("channel", "whatsapp")
    .in("provider", ["dialog360", "meta", "linked_device"]);
  if (channels.error || !channels.data) return EMPTY;
  const channel = selectChannel(channels.data as ChannelRow[]);
  if (!channel) return EMPTY;

  const linkedDeviceChannel = channel.provider === "linked_device";
  const [
    inbound,
    outbound,
    bindings,
    legacyTemplates,
    audits,
    telemetry,
    sessionRow,
  ] = await Promise.all([
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
      // Signature and rate-limit rejections are counted on the shared provider
      // callback route. A linked device has no such route, so these are
      // genuinely not applicable rather than zero, and the counter is not read.
      linkedDeviceChannel
        ? Promise.resolve({
            signatureFailures: null,
            rateLimitRejections: null,
            windowHours: 24 as const,
          })
        : getWebhookRouteTelemetry(channel.provider),
      linkedDeviceChannel
        ? client
            .from("whatsapp_linked_device_sessions")
            .select(
              "status, phone_number, connected_at, last_heartbeat_at, worker_id",
            )
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
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
  const linkedDevice = linkedDeviceChannel
    ? linkedDeviceHealth(
        safeChannel,
        sessionRow.error
          ? null
          : (sessionRow.data as LinkedDeviceSessionRow | null),
      )
    : null;
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
    // The pairing session is the authority on a linked device's live state; the
    // channel row's `connection_state` is only stamped when the number is first
    // claimed and never moves again.
    connectionState: linkedDevice
      ? linkedDevice.sessionStatus
      : safeChannel.connection_state,
    connectionReason: safeChannel.last_state_reason,
    webhook: {
      status: linkedDeviceChannel
        ? "unknown"
        : safeHealthStatus(channel.webhook_health_status),
      reason: linkedDeviceChannel ? null : safeChannel.webhook_health_reason,
      lastVerifiedAt: linkedDeviceChannel
        ? null
        : channel.last_verified_webhook_at,
      lastCheckedAt: linkedDeviceChannel
        ? null
        : channel.last_webhook_check_at,
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
    linkedDevice,
    readiness: readiness(safeChannel, templates, linkedDevice),
    timeline: mergedTimeline({
      audits: auditEvents,
      provider: channel.provider,
      lastIncomingAt,
      lastOutgoing,
      lastSyncedAt: channel.last_synced_at,
      linkedDeviceConnectedAt: linkedDevice?.connectedAt ?? null,
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
    .in("provider", ["dialog360", "meta", "linked_device"]);
  if (rows.error || !rows.data) return null;
  // Every recovery action drives a Cloud API credential. A clinic paired by QR
  // owns its WhatsApp channel through the worker, so a leftover, unverified
  // Meta or 360dialog row must not be picked up and acted on behind its back —
  // the caller reports "channel unavailable" instead.
  if (rows.data.some((row) => row.provider === "linked_device")) return null;
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
