/**
 * The sixteen patient tools, with the production names, descriptions and
 * argument schemas, backed by the acceptance simulator.
 *
 * The descriptions and the schemas are copied from `lib/ai/tools/*` rather than
 * simplified, because half of what a model gets right or wrong about a tool is
 * what its description told it. A harness that trimmed them would be measuring
 * a different product.
 *
 * The wrapper reproduces `protectPatientTool`: a thrown error never reaches the
 * model as a stack trace, it becomes the clinic's stored phone number and one
 * apology — which is the behaviour the "no raw DB/tool errors exposed" gate is
 * actually about.
 */

import { tool, type Tool } from "ai";
import { z } from "zod";

import { FIXTURE_CLINIC } from "@/lib/ai/acceptance/fixture-clinic";
import type { AcceptanceSimulator } from "@/lib/ai/acceptance/simulator";
import type { GroundingLedger } from "@/lib/ai/patient-grounding";

const TOOL_TIMEOUT_MS = 8_000;

export type ToolMountOptions = {
  /** Records every server-returned payload, exactly as production does. */
  ledger?: GroundingLedger | null;
  /** Tool names whose call should hang until the harness times it out. */
  hang?: readonly string[];
};

function guard(
  name: string,
  sim: AcceptanceSimulator,
  options: ToolMountOptions,
  run: (input: Record<string, unknown>) => Promise<unknown>,
) {
  return async (input: Record<string, unknown>) => {
    try {
      if (options.hang?.includes(name)) {
        // A provider that never answers. The turn must still end with something
        // a patient can act on.
        await new Promise((resolve) => setTimeout(resolve, TOOL_TIMEOUT_MS));
        throw new Error("ETIMEDOUT");
      }
      const result = await run(input);
      const payload =
        result && typeof result === "object" && !Array.isArray(result)
          ? (result as Record<string, unknown>)
          : { result };
      options.ledger?.record(name, payload);
      return payload;
    } catch {
      // `buildPatientTechnicalFallback`, reproduced: one apology carrying the
      // clinic's stored phone number. Never the error, never the table name.
      const payload = {
        ok: false as const,
        technical_error: true as const,
        clinic_phone: FIXTURE_CLINIC.phone,
        guidance:
          "Apologise once for a temporary technical problem, give the clinic's phone number, and " +
          "do not state any clinic fact you did not already receive from a tool.",
      };
      options.ledger?.record(name, payload);
      return payload;
    }
  };
}

export function buildAcceptanceTools(
  sim: AcceptanceSimulator,
  options: ToolMountOptions = {},
): Record<string, Tool> {
  const g = (name: string, run: (input: never) => Promise<unknown>) =>
    guard(name, sim, options, run as (input: Record<string, unknown>) => Promise<unknown>);

  return {
    register_patient: tool({
      description:
        "Register the person writing in as a new patient of this clinic, when the conversation is " +
        "not yet linked to a patient record. Never ask for, accept, or invent a phone number or a " +
        "patient id.",
      inputSchema: z.object({
        for_someone_else: z.boolean().optional(),
        phone: z.string().trim().min(4).max(40).optional(),
        full_name: z.string().trim().max(120).optional(),
        national_id: z.string().trim().max(40).optional(),
        date_of_birth: z.string().trim().max(60).optional(),
        email: z.string().trim().max(320).optional(),
      }),
      execute: g("register_patient", (i) => sim.registerPatient(i)),
    }),

    confirm_booking_identity: tool({
      description:
        "Confirm which patient file this booking belongs to. Call with no arguments when the " +
        "thread's own number is already on a file and the patient has confirmed the stored name; " +
        "call with full_name and national_id otherwise. Never ask for date of birth here.",
      inputSchema: z.object({
        full_name: z.string().trim().min(2).max(120).optional(),
        national_id: z.string().trim().min(4).max(40).optional(),
      }),
      execute: g("confirm_booking_identity", (i) => sim.confirmBookingIdentity(i)),
    }),

    prepare_booking: tool({
      description:
        "Start or continue appointment booking. Call this first. For an existing patient it " +
        "returns their treating doctor first, together with the other bookable doctors in that " +
        "department. For a new patient it lists active departments, then returns ALL bookable " +
        "doctors of the chosen department. Pass the patient's own words as `doctor` — a name, an " +
        "ordinal, or a request such as 'another doctor' / 'في دكاترة غيره؟'.",
      inputSchema: z.object({
        department: z.string().trim().min(1).max(120).optional(),
        doctor: z.string().trim().min(1).max(120).optional(),
        show_other_doctors: z.boolean().optional(),
      }),
      execute: g("prepare_booking", (i) => sim.prepareBooking(i)),
    }),

    list_doctors: tool({
      description:
        "List every bookable doctor of one department. Use it for follow-ups such as 'are there " +
        "other doctors?', 'مين تاني؟'. With no department it uses the one this conversation " +
        "already chose, so the booking context is preserved.",
      inputSchema: z.object({
        department: z.string().trim().min(1).max(120).optional(),
        exclude_doctor_id: z.string().trim().min(1).max(120).optional(),
      }),
      execute: g("list_doctors", (i) => sim.listDoctors(i)),
    }),

    verify_patient_identity: tool({
      description:
        "Verify the patient using their date of birth before showing any appointment details.",
      inputSchema: z.object({ date_of_birth: z.string().trim().min(4).max(60) }),
      execute: g("verify_patient_identity", (i) => sim.verifyIdentity(i)),
    }),

    list_available_days: tool({
      description:
        "List real days that have at least one bookable slot for the resolved doctor. Call this " +
        "after doctor selection and before check_availability. Days only, never times.",
      inputSchema: z.object({
        doctor_id: z.string().trim().min(1).max(80).optional(),
        duration_minutes: z.number().int().min(15).max(240).multipleOf(15).default(30),
        search_days: z.number().int().min(1).max(60).default(21),
        service_id: z.string().trim().min(1).max(80).optional(),
      }),
      execute: g("list_available_days", (i) => sim.listAvailableDays(i)),
    }),

    check_availability: tool({
      description:
        "Check real clinic appointment availability for a day. Pass the day the way the patient " +
        "described it. Availability is logistics-only and does not require DOB verification.",
      inputSchema: z.object({
        date: z.string().trim().min(1).max(60),
        doctor_id: z.string().trim().min(1).max(80).optional(),
        service_id: z.string().trim().min(1).max(80).optional(),
        duration_minutes: z.number().int().min(15).max(240).multipleOf(15).default(30),
      }),
      execute: g("check_availability", (i) => sim.checkAvailability(i)),
    }),

    create_preliminary_booking: tool({
      description:
        "Create a preliminary pending appointment for an existing verified patient, or a " +
        "real-slot pending request for a provisional intake. The clinic must confirm it. Never " +
        "ask for or accept a patient id.",
      inputSchema: z.object({
        doctor_id: z.string().trim().min(1).max(80).optional(),
        scheduled_at: z.string().optional(),
        date: z.string().trim().min(1).max(60).optional(),
        time: z.string().trim().min(1).max(60).optional(),
        duration_minutes: z.number().int().min(15).max(240).multipleOf(15).default(30),
        service_id: z.string().trim().min(1).max(80).optional(),
        for_someone_else: z.boolean().optional(),
      }),
      execute: g("create_preliminary_booking", (i) => sim.createBooking(i)),
    }),

    list_my_appointments: tool({
      description: "List the patient's upcoming appointments, after identity verification.",
      inputSchema: z.object({}),
      execute: g("list_my_appointments", () => sim.listAppointments()),
    }),

    lookup_appointment: tool({
      description:
        "Find an appointment for a patient writing from a number the clinic has not linked, using " +
        "their full name and national id. Discloses appointment logistics only.",
      inputSchema: z.object({
        full_name: z.string().trim().min(2).max(120).optional(),
        national_id: z.string().trim().min(4).max(40).optional(),
      }),
      execute: g("lookup_appointment", (i) => sim.lookupAppointment(i)),
    }),

    cancel_my_appointment: tool({
      description: "Cancel one pending appointment the patient owns.",
      inputSchema: z.object({ appointment_id: z.string().trim().min(4).max(80) }),
      execute: g("cancel_my_appointment", (i) => sim.cancelAppointment(i)),
    }),

    get_clinic_info: tool({
      description: "The clinic's stored name, address, phone, website and working hours.",
      inputSchema: z.object({ question: z.string().trim().min(1).max(500).optional() }),
      execute: g("get_clinic_info", () => sim.clinicInfo()),
    }),

    answer_clinic_faq: tool({
      description: "Answer from clinic-authored FAQ entries only.",
      inputSchema: z.object({ question: z.string().trim().min(1).max(500) }),
      execute: g("answer_clinic_faq", (i) => sim.faq(i)),
    }),

    list_clinic_departments: tool({
      description:
        "List every active department in this clinic from the live clinic-wide directory. Use for " +
        "general questions such as 'what departments do you have?', even during an existing " +
        "booking. Read-only: it never changes the selected booking department.",
      inputSchema: z.object({}),
      execute: g("list_clinic_departments", () => sim.listClinicDepartments()),
    }),

    list_clinic_insurance: tool({
      description:
        "The insurers this clinic accepts, from its settings. Use for 'do you take my insurance?'. " +
        "Never name an insurer that is not in the result.",
      inputSchema: z.object({ provider: z.string().trim().min(1).max(120).optional() }),
      execute: g("list_clinic_insurance", (i) => sim.listClinicInsurance(i)),
    }),

    list_department_services: tool({
      description:
        "List the real services and current prices this clinic offers, from its settings. Use for " +
        "'what services do you offer?', 'بكام الكشف؟'. If the conversation has already settled a " +
        "department, call this with no arguments. Never invent a service or a price.",
      inputSchema: z.object({
        department: z.string().trim().min(1).max(120).optional(),
        all_departments: z.boolean().optional(),
      }),
      execute: g("list_department_services", (i) => sim.listDepartmentServices(i)),
    }),
  };
}
