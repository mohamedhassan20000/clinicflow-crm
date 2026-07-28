import "server-only";

import * as Sentry from "@sentry/nextjs";
import { convertToModelMessages, type UIMessage } from "ai";
import {
  createAiRequestId,
  prepareAiExecution,
  type AiExecutionOutcome,
} from "@/lib/ai/client";
import { AI_SCHEDULING_FEATURE } from "@/lib/ai/patient-authorization";
import { createPatientAgent } from "@/lib/ai/patient-agent";
import { AiToolAuthorizationError } from "@/lib/ai/errors";
import { logAgentTool } from "@/lib/ai/audit";
import {
  detectPatientEscalation,
  emergencyNumberForCountry,
  type PatientEscalationDetection,
  type PatientEscalationReason,
} from "@/lib/ai/patient-escalation";
import {
  normalizeClinicAiReplyMode,
  resolveEffectiveAiReplyMode,
  type EffectiveAiReplyMode,
} from "@/lib/ai/patient-reply-mode";
import { getEntitlements, hasFeature } from "@/lib/entitlements";
import { emitClinicNotification } from "@/lib/notifications/emit";
import { patientCopyLocale, patientEscalationCopy } from "@/lib/messaging/patient-copy";
import { sendMessage } from "@/lib/messaging/send";
import {
  createClinicScopedAdminClient,
  getClinicAiReplyContext,
} from "@/lib/supabase/admin";
import type { AiTaskClass } from "@/lib/ai/platform/types";

/** How many prior messages of context the agent sees. Bounded for cost. */
const HISTORY_LIMIT = 16;

export type PatientAiReplyOutcome =
  | { status: "disabled"; mode: EffectiveAiReplyMode }
  | { status: "skipped"; reason: "conversation_unavailable" | "already_escalated" | "empty_message" }
  | { status: "escalated"; reason: PatientEscalationReason; sent: boolean }
  | { status: "suggested"; suggestionId: string | null }
  | { status: "auto_sent"; suggestionId: string | null; outboundMessageId: string | null }
  | { status: "failed" };

/**
 * The model-facing half of the turn, injectable so tests exercise the full
 * suggest/auto/escalation orchestration with a mocked LLM (§P5B acceptance)
 * without a live provider or budget ledger. The default runs the certified
 * P5A patient agent through the shared P4.5 execution/budget lifecycle.
 */
export type PatientAgentRunner = (input: {
  clinicId: string;
  conversationId: string;
  /** Stable per-inbound key (the provider message id) for the reservation. */
  requestKey: string;
  locale: "ar" | "en";
  task: Extract<AiTaskClass, "patient_booking" | "patient_faq">;
  messages: UIMessage[];
}) => Promise<{ ok: boolean; text: string }>;

async function runCertifiedPatientAgent(
  input: Parameters<PatientAgentRunner>[0],
): Promise<{ ok: boolean; text: string }> {
  const requestId = createAiRequestId({
    clinicId: input.clinicId,
    // The conversation UUID is the content-free patient actor key (P5A §7).
    actorId: input.conversationId,
    conversationId: input.conversationId,
    messageId: input.requestKey,
  });
  let outcome: AiExecutionOutcome = "failed";
  let errorClass: string | undefined = "stream_failed";
  const execution = await prepareAiExecution({
    user: { id: input.conversationId, clinicId: input.clinicId },
    requestId,
    task: input.task,
    persona: "patient",
    surface: "patient_messaging",
  });
  try {
    const agent = createPatientAgent({
      clinicId: input.clinicId,
      conversationId: input.conversationId,
      locale: input.locale,
      execution,
    });
    const result = await agent.generate({
      messages: await convertToModelMessages(input.messages),
    });
    const text = (result.text ?? "").trim();
    if (text) {
      outcome = "success";
      errorClass = undefined;
      return { ok: true, text };
    }
    return { ok: false, text: "" };
  } finally {
    try {
      await execution.finalize({ outcome, errorClass });
    } catch (error) {
      Sentry.captureException(error, {
        tags: { area: "patient-ai-reconciliation" },
      });
    }
  }
}

type ConversationRow = {
  status: string;
  patient_id: string | null;
  participant_address: string | null;
  ai_escalated_at: string | null;
};

type ClinicRow = {
  name: string;
  locale: string;
  country: string;
  phone: string | null;
  ai_reply_mode: string;
};

async function recordSuggestion(input: {
  clinicId: string;
  conversationId: string;
  inboundMessageId: string | null;
  mode: "suggest" | "auto";
  body: string;
  status: "pending" | "sent";
  escalate: boolean;
  escalationReason: PatientEscalationReason | null;
  outboundMessageId: string | null;
}): Promise<string | null> {
  const client = createClinicScopedAdminClient(input.clinicId);
  // Supersede a prior undecided draft so staff never act on a stale suggestion
  // for an already-superseded turn (the partial unique index also guards this).
  await client
    .from("ai_suggested_replies")
    .update({ status: "superseded" })
    .eq("conversation_id", input.conversationId)
    .eq("status", "pending");
  const inserted = await client
    .from("ai_suggested_replies")
    .insert({
      clinic_id: input.clinicId,
      conversation_id: input.conversationId,
      inbound_message_id: input.inboundMessageId,
      mode: input.mode,
      body: input.body.slice(0, 4000),
      status: input.status,
      escalate: input.escalate,
      escalation_reason: input.escalationReason,
      outbound_message_id: input.outboundMessageId,
      decided_at: input.status === "sent" ? new Date().toISOString() : null,
    })
    .select("id")
    .maybeSingle();
  return inserted.data?.id ?? null;
}

async function markConversationReplied(clinicId: string, conversationId: string): Promise<void> {
  await createClinicScopedAdminClient(clinicId)
    .from("conversations")
    .update({ ai_last_replied_at: new Date().toISOString() })
    .eq("id", conversationId);
}

async function escalateConversation(input: {
  clinicId: string;
  conversationId: string;
  reason: PatientEscalationReason;
  assignedTo: string | null;
}): Promise<void> {
  const client = createClinicScopedAdminClient(input.clinicId);
  // Only stamp the first escalation so the human-handoff time and reason are
  // stable; a later turn never overwrites an open escalation.
  await client
    .from("conversations")
    .update({
      ai_escalated_at: new Date().toISOString(),
      ai_escalation_reason: input.reason,
    })
    .eq("id", input.conversationId)
    .is("ai_escalated_at", null);
  await emitClinicNotification({
    clinicId: input.clinicId,
    type: "ai_escalation",
    link: `/inbox?conversation=${input.conversationId}`,
    data: { conversationId: input.conversationId, reason: input.reason },
    ...(input.assignedTo
      ? { recipientIds: [input.assignedTo] }
      : { roles: ["admin", "receptionist"] }),
    dedupeUnread: true,
  });
}

async function loadHistory(
  clinicId: string,
  conversationId: string,
): Promise<UIMessage[]> {
  const client = createClinicScopedAdminClient(clinicId);
  const [inbound, outbound] = await Promise.all([
    client
      .from("inbound_messages")
      .select("id, body, received_at")
      .eq("conversation_id", conversationId)
      .order("received_at", { ascending: false })
      .limit(HISTORY_LIMIT),
    client
      .from("outbound_messages")
      .select("id, body_preview, created_at")
      .eq("related_type", "manual")
      .eq("related_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(HISTORY_LIMIT),
  ]);
  const merged = [
    ...(inbound.data ?? []).map((row) => ({
      role: "user" as const,
      at: row.received_at,
      text: row.body ?? "",
    })),
    ...(outbound.data ?? []).map((row) => ({
      role: "assistant" as const,
      at: row.created_at,
      text: row.body_preview ?? "",
    })),
  ]
    .filter((message) => message.text.trim().length > 0)
    .sort((a, b) => a.at.localeCompare(b.at))
    .slice(-HISTORY_LIMIT);
  return merged.map((message, index) => ({
    id: `${message.role}-${index}`,
    role: message.role,
    parts: [{ type: "text", text: message.text }],
  }));
}

/**
 * Entry point invoked (best-effort) from the WhatsApp webhook after a new
 * inbound patient message is persisted (§6.2). Resolves the clinic's effective
 * reply mode, handles deterministic human-escalation first, then runs the
 * certified P5A patient agent and either records a staff-approvable suggestion
 * (`suggest`) or sends the reply directly (`auto`). Never throws into the
 * webhook; every failure degrades to a human (§6.7).
 */
export async function runPatientInboundAiReply(
  input: {
    clinicId: string;
    conversationId: string;
    /** The provider message id of the triggering inbound turn (stable key). */
    providerMessageId: string;
    messageText: string;
  },
  deps: { runAgent?: PatientAgentRunner } = {},
): Promise<PatientAiReplyOutcome> {
  const runAgent = deps.runAgent ?? runCertifiedPatientAgent;
  const message = (input.messageText ?? "").trim();

  const entitlements = await getEntitlements(input.clinicId);
  const scoped = createClinicScopedAdminClient(input.clinicId);
  const clinicResult = await getClinicAiReplyContext(input.clinicId);
  const clinic = clinicResult.data as ClinicRow | null;
  if (!clinic) return { status: "failed" };

  const mode = resolveEffectiveAiReplyMode({
    clinicMode: normalizeClinicAiReplyMode(clinic.ai_reply_mode),
    entitlements,
  });
  if (mode === "off") return { status: "disabled", mode };

  const conversationResult = await scoped
    .from("conversations")
    .select("status, patient_id, participant_address, ai_escalated_at")
    .eq("id", input.conversationId)
    .maybeSingle();
  const conversation = conversationResult.data as ConversationRow | null;
  if (!conversation || conversation.status !== "open") {
    return { status: "skipped", reason: "conversation_unavailable" };
  }
  // A conversation already handed to a human stays with the human. The AI never
  // re-enters an escalated thread until staff resolve/reopen it.
  if (conversation.ai_escalated_at) {
    return { status: "skipped", reason: "already_escalated" };
  }
  if (!message) return { status: "skipped", reason: "empty_message" };

  const assignedResult = await scoped
    .from("conversations")
    .select("assigned_to")
    .eq("id", input.conversationId)
    .maybeSingle();
  const assignedTo = assignedResult.data?.assigned_to ?? null;
  const locale = patientCopyLocale(clinic.locale);
  const recipient = conversation.participant_address?.trim() || null;

  // The DB id of the triggering inbound message, for linking the suggestion
  // back to the thread. Best-effort: the reservation key uses the provider id.
  const inboundLookup = await scoped
    .from("inbound_messages")
    .select("id")
    .eq("conversation_id", input.conversationId)
    .eq("provider_message_id", input.providerMessageId)
    .maybeSingle();
  const inboundMessageId = inboundLookup.data?.id ?? null;

  async function sendPatientText(body: string): Promise<string | null> {
    if (!recipient) return null;
    const result = await sendMessage({
      clinicId: input.clinicId,
      recipient,
      body,
      relatedType: "manual",
      conversationId: input.conversationId,
      channelPreference: ["whatsapp"],
    });
    return result.ok ? result.outboundMessageId : null;
  }

  const detection: PatientEscalationDetection = detectPatientEscalation(message);
  if (detection.escalate && detection.reason) {
    const reason = detection.reason;
    const body = patientEscalationCopy(detection.emergency ? "emergency" : "handoff", {
      locale,
      clinicName: clinic.name,
      clinicPhone: clinic.phone,
      emergencyNumber: emergencyNumberForCountry(clinic.country),
    });
    // Emergencies always send the safety message immediately, regardless of
    // mode (§6.5). Other handoffs send only in auto mode; suggest mode leaves
    // the canned reply as a one-click staff suggestion.
    const sendNow = detection.emergency || mode === "auto";
    const outboundMessageId = sendNow ? await sendPatientText(body) : null;
    await escalateConversation({
      clinicId: input.clinicId,
      conversationId: input.conversationId,
      reason,
      assignedTo,
    });
    await recordSuggestion({
      clinicId: input.clinicId,
      conversationId: input.conversationId,
      inboundMessageId,
      mode: mode === "auto" ? "auto" : "suggest",
      body,
      status: sendNow ? "sent" : "pending",
      escalate: true,
      escalationReason: reason,
      outboundMessageId,
    });
    if (sendNow) await markConversationReplied(input.clinicId, input.conversationId);
    await logAgentTool({
      clinicId: input.clinicId,
      actorId: null,
      tool: "patient_escalation",
      params: { reason, mode, sent: Boolean(outboundMessageId) },
    });
    return { status: "escalated", reason, sent: Boolean(outboundMessageId) };
  }

  const task: Extract<AiTaskClass, "patient_booking" | "patient_faq"> =
    hasFeature(entitlements, AI_SCHEDULING_FEATURE) ? "patient_booking" : "patient_faq";
  const history = await loadHistory(input.clinicId, input.conversationId);

  let reply: { ok: boolean; text: string };
  try {
    reply = await runAgent({
      clinicId: input.clinicId,
      conversationId: input.conversationId,
      requestKey: input.providerMessageId,
      locale,
      task,
      messages: history,
    });
  } catch (error) {
    // A usage/entitlement/budget denial or provider failure degrades to a human
    // instead of leaving the patient unanswered (§6.7).
    if (!(error instanceof AiToolAuthorizationError)) {
      Sentry.captureException(error, { tags: { area: "patient-ai-reply" } });
    }
    reply = { ok: false, text: "" };
  }

  if (!reply.ok || !reply.text.trim()) {
    // Low confidence / no answer → escalate to a human (§6.2).
    await escalateConversation({
      clinicId: input.clinicId,
      conversationId: input.conversationId,
      reason: "low_confidence",
      assignedTo,
    });
    await logAgentTool({
      clinicId: input.clinicId,
      actorId: null,
      tool: "patient_escalation",
      params: { reason: "low_confidence", mode },
    });
    return { status: "escalated", reason: "low_confidence", sent: false };
  }

  const body = reply.text.trim();
  if (mode === "suggest") {
    const suggestionId = await recordSuggestion({
      clinicId: input.clinicId,
      conversationId: input.conversationId,
      inboundMessageId,
      mode: "suggest",
      body,
      status: "pending",
      escalate: false,
      escalationReason: null,
      outboundMessageId: null,
    });
    await emitClinicNotification({
      clinicId: input.clinicId,
      type: "ai_suggestion",
      link: `/inbox?conversation=${input.conversationId}`,
      data: { conversationId: input.conversationId },
      ...(assignedTo ? { recipientIds: [assignedTo] } : { roles: ["admin", "receptionist"] }),
      dedupeUnread: true,
    });
    await logAgentTool({
      clinicId: input.clinicId,
      actorId: null,
      tool: "patient_reply_suggested",
      params: { task },
    });
    return { status: "suggested", suggestionId };
  }

  // auto mode
  const outboundMessageId = await sendPatientText(body);
  const suggestionId = await recordSuggestion({
    clinicId: input.clinicId,
    conversationId: input.conversationId,
    inboundMessageId,
    mode: "auto",
    body,
    status: outboundMessageId ? "sent" : "pending",
    escalate: false,
    escalationReason: null,
    outboundMessageId,
  });
  if (outboundMessageId) {
    await markConversationReplied(input.clinicId, input.conversationId);
    await logAgentTool({
      clinicId: input.clinicId,
      actorId: null,
      tool: "patient_reply_auto",
      params: { task, sent: true },
    });
    return { status: "auto_sent", suggestionId, outboundMessageId };
  }
  // Send failed → leave the drafted reply pending for staff and escalate.
  await escalateConversation({
    clinicId: input.clinicId,
    conversationId: input.conversationId,
    reason: "agent_error",
    assignedTo,
  });
  return { status: "auto_sent", suggestionId, outboundMessageId: null };
}
