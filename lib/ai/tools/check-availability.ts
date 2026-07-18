import "server-only";
import { z } from "zod";
import { tool } from "ai";
import { createClient } from "@/lib/supabase/server";
import { assertDoctorToolAccess } from "@/lib/ai/authorization";
import { logAgentTool } from "@/lib/ai/audit";
import { computeAvailableSlots } from "@/lib/booking/availability";
import {
  ISO_DATE_RE,
  omitElapsedClinicSlots,
  resolveClinicTimeZone,
  type DoctorToolContext,
} from "@/lib/ai/tools/context";

/**
 * check_availability(doctor_id?, date, service?) — both personas (§6.3 row 4).
 * Reports availability from the single booking core (computeAvailableSlots), so
 * the agent can never invent an open slot. Availability is not patient PHI, so
 * doctor_id is an allowed model parameter here; when omitted the caller's own
 * schedule is used. The read still goes through the RLS client.
 */
export function checkAvailabilityTool(ctx: DoctorToolContext) {
  return tool({
    description:
      "Check open appointment slots on a given date. Optionally scope to a specific doctor id; when omitted the current doctor's schedule is used. Returns the list of free start times (HH:MM) in clinic-local time.",
    inputSchema: z.object({
      date: z.string().regex(ISO_DATE_RE).describe("The date to check (YYYY-MM-DD)."),
      doctor_id: z
        .string()
        .uuid()
        .optional()
        .describe("Optional doctor id. Defaults to the current doctor."),
      service: z
        .string()
        .trim()
        .max(200)
        .optional()
        .describe("Optional service name for context."),
    }),
    execute: async ({ date, doctor_id, service }) => {
      await assertDoctorToolAccess(ctx.user);
      const supabase = await createClient();
      const timeZone = await resolveClinicTimeZone(supabase, ctx.user.clinicId);

      const doctorId =
        doctor_id ?? (ctx.user.role === "doctor" ? ctx.user.id : null);

      const slots = await computeAvailableSlots({
        supabase,
        clinicId: ctx.user.clinicId,
        doctorId,
        dateIso: date,
        timeZone,
      });
      const available = omitElapsedClinicSlots(
        date,
        slots.filter((s) => !s.disabled).map((s) => s.time),
        timeZone,
      );

      await logAgentTool({
        clinicId: ctx.user.clinicId,
        actorId: ctx.user.id,
        tool: "check_availability",
        tableName: "appointments",
        recordId: doctorId,
        params: { date, doctor_id: doctorId, service: service ?? null, count: available.length },
      });

      return { date, doctor_id: doctorId, available_slots: available };
    },
  });
}
