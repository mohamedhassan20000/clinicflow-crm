/**
 * Typed errors for the AI assistant. Tools run inside the model loop and cannot
 * use redirect()-based guards (those belong to RSCs/actions), so authorization
 * failures surface as thrown errors the route layer maps to safe responses.
 */

export type AiToolDenialReason =
  | "unauthenticated"
  | "role_forbidden"
  | "page_hidden"
  | "feature_not_entitled"
  | "usage_limit_reached"
  | "lookup_failed"
  | "subscription_inactive";

export class AiToolAuthorizationError extends Error {
  readonly code = "AI_TOOL_FORBIDDEN";
  constructor(
    public readonly reason: AiToolDenialReason,
    message?: string,
  ) {
    super(message ?? `Agent tool access denied: ${reason}`);
    this.name = "AiToolAuthorizationError";
  }
}

export class AiToolInputError extends Error {
  readonly code = "AI_TOOL_INPUT_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "AiToolInputError";
  }
}
