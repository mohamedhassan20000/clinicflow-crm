import "server-only";

import { tool } from "ai";
import { z } from "zod";
import { establishedDepartmentId } from "@/lib/ai/booking-stage";
import { loadDoctorDirectory, resolveDoctorName } from "@/lib/ai/doctor-directory";
import { resolveThirdPartyDate } from "@/lib/ai/patient-input";
import { filterSlotsAfter, parsePatientAfterTime } from "@/lib/ai/patient-time-constraint";
import {
  authorizePatientConversation,
  type PatientToolContext,
} from "@/lib/ai/patient-authorization";
import { getPatientAvailableSlots } from "@/lib/booking/patient";
import { logAgentTool } from "@/lib/ai/audit";

/** Read-only comparison: it deliberately writes neither booking stage nor offers. */
export function compareDoctorAvailabilityTool(ctx: PatientToolContext) {
  return tool({
    description:
      "Compare real availability for 2–4 named doctors without starting or changing a booking. " +
      "Use for questions like 'which of these two is free tomorrow after 5?'. Pass the date and " +
      "after_time exactly as the patient said. This tool is inquiry-only.",
    inputSchema: z.object({
      doctors: z.array(z.string().trim().min(1).max(120)).min(2).max(4),
      date: z.string().trim().min(1).max(60),
      after_time: z.string().trim().min(1).max(40).optional(),
      duration_minutes: z.number().int().min(15).max(240).multipleOf(15).default(30),
    }),
    execute: async ({ doctors, date, after_time, duration_minutes }) => {
      const identity = await authorizePatientConversation(ctx, { requireScheduling: true });
      const resolvedDate = resolveThirdPartyDate(identity, "appointment_date", date);
      if (!resolvedDate.ok) return { field: "date", ...resolvedDate.toolResult };
      const directory = await loadDoctorDirectory(identity.clinicId);
      const departmentId = establishedDepartmentId(identity.collectedData);
      const uniqueDoctors = [...new Set(doctors.map((name) => name.trim()))];
      const afterMinutes = parsePatientAfterTime(after_time);
      const comparisons = await Promise.all(uniqueDoctors.map(async (reference) => {
        const resolution = resolveDoctorName(reference, directory, departmentId);
        if (resolution.status !== "resolved") {
          return { reference, resolved: false as const, reason: resolution.status };
        }
        const result = await getPatientAvailableSlots({
          identity,
          date: resolvedDate.iso,
          doctorId: resolution.doctor.id,
          durationMinutes: duration_minutes,
        });
        const slots = result.ok
          ? filterSlotsAfter(result.availableSlots, afterMinutes).slice(0, 3)
          : [];
        return {
          reference,
          resolved: true as const,
          doctor: { id: resolution.doctor.id, name: resolution.doctor.name },
          available: slots.length > 0,
          slots,
        };
      }));
      await logAgentTool({
        clinicId: identity.clinicId,
        actorId: null,
        tool: "compare_doctor_availability",
        tableName: "appointments",
        params: {
          outcome: "success",
          doctor_count: comparisons.length,
          time_filter_applied: afterMinutes !== null,
        },
      });
      return {
        ok: true as const,
        inquiry_only: true as const,
        date: resolvedDate.iso,
        comparisons,
        guidance:
          "Answer the comparison directly. Do not start a booking, ask booking-intent questions, " +
          "record an offer, or call a write tool.",
      };
    },
  });
}
