import "server-only";

import { tool } from "ai";
import { z } from "zod";
import { assertClinicAnalyticsToolAccess } from "@/lib/ai/authorization";
import { logAgentTool } from "@/lib/ai/audit";
import { createClient } from "@/lib/supabase/server";
import type { DoctorToolContext } from "@/lib/ai/tools/context";
import {
  dateRangeInputSchema,
  describeRange,
  resolveToolDateRange,
} from "@/lib/ai/tools/range";

/**
 * get_patient_stats — patient distributions for admin/manager (§P4.6).
 *
 * Every bucket passes through the RPC's small-cell suppression floor, so a
 * distribution (notably blood type) can never be reversed into a statement
 * about one identifiable patient. The suppression happens in the database, not
 * here.
 *
 * Suppressed categories are **generalized, not labelled** (phase review #3,
 * H1). Everything below the floor — plus whatever complementary suppression
 * pulls in to protect it — is folded into a single `Other` bucket carrying the
 * exact combined count and naming none of the categories it covers. Because
 * that aggregate always spans at least two categories and always reaches the
 * floor, it is safe to publish exactly, which is what lets `patients_total` be
 * exact again and agree with `get_clinic_summary` instead of contradicting it.
 *
 * The earlier design withheld the total instead, and that only held as long as
 * no sibling tool published it. `get_clinic_summary` did, mounting under the
 * identical role and feature gates, so two calls and one subtraction recovered
 * the hidden cells exactly. Generalizing the buckets makes this tool's privacy
 * property self-contained rather than a property of the whole tool surface.
 *
 * **Scope of that property (post-plan completion).** It is a property of *this
 * statistical release*, not of the underlying rows. The same caller may read
 * those rows directly through `query_resource`, and count them grouped through
 * `aggregate_resource`, because plan §7.4 rules that "a clinic user listing
 * records they are authorized to read is not treated as a statistical
 * disclosure". The model was nevertheless generalizing this tool's suppression
 * into a blanket refusal, so every result now carries an explicit, structured
 * pointer at the authorized path. The pointer names tools, never data: it adds
 * no capability and no row, and an unauthorized caller reaching that path is
 * denied there exactly as before.
 */
/**
 * This tool's `group_by` vocabulary mapped onto the `patients` resource group
 * keys, so the re-route pointer names a key `aggregate_resource` will actually
 * accept. Kept as an explicit record rather than a string transform so a
 * renamed registry key is a compile error here, not a dead-end hint at runtime.
 */
const GROUP_BY_RESOURCE_KEY = {
  department: "department_id",
  blood_type: "blood_type",
  assigned_doctor: "assigned_doctor_id",
} as const satisfies Record<string, string>;

export function getPatientStatsTool(ctx: DoctorToolContext) {
  return tool({
    description:
      "Get aggregate patient statistics for the clinic: new patients within the date range, plus an ALL-TIME distribution grouped by department, blood type, or assigned doctor. The distribution in `buckets_all_time` covers the whole patient population and ignores the date range — never describe it as belonging to the range. Small groups are never listed individually: every group below the privacy floor, together with any group folded in to protect them, is combined into one bucket named 'Other' with `suppression_reason: 'aggregated'`, an exact combined `count`, and `grouped_bucket_count` saying how many groups it covers. Report that bucket as a combined 'other groups' total — never guess which categories it contains, how many are in any one of them, or name a category that is not in the list. If `distribution_withheld` is true there are no buckets at all. `patients_total` is always exact and always matches the clinic summary. IMPORTANT: this tool's suppression is a property of this statistical release only, never of the underlying records. If it suppresses or withholds what the user asked for, do NOT tell the user the information cannot be shown — follow `authorized_alternative` in the result and answer from the resource path (`aggregate_resource` with group_by, then `query_resource` with the matching filter), which returns exact, RLS-scoped rows this user is already authorized to read.",
    inputSchema: dateRangeInputSchema.extend({
      group_by: z
        .enum(["department", "blood_type", "assigned_doctor"])
        .default("department")
        .describe("Which attribute to group the distribution by."),
    }),
    execute: async ({ group_by, ...rangeInput }) => {
      await assertClinicAnalyticsToolAccess(ctx.user);
      const supabase = await createClient();
      const range = resolveToolDateRange(rangeInput);

      const { data, error } = await supabase.rpc("ai_get_patient_stats", {
        p_start: range.start.toISOString(),
        p_end: range.end.toISOString(),
        p_group_by: group_by,
      });
      if (error) throw new Error("Patient statistics lookup failed.");

      await logAgentTool({
        clinicId: ctx.user.clinicId,
        actorId: ctx.user.id,
        tool: "get_patient_stats",
        tableName: "patients",
        params: { preset: range.preset, from: range.from, to: range.to, group_by },
      });

      return {
        range: describeRange(range),
        stats: data,
        authorized_alternative: {
          reason:
            "Suppression above applies to this statistical tool only. The same caller may read the underlying records directly.",
          resource: "patients",
          group_by: GROUP_BY_RESOURCE_KEY[group_by],
          aggregate_tool: "aggregate_resource",
          list_tool: "query_resource",
          guidance:
            "For an exact distribution call aggregate_resource with resource 'patients' and this group_by; to list the records in any group, however small, call query_resource with the same filter. Both are scoped by the caller's own RLS and role, so use them instead of reporting that the information cannot be shown.",
        },
      };
    },
  });
}
