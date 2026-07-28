import "server-only";
import * as Sentry from "@sentry/nextjs";
import {
  advanceOutboundMessageStatus,
  findMessageTemplateForWebhook,
  createClinicScopedAdminClient,
  persistWhatsAppInbound,
} from "@/lib/supabase/admin";
import { normalizePhone } from "@/lib/phone/registry";
import { sanitizeProviderError } from "@/lib/messaging/scrub";
import { emitClinicNotification } from "@/lib/notifications/emit";
import { runPatientInboundAiReply } from "@/lib/ai/patient-reply";
import type {
  MessagingProviderId,
  TemplateApprovalStatus,
  WebhookEvent,
} from "@/lib/messaging/types";

type ProcessingSummary = {
  inbound: number;
  statuses: number;
  templates: number;
  replays: number;
  ignored: number;
};

function receivedAt(value: string | null): string {
  if (!value) return new Date().toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? new Date().toISOString() : parsed.toISOString();
}

function senderE164(sender: string): string {
  const candidate = sender.startsWith("+") ? sender : `+${sender}`;
  return normalizePhone(candidate) ?? candidate;
}

async function persistInboundMessage(
  clinicId: string,
  event: Extract<WebhookEvent, { kind: "inbound" }>,
): Promise<"inserted" | "replay"> {
  const sender = senderE164(event.sender);
  const timestamp = receivedAt(event.receivedAt);
  const persisted = await persistWhatsAppInbound({
    clinicId,
    sender,
    body: event.body || "[Empty message]",
    providerMessageId: event.providerMessageId,
    receivedAt: timestamp,
  });
  if (persisted.error || !persisted.data?.[0]) {
    throw new Error("INBOUND_PERSIST_FAILED");
  }
  if (!persisted.data[0].inserted) return "replay";

  // P3D (§7.5): staff awareness of new patient messages. Assigned threads
  // notify their owner; unassigned ones notify the inbox roles. Deduped per
  // conversation while unread, and never a reason to fail the webhook.
  const conversationId = persisted.data[0].conversation_id;
  if (conversationId) {
    const conversation = await createClinicScopedAdminClient(clinicId)
      .from("conversations")
      .select("assigned_to")
      .eq("id", conversationId)
      .maybeSingle();
    await emitClinicNotification({
      clinicId,
      type: "inbox_message",
      link: `/inbox?conversation=${conversationId}`,
      data: { conversationId },
      ...(conversation.data?.assigned_to
        ? { recipientIds: [conversation.data.assigned_to] }
        : { roles: ["admin", "receptionist"] }),
      dedupeUnread: true,
    });

    // P5B (§6.2): hand the fresh inbound turn to the patient AI. This is the
    // only wiring point between the webhook and the agent. It is strictly
    // best-effort — a disabled mode, a missing entitlement, or any failure
    // leaves the staff inbox notification above as the guaranteed fallback and
    // never fails the webhook (a failed reply degrades to a human, §6.7).
    try {
      await runPatientInboundAiReply({
        clinicId,
        conversationId,
        providerMessageId: event.providerMessageId,
        messageText: event.body ?? "",
      });
    } catch (error) {
      Sentry.captureException(error, {
        tags: { scope: "webhook-patient-ai", provider: "dialog360" },
      });
    }
  }
  return "inserted";
}

async function persistStatus(
  provider: MessagingProviderId,
  event: Extract<WebhookEvent, { kind: "status" }>,
  expectedClinicId?: string,
): Promise<boolean> {
  const clientReference = event.clientReference &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      event.clientReference,
    )
    ? event.clientReference
    : null;
  const update = await advanceOutboundMessageStatus({
    provider,
    providerMessageId: event.providerMessageId,
    clientReference,
    expectedClinicId: expectedClinicId ?? null,
    status: event.status,
    error: event.error ? sanitizeProviderError(event.error) : null,
    occurredAt: event.occurredAt,
  });
  if (update.error) throw new Error("OUTBOUND_STATUS_UPDATE_FAILED");
  return update.data === true;
}

/**
 * Provider states a webhook may legally move a template into. Only a
 * submitted template accepts provider outcomes, and only from the states that
 * can still change (P3-M3). A late/stale event for a template the clinic has
 * since edited (back to draft) or replaced is ignored rather than allowed to
 * regress the stored state.
 */
const TEMPLATE_WEBHOOK_TRANSITIONS: Partial<
  Record<TemplateApprovalStatus, readonly TemplateApprovalStatus[]>
> = {
  approved: ["submitted", "rejected"],
  rejected: ["submitted", "approved"],
  submitted: ["submitted"],
};

async function persistTemplateStatus(
  clinicId: string,
  event: Extract<WebhookEvent, { kind: "template_status" }>,
): Promise<boolean> {
  const owner = await findMessageTemplateForWebhook(event.providerTemplateId);
  if (owner.error || !owner.data || owner.data.clinic_id !== clinicId) return false;
  const allowedFrom = TEMPLATE_WEBHOOK_TRANSITIONS[event.status];
  if (!allowedFrom) return false;
  const client = createClinicScopedAdminClient(clinicId);
  // Conditional UPDATE gated on both the provider id (so an edit that detached
  // it wins) and the legal source states, in one statement — no read-then-write
  // race with a concurrent edit/submit/delete.
  const update = await client
    .from("message_templates")
    .update({ approval_status: event.status })
    .eq("id", owner.data.id)
    .eq("provider_template_id", event.providerTemplateId)
    .in("approval_status", [...allowedFrom])
    .select("id")
    .maybeSingle();
  if (update.error) throw new Error("TEMPLATE_STATUS_UPDATE_FAILED");
  // A no-op (stale event, superseded template) is not an error: the event was
  // handled by being safely ignored.
  return update.data !== null;
}

export async function processMessagingWebhookEvents(input: {
  provider: MessagingProviderId;
  clinicId?: string;
  senderIdentity?: string;
  events: readonly WebhookEvent[];
}): Promise<ProcessingSummary> {
  const summary: ProcessingSummary = {
    inbound: 0,
    statuses: 0,
    templates: 0,
    replays: 0,
    ignored: 0,
  };
  for (const event of input.events) {
    if (event.kind === "ignored") {
      summary.ignored += 1;
      continue;
    }
    if (event.kind === "inbound") {
      if (
        !input.clinicId ||
        (input.senderIdentity !== undefined && event.phoneNumberId !== input.senderIdentity)
      ) {
        summary.ignored += 1;
        continue;
      }
      try {
        const result = await persistInboundMessage(input.clinicId, event);
        if (result === "replay") summary.replays += 1;
        else summary.inbound += 1;
      } catch (error) {
        if (error instanceof Error && error.message === "WEBHOOK_REPLAY") {
          summary.replays += 1;
          continue;
        }
        throw error;
      }
      continue;
    }
    if (event.kind === "status") {
      if (await persistStatus(input.provider, event, input.clinicId)) summary.statuses += 1;
      else summary.ignored += 1;
      continue;
    }
    if (!input.clinicId) {
      summary.ignored += 1;
      continue;
    }
    if (await persistTemplateStatus(input.clinicId, event)) summary.templates += 1;
    else summary.ignored += 1;
  }
  return summary;
}
