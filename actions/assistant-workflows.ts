"use server";

import * as Sentry from "@sentry/nextjs";
import { z } from "zod";
import {
  authorizeStaffAssistant,
  assertWorkflowAccess,
} from "@/lib/ai/authorization";
import { resolveWorkflowStepMount } from "@/lib/ai/tools";
import { confirmOrResumeWorkflow } from "@/lib/ai/workflows/executor";
import {
  workflowPlanSchema,
  WorkflowPlanError,
} from "@/lib/ai/workflows/plan";
import type { WorkflowConfirmationResult } from "@/lib/ai/workflows/types";
import { AiToolAuthorizationError } from "@/lib/ai/errors";
import { checkRateLimit } from "@/lib/rate-limit";

const confirmationSchema = z
  .object({
    runId: z.string().uuid(),
    plan: workflowPlanSchema,
  })
  .strict();

export async function confirmAssistantWorkflow(
  input: unknown,
): Promise<WorkflowConfirmationResult> {
  const parsed = confirmationSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "invalid_request" };
  try {
    const user = await authorizeStaffAssistant();
    await assertWorkflowAccess(user);
    const rateLimit = await checkRateLimit(
      "staff-workflow-confirmation",
      user.clinicId,
      { limit: 10, windowSeconds: 60, failureMode: "closed" },
    );
    if (!rateLimit.allowed) return { ok: false, reason: "rate_limited" };

    const mount = await resolveWorkflowStepMount({ user, locale: "en" });
    const result = await confirmOrResumeWorkflow({
      user,
      runId: parsed.data.runId,
      plan: parsed.data.plan,
      definitions: mount.definitions,
      tools: mount.tools,
    });
    return result
      ? { ok: true, result }
      : { ok: false, reason: "not_confirmable" };
  } catch (error) {
    if (error instanceof WorkflowPlanError) {
      if (error.reason === "preview_stale") {
        return { ok: false, reason: "preview_stale" };
      }
      if (error.reason === "preview_expired") {
        return { ok: false, reason: "preview_expired" };
      }
      return { ok: false, reason: "invalid_request" };
    }
    if (error instanceof AiToolAuthorizationError) {
      return { ok: false, reason: "denied" };
    }
    Sentry.captureException(error, {
      tags: { area: "assistant-workflow-confirmation" },
    });
    return { ok: false, reason: "internal_error" };
  }
}
