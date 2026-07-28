import "server-only";

import { tool } from "ai";
import { z } from "zod";
import {
  authorizePatientConversation,
  type PatientToolContext,
} from "@/lib/ai/patient-authorization";
import { logAgentTool } from "@/lib/ai/audit";
import { searchPatientClinicFaq } from "@/lib/supabase/admin";

export function answerClinicFaqTool(ctx: PatientToolContext) {
  return tool({
    description:
      "Retrieve clinic-authored non-medical FAQ answers. Never answer a medical question from general knowledge.",
    inputSchema: z.object({
      question: z.string().trim().min(1).max(500),
    }),
    execute: async ({ question }) => {
      const identity = await authorizePatientConversation(ctx);
      const { data, error } = await searchPatientClinicFaq({
        clinicId: identity.clinicId,
        conversationId: identity.conversationId,
        question,
        language: ctx.locale,
      });
      if (error) throw new Error("Could not search clinic FAQs.");
      const matches = (data ?? []).filter((row) => row.score >= 0.18);
      await logAgentTool({
        clinicId: identity.clinicId,
        actorId: null,
        tool: "answer_clinic_faq",
        tableName: "clinic_faq",
        params: { outcome: "success", match_count: matches.length, language: ctx.locale },
      });
      return matches.length
        ? { found: true as const, matches }
        : {
            found: false as const,
            guidance:
              "No clinic-authored answer matched. Say you do not know and offer to connect the patient with clinic staff.",
          };
    },
  });
}
