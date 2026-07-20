import "server-only";

import { tool } from "ai";
import { z } from "zod";
import { assertAnalyticsToolAccess } from "@/lib/ai/authorization";
import { logAgentTool } from "@/lib/ai/audit";
import { createClient } from "@/lib/supabase/server";
import type { DoctorToolContext } from "@/lib/ai/tools/context";
import {
  dateRangeInputSchema,
  describeRange,
  resolveToolDateRange,
} from "@/lib/ai/tools/range";

const ROW_CAP = 50;

type PendingRow = {
  id?: unknown;
  scheduled_at?: unknown;
  patients?: { full_name?: unknown; phone?: unknown; file_number?: unknown } | null;
  profiles?: { full_name?: unknown } | null;
  departments?: { name?: unknown } | null;
};

type DoneRow = {
  id?: unknown;
  recorded_at?: unknown;
  outcome?: unknown;
  patients?: { full_name?: unknown; phone?: unknown; file_number?: unknown } | null;
};

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * list_pending_followups — operational follow-up worklist.
 *
 * Reuses get_followups_dashboard, the same core the follow-ups page calls, so
 * the assistant and the page agree. That RPC denies managers by design (a
 * pre-existing platform rule), which is why this tool is registered for admin
 * and receptionist only — the assistant must never be a way to reach data the
 * same user is refused in the UI.
 *
 * The RPC returns richer rows than the assistant should see, so the mapping
 * below is a strict field allow-list: patient name, phone, file number,
 * schedule, doctor, department. National ids, payment notes, and amounts are
 * dropped before anything reaches the model.
 *
 * **Phone numbers are deliberately retained** — recorded here because this is
 * the largest quantity of direct patient contact data any P4.6A tool emits (up
 * to 50 rows per call), and that should be a stated decision rather than an
 * accident of the allow-list. The tool's entire purpose is a call worklist: a
 * follow-up list without numbers to call is not usable, the follow-ups page
 * shows the same numbers to the same roles, and the tool is mounted only for
 * admin and receptionist, who make those calls. Phones are excluded from every
 * other tool in the phase, including `list_outstanding_invoices`.
 */
export function listPendingFollowupsTool(ctx: DoctorToolContext) {
  return tool({
    description:
      "List follow-ups for a date range. By default returns appointments still awaiting a follow-up call; when an outcome is given, returns the recorded follow-ups with that outcome instead. Always returns the summary counts. At most 50 rows, with patient name, phone, file number, and appointment context only — no clinical notes.",
    inputSchema: dateRangeInputSchema.extend({
      outcome: z
        .enum(["all_fine", "has_problem", "no_response"])
        .optional()
        .describe(
          "Optional. When set, returns recorded follow-ups with this outcome instead of the pending worklist.",
        ),
    }),
    execute: async ({ outcome, ...rangeInput }) => {
      await assertAnalyticsToolAccess(ctx.user);
      const supabase = await createClient();
      const range = resolveToolDateRange(rangeInput);

      const { data, error } = await supabase.rpc("get_followups_dashboard", {
        p_start: range.start.toISOString(),
        p_end: range.end.toISOString(),
        p_department_id: undefined,
        p_doctor_id: undefined,
        p_patient_ids: undefined,
        p_outcome: outcome ?? undefined,
        p_pending_limit: outcome ? 0 : ROW_CAP,
        p_done_limit: outcome ? ROW_CAP : 0,
        p_done_offset: 0,
      });
      if (error) throw new Error("Follow-up lookup failed.");

      const payload = (data ?? {}) as {
        pending?: PendingRow[];
        done?: DoneRow[];
        summary?: Record<string, unknown>;
      };
      const pending = Array.isArray(payload.pending) ? payload.pending : [];
      const done = Array.isArray(payload.done) ? payload.done : [];

      await logAgentTool({
        clinicId: ctx.user.clinicId,
        actorId: ctx.user.id,
        tool: "list_pending_followups",
        tableName: "follow_ups",
        params: {
          preset: range.preset,
          from: range.from,
          to: range.to,
          outcome: outcome ?? null,
          count: outcome ? done.length : pending.length,
        },
      });

      return {
        range: describeRange(range),
        mode: outcome ? "recorded" : "pending",
        row_cap: ROW_CAP,
        summary: payload.summary ?? {},
        pending: outcome
          ? []
          : pending.slice(0, ROW_CAP).map((row) => ({
              appointment_id: text(row.id),
              scheduled_at: text(row.scheduled_at),
              patient_name: text(row.patients?.full_name),
              patient_phone: text(row.patients?.phone),
              patient_file_number: text(row.patients?.file_number),
              doctor_name: text(row.profiles?.full_name),
              department_name: text(row.departments?.name),
            })),
        recorded: outcome
          ? done.slice(0, ROW_CAP).map((row) => ({
              followup_id: text(row.id),
              recorded_at: text(row.recorded_at),
              outcome: text(row.outcome),
              patient_name: text(row.patients?.full_name),
              patient_phone: text(row.patients?.phone),
              patient_file_number: text(row.patients?.file_number),
            }))
          : [],
      };
    },
  });
}
