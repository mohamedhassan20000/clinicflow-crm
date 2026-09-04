import "server-only";

import { tool } from "ai";
import { z } from "zod";
import { logAgentTool } from "@/lib/ai/audit";
import { MAX_PAGE } from "@/lib/ai/resources/compile";
import { resolveAuthorizedResources } from "@/lib/ai/resources/registry";
import type { DoctorToolContext } from "@/lib/ai/tools/context";

export function describeCapabilitiesTool(ctx: DoctorToolContext) {
  return tool({
    description:
      "Describe the generic read resources this exact user is authorized and entitled to query, including allowed fields, default fields, filters/operators, sorts, relations, pagination limits, and aggregates. This is permission-filtered server metadata, not a guess. Use it before a generic read when the valid resource contract is unclear.",
    inputSchema: z.object({
      resource: z.string().trim().min(1).max(80).optional(),
    }).strict(),
    execute: async ({ resource }) => {
      const definitions = await resolveAuthorizedResources(ctx.user);
      const selected = resource
        ? definitions.filter((definition) => definition.id === resource)
        : definitions;
      await logAgentTool({
        clinicId: ctx.user.clinicId,
        actorId: ctx.user.id,
        tool: "describe_capabilities",
        tableName: null,
        params: { resource: resource ?? null, resource_count: selected.length },
      });
      return {
        resources: selected.map((definition) => ({
          id: definition.id,
          label: definition.labels[ctx.locale],
          description: definition.description[ctx.locale],
          fields: definition.fieldPolicy(ctx.user).map((name) => ({
            name,
            type: definition.fields[name]!.type,
            description: definition.fields[name]!.description,
            explicit_only: !definition.defaultFields.includes(name),
            max_list_rows: definition.fields[name]!.maxListRows ?? null,
          })),
          default_fields: definition.defaultFields,
          filters: Object.entries(definition.filters).map(([name, spec]) => ({
            name,
            operators: spec.operators,
            description: spec.description,
          })),
          sorts: definition.sorts,
          relations: Object.entries(definition.relations).map(([name, relation]) => ({
            name,
            description: relation.description,
            fields: relation.fieldPolicy(ctx.user),
            default_fields: relation.defaultFields,
          })),
          row_cap: definition.rowCap,
          max_page: MAX_PAGE,
          // Projected explicitly rather than spread: the group specs carry
          // server-owned column/filter wiring the model must never see, and the
          // model only needs the key, what it means, and whether an unset value
          // gets its own bucket.
          aggregates: definition.aggregates
            ? {
                metrics: definition.aggregates.metrics,
                group_by: definition.aggregates.groupBy,
                groups: definition.aggregates.groupBy.map((key) => ({
                  key,
                  description: definition.aggregates?.groups?.[key]?.description ?? "",
                  includes_unset_bucket:
                    definition.aggregates?.groups?.[key]?.includeNull ?? false,
                })),
                suppressed: false as const,
              }
            : null,
        })),
        capability_only: true as const,
      };
    },
  });
}
