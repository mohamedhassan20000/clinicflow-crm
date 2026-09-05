import "server-only";

import { tool } from "ai";
import { z } from "zod";
import { fromZonedTime } from "date-fns-tz";
import {
  authorizePatientConversation,
  type PatientToolContext,
} from "@/lib/ai/patient-authorization";
import { isExplicitBookingConfirmation } from "@/lib/ai/patient-turn-intent";
import { checkConversationOfferedSlot, recordStageTurn } from "@/lib/ai/booking-stage-store";
import { reschedulePatientAiAppointment } from "@/lib/supabase/admin";

export function rescheduleMyAppointmentTool(ctx: PatientToolContext) {
  return tool({
    description:
      "Atomically replace the verified patient's pending appointment with the server-recorded replacement slot. " +
      "Callable only after a separate explicit-confirmation turn.",
    inputSchema: z.object({}),
    execute: async () => {
      const identity = await authorizePatientConversation(ctx, {
        requireLinked: true,
        requireVerified: true,
        requireScheduling: true,
        refuseIfPaused: true,
      });
      const latest = ctx.episodeUtterances?.at(-1) ?? "";
      if (!isExplicitBookingConfirmation(latest)) {
        return {
          rescheduled: false as const,
          reason: "explicit_confirmation_required" as const,
          mutation_performed: false as const,
        };
      }
      const proposal = identity.bookingStage.appointmentChange;
      if (!proposal?.time) {
        return {
          rescheduled: false as const,
          reason: "replacement_slot_required" as const,
          mutation_performed: false as const,
        };
      }
      const offered = checkConversationOfferedSlot(identity, proposal.date, proposal.time);
      if (offered.status === "rejected") {
        await recordStageTurn(identity, {
          appointmentChange: { ...proposal, time: null },
          tool: "reschedule_my_appointment",
          outcome: "slot_never_offered",
        });
        return {
          rescheduled: false as const,
          reason: "slot_not_offered" as const,
          available_times: offered.offeredForDate,
          mutation_performed: false as const,
        };
      }
      const scheduledAt = fromZonedTime(
        `${proposal.date}T${proposal.time}:00`,
        identity.clinicTimezone,
      ).toISOString();
      const result = await reschedulePatientAiAppointment({
        clinicId: identity.clinicId,
        conversationId: identity.conversationId,
        appointmentId: proposal.appointmentId,
        scheduledAt,
      });
      const row = result.data?.[0];
      const succeeded = !result.error && row?.rescheduled === true;
      await recordStageTurn(identity, {
        appointmentChange: succeeded ? null : proposal,
        clearOfferedSlots: succeeded,
        tool: "reschedule_my_appointment",
        outcome: succeeded ? "rescheduled" : row?.reason ?? "failed",
      });
      return succeeded
        ? {
            rescheduled: true as const,
            appointment_id: row.new_appointment_id,
            scheduled_at: row.scheduled_at,
            status: "pending" as const,
            requires_staff_confirmation: true as const,
          }
        : {
            rescheduled: false as const,
            reason: row?.reason ?? "failed",
            mutation_performed: false as const,
            guidance: "The original request remains unchanged. Recheck availability; never create a second request.",
          };
    },
  });
}
