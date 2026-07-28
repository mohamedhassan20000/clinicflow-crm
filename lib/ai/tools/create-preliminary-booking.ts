import "server-only";

import { tool } from "ai";
import { z } from "zod";
import {
  authorizePatientConversation,
  type PatientToolContext,
} from "@/lib/ai/patient-authorization";
import { createPatientPendingBooking } from "@/lib/booking/patient";

export function createPreliminaryBookingTool(ctx: PatientToolContext) {
  return tool({
    description:
      "Create a preliminary pending appointment for the patient bound to this conversation. The clinic must confirm it. Never ask for or accept a patient id.",
    inputSchema: z.object({
      doctor_id: z.string().uuid(),
      scheduled_at: z.string().datetime({ offset: true }),
      duration_minutes: z.number().int().min(15).max(240).multipleOf(15).default(30),
      service_id: z.string().uuid().optional(),
    }),
    execute: async ({
      doctor_id,
      scheduled_at,
      duration_minutes,
      service_id,
    }) => {
      const identity = await authorizePatientConversation(ctx, {
        requireLinked: true,
        requireScheduling: true,
      });
      const result = await createPatientPendingBooking({
        identity,
        doctorId: doctor_id,
        scheduledAt: scheduled_at,
        durationMinutes: duration_minutes,
        serviceId: service_id,
      });
      return result.ok
        ? {
            created: true as const,
            appointment_id: result.appointmentId,
            status: "pending" as const,
            expires_at: result.expiresAt,
            requires_staff_confirmation: true as const,
          }
        : {
            created: false as const,
            reason: result.reason,
            guidance:
              result.reason === "patient_pending_cap"
                ? "The patient already has an active AI-created pending booking."
                : result.reason === "slot_pending_cap"
                  ? "That slot has reached the clinic's pending-request cap. Offer another slot."
                  : "The slot could not be booked. Check availability again.",
          };
    },
  });
}
