import "server-only";
import { createClient } from "@/lib/supabase/server";
import type { AuthedUser } from "@/lib/rbac";
import type { Database, Json } from "@/types/database";

export type InboxConversation = {
  id: string;
  channel: Database["public"]["Enums"]["message_channel"];
  status: Database["public"]["Enums"]["conversation_status"];
  patientId: string | null;
  patientName: string | null;
  patientPhone: string | null;
  patientFileNumber: string | null;
  sender: string | null;
  assignedTo: string | null;
  assignedName: string | null;
  lastMessageAt: string | null;
  lastInboundAt: string | null;
  windowExpiresAt: string | null;
  identityVerifiedAt: string | null;
  escalatedAt: string | null;
  escalationReason: string | null;
  preview: string;
  unreadCount: number;
};

export type InboxSuggestion = {
  id: string;
  conversationId: string;
  body: string;
  escalate: boolean;
  escalationReason: string | null;
  createdAt: string;
};

export type InboxThreadMessage = {
  id: string;
  direction: "inbound" | "outbound";
  body: string;
  occurredAt: string;
  status: Database["public"]["Enums"]["outbound_message_status"] | null;
  templateId: string | null;
};

export type InboxPersonOption = {
  id: string;
  name: string;
};

export type InboxPatientOption = InboxPersonOption & {
  phone: string;
  fileNumber: string;
};

export type InboxTemplate = {
  id: string;
  name: string;
  language: string;
  body: string;
  variableNames: string[];
};

export type InboxData = {
  conversations: InboxConversation[];
  messages: InboxThreadMessage[];
  assignees: InboxPersonOption[];
  patients: InboxPatientOption[];
  templates: InboxTemplate[];
  suggestion: InboxSuggestion | null;
  selectedConversationId: string | null;
  loadedAt: string;
  error: boolean;
};

type SummaryRow =
  Database["public"]["Functions"]["get_inbox_conversation_summaries"]["Returns"][number];

function variableNames(value: Json): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function emptyInbox(error: boolean): InboxData {
  return {
    conversations: [],
    messages: [],
    assignees: [],
    patients: [],
    templates: [],
    suggestion: null,
    selectedConversationId: null,
    loadedAt: new Date().toISOString(),
    error,
  };
}

function requestedUuid(value: string | undefined): string | null {
  return value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null;
}

export async function loadInboxData(
  user: AuthedUser,
  requestedConversationId?: string,
): Promise<InboxData> {
  const supabase = await createClient();
  const [summaryResult, assigneeResult, patientResult, templateResult] =
    await Promise.all([
      supabase.rpc("get_inbox_conversation_summaries", {
        p_requested_conversation_id: requestedUuid(requestedConversationId),
        p_limit: 100,
      }),
      supabase
        .from("profiles")
        .select("id, full_name")
        .eq("clinic_id", user.clinicId)
        .in("role", ["admin", "receptionist"])
        .eq("is_active", true)
        .eq("is_deleted", false)
        .is("deleted_at", null)
        .order("full_name"),
      supabase
        .from("patients")
        .select("id, full_name, phone, file_number")
        .eq("clinic_id", user.clinicId)
        .eq("is_deleted", false)
        .is("deleted_at", null)
        .order("full_name")
        .limit(500),
      supabase
        .from("message_templates")
        .select("id, name, language, body, variables")
        .eq("clinic_id", user.clinicId)
        .eq("channel", "whatsapp")
        .eq("approval_status", "approved")
        .order("name"),
    ]);

  if (
    summaryResult.error ||
    assigneeResult.error ||
    patientResult.error ||
    templateResult.error
  ) {
    return emptyInbox(true);
  }

  const summaryRows = (summaryResult.data ?? []) as SummaryRow[];
  const selectedConversationId =
    (requestedConversationId && summaryRows.some((item) => item.id === requestedConversationId)
      ? requestedConversationId
      : summaryRows[0]?.id) ?? null;

  // P5B (§5.4, §6.2): the summary RPC returns no identity/escalation state, so
  // read those conversation columns directly for the visible threads. RLS keeps
  // this to the caller's clinic and the inbox roles.
  const conversationIds = summaryRows.map((row) => row.id);
  const metaResult = conversationIds.length
    ? await supabase
        .from("conversations")
        .select("id, identity_verified_at, ai_escalated_at, ai_escalation_reason")
        .eq("clinic_id", user.clinicId)
        .in("id", conversationIds)
    : { data: [], error: null };
  if (metaResult.error) return emptyInbox(true);
  const metaById = new Map(
    (metaResult.data ?? []).map((row) => [row.id, row]),
  );

  const [inboundResult, outboundResult] = selectedConversationId
    ? await Promise.all([
        supabase
          .from("inbound_messages")
          .select("id, conversation_id, body, sender, received_at")
          .eq("clinic_id", user.clinicId)
          .eq("conversation_id", selectedConversationId)
          .order("received_at", { ascending: true }),
        supabase
          .from("outbound_messages")
          .select("id, related_id, body_preview, created_at, status, template_id")
          .eq("clinic_id", user.clinicId)
          .eq("related_type", "manual")
          .eq("related_id", selectedConversationId)
          .order("created_at", { ascending: true }),
      ])
    : [
        { data: [], error: null },
        { data: [], error: null },
      ];

  if (inboundResult.error || outboundResult.error) {
    return emptyInbox(true);
  }

  const optionPatients = patientResult.data ?? [];
  const optionPatientIds = new Set(optionPatients.map((patient) => patient.id));
  const missingLinkedPatientIds = [...new Set(
    summaryRows
      .map((row) => row.patient_id)
      .filter((id): id is string => Boolean(id) && !optionPatientIds.has(id!)),
  )];
  const linkedPatientResult = missingLinkedPatientIds.length
    ? await supabase
        .from("patients")
        .select("id, full_name, phone, file_number")
        .eq("clinic_id", user.clinicId)
        .in("id", missingLinkedPatientIds)
    : { data: [], error: null };
  if (linkedPatientResult.error) return emptyInbox(true);

  const patientsById = new Map(
    [...optionPatients, ...(linkedPatientResult.data ?? [])].map((patient) => [patient.id, patient]),
  );
  const assigneesById = new Map(
    (assigneeResult.data ?? []).map((assignee) => [assignee.id, assignee.full_name]),
  );

  const conversations = summaryRows.map((row) => {
    const patient = row.patient_id ? patientsById.get(row.patient_id) : null;
    const meta = metaById.get(row.id);
    return {
      id: row.id,
      channel: row.channel,
      status: row.status,
      patientId: row.patient_id,
      patientName: patient?.full_name ?? null,
      patientPhone: patient?.phone ?? null,
      patientFileNumber: patient?.file_number ?? null,
      sender: row.participant_address,
      assignedTo: row.assigned_to,
      assignedName: row.assigned_to ? assigneesById.get(row.assigned_to) ?? null : null,
      lastMessageAt: row.last_message_at,
      lastInboundAt: row.last_inbound_at,
      windowExpiresAt: row.window_expires_at,
      identityVerifiedAt: meta?.identity_verified_at ?? null,
      escalatedAt: meta?.ai_escalated_at ?? null,
      escalationReason: meta?.ai_escalation_reason ?? null,
      preview: row.preview,
      unreadCount: Number(row.unread_count),
    } satisfies InboxConversation;
  });

  const suggestionResult = selectedConversationId
    ? await supabase
        .from("ai_suggested_replies")
        .select("id, conversation_id, body, escalate, escalation_reason, created_at")
        .eq("clinic_id", user.clinicId)
        .eq("conversation_id", selectedConversationId)
        .eq("status", "pending")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle()
    : { data: null, error: null };
  const suggestion: InboxSuggestion | null =
    suggestionResult.data && !suggestionResult.error
      ? {
          id: suggestionResult.data.id,
          conversationId: suggestionResult.data.conversation_id,
          body: suggestionResult.data.body,
          escalate: suggestionResult.data.escalate,
          escalationReason: suggestionResult.data.escalation_reason,
          createdAt: suggestionResult.data.created_at,
        }
      : null;

  const messages: InboxThreadMessage[] = [
    ...(inboundResult.data ?? [])
      .filter((message) => message.conversation_id === selectedConversationId)
      .map((message) => ({
        id: message.id,
        direction: "inbound" as const,
        body: message.body,
        occurredAt: message.received_at,
        status: null,
        templateId: null,
      })),
    ...(outboundResult.data ?? [])
      .filter((message) => message.related_id === selectedConversationId)
      .map((message) => ({
        id: message.id,
        direction: "outbound" as const,
        body: message.body_preview ?? "",
        occurredAt: message.created_at,
        status: message.status,
        templateId: message.template_id,
      })),
  ].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));

  return {
    conversations,
    messages,
    assignees: (assigneeResult.data ?? []).map((assignee) => ({
      id: assignee.id,
      name: assignee.full_name,
    })),
    patients: optionPatients.map((patient) => ({
      id: patient.id,
      name: patient.full_name,
      phone: patient.phone,
      fileNumber: patient.file_number,
    })),
    templates: (templateResult.data ?? []).map((template) => ({
      id: template.id,
      name: template.name,
      language: template.language,
      body: template.body,
      variableNames: variableNames(template.variables),
    })),
    suggestion,
    selectedConversationId,
    loadedAt: new Date().toISOString(),
    error: false,
  };
}
