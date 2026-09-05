import "server-only";

import { tool } from "ai";
import { z } from "zod";
import { resolvePatientDate } from "@/lib/ai/patient-input";
import {
  authorizePatientConversation,
  type PatientToolContext,
} from "@/lib/ai/patient-authorization";
import { getPatientAvailableSlots } from "@/lib/booking/patient";
import { filterSlotsAfter, parsePatientAfterTime } from "@/lib/ai/patient-time-constraint";
import { recordStageTurn } from "@/lib/ai/booking-stage-store";
import { preparePatientAiReschedule } from "@/lib/supabase/admin";

const VISIBLE_SLOT_LIMIT = 6;

export function checkRescheduleAvailabilityTool(ctx: PatientToolContext) {
  return tool({
    description:
      "Check a verified patient's own pending appointment against a requested replacement day/time. " +
      "This never changes the appointment. Use the appointment id returned by list_my_appointments.",
    inputSchema: z.object({
      appointment_id: z.string().uuid().optional(),
      date: z.string().trim().min(1).max(60).optional(),
      requested_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
      after_time: z.string().trim().min(1).max(40).optional(),
    }),
    execute: async ({ appointment_id, date, requested_time, after_time }) => {
      const identity = await authorizePatientConversation(ctx, {
        requireLinked: true,
        requireVerified: true,
        requireScheduling: true,
        refuseIfPaused: true,
      });
      const previous = identity.bookingStage.appointmentChange;
      const appointmentId = appointment_id ?? previous?.appointmentId;
      if (!appointmentId) {
        return {
          available: false as const,
          needs_appointment: true as const,
          guidance: "Call list_my_appointments, then use the pending appointment id the patient selected.",
        };
      }
      const prepared = await preparePatientAiReschedule({
        clinicId: identity.clinicId,
        conversationId: identity.conversationId,
        appointmentId,
      });
      const target = prepared.data?.[0];
      if (prepared.error || !target) {
        await recordStageTurn(identity, {
          appointmentChange: null,
          tool: "check_reschedule_availability",
          outcome: "pending_required",
        });
        return {
          available: false as const,
          reason: "pending_required" as const,
          guidance: "Only the verified patient's own future pending request can be changed. Do not create another request.",
        };
      }

      let resolvedDate = date ?? previous?.date;
      if (!resolvedDate) {
        return {
          available: false as const,
          needs_date: true as const,
          current_scheduled_at: target.scheduled_at,
        };
      }
      if (date) {
        const resolved = await resolvePatientDate(identity, "appointment_date", date);
        if (!resolved.ok) return { available: false as const, field: "date", ...resolved.toolResult };
        resolvedDate = resolved.iso;
      }

      const result = await getPatientAvailableSlots({
        identity,
        date: resolvedDate,
        doctorId: target.doctor_id,
        serviceId: target.service_id,
        durationMinutes: target.duration_minutes,
      });
      if (!result.ok) {
        return { available: false as const, reason: result.reason };
      }
      const afterMinutes = parsePatientAfterTime(after_time);
      const filtered = filterSlotsAfter(result.availableSlots, afterMinutes);
      const selectedTime = requested_time && filtered.includes(requested_time)
        ? requested_time
        : null;
      const visible = filtered.slice(0, VISIBLE_SLOT_LIMIT);
      await recordStageTurn(identity, {
        appointmentChange: {
          appointmentId: target.appointment_id,
          doctorId: target.doctor_id,
          doctorName: target.doctor_name,
          departmentId: target.department_id,
          serviceId: target.service_id,
          durationMinutes: target.duration_minutes,
          date: resolvedDate,
          time: selectedTime,
        },
        offeredSlots: { date: resolvedDate, times: visible },
        tool: "check_reschedule_availability",
        outcome: selectedTime ? "confirmation_required" : "availability_checked",
      });
      return {
        available: requested_time ? selectedTime !== null : visible.length > 0,
        appointment_id: target.appointment_id,
        doctor_name: target.doctor_name,
        date: resolvedDate,
        requested_time: requested_time ?? null,
        selected_time: selectedTime,
        available_times: visible,
        has_more: filtered.length > visible.length,
        mutation_performed: false as const,
        requires_explicit_confirmation: selectedTime !== null,
        guidance: selectedTime
          ? "The requested replacement slot is available. Summarize the doctor, localized date and time, state that the request remains pending, and ask for explicit confirmation. Do not mutate yet."
          : requested_time
            ? "The requested time is unavailable. Say so directly and offer only available_times."
            : "Offer only available_times and ask which replacement time the patient wants.",
      };
    },
  });
}
