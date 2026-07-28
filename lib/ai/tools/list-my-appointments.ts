import "server-only";

import { tool } from "ai";
import { z } from "zod";
import {
  authorizePatientConversation,
  type PatientToolContext,
} from "@/lib/ai/patient-authorization";
import { logAgentTool } from "@/lib/ai/audit";
import { listPatientAiAppointments } from "@/lib/supabase/admin";

export function listMyAppointmentsTool(ctx: PatientToolContext) {
  return tool({
    description:
      "List appointment details only after DOB verification for the patient bound to this conversation. Never ask for or accept a patient id.",
    inputSchema: z.object({}),
    execute: async () => {
      const identity = await authorizePatientConversation(ctx, {
        requireLinked: true,
        requireVerified: true,
      });
      const { data, error } = await listPatientAiAppointments({
        clinicId: identity.clinicId,
        conversationId: identity.conversationId,
      });
      if (error) throw new Error("Could not list patient appointments.");
      await logAgentTool({
        clinicId: identity.clinicId,
        actorId: null,
        tool: "list_my_appointments",
        tableName: "appointments",
        params: { outcome: "success", count: data?.length ?? 0 },
      });
      return { appointments: data ?? [] };
    },
  });
}
