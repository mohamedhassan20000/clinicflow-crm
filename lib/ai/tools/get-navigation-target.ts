import "server-only";

import { tool } from "ai";
import { z } from "zod";
import { assertStaffToolAccess } from "@/lib/ai/authorization";
import { logAgentTool } from "@/lib/ai/audit";
import {
  NAVIGATION_TARGET_IDS,
  resolveNavigationTarget,
  type NavigationAccessStatus,
  type NavigationTargetId,
} from "@/lib/ai/help/navigation";
import type { DoctorToolContext } from "@/lib/ai/tools/context";

/**
 * What the model should do with each verdict, in the model's working language.
 *
 * Enumerated exhaustively so adding a status is a compile error here rather than
 * a silent fall-through to a vague sentence — the same argument
 * `DENIAL_GUIDANCE` in `lib/ai/tools/index.ts` makes for tool denials.
 *
 * The denials are kept distinct because they send the user to different people
 * or remedies. Collapsing them into "you can't" is what makes an assistant
 * useless at exactly the moment it could be useful: the user whose page their
 * administrator hid can have it back in thirty seconds if they are told who to
 * ask.
 */
const STATUS_GUIDANCE: Record<NavigationAccessStatus, string> = {
  available:
    "This user can open this page. Give them the section path and the link.",
  role_forbidden:
    "This part of ClinicFlow is not available to this user's role at all. Tell them plainly that it is not part of what their role can access, and suggest the colleague whose role handles it. Do not give a URL, do not describe the steps, and do not offer it again in this conversation.",
  primary_admin_required:
    "This section is reserved for the clinic's primary administrator. Tell the user that a secondary administrator cannot open it and that the clinic's primary administrator handles it. Do not give a URL and do not describe the steps as available to this user.",
  hidden_by_admin:
    "This page exists and their role would normally include it, but their clinic administrator has turned it off for their account. Tell them exactly that — name the section so they know what to ask for — and tell them their administrator controls it under Settings → Customize. Do not give a URL and do not walk them through the steps.",
  not_entitled:
    "This capability is not part of this clinic's current plan, so it does not exist for them. Tell them it is not included in their plan and that their clinic administrator would handle upgrading. Do not give a URL and do not describe what the feature would do.",
  lookup_failed:
    "Their access to this page could not be verified, so treat it as unavailable. Tell them you could not confirm their access and ask them to try again shortly. Do not give a URL.",
};

/**
 * get_navigation_target — resolves a feature to its route *and* whether this
 * user may open it (P4.7A).
 *
 * The tool exists because guidance that contradicts server-side authorization is
 * worse than no guidance: a user sent to a page their administrator hid follows
 * a link, gets redirected, and now distrusts every answer the assistant gave
 * them. So the same resolution the shell and middleware use — `ROLE_PAGE_SLUGS`,
 * the route's own guard, primary-admin authority where applicable, plan
 * entitlements, and `user_page_permissions` — decides what this returns, and
 * `href` is present only on `available`.
 *
 * Note what it deliberately is not: a route enumerator. The input is a closed
 * enum of registered target ids, so the model cannot ask about an arbitrary
 * path, and an unregistered id resolves to a denial rather than a probe result.
 */
export function getNavigationTargetTool(ctx: DoctorToolContext) {
  return tool({
    description:
      "Resolve where a ClinicFlow feature lives and whether this specific user can open it. Use it before telling anyone to go somewhere in the app, so you never send them to a page they cannot reach. Report the returned status honestly: only offer the link when a link is returned, and when it is not, follow the returned 'guidance' exactly — never guess a URL, and never present a page as available when the result says it is not.",
    inputSchema: z.object({
      target: z
        .enum(NAVIGATION_TARGET_IDS as [NavigationTargetId, ...NavigationTargetId[]])
        .describe("Which part of ClinicFlow the user is trying to reach."),
    }),
    execute: async ({ target }) => {
      await assertStaffToolAccess(ctx.user);

      const resolution = await resolveNavigationTarget(ctx.user, target, ctx.locale);

      await logAgentTool({
        clinicId: ctx.user.clinicId,
        actorId: ctx.user.id,
        tool: "get_navigation_target",
        tableName: null,
        params: { target, status: resolution.status },
      });

      return {
        target: resolution.id,
        status: resolution.status,
        // Safe on every status: naming the section is what lets the answer be
        // specific about what is unavailable and who can change it. The route
        // is not safe, and `resolution.href` is undefined unless available.
        section: resolution.breadcrumb,
        label: resolution.label,
        ...(resolution.href ? { link: resolution.href } : {}),
        guidance: STATUS_GUIDANCE[resolution.status],
      };
    },
  });
}
