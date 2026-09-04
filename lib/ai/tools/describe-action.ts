import "server-only";

import { tool } from "ai";
import { z } from "zod";
import { describeAuthorizedActions } from "@/lib/ai/actions/execute";
import type { DoctorToolContext } from "@/lib/ai/tools/context";

export function describeActionTool(ctx: DoctorToolContext) {
  return tool({
    description:
      "Describe the registered write actions this exact user is currently authorized and entitled to preview, including risk, purpose, and expected input. This is permission-filtered server metadata. It never previews or executes an action.",
    inputSchema: z
      .object({
        action: z.string().regex(/^[a-z][a-z0-9_.]{0,99}$/).optional(),
      })
      .strict(),
    execute: async ({ action }) => {
      const definitions = await describeAuthorizedActions(ctx.user);
      return {
        actions: definitions
          .filter((definition) => !action || definition.id === action)
          .map((definition) => ({
            id: definition.id,
            label: definition.labels[ctx.locale],
            description: definition.description[ctx.locale],
            input: definition.inputDescription[ctx.locale],
            risk_class: definition.risk,
            confirmation_required: true as const,
          })),
        capability_only: true as const,
      };
    },
  });
}
