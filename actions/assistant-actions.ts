"use server";

import * as Sentry from "@sentry/nextjs";
import { z } from "zod";
import {
  ActionConfirmationError,
  actionConfirmationExpiresAt,
  verifyPrivilegedActionStepUp,
} from "@/lib/ai/actions/confirm";
import { executeRegisteredAction } from "@/lib/ai/actions/execute";
import { registeredAction } from "@/lib/ai/actions/registry";
import type {
  ActionDenialReason,
  ActionExecuteSuccess,
} from "@/lib/ai/actions/types";
import { checkRateLimit } from "@/lib/rate-limit";
import { getAuthedUser } from "@/lib/rbac";
import { clearPendingActionConfirmation } from "@/lib/ai/conversations";
import { createClient } from "@/lib/supabase/server";
import { verifyCurrentPasswordStepUp } from "@/lib/auth/step-up";

const confirmationSchema = z
  .object({
    conversationId: z.string().uuid(),
    actionId: z.string().regex(/^[a-z][a-z0-9_.]{0,99}$/),
    input: z.record(z.string(), z.unknown()),
    confirmToken: z.string().min(40).max(2_500),
    currentPassword: z.string().min(1).max(1_024).optional(),
  })
  .strict();

export type AssistantActionConfirmationResult =
  | { ok: true; result: ActionExecuteSuccess }
  | {
      ok: false;
      reason:
        | ActionDenialReason
        | "rate_limited"
        | "invalid_request"
        | "internal_error";
    };

export async function confirmAssistantAction(
  input: unknown,
): Promise<AssistantActionConfirmationResult> {
  const parsed = confirmationSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "invalid_request" };

  try {
    // Fresh session/profile resolution here is deliberate: preview-time user
    // data is never reused for execution.
    const user = await getAuthedUser();
    if (!user) return { ok: false, reason: "unauthorized_scope" };
    const rateLimit = await checkRateLimit(
      "staff-action-confirmation",
      `${user.clinicId}:${user.id}`,
      { limit: 10, windowSeconds: 60, failureMode: "closed" },
    );
    if (!rateLimit.allowed) return { ok: false, reason: "rate_limited" };

    const definition = registeredAction(parsed.data.actionId);
    let privilegedStepUpNonce: string | undefined;
    let privilegedPreconditionFailure:
      | "step_up_required"
      | "step_up_failed"
      | "privileged_rate_limited"
      | "confirmation_invalid"
      | "confirmation_expired"
      | undefined;
    if (definition?.risk === "privileged") {
      if (!parsed.data.currentPassword) {
        privilegedPreconditionFailure = "step_up_required";
      } else {
        const stepUpLimit = await checkRateLimit(
          "assistant-privileged-step-up",
          `${user.clinicId}:${user.id}`,
          { limit: 5, windowSeconds: 15 * 60, failureMode: "closed" },
        );
        if (!stepUpLimit.allowed) {
          privilegedPreconditionFailure = "privileged_rate_limited";
        } else if (
          !(await verifyCurrentPasswordStepUp(
            user,
            parsed.data.currentPassword,
          ))
        ) {
          privilegedPreconditionFailure = "step_up_failed";
        } else {
          try {
            privilegedStepUpNonce = await verifyPrivilegedActionStepUp({
              token: parsed.data.confirmToken,
              userId: user.id,
              clinicId: user.clinicId,
            });
          } catch (error) {
            privilegedPreconditionFailure =
              error instanceof ActionConfirmationError &&
              error.reason === "expired"
                ? "confirmation_expired"
                : "confirmation_invalid";
          }
        }
      }
    }

    const result = await executeRegisteredAction({
      user,
      conversationId: parsed.data.conversationId,
      actionId: parsed.data.actionId,
      actionInput: parsed.data.input,
      confirmToken: parsed.data.confirmToken,
      privilegedStepUpNonce,
      privilegedPreconditionFailure,
    });
    if (result.phase === "execute" && "executed" in result) {
      const supabase = await createClient();
      await clearPendingActionConfirmation({
        supabase,
        user,
        conversationId: parsed.data.conversationId,
        actionId: parsed.data.actionId,
        expiresAt: actionConfirmationExpiresAt(parsed.data.confirmToken),
      });
      return { ok: true, result };
    }
    return {
      ok: false,
      reason: "action_denied" in result ? result.reason : "invalid_request",
    };
  } catch (error) {
    Sentry.captureException(error, {
      tags: { area: "assistant-action-confirmation" },
    });
    return { ok: false, reason: "internal_error" };
  }
}
