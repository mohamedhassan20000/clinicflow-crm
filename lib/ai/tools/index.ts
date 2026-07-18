import "server-only";
import { getPatientSummaryTool } from "@/lib/ai/tools/get-patient-summary";
import { searchPatientVisitsTool } from "@/lib/ai/tools/search-patient-visits";
import { listDoctorAppointmentsTool } from "@/lib/ai/tools/list-doctor-appointments";
import { checkAvailabilityTool } from "@/lib/ai/tools/check-availability";
import type { DoctorToolContext } from "@/lib/ai/tools/context";

export type { DoctorToolContext } from "@/lib/ai/tools/context";

/**
 * Builds the doctor persona's tool set (§6.3 rows 1–4). The tool array is
 * constructed per persona in code, never selected by prompt (§9.4): the doctor
 * assistant mounts only these read-only tools, and no write or patient tool is
 * reachable here. Each tool independently re-checks role and queries through
 * the RLS client, so authorization holds even if a tool is wired incorrectly.
 */
export function buildDoctorTools(ctx: DoctorToolContext) {
  return {
    get_patient_summary: getPatientSummaryTool(ctx),
    search_patient_visits: searchPatientVisitsTool(ctx),
    list_doctor_appointments: listDoctorAppointmentsTool(ctx),
    check_availability: checkAvailabilityTool(ctx),
  };
}

export const DOCTOR_TOOL_NAMES = [
  "get_patient_summary",
  "search_patient_visits",
  "list_doctor_appointments",
  "check_availability",
] as const;
