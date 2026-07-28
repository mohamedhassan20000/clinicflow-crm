import "server-only";

import { tool } from "ai";
import { z } from "zod";
import { assertWorkflowActionAccess } from "@/lib/ai/authorization";
import { workflowInvocationIdentity } from "@/lib/ai/workflows/executor";
import type { DoctorToolContext } from "@/lib/ai/tools/context";
import { createClient } from "@/lib/supabase/server";
import {
  createPendingWorkflowBooking,
  previewPendingWorkflowBooking,
} from "@/lib/booking/pending-workflow";
import { logAgentTool } from "@/lib/ai/audit";

const bookingSchema = z
  .object({
    patient_id: z.string().uuid(),
    doctor_id: z.string().uuid(),
    department_id: z.string().uuid().nullable().optional(),
    scheduled_at: z.string().datetime(),
    duration_minutes: z.number().int().min(15).max(240).default(30),
  })
  .strict();

export function createPendingBookingWorkflowTool(ctx: DoctorToolContext) {
  return tool({
    description:
      "Preview, then after explicit confirmation create exactly one pending appointment. It never confirms the appointment and never notifies the patient.",
    inputSchema: bookingSchema,
    execute: async (booking, options) => {
      await assertWorkflowActionAccess(
        ctx.user,
        "appointments",
        ["admin", "receptionist"],
      );
      const invocation = workflowInvocationIdentity(options);
      const supabase = await createClient();
      if (invocation.mode === "preview") {
        const preview = await previewPendingWorkflowBooking({
          supabase,
          user: ctx.user,
          booking,
        });
        if (!preview) {
          return {
            needs_clarification: true as const,
            field: "scheduled_at",
            guidance:
              "The patient, doctor, department, or selected time is no longer available. Ask the user to choose again.",
            candidates: [],
          };
        }
        await logAgentTool({
          clinicId: ctx.user.clinicId,
          actorId: ctx.user.id,
          tool: "create_pending_booking",
          tableName: "appointments",
          params: { outcome: "previewed", status: "pending" },
        });
        return {
          action: "create_pending_booking" as const,
          draft_status: "awaiting_confirmation" as const,
          booking: preview,
        };
      }

      const created = await createPendingWorkflowBooking({
        supabase,
        user: ctx.user,
        booking,
        workflowRunId: invocation.runId,
        workflowStepId: invocation.stepId,
      });
      if (!created.ok) {
        const guidance =
          created.reason === "patient_pending_cap"
            ? "This patient already has an active AI-created pending booking. Ask staff to confirm, cancel, or let that request expire before previewing another."
            : created.reason === "slot_pending_cap"
              ? "This time has reached the clinic's AI pending-booking cap. Ask the user to preview another available time."
              : "The selected time is no longer available. Ask the user to preview a new pending booking.";
        return {
          needs_clarification: true as const,
          field: "scheduled_at",
          guidance,
          candidates: [],
        };
      }
      await logAgentTool({
        clinicId: ctx.user.clinicId,
        actorId: ctx.user.id,
        tool: "create_pending_booking",
        tableName: "appointments",
        recordId: created.appointmentId,
        params: { outcome: "confirmed", status: "pending" },
      });
      return {
        action: "create_pending_booking" as const,
        draft_status: "pending_created" as const,
        appointment_id: created.appointmentId,
        booking: created.preview,
      };
    },
  });
}
