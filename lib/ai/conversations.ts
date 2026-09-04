import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { UIMessage } from "ai";
import type { AuthedUser } from "@/lib/rbac";
import {
  applyProposals,
  parseActiveContext,
  pendingActionConfirmations,
  withoutPendingActionConfirmation,
  withPendingActionConfirmations,
  type ActiveContext,
  type ActiveContextProposal,
} from "@/lib/ai/conversation-context";
import type { Database } from "@/types/database";

const HISTORY_LIMIT = 40;
/**
 * How many of the caller's own past conversations the history list offers.
 * Bounded because the list is a browsing affordance, not an export: older
 * conversations remain in the table (subject to the Phase 6 retention window)
 * and are reachable by continuing to work in them, not by paging back forever.
 */
export const CONVERSATION_LIST_LIMIT = 30;

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
  activeContext: ActiveContext;
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
    parts: unknown;
  }>,
): UIMessage[] {
  return rows.flatMap((row) =>
    row.role === "user" || row.role === "assistant"
      ? [{
          id: row.id,
          role: row.role,
          // Parts are server-written only and sanitized before persistence. The
          // text fallback preserves all legacy rows created before Phase 4.
          parts: Array.isArray(row.parts) && row.parts.length > 0
            ? row.parts as UIMessage["parts"]
            : [{ type: "text", text: row.content }],
        }]
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
    .select("id, role, content, parts, created_at, sequence")
    .eq("clinic_id", clinicId)
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .order("sequence", { ascending: false })
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
    .select("id, patient_id, title, active_context")
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
    activeContext: parseActiveContext(data.active_context),
  };
}

type PatientScopeRow = {
  id: string;
  assigned_doctor_id: string | null;
  department_id: string | null;
};

/**
 * The single predicate deciding whether a patient-bound conversation is still
 * the caller's to see. Extracted so the single-id assert and the batched list
 * filter below cannot drift apart — a conversation that would fail to *open*
 * must never be *listed*, or the history panel becomes a side channel for the
 * titles of conversations about patients the user has since lost access to.
 *
 * RLS is still the authority: the row is read through the caller's session
 * client, so `patients_select_role_scoped` has already narrowed it. This is the
 * same belt-and-braces re-check the original assert carried.
 */
function patientContextAuthorized(user: AuthedUser, patient: PatientScopeRow): boolean {
  if (user.role !== "doctor" && user.role !== "assistant") return false;
  if (user.role !== "doctor") return true;
  return (
    patient.assigned_doctor_id === user.id ||
    (Boolean(user.departmentId) && patient.department_id === user.departmentId)
  );
}

/**
 * Re-authorizes a patient context before a non-page server boundary may expose
 * conversation history for it. Launcher session requests are browser input,
 * so the patient page's earlier RLS check cannot be treated as authorization
 * for the later request.
 */
export async function assertDoctorPatientContextAccess(input: {
  supabase: AiClient;
  user: AuthedUser;
  patientId: string;
}): Promise<void> {
  if (input.user.role !== "doctor" && input.user.role !== "assistant") {
    throw new AiConversationError("invalid_patient_context");
  }

  const { data: patient, error: patientError } = await input.supabase
    .from("patients")
    .select("id, assigned_doctor_id, department_id")
    .eq("id", input.patientId)
    .eq("clinic_id", input.user.clinicId)
    .is("deleted_at", null)
    .maybeSingle();
  if (patientError || !patient) {
    throw new AiConversationError("invalid_patient_context");
  }
  if (!patientContextAuthorized(input.user, patient)) {
    throw new AiConversationError("invalid_patient_context");
  }
}

export type AssistantConversationSummary = {
  id: string;
  title: string | null;
  updatedAt: string;
  createdAt: string;
  /** UI-only marker that the conversation is bound to a patient record. */
  patientBound: boolean;
};

/**
 * The caller's own conversations, newest first.
 *
 * Scoped identically to every other read in this module — clinic, owner,
 * persona, active status, through the caller's RLS client — so it can only ever
 * list conversations the same user could already resume. Patient-bound rows are
 * re-authorized against the *current* patient scope in one batched read, and a
 * row that no longer resolves is dropped rather than shown with a denial, so the
 * list never asserts the existence of a record outside the caller's scope.
 *
 * The title is the user's own first message, already stored by `persistDoctorTurn`;
 * no new column, table, or persistence mechanism is introduced.
 */
export async function listAssistantConversations(input: {
  supabase: AiClient;
  user: AuthedUser;
  limit?: number;
}): Promise<AssistantConversationSummary[]> {
  const { data, error } = await input.supabase
    .from("agent_conversations")
    .select("id, title, patient_id, updated_at, created_at")
    .eq("clinic_id", input.user.clinicId)
    .eq("user_id", input.user.id)
    .eq("persona", "doctor")
    .eq("status", "active")
    .order("updated_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(Math.min(input.limit ?? CONVERSATION_LIST_LIMIT, CONVERSATION_LIST_LIMIT));
  if (error) throw new AiConversationError("persistence_failed");

  const rows = data ?? [];
  const patientIds = [
    ...new Set(
      rows.flatMap((row) => (row.patient_id ? [row.patient_id] : [])),
    ),
  ];
  const authorizedPatientIds = new Set<string>();
  if (patientIds.length > 0) {
    const { data: patients, error: patientError } = await input.supabase
      .from("patients")
      .select("id, assigned_doctor_id, department_id")
      .in("id", patientIds)
      .eq("clinic_id", input.user.clinicId)
      .is("deleted_at", null);
    if (patientError) throw new AiConversationError("persistence_failed");
    for (const patient of patients ?? []) {
      if (patientContextAuthorized(input.user, patient)) {
        authorizedPatientIds.add(patient.id);
      }
    }
  }

  return rows.flatMap((row) =>
    row.patient_id && !authorizedPatientIds.has(row.patient_id)
      ? []
      : [{
          id: row.id,
          title: row.title,
          updatedAt: row.updated_at,
          createdAt: row.created_at,
          patientBound: Boolean(row.patient_id),
        }],
  );
}

/**
 * Loads one of the caller's own conversations by id, with its persisted history.
 *
 * Returns null — never a denial — for an id that is not the caller's, is not an
 * active staff conversation, or is bound to a patient now outside their scope.
 * That keeps the boundary indistinguishable from not-found, matching the
 * `unauthorized_scope` contract the resource compiler uses.
 */
export async function loadAssistantConversationById(input: {
  supabase: AiClient;
  user: AuthedUser;
  conversationId: string;
}): Promise<LoadedDoctorConversation | null> {
  const { data, error } = await input.supabase
    .from("agent_conversations")
    .select("id, patient_id, title, active_context")
    .eq("id", input.conversationId)
    .eq("clinic_id", input.user.clinicId)
    .eq("user_id", input.user.id)
    .eq("persona", "doctor")
    .eq("status", "active")
    .maybeSingle();
  if (error) throw new AiConversationError("persistence_failed");
  if (!data) return null;

  if (data.patient_id) {
    try {
      await assertDoctorPatientContextAccess({
        supabase: input.supabase,
        user: input.user,
        patientId: data.patient_id,
      });
    } catch {
      return null;
    }
  }

  const history = await loadMessages(input.supabase, input.user.clinicId, data.id);
  return {
    id: data.id,
    patientId: data.patient_id,
    title: data.title,
    messages: history.messages,
    historyTruncated: history.truncated,
    activeContext: parseActiveContext(data.active_context),
  };
}

export async function ensureDoctorConversation(input: {
  supabase: AiClient;
  user: AuthedUser;
  conversationId: string;
  locale: "ar" | "en";
  patientId?: string | null;
}): Promise<{
  id: string;
  patientId: string | null;
  messages: UIMessage[];
  activeContext: ActiveContext;
}> {
  const { data: existing, error: existingError } = await input.supabase
    .from("agent_conversations")
    .select("id, patient_id, active_context")
    .eq("id", input.conversationId)
    .eq("clinic_id", input.user.clinicId)
    .eq("user_id", input.user.id)
    .eq("persona", "doctor")
    .eq("status", "active")
    .maybeSingle();

  if (existingError) throw new AiConversationError("persistence_failed");
  const requestedPatientId = input.patientId ?? null;

  if (
    requestedPatientId &&
    input.user.role !== "doctor" &&
    input.user.role !== "assistant"
  ) {
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
      activeContext: parseActiveContext(existing.active_context),
    };
  }

  if (requestedPatientId) {
    await assertDoctorPatientContextAccess({
      supabase: input.supabase,
      user: input.user,
      patientId: requestedPatientId,
    });
  }

  // Keep a first turn virtual until the model completes. This prevents an abort
  // or model/tool error from leaving an empty conversation row behind. No row
  // exists yet, so there is no persisted active context; a patient-bound turn
  // still resolves its default from the requested patient id via the route.
  return {
    id: input.conversationId,
    patientId: requestedPatientId,
    messages: [],
    activeContext: {},
  };
}

/**
 * Removes only the confirmation that was successfully consumed. The update is
 * owner/clinic scoped through the caller's RLS client; a conversation archived
 * or deleted between execution and cleanup is treated as already moved on.
 */
export async function clearPendingActionConfirmation(input: {
  supabase: AiClient;
  user: AuthedUser;
  conversationId: string;
  actionId: string;
  expiresAt: string;
}): Promise<void> {
  const { data: conversation, error: conversationError } = await input.supabase
    .from("agent_conversations")
    .select("id, active_context")
    .eq("id", input.conversationId)
    .eq("clinic_id", input.user.clinicId)
    .eq("user_id", input.user.id)
    .eq("persona", "doctor")
    .eq("status", "active")
    .maybeSingle();
  if (conversationError) throw new AiConversationError("persistence_failed");
  if (!conversation) return;

  const currentContext = parseActiveContext(conversation.active_context);
  const nextContext = withoutPendingActionConfirmation(currentContext, {
    action_id: input.actionId,
    expires_at: input.expiresAt,
  });
  if (JSON.stringify(nextContext) === JSON.stringify(currentContext)) return;

  const { error: updateError } = await input.supabase
    .from("agent_conversations")
    .update({
      active_context:
        nextContext as Database["public"]["Tables"]["agent_conversations"]["Update"]["active_context"],
    })
    .eq("id", input.conversationId)
    .eq("clinic_id", input.user.clinicId)
    .eq("user_id", input.user.id)
    .eq("persona", "doctor")
    .eq("status", "active");
  if (updateError) throw new AiConversationError("persistence_failed");
}

export async function persistDoctorTurn(input: {
  supabase: AiClient;
  user: AuthedUser;
  conversationId: string;
  locale: "ar" | "en";
  patientId: string | null;
  userText: string;
  assistantText: string;
  /** Sanitized UI parts from the completed assistant message (Phase 4). */
  assistantParts?: UIMessage["parts"];
  /**
   * A server-derived active-context proposal recorded by a tool during the turn
   * (P4.10A), e.g. a high-confidence patient resolution. Applied to the row's
   * session context once, here, so the next turn resolves the same entity.
   */
  contextProposal?: ActiveContextProposal | null;
  /** P4.10B may resolve more than one entity type during the same turn. */
  contextProposals?: readonly ActiveContextProposal[];
  pendingConfirmations?: readonly import("@/lib/ai/conversation-context").PendingActionConfirmation[];
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
    .select("id, patient_id, active_context")
    .eq("id", input.conversationId)
    .eq("clinic_id", input.user.clinicId)
    .eq("user_id", input.user.id)
    .eq("persona", "doctor")
    .eq("status", "active")
    .maybeSingle();
  if (conversationError || !conversation || conversation.patient_id !== input.patientId) {
    throw new AiConversationError("persistence_failed");
  }

  // P4.10A: fold a tool's active-context proposal (e.g. a high-confidence
  // patient resolution) into the persisted slot, so the next turn resolves the
  // same entity. The id is server-derived from an RLS-authorized lookup, never
  // asserted by the model. A patient-bound conversation needs no slot written
  // here: its active patient is the re-authorized `patient_id` column, which the
  // route uses as the default when no conversational slot exists. A turn with no
  // proposal leaves the stored context untouched.
  const currentContext = parseActiveContext(conversation.active_context);
  const proposals = input.contextProposals ??
    (input.contextProposal ? [input.contextProposal] : []);
  const currentPending = pendingActionConfirmations(currentContext);
  const incomingPending = input.pendingConfirmations ?? [];
  const mergedPending = [...currentPending, ...incomingPending].filter(
    (item, index, items) =>
      items.findIndex(
        (candidate) =>
          candidate.action_id === item.action_id &&
          candidate.expires_at === item.expires_at,
      ) === index,
  );
  const nextContext = withPendingActionConfirmations(
    applyProposals(currentContext, proposals),
    mergedPending,
  );
  const contextChanged =
    JSON.stringify(nextContext) !== JSON.stringify(currentContext);

  const rows: Database["public"]["Tables"]["agent_messages"]["Insert"][] = [
    {
      conversation_id: input.conversationId,
      clinic_id: input.user.clinicId,
      role: "user",
      content: input.userText,
      parts: [{ type: "text", text: input.userText }],
    },
  ];
  if (input.assistantText.trim() || (input.pendingConfirmations?.length ?? 0) > 0) {
    rows.push({
      conversation_id: input.conversationId,
      clinic_id: input.user.clinicId,
      role: "assistant",
      content: input.assistantText.trim(),
      parts: input.assistantParts as Database["public"]["Tables"]["agent_messages"]["Insert"]["parts"],
    });
  }

  const { error: messageError } = await input.supabase
    .from("agent_messages")
    .insert(rows);
  if (messageError) throw new AiConversationError("persistence_failed");

  const { error: touchError } = await input.supabase
    .from("agent_conversations")
    .update({
      updated_at: new Date().toISOString(),
      ...(contextChanged
        ? { active_context: nextContext as Database["public"]["Tables"]["agent_conversations"]["Update"]["active_context"] }
        : {}),
    })
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
