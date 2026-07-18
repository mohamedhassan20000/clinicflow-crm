import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { UIMessage } from "ai";
import type { AuthedUser } from "@/lib/rbac";
import type { Database } from "@/types/database";

const HISTORY_LIMIT = 40;

type AiClient = SupabaseClient<Database>;

export class AiConversationError extends Error {
  constructor(
    public readonly reason:
      | "conversation_unavailable"
      | "invalid_patient_context"
      | "persistence_failed",
  ) {
    super(reason);
    this.name = "AiConversationError";
  }
}

export type LoadedDoctorConversation = {
  id: string;
  patientId: string | null;
  title: string | null;
  messages: UIMessage[];
  historyTruncated: boolean;
};

type LoadedMessageHistory = {
  messages: UIMessage[];
  truncated: boolean;
};

function toUiMessages(
  rows: Array<{
    id: string;
    role: Database["public"]["Enums"]["agent_message_role"];
    content: string;
  }>,
): UIMessage[] {
  return rows.flatMap((row) =>
    row.role === "user" || row.role === "assistant"
      ? [{ id: row.id, role: row.role, parts: [{ type: "text", text: row.content }] }]
      : [],
  );
}

async function loadMessages(
  supabase: AiClient,
  clinicId: string,
  conversationId: string,
): Promise<LoadedMessageHistory> {
  const { data, error } = await supabase
    .from("agent_messages")
    .select("id, role, content, created_at")
    .eq("clinic_id", clinicId)
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(HISTORY_LIMIT + 1);

  if (error) throw new AiConversationError("persistence_failed");
  const rows = data ?? [];
  return {
    messages: toUiMessages(rows.slice(0, HISTORY_LIMIT).toReversed()),
    truncated: rows.length > HISTORY_LIMIT,
  };
}

export async function loadLatestDoctorConversation(input: {
  supabase: AiClient;
  user: AuthedUser;
  patientId?: string | null;
}): Promise<LoadedDoctorConversation | null> {
  let query = input.supabase
    .from("agent_conversations")
    .select("id, patient_id, title")
    .eq("clinic_id", input.user.clinicId)
    .eq("user_id", input.user.id)
    .eq("persona", "doctor")
    .eq("status", "active")
    .order("updated_at", { ascending: false })
    .limit(1);

  query = input.patientId
    ? query.eq("patient_id", input.patientId)
    : query.is("patient_id", null);

  const { data, error } = await query.maybeSingle();
  if (error) throw new AiConversationError("persistence_failed");
  if (!data) return null;

  const history = await loadMessages(input.supabase, input.user.clinicId, data.id);
  return {
    id: data.id,
    patientId: data.patient_id,
    title: data.title,
    messages: history.messages,
    historyTruncated: history.truncated,
  };
}

export async function ensureDoctorConversation(input: {
  supabase: AiClient;
  user: AuthedUser;
  conversationId: string;
  locale: "ar" | "en";
  patientId?: string | null;
}): Promise<{ id: string; patientId: string | null; messages: UIMessage[] }> {
  const { data: existing, error: existingError } = await input.supabase
    .from("agent_conversations")
    .select("id, patient_id")
    .eq("id", input.conversationId)
    .eq("clinic_id", input.user.clinicId)
    .eq("user_id", input.user.id)
    .eq("persona", "doctor")
    .eq("status", "active")
    .maybeSingle();

  if (existingError) throw new AiConversationError("persistence_failed");
  const requestedPatientId = input.patientId ?? null;

  if (requestedPatientId && input.user.role !== "doctor") {
    throw new AiConversationError("invalid_patient_context");
  }

  if (existing) {
    if (existing.patient_id !== requestedPatientId) {
      throw new AiConversationError("invalid_patient_context");
    }
    const history = await loadMessages(input.supabase, input.user.clinicId, existing.id);
    return {
      id: existing.id,
      patientId: existing.patient_id,
      messages: history.messages,
    };
  }

  if (requestedPatientId) {
    const { data: patient, error: patientError } = await input.supabase
      .from("patients")
      .select("id, assigned_doctor_id, department_id")
      .eq("id", requestedPatientId)
      .eq("clinic_id", input.user.clinicId)
      .is("deleted_at", null)
      .maybeSingle();
    if (patientError || !patient) {
      throw new AiConversationError("invalid_patient_context");
    }
    if (
      input.user.role === "doctor" &&
      patient.assigned_doctor_id !== input.user.id &&
      (!input.user.departmentId || patient.department_id !== input.user.departmentId)
    ) {
      throw new AiConversationError("invalid_patient_context");
    }
  }

  // Keep a first turn virtual until the model completes. This prevents an abort
  // or model/tool error from leaving an empty conversation row behind.
  return { id: input.conversationId, patientId: requestedPatientId, messages: [] };
}

export async function persistDoctorTurn(input: {
  supabase: AiClient;
  user: AuthedUser;
  conversationId: string;
  locale: "ar" | "en";
  patientId: string | null;
  userText: string;
  assistantText: string;
}): Promise<void> {
  const { error: createError } = await input.supabase
    .from("agent_conversations")
    .upsert(
      {
        id: input.conversationId,
        clinic_id: input.user.clinicId,
        user_id: input.user.id,
        patient_id: input.patientId,
        persona: "doctor",
        locale: input.locale,
      },
      { onConflict: "id", ignoreDuplicates: true },
    );
  if (createError) throw new AiConversationError("persistence_failed");

  // A concurrent first turn may have inserted the same client-generated id.
  // Re-select it through the normal owner/clinic/persona scope before writing.
  const { data: conversation, error: conversationError } = await input.supabase
    .from("agent_conversations")
    .select("id, patient_id")
    .eq("id", input.conversationId)
    .eq("clinic_id", input.user.clinicId)
    .eq("user_id", input.user.id)
    .eq("persona", "doctor")
    .eq("status", "active")
    .maybeSingle();
  if (conversationError || !conversation || conversation.patient_id !== input.patientId) {
    throw new AiConversationError("persistence_failed");
  }

  const rows: Database["public"]["Tables"]["agent_messages"]["Insert"][] = [
    {
      conversation_id: input.conversationId,
      clinic_id: input.user.clinicId,
      role: "user",
      content: input.userText,
    },
  ];
  if (input.assistantText.trim()) {
    rows.push({
      conversation_id: input.conversationId,
      clinic_id: input.user.clinicId,
      role: "assistant",
      content: input.assistantText.trim(),
    });
  }

  const { error: messageError } = await input.supabase
    .from("agent_messages")
    .insert(rows);
  if (messageError) throw new AiConversationError("persistence_failed");

  const { error: touchError } = await input.supabase
    .from("agent_conversations")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", input.conversationId)
    .eq("clinic_id", input.user.clinicId)
    .eq("user_id", input.user.id);
  if (touchError) throw new AiConversationError("persistence_failed");

  const { error: titleError } = await input.supabase
    .from("agent_conversations")
    .update({ title: input.userText.trim().slice(0, 120) })
    .eq("id", input.conversationId)
    .eq("clinic_id", input.user.clinicId)
    .eq("user_id", input.user.id)
    .is("title", null);
  if (titleError) throw new AiConversationError("persistence_failed");
}
