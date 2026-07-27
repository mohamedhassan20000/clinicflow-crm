import "server-only";

import { tool } from "ai";
import { z } from "zod";
import { assertAnalyticsToolAccess } from "@/lib/ai/authorization";
import { logAgentTool } from "@/lib/ai/audit";
import { createClient } from "@/lib/supabase/server";
import type { DoctorToolContext } from "@/lib/ai/tools/context";
import {
  filterClarification,
  resolveDepartmentFilter,
  resolveDoctorFilter,
} from "@/lib/ai/tools/entity-filters";
import {
  dateRangeInputSchema,
  describeRange,
  resolveToolDateRange,
} from "@/lib/ai/tools/range";
import { activeEntityId } from "@/lib/ai/conversation-context";

/** Hard row cap. The assistant summarizes; it is not a bulk export path. */
const ROW_CAP = 50;

/**
 * list_appointments — bounded operational list for admin/manager/receptionist.
 *
 * Two containment rules matter here. The query runs on the authenticated RLS
 * client (so clinic isolation and every existing appointment policy apply
 * unchanged), and the selected columns are a fixed allow-list limited to what
 * these roles already see in the appointments UI: schedule, status, patient
 * name/file number, doctor, department. Appointment notes, cancellation
 * reasons, and every financial column are deliberately excluded.
 */
export function listAppointmentsTool(ctx: DoctorToolContext) {
  return tool({
    description:
      "List individual appointments in a date range, optionally filtered by status, doctor, or department. Doctor and department may be given by name; when a name is ambiguous the tool returns candidates and asks you to have the user choose rather than guessing. Returns at most 50 appointments with schedule, status, patient name, file number, doctor, and department. Use get_appointment_stats for counts and rates instead of listing and counting yourself.",
    inputSchema: dateRangeInputSchema.extend({
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
          "Set true only when the user explicitly refers to the active appointment (for example, “this appointment”). Omit or set false for broad appointment lists.",
        ),
      status: z
        .enum(["pending", "confirmed", "completed", "cancelled", "no_show", "replaced"])
        .optional()
        .describe("Optional appointment status filter."),
      doctor: z
        .string()
        .trim()
        .min(2)
        .max(120)
        .optional()
        .describe("Optional doctor name or id."),
      use_active_staff: z
        .boolean()
        .optional()
        .describe(
          "Set true only when the user explicitly scopes the request to the active staff member. Omit or set false for clinic-wide or otherwise broad lists.",
        ),
      department: z
        .string()
        .trim()
        .min(2)
        .max(120)
        .optional()
        .describe("Optional department name or id."),
      use_active_department: z
        .boolean()
        .optional()
        .describe(
          "Set true only when the user explicitly scopes the request to the active department. Omit or set false for clinic-wide or otherwise broad lists.",
        ),
    }),
    execute: async ({
      appointment_id,
      use_active_appointment,
      status,
      doctor,
      use_active_staff,
      department,
      use_active_department,
      ...rangeInput
    }) => {
      await assertAnalyticsToolAccess(ctx.user);
      const supabase = await createClient();
      const range = resolveToolDateRange(rangeInput);
      const activeAppointmentId = activeEntityId(ctx.activeContext, "appointment");
      const activeStaffId = activeEntityId(ctx.activeContext, "staff");
      const activeDepartmentId = activeEntityId(ctx.activeContext, "department");
      const effectiveAppointmentId =
        appointment_id ??
        (use_active_appointment === true ? activeAppointmentId : null);
      const effectiveDoctor =
        doctor ??
        (use_active_staff === true ? activeStaffId ?? undefined : undefined);
      const effectiveDepartment =
        department ??
        (use_active_department === true
          ? activeDepartmentId ?? undefined
          : undefined);

      if (use_active_appointment === true && !appointment_id && !activeAppointmentId) {
        return {
          needs_clarification: true,
          field: "appointment_id",
          guidance:
            "There is no active appointment in this conversation. Ask the user which appointment they mean.",
          candidates: [],
        };
      }
      if (use_active_staff === true && !doctor && !activeStaffId) {
        return {
          needs_clarification: true,
          field: "doctor",
          guidance:
            "There is no active staff member in this conversation. Ask the user which staff member they mean.",
          candidates: [],
        };
      }
      if (use_active_department === true && !department && !activeDepartmentId) {
        return {
          needs_clarification: true,
          field: "department",
          guidance:
            "There is no active department in this conversation. Ask the user which department they mean.",
          candidates: [],
        };
      }

      const doctorFilter = await resolveDoctorFilter(supabase, effectiveDoctor);
      const doctorClarification = effectiveDoctor
        ? filterClarification("doctor", effectiveDoctor, doctorFilter)
        : null;
      if (doctorClarification) return doctorClarification;

      const departmentFilter = await resolveDepartmentFilter(supabase, effectiveDepartment);
      const departmentClarification = effectiveDepartment
        ? filterClarification("department", effectiveDepartment, departmentFilter)
        : null;
      if (departmentClarification) return departmentClarification;

      let query = supabase
        .from("appointments")
        .select(
          "id, scheduled_at, status, duration_minutes, patients(full_name, file_number), profiles!doctor_id(full_name), departments(name)",
        )
        .eq("clinic_id", ctx.user.clinicId)
        .is("deleted_at", null)
        .gte("scheduled_at", range.start.toISOString())
        .lte("scheduled_at", range.end.toISOString());

      if (effectiveAppointmentId) query = query.eq("id", effectiveAppointmentId);
      if (status) query = query.eq("status", status);
      if (doctorFilter.id) query = query.eq("doctor_id", doctorFilter.id);
      if (departmentFilter.id) query = query.eq("department_id", departmentFilter.id);

      // Fetch one past the cap so "there is more" can be distinguished from
      // "there is exactly this much". Comparing `rows.length === ROW_CAP` told
      // a clinic with exactly 50 appointments in range that its list had been
      // cut short — a user-visible notice that was simply untrue.
      const { data, error } = await query
        .order("scheduled_at", { ascending: true })
        .limit(ROW_CAP + 1);
      if (error) throw new Error("Appointment list lookup failed.");

      const fetched = data ?? [];
      const truncated = fetched.length > ROW_CAP;
      const rows = truncated ? fetched.slice(0, ROW_CAP) : fetched;

      if (ctx.conversationId) {
        if (doctorFilter.status === "resolved" && doctorFilter.trustedForContext) {
          ctx.contextRecorder?.propose(
            "staff",
            doctorFilter.id,
            doctorFilter.label,
            "resolution",
          );
        }
        if (
          departmentFilter.status === "resolved" &&
          departmentFilter.trustedForContext
        ) {
          ctx.contextRecorder?.propose(
            "department",
            departmentFilter.id,
            departmentFilter.label,
            "resolution",
          );
        }
        // A single row derived from RLS-authorized filters is a deterministic
        // resolution. A model-supplied appointment id is deliberately excluded:
        // like P4.10A's patient tools, it may authorize this one call but may
        // never become trusted stored context.
        if (
          rows.length === 1 &&
          !truncated &&
          !appointment_id &&
          !activeAppointmentId
        ) {
          const row = rows[0]!;
          const label = [row.patients?.full_name, row.scheduled_at]
            .filter(Boolean)
            .join(" · ");
          ctx.contextRecorder?.propose(
            "appointment",
            row.id,
            label || row.id,
            "resolution",
          );
        }
      }

      await logAgentTool({
        clinicId: ctx.user.clinicId,
        actorId: ctx.user.id,
        tool: "list_appointments",
        tableName: "appointments",
        params: {
          preset: range.preset,
          from: range.from,
          to: range.to,
          status: status ?? null,
          appointment_filtered: Boolean(effectiveAppointmentId),
          from_active_context: {
            appointment:
              use_active_appointment === true &&
              !appointment_id &&
              Boolean(activeAppointmentId),
            staff:
              use_active_staff === true && !doctor && Boolean(activeStaffId),
            department:
              use_active_department === true &&
              !department &&
              Boolean(activeDepartmentId),
          },
          doctor_filtered: Boolean(doctorFilter.id),
          department_filtered: Boolean(departmentFilter.id),
          count: rows.length,
        },
      });

      return {
        range: describeRange(range),
        truncated,
        row_cap: ROW_CAP,
        appointments: rows.map((row) => ({
          id: row.id,
          scheduled_at: row.scheduled_at,
          status: row.status,
          duration_minutes: row.duration_minutes,
          patient_name: row.patients?.full_name ?? null,
          patient_file_number: row.patients?.file_number ?? null,
          doctor_name: row.profiles?.full_name ?? null,
          department_name: row.departments?.name ?? null,
        })),
      };
    },
  });
}
