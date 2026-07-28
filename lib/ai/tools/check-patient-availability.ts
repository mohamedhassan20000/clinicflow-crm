import "server-only";

import { tool } from "ai";
import { z } from "zod";
import {
  authorizePatientConversation,
  type PatientToolContext,
} from "@/lib/ai/patient-authorization";
import { getPatientAvailableSlots } from "@/lib/booking/patient";
import { logAgentTool } from "@/lib/ai/audit";
import { ISO_DATE_RE } from "@/lib/ai/tools/context";

export function checkPatientAvailabilityTool(ctx: PatientToolContext) {
  return tool({
    description:
      "Check real clinic appointment availability for a date. Availability is logistics-only and does not require DOB verification.",
    inputSchema: z.object({
      date: z.string().regex(ISO_DATE_RE),
      doctor_id: z.string().uuid().optional(),
      service_id: z.string().uuid().optional(),
    }),
    execute: async ({ date, doctor_id, service_id }) => {
      const identity = await authorizePatientConversation(ctx, {
        requireScheduling: true,
      });
      const result = await getPatientAvailableSlots({
        identity,
        date,
        doctorId: doctor_id,
        serviceId: service_id,
      });
      await logAgentTool({
        clinicId: identity.clinicId,
        actorId: null,
        tool: "check_availability",
        tableName: "appointments",
        params: {
          outcome: result.ok ? "success" : result.reason,
          date,
          doctor_specified: Boolean(doctor_id),
          service_specified: Boolean(service_id),
          count: result.ok ? result.availableSlots.length : 0,
        },
      });
      if (!result.ok && result.reason === "doctor_required") {
        return {
          needs_clarification: true as const,
          field: "doctor_id",
          candidates: result.candidates,
          guidance: "Ask which doctor the patient prefers.",
        };
      }
      return result;
    },
  });
}
