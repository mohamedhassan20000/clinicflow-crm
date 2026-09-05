import "server-only";

import { parseActiveContext } from "@/lib/ai/conversation-context";
import { DETACHED_RESOLVER_CONTEXT } from "@/lib/ai/actions/types";
import type { ActionResolverContext } from "@/lib/ai/actions/types";
import type { AuthedUser } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";

/**
 * P6-07 — resolves the conversation-scoped defaults an action may fill from.
 *
 * The two phases of the confirmation pipeline run in different surfaces: the
 * preview is invoked from the chat route's `execute_action` tool, which holds a
 * fully-hydrated `DoctorToolContext`, while the execute is invoked from the
 * `confirmAssistantAction` server action, which holds only the conversation id.
 * Passing the tool's context through the model would make it model-supplied, so
 * both phases instead read it here from the conversation row itself, on the
 * caller's own RLS-scoped session client. What the preview auto-filled is
 * therefore exactly what the execute sees.
 *
 * Fails soft to the detached context: a lookup failure means "no server-derived
 * default available", which makes the action ask rather than guess. It can never
 * widen access — every id is re-authorized by the resolver that consumes it.
 */
export async function resolveActionResolverContext(
  user: AuthedUser,
  conversationId: string,
): Promise<ActionResolverContext> {
  const base: ActionResolverContext = {
    ...DETACHED_RESOLVER_CONTEXT,
    conversationId,
  };
  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("agent_conversations")
      .select("locale, active_context")
      .eq("id", conversationId)
      .eq("clinic_id", user.clinicId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (error || !data) return base;
    const active = parseActiveContext(data.active_context);
    return {
      conversationId,
      locale: data.locale === "ar" ? "ar" : "en",
      activePatientId: active.patient?.entity_id ?? null,
      activeAppointmentId: active.appointment?.entity_id ?? null,
    };
  } catch {
    return base;
  }
}
