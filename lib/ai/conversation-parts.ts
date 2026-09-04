import type { UIMessage } from "ai";
import type { PendingActionConfirmation } from "@/lib/ai/conversation-context";

export const MAX_PERSISTED_ASSISTANT_PARTS_BYTES = 64_000;

function redactCredentials(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactCredentials);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      key.toLowerCase().includes("password")
        ? "[REDACTED]"
        : redactCredentials(nested),
    ]),
  );
}

/** Persist UI tool cards, but never replay them (or their confirm tokens) to the model. */
export function modelSafeHistory(messages: UIMessage[]): UIMessage[] {
  return messages.map((message) => ({
    ...message,
    parts: message.parts.filter((part) => part.type === "text"),
  }));
}

export function boundedAssistantParts(parts: UIMessage["parts"]): UIMessage["parts"] {
  const redacted = redactCredentials(parts) as UIMessage["parts"];
  try {
    if (Buffer.byteLength(JSON.stringify(redacted), "utf8") <= MAX_PERSISTED_ASSISTANT_PARTS_BYTES) {
      return redacted;
    }
  } catch {
    // A non-serializable tool payload cannot be persisted; text remains safe.
  }
  return redacted.filter((part) => part.type === "text");
}

export function pendingConfirmations(parts: UIMessage["parts"]): PendingActionConfirmation[] {
  return parts.flatMap((part) => {
    if (part.type !== "tool-execute_action" || part.state !== "output-available") return [];
    const output = (part as { output?: unknown }).output;
    if (!output || typeof output !== "object" || Array.isArray(output)) return [];
    const value = output as Record<string, unknown>;
    return value.phase === "preview" && value.confirmation_required === true &&
      typeof value.action_id === "string" && typeof value.expires_at === "string"
      ? [{ action_id: value.action_id, expires_at: value.expires_at }]
      : [];
  });
}

/** Bound first, then derive metadata so active_context can never reference a missing card. */
export function persistedAssistantState(parts: UIMessage["parts"]): {
  parts: UIMessage["parts"];
  pendingConfirmations: PendingActionConfirmation[];
} {
  const persistedParts = boundedAssistantParts(parts);
  return {
    parts: persistedParts,
    pendingConfirmations: pendingConfirmations(persistedParts),
  };
}
