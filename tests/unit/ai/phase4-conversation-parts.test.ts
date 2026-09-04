import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import {
  MAX_PERSISTED_ASSISTANT_PARTS_BYTES,
  modelSafeHistory,
  persistedAssistantState,
} from "@/lib/ai/conversation-parts";

function confirmationPart(extra: Record<string, unknown> = {}) {
  return {
    type: "tool-execute_action" as const,
    toolCallId: "action-preview",
    state: "output-available" as const,
    input: { action: "appointments.send_reminders", input: {} },
    output: {
      action_id: "appointments.send_reminders",
      phase: "preview",
      confirmation_required: true,
      confirm_token: "server-only-confirm-token",
      expires_at: "2026-08-13T12:10:00.000Z",
      ...extra,
    },
  };
}

describe("Phase 4 persisted conversation parts", () => {
  it("keeps a preview-only confirmation card and derives matching active context", () => {
    const state = persistedAssistantState([confirmationPart()] as UIMessage["parts"]);
    expect(state.parts).toHaveLength(1);
    expect(state.pendingConfirmations).toEqual([{
      action_id: "appointments.send_reminders",
      expires_at: "2026-08-13T12:10:00.000Z",
    }]);
  });

  it("drops an oversized card and never leaves ghost pending-confirmation metadata", () => {
    const state = persistedAssistantState([
      confirmationPart({ preview: "x".repeat(MAX_PERSISTED_ASSISTANT_PARTS_BYTES) }),
    ] as UIMessage["parts"]);
    expect(state.parts).toEqual([]);
    expect(state.pendingConfirmations).toEqual([]);
  });

  it("never replays persisted tool parts or a confirmation token to the model", () => {
    const history = modelSafeHistory([{
      id: "assistant-preview",
      role: "assistant",
      parts: [
        { type: "text", text: "Please review this preview." },
        confirmationPart(),
      ] as UIMessage["parts"],
    }]);
    expect(history[0]?.parts).toEqual([
      { type: "text", text: "Please review this preview." },
    ]);
    expect(JSON.stringify(history)).not.toContain("server-only-confirm-token");
    expect(JSON.stringify(history)).not.toContain("tool-execute_action");
  });

  it("ignores a visually similar negative control that is not a real pending preview", () => {
    const state = persistedAssistantState([
      confirmationPart({ phase: "execute", confirmation_required: false }),
    ] as UIMessage["parts"]);
    expect(state.parts).toHaveLength(1);
    expect(state.pendingConfirmations).toEqual([]);
  });

  it("redacts credential-shaped tool input before any assistant part is persisted", () => {
    const state = persistedAssistantState([
      {
        type: "tool-execute_action",
        toolCallId: "staff-create",
        state: "output-available",
        input: {
          action: "staff.create",
          input: {
            email: "staff@example.com",
            temporary_password: "ModelMustNeverStoreThis1",
          },
        },
        output: {
          action_id: "staff.create",
          phase: "execute",
          confirmation_required: false,
          result: {
            data: {
              one_time_temporary_password: "ServerGeneratedMustNeverPersist2",
            },
          },
        },
      },
    ] as UIMessage["parts"]);

    expect(JSON.stringify(state.parts)).not.toContain(
      "ModelMustNeverStoreThis1",
    );
    expect(JSON.stringify(state.parts)).not.toContain(
      "ServerGeneratedMustNeverPersist2",
    );
    expect(JSON.stringify(state.parts)).toContain("[REDACTED]");
  });
});
