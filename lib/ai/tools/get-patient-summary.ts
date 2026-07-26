import "server-only";
import { z } from "zod";
import { tool } from "ai";
import { createClient } from "@/lib/supabase/server";
import { assertDoctorToolAccess } from "@/lib/ai/authorization";
import { logAgentTool } from "@/lib/ai/audit";
import { redactPatientIdentity, redactText } from "@/lib/ai/redact";
import type { DoctorToolContext } from "@/lib/ai/tools/context";

const RECENT_LIMIT = 10;

/**
 * get_patient_summary(patient_id) — doctor/staff (§6.3 row 1).
 * Patient row + recent appointments, medical notes, follow-ups and packages,
 * read exclusively through the RLS client. The doctor-scoping policies
 * (20260505220000) filter rows automatically: a doctor summarizing a patient
 * outside their assignment/department simply gets no data back.
 */
export function getPatientSummaryTool(ctx: DoctorToolContext) {
  return tool({
    description:
      "Retrieve a clinical summary for one patient: demographics (age/gender/blood type only), recent appointments, recent clinical notes (by date and author), recent follow-up outcomes, and active packages. Returns only patients the current user is authorized to see. Omit patient_id to use the conversation's active patient (e.g. when the user says \"this patient\" or refers to them by pronoun); provide it explicitly to summarize a different patient.",
    inputSchema: z.object({
      patient_id: z
        .string()
        .uuid()
        .optional()
        .describe(
          "The patient's id. Omit to use the active patient from the current conversation context.",
        ),
    }),
    execute: async ({ patient_id }) => {
      await assertDoctorToolAccess(ctx.user);

      // P4.10A: fall back to the conversation's active patient when the model
      // omits the id. The effective id is still re-authorized below exactly as a
      // named id is (clinic scope + doctor-scoping RLS), so the context is an
      // advisory default only and can never widen access.
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

      const { data: patient } = await supabase
        .from("patients")
        .select("id, full_name, date_of_birth, blood_type, clinic_id")
        .eq("id", effectivePatientId)
        .eq("clinic_id", ctx.user.clinicId)
        .maybeSingle();

      await logAgentTool({
        clinicId: ctx.user.clinicId,
        actorId: ctx.user.id,
        tool: "get_patient_summary",
        tableName: "patients",
        recordId: patient?.id ?? null,
        params: {
          patient_id: effectivePatientId,
          from_active_context: !patient_id,
          found: Boolean(patient),
        },
      });

      if (!patient) {
        return {
          found: false as const,
          message: "No patient record is available for that id.",
        };
      }

      const [appointments, notes, followUps, packages] = await Promise.all([
        supabase
          .from("appointments")
          .select("id, scheduled_at, status, duration_minutes")
          .eq("patient_id", patient.id)
          .eq("clinic_id", ctx.user.clinicId)
          .is("deleted_at", null)
          .order("scheduled_at", { ascending: false })
          .limit(RECENT_LIMIT),
        supabase
          .from("medical_notes")
          .select("id, note, doctor_id, created_at")
          .eq("patient_id", patient.id)
          .is("deleted_at", null)
          .order("created_at", { ascending: false })
          .limit(RECENT_LIMIT),
        supabase
          .from("follow_ups")
          .select("id, outcome, recorded_at")
          .eq("patient_id", patient.id)
          .eq("clinic_id", ctx.user.clinicId)
          .order("recorded_at", { ascending: false })
          .limit(RECENT_LIMIT),
        supabase
          .from("patient_packages")
          .select("id, name, total_sessions, used_sessions, is_active")
          .eq("patient_id", patient.id)
          .eq("clinic_id", ctx.user.clinicId)
          .eq("is_active", true),
      ]);

      return {
        found: true as const,
        patient: redactPatientIdentity(patient),
        appointments: (appointments.data ?? []).map((a) => ({
          date: a.scheduled_at,
          status: a.status,
          duration_minutes: a.duration_minutes,
        })),
        notes: (notes.data ?? []).map((n) => ({
          date: n.created_at,
          author_id: n.doctor_id,
          excerpt: redactText(n.note).slice(0, 500),
        })),
        follow_ups: (followUps.data ?? []).map((f) => ({
          date: f.recorded_at,
          outcome: f.outcome,
        })),
        active_packages: (packages.data ?? []).map((p) => ({
          name: p.name,
          used_sessions: p.used_sessions,
          total_sessions: p.total_sessions,
        })),
      };
    },
  });
}
