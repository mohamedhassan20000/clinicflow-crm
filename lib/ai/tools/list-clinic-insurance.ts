import "server-only";

import { tool } from "ai";
import { z } from "zod";
import { logAgentTool } from "@/lib/ai/audit";
import { resolveNamedEntity } from "@/lib/ai/entity-resolution";
import {
  authorizePatientConversation,
  type PatientToolContext,
} from "@/lib/ai/patient-authorization";
import { createClinicScopedAdminClient } from "@/lib/supabase/admin";

/**
 * P10 — "بتتعاملوا مع تأمين ايه؟"
 *
 * Insurance was the one thing patients asked about that the assistant had no
 * way to answer. `answer_clinic_faq` only knows what a staff member has written
 * out by hand, so a clinic that had configured eight insurers in Settings and
 * never written an FAQ about them got "I do not know, let me connect you to the
 * clinic" — for a list sitting in its own database.
 *
 * The list is `public.insurance_providers`, active and not soft-deleted, read
 * fresh every call. Adding an insurer in Settings makes the assistant aware of
 * it immediately; deactivating one removes it from the answer immediately.
 * Nothing about the insurers is hardcoded anywhere.
 *
 * Two deliberate restrictions:
 *
 *   * **Names only.** No contract terms, no coverage percentages, no
 *     co-payment rules, no per-patient policy. Those are commercial and
 *     clinical facts that belong to a staff conversation, and a patient asking
 *     "do you take X?" is asking whether to come, not for their coverage.
 *
 *   * **An empty list is an answer.** A clinic with nothing configured gets a
 *     truthful "we do not have insurers listed" rather than a hedge, and
 *     explicitly must not have one invented for it.
 */
const MAX_PROVIDERS = 60;

export function listClinicInsuranceTool(ctx: PatientToolContext) {
  return tool({
    description:
      "List the insurance providers this clinic actually accepts, from its current settings. " +
      "Use for any insurance question — 'what insurance do you take?', 'بتتعاملوا مع تأمين ايه؟', " +
      "'do you accept X?'. Pass the patient's words as `provider` to check one specific insurer. " +
      "Never name an insurer that is not in the result and never state coverage terms.",
    inputSchema: z.object({
      provider: z
        .string()
        .trim()
        .min(1)
        .max(120)
        .optional()
        .describe(
          "The insurer the patient named, in their own words, when they asked about one " +
            "specifically. Leave empty when they asked which insurers you accept in general.",
        ),
    }),
    execute: async ({ provider }) => {
      const identity = await authorizePatientConversation(ctx);
      const db = createClinicScopedAdminClient(identity.clinicId);
      const result = await db
        .from("insurance_providers")
        .select("id, name")
        .eq("is_active", true)
        .is("deleted_at", null)
        .order("name")
        .limit(MAX_PROVIDERS);
      if (result.error) throw new Error("Could not read clinic insurance providers.");

      const providers = (result.data ?? []).map((row) => ({
        id: row.id,
        name: row.name,
      }));
      await logAgentTool({
        clinicId: identity.clinicId,
        actorId: null,
        tool: "list_clinic_insurance",
        tableName: "insurance_providers",
        params: {
          outcome: "success",
          provider_count: providers.length,
          specific_query: Boolean(provider),
        },
      });

      if (providers.length === 0) {
        return {
          accepts_insurance: false as const,
          providers: [],
          provider_count: 0,
          guidance:
            "This clinic has no insurance providers configured. Say plainly that no insurers are " +
            "listed and offer to connect the patient with clinic staff. Never name an insurer, " +
            "and never say the clinic accepts one.",
        };
      }

      // A named insurer is resolved against the clinic's own list — the same
      // fuzzy resolver departments use, and for the same reason: "أكسا" and
      // "AXA" are the same company, and the patient should not have to guess
      // the clinic's spelling. Nothing about this decision is identity-shaped,
      // so fuzzy is correct here in a way it never is for a patient record.
      if (provider) {
        const resolution = resolveNamedEntity(provider, providers);
        if (resolution.status === "resolved") {
          return {
            accepts_insurance: true as const,
            matched: true as const,
            provider: resolution.entity,
            providers,
            provider_count: providers.length,
            guidance:
              `Yes — this clinic accepts ${resolution.entity.name}. Confirm it by that exact ` +
              "stored name. Do not state coverage percentages, co-payments, or contract terms: " +
              "if the patient asks about those, say clinic staff will confirm the details.",
          };
        }
        if (resolution.status === "ambiguous") {
          return {
            accepts_insurance: true as const,
            matched: "ambiguous" as const,
            candidates: resolution.candidates.map(({ id, name }) => ({ id, name })),
            providers,
            provider_count: providers.length,
            guidance:
              "More than one accepted insurer could be the one they mean. Ask one short question " +
              "naming only those candidates.",
          };
        }
        return {
          accepts_insurance: true as const,
          matched: false as const,
          providers,
          provider_count: providers.length,
          guidance:
            "That insurer is not among the ones this clinic accepts. Say so plainly, then list " +
            "the accepted insurers in `providers` by name. Do not speculate about whether the " +
            "clinic might accept it anyway.",
        };
      }

      return {
        accepts_insurance: true as const,
        providers,
        provider_count: providers.length,
        guidance:
          "List these insurers by name — all of them, exactly as stored. Do not add any insurer " +
          "that is not in this list and do not state coverage terms, percentages, or " +
          "co-payments; those are for clinic staff to confirm.",
      };
    },
  });
}
