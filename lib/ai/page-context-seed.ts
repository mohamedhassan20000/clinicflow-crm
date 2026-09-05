import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  assertAnalyticsToolAccess,
  assertFinancialInsightsAccess,
} from "@/lib/ai/authorization";
import { CLINIC_REPORTS, clinicReportLabel } from "@/lib/ai/clinic-reports";
import type { ActiveContextProposal } from "@/lib/ai/conversation-context";
import type { AssistantPageContext } from "@/lib/ai/page-context";
import type { PromptLocale } from "@/lib/ai/prompts/doctor";
import type { AuthedUser } from "@/lib/rbac";
import type { Database } from "@/types/database";

/**
 * Server-derived active-context seed for a conversation started from a
 * contextual "Ask Assistant" launcher.
 *
 * A launcher now opens a *new* conversation rather than resuming the caller's
 * latest one, so the record the user was looking at has to reach the new
 * conversation somehow. It reaches it here, as ordinary active-context slots —
 * the same mechanism a high-confidence entity resolution or an explicit user
 * choice already writes, and the same `page_context` provenance the P4.8
 * launcher protocol reserved for exactly this.
 *
 * **Nothing here is trusted from the browser.** The launcher submits only a
 * strict, bounded page-context descriptor; every label below is re-read through
 * the caller's own RLS client, and every slot re-runs the same tool gate the
 * matching clarification choice runs in `actions/assistant-context.ts`. A row
 * outside the caller's scope simply produces no slot. The slot is advisory in
 * exactly the way `lib/ai/conversation-context.ts` documents: it names an entity
 * by internal id, and every tool re-authorizes independently on every call, so a
 * seeded id can only reach what the same user could reach by naming the entity.
 */
export async function resolvePageContextSeed(input: {
  supabase: SupabaseClient<Database>;
  user: AuthedUser;
  context: AssistantPageContext | null;
  locale: PromptLocale;
}): Promise<ActiveContextProposal[]> {
  const { context, supabase, user } = input;
  if (!context) return [];

  switch (context.type) {
    case "patient": {
      const { data, error } = await supabase
        .from("patients")
        .select("id, full_name")
        .eq("id", context.patientId)
        .eq("clinic_id", user.clinicId)
        .is("deleted_at", null)
        .maybeSingle();
      if (error || !data?.full_name) return [];
      return [{
        entityType: "patient",
        entityId: data.id,
        displayLabel: data.full_name,
        setBy: "page_context",
      }];
    }
    case "appointments": {
      if (!context.doctorId) return [];
      // Mirrors the `staff` clarification choice: the staff directory is behind
      // the analytics gate, so seeding a doctor slot must clear it too.
      try {
        await assertAnalyticsToolAccess(user);
      } catch {
        return [];
      }
      const { data, error } = await supabase
        .from("profiles")
        .select("id, full_name")
        .eq("id", context.doctorId)
        .eq("clinic_id", user.clinicId)
        .eq("is_active", true)
        .eq("is_deleted", false)
        .is("deleted_at", null)
        .maybeSingle();
      if (error || !data?.full_name) return [];
      return [{
        entityType: "staff",
        entityId: data.id,
        displayLabel: data.full_name,
        setBy: "page_context",
      }];
    }
    case "reports": {
      const report = CLINIC_REPORTS[context.report];
      if (!(report.roles as readonly string[]).includes(user.role)) return [];
      try {
        if (report.financial) {
          await assertFinancialInsightsAccess(user);
        } else {
          await assertAnalyticsToolAccess(user);
        }
      } catch {
        return [];
      }
      return [{
        entityType: "report",
        entityId: context.report,
        displayLabel: clinicReportLabel(context.report, input.locale),
        setBy: "page_context",
      }];
    }
    // dashboard, revenue, invoices, staff, departments and doctor-schedule
    // describe a *view*, not one record: their advisory prompt line already
    // carries everything they know, and inventing a slot for them would put a
    // context chip on screen the user cannot act on. The launcher still seeds
    // the page-context prompt line for every one of them.
    case "dashboard":
    case "revenue":
    case "invoices":
    case "staff":
    case "departments":
    case "doctor-schedule":
      return [];
  }
}
