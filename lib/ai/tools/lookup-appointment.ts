import "server-only";

import { tool } from "ai";
import { z } from "zod";
import { formatInTimeZone } from "date-fns-tz";
import { logAgentTool } from "@/lib/ai/audit";
import { parseHumanName, parseNationalId } from "@/lib/ai/human-input";
import {
  authorizePatientConversation,
  type PatientToolContext,
} from "@/lib/ai/patient-authorization";
import { recordStageTurn } from "@/lib/ai/booking-stage-store";
import { lookupPatientAppointmentsByIdentity } from "@/lib/supabase/admin";

/**
 * P11 — "عايز أعرف ميعادي" / "when is my appointment?".
 *
 * ## Why this is its own tool
 *
 * Before P11 the assistant had exactly two moves when somebody asked about
 * their own appointment. If the thread was linked and date-of-birth verified,
 * `list_my_appointments` answered. If it was not — which is the ordinary case
 * for a patient messaging from a phone the clinic never linked — the only
 * mounted tool that engaged with "I am a patient here" was `prepare_booking`,
 * so the conversation slid into **new-patient registration**: name, national
 * id, date of birth, email, blood type, for somebody who already has a file and
 * only wanted to know a time. That is the defect.
 *
 * So there is now a third move, and it asks for exactly two things: the
 * patient's full name and their national id.
 *
 * ## The identity rules, which are the whole design
 *
 * * **The server matches, never the model.** Both values are folded by the same
 *   `fold_patient_name` / `fold_national_id` the booking identification uses and
 *   must select one single live patient. There is no resolver, no similarity,
 *   no candidate list, and no branch anywhere in which the model chooses whose
 *   record this is.
 *
 * * **No fallback to the sender.** The RPC never reads
 *   `conversations.patient_id`. If sender A supplies patient B's name and id,
 *   the answer is B's appointments or nothing — it can never quietly become A's,
 *   because A's record is not in scope of the query at all. `doctors.data[0]`,
 *   the previous booking target and the last tool result are likewise not in
 *   scope: this tool reads none of them.
 *
 * * **No existence oracle.** Unknown name, unknown id, an id registered to
 *   somebody else, a name registered with a different id, two matches — one
 *   answer, `no_match`, with no hint as to which. The guidance below forbids
 *   saying more, and the tool has no more to say even if it were asked.
 *
 * * **The turn does not have to be the one that finishes it.** P11B: a patient
 *   who sends their name and then their national id in two messages is the
 *   ordinary case, and the tool needs both in one call. Whichever half arrives
 *   first is held in `ai_booking_stage.appointmentLookup` — a server-owned slot
 *   read by nothing else and erased the moment the lookup resolves — so the
 *   second turn completes without re-asking. It is deliberately *not* in
 *   `ai_collected_data`: a name given to identify an existing file must never
 *   become a name `register_patient` opens a new one with.
 *
 * * **Booking scope, not clinical scope.** Date, time, doctor, department,
 *   service and the request's own status. Nothing else exists in the result.
 *   `identity_verified_at` is neither read nor written here, so every clinical
 *   disclosure still costs a full date-of-birth verification exactly as it did
 *   before — see `confirm-booking-identity.ts` for the same boundary stated
 *   from the booking side.
 */
export function lookupAppointmentTool(ctx: PatientToolContext) {
  return tool({
    description:
      "Look up a patient's own upcoming appointment from their full name and national/civil id. " +
      "Use this for 'عايز أعرف ميعادي', 'ميعادي امتى؟', 'عندي موعد امتى؟', 'ممكن تشوف حجزي؟', " +
      "'when is my appointment?', 'what time is my appointment?'. Ask ONLY for the full name and " +
      "the national id — never start a new patient registration for this, and never ask for date " +
      "of birth, email or blood type. Call it once you have both. It shows appointment logistics " +
      "only and never permits any clinical or record disclosure.",
    inputSchema: z.object({
      // Both are optional so the tool can be called the moment either half
      // arrives. The server, not the model, decides whether it has enough: it
      // merges the call with whatever it is already holding for this
      // conversation and asks for exactly what is still missing.
      full_name: z
        .string()
        .trim()
        .min(2)
        .max(120)
        .optional()
        .describe("The patient's full name exactly as they wrote it, if given yet."),
      national_id: z
        .string()
        .trim()
        .min(4)
        .max(40)
        .optional()
        .describe("The patient's national or civil id, exactly as written, if given yet."),
    }),
    execute: async ({ full_name, national_id }) => {
      const identity = await authorizePatientConversation(ctx, {
        refuseIfPaused: true,
      });
      const held = identity.bookingStage.appointmentLookup;
      // This turn's values win over the held ones, so a patient correcting a
      // digit is answered on the corrected value rather than the stale one.
      const name = parseHumanName(full_name ?? "") ?? parseHumanName(held?.fullName ?? "");
      const nationalId =
        parseNationalId(national_id ?? "") ?? parseNationalId(held?.nationalId ?? "");

      if (!name || !nationalId) {
        // Exactly one half is missing (or the supplied one was unreadable).
        // Keep what we do have and ask for the rest — never for a date of
        // birth, an email, a phone number or a blood type, none of which this
        // lookup uses or is permitted to use.
        const keep =
          name || nationalId
            ? { fullName: name ?? null, nationalId: nationalId ?? null }
            : null;
        await recordStageTurn(identity, {
          appointmentLookup: keep,
          tool: "lookup_appointment",
          outcome: "awaiting_identity",
        });
        return {
          found: false as const,
          reason: "needs_identity" as const,
          have: [...(name ? ["full_name"] : []), ...(nationalId ? ["national_id"] : [])],
          missing: [...(name ? [] : ["full_name"]), ...(nationalId ? [] : ["national_id"])],
          guidance:
            "Ask, in one short natural sentence and in the patient's own language, only for the " +
            "detail listed in `missing`. Never re-ask for anything in `have` — the server is " +
            "holding it. Never ask for date of birth, phone, email, blood type or any " +
            "registration detail, and never start a new patient registration: this person " +
            "already has a file. No lookup attempt was used.",
        };
      }
      const result = await lookupPatientAppointmentsByIdentity({
        clinicId: identity.clinicId,
        conversationId: identity.conversationId,
        fullName: name,
        nationalId,
      });
      if (result.error) throw new Error("Appointment lookup failed.");
      const rows = result.data ?? [];
      const status = rows[0]?.status ?? "no_match";

      await logAgentTool({
        clinicId: identity.clinicId,
        actorId: null,
        tool: "lookup_appointment",
        tableName: "appointments",
        params: { outcome: status, scope: "booking_only" },
      });
      // The check has resolved, whichever way. The held identity has served its
      // only purpose and is erased now rather than lingering on the record for
      // the rest of the conversation.
      await recordStageTurn(identity, {
        appointmentLookup: null,
        tool: "lookup_appointment",
        outcome: status,
      });

      if (status === "locked") {
        return {
          found: false as const,
          reason: "identity_verification_locked" as const,
          guidance:
            "Do not retry. Ask the patient to contact clinic staff directly, and never say which " +
            "detail was the problem.",
        };
      }
      if (status === "no_match") {
        return {
          found: false as const,
          reason: "no_match" as const,
          attempts_remaining: rows[0]?.attempts_remaining ?? null,
          guidance:
            "Say only that you could not find a booking with those details, and offer to have " +
            "clinic staff check. Never say whether the name or the id was the problem, never say " +
            "whether that id belongs to anybody, and never confirm or deny that any record " +
            "exists. Do not start a registration unless the patient asks to open a new file.",
        };
      }
      if (status === "no_upcoming") {
        return {
          found: true as const,
          appointments: [],
          appointment_count: 0,
          guidance:
            "Their file was found and there is no upcoming appointment on it. Say that plainly " +
            "and offer to book one. Do not mention any past appointment and do not give any " +
            "other detail from their record.",
        };
      }

      const appointments = rows
        .filter((row) => row.appointment_id !== null)
        .map((row) => ({
          scheduled_at: row.scheduled_at,
          date: formatInTimeZone(
            new Date(row.scheduled_at!),
            identity.clinicTimezone,
            "yyyy-MM-dd",
          ),
          time: formatInTimeZone(
            new Date(row.scheduled_at!),
            identity.clinicTimezone,
            "HH:mm",
          ),
          duration_minutes: row.duration_minutes,
          status: row.appointment_status,
          doctor_name: row.doctor_name,
          department_name: row.department_name,
          service_name: row.service_name,
        }));

      return {
        found: true as const,
        appointments,
        appointment_count: appointments.length,
        clinical_disclosure_allowed: false as const,
        guidance:
          "These are their real upcoming appointments. Give the day, the time, the doctor and the " +
          "department or service for each, in the patient's own language, exactly as returned. A " +
          "'pending' one is still awaiting clinic confirmation and must be described that way — " +
          "never as confirmed. Do not give any clinical detail, diagnosis, note or balance: this " +
          "lookup permits appointment logistics and nothing else.",
      };
    },
  });
}
