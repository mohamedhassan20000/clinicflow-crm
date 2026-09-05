import "server-only";

import { tool } from "ai";
import { z } from "zod";
import { logAgentTool } from "@/lib/ai/audit";
import { parseHumanName, parseNationalId } from "@/lib/ai/human-input";
import {
  authorizePatientConversation,
  type PatientToolContext,
} from "@/lib/ai/patient-authorization";
import {
  confirmPatientBookingIdentity,
  identifyPatientForBooking,
} from "@/lib/supabase/admin";

/**
 * P10 — booking identity, which is not the same thing as verified identity.
 *
 * ## The distinction, because everything below depends on it
 *
 * ClinicFlow has exactly one identity check today: the date of birth, through
 * `verify_patient_conversation_dob`, rate-limited and locking. It is what gates
 * *disclosure* — "what appointments do I have?", "when is my follow-up?", any
 * clinical or record detail — and nothing in this file weakens it. It is not
 * touched, not written, and not read as satisfied by anything here.
 *
 * What this file adds is a second, weaker fact for a strictly narrower purpose:
 * **may this thread create a booking, and against which file?** That question
 * does not need the same evidence, because getting it wrong costs a pending
 * appointment request a human then reviews, not somebody's medical record shown
 * to a stranger. Demanding a date-of-birth challenge for it made the ordinary
 * case — a returning patient messaging from the number already on their file —
 * feel like an interrogation, and lockouts on mistyped dates ended bookings that
 * had nothing sensitive in them.
 *
 * So there are two doors, and they open onto different rooms:
 *
 * | | evidence | unlocks |
 * |---|---|---|
 * | booking identity | the WhatsApp-proved number already on the file, plus the patient confirming their own name — or, from a new number, exact name **and** national id | creating a pending booking request |
 * | verified identity | date of birth, rate-limited | listing, cancelling, and every clinical or record disclosure |
 *
 * `authorizePatientConversation({ requireVerified: true })` reads
 * `identityVerifiedAt` and only that, so the second row is unreachable from the
 * first by construction rather than by prompt wording.
 *
 * ## Why the different-phone path is exact and silent
 *
 * `identify_patient_for_booking` requires the normalized name **and** the
 * national id to select the same single live record. No fuzzy resolver takes
 * part — the entity resolver is for departments, doctors and insurers, never for
 * a person. And every failure returns the same `no_match`, never "that id
 * belongs to somebody else" and never "that id is not registered", because
 * either of those makes the tool an existence oracle for national ids. The
 * attempt counter is the same one the date-of-birth check uses, so guessing here
 * is no cheaper than guessing there.
 */
export function confirmBookingIdentityTool(ctx: PatientToolContext) {
  return tool({
    description:
      "Establish WHICH patient file a booking belongs to. Booking only — this never permits " +
      "showing appointments, clinical details, or any record data; those still require " +
      "verify_patient_identity. Call with no arguments when the conversation is already linked " +
      "to a file and the patient has confirmed they are that person. Call with full_name AND " +
      "national_id when a returning patient is writing from a number the clinic does not have " +
      "on their file.",
    inputSchema: z.object({
      full_name: z
        .string()
        .trim()
        .min(2)
        .max(120)
        .optional()
        .describe(
          "The patient's full name, exactly as they wrote it. Only for a patient writing from a " +
            "number that is not on their file, and only together with national_id.",
        ),
      national_id: z
        .string()
        .trim()
        .min(4)
        .max(40)
        .optional()
        .describe(
          "The patient's national or civil id, as they wrote it. Only together with full_name.",
        ),
    }),
    execute: async ({ full_name, national_id }) => {
      const identity = await authorizePatientConversation(ctx, {
        requireScheduling: true,
        refuseIfPaused: true,
      });

      // ---- The same number that is already on the file --------------------
      if (!full_name && !national_id) {
        if (!identity.linked) {
          return {
            confirmed: false as const,
            reason: "not_linked" as const,
            guidance:
              "This number is not on any patient file. Do not ask them to confirm a name. If they " +
              "are a returning patient writing from a different number, ask for their full name " +
              "and national id and call this tool again with both. Otherwise open a new file with " +
              "prepare_booking and register_patient.",
          };
        }
        const result = await confirmPatientBookingIdentity({
          clinicId: identity.clinicId,
          conversationId: identity.conversationId,
        });
        const row = result.data?.[0];
        if (result.error || !row) throw new Error("Booking identity could not be confirmed.");
        await logAgentTool({
          clinicId: identity.clinicId,
          actorId: null,
          tool: "confirm_booking_identity",
          params: { outcome: row.status, scope: "booking_only" },
        });
        if (row.status !== "confirmed") {
          return {
            confirmed: false as const,
            reason: row.status,
            guidance:
              "This thread could not be confirmed against a patient file for booking. Do not " +
              "guess who they are. Ask for their full name and national id and call this tool " +
              "again with both.",
          };
        }
        return {
          confirmed: true as const,
          scope: "booking_only" as const,
          patient_name: row.patient_name,
          clinical_disclosure_allowed: false as const,
          guidance:
            `Booking identity is settled for ${row.patient_name}. Continue the booking without ` +
            "asking for any personal detail again. This does NOT allow showing appointments, " +
            "clinical information, balances, or any record data — if they ask for any of those, " +
            "ask for their date of birth and call verify_patient_identity first.",
        };
      }

      // ---- A returning patient on a different number ----------------------
      if (!full_name || !national_id) {
        return {
          confirmed: false as const,
          reason: "incomplete" as const,
          guidance:
            "Identifying a patient from a different number needs BOTH their full name and their " +
            "national id. Ask for whichever is missing and call this tool again with both.",
        };
      }
      const name = parseHumanName(full_name);
      const nationalId = parseNationalId(national_id);
      if (!name || !nationalId) {
        // Refused before the rate-limited RPC, so our own inability to read a
        // value never costs the patient an attempt. Same property as the
        // date-of-birth path, and for the same reason.
        return {
          confirmed: false as const,
          reason: "unreadable" as const,
          fields: [...(name ? [] : ["full_name"]), ...(nationalId ? [] : ["national_id"])],
          guidance:
            "Ask again for only the listed detail, in ordinary words. Never quote a format back " +
            "to the patient. No verification attempt was used.",
        };
      }

      const result = await identifyPatientForBooking({
        clinicId: identity.clinicId,
        conversationId: identity.conversationId,
        fullName: name,
        nationalId,
      });
      const row = result.data?.[0];
      if (result.error || !row) throw new Error("Booking identification failed.");
      await logAgentTool({
        clinicId: identity.clinicId,
        actorId: null,
        tool: "confirm_booking_identity",
        params: { outcome: row.status, scope: "booking_only", cross_number: true },
      });

      if (row.status === "identified") {
        return {
          confirmed: true as const,
          scope: "booking_only" as const,
          patient_name: row.patient_name,
          clinical_disclosure_allowed: false as const,
          guidance:
            `Their existing file has been found. Continue the booking for ${row.patient_name} — ` +
            "do not ask them to register again and do not collect personal details they already " +
            "have on file. This does NOT allow showing appointments, clinical information, or " +
            "any record data: those still need date-of-birth verification.",
        };
      }
      if (row.status === "already_linked") {
        return {
          confirmed: false as const,
          reason: "already_linked" as const,
          guidance:
            "This thread is already attached to a file. Call this tool with no arguments instead.",
        };
      }
      if (row.status === "locked") {
        return {
          confirmed: false as const,
          reason: "identity_verification_locked" as const,
          guidance:
            "Do not retry identification on this conversation. Ask the patient to contact clinic " +
            "staff directly, and do not say which detail was the problem.",
        };
      }
      // `no_match` is deliberately the only thing said out loud, whatever
      // actually happened — an id that belongs to somebody else, an id that
      // exists with a different name, and an id nobody has are one answer here.
      return {
        confirmed: false as const,
        reason: "no_match" as const,
        attempts_remaining: row.attempts_remaining,
        guidance:
          "No file matched those details. Say only that you could not find their file — never say " +
          "whether the name or the id was the problem, and never say whether that id belongs to " +
          "anybody. Offer to open a new file with register_patient, or to have clinic staff help.",
      };
    },
  });
}
