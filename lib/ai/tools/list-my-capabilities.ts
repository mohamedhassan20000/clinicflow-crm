import "server-only";

import { tool } from "ai";
import { z } from "zod";
import { assertStaffToolAccess } from "@/lib/ai/authorization";
import { logAgentTool } from "@/lib/ai/audit";
import type { DoctorToolContext } from "@/lib/ai/tools/context";

/**
 * list_my_capabilities — the server-resolved set of things this specific user
 * can ask the assistant to do across supported task classes (P4.7B).
 *
 * It reads no clinic data. Its answer is `resolveAssistantCapabilities`, the
 * unscoped resolution of the same registry function that mounts the model's
 * tools. It is deliberately the authorized union across every task class the
 * router supports for this role, not the narrower set mounted for one turn.
 * Every active task-class mount must be a subset of this union, and the panel
 * and this tool return the same union without a hand-kept list.
 *
 * The staff spine (`assertStaffToolAccess`) is re-asserted on every call, like
 * the P4.7A help tools, because an administrator can hide the assistant or a
 * subscription can lapse mid-conversation. Descriptions are already localized to
 * `ctx.locale` by the resolver, from each tool's `capabilityDescription`.
 */
export function listMyCapabilitiesTool(ctx: DoctorToolContext) {
  return tool({
    description:
      "List exactly what this user is authorized to ask across ClinicFlow assistant task types — their cross-task capability union, grouped and described. The current turn may mount only the subset needed for this question; a later question is re-routed and mounts its authorized subset. Use this when the user asks what you can do, what they can ask, or whether you can help with something. Describe only the capabilities returned, never promise one outside the list, and do not imply every listed tool is mounted in this turn.",
    inputSchema: z.object({}).strict(),
    execute: async () => {
      // Re-asserted on every invocation, not only at mount (see P4.7A help tools).
      await assertStaffToolAccess(ctx.user);

      // Imported lazily, at call time, on purpose. `capabilities` depends on the
      // tools index, which depends on the registry, which lists this tool — a
      // static import would close that cycle and race the registry's own
      // top-level initialization. Deferring the load to execute() breaks the
      // cycle without giving up the single shared resolution.
      const { resolveAssistantCapabilities } = await import("@/lib/ai/capabilities");
      const capabilities = await resolveAssistantCapabilities(ctx.user, ctx.locale);

      await logAgentTool({
        clinicId: ctx.user.clinicId,
        actorId: ctx.user.id,
        tool: "list_my_capabilities",
        // Reads no database table — the answer is registry metadata resolved
        // against this user's entitlements and permissions.
        tableName: null,
        params: { capability_count: capabilities.items.length },
      });

      return {
        capabilities: capabilities.items.map((item) => ({
          name: item.name,
          group: item.group,
          description: item.description,
        })),
        capability_scope: "authorized_task_class_union" as const,
        // Stated so the model treats this as the complete, authoritative set for
        // this user and does not append capabilities from its general knowledge
        // of similar software — the same honesty guard search_help carries.
        capability_only: true as const,
      };
    },
  });
}
