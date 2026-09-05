import "server-only";

import { tool } from "ai";
import { z } from "zod";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { resolvePatientBookingTarget } from "@/lib/ai/booking-target";
import { doctorRefSchema, serviceRefSchema } from "@/lib/ai/tools/booking-refs";
import {
  checkConversationOfferedSlot,
  recordStageTurn,
} from "@/lib/ai/booking-stage-store";
import { resolveOptionIndex } from "@/lib/ai/entity-resolution";
import {
  assertPatientBookingIdentity,
  authorizePatientConversation,
  type PatientToolContext,
} from "@/lib/ai/patient-authorization";
import { resolvePatientDate, resolvePatientInput } from "@/lib/ai/patient-input";
import {
  createPatientPendingBooking,
  getPatientAvailableSlots,
} from "@/lib/booking/patient";
import {
  getPatientClinicPublicInfo,
  getPendingConversationIntake,
} from "@/lib/supabase/admin";

const CANONICAL_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export function createPreliminaryBookingTool(ctx: PatientToolContext) {
  return tool({
    description:
      "Create a preliminary pending appointment for an existing verified patient, or a real-slot " +
      "pending request for a staged intake. The clinic must confirm it. Natural date/time " +
      "answers are accepted. Never ask for or accept a patient id. When the appointment is for " +
      "somebody other than the person writing in, set `for_someone_else`: that person must have " +
      "been staged with register_patient first, and the appointment is filed against their staged " +
      "file, never against the sender's record.",
    inputSchema: z.object({
        doctor_id: doctorRefSchema.optional(),
        scheduled_at: z.string().datetime({ offset: true }).optional(),
        date: z.string().trim().min(2).max(60).optional(),
        time: z.string().trim().min(1).max(60).optional(),
        duration_minutes: z.number().int().min(15).max(240).multipleOf(15).default(30),
        service_id: serviceRefSchema.optional(),
        for_someone_else: z
          .boolean()
          .optional()
          .describe(
            "True when the appointment is for a person the sender staged with register_patient.",
          ),
      }),
    execute: async ({
      doctor_id,
      scheduled_at,
      date,
      time,
      duration_minutes,
      service_id,
      for_someone_else,
    }) => {
      const identity = await authorizePatientConversation(ctx, {
        requireScheduling: true,
        // P8: a staff member who has taken this thread over is mid-conversation
        // with the patient. Creating a booking underneath them is the exact
        // collision human takeover exists to prevent.
        refuseIfPaused: true,
      });
      // P9C — booking for somebody else is only possible once they exist as a
      // staged file. Checked here, before anything is resolved or written, so
      // the answer is "stage them first" rather than a failed write: the
      // database refuses this too, but it refuses with an exception, and an
      // exception on the booking path is what the patient hears as a technical
      // problem.
      const pendingIntake = await getPendingConversationIntake({
        clinicId: identity.clinicId,
        conversationId: identity.conversationId,
      });
      const stagedThirdParty = pendingIntake.data?.is_third_party === true;
      assertPatientBookingIdentity(identity, {
        forSomeoneElse:
          for_someone_else === true ||
          stagedThirdParty ||
          identity.bookingStage?.bookingForOther === true,
      });
      if (for_someone_else === true && !stagedThirdParty) {
        await recordStageTurn(identity, {
          bookingIntent: true,
          tool: "create_preliminary_booking",
          outcome: "intake_required",
          bookingForOther: true,
        });
        return {
          created: false as const,
          reason: "intake_required" as const,
          needs_intake: true as const,
          guidance:
            "This appointment is for somebody else and that person has no staged file yet. Do not " +
            "book anything against the sender's record. Collect the other person's full name, " +
            "national or civil id, date of birth and email, then call register_patient with " +
            "for_someone_else set. Continue the booking from there.",
        };
      }

      // P9B: the booking call resolves its doctor the same way the availability
      // calls do. A uuid the clinic did not issue can no longer reach
      // `ai_create_preliminary_booking`, where it would have surfaced as an
      // opaque `create_failed`.
      const target = await resolvePatientBookingTarget({
        identity,
        doctorId: doctor_id ?? null,
        serviceId: service_id ?? null,
        patientText: ctx.episodeUtterances?.at(-1) ?? null,
      });
      if (target.status === "unresolved") {
        await recordStageTurn(identity, {
          bookingIntent: true,
          tool: "create_preliminary_booking",
          outcome: target.outcome,
        });
        return { created: false as const, ...target.payload };
      }
      const resolvedDoctorId = target.doctor.id;
      const resolvedServiceId = target.serviceId;

      let resolvedScheduledAt = scheduled_at;
      if (!resolvedScheduledAt) {
        const dateOutcome = await resolvePatientDate(identity, "appointment_date", date ?? "");
        if (!dateOutcome.ok) return { created: false as const, field: "date", ...dateOutcome.toolResult };
        const optionIndex = resolveOptionIndex(time ?? "");
        let localTime: string;
        if (optionIndex !== null) {
          const availability = await getPatientAvailableSlots({
            identity,
            date: dateOutcome.iso,
            doctorId: resolvedDoctorId,
            serviceId: resolvedServiceId,
            durationMinutes: duration_minutes,
          });
          if (!availability.ok || !availability.availableSlots[optionIndex]) {
            return {
              created: false as const,
              needs_clarification: true as const,
              field: "time",
              guidance: "That option is not currently available. Offer only the real slots returned by check_availability.",
            };
          }
          localTime = `${availability.availableSlots[optionIndex]}:00`;
        } else if (CANONICAL_TIME.test((time ?? "").trim())) {
          // A zero-padded 24-hour `HH:mm` — the exact shape `check_availability`
          // returns, and the shape the model echoes back when the patient picks
          // a slot. It carries no meridiem ambiguity to resolve, and running it
          // through the conversational resolver asked "morning or evening?"
          // about a time the *server* had chosen: a question with no honest
          // answer, and a step that stalled the booking one move from done.
          //
          // Booking a time nobody offered is a different concern, and it is
          // still handled a few lines below by the offered-slot guard, with the
          // availability recheck at the boundary behind it.
          localTime = `${(time ?? "").trim()}:00`;
        } else {
          const timeOutcome = await resolvePatientInput(identity, "appointment_time", time ?? "");
          if (!timeOutcome.ok) {
            return {
              created: false as const,
              needs_clarification: true as const,
              field: "time",
              reason: timeOutcome.reason,
              guidance: timeOutcome.guidance,
            };
          }
          const minutes = Number(timeOutcome.value);
          localTime = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}:00`;
        }
        resolvedScheduledAt = fromZonedTime(
          `${dateOutcome.iso}T${localTime}`,
          identity.clinicTimezone,
        ).toISOString();
      }
      // P9 — the offered-options guard.
      //
      // `ai_requested_slot_is_available` already refuses a slot the clinic
      // cannot serve, so a time that does not exist is caught. What was never
      // caught is a time that happens to be free but was never *offered*: the
      // model volunteering "how about 4pm?" and then booking it because 4pm was
      // open. That produces a real appointment the patient never chose, and no
      // amount of prompt wording prevents it, because the prompt is advice.
      //
      // The check runs against the slots `check_availability` actually returned,
      // recorded server-side, and it applies to `scheduled_at` exactly as it
      // applies to a natural date and time — the two paths converge here on
      // purpose, because the direct-timestamp path is the easier one to hallucinate
      // into. It is conditional on there being a recorded offer at all, so it can
      // never invent a dead end on a conversation the availability flow never ran.
      const requestedLocalDate = formatInTimeZone(
        new Date(resolvedScheduledAt),
        identity.clinicTimezone,
        "yyyy-MM-dd",
      );
      const requestedLocalTime = formatInTimeZone(
        new Date(resolvedScheduledAt),
        identity.clinicTimezone,
        "HH:mm",
      );
      const offered = checkConversationOfferedSlot(
        identity,
        requestedLocalDate,
        requestedLocalTime,
      );
      if (offered.status === "rejected") {
        await recordStageTurn(identity, {
          bookingIntent: true,
          tool: "create_preliminary_booking",
          outcome: "slot_never_offered",
        });
        return {
          created: false as const,
          needs_clarification: true as const,
          field: "time",
          reason: "slot_not_offered" as const,
          available_times: offered.offeredForDate,
          guidance:
            offered.offeredForDate.length > 0
              ? "That time was never offered to this patient. Offer only the times in " +
                "available_times and ask which one they want. Do not book any other time."
              : "That time was never offered to this patient. Call check_availability for the " +
                "day they chose and offer only the times it returns.",
        };
      }

      const result = await createPatientPendingBooking({
        identity,
        doctorId: resolvedDoctorId,
        scheduledAt: resolvedScheduledAt,
        durationMinutes: duration_minutes,
        serviceId: resolvedServiceId,
      });
      const clinicInfo = result.ok || result.reason !== "minimum_notice"
        ? null
        : await getPatientClinicPublicInfo(identity.clinicId);
      await recordStageTurn(identity, {
        bookingIntent: true,
        tool: "create_preliminary_booking",
        outcome: result.ok ? "submitted" : result.reason,
        submitted: result.ok,
        collectedOverride: {
          doctor_id: resolvedDoctorId,
          ...(target.department ? { department_id: target.department.id } : {}),
        },
      });
      return result.ok
        ? {
            created: true as const,
            provisional_intake: result.provisional,
            ...(stagedThirdParty
              ? {
                  booked_for_other_person: true as const,
                  booked_for_name: pendingIntake.data?.full_name ?? null,
                }
              : {}),
            ...(result.provisional
              ? { request_id: result.appointmentId }
              : { appointment_id: result.appointmentId }),
            status: "pending" as const,
            created_entity: {
              id: result.appointmentId,
              entity: result.provisional
                ? "ai_appointment_request" as const
                : "appointment" as const,
              status: "pending" as const,
              booking_subject: stagedThirdParty
                ? "third_party_intake" as const
                : result.provisional
                  ? "patient_intake" as const
                  : "linked_patient" as const,
              subject_id: stagedThirdParty || result.provisional
                ? pendingIntake.data?.id ?? null
                : identity.patientId,
              doctor: {
                id: target.doctor.id,
                name: target.doctor.name,
              },
              department: target.department
                ? { id: target.department.id, name: target.department.name }
                : null,
              scheduled_at: resolvedScheduledAt,
              scheduled_local_date: requestedLocalDate,
              scheduled_local_time: requestedLocalTime,
              expires_at: result.expiresAt,
            },
            expires_at: result.expiresAt,
            requires_staff_confirmation: true as const,
          }
        : {
            created: false as const,
            reason: result.reason,
            ...(result.reason === "minimum_notice"
              ? {
                  minimum_notice_hours: 24 as const,
                  clinic_phone: clinicInfo?.data?.phone ?? null,
                }
              : {}),
            guidance:
              result.reason === "patient_pending_cap"
                ? "The patient already has an active AI-created pending booking."
                : result.reason === "slot_pending_cap"
                  ? "That slot has reached the clinic's pending-request cap. Offer another slot."
                  : result.reason === "minimum_notice"
                    ? "AI booking requires at least 24 hours notice. Do not create this appointment. " +
                      "Explain the rule and give the patient the clinic_phone returned here so staff can help with an earlier appointment."
                    : result.reason === "intake_required"
                      ? "This booking has no staged patient file behind it. If the appointment is " +
                        "for somebody other than the sender, collect that person's details and " +
                        "call register_patient with for_someone_else set. Never book it against " +
                        "the sender's record."
                  : "The slot could not be booked. Check availability again.",
          };
    },
  });
}
