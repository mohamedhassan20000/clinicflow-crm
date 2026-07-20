import "server-only";

import { tool } from "ai";
import { assertAnalyticsToolAccess } from "@/lib/ai/authorization";
import { logAgentTool } from "@/lib/ai/audit";
import { createClient } from "@/lib/supabase/server";
import type { DoctorToolContext } from "@/lib/ai/tools/context";
import {
  dateRangeInputSchema,
  describeRange,
  resolveToolDateRange,
} from "@/lib/ai/tools/range";

/**
 * count_new_patients — the cheapest operational question, available to
 * admin/manager/receptionist. A head count through the RLS client: no patient
 * row is read or returned, only the count the caller is authorized to see.
 */
export function countNewPatientsTool(ctx: DoctorToolContext) {
  return tool({
    description:
      "Count patients registered in a date range, plus the count for the immediately preceding period of the same length so the trend can be described. Returns counts only — no patient records.",
    inputSchema: dateRangeInputSchema,
    execute: async (input) => {
      await assertAnalyticsToolAccess(ctx.user);
      const supabase = await createClient();
      const range = resolveToolDateRange(input);

      const span = range.end.getTime() - range.start.getTime();
      const previousStart = new Date(range.start.getTime() - span).toISOString();

      const [current, previous] = await Promise.all([
        supabase
          .from("patients")
          .select("id", { count: "exact", head: true })
          .eq("clinic_id", ctx.user.clinicId)
          .eq("is_deleted", false)
          .gte("created_at", range.start.toISOString())
          .lte("created_at", range.end.toISOString()),
        supabase
          .from("patients")
          .select("id", { count: "exact", head: true })
          .eq("clinic_id", ctx.user.clinicId)
          .eq("is_deleted", false)
          .gte("created_at", previousStart)
          .lt("created_at", range.start.toISOString()),
      ]);
      if (current.error || previous.error) {
        throw new Error("New patient count lookup failed.");
      }

      const count = current.count ?? 0;
      const previousCount = previous.count ?? 0;

      await logAgentTool({
        clinicId: ctx.user.clinicId,
        actorId: ctx.user.id,
        tool: "count_new_patients",
        tableName: "patients",
        params: { preset: range.preset, from: range.from, to: range.to, count },
      });

      return {
        range: describeRange(range),
        new_patients: count,
        previous_period_new_patients: previousCount,
        change: count - previousCount,
      };
    },
  });
}
