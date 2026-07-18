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
    }),
    execute: async ({ from, to }) => {
      await assertDoctorToolAccess(ctx.user);
      const supabase = await createClient();
      const timeZone = await resolveClinicTimeZone(supabase, ctx.user.clinicId);
      const bounds = clinicDateRangeToUtc(from, to, timeZone);

      const { data } = await supabase
        .from("appointments")
        .select("id, scheduled_at, status, duration_minutes, patients(full_name)")
        .eq("clinic_id", ctx.user.clinicId)
        .eq("doctor_id", ctx.user.id) // own schedule only — not a model parameter
        .is("deleted_at", null)
        .gte("scheduled_at", bounds.start)
        .lte("scheduled_at", bounds.end)
        .order("scheduled_at", { ascending: true })
        .limit(APPT_LIMIT);

      await logAgentTool({
        clinicId: ctx.user.clinicId,
        actorId: ctx.user.id,
        tool: "list_doctor_appointments",
        tableName: "appointments",
        params: { from, to, count: data?.length ?? 0 },
      });

      return {
        appointments: (data ?? []).map((a) => ({
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
