import "server-only";
import { z } from "zod";
import { tool } from "ai";
import { createClient } from "@/lib/supabase/server";
import { assertDoctorToolAccess } from "@/lib/ai/authorization";
import { logAgentTool } from "@/lib/ai/audit";
import {
  clinicDateRangeToUtc,
  ISO_DATE_RE,
  resolveClinicTimeZone,
  type DoctorToolContext,
} from "@/lib/ai/tools/context";
import { activeEntityId } from "@/lib/ai/conversation-context";

const APPT_LIMIT = 100;

/**
 * list_doctor_appointments(date_range) — doctor (§6.3 row 3). The doctor's own
 * id comes from the session, never from the model, so this tool can only ever
 * list the caller's own schedule. RLS is the backstop.
 */
export function listDoctorAppointmentsTool(ctx: DoctorToolContext) {
  return tool({
    description:
      "List the current doctor's own appointments within a date range (inclusive), ordered by time. Returns appointment date, status, duration, and patient name.",
    inputSchema: z.object({
      from: z.string().regex(ISO_DATE_RE).describe("Inclusive start date (YYYY-MM-DD)."),
      to: z.string().regex(ISO_DATE_RE).describe("Inclusive end date (YYYY-MM-DD)."),
      appointment_id: z
        .string()
        .uuid()
        .optional()
        .describe(
          "Optional appointment id explicitly named by the user. Do not copy the active context id into this field; use use_active_appointment instead.",
        ),
      use_active_appointment: z
        .boolean()
        .optional()
        .describe(
          "Set true only when the user explicitly refers to the active appointment. Omit or set false for a broad list of the doctor's schedule.",
        ),
    }),
    execute: async ({ from, to, appointment_id, use_active_appointment }) => {
      await assertDoctorToolAccess(ctx.user);
      const supabase = await createClient();
      const timeZone = await resolveClinicTimeZone(supabase, ctx.user.clinicId);
      const bounds = clinicDateRangeToUtc(from, to, timeZone);
      const activeAppointmentId = activeEntityId(ctx.activeContext, "appointment");
      const effectiveAppointmentId =
        appointment_id ??
        (use_active_appointment === true ? activeAppointmentId : null);

      if (use_active_appointment === true && !appointment_id && !activeAppointmentId) {
        return {
          needs_clarification: true,
          field: "appointment_id",
          guidance:
            "There is no active appointment in this conversation. Ask the user which appointment they mean.",
          candidates: [],
        };
      }

      let query = supabase
        .from("appointments")
        .select("id, scheduled_at, status, duration_minutes, patients(full_name)")
        .eq("clinic_id", ctx.user.clinicId)
        .eq("doctor_id", ctx.user.id) // own schedule only — not a model parameter
        .is("deleted_at", null)
        .gte("scheduled_at", bounds.start)
        .lte("scheduled_at", bounds.end);
      if (effectiveAppointmentId) query = query.eq("id", effectiveAppointmentId);
      const { data } = await query
        .order("scheduled_at", { ascending: true })
        .limit(APPT_LIMIT + 1);
      const fetched = data ?? [];
      const truncated = fetched.length > APPT_LIMIT;
      const rows = truncated ? fetched.slice(0, APPT_LIMIT) : fetched;

      if (
        rows.length === 1 &&
        !truncated &&
        !appointment_id &&
        !activeAppointmentId &&
        ctx.conversationId
      ) {
        const appointment = rows[0]!;
        const patientName =
          (appointment.patients as { full_name: string } | null)?.full_name ?? null;
        ctx.contextRecorder?.propose(
          "appointment",
          appointment.id,
          [patientName, appointment.scheduled_at].filter(Boolean).join(" · "),
          "resolution",
        );
      }

      await logAgentTool({
        clinicId: ctx.user.clinicId,
        actorId: ctx.user.id,
        tool: "list_doctor_appointments",
        tableName: "appointments",
        params: {
          from,
          to,
          count: rows.length,
          appointment_filtered: Boolean(effectiveAppointmentId),
          from_active_context:
            use_active_appointment === true &&
            !appointment_id &&
            Boolean(activeAppointmentId),
        },
      });

      return {
        appointments: rows.map((a) => ({
          id: a.id,
          date: a.scheduled_at,
          status: a.status,
          duration_minutes: a.duration_minutes,
          patient_name:
            (a.patients as { full_name: string } | null)?.full_name ?? null,
        })),
      };
    },
  });
}
