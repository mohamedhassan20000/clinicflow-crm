import "server-only";

import { tool } from "ai";
import { z } from "zod";
import {
  assertPatientBookingIdentity,
  authorizePatientConversation,
  type PatientToolContext,
} from "@/lib/ai/patient-authorization";
import { resolvePatientBookingTarget } from "@/lib/ai/booking-target";
import { doctorRefSchema, serviceRefSchema } from "@/lib/ai/tools/booking-refs";
import { recordStageTurn } from "@/lib/ai/booking-stage-store";
import { getPatientAvailableDays } from "@/lib/booking/patient";
import { logAgentTool } from "@/lib/ai/audit";
import { readDateBoundary } from "@/lib/ai/day-of-month";
import { addCalendarDays } from "@/lib/appointments/calendar";
import { formatInTimeZone } from "date-fns-tz";

const AVAILABILITY_WINDOW_DAYS = 7;

function asksForNextWindow(value: string | null | undefined): boolean {
  const text = (value ?? "").toLocaleLowerCase();
  return /(?:next\s+(?:week|dates?|window)|show\s+more|after\s+(?:day|date)|الأسبوع\s+(?:الجاي|القادم|اللي\s+بعده)|بعد\s+(?:يوم|تاريخ)|الأيام\s+اللي\s+بعدها|مواعيد(?:\s+تانية|\s+بعد\s+كده))/i.test(text);
}

function requestedWeekday(value: string | undefined): number | null {
  const text = (value ?? "").toLocaleLowerCase();
  const names: Array<[RegExp, number]> = [
    [/(?:الأحد|الاحد|sunday)/i, 0], [/(?:الاثنين|الإثنين|monday)/i, 1],
    [/(?:الثلاثاء|tuesday)/i, 2], [/(?:الأربعاء|الاربعاء|wednesday)/i, 3],
    [/(?:الخميس|thursday)/i, 4], [/(?:الجمعة|friday)/i, 5],
    [/(?:السبت|saturday)/i, 6],
  ];
  return names.find(([pattern]) => pattern.test(text))?.[1] ?? null;
}

export function listAvailableDaysTool(ctx: PatientToolContext) {
  return tool({
    description:
      "List real days that have at least one bookable slot for the resolved doctor. " +
      "Call this after doctor selection and before check_availability. It returns days only, never times, " +
      "and excludes every slot less than 24 hours away. Name the doctor with an id a tool " +
      "returned earlier, or with the patient's own words — both are accepted, and a doctor this " +
      "clinic cannot place comes back as the roster to choose from, never as an error.",
    inputSchema: z.object({
      doctor_id: doctorRefSchema.optional(),
      duration_minutes: z.number().int().min(15).max(240).multipleOf(15).default(30),
      search_days: z.number().int().min(1).max(60).default(7),
      service_id: serviceRefSchema.optional(),
      weekday: z.string().trim().min(2).max(20).optional().describe(
        "The weekday named by the patient, such as Sunday or الأحد. Use it for exact weekday follow-ups.",
      ),
    }),
    execute: async ({ doctor_id, duration_minutes, service_id, weekday }) => {
      const identity = await authorizePatientConversation(ctx, {
        requireScheduling: true,
      });
      assertPatientBookingIdentity(identity, {
        forSomeoneElse: identity.bookingStage?.bookingForOther === true,
      });
      // P9B: the doctor and the service are resolved against the clinic's own
      // directory before either reaches the availability engine, and the
      // resolved pair is persisted. An id the clinic did not issue comes back
      // as a roster to choose from, never as a failure — see `booking-target`.
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
          tool: "list_available_days",
          tableName: "appointments",
          params: { outcome: target.outcome, count: 0 },
        });
        await recordStageTurn(identity, {
          bookingIntent: true,
          tool: "list_available_days",
          outcome: target.outcome,
        });
        return target.payload;
      }

      const latestPatientText = ctx.episodeUtterances?.at(-1) ?? null;
      const today = formatInTimeZone(
        new Date(),
        identity.clinicTimezone,
        "yyyy-MM-dd",
      );
      // "بعد يوم ٨" is a lower bound on the search, not an answer to "which
      // day?". Reading it here — from the patient's own words, against the
      // clinic's own calendar — is what makes the days that come back real
      // days after the 8th rather than the single day the parser used to pick
      // silently. See `lib/ai/day-of-month.ts`.
      const boundary = readDateBoundary(latestPatientText, {
        timeZone: identity.clinicTimezone,
      });
      const boundaryStart =
        boundary?.after && boundary.after >= today
          ? addCalendarDays(boundary.after, 1)
          : boundary?.after
            ? today
            : null;
      const nextWindow = boundaryStart === null && asksForNextWindow(latestPatientText);
      const windowStart = boundaryStart
        ? boundaryStart
        : nextWindow
          ? addCalendarDays(identity.bookingStage.availabilityWindowEnd ?? addCalendarDays(today, 6), 1)
          : today;
      const windowEnd = addCalendarDays(windowStart, AVAILABILITY_WINDOW_DAYS - 1);

      const result = await getPatientAvailableDays({
        identity,
        doctorId: target.doctor.id,
        durationMinutes: duration_minutes,
        searchDays: AVAILABILITY_WINDOW_DAYS,
        startDate: windowStart,
        serviceId: target.serviceId,
      });
      const weekdayNumber = requestedWeekday(weekday);
      const filteredDays = result.ok && weekdayNumber !== null
        ? result.availableDays.filter(
            (day) => new Date(`${day.date}T12:00:00Z`).getUTCDay() === weekdayNumber,
          )
        : result.ok
          ? result.availableDays
          : [];
      const visibleDays = filteredDays;
      await logAgentTool({
        clinicId: identity.clinicId,
        actorId: null,
        tool: "list_available_days",
        tableName: "appointments",
        params: {
          outcome: result.ok ? "success" : result.reason,
          count: result.ok ? visibleDays.length : 0,
          service_ignored: target.serviceIgnored,
        },
      });
      // The days actually put in front of the patient. Recorded, not enforced —
      // a day is only ever a route to `check_availability`, which is where the
      // real slots (and the enforced offer record) come from.
      await recordStageTurn(identity, {
        bookingIntent: true,
        tool: "list_available_days",
        outcome: result.ok ? "success" : result.reason,
        collectedOverride: {
          doctor_id: target.doctor.id,
          ...(target.department ? { department_id: target.department.id } : {}),
        },
        ...(result.ok
          ? { offeredDays: visibleDays.map((day) => day.date) }
          : {}),
        availabilityWindow: { start: windowStart, end: windowEnd },
      });

      if (!result.ok) {
        // The doctor was proven bookable moments ago, so this is a transient
        // read failure rather than a statement about the clinic. It still gets
        // a way forward instead of a bare reason code.
        return {
          ok: false as const,
          reason: result.reason,
          doctor: { id: target.doctor.id, name: target.doctor.name },
          guidance:
            "The schedule could not be read for this doctor just now. Ask the patient which day " +
            "suits them and call check_availability for that day. Do not tell them anything is " +
            "broken and do not invent days.",
        };
      }

      return {
        ...result,
        availableDays: visibleDays,
        window_start: windowStart,
        window_end: windowEnd,
        window_kind: boundaryStart
          ? ("after_boundary" as const)
          : nextWindow
            ? ("next" as const)
            : ("current" as const),
        ...(boundary?.after ? { after_date: boundary.after } : {}),
        filtered_total: filteredDays.length,
        has_more: filteredDays.length > visibleDays.length,
        ...(weekdayNumber !== null ? { requested_weekday: weekday } : {}),
        doctor_name: target.doctor.name,
        ...(target.department ? { department: target.department } : {}),
        ...(target.serviceIgnored ? { service_ignored: true as const } : {}),
        guidance:
          visibleDays.length > 0
            ? "Offer these days to the patient in their own words, then call check_availability " +
              "for the day they choose. Never offer a day that is not in `availableDays`." +
              (boundaryStart
                ? " The patient named a boundary, not a day: these are the real available days " +
                  "after it. Present them and ask which one they want — do not pick one for them."
                : "")
            : "This doctor has no bookable day in the searched window. Say so plainly, and offer " +
              "either a wider search or another doctor from the same department using " +
              "list_doctors. This is a real answer, not a failure.",
      };
    },
  });
}
