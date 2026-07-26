import "server-only";

import { tool } from "ai";
import { z } from "zod";
import { assertFinancialInsightsAccess } from "@/lib/ai/authorization";
import { logAgentTool } from "@/lib/ai/audit";
import { createClient } from "@/lib/supabase/server";
import type { DoctorToolContext } from "@/lib/ai/tools/context";
import {
  dateRangeInputSchema,
  describeRange,
  resolveToolDateRange,
} from "@/lib/ai/tools/range";
import { activeEntityId } from "@/lib/ai/conversation-context";

const MAX_LIMIT = 25;

/**
 * list_outstanding_invoices — the only financial tool that returns rows rather
 * than aggregates, so its field allow-list is the narrowest in the phase:
 * patient name, outstanding amount, and age in days. Nothing else — no
 * services, no payment notes, no clinical context, no contact details.
 *
 * Two corrections over the first cut, both about the numbers *meaning*
 * something:
 *
 *   * **Status.** It previously counted any appointment with a residual
 *     `outstanding_amount`, including `cancelled` and `no_show` ones, while
 *     `ai_get_revenue_summary` scopes strictly to `completed`. The assistant
 *     could therefore contradict itself between two of its own tools, and
 *     contradict the revenue report page a user can open to check it. The
 *     status predicate now matches the revenue definition.
 *   * **Time.** It was the one tool with no range input at all, so it ordered
 *     the clinic's entire appointment history by amount. A range is now
 *     accepted and clamped like every other tool; when omitted the payload says
 *     `scope: "all_time"` explicitly rather than leaving the model to assume.
 */
export function listOutstandingInvoicesTool(ctx: DoctorToolContext) {
  return tool({
    description:
      "List completed appointments that still carry an outstanding balance, largest first. Returns patient name, outstanding amount, and how many days old the balance is — nothing else. Capped at 25 rows. Covers all time unless a date range is given. Counts the same appointments as get_revenue_summary, so the two always reconcile.",
    inputSchema: z.object({
      invoice_id: z
        .string()
        .uuid()
        .optional()
        .describe(
          "Optional invoice id explicitly named by the user (the underlying completed appointment id). Do not copy the active context id into this field; use use_active_invoice instead.",
        ),
      use_active_invoice: z
        .boolean()
        .optional()
        .describe(
          "Set true only when the user explicitly refers to the active invoice or balance. Omit or set false for clinic-wide totals and broad outstanding-balance lists.",
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_LIMIT)
        .default(10)
        .describe("How many outstanding balances to return (max 25)."),
      preset: dateRangeInputSchema.shape.preset
        .optional()
        .describe("Optional. Omit to cover all outstanding balances regardless of age."),
      date_from: dateRangeInputSchema.shape.date_from,
      date_to: dateRangeInputSchema.shape.date_to,
    }),
    execute: async ({
      invoice_id,
      use_active_invoice,
      limit,
      preset,
      date_from,
      date_to,
    }) => {
      await assertFinancialInsightsAccess(ctx.user);
      const supabase = await createClient();
      const activeInvoiceId = activeEntityId(ctx.activeContext, "invoice");
      const effectiveInvoiceId =
        invoice_id ?? (use_active_invoice === true ? activeInvoiceId : null);

      if (use_active_invoice === true && !invoice_id && !activeInvoiceId) {
        return {
          needs_clarification: true,
          field: "invoice_id",
          guidance:
            "There is no active invoice in this conversation. Ask the user which invoice or balance they mean.",
          candidates: [],
        };
      }

      const range = preset
        ? resolveToolDateRange({ preset, date_from, date_to })
        : null;

      let query = supabase
        .from("appointments")
        .select("id, scheduled_at, outstanding_amount, patients(full_name)")
        .eq("clinic_id", ctx.user.clinicId)
        .is("deleted_at", null)
        // Mirrors ai_get_revenue_summary's scope so the two tools agree.
        .eq("status", "completed")
        .gt("outstanding_amount", 0);

      if (effectiveInvoiceId) query = query.eq("id", effectiveInvoiceId);
      if (range) {
        query = query
          .gte("scheduled_at", range.start.toISOString())
          .lte("scheduled_at", range.end.toISOString());
      }

      // One past the effective cap, so a clinic with exactly `limit`
      // outstanding balances is not told its list was truncated when it was not.
      const effectiveLimit = Math.min(limit, MAX_LIMIT);
      const { data, error } = await query
        .order("outstanding_amount", { ascending: false })
        .limit(effectiveLimit + 1);
      if (error) throw new Error("Outstanding balance lookup failed.");

      const fetched = data ?? [];
      const truncated = fetched.length > effectiveLimit;
      const now = Date.now();
      const rows = fetched.slice(0, effectiveLimit).map((row) => ({
        appointment_id: row.id,
        patient_name: row.patients?.full_name ?? null,
        outstanding_amount: Number(row.outstanding_amount ?? 0),
        age_days: row.scheduled_at
          ? Math.max(
              0,
              Math.floor((now - new Date(row.scheduled_at).getTime()) / 86_400_000),
            )
          : null,
      }));

      if (
        rows.length === 1 &&
        !truncated &&
        !invoice_id &&
        !activeInvoiceId &&
        ctx.conversationId
      ) {
        const invoice = rows[0]!;
        ctx.contextRecorder?.propose(
          "invoice",
          invoice.appointment_id,
          invoice.patient_name
            ? `${invoice.patient_name} · ${invoice.outstanding_amount}`
            : String(invoice.outstanding_amount),
          "resolution",
        );
      }

      await logAgentTool({
        clinicId: ctx.user.clinicId,
        actorId: ctx.user.id,
        tool: "list_outstanding_invoices",
        tableName: "appointments",
        params: {
          limit,
          count: rows.length,
          scope: range ? range.preset : "all_time",
          invoice_filtered: Boolean(effectiveInvoiceId),
          from_active_context:
            use_active_invoice === true &&
            !invoice_id &&
            Boolean(activeInvoiceId),
        },
      });

      return {
        row_cap: effectiveLimit,
        truncated,
        scope: range ? "range" : "all_time",
        range: range ? describeRange(range) : null,
        status_filter: "completed",
        outstanding: rows,
      };
    },
  });
}
