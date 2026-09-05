import "server-only";

import { tool } from "ai";
import { z } from "zod";
import { logAgentTool } from "@/lib/ai/audit";
import {
  authorizePatientConversation,
  type PatientToolContext,
} from "@/lib/ai/patient-authorization";
import { getPatientClinicPublicInfo } from "@/lib/supabase/admin";

/**
 * Deterministic public clinic information for WhatsApp patients.
 *
 * These fields come from the clinic's settings, never from an FAQ match or the
 * model's memory. The question is accepted only so the model can state which
 * field the patient asked for in the audit summary; it does not affect the
 * tenant-scoped lookup.
 */
export function getClinicInfoTool(ctx: PatientToolContext) {
  return tool({
    description:
      "Get the clinic's current stored name, address, phone, website, and working hours. " +
      "Use this for greetings and for any clinic contact, location, website, or opening-hours question. " +
      "Never substitute general knowledge or an invented value.",
    inputSchema: z.object({
      question: z.string().trim().min(1).max(500).optional(),
    }),
    execute: async ({ question }) => {
      const identity = await authorizePatientConversation(ctx);
      const result = await getPatientClinicPublicInfo(identity.clinicId);
      await logAgentTool({
        clinicId: identity.clinicId,
        actorId: null,
        tool: "get_clinic_info",
        tableName: "clinics",
        params: {
          outcome: result.error ? "error" : "success",
          question_supplied: Boolean(question),
        },
      });
      if (result.error || !result.data) {
        return {
          found: false as const,
          guidance:
            "Clinic settings could not be read. Do not invent them; ask the patient to try again later.",
        };
      }
      return {
        found: true as const,
        clinic: result.data,
        guidance:
          "Answer only with these current stored settings. Localize day names and phrasing naturally, " +
          "but do not alter phone numbers, addresses, URLs, dates, or times.",
      };
    },
  });
}
