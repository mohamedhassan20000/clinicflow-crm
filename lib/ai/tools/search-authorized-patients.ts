import "server-only";

import { tool } from "ai";
import { z } from "zod";
import { assertStaffToolAccess } from "@/lib/ai/authorization";
import { logAgentTool } from "@/lib/ai/audit";
import {
  classifyConfidence,
  transliterateQuery,
  type SearchConfidence,
} from "@/lib/ai/entity-search";
import type { DoctorToolContext } from "@/lib/ai/tools/context";
import { createClient } from "@/lib/supabase/server";

const RESULT_LIMIT = 10;

type RankedPatientRow = {
  id: string;
  full_name: string;
  file_number: string | null;
  phone: string;
  email: string | null;
  score: number;
  match_kind: string;
};

/**
 * Keeps the last four digits — enough for a user to recognize their own
 * patient's number when disambiguating, not enough to be a contact detail.
 */
function maskPhone(phone: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  return digits.length <= 4 ? "••••" : `••••${digits.slice(-4)}`;
}

const GUIDANCE: Record<SearchConfidence, string> = {
  high: "Single confident match. Proceed with this patient.",
  medium:
    "Multiple or uncertain candidates. Present the ranked candidates to the user and ask them to confirm which patient they mean before proceeding. Never silently pick one.",
  low: "No confident match. Tell the user no clear match was found, show any weak candidates, and ask for more detail (another spelling, file number, or phone number).",
};

/**
 * Non-clinical patient lookup shared by all staff personas. Matching and
 * ranking are fully deterministic in the database (`search_patients_ranked`,
 * P4.6C): normalized Arabic/English text, trigram fuzzy matching, phone-suffix
 * and exact file-number identifiers, plus an application-supplied
 * transliteration variant. The RPC is SECURITY INVOKER, so clinic isolation
 * and doctor assignment/department scope come from the same patient RLS policy
 * as the normal application.
 */
export function searchAuthorizedPatientsTool(ctx: DoctorToolContext) {
  return tool({
    description:
      "Find patients the current staff member is authorized to access by name (partial, misspelled, Arabic or English), file number, or phone number. Returns ranked candidates with a match score and a server-computed confidence level; follow the returned guidance — when confidence is not high, ask the user to choose instead of guessing. Returns contact/identity fields only; it never returns diagnoses, clinical notes, summaries, or medical history. Full phone and email are returned only for a single high-confidence match; in a candidate list the phone is masked to its last four digits and email is withheld, so use name and file number to disambiguate.",
    inputSchema: z.object({
      query: z.string().trim().min(2).max(120),
    }),
    execute: async ({ query }) => {
      await assertStaffToolAccess(ctx.user);
      const supabase = await createClient();

      const { data, error } = await supabase.rpc("search_patients_ranked", {
        p_query: query,
        p_query_alt: transliterateQuery(query) ?? undefined,
        p_limit: RESULT_LIMIT,
      });
      if (error) throw new Error("Authorized patient lookup failed.");

      const rows = (data ?? []) as RankedPatientRow[];
      const confidence = classifyConfidence(rows.map((row) => row.score));

      await logAgentTool({
        clinicId: ctx.user.clinicId,
        actorId: ctx.user.id,
        tool: "search_authorized_patients",
        tableName: "patients",
        params: { query_length: query.length, count: rows.length, confidence },
      });

      // Contact details only for a confident single match.
      //
      // P4.6C deliberately widened this from a near-exact lookup to a ranked
      // candidate set with a generous 0.18 recall floor, and the intended flow
      // makes the low-confidence path — the one that returns the *most*
      // candidates — the path designed to show them all to the user. Under the
      // managed gateway that is a real increase in PHI-adjacent egress to a
      // third-party inference provider, for candidates who are by definition
      // mostly not the person being asked about.
      //
      // Every candidate is RLS-authorized for this caller, so this is not an
      // authorization change; it is a volume one. Identity plus a masked phone
      // suffix is all a user needs to disambiguate a namesake, so that is all
      // the clarification list carries.
      const identifyingOnly = confidence !== "high" || rows.length !== 1;

      return {
        confidence,
        guidance: GUIDANCE[confidence],
        contact_details_withheld: identifyingOnly,
        patients: rows.map((row) => ({
          id: row.id,
          full_name: row.full_name,
          file_number: row.file_number,
          phone: identifyingOnly ? maskPhone(row.phone) : row.phone,
          email: identifyingOnly ? null : row.email,
          score: Math.round(row.score * 100) / 100,
          match_kind: row.match_kind,
        })),
      };
    },
  });
}
