import "server-only";

import { tool } from "ai";
import { z } from "zod";
import { describeIssuableDocuments } from "@/lib/ai/documents/capability";
import type { DoctorToolContext } from "@/lib/ai/tools/context";

export function describeDocumentsTool(ctx: DoctorToolContext) {
  return tool({
    description:
      "List the ClinicFlow document types this exact user may issue, each with the inputs it requires, the inputs it accepts, and the inputs the server fills automatically. Permission-filtered server metadata: a document type the user may not issue is simply absent. It never previews or issues anything. Call this first for any 'create/generate/issue a document' request, then preview_document.",
    inputSchema: z
      .object({
        request: z
          .string()
          .trim()
          .max(200)
          .optional()
          .describe(
            "What the user asked for, in their own words. Used only to order the permitted list.",
          ),
      })
      .strict(),
    execute: async ({ request }) => ({
      document_types: await describeIssuableDocuments(ctx.user, {
        query: request ?? null,
        locale: ctx.locale,
      }),
      capability_only: true as const,
      guidance:
        "Ask the user only for the required slots that preview_document reports as missing. Resolve any named patient, doctor, department, or staff member to an id first.",
    }),
  });
}
