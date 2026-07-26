"use server";

import { revalidatePath } from "next/cache";
import { getLocale } from "next-intl/server";
import { z } from "zod";
import {
  assertAnalyticsToolAccess,
  assertFinancialInsightsAccess,
  authorizeStaffAssistant,
} from "@/lib/ai/authorization";
import {
  ACTIVE_CONTEXT_ENTITY_TYPES,
  applyProposal,
  clearActiveEntityContext,
  parseActiveContext,
  type ActiveContext,
  type ActiveContextEntityType,
} from "@/lib/ai/conversation-context";
import {
  clinicReportLabel,
  CLINIC_REPORT_IDS,
  CLINIC_REPORTS,
} from "@/lib/ai/clinic-reports";
import { checkRateLimit } from "@/lib/rate-limit";
import { createClient } from "@/lib/supabase/server";
import type { Database } from "@/types/database";

const entityTypeSchema = z.enum(ACTIVE_CONTEXT_ENTITY_TYPES);
const conversationSchema = z.object({
  conversationId: z.string().uuid(),
  entityType: entityTypeSchema,
}).strict();
const choiceSchema = conversationSchema.extend({
  entityId: z.string().min(1).max(120),
}).strict();

export type AssistantContextActionResult =
  | { success: true; activeContext: ActiveContext }
  | {
      success: false;
      reason:
        | "invalid_selection"
        | "not_found"
        | "rate_limited"
        | "update_failed";
    };

type Client = Awaited<ReturnType<typeof createClient>>;
type AuthorizedUser = Awaited<ReturnType<typeof authorizeStaffAssistant>>;

async function contextMutationAllowed(user: AuthorizedUser): Promise<boolean> {
  const result = await checkRateLimit(
    "assistant-context-mutation",
    `${user.clinicId}:${user.id}`,
    { limit: 30, windowSeconds: 60, failureMode: "open" },
  );
  return result.allowed;
}

async function loadOwnedConversation(
  client: Client,
  user: AuthorizedUser,
  conversationId: string,
) {
  return client
    .from("agent_conversations")
    .select("id, active_context")
    .eq("id", conversationId)
    .eq("clinic_id", user.clinicId)
    .eq("user_id", user.id)
    .eq("persona", "doctor")
    .eq("status", "active")
    .maybeSingle();
}

async function persistContext(
  client: Client,
  user: AuthorizedUser,
  conversationId: string,
  activeContext: ActiveContext,
): Promise<AssistantContextActionResult> {
  const { data, error } = await client
    .from("agent_conversations")
    .update({
      active_context:
        activeContext as Database["public"]["Tables"]["agent_conversations"]["Update"]["active_context"],
      updated_at: new Date().toISOString(),
    })
    .eq("id", conversationId)
    .eq("clinic_id", user.clinicId)
    .eq("user_id", user.id)
    .eq("persona", "doctor")
    .eq("status", "active")
    .select("id")
    .maybeSingle();

  if (error || !data) return { success: false, reason: "update_failed" };
  revalidatePath("/assistant");
  return { success: true, activeContext };
}

/**
 * Clears one UI-visible context slot from the caller's own active conversation.
 * It changes no clinical/business row and grants no access.
 */
export async function clearAssistantConversationContext(
  input: unknown,
): Promise<AssistantContextActionResult> {
  const parsed = conversationSchema.safeParse(input);
  if (!parsed.success) return { success: false, reason: "invalid_selection" };

  const user = await authorizeStaffAssistant();
  if (!(await contextMutationAllowed(user))) {
    return { success: false, reason: "rate_limited" };
  }
  const client = await createClient();
  const { data, error } = await loadOwnedConversation(
    client,
    user,
    parsed.data.conversationId,
  );
  if (error || !data) return { success: false, reason: "not_found" };

  const next = clearActiveEntityContext(
    parseActiveContext(data.active_context),
    parsed.data.entityType,
  );
  return persistContext(client, user, parsed.data.conversationId, next);
}

async function resolveChoiceLabel(
  client: Client,
  user: AuthorizedUser,
  entityType: ActiveContextEntityType,
  entityId: string,
): Promise<string | null> {
  switch (entityType) {
    case "patient": {
      const parsedId = z.string().uuid().safeParse(entityId);
      if (!parsedId.success) return null;
      const { data, error } = await client
        .from("patients")
        .select("full_name")
        .eq("id", parsedId.data)
        .eq("clinic_id", user.clinicId)
        .is("deleted_at", null)
        .maybeSingle();
      return error ? null : data?.full_name ?? null;
    }
    case "appointment": {
      const parsedId = z.string().uuid().safeParse(entityId);
      if (!parsedId.success) return null;
      const { data, error } = await client
        .from("appointments")
        .select("scheduled_at, patients(full_name)")
        .eq("id", parsedId.data)
        .eq("clinic_id", user.clinicId)
        .is("deleted_at", null)
        .maybeSingle();
      if (error || !data) return null;
      return [data.patients?.full_name, data.scheduled_at]
        .filter(Boolean)
        .join(" · ");
    }
    case "invoice": {
      const parsedId = z.string().uuid().safeParse(entityId);
      if (!parsedId.success) return null;
      await assertFinancialInsightsAccess(user);
      const { data, error } = await client
        .from("appointments")
        .select("outstanding_amount, patients(full_name)")
        .eq("id", parsedId.data)
        .eq("clinic_id", user.clinicId)
        .eq("status", "completed")
        .gt("outstanding_amount", 0)
        .is("deleted_at", null)
        .maybeSingle();
      if (error || !data) return null;
      return data.patients?.full_name
        ? `${data.patients.full_name} · ${Number(data.outstanding_amount)}`
        : String(Number(data.outstanding_amount));
    }
    case "staff": {
      const parsedId = z.string().uuid().safeParse(entityId);
      if (!parsedId.success) return null;
      await assertAnalyticsToolAccess(user);
      const { data, error } = await client
        .from("profiles")
        .select("full_name")
        .eq("id", parsedId.data)
        .eq("clinic_id", user.clinicId)
        .eq("is_active", true)
        .eq("is_deleted", false)
        .is("deleted_at", null)
        .maybeSingle();
      return error ? null : data?.full_name ?? null;
    }
    case "department": {
      const parsedId = z.string().uuid().safeParse(entityId);
      if (!parsedId.success) return null;
      await assertAnalyticsToolAccess(user);
      const { data, error } = await client
        .from("departments")
        .select("name")
        .eq("id", parsedId.data)
        .eq("clinic_id", user.clinicId)
        .eq("is_active", true)
        .is("deleted_at", null)
        .maybeSingle();
      return error ? null : data?.name ?? null;
    }
    case "report": {
      const parsedId = z.enum(CLINIC_REPORT_IDS).safeParse(entityId);
      if (!parsedId.success) return null;
      const report = CLINIC_REPORTS[parsedId.data];
      if (!(report.roles as readonly string[]).includes(user.role)) return null;
      if (report.financial) {
        await assertFinancialInsightsAccess(user);
      } else {
        await assertAnalyticsToolAccess(user);
      }
      return clinicReportLabel(parsedId.data, (await getLocale()) === "ar" ? "ar" : "en");
    }
  }
}

/**
 * Applies an explicit clarification choice. The browser supplies only the
 * candidate identity; the server re-reads it through the authenticated RLS
 * client, re-runs the matching tool gate, and derives the canonical UI label.
 * A forged/cross-clinic/stale id therefore cannot become stored context.
 */
export async function chooseAssistantConversationContext(
  input: unknown,
): Promise<AssistantContextActionResult> {
  const parsed = choiceSchema.safeParse(input);
  if (!parsed.success) return { success: false, reason: "invalid_selection" };

  const user = await authorizeStaffAssistant();
  if (!(await contextMutationAllowed(user))) {
    return { success: false, reason: "rate_limited" };
  }
  const client = await createClient();
  const { data: conversation, error } = await loadOwnedConversation(
    client,
    user,
    parsed.data.conversationId,
  );
  if (error || !conversation) return { success: false, reason: "not_found" };

  const label = await resolveChoiceLabel(
    client,
    user,
    parsed.data.entityType,
    parsed.data.entityId,
  );
  if (!label) return { success: false, reason: "not_found" };

  const next = applyProposal(parseActiveContext(conversation.active_context), {
    entityType: parsed.data.entityType,
    entityId: parsed.data.entityId,
    displayLabel: label,
    setBy: "user_choice",
  });
  return persistContext(client, user, parsed.data.conversationId, next);
}
