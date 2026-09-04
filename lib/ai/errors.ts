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
  /** Entitled at the plan level, but the admin-granted per-user grant is off. */
  | "permission_not_granted"
  | "usage_limit_reached"
  | "lookup_failed"
  | "subscription_inactive"
  /** Record is absent or outside RLS scope; those cases are intentionally identical. */
  | "unauthorized_scope";

/**
 * Every code the assistant surface can send to the client, over any of its
 * three transports.
 *
 * There are genuinely three, and phase review #2's H2 exists because a previous
 * fix assumed there were two. Verified against `ai@6` rather than inferred:
 *
 *  1. **Pre-stream JSON body.** `POST /api/agent/chat` returns `{ error: code }`
 *     before streaming begins. The client reads it from the fetch response.
 *  2. **Stream-level `error` chunk.** Emitted for a failure of the stream
 *     itself. `processUIMessageStream` turns it into `onError(new Error(text))`,
 *     which is what sets `useChat`'s `error`. This is the *only* one that does.
 *  3. **`tool-output-error` chunk.** A tool whose `execute()` throws is caught
 *     by `executeToolCall` and converted to a `tool-error` content part, never
 *     to a stream error. It reaches the client as a `tool-output-error` chunk
 *     which only calls `updateToolPart({ state: "output-error", errorText })` —
 *     `useChat`'s `error` stays `undefined` and the chat's `onError` is never
 *     invoked. The route's `toUIMessageStreamResponse({ onError })` still runs,
 *     but as the *formatter* that produces `errorText`, not as an error sink.
 *
 * Transport 3 is why the route returns a code from `onError` and why
 * `ToolActivity` classifies a tool part's `errorText` against this union: the
 * code is the only thing that crosses that boundary, and before the review-#2
 * fix the UI discarded it and rendered a bare "could not complete" chip.
 *
 * Shared with the client on purpose. This module is dependency-free and carries
 * no `server-only` marker precisely so the chat component can key its localized
 * copy off the same union the route produces, instead of the two sides agreeing
 * by convention on string literals.
 */
export type AssistantErrorCode =
  | AiToolDenialReason
  | "rate_limited"
  | "invalid_request"
  | "input_limit_reached"
  | "temporarily_unavailable";

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
