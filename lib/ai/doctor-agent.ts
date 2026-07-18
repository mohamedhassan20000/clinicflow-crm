import "server-only";

import { ToolLoopAgent, stepCountIs, type InferAgentUIMessage } from "ai";
import {
  DOCTOR_GENERATION,
  MAX_AGENT_STEPS,
  resolveModelId,
} from "@/lib/ai/client";
import { buildDoctorSystemPrompt, type PromptLocale } from "@/lib/ai/prompts/doctor";
import { buildDoctorTools } from "@/lib/ai/tools";
import type { AuthedUser } from "@/lib/rbac";

type DoctorAgentContext = {
  user: AuthedUser;
  locale: PromptLocale;
  clinicName: string;
  patientId?: string | null;
};

/**
 * Creates the read-only doctor persona for one authorized request. Tools close
 * over server-derived identity, so neither the browser nor the model can choose
 * the clinic or actor. Patient context is advisory: every clinical read still
 * passes through the P4A tool authorization and RLS boundaries.
 */
export function createDoctorAgent(ctx: DoctorAgentContext) {
  const patientContext = ctx.patientId
    ? `\n\nThis chat was opened from a patient profile. When the user refers to "this patient", use the internal patient id "${ctx.patientId}" as the patient_id tool argument. Never display that internal id in your answer.`
    : "";

  return new ToolLoopAgent({
    id: "clinicflow-doctor-assistant",
    model: resolveModelId("doctor"),
    instructions:
      buildDoctorSystemPrompt({
        locale: ctx.locale,
        clinicName: ctx.clinicName,
        doctorName: ctx.user.fullName,
      }) + patientContext,
    tools: buildDoctorTools({
      user: ctx.user,
      locale: ctx.locale,
      patientId: ctx.patientId,
    }),
    stopWhen: stepCountIs(MAX_AGENT_STEPS),
    ...DOCTOR_GENERATION,
  });
}

export type DoctorAssistantUIMessage = InferAgentUIMessage<
  ReturnType<typeof createDoctorAgent>
>;
