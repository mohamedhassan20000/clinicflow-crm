import "server-only";

import { tool } from "ai";
import { z } from "zod";
import { resolvePatientDate } from "@/lib/ai/patient-input";
import {
  authorizePatientConversation,
  type PatientToolContext,
} from "@/lib/ai/patient-authorization";
import { resolvePatientBookingTarget } from "@/lib/ai/booking-target";
import { doctorRefSchema, serviceRefSchema } from "@/lib/ai/tools/booking-refs";
import { recordStageTurn } from "@/lib/ai/booking-stage-store";
import { resolveOfferedDay } from "@/lib/ai/booking-stage";
import { getPatientAvailableDays, getPatientAvailableSlots } from "@/lib/booking/patient";
import { logAgentTool } from "@/lib/ai/audit";
import { filterSlotsAfter, parsePatientAfterTime } from "@/lib/ai/patient-time-constraint";

export function checkPatientAvailabilityTool(ctx: PatientToolContext) {
  return tool({
    description:
      "Check real clinic appointment availability for a day. Pass the day the way the patient " +
      "described it — '2026-08-18', '18/8/2026', 'tomorrow', 'بكرا' are all accepted. " +
      "Availability is logistics-only and does not require DOB verification.",
    inputSchema: z.object({
      date: z
        .string()
        .trim()
        // P9C: `min(3)` refused "24" — the literal answer to "which day?" in
        // "طيب يوم 24؟". A two-character day is a perfectly ordinary thing for a
        // patient to say, and a length bound that rejects it does not protect
        // anything: the value is resolved conversationally a few lines below,
        // and an unreadable one comes back as one short question. A rejected
        // *call*, by contrast, never reaches that resolver at all.
        .min(1)
        .max(60)
        .describe("The day the patient asked about, in their own words or as YYYY-MM-DD."),
      doctor_id: doctorRefSchema.optional(),
      service_id: serviceRefSchema.optional(),
      duration_minutes: z.number().int().min(15).max(240).multipleOf(15).default(30),
      after_time: z
        .string()
        .trim()
        .min(1)
        .max(40)
        .optional()
        .describe("Patient's lower time bound, such as 'after 2', 'بعد الساعة ٢', or '5 PM'."),
    }),
    execute: async ({ date, doctor_id, service_id, duration_minutes, after_time }) => {
      const identity = await authorizePatientConversation(ctx, {
        requireScheduling: true,
      });
      // P8/P8B: "بكرا" and "tomorrow" are resolved in the *clinic's* timezone,
      // not the server's — which day tomorrow is depends on where the clinic
      // is. Everything else goes through the same conversational resolver the
      // other patient tools use, so a day the patient gave two messages ago is
      // not asked for again, and a genuinely ambiguous one is asked about once.
      // P9C: a bare day number is the patient picking one of the days this
      // server just offered them. Checked first, because the general resolver
      // has no way to read "24" and would ask about a day already chosen.
      const fromOffer = resolveOfferedDay(identity.bookingStage, date);
      let resolvedDate: string;
      let dateFromMemory = false;
      if (fromOffer) {
        resolvedDate = fromOffer;
      } else {
        const resolved = await resolvePatientDate(identity, "appointment_date", date);
        if (!resolved.ok) {
          return { field: "date", ...resolved.toolResult };
        }
        resolvedDate = resolved.iso;
        dateFromMemory = resolved.fromMemory;
      }
      // P9B: the same directory check `list_available_days` runs. A doctor id
      // the clinic did not issue never reaches the availability engine, and a
      // service id it did not issue is dropped rather than turned into a dead
      // end. See `booking-target`.
      const target = await resolvePatientBookingTarget({
        identity,
        doctorId: doctor_id ?? null,
        allowImplicitSingleDoctor: true,
        serviceId: service_id ?? null,
        patientText: ctx.episodeUtterances?.at(-1) ?? null,
      });
      if (target.status === "unresolved") {
        await logAgentTool({
          clinicId: identity.clinicId,
          actorId: null,
          tool: "check_availability",
          tableName: "appointments",
          params: { outcome: target.outcome, date: resolvedDate, count: 0 },
        });
        await recordStageTurn(identity, {
          bookingIntent: true,
          tool: "check_availability",
          outcome: target.outcome,
          collectedOverride: { appointment_date: resolvedDate },
        });
        return { ...target.payload, date: resolvedDate };
      }
      const resolvedDoctorId = target.doctor.id;

      const result = await getPatientAvailableSlots({
        identity,
        date: resolvedDate,
        doctorId: resolvedDoctorId,
        serviceId: target.serviceId,
        durationMinutes: duration_minutes,
      });
      const afterMinutes = parsePatientAfterTime(after_time);
      const filteredSlots = result.ok
        ? filterSlotsAfter(result.availableSlots, afterMinutes)
        : [];
      const visibleSlots = [...filteredSlots].sort((left, right) => left.localeCompare(right));
      let alternativeDays: Array<{ date: string; slots: string[] }> = [];
      if (result.ok && visibleSlots.length === 0) {
        const days = await getPatientAvailableDays({
          identity,
          doctorId: resolvedDoctorId,
          serviceId: target.serviceId,
          durationMinutes: duration_minutes,
          searchDays: 21,
        });
        if (days.ok) {
          const candidates = days.availableDays
            .filter((day) => day.date !== resolvedDate)
            .slice(0, 8);
          const checked = await Promise.all(candidates.map(async (day) => {
            const alternative = await getPatientAvailableSlots({
              identity,
              date: day.date,
              doctorId: resolvedDoctorId,
              serviceId: target.serviceId,
              durationMinutes: duration_minutes,
            });
            const slots = alternative.ok
              ? filterSlotsAfter(alternative.availableSlots, afterMinutes).slice(0, 2)
              : [];
            return { date: day.date, slots };
          }));
          alternativeDays = checked.filter((day) => day.slots.length > 0).slice(0, 3);
        }
      }
      await logAgentTool({
        clinicId: identity.clinicId,
        actorId: null,
        tool: "check_availability",
        tableName: "appointments",
        params: {
          outcome: result.ok ? "success" : result.reason,
          date: resolvedDate,
          doctor_specified: Boolean(resolvedDoctorId),
          service_specified: Boolean(service_id),
          service_ignored: target.serviceIgnored,
          count: result.ok ? visibleSlots.length : 0,
          time_filter_applied: afterMinutes !== null,
        },
      });
      // P9: this is where the offer record is written, and it is the only place
      // it is written, because this is the only tool whose output is a list of
      // bookable times. `create_preliminary_booking` refuses anything that is
      // not in it — see `checkOfferedSlot`. The record is server-side and the
      // model has no way to add to it.
      await recordStageTurn(identity, {
        bookingIntent: true,
        tool: "check_availability",
        outcome: result.ok ? "success" : result.reason,
        collectedOverride: {
          appointment_date: resolvedDate,
          doctor_id: resolvedDoctorId,
          ...(target.department ? { department_id: target.department.id } : {}),
        },
        ...(result.ok && visibleSlots.length > 0
          ? { offeredSlots: { date: resolvedDate, times: visibleSlots } }
          : {}),
      });
      if (!result.ok) {
        // The doctor was proven bookable one call ago, so anything here is a
        // read that did not land. It still leaves the patient a move.
        return {
          ok: false as const,
          reason: result.reason,
          date: resolvedDate,
          doctor: { id: target.doctor.id, name: target.doctor.name },
          guidance:
            "The schedule could not be read for that day. Ask the patient for another day and " +
            "call this tool again. Do not report a fault and do not invent times.",
        };
      }
      return {
        ...result,
        availableSlots: visibleSlots,
        filtered_total: filteredSlots.length,
        has_more: false as const,
        alternativeDays,
        selected_from_offer: Boolean(fromOffer),
        date_from_memory: dateFromMemory,
        time_format: ctx.timeFormat ?? "24h",
        ...(afterMinutes !== null ? { after_minutes: afterMinutes } : {}),
        doctor_name: target.doctor.name,
        ...(target.department ? { department: target.department } : {}),
        ...(target.serviceIgnored ? { service_ignored: true as const } : {}),
        guidance:
          visibleSlots.length > 0
            ? "Offer only these times, then call create_preliminary_booking with the one the " +
              "patient picks."
            : "There is no bookable time left on that day. Say so plainly and offer another day " +
              "from list_available_days. This is a real answer, not a failure.",
      };
    },
  });
}
