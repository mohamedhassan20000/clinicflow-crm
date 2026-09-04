import type { z } from "zod";
import { sameCanonicalValue } from "@/lib/ai/actions/canonical";
import type { AiCommercialFeature } from "@/lib/ai/commercial-policy";
import type { AiUserPermissionKey } from "@/lib/ai/permissions";
import type { PageSlug } from "@/lib/page-permissions";
import type { AuthedUser, UserRole } from "@/lib/rbac";

export type ActionRiskClass =
  | "normal"
  | "sensitive"
  | "destructive"
  | "bulk"
  | "privileged";

export type ActionPhase = "preview" | "execute";

export type ActionDenialReason =
  | "unauthorized_role"
  | "unauthorized_scope"
  | "plan_not_entitled"
  | "permission_not_granted"
  | "missing_information"
  | "ambiguous"
  | "confirmation_required"
  | "confirmation_invalid"
  | "confirmation_expired"
  | "confirmation_replayed"
  | "step_up_required"
  | "step_up_failed"
  | "privileged_rate_limited"
  | "business_rule_violation"
  | "not_supported"
  | "invalid_request"
  | "transient_failure";

export type ActionPreviewChange = {
  label: string;
  before: string | number | boolean | null;
  after: string | number | boolean | null;
  /** Explicitly marks the human-readable record identity required by §11. */
  identifiesRecord?: true;
};

export type ActionAuditState = {
  targetTable?: string | null;
  targetRecordIds?: readonly string[];
  before?: unknown;
  after?: unknown;
};

export type ActionPreview = {
  title: string;
  summary: string;
  changes: readonly ActionPreviewChange[];
  audit?: ActionAuditState;
  /**
   * P6-07 — the server's own canonicalisation of this invocation's input.
   *
   * When present, the confirm token is minted over **this** object rather than
   * the model-supplied one, and it is handed back to the UI as the input the
   * confirm button must resend. That closes the gap where a value the server
   * resolved at preview (a reporting period derived from `this_month`, an entity
   * taken from conversation context) was re-derived independently at execute and
   * could legitimately differ inside the token's 10-minute TTL — issuing a
   * different document than the one the user approved, with a still-valid token.
   *
   * It can only ever *narrow* trust: the value is re-parsed through the action's
   * own input schema before the token is minted, and a client that resends the
   * old input simply fails the digest check and is denied.
   */
  canonicalInput?: unknown;
};

export type ActionExecution = {
  summary: string;
  audit?: ActionAuditState;
  data?: Readonly<Record<string, unknown>>;
};

/**
 * Server-derived, conversation-scoped context an action may resolve defaults
 * from. Identical in both phases because it is read from the conversation row
 * rather than reconstructed by the caller, so what the preview auto-filled is
 * what the execute sees (§10's continuous loop). Never model-supplied.
 */
export type ActionResolverContext = {
  conversationId: string;
  /** The conversation's own language, for output that has a language. */
  locale: "ar" | "en";
  activePatientId: string | null;
  activeAppointmentId: string | null;
  /**
   * The invocation clock, so a phase that derives a value from "now" (a named
   * reporting period, a relative date) derives it from the same instant the
   * pipeline is reasoning about rather than from an ambient `new Date()`.
   * Omitted means "use the wall clock".
   */
  now?: Date;
};

export type ActionExecutionContext = ActionResolverContext & {
  aiRequestId: string | null;
  /** Receipt already opened for this execute attempt; action provenance only. */
  actionReceiptId: string;
  /** Derived from the consumed confirm token; domain cores use it for dedupe. */
  idempotencyKey: string;
};

export type ActionDefinition<TInput = unknown> = {
  id: string;
  roles: readonly UserRole[];
  requiredFeatures: readonly AiCommercialFeature[];
  requiredUserPermission?: AiUserPermissionKey;
  risk: ActionRiskClass;
  inputSchema: z.ZodType<TInput>;
  pageSlug?: PageSlug;
  labels: { en: string; ar: string };
  description: { en: string; ar: string };
  inputDescription: { en: string; ar: string };
  /** Server-owned target resolver used by the Phase 5f self-mutation ban. */
  privilegedTargetUserId?: (input: TInput) => string;
  preview: (
    user: AuthedUser,
    input: TInput,
    context: ActionResolverContext,
  ) => Promise<ActionPreview>;
  execute: (
    user: AuthedUser,
    input: TInput,
    context: ActionExecutionContext,
  ) => Promise<ActionExecution>;
};

/**
 * Type-erased registry entry for heterogeneous action inputs. The adapter
 * validates unknown registry input with the action's own schema before calling
 * its strongly typed implementation.
 */
export type RegisteredActionDefinition = Omit<
  ActionDefinition<unknown>,
  "preview" | "execute" | "privilegedTargetUserId"
> & {
  privilegedTargetUserId?: (input: unknown) => string;
  previewContract: "standard" | "record_identifying" | "explicit_diff";
  preview: (
    user: AuthedUser,
    input: unknown,
    context?: ActionResolverContext,
  ) => Promise<ActionPreview>;
  /** Invokes the real definition after the registry adapter has parsed input. */
  previewValidated: (
    user: AuthedUser,
    input: unknown,
    context?: ActionResolverContext,
  ) => Promise<ActionPreview>;
  execute: (
    user: AuthedUser,
    input: unknown,
    context: ActionExecutionContext,
  ) => Promise<ActionExecution>;
  /** Invokes the real definition after the registry adapter has parsed input. */
  executeValidated: (
    user: AuthedUser,
    input: unknown,
    context: ActionExecutionContext,
  ) => Promise<ActionExecution>;
};

function beginsWithJsonObject(value: ActionPreviewChange["before"]): boolean {
  return typeof value === "string" && value.trimStart().startsWith("{");
}

function isHumanReadableIdentifier(
  value: ActionPreviewChange["before"],
): boolean {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    !beginsWithJsonObject(value)
  );
}

export class ActionPreviewContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionPreviewContractError";
  }
}

export function assertActionPreviewContract(
  risk: ActionRiskClass,
  preview: ActionPreview,
): void {
  if (risk !== "destructive" && risk !== "bulk" && risk !== "privileged") {
    return;
  }

  if (
    preview.changes.some(
      (change) =>
        beginsWithJsonObject(change.before) || beginsWithJsonObject(change.after),
    )
  ) {
    throw new ActionPreviewContractError(
      "High-risk previews may not render JSON objects as record identifiers.",
    );
  }

  const hasRecordIdentifier = preview.changes.some(
    (change) =>
      change.identifiesRecord === true &&
      (isHumanReadableIdentifier(change.before) ||
        isHumanReadableIdentifier(change.after)),
  );
  if (!hasRecordIdentifier) {
    throw new ActionPreviewContractError(
      "High-risk previews must identify the exact target record.",
    );
  }
  if (
    risk === "privileged" &&
    !preview.changes.some(
      (change) =>
        change.identifiesRecord !== true &&
        // Same normalisation the diff builder and the confirm-token digest use,
        // so "there is a real change" means one thing across all three.
        !sameCanonicalValue(change.before, change.after),
    )
  ) {
    throw new ActionPreviewContractError(
      "Privileged previews must contain an explicit before-to-after change.",
    );
  }
}

/**
 * Fallback for callers that hold no conversation (non-route surfaces, and the
 * registry's own contract probes). Deliberately empty rather than guessed: an
 * action that resolves a default from context must fail closed and ask, never
 * invent an entity.
 */
export const DETACHED_RESOLVER_CONTEXT: ActionResolverContext = {
  conversationId: "",
  locale: "en",
  activePatientId: null,
  activeAppointmentId: null,
};

export function registerActionDefinition<TInput>(
  definition: ActionDefinition<TInput>,
): RegisteredActionDefinition {
  const { privilegedTargetUserId, ...baseDefinition } = definition;
  const previewContract =
    definition.risk === "privileged"
      ? "explicit_diff"
      : definition.risk === "destructive" || definition.risk === "bulk"
      ? "record_identifying"
      : "standard";
  const previewValidated = async (
    user: AuthedUser,
    input: unknown,
    context?: ActionResolverContext,
  ) => {
    const preview = await definition.preview(
      user,
      input as TInput,
      context ?? DETACHED_RESOLVER_CONTEXT,
    );
    assertActionPreviewContract(definition.risk, preview);
    return preview;
  };
  const executeValidated = (
    user: AuthedUser,
    input: unknown,
    context: ActionExecutionContext,
  ) => definition.execute(user, input as TInput, context);

  return {
    ...baseDefinition,
    ...(privilegedTargetUserId
      ? {
          privilegedTargetUserId: (input: unknown) =>
            privilegedTargetUserId(input as TInput),
        }
      : {}),
    previewContract,
    inputSchema: definition.inputSchema as z.ZodType<unknown>,
    preview: (user, input, context) =>
      previewValidated(user, definition.inputSchema.parse(input), context),
    previewValidated,
    execute: (user, input, context) =>
      executeValidated(user, definition.inputSchema.parse(input), context),
    executeValidated,
  };
}

export type ActionPreviewSuccess = {
  action_id: string;
  phase: "preview";
  risk_class: ActionRiskClass;
  confirmation_required: true;
  confirm_token: string;
  expires_at: string;
  step_up_required?: boolean;
  preview: Pick<ActionPreview, "title" | "summary" | "changes">;
  /**
   * P6-07 — the exact input the confirm token was minted over. Present whenever
   * the action canonicalised its own input; the confirm button must resend this
   * rather than the model's original arguments, or the digest check denies it.
   * Withheld from model context along with the token.
   */
  action_input?: Record<string, unknown>;
};

export type ActionExecuteSuccess = {
  action_id: string;
  phase: "execute";
  risk_class: ActionRiskClass;
  confirmation_required: false;
  executed: true;
  /**
   * Privileged actions only. The mutation committed either way — this reports
   * whether the mandatory admin notification for it was delivered, so a failed
   * notification is visible without ever being confused with a failed change.
   */
  notification_delivered?: boolean;
  result: Pick<ActionExecution, "summary" | "data">;
};

export type ActionDenied = {
  action_id: string;
  phase: ActionPhase;
  action_denied: true;
  confirmation_required: false;
  reason: ActionDenialReason;
};

export type ActionInvocationResult =
  | ActionPreviewSuccess
  | ActionExecuteSuccess
  | ActionDenied;

export type ConfirmationClaimOutcome =
  | "claimed"
  | "invalid"
  | "expired"
  | "replayed";

export type PrivilegedConfirmationBinding = {
  targetUserId: string;
  beforeDigest: string;
  afterDigest: string;
};

export interface ActionConfirmationStore {
  issue(input: {
    tokenHash: string;
    clinicId: string;
    actorId: string;
    conversationId: string;
    actionId: string;
    inputDigest: string;
    expiresAt: string;
    riskClass?: ActionRiskClass;
    privilegedBinding?: PrivilegedConfirmationBinding;
  }): Promise<void>;
  verifyStepUp?(input: {
    tokenHash: string;
    clinicId: string;
    actorId: string;
    reauthNonceHash: string;
    verifiedAt: string;
  }): Promise<boolean>;
  claim(input: {
    tokenHash: string;
    clinicId: string;
    actorId: string;
    conversationId: string;
    actionId: string;
    inputDigest: string;
    consumedAt: string;
    privilegedBinding?: PrivilegedConfirmationBinding;
    reauthNonceHash?: string;
  }): Promise<ConfirmationClaimOutcome>;
}

export interface PrivilegedActionRateLimiter {
  consume(input: {
    clinicId: string;
    actorId: string;
    conversationId: string;
    phase: ActionPhase;
    occurredAt: string;
  }): Promise<boolean>;
}

export interface ActionReceiptLedger {
  begin(input: {
    clinicId: string;
    actorId: string;
    conversationId: string;
    aiRequestId: string | null;
    actionId: string;
    riskClass: ActionRiskClass;
    phase: ActionPhase;
    inputDigest: string;
  }): Promise<string>;
  finalize(input: {
    receiptId: string;
    clinicId: string;
    actorId: string;
    authorizationOutcome: "allowed" | "denied";
    denialReason: string | null;
    targetTable: string | null;
    targetRecordIds: readonly string[];
    beforeDigest: string | null;
    afterDigest: string | null;
    outcome: "success" | "business_rule_refused" | "error";
    errorCode: string | null;
  }): Promise<void>;
}
