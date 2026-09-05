import "server-only";

import * as Sentry from "@sentry/nextjs";
import { z } from "zod";
import { getEntitlements, hasFeature } from "@/lib/entitlements";
import { assertStaffToolAccess } from "@/lib/ai/authorization";
import { AiToolAuthorizationError } from "@/lib/ai/errors";
import { hasAiUserPermission } from "@/lib/ai/permissions";
import { getPageVisibilityState } from "@/lib/server-page-permissions";
import {
  beginAiActionReceipt,
  consumeAiPrivilegedActionRateLimit,
  finalizeAiActionReceipt,
} from "@/lib/supabase/admin";
import {
  actionDigest,
  ActionConfirmationError,
  issueActionConfirmation,
  PRIVILEGED_ACTION_CONFIRMATION_TTL_MS,
  verifyAndClaimActionConfirmation,
} from "@/lib/ai/actions/confirm";
import {
  AI_ACTION_REGISTRY,
  registeredAction,
} from "@/lib/ai/actions/registry";
import { resolveActionResolverContext } from "@/lib/ai/actions/resolver-context";
import type {
  ActionAuditState,
  ActionConfirmationStore,
  ActionDefinition,
  ActionDenialReason,
  ActionInvocationResult,
  ActionPhase,
  ActionReceiptLedger,
  ActionResolverContext,
  ActionRiskClass,
  PrivilegedActionRateLimiter,
  PrivilegedConfirmationBinding,
} from "@/lib/ai/actions/types";
import type { AuthedUser } from "@/lib/rbac";
import {
  ActionBusinessRuleError,
  ActionTransientError,
} from "@/lib/ai/actions/errors";
import {
  notifyClinicAdminsOfPrivilegedAction,
  type PrivilegedNotifier,
} from "@/lib/ai/actions/privileged-notifications";

const UUID_SCHEMA = z.string().uuid();
const ACTION_ID_RE = /^[a-z][a-z0-9_.]{0,99}$/;

export {
  ActionBusinessRuleError,
  ActionTransientError,
} from "@/lib/ai/actions/errors";

class ActionAuthorizationError extends Error {
  constructor(public readonly reason: ActionDenialReason) {
    super(`AI action authorization denied: ${reason}`);
    this.name = "ActionAuthorizationError";
  }
}

export const databaseActionReceiptLedger: ActionReceiptLedger = {
  async begin(input) {
    const { data, error } = await beginAiActionReceipt(input);
    if (error || typeof data !== "string") {
      throw new Error("AI action receipt begin failed.");
    }
    return data;
  },
  async finalize(input) {
    const { data, error } = await finalizeAiActionReceipt(input);
    if (error || data !== true) {
      throw new Error("AI action receipt finalize failed.");
    }
  },
};

export const databasePrivilegedActionRateLimiter: PrivilegedActionRateLimiter = {
  async consume(input) {
    const { data, error } = await consumeAiPrivilegedActionRateLimit(input);
    if (error) throw new Error("AI privileged action rate-limit check failed.");
    return data === true;
  },
};

function mappedAuthorizationReason(error: AiToolAuthorizationError): ActionDenialReason {
  switch (error.reason) {
    case "role_forbidden":
      return "unauthorized_role";
    case "feature_not_entitled":
    case "subscription_inactive":
      return "plan_not_entitled";
    case "permission_not_granted":
      return "permission_not_granted";
    case "unauthorized_scope":
      return "unauthorized_scope";
    case "unauthenticated":
    case "page_hidden":
    case "usage_limit_reached":
    case "lookup_failed":
      return "unauthorized_scope";
  }
}

async function assertActionAccess(
  user: AuthedUser,
  definition: ActionDefinition,
): Promise<void> {
  if (!definition.roles.includes(user.role)) {
    throw new ActionAuthorizationError("unauthorized_role");
  }
  try {
    await assertStaffToolAccess(user);
  } catch (error) {
    if (error instanceof AiToolAuthorizationError) {
      throw new ActionAuthorizationError(mappedAuthorizationReason(error));
    }
    throw error;
  }

  const entitlements = await getEntitlements(user.clinicId);
  if (
    !definition.requiredFeatures.every((feature) =>
      hasFeature(entitlements, feature),
    )
  ) {
    throw new ActionAuthorizationError("plan_not_entitled");
  }
  if (
    definition.requiredUserPermission &&
    !(await hasAiUserPermission(user, definition.requiredUserPermission))
  ) {
    throw new ActionAuthorizationError("permission_not_granted");
  }
  if (definition.pageSlug) {
    const visibility = await getPageVisibilityState(user, definition.pageSlug);
    if (visibility === "hidden") {
      throw new ActionAuthorizationError("unauthorized_scope");
    }
    if (visibility === "lookup_failed") {
      throw new ActionAuthorizationError("transient_failure");
    }
  }
}

function privilegedTarget(
  user: AuthedUser,
  definition: ActionDefinition,
  actionInput: unknown,
): string | null {
  if (definition.risk !== "privileged") return null;
  const target = definition.privilegedTargetUserId?.(actionInput);
  if (!target || !UUID_SCHEMA.safeParse(target).success) {
    throw new ActionAuthorizationError("invalid_request");
  }
  if (target === user.id) {
    throw new ActionAuthorizationError("unauthorized_scope");
  }
  return target;
}

function privilegedBinding(
  targetUserId: string,
  audit: ActionAuditState | undefined,
): PrivilegedConfirmationBinding {
  if (
    audit?.before === undefined ||
    audit?.after === undefined ||
    !(audit.targetRecordIds ?? []).includes(targetUserId)
  ) {
    throw new ActionAuthorizationError("invalid_request");
  }
  return {
    targetUserId,
    beforeDigest: actionDigest(audit.before),
    afterDigest: actionDigest(audit.after),
  };
}

function samePrivilegedBinding(
  confirmed: PrivilegedConfirmationBinding | undefined,
  current: PrivilegedConfirmationBinding,
): boolean {
  return (
    confirmed?.targetUserId === current.targetUserId &&
    confirmed.beforeDigest === current.beforeDigest &&
    confirmed.afterDigest === current.afterDigest
  );
}

async function consumePrivilegedLimit(input: {
  limiter: PrivilegedActionRateLimiter;
  user: AuthedUser;
  conversationId: string;
  phase: ActionPhase;
  now: Date;
}) {
  if (
    !(await input.limiter.consume({
      clinicId: input.user.clinicId,
      actorId: input.user.id,
      conversationId: input.conversationId,
      phase: input.phase,
      occurredAt: input.now.toISOString(),
    }))
  ) {
    throw new ActionAuthorizationError("privileged_rate_limited");
  }
}

function safeActionId(actionId: string): string {
  return ACTION_ID_RE.test(actionId) ? actionId : "assistant.invalid_action";
}

function safeInputDigest(value: unknown): string {
  try {
    return actionDigest(value);
  } catch {
    return actionDigest({ invalid_input: true });
  }
}

function confirmationDenial(error: ActionConfirmationError): ActionDenialReason {
  if (error.reason === "expired") return "confirmation_expired";
  if (error.reason === "replayed") return "confirmation_replayed";
  if (error.reason === "invalid_input") return "invalid_request";
  if (error.reason === "configuration") return "transient_failure";
  return "confirmation_invalid";
}

function auditDigests(audit: ActionAuditState | undefined): {
  targetTable: string | null;
  targetRecordIds: string[];
  beforeDigest: string | null;
  afterDigest: string | null;
} {
  return {
    targetTable: audit?.targetTable?.slice(0, 100) ?? null,
    targetRecordIds: (audit?.targetRecordIds ?? []).filter(
      (id): id is string => UUID_SCHEMA.safeParse(id).success,
    ),
    beforeDigest: audit?.before === undefined ? null : actionDigest(audit.before),
    afterDigest: audit?.after === undefined ? null : actionDigest(audit.after),
  };
}

async function finalizeDenied(input: {
  ledger: ActionReceiptLedger;
  receiptId: string;
  user: AuthedUser;
  reason: ActionDenialReason;
}) {
  await input.ledger.finalize({
    receiptId: input.receiptId,
    clinicId: input.user.clinicId,
    actorId: input.user.id,
    authorizationOutcome: "denied",
    denialReason: input.reason,
    targetTable: null,
    targetRecordIds: [],
    beforeDigest: null,
    afterDigest: null,
    outcome: "error",
    errorCode: input.reason,
  });
}

/**
 * Action id used for the follow-up receipt that records a privileged admin
 * notification that could not be delivered. It is deliberately *not* the
 * mutation's own action id: an incident review must be able to tell "the role
 * change failed" from "the role change succeeded and its notification did not".
 */
export const PRIVILEGED_NOTIFICATION_FAILURE_ACTION_ID =
  "assistant.privileged_notification";

/**
 * Delivers the mandatory §11.1(7) admin notification for an already-committed,
 * already-finalized privileged mutation. Returns whether it landed; a failure
 * is reported to Sentry and written as its own receipt row rather than
 * corrupting the mutation's outcome. Never throws.
 */
async function deliverPrivilegedNotification(input: {
  notifier: PrivilegedNotifier;
  ledger: ActionReceiptLedger;
  user: AuthedUser;
  conversationId: string;
  aiRequestId: string | null;
  actionId: string;
  targetUserId: string;
  targetName: string;
  receiptId: string;
}): Promise<boolean> {
  let reason = "notifier_threw";
  try {
    const outcome = await input.notifier({
      user: input.user,
      actionId: input.actionId,
      targetUserId: input.targetUserId,
      targetName: input.targetName,
      receiptId: input.receiptId,
    });
    if (outcome.delivered) return true;
    reason = outcome.reason;
  } catch (error) {
    Sentry.captureException(error, {
      tags: { area: "assistant-privileged-notification" },
      extra: { actionId: input.actionId, receiptId: input.receiptId },
    });
  }
  Sentry.captureMessage(
    "Privileged action committed but its admin notification was not delivered.",
    {
      level: "error",
      tags: { area: "assistant-privileged-notification" },
      extra: {
        actionId: input.actionId,
        receiptId: input.receiptId,
        reason,
      },
    },
  );
  try {
    const followUpReceiptId = await input.ledger.begin({
      clinicId: input.user.clinicId,
      actorId: input.user.id,
      conversationId: input.conversationId,
      aiRequestId: input.aiRequestId,
      actionId: PRIVILEGED_NOTIFICATION_FAILURE_ACTION_ID,
      riskClass: "privileged",
      phase: "execute",
      inputDigest: safeInputDigest({
        source_receipt_id: input.receiptId,
        action_id: input.actionId,
        target_user_id: input.targetUserId,
      }),
    });
    await input.ledger.finalize({
      receiptId: followUpReceiptId,
      clinicId: input.user.clinicId,
      actorId: input.user.id,
      authorizationOutcome: "allowed",
      denialReason: null,
      targetTable: "notifications",
      targetRecordIds: [input.targetUserId],
      beforeDigest: null,
      afterDigest: null,
      outcome: "error",
      errorCode: `privileged_notification_${reason}`.slice(0, 100),
    });
  } catch (error) {
    Sentry.captureException(error, {
      tags: { area: "assistant-privileged-notification" },
      extra: { receiptId: input.receiptId },
    });
  }
  return false;
}

async function beginReceipt(input: {
  ledger: ActionReceiptLedger;
  user: AuthedUser;
  conversationId: string;
  aiRequestId: string | null;
  actionId: string;
  riskClass: ActionRiskClass;
  phase: ActionPhase;
  actionInput: unknown;
}): Promise<string> {
  return input.ledger.begin({
    clinicId: input.user.clinicId,
    actorId: input.user.id,
    conversationId: input.conversationId,
    aiRequestId: input.aiRequestId,
    actionId: safeActionId(input.actionId),
    riskClass: input.riskClass,
    phase: input.phase,
    inputDigest: safeInputDigest(input.actionInput),
  });
}

export async function previewRegisteredAction(input: {
  user: AuthedUser;
  conversationId: string;
  aiRequestId?: string | null;
  actionId: string;
  actionInput: unknown;
  now?: Date;
  confirmationStore?: ActionConfirmationStore;
  receiptLedger?: ActionReceiptLedger;
  privilegedRateLimiter?: PrivilegedActionRateLimiter;
  /** Injectable so the conversation-derived defaults are testable in isolation. */
  resolverContext?: ActionResolverContext;
}): Promise<ActionInvocationResult> {
  const definition = registeredAction(input.actionId);
  const ledger = input.receiptLedger ?? databaseActionReceiptLedger;
  const receiptId = await beginReceipt({
    ledger,
    user: input.user,
    conversationId: input.conversationId,
    aiRequestId: input.aiRequestId ?? null,
    actionId: input.actionId,
    riskClass: definition?.risk ?? "normal",
    phase: "preview",
    actionInput: input.actionInput,
  });
  let authorizationPassed = false;

  try {
    if (!definition) throw new ActionAuthorizationError("not_supported");
    await assertActionAccess(input.user, definition);
    authorizationPassed = true;
    const parsed = await definition.inputSchema.safeParseAsync(input.actionInput);
    if (!parsed.success) {
      await ledger.finalize({
        receiptId,
        clinicId: input.user.clinicId,
        actorId: input.user.id,
        authorizationOutcome: "allowed",
        denialReason: null,
        targetTable: null,
        targetRecordIds: [],
        beforeDigest: null,
        afterDigest: null,
        outcome: "business_rule_refused",
        errorCode: "invalid_request",
      });
      return {
        action_id: input.actionId,
        phase: "preview",
        action_denied: true,
        confirmation_required: false,
        reason: "invalid_request",
      };
    }

    const targetUserId = privilegedTarget(
      input.user,
      definition,
      parsed.data,
    );
    if (definition.risk === "privileged") {
      await consumePrivilegedLimit({
        limiter:
          input.privilegedRateLimiter ?? databasePrivilegedActionRateLimiter,
        user: input.user,
        conversationId: input.conversationId,
        phase: "preview",
        now: input.now ?? new Date(),
      });
    }
    const resolverContext = {
      ...(input.resolverContext ??
        (await resolveActionResolverContext(input.user, input.conversationId))),
      ...(input.now ? { now: input.now } : {}),
    };
    const preview = await definition.previewValidated(
      input.user,
      parsed.data,
      resolverContext,
    );
    // P6-07 — when the action canonicalised its own input, the token is minted
    // over that object and the UI resends it, so the executed invocation is
    // provably the previewed one. Re-parsed through the action's own schema
    // first: a canonicalisation may only produce input the action already
    // accepts.
    const confirmedInput =
      preview.canonicalInput === undefined
        ? parsed.data
        : definition.inputSchema.parse(preview.canonicalInput);
    const binding = targetUserId
      ? privilegedBinding(targetUserId, preview.audit)
      : undefined;
    const confirmation = await issueActionConfirmation({
      actionId: definition.id,
      actionInput: confirmedInput,
      userId: input.user.id,
      clinicId: input.user.clinicId,
      conversationId: input.conversationId,
      now: input.now,
      ttlMs:
        definition.risk === "privileged"
          ? PRIVILEGED_ACTION_CONFIRMATION_TTL_MS
          : undefined,
      privilegedBinding: binding,
      store: input.confirmationStore,
    });
    const audit = auditDigests(preview.audit);
    await ledger.finalize({
      receiptId,
      clinicId: input.user.clinicId,
      actorId: input.user.id,
      authorizationOutcome: "allowed",
      denialReason: null,
      ...audit,
      outcome: "success",
      errorCode: null,
    });
    return {
      action_id: definition.id,
      phase: "preview",
      risk_class: definition.risk,
      confirmation_required: true,
      confirm_token: confirmation.token,
      expires_at: confirmation.expiresAt,
      step_up_required: definition.risk === "privileged",
      preview: {
        title: preview.title,
        summary: preview.summary,
        changes: preview.changes,
      },
      ...(preview.canonicalInput === undefined
        ? {}
        : { action_input: confirmedInput as Record<string, unknown> }),
    };
  } catch (error) {
    // An authorization gate an action applies *inside* its own preview (e.g. the
    // extra `ai.write_records` feature a clinical document issuance needs) is a
    // denial, not a crash: map it onto the same taxonomy `assertActionAccess`
    // uses so the receipt records `plan_not_entitled` rather than an error.
    const reason =
      error instanceof ActionAuthorizationError
        ? error.reason
        : error instanceof AiToolAuthorizationError
          ? mappedAuthorizationReason(error)
          : error instanceof ActionTransientError
            ? ("transient_failure" as const)
            : null;
    if (reason) {
      await finalizeDenied({
        ledger,
        receiptId,
        user: input.user,
        reason,
      });
      return {
        action_id: input.actionId,
        phase: "preview",
        action_denied: true,
        confirmation_required: false,
        reason,
      };
    }
    if (error instanceof ActionBusinessRuleError) {
      await ledger.finalize({
        receiptId,
        clinicId: input.user.clinicId,
        actorId: input.user.id,
        authorizationOutcome: "allowed",
        denialReason: null,
        targetTable: null,
        targetRecordIds: [],
        beforeDigest: null,
        afterDigest: null,
        outcome: "business_rule_refused",
        errorCode: error.code.slice(0, 100),
      });
      return {
        action_id: input.actionId,
        phase: "preview",
        action_denied: true,
        confirmation_required: false,
        reason: "business_rule_violation",
      };
    }
    await ledger.finalize({
      receiptId,
      clinicId: input.user.clinicId,
      actorId: input.user.id,
      authorizationOutcome: authorizationPassed ? "allowed" : "denied",
      denialReason: authorizationPassed ? null : "transient_failure",
      targetTable: null,
      targetRecordIds: [],
      beforeDigest: null,
      afterDigest: null,
      outcome: "error",
      errorCode: "preview_failed",
    });
    throw error;
  }
}

export async function executeRegisteredAction(input: {
  user: AuthedUser;
  conversationId: string;
  aiRequestId?: string | null;
  actionId: string;
  actionInput: unknown;
  confirmToken: string;
  now?: Date;
  confirmationStore?: ActionConfirmationStore;
  receiptLedger?: ActionReceiptLedger;
  privilegedRateLimiter?: PrivilegedActionRateLimiter;
  /** Injectable so the post-commit notification path is testable in isolation. */
  privilegedNotifier?: PrivilegedNotifier;
  /** Injectable so the conversation-derived defaults are testable in isolation. */
  resolverContext?: ActionResolverContext;
  privilegedStepUpNonce?: string;
  privilegedPreconditionFailure?:
    | "step_up_required"
    | "step_up_failed"
    | "privileged_rate_limited"
    | "confirmation_invalid"
    | "confirmation_expired";
}): Promise<ActionInvocationResult> {
  const definition = registeredAction(input.actionId);
  const ledger = input.receiptLedger ?? databaseActionReceiptLedger;
  const receiptId = await beginReceipt({
    ledger,
    user: input.user,
    conversationId: input.conversationId,
    aiRequestId: input.aiRequestId ?? null,
    actionId: input.actionId,
    riskClass: definition?.risk ?? "normal",
    phase: "execute",
    actionInput: input.actionInput,
  });
  let authorizationPassed = false;

  try {
    if (!definition) throw new ActionAuthorizationError("not_supported");
    const parsed = await definition.inputSchema.safeParseAsync(input.actionInput);
    if (!parsed.success) {
      throw new ActionConfirmationError("invalid_input");
    }

    if (definition.risk === "privileged") {
      if (input.privilegedPreconditionFailure) {
        throw new ActionAuthorizationError(
          input.privilegedPreconditionFailure,
        );
      }
      if (!input.privilegedStepUpNonce) {
        throw new ActionAuthorizationError("step_up_required");
      }
      await consumePrivilegedLimit({
        limiter:
          input.privilegedRateLimiter ?? databasePrivilegedActionRateLimiter,
        user: input.user,
        conversationId: input.conversationId,
        phase: "execute",
        now: input.now ?? new Date(),
      });
    }

    // Claim first, then re-authorize from scratch. A role/feature/permission
    // revoked after preview burns the token and denies the mutation.
    const confirmation = await verifyAndClaimActionConfirmation({
      token: input.confirmToken,
      actionId: definition.id,
      actionInput: parsed.data,
      userId: input.user.id,
      clinicId: input.user.clinicId,
      conversationId: input.conversationId,
      now: input.now,
      reauthNonce: input.privilegedStepUpNonce,
      store: input.confirmationStore,
    });
    await assertActionAccess(input.user, definition);
    const resolverContext = {
      ...(input.resolverContext ??
        (await resolveActionResolverContext(input.user, input.conversationId))),
      ...(input.now ? { now: input.now } : {}),
    };
    const targetUserId = privilegedTarget(
      input.user,
      definition,
      parsed.data,
    );
    let privilegedTargetName = "Unknown staff member";
    if (targetUserId) {
      const currentPreview = await definition.previewValidated(
        input.user,
        parsed.data,
        resolverContext,
      );
      const currentBinding = privilegedBinding(
        targetUserId,
        currentPreview.audit,
      );
      if (!samePrivilegedBinding(confirmation.privilegedBinding, currentBinding)) {
        throw new ActionConfirmationError("invalid");
      }
      const identifier = currentPreview.changes.find(
        (change) => change.identifiesRecord === true,
      );
      if (typeof identifier?.before === "string") {
        privilegedTargetName = identifier.before;
      }
    }
    authorizationPassed = true;

    const executed = await definition.executeValidated(input.user, parsed.data, {
      ...resolverContext,
      conversationId: input.conversationId,
      aiRequestId: input.aiRequestId ?? null,
      actionReceiptId: receiptId,
      idempotencyKey: confirmation.idempotencyKey,
    });
    const audit = auditDigests(executed.audit);
    // F5: the mutation has committed. Finalize the authoritative receipt with
    // the real audit digests BEFORE anything optional runs, so no downstream
    // failure can relabel a committed privileged change as `error`.
    await ledger.finalize({
      receiptId,
      clinicId: input.user.clinicId,
      actorId: input.user.id,
      authorizationOutcome: "allowed",
      denialReason: null,
      ...audit,
      outcome: "success",
      errorCode: null,
    });
    let notificationDelivered = true;
    if (definition.risk === "privileged" && targetUserId) {
      notificationDelivered = await deliverPrivilegedNotification({
        notifier:
          input.privilegedNotifier ?? notifyClinicAdminsOfPrivilegedAction,
        ledger,
        user: input.user,
        conversationId: input.conversationId,
        aiRequestId: input.aiRequestId ?? null,
        actionId: definition.id,
        targetUserId,
        targetName: privilegedTargetName,
        receiptId,
      });
    }
    return {
      action_id: definition.id,
      phase: "execute",
      risk_class: definition.risk,
      confirmation_required: false,
      executed: true,
      ...(definition.risk === "privileged" && targetUserId
        ? { notification_delivered: notificationDelivered }
        : {}),
      result: {
        summary: executed.summary,
        ...(executed.data ? { data: executed.data } : {}),
      },
    };
  } catch (error) {
    const reason =
      error instanceof ActionAuthorizationError
        ? error.reason
        : error instanceof AiToolAuthorizationError
          ? mappedAuthorizationReason(error)
          : error instanceof ActionTransientError
            ? ("transient_failure" as const)
            : error instanceof ActionConfirmationError
              ? confirmationDenial(error)
              : null;
    if (reason) {
      await finalizeDenied({ ledger, receiptId, user: input.user, reason });
      return {
        action_id: input.actionId,
        phase: "execute",
        action_denied: true,
        confirmation_required: false,
        reason,
      };
    }
    if (error instanceof ActionBusinessRuleError) {
      await ledger.finalize({
        receiptId,
        clinicId: input.user.clinicId,
        actorId: input.user.id,
        authorizationOutcome: "allowed",
        denialReason: null,
        targetTable: null,
        targetRecordIds: [],
        beforeDigest: null,
        afterDigest: null,
        outcome: "business_rule_refused",
        errorCode: error.code.slice(0, 100),
      });
      return {
        action_id: input.actionId,
        phase: "execute",
        action_denied: true,
        confirmation_required: false,
        reason: "business_rule_violation",
      };
    }
    await ledger.finalize({
      receiptId,
      clinicId: input.user.clinicId,
      actorId: input.user.id,
      authorizationOutcome: authorizationPassed ? "allowed" : "denied",
      denialReason: authorizationPassed ? null : "transient_failure",
      targetTable: null,
      targetRecordIds: [],
      beforeDigest: null,
      afterDigest: null,
      outcome: "error",
      errorCode: "execute_failed",
    });
    throw error;
  }
}

export async function describeAuthorizedActions(user: AuthedUser) {
  const definitions: ActionDefinition[] = [];
  for (const definition of AI_ACTION_REGISTRY) {
    try {
      await assertActionAccess(user, definition);
      definitions.push(definition);
    } catch (error) {
      if (!(error instanceof ActionAuthorizationError)) throw error;
    }
  }
  return definitions;
}
