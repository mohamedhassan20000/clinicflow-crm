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
      status: z
        .enum(["pending", "confirmed", "completed", "cancelled", "no_show"])
        .optional()
        .describe("Optional appointment status filter."),
      doctor: z
        .string()
        .trim()
        .min(2)
        .max(120)
        .optional()
        .describe("Optional doctor name or id."),
      department: z
        .string()
        .trim()
        .min(2)
        .max(120)
        .optional()
        .describe("Optional department name or id."),
    }),
    execute: async ({ status, doctor, department, ...rangeInput }) => {
      await assertAnalyticsToolAccess(ctx.user);
      const supabase = await createClient();
      const range = resolveToolDateRange(rangeInput);

      const doctorFilter = await resolveDoctorFilter(supabase, doctor);
      const doctorClarification = doctor
        ? filterClarification("doctor", doctor, doctorFilter)
        : null;
      if (doctorClarification) return doctorClarification;

      const departmentFilter = await resolveDepartmentFilter(supabase, department);
      const departmentClarification = department
        ? filterClarification("department", department, departmentFilter)
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
