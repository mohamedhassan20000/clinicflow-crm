import "server-only";

import { tool } from "ai";
import { z } from "zod";
import { assertStaffToolAccess } from "@/lib/ai/authorization";
import { logAgentTool } from "@/lib/ai/audit";
import type { DoctorToolContext } from "@/lib/ai/tools/context";
import { createClient } from "@/lib/supabase/server";

const RESULT_LIMIT = 10;

function escapeIlikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

type PatientLookupRow = {
  id: string;
  full_name: string;
  file_number: string | null;
  phone: string;
  email: string | null;
};

/**
 * Non-clinical patient lookup shared by all staff personas. Each query runs as
 * the authenticated user, so clinic isolation and doctor assignment/department
 * scope come from the same patient RLS policy as the normal application.
 */
export function searchAuthorizedPatientsTool(ctx: DoctorToolContext) {
  return tool({
    description:
      "Find patients the current staff member is authorized to access by name, exact file number, or exact phone number. Returns contact/identity fields only; it never returns diagnoses, clinical notes, summaries, or medical history.",
    inputSchema: z.object({
      query: z.string().trim().min(2).max(120),
    }),
    execute: async ({ query }) => {
      await assertStaffToolAccess(ctx.user);
      const supabase = await createClient();
      const columns = "id, full_name, file_number, phone, email";

      const [nameResult, fileResult, phoneResult] = await Promise.all([
        supabase
          .from("patients")
          .select(columns)
          .eq("clinic_id", ctx.user.clinicId)
          .ilike("full_name", `%${escapeIlikePattern(query)}%`)
          .limit(RESULT_LIMIT),
        supabase
          .from("patients")
          .select(columns)
          .eq("clinic_id", ctx.user.clinicId)
          .eq("file_number", query)
          .limit(RESULT_LIMIT),
        supabase
          .from("patients")
          .select(columns)
          .eq("clinic_id", ctx.user.clinicId)
          .eq("phone", query)
          .limit(RESULT_LIMIT),
      ]);

      const lookupError = nameResult.error ?? fileResult.error ?? phoneResult.error;
      if (lookupError) throw new Error("Authorized patient lookup failed.");

      const matches = new Map<string, PatientLookupRow>();
      for (const row of [
        ...(nameResult.data ?? []),
        ...(fileResult.data ?? []),
        ...(phoneResult.data ?? []),
      ] as PatientLookupRow[]) {
        matches.set(row.id, row);
        if (matches.size >= RESULT_LIMIT) break;
      }

      await logAgentTool({
        clinicId: ctx.user.clinicId,
        actorId: ctx.user.id,
        tool: "search_authorized_patients",
        tableName: "patients",
        params: { query_length: query.length, count: matches.size },
      });

      return {
        patients: Array.from(matches.values()).map((patient) => ({
          id: patient.id,
          full_name: patient.full_name,
          file_number: patient.file_number,
          phone: patient.phone,
          email: patient.email,
        })),
      };
    },
  });
}
