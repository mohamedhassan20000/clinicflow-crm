import "server-only";

import { tool } from "ai";
import { z } from "zod";
import {
  authorizePatientConversation,
  type PatientToolContext,
} from "@/lib/ai/patient-authorization";
import { resolvePatientDate } from "@/lib/ai/patient-input";
import { verifyPatientConversationDob } from "@/lib/supabase/admin";

/**
 * P8 — identity verification that accepts the date the way the patient wrote it.
 *
 * This tool used to demand `YYYY-MM-DD` in its schema, which meant the model had
 * to either reformat the patient's answer itself (silently, with no record of
 * how) or push the format requirement out to the patient — "please send your
 * date of birth as DD/MM/YYYY" — which is exactly the machine-shaped
 * conversation this phase is removing.
 *
 * Now the patient's own words come in and the deterministic parser in
 * `human-input.ts` decides what they mean. Two properties matter here more than
 * anywhere else in the product, because this is the check that decides whether
 * somebody is shown another person's appointments:
 *
 *   * **A misread date must not cost an attempt.** Verification is rate-limited
 *     and locks out; spending one of those attempts on our own misparse would
 *     turn a formatting difference into a lockout. So an unparseable or
 *     genuinely ambiguous date is refused *before* the database is asked
 *     anything, and the model is told to ask one short question.
 *   * **Ambiguity is asked about, not resolved.** `12/9/2000` reads as 12
 *     September under the clinic's own convention, but 9 December is a real date
 *     too. Trying the preferred reading and then quietly trying the other one
 *     would double the guess rate of a security check — so when both readings are
 *     possible the patient is asked which they meant, in their own terms
 *     ("September or December?"), never in a format specification.
 */
export function verifyPatientIdentityTool(ctx: PatientToolContext) {
  return tool({
    description:
      "Verify the patient using their date of birth before showing any appointment details. " +
      "Pass the patient's answer through exactly as they wrote it — any everyday format is " +
      "accepted, including Arabic digits and month names. Never ask for or accept a patient id.",
    inputSchema: z.object({
      date_of_birth: z
        .string()
        .trim()
        .min(4)
        .max(60)
        .describe(
          "The patient's date of birth in their own words, e.g. '12/9/2000', '2000-09-12', " +
            "'12 سبتمبر 2000', '١٢-٩-٢٠٠٠'. Do not reformat it and do not ask the patient for a " +
            "particular format.",
        ),
    }),
    execute: async ({ date_of_birth }) => {
      const identity = await authorizePatientConversation(ctx, {
        requireLinked: true,
      });

      // P8B: the answer is resolved against what this conversation has already
      // established, so a patient who wrote "12/9/2000" and then clarified
      // "سبتمبر" is verified on the next turn instead of being asked a third
      // time. The resolution is deterministic and happens entirely before the
      // rate-limited RPC below — an answer we could not read costs no attempt,
      // and an answer we *could* read buys no verification.
      const resolved = await resolvePatientDate(identity, "date_of_birth", date_of_birth);
      if (!resolved.ok) {
        return { verified: false, ...resolved.toolResult };
      }

      const { data, error } = await verifyPatientConversationDob({
        clinicId: identity.clinicId,
        conversationId: identity.conversationId,
        dateOfBirth: resolved.iso,
      });
      if (error || !data?.[0]) {
        throw new Error("Patient identity verification failed.");
      }
      const result = data[0];
      return {
        verified: result.verified,
        attempts_remaining: result.attempts_remaining,
        locked_until: result.locked_until,
        guidance: result.verified
          ? "Identity verified for this conversation."
          : result.locked_until
            ? "Verification is temporarily locked. Ask the patient to contact the clinic."
            : "The date did not match. Ask the patient to try again.",
      };
    },
  });
}
