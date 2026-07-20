import "server-only";

import { tool } from "ai";
import { assertClinicAnalyticsToolAccess } from "@/lib/ai/authorization";
import { logAgentTool } from "@/lib/ai/audit";
import { createClient } from "@/lib/supabase/server";
import type { DoctorToolContext } from "@/lib/ai/tools/context";
import {
  dateRangeInputSchema,
  describeRange,
  resolveToolDateRange,
} from "@/lib/ai/tools/range";

/**
 * get_clinic_summary — operational aggregates for admin/manager (§P4.6).
 *
 * Backed by ai_get_clinic_summary, a SECURITY DEFINER RPC that re-resolves the
 * caller's clinic and role itself and returns aggregates only. No patient row
 * ever crosses this boundary, so the admin persona stays non-clinical while
 * still answering "how many departments / patients / appointments" questions.
 */
export function getClinicSummaryTool(ctx: DoctorToolContext) {
  return tool({
    description:
      "Get an operational overview of the clinic for a date range: department count, active staff counts by role, total and new patient counts, appointment counts by status, follow-up counts, and the equivalent figures for the previous period so trends can be described. Also returns the clinic's department and active-doctor directory (names and ids) for use as filters in other tools. Aggregates only — never individual patients or clinical data.",
    inputSchema: dateRangeInputSchema,
    execute: async (input) => {
      await assertClinicAnalyticsToolAccess(ctx.user);
      const supabase = await createClient();
      const range = resolveToolDateRange(input);

      const { data, error } = await supabase.rpc("ai_get_clinic_summary", {
        p_start: range.start.toISOString(),
        p_end: range.end.toISOString(),
      });
      if (error) throw new Error("Clinic summary lookup failed.");

      await logAgentTool({
        clinicId: ctx.user.clinicId,
        actorId: ctx.user.id,
        tool: "get_clinic_summary",
        // Reads departments, profiles, patients, appointments and follow_ups. The
        // audit ledger answers "what did the assistant touch", so a single
        // fixed table name would be an inaccurate answer, not a terse one.
        tableName: "multiple",
        params: { preset: range.preset, from: range.from, to: range.to },
      });

      return { range: describeRange(range), summary: data };
    },
  });
}
