import "server-only";

import { tool } from "ai";
import { assertFinancialInsightsAccess } from "@/lib/ai/authorization";
import { logAgentTool } from "@/lib/ai/audit";
import { createClient } from "@/lib/supabase/server";
import type { DoctorToolContext } from "@/lib/ai/tools/context";
import {
  dateRangeInputSchema,
  describeRange,
  resolveToolDateRange,
} from "@/lib/ai/tools/range";

/**
 * get_revenue_summary — financial aggregates behind the double gate.
 *
 * The tool is not registered at all unless the ai.financial_insights
 * entitlement and the admin-granted per-user permission both pass, and
 * assertFinancialInsightsAccess re-runs both on every invocation so a grant
 * revoked mid-conversation denies the next call. The underlying RPC returns
 * aggregates only; no invoice, deposit, or settlement row is exposed.
 */
export function getRevenueSummaryTool(ctx: DoctorToolContext) {
  return tool({
    description:
      "Get financial aggregates for a date range: total and gross revenue, primary/secondary/insurance splits, deposits, outstanding balance, settlement totals, transaction counts, and a breakdown by payment method. Aggregates only. Report the returned figures exactly and never estimate or extrapolate a financial number.",
    inputSchema: dateRangeInputSchema,
    execute: async (input) => {
      await assertFinancialInsightsAccess(ctx.user);
      const supabase = await createClient();
      const range = resolveToolDateRange(input);

      const { data, error } = await supabase.rpc("ai_get_revenue_summary", {
        p_start: range.start.toISOString(),
        p_end: range.end.toISOString(),
      });
      if (error) throw new Error("Revenue summary lookup failed.");

      await logAgentTool({
        clinicId: ctx.user.clinicId,
        actorId: ctx.user.id,
        tool: "get_revenue_summary",
        tableName: "appointments",
        params: { preset: range.preset, from: range.from, to: range.to },
      });

      return { range: describeRange(range), revenue: data };
    },
  });
}
