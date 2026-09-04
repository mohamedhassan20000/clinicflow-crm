import "server-only";

import * as Sentry from "@sentry/nextjs";
import type { Tool } from "ai";
import { logAgentTool } from "@/lib/ai/audit";
import { AiToolAuthorizationError } from "@/lib/ai/errors";
import {
  PatientIdentityError,
  type PatientToolContext,
} from "@/lib/ai/patient-authorization";
import type { AiTaskClass } from "@/lib/ai/platform/types";
import { sanitizeUntrustedDeep, withProvenance } from "@/lib/ai/untrusted-text";
import { buildPatientTechnicalFallback } from "@/lib/ai/patient-fallback";
import { answerClinicFaqTool } from "@/lib/ai/tools/answer-clinic-faq";
import { cancelMyAppointmentTool } from "@/lib/ai/tools/cancel-my-appointment";
import { checkPatientAvailabilityTool } from "@/lib/ai/tools/check-patient-availability";
import { checkRescheduleAvailabilityTool } from "@/lib/ai/tools/check-reschedule-availability";
import { confirmBookingIdentityTool } from "@/lib/ai/tools/confirm-booking-identity";
import { compareDoctorAvailabilityTool } from "@/lib/ai/tools/compare-doctor-availability";
import { createPreliminaryBookingTool } from "@/lib/ai/tools/create-preliminary-booking";
import { getClinicInfoTool } from "@/lib/ai/tools/get-clinic-info";
import { listAvailableDaysTool } from "@/lib/ai/tools/list-available-days";
import { listClinicDepartmentsTool } from "@/lib/ai/tools/list-clinic-departments";
import { listClinicInsuranceTool } from "@/lib/ai/tools/list-clinic-insurance";
import { listDepartmentServicesTool } from "@/lib/ai/tools/list-department-services";
import { listDoctorsTool } from "@/lib/ai/tools/list-doctors";
import { listMyAppointmentsTool } from "@/lib/ai/tools/list-my-appointments";
import { lookupAppointmentTool } from "@/lib/ai/tools/lookup-appointment";
import { prepareBookingTool } from "@/lib/ai/tools/prepare-booking";
import { registerPatientTool } from "@/lib/ai/tools/register-patient";
import { rescheduleMyAppointmentTool } from "@/lib/ai/tools/reschedule-my-appointment";
import { verifyPatientIdentityTool } from "@/lib/ai/tools/verify-patient-identity";

export const PATIENT_TOOL_NAMES = [
  "register_patient",
  "confirm_booking_identity",
  "prepare_booking",
  "list_doctors",
  "verify_patient_identity",
  "list_available_days",
  "check_availability",
  "check_reschedule_availability",
  "compare_doctor_availability",
  "create_preliminary_booking",
  "list_my_appointments",
  "lookup_appointment",
  "cancel_my_appointment",
  "reschedule_my_appointment",
  "get_clinic_info",
  "answer_clinic_faq",
  "list_clinic_departments",
  "list_clinic_insurance",
  "list_department_services",
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
        // P11 — the turn's ledger of what the *server* said exists. Recorded
        // before sanitization so it holds the values the tool actually
        // produced, and recorded here rather than in each tool so a new tool
        // cannot be added without its entities being accounted for.
        ctx.grounding?.record(name, payload);
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
                ? "This sender has no patient record yet. Do not escalate and do not refuse: " +
                  "explain naturally that you need a few details to propose their file, use " +
                  "prepare_booking to resolve a real department and doctor, then use register_patient. " +
                  "Never ask for their phone number — the clinic already has it."
                : reason === "human_takeover"
                  ? "A member of clinic staff has taken this conversation over. Do not act and do " +
                    "not send anything."
                : reason === "booking_identity_required"
                  ? "This booking still needs its patient file identified. If this number is " +
                    "already attached to a file, ask the patient to confirm the stored name and " +
                    "call confirm_booking_identity with no arguments. Otherwise ask only for full " +
                    "name and national id and call confirm_booking_identity with both. Do not ask " +
                    "for date of birth for booking identity."
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
        // Anything reaching here is genuinely unexpected — a failed query, a
        // provider hiccup, a bug. Rethrowing turned it into a `tool-error` part
        // and the patient got a bare "technical error" with no way forward,
        // which is what a WhatsApp-only patient is least able to recover from.
        // Every unexpected patient/intake/booking failure now degrades to one
        // apology carrying the clinic's *stored* phone number, and the model
        // still holds the turn, so a retry remains possible.
        Sentry.captureException(error, {
          tags: { area: "patient-ai-tool", tool: name },
        });
        return withProvenance(await buildPatientTechnicalFallback(ctx.clinicId));
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
    get_clinic_info: protectPatientTool(
      "get_clinic_info",
      ctx,
      getClinicInfoTool(ctx),
    ),
    answer_clinic_faq: protectPatientTool(
      "answer_clinic_faq",
      ctx,
      answerClinicFaqTool(ctx),
    ),
    list_clinic_departments: protectPatientTool(
      "list_clinic_departments",
      ctx,
      listClinicDepartmentsTool(ctx),
    ),
    // P10: "which insurers do you take?" and "what do you charge?" are clinic
    // information, not booking steps. They belong on the FAQ mount so a
    // conversation that never books can still get a true answer — and both
    // read live settings, so neither can be answered from the prompt.
    list_clinic_insurance: protectPatientTool(
      "list_clinic_insurance",
      ctx,
      listClinicInsuranceTool(ctx),
    ),
    list_department_services: protectPatientTool(
      "list_department_services",
      ctx,
      listDepartmentServicesTool(ctx),
    ),
  };
  if (taskClass === "patient_faq") return faq;

  return {
    // P8: the way in for somebody the clinic has never met. Mounted alongside
    // the booking tools rather than behind them, because a sender with no
    // patient record used to hit `patient_unlinked` on everything and the
    // assistant's only honest answer was to send them away.
    register_patient: protectPatientTool(
      "register_patient",
      ctx,
      registerPatientTool(ctx),
    ),
    // P10: which patient file a booking belongs to. Mounted beside
    // prepare_booking rather than behind it, because "you're X, correct?" is
    // the first move of a returning patient's booking, not a later step.
    confirm_booking_identity: protectPatientTool(
      "confirm_booking_identity",
      ctx,
      confirmBookingIdentityTool(ctx),
    ),
    prepare_booking: protectPatientTool(
      "prepare_booking",
      ctx,
      prepareBookingTool(ctx),
    ),
    // The read-only roster. Mounted next to prepare_booking so "are there other
    // doctors?" has a move that does not rewrite the conversation's collected
    // department and doctor.
    list_doctors: protectPatientTool("list_doctors", ctx, listDoctorsTool(ctx)),
    verify_patient_identity: protectPatientTool(
      "verify_patient_identity",
      ctx,
      verifyPatientIdentityTool(ctx),
    ),
    list_available_days: protectPatientTool(
      "list_available_days",
      ctx,
      listAvailableDaysTool(ctx),
    ),
    check_availability: protectPatientTool(
      "check_availability",
      ctx,
      checkPatientAvailabilityTool(ctx),
    ),
    check_reschedule_availability: protectPatientTool(
      "check_reschedule_availability",
      ctx,
      checkRescheduleAvailabilityTool(ctx),
    ),
    compare_doctor_availability: protectPatientTool(
      "compare_doctor_availability",
      ctx,
      compareDoctorAvailabilityTool(ctx),
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
    // P11: "ميعادي امتى؟" from a thread the clinic has never linked. Mounted
    // beside `list_my_appointments` rather than instead of it — that one still
    // answers for a DOB-verified linked thread and still requires the stronger
    // check. This one asks for a name and a national id, matches them exactly
    // server-side, and discloses appointment logistics and nothing else.
    lookup_appointment: protectPatientTool(
      "lookup_appointment",
      ctx,
      lookupAppointmentTool(ctx),
    ),
    cancel_my_appointment: protectPatientTool(
      "cancel_my_appointment",
      ctx,
      cancelMyAppointmentTool(ctx),
    ),
    reschedule_my_appointment: protectPatientTool(
      "reschedule_my_appointment",
      ctx,
      rescheduleMyAppointmentTool(ctx),
    ),
    ...faq,
  };
}
