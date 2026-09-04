import "server-only";

import { tool } from "ai";
import { z } from "zod";
import { logAgentTool } from "@/lib/ai/audit";
import { AiResourceInputError, queryResource } from "@/lib/ai/resources/compile";
import { resourceRelationsSchema } from "@/lib/ai/tools/resource-input";
import type { DoctorToolContext } from "@/lib/ai/tools/context";

export function getRecordTool(ctx: DoctorToolContext) {
  return tool({
    description:
      "Read one registered ClinicFlow record by UUID. The record is returned only when the authenticated caller's RLS scope permits it. A missing id and an id outside that scope produce the same unauthorized_scope result, so never claim which one occurred. Use only fields and relations advertised by describe_capabilities.",
    inputSchema: z.object({
      resource: z.string().trim().min(1).max(80),
      id: z.string().uuid(),
      fields: z.array(z.string().trim().min(1).max(80)).min(1).max(40).optional(),
      relations: resourceRelationsSchema,
    }).strict(),
    execute: async ({ resource, id, fields, relations }) => {
      try {
        const result = await queryResource(ctx.user, resource, {
          fields,
          relations,
          filters: { id },
          page: 1,
          page_size: 1,
        });
        if ("needs_clarification" in result) return result;
        const row = result.rows[0];
        if (!row) throw new Error("Record lookup returned no row after scope validation.");
        await logAgentTool({
          clinicId: ctx.user.clinicId,
          actorId: ctx.user.id,
          tool: "get_record",
          tableName: resource,
          recordId: id,
          params: { resource, outcome: "success" },
        });
        return {
          resource,
          record: row,
          fields_withheld: result.fields_withheld,
        };
      } catch (error) {
        if (!(error instanceof AiResourceInputError)) throw error;
        await logAgentTool({
          clinicId: ctx.user.clinicId,
          actorId: ctx.user.id,
          tool: "get_record",
          tableName: null,
          params: { outcome: "invalid", reason: error.reason },
        });
        return error.toResult();
      }
    },
  });
}
