import "server-only";

import { tool } from "ai";
import { z } from "zod";
import { logAgentTool } from "@/lib/ai/audit";
import { loadClinicDepartments } from "@/lib/ai/doctor-directory";
import {
  authorizePatientConversation,
  type PatientToolContext,
} from "@/lib/ai/patient-authorization";

/**
 * Complete, read-only clinic department directory.
 *
 * This tool intentionally accepts no department and returns no doctors. A
 * selected booking department is valid booking state, but it is not a filter
 * on clinic-wide facts.
 */
export function listClinicDepartmentsTool(ctx: PatientToolContext) {
  return tool({
    description:
      "List every active department in this clinic from the live clinic-wide directory. Use for " +
      "general questions such as 'what departments do you have?' or 'are there other " +
      "departments?', even during an existing booking. This is read-only: it never changes the " +
      "selected booking department. The result contains departments only, so do not list doctors " +
      "unless the patient separately asks about or selects a department.",
    inputSchema: z.object({}),
    execute: async () => {
      const identity = await authorizePatientConversation(ctx);
      const departments = await loadClinicDepartments(identity.clinicId);
      await logAgentTool({
        clinicId: identity.clinicId,
        actorId: null,
        tool: "list_clinic_departments",
        tableName: "departments",
        params: { outcome: "success", department_count: departments.length },
      });
      return {
        scope: "clinic_directory" as const,
        complete: true as const,
        departments,
        department_count: departments.length,
        guidance:
          "Answer the clinic-wide question by naming every department in `departments`. Do not " +
          "call the selected booking department the only department, do not omit departments, " +
          "do not list doctors, and do not change or clear the current booking selection.",
      };
    },
  });
}
