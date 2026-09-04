import "server-only";

import { tool } from "ai";
import { z } from "zod";
import { logAgentTool } from "@/lib/ai/audit";
import {
  AiResourceInputError,
  countResource,
  groupedCountResource,
} from "@/lib/ai/resources/compile";
import type { ResourceQueryInput } from "@/lib/ai/resources/types";
import { resourceFiltersSchema } from "@/lib/ai/tools/resource-input";
import type { DoctorToolContext } from "@/lib/ai/tools/context";

export function aggregateResourceTool(ctx: DoctorToolContext) {
  return tool({
    // Approved plan §7.4: row-level and single-cell reads are deliberately
    // unsuppressed for RLS-admitted roles. The post-plan completion pass extends
    // the same rule to `group_by`, because every bucket is one of those same
    // single-cell counts and every bucket's rows are ones `query_resource`
    // returns in full — see `groupedCountResource`.
    description:
      "Count records in a registered ClinicFlow resource after registered filters and the caller's RLS scope are applied. Counts are exact and unsuppressed: they describe only rows this user is already authorized to read, so never describe a result from this tool as withheld, suppressed, or unavailable for privacy reasons. Set group_by to a registered group key (see describe_capabilities -> aggregates.group_by) to get an exact distribution; each bucket carries the count and the label, and you may then call query_resource with the same filter to list the matching records. get_patient_stats is a separate k-anonymous statistical release and its suppression applies only to that tool — if it withholds a distribution, use this tool and query_resource instead of telling the user the information cannot be shown. Never list rows and count them yourself.",
    inputSchema: z.object({
      resource: z.string().trim().min(1).max(80),
      metric: z.literal("count").default("count"),
      group_by: z.string().trim().min(1).max(80).optional(),
      filters: resourceFiltersSchema,
    }).strict(),
    execute: async ({ resource, group_by, filters }) => {
      try {
        const input: ResourceQueryInput = {
          filters: filters as ResourceQueryInput["filters"],
        };
        const result = group_by
          ? await groupedCountResource(ctx.user, resource, group_by, input)
          : await countResource(ctx.user, resource, input);
        if (!("needs_clarification" in result)) {
          await logAgentTool({
            clinicId: ctx.user.clinicId,
            actorId: ctx.user.id,
            tool: "aggregate_resource",
            tableName: resource,
            params: {
              resource,
              metric: "count",
              group_by: group_by ?? null,
              outcome: "success",
            },
          });
        }
        return result;
      } catch (error) {
        if (!(error instanceof AiResourceInputError)) throw error;
        await logAgentTool({
          clinicId: ctx.user.clinicId,
          actorId: ctx.user.id,
          tool: "aggregate_resource",
          tableName: null,
          params: { outcome: "invalid", reason: error.reason },
        });
        return error.toResult();
      }
    },
  });
}
