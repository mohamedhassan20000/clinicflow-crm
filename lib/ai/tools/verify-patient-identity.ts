import "server-only";

import { tool } from "ai";
import { z } from "zod";
import {
  authorizePatientConversation,
  type PatientToolContext,
} from "@/lib/ai/patient-authorization";
import { verifyPatientConversationDob } from "@/lib/supabase/admin";

export function verifyPatientIdentityTool(ctx: PatientToolContext) {
  return tool({
    description:
      "Verify the patient using their date of birth before showing any appointment details. Never ask for or accept a patient id.",
    inputSchema: z.object({
      date_of_birth: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .describe("Date of birth in YYYY-MM-DD format."),
    }),
    execute: async ({ date_of_birth }) => {
      const identity = await authorizePatientConversation(ctx, {
        requireLinked: true,
      });
      const { data, error } = await verifyPatientConversationDob({
        clinicId: identity.clinicId,
        conversationId: identity.conversationId,
        dateOfBirth: date_of_birth,
      });
      if (error || !data?.[0]) {
        throw new Error("Patient identity verification failed.");
      }
      const result = data[0];
      return {
        verified: result.verified,
        attempts_remaining: result.attempts_remaining,
        locked_until: result.locked_until,
        guidance: result.verified
          ? "Identity verified for this conversation."
          : result.locked_until
            ? "Verification is temporarily locked. Ask the patient to contact the clinic."
            : "The date did not match. Ask the patient to try again.",
      };
    },
  });
}
