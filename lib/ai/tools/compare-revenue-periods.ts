import "server-only";

import { tool } from "ai";
import { z } from "zod";
import { assertFinancialInsightsAccess } from "@/lib/ai/authorization";
import { logAgentTool } from "@/lib/ai/audit";
import { createClient } from "@/lib/supabase/server";
import { describeRange, resolveToolPeriod } from "@/lib/ai/tools/range";
import { ISO_DATE_RE, type DoctorToolContext } from "@/lib/ai/tools/context";

const periodSchema = z.object({
  date_from: z.string().regex(ISO_DATE_RE),
  date_to: z.string().regex(ISO_DATE_RE),
});

/**
 * compare_revenue_periods — period-over-period financial comparison.
 *
 * This exists so "why did revenue drop?" is answered from two real aggregate
 * reads and their computed deltas, rather than the model inventing a plausible
 * narrative. The deltas are computed in the RPC; the model's job is to describe
 * them, not to derive them.
 */
export function compareRevenuePeriodsTool(ctx: DoctorToolContext) {
  return tool({
    description:
      "Compare financial aggregates between two explicit date periods. Returns the full revenue summary for each period plus the computed gross delta, percentage change, transaction delta, and outstanding delta. Use this — never two separate summary calls plus your own arithmetic — when the user asks why revenue rose or fell.",
    inputSchema: z.object({
      period_a: periodSchema.describe("The earlier/baseline period."),
      period_b: periodSchema.describe("The later/comparison period."),
    }),
    execute: async ({ period_a, period_b }) => {
      await assertFinancialInsightsAccess(ctx.user);
      const supabase = await createClient();

      // Both periods go through the shared clamp. Calling resolveDateRange
      // directly here bypassed MAX_RANGE_DAYS entirely, which made this — the
      // one tool that aggregates the full financial surface twice per call —
      // the only unbounded historical scan in the phase.
      const rangeA = resolveToolPeriod(period_a);
      const rangeB = resolveToolPeriod(period_b);

      const { data, error } = await supabase.rpc("ai_compare_revenue_periods", {
        p_a_start: rangeA.start.toISOString(),
        p_a_end: rangeA.end.toISOString(),
        p_b_start: rangeB.start.toISOString(),
        p_b_end: rangeB.end.toISOString(),
      });
      if (error) throw new Error("Revenue comparison lookup failed.");

      await logAgentTool({
        clinicId: ctx.user.clinicId,
        actorId: ctx.user.id,
        tool: "compare_revenue_periods",
        tableName: "appointments",
        params: {
          a_from: rangeA.from,
          a_to: rangeA.to,
          b_from: rangeB.from,
          b_to: rangeB.to,
          clamped: rangeA.clamped || rangeB.clamped,
        },
      });

      return {
        period_a: describeRange(rangeA),
        period_b: describeRange(rangeB),
        comparison: data,
      };
    },
  });
}
