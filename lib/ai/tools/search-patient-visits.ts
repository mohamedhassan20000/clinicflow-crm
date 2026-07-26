import "server-only";
import { z } from "zod";
import { tool } from "ai";
import { createClient } from "@/lib/supabase/server";
import { assertDoctorToolAccess } from "@/lib/ai/authorization";
import { logAgentTool } from "@/lib/ai/audit";
import { redactText } from "@/lib/ai/redact";
import {
  clinicDateRangeToUtc,
  ISO_DATE_RE,
  resolveClinicTimeZone,
  type DoctorToolContext,
} from "@/lib/ai/tools/context";

const MATCH_LIMIT = 20;

function escapeIlikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

/**
 * search_patient_visits(patient_id, query, date_range) — doctor/staff (§6.3 row
 * 2). Text search across a patient's clinical notes plus their appointments in
 * an optional date range. RLS scopes every read; a query never widens access.
 */
export function searchPatientVisitsTool(ctx: DoctorToolContext) {
  return tool({
    description:
      "Search one patient's clinical notes and appointments. Provide a free-text query to match note content, and optionally a date range (inclusive). Omit patient_id to use the conversation's active patient (e.g. \"this patient\"); provide it to search a different patient. Returns matching notes (date, author, excerpt) and appointments the current user is authorized to see.",
    inputSchema: z.object({
      patient_id: z
        .string()
        .uuid()
        .optional()
        .describe(
          "The patient's id. Omit to use the active patient from the current conversation context.",
        ),
      query: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .describe("Text to search for within the patient's clinical notes."),
      from: z
        .string()
        .regex(ISO_DATE_RE)
        .optional()
        .describe("Inclusive start date (YYYY-MM-DD)."),
      to: z
        .string()
        .regex(ISO_DATE_RE)
        .optional()
        .describe("Inclusive end date (YYYY-MM-DD)."),
    }),
    execute: async ({ patient_id, query, from, to }) => {
      await assertDoctorToolAccess(ctx.user);

      // P4.10A: fall back to the conversation's active patient when the id is
      // omitted. The effective id is re-authorized below (visibility probe +
      // RLS), so the context is an advisory default that can never widen access.
      const effectivePatientId = patient_id ?? ctx.activePatientId ?? null;
      if (!effectivePatientId) {
        return {
          needs_clarification: true as const,
          field: "patient_id",
          message:
            "No patient is in context. Ask the user which patient they mean, or search for them by name first.",
        };
      }

      const supabase = await createClient();

      // Confirm the patient is visible to this user before searching, so the
      // tool never leaks the existence of an out-of-scope patient.
      const { data: patient } = await supabase
        .from("patients")
        .select("id")
        .eq("id", effectivePatientId)
        .eq("clinic_id", ctx.user.clinicId)
        .maybeSingle();

      await logAgentTool({
        clinicId: ctx.user.clinicId,
        actorId: ctx.user.id,
        tool: "search_patient_visits",
        tableName: "medical_notes",
        recordId: patient?.id ?? null,
        params: {
          patient_id: effectivePatientId,
          from_active_context: !patient_id,
          query,
          from: from ?? null,
          to: to ?? null,
          found: Boolean(patient),
        },
      });

      if (!patient) {
        return { found: false as const, notes: [], appointments: [] };
      }

      const timeZone = await resolveClinicTimeZone(supabase, ctx.user.clinicId);
      const bounds =
        from || to
          ? clinicDateRangeToUtc(from ?? to!, to ?? from!, timeZone)
          : null;

      let notesQuery = supabase
        .from("medical_notes")
        .select("id, note, doctor_id, created_at")
        .eq("patient_id", patient.id)
        .is("deleted_at", null)
        .ilike("note", `%${escapeIlikePattern(query)}%`)
        .order("created_at", { ascending: false })
        .limit(MATCH_LIMIT);
      if (from && bounds) notesQuery = notesQuery.gte("created_at", bounds.start);
      if (to && bounds) notesQuery = notesQuery.lte("created_at", bounds.end);

      let apptQuery = supabase
        .from("appointments")
        .select("id, scheduled_at, status")
        .eq("patient_id", patient.id)
        .eq("clinic_id", ctx.user.clinicId)
        .is("deleted_at", null)
        .order("scheduled_at", { ascending: false })
        .limit(MATCH_LIMIT);
      if (from && bounds) apptQuery = apptQuery.gte("scheduled_at", bounds.start);
      if (to && bounds) apptQuery = apptQuery.lte("scheduled_at", bounds.end);

      const [notes, appointments] = await Promise.all([notesQuery, apptQuery]);

      return {
        found: true as const,
        notes: (notes.data ?? []).map((n) => ({
          date: n.created_at,
          author_id: n.doctor_id,
          excerpt: redactText(n.note).slice(0, 500),
        })),
        appointments: (appointments.data ?? []).map((a) => ({
          date: a.scheduled_at,
          status: a.status,
        })),
      };
    },
  });
}
