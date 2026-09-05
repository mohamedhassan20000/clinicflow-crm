import "server-only";

import { tool } from "ai";
import { logAgentTool } from "@/lib/ai/audit";
import { AiResourceInputError, queryResource } from "@/lib/ai/resources/compile";
import { RESOURCE_REGISTRY } from "@/lib/ai/resources/registry";
import { resourceExportSuggestion } from "@/lib/ai/resources/export-hatch";
import { proposeResourceContext } from "@/lib/ai/resources/context-proposal";
import type { ResourceQueryInput } from "@/lib/ai/resources/types";
import { resourceQueryInputSchema } from "@/lib/ai/tools/resource-input";
import type { DoctorToolContext } from "@/lib/ai/tools/context";

const REGISTERED_RESOURCE_IDS = RESOURCE_REGISTRY.map(
  (definition) => definition.id,
).join(", ");

export function queryResourceTool(ctx: DoctorToolContext) {
  return tool({
    description: `Query a registered ClinicFlow resource using only its registered fields, filters, relations, and sort keys. Registered resource IDs: ${REGISTERED_RESOURCE_IDS}. Availability is user-specific; use describe_capabilities for the permission-filtered resource contract. Results are RLS-scoped, paginated, include an exact total, and carry a notice that must be relayed when more rows exist. For example, to answer 'give me Dermatology patient names', query patients with filters { department: 'Dermatology' } and fields ['full_name','file_number']. Never invent a resource, filter, field, or operator; use describe_capabilities when unsure. When a result is truncated and carries an export_suggestion, offer the user that document instead of paging through the rows.`,
    inputSchema: resourceQueryInputSchema,
    execute: async ({ resource, ...input }) => {
      try {
        const result = await queryResource(
          ctx.user,
          resource,
          input as ResourceQueryInput,
          undefined,
          {
            // A doctor/department named in words and resolved deterministically
            // becomes context, exactly as `list_appointments` did before it was
            // superseded. Model-asserted uuids resolve without a context.
            onResolvedContext: (entity) => {
              if (!ctx.conversationId) return;
              ctx.contextRecorder?.propose(
                entity.entityType,
                entity.id,
                entity.label,
                "resolution",
              );
            },
          },
        );
        if (!("needs_clarification" in result)) {
          // Phase 7: the unmounted narrow tools proposed active context on a
          // single deterministic match; the generic path inherits that, under
          // the same server-derived-only rule.
          proposeResourceContext(
            ctx,
            result.resource,
            input as ResourceQueryInput,
            result,
          );
          // §7.5 — a truncated page routes to a document rather than to more
          // pages. Advisory only; issuing still runs the full action pipeline.
          if (result.truncated) {
            const exportSuggestion = await resourceExportSuggestion(
              ctx.user,
              resource,
            );
            if (exportSuggestion) {
              Object.assign(result, { export_suggestion: exportSuggestion });
            }
          }
          await logAgentTool({
            clinicId: ctx.user.clinicId,
            actorId: ctx.user.id,
            tool: "query_resource",
            tableName: resource,
            params: {
              resource,
              outcome: "success",
              row_count: result.rows.length,
              filtered: Object.keys(input.filters ?? {}).length > 0,
            },
          });
        }
        return result;
      } catch (error) {
        if (!(error instanceof AiResourceInputError)) throw error;
        await logAgentTool({
          clinicId: ctx.user.clinicId,
          actorId: ctx.user.id,
          tool: "query_resource",
          tableName: null,
          params: { outcome: "invalid", reason: error.reason },
        });
        return error.toResult();
      }
    },
  });
}
