import "server-only";

import type { Tool } from "ai";
import { logAgentTool } from "@/lib/ai/audit";
import { AiToolAuthorizationError } from "@/lib/ai/errors";
import {
  PatientIdentityError,
  type PatientToolContext,
} from "@/lib/ai/patient-authorization";
import type { AiTaskClass } from "@/lib/ai/platform/types";
import { sanitizeUntrustedDeep, withProvenance } from "@/lib/ai/untrusted-text";
import { answerClinicFaqTool } from "@/lib/ai/tools/answer-clinic-faq";
import { cancelMyAppointmentTool } from "@/lib/ai/tools/cancel-my-appointment";
import { checkPatientAvailabilityTool } from "@/lib/ai/tools/check-patient-availability";
import { createPreliminaryBookingTool } from "@/lib/ai/tools/create-preliminary-booking";
import { listMyAppointmentsTool } from "@/lib/ai/tools/list-my-appointments";
import { verifyPatientIdentityTool } from "@/lib/ai/tools/verify-patient-identity";

export const PATIENT_TOOL_NAMES = [
  "verify_patient_identity",
  "check_availability",
  "create_preliminary_booking",
  "list_my_appointments",
  "cancel_my_appointment",
  "answer_clinic_faq",
] as const;

type PatientTaskClass = Extract<AiTaskClass, "patient_booking" | "patient_faq">;

function protectPatientTool(
  name: (typeof PATIENT_TOOL_NAMES)[number],
  ctx: PatientToolContext,
  built: Tool,
): Tool {
  const execute = built.execute;
  if (typeof execute !== "function") return built;
  return {
    ...built,
    execute: async (...args: Parameters<typeof execute>) => {
      try {
        const result = await execute(...args);
        const payload =
          result && typeof result === "object" && !Array.isArray(result)
            ? (result as Record<string, unknown>)
            : { result };
        return withProvenance(sanitizeUntrustedDeep(payload));
      } catch (error) {
        if (
          error instanceof PatientIdentityError ||
          error instanceof AiToolAuthorizationError
        ) {
          const reason =
            error instanceof PatientIdentityError ? error.reason : error.reason;
          await logAgentTool({
            clinicId: ctx.clinicId,
            actorId: null,
            tool: name,
            params: { outcome: "denied", reason },
          });
          return withProvenance({
            permission_denied: true,
            reason,
            guidance:
              reason === "patient_unlinked"
                ? "This sender is not linked to a patient. Escalate to clinic staff."
                : reason === "identity_verification_required"
                  ? "Ask for date of birth, then call verify_patient_identity. Do not reveal appointment details yet."
                  : reason === "identity_verification_locked"
                    ? "Do not retry verification. Ask the patient to contact clinic staff."
                    : "This capability is unavailable. Do not retry or infer any data.",
          });
        }
        await logAgentTool({
          clinicId: ctx.clinicId,
          actorId: null,
          tool: name,
          params: { outcome: "error" },
        });
        throw error;
      }
    },
  } as Tool;
}

/**
 * Patient persona mount is deliberately independent of the staff registry.
 * No staff, clinical-summary, reporting, financial, workflow, or navigation
 * tool can enter this object, even if prompt content asks for one.
 */
export function buildPatientTools(
  ctx: PatientToolContext,
  taskClass: PatientTaskClass,
): Record<string, Tool> {
  const faq = {
    answer_clinic_faq: protectPatientTool(
      "answer_clinic_faq",
      ctx,
      answerClinicFaqTool(ctx),
    ),
  };
  if (taskClass === "patient_faq") return faq;

  return {
    verify_patient_identity: protectPatientTool(
      "verify_patient_identity",
      ctx,
      verifyPatientIdentityTool(ctx),
    ),
    check_availability: protectPatientTool(
      "check_availability",
      ctx,
      checkPatientAvailabilityTool(ctx),
    ),
    create_preliminary_booking: protectPatientTool(
      "create_preliminary_booking",
      ctx,
      createPreliminaryBookingTool(ctx),
    ),
    list_my_appointments: protectPatientTool(
      "list_my_appointments",
      ctx,
      listMyAppointmentsTool(ctx),
    ),
    cancel_my_appointment: protectPatientTool(
      "cancel_my_appointment",
      ctx,
      cancelMyAppointmentTool(ctx),
    ),
    ...faq,
  };
}
