import "server-only";

import { tool } from "ai";
import { z } from "zod";
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
 * get_appointment_stats — appointment aggregates for admin/manager (§P4.6).
 * Rates are computed in the RPC from real counts so the model narrates measured
 * numbers rather than deriving percentages it could get wrong.
 */
export function getAppointmentStatsTool(ctx: DoctorToolContext) {
  return tool({
    description:
      "Get aggregate appointment statistics for a date range: active totals, completed/cancelled/no-show counts and rates, dedicated replaced appointment count and replacement rate, and a breakdown grouped by status, doctor, or department. Replaced originals are excluded from active totals and the other outcome rates. Aggregates only — use query_resource on the appointments resource when the user needs the individual appointments.",
    inputSchema: dateRangeInputSchema.extend({
      group_by: z
        .enum(["status", "doctor", "department"])
        .default("status")
        .describe("Which dimension to break the totals down by."),
    }),
    execute: async ({ group_by, ...rangeInput }) => {
      await assertClinicAnalyticsToolAccess(ctx.user);
      const supabase = await createClient();
      const range = resolveToolDateRange(rangeInput);

      const { data, error } = await supabase.rpc("ai_get_appointment_stats", {
        p_start: range.start.toISOString(),
        p_end: range.end.toISOString(),
        p_group_by: group_by,
      });
      if (error) throw new Error("Appointment statistics lookup failed.");

      await logAgentTool({
        clinicId: ctx.user.clinicId,
        actorId: ctx.user.id,
        tool: "get_appointment_stats",
        tableName: "appointments",
        params: { preset: range.preset, from: range.from, to: range.to, group_by },
      });

      return { range: describeRange(range), stats: data };
    },
  });
}
