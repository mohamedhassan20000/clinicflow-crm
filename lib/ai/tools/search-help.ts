import "server-only";

import { tool } from "ai";
import { z } from "zod";
import { assertStaffToolAccess } from "@/lib/ai/authorization";
import { logAgentTool } from "@/lib/ai/audit";
import { searchHelp } from "@/lib/ai/help/search";
import type { DoctorToolContext } from "@/lib/ai/tools/context";

/**
 * search_help — retrieval over the curated in-repo help corpus (P4.7A).
 *
 * The only tool in the assistant that answers from something other than the
 * clinic's database, and the only one whose source is trusted text: the corpus
 * is static product documentation reviewed in pull requests, containing no
 * tenant data, so it carries no stored-injection risk (contrast the tenant
 * strings that `harden()` neutralizes at the mount boundary — that pass still
 * runs over these results, harmlessly).
 *
 * Its authorization story is short because it reads no clinic data: the staff
 * spine (`assertStaffToolAccess`) plus, inside `searchHelp`, the per-article
 * role/entitlement/permission filter and the navigation registry's page-level
 * resolution. What it must never do is describe a surface the caller cannot
 * reach — that is enforced in `lib/ai/help/search.ts`, not here.
 */
export function searchHelpTool(ctx: DoctorToolContext) {
  return tool({
    description:
      "Look up how to do something in ClinicFlow from the product's official help articles. Use this for any question about how to use the system, where a feature lives, or what steps a workflow takes — for example 'how do I issue an invoice', 'where do I configure reminders', 'how do I add a doctor'. Answer only from what this tool returns: never describe a ClinicFlow feature, screen, button, or step that does not appear in a result. If it returns no results, say plainly that you do not have documentation for that and do not guess. When a result carries a link, offer it. When a result carries 'unavailable_reason', follow its 'guidance' exactly: name where the feature lives, explain it is not enabled for this user, and do not give steps or a URL.",
    inputSchema: z.object({
      query: z
        .string()
        .trim()
        .min(2)
        .max(200)
        .describe(
          "The user's question about using ClinicFlow, in their own words, in Arabic or English.",
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(5)
        .optional()
        .describe("How many articles to return. Defaults to 3."),
    }),
    execute: async ({ query, limit }) => {
      // Re-asserted on every invocation, not only at mount: an administrator can
      // hide the assistant or a subscription can lapse mid-conversation.
      await assertStaffToolAccess(ctx.user);

      const results = await searchHelp(ctx.user, {
        query,
        locale: ctx.locale,
        limit,
      });

      await logAgentTool({
        clinicId: ctx.user.clinicId,
        actorId: ctx.user.id,
        tool: "search_help",
        // Reads no database table — the corpus is a static module. Recording a
        // table here would make the ledger's answer to "what did the assistant
        // touch" wrong in the safe direction, which is still wrong.
        tableName: null,
        params: {
          // The article ids are what makes the row useful for auditing what
          // guidance was actually given. Joined into a string on purpose:
          // `toolAuditSummary` drops arrays, and these are static, non-PII slugs
          // that belong in the ledger. The raw query is deliberately not logged
          // — it is the user's own words, already inside the conversation this
          // row belongs to, and logging it would put free text into the audit
          // trail for no auditing gain.
          article_ids: results.map((result) => result.article_id).join(",") || null,
          result_count: results.length,
          withheld_count: results.filter((result) => result.unavailable_reason).length,
        },
      });

      return {
        results,
        // Stated rather than left to inference. Without it, an empty result is
        // indistinguishable to the model from a failed lookup, and the failure
        // mode of that ambiguity is exactly the one this phase forbids: filling
        // the silence with a plausible-sounding invented procedure.
        corpus_only: true as const,
        no_results_guidance:
          results.length === 0
            ? "No help article covers this. Tell the user you do not have documentation for that specific thing and suggest they ask their clinic administrator. Do not invent steps, screens, or menu names."
            : undefined,
      };
    },
  });
}
