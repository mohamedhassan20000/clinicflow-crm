"use server";

import * as Sentry from "@sentry/nextjs";
import { z } from "zod";
import { authorizeStaffAssistant } from "@/lib/ai/authorization";
import {
  listAssistantConversations,
  loadAssistantConversationById,
  type AssistantConversationSummary,
} from "@/lib/ai/conversations";
import type { ActiveContext } from "@/lib/ai/conversation-context";
import type { StaffAssistantUIMessage } from "@/lib/ai/staff-agent";
import { checkRateLimit } from "@/lib/rate-limit";
import { createClient } from "@/lib/supabase/server";

/**
 * Conversation history for the staff Assistant.
 *
 * Both the `/assistant` page and every contextual "Ask Assistant" launcher use
 * these two actions — there is deliberately no second history mechanism. They
 * read the same `agent_conversations` / `agent_messages` rows the streaming
 * route already writes, through the caller's own RLS client, and grant nothing:
 * a listed conversation is one the caller could already resume by id, and the
 * chat route re-authorizes the conversation, its patient binding, the tool
 * mount, the entitlement and every action on the next turn regardless.
 */

const openSchema = z.object({ conversationId: z.string().uuid() }).strict();

export type AssistantConversationListResult =
  | { success: true; conversations: AssistantConversationSummary[] }
  | { success: false; reason: "rate_limited" | "unavailable" };

export type AssistantConversationOpenResult =
  | {
      success: true;
      conversation: {
        id: string;
        title: string | null;
        patientId: string | null;
        messages: StaffAssistantUIMessage[];
        activeContext: ActiveContext;
        historyTruncated: boolean;
      };
    }
  | { success: false; reason: "invalid_selection" | "not_found" | "rate_limited" | "unavailable" };

async function historyReadAllowed(clinicId: string, userId: string): Promise<boolean> {
  const result = await checkRateLimit(
    "assistant-conversation-history",
    `${clinicId}:${userId}`,
    { limit: 60, windowSeconds: 60, failureMode: "open" },
  );
  return result.allowed;
}

export async function listAssistantConversationHistory(): Promise<AssistantConversationListResult> {
  const user = await authorizeStaffAssistant();
  if (!(await historyReadAllowed(user.clinicId, user.id))) {
    return { success: false, reason: "rate_limited" };
  }
  try {
    return {
      success: true,
      conversations: await listAssistantConversations({
        supabase: await createClient(),
        user,
      }),
    };
  } catch (error) {
    Sentry.captureException(error, {
      tags: { area: "assistant-conversation-history" },
      extra: { clinicId: user.clinicId, role: user.role },
    });
    return { success: false, reason: "unavailable" };
  }
}

export async function openAssistantConversation(
  input: unknown,
): Promise<AssistantConversationOpenResult> {
  const parsed = openSchema.safeParse(input);
  if (!parsed.success) return { success: false, reason: "invalid_selection" };

  const user = await authorizeStaffAssistant();
  if (!(await historyReadAllowed(user.clinicId, user.id))) {
    return { success: false, reason: "rate_limited" };
  }
  try {
    const conversation = await loadAssistantConversationById({
      supabase: await createClient(),
      user,
      conversationId: parsed.data.conversationId,
    });
    // Indistinguishable from not-found for an id that is not the caller's or
    // whose patient binding no longer resolves, matching the resource
    // compiler's `unauthorized_scope` contract.
    if (!conversation) return { success: false, reason: "not_found" };
    return {
      success: true,
      conversation: {
        id: conversation.id,
        title: conversation.title,
        patientId: conversation.patientId,
        messages: conversation.messages as StaffAssistantUIMessage[],
        activeContext: conversation.activeContext,
        historyTruncated: conversation.historyTruncated,
      },
    };
  } catch (error) {
    Sentry.captureException(error, {
      tags: { area: "assistant-conversation-open" },
      extra: { clinicId: user.clinicId, role: user.role },
    });
    return { success: false, reason: "unavailable" };
  }
}
