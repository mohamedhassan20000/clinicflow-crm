import "server-only";

import { tool } from "ai";
import { z } from "zod";
import {
  authorizePatientConversation,
  type PatientToolContext,
} from "@/lib/ai/patient-authorization";
import { cancelPatientAiAppointment } from "@/lib/supabase/admin";

export function cancelMyAppointmentTool(ctx: PatientToolContext) {
  return tool({
    description:
      "Cancel one of the verified patient's own pending appointments. Confirmed appointments must be handled by clinic staff.",
    inputSchema: z.object({
      appointment_id: z.string().uuid(),
    }),
    execute: async ({ appointment_id }) => {
      const identity = await authorizePatientConversation(ctx, {
        requireLinked: true,
        requireVerified: true,
        // P8: nothing acts on the patient's behalf while a staff member has the
        // conversation.
        refuseIfPaused: true,
      });
      const { data, error } = await cancelPatientAiAppointment({
        clinicId: identity.clinicId,
        conversationId: identity.conversationId,
        appointmentId: appointment_id,
      });
      if (error || !data?.[0]) {
        throw new Error("Could not cancel the appointment.");
      }
      return data[0];
    },
  });
}
