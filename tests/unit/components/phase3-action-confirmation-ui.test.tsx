import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}));
vi.mock("@ai-sdk/react", () => ({
  useChat: (options: { messages?: unknown[] }) => ({
    messages: options.messages ?? [],
    sendMessage: vi.fn(),
    status: "ready",
    error: undefined,
    stop: vi.fn(),
    clearError: vi.fn(),
  }),
}));
vi.mock("@/actions/assistant-actions", () => ({
  confirmAssistantAction: mocks.confirm,
}));

import { AssistantChat } from "@/components/assistant/assistant-chat";

const CONVERSATION_ID = "00000000-0000-4000-8000-000000000010";
const INPUT = { label: "Phase 3 pipeline" };

function message() {
  return {
    id: "assistant-action-preview",
    role: "assistant" as const,
    parts: [
      {
        type: "tool-execute_action" as const,
        toolCallId: "tool-action",
        state: "output-available" as const,
        input: {
          action: "assistant.reference_check",
          input: INPUT,
        },
        output: {
          action_id: "assistant.reference_check",
          phase: "preview",
          risk_class: "normal",
          confirmation_required: true,
          confirm_token: "server-issued-confirmation-token-value-1234567890",
          expires_at: "2026-08-13T12:10:00.000Z",
          preview: {
            title: "Assistant action safety check",
            summary:
              "This confirms the Phase 3 action pipeline only. No clinic record will be changed.",
            changes: [
              {
                label: "Reference label",
                before: null,
                after: "Phase 3 pipeline",
              },
            ],
          },
        },
      },
    ],
  };
}

function privilegedMessage() {
  return {
    id: "assistant-privileged-preview",
    role: "assistant" as const,
    parts: [
      {
        type: "tool-execute_action" as const,
        toolCallId: "tool-privileged-action",
        state: "output-available" as const,
        input: {
          action: "staff.change_role",
          input: {
            staff_id: "00000000-0000-4000-8000-000000000011",
            role: "admin",
            department_id: null,
            supervising_doctor_ids: [],
          },
        },
        output: {
          action_id: "staff.change_role",
          phase: "preview",
          risk_class: "privileged",
          confirmation_required: true,
          step_up_required: true,
          confirm_token: "server-issued-privileged-token-value-1234567890",
          expires_at: "2026-08-13T12:02:00.000Z",
          preview: {
            title: "Change staff role",
            summary: "Review the exact staff role change.",
            changes: [
              {
                label: "Staff member",
                before: "Sara Ahmed (user 00000000-0000-4000-8000-000000000011)",
                after: "Sara Ahmed (user 00000000-0000-4000-8000-000000000011)",
                identifiesRecord: true,
              },
              { label: "Role", before: "receptionist", after: "admin" },
            ],
          },
        },
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.confirm.mockResolvedValue({
    ok: true,
    result: {
      action_id: "assistant.reference_check",
      phase: "execute",
      risk_class: "normal",
      confirmation_required: false,
      executed: true,
      result: {
        summary:
          "The assistant action safety check completed. No clinic record was changed.",
      },
    },
  });
});

describe("Phase 3 action confirmation UI", () => {
  it("renders the exact diff and executes only after the explicit button click", async () => {
    render(
      <AssistantChat
        initialConversationId={CONVERSATION_ID}
        initialMessages={[message()] as never}
        remaining={25}
        role="admin"
      />,
    );

    expect(screen.getByText("Reference label")).toBeVisible();
    expect(screen.getByText("Phase 3 pipeline")).toBeVisible();
    expect(mocks.confirm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Confirm and execute" }));
    await waitFor(() => {
      expect(mocks.confirm).toHaveBeenCalledWith({
        conversationId: CONVERSATION_ID,
        actionId: "assistant.reference_check",
        input: INPUT,
        confirmToken: "server-issued-confirmation-token-value-1234567890",
      });
      expect(screen.getByText("The confirmed action completed.")).toBeVisible();
    });
  });

  it("renders the privileged diff and requires credential step-up before submitting", async () => {
    mocks.confirm.mockResolvedValueOnce({
      ok: true,
      result: {
        action_id: "staff.change_role",
        phase: "execute",
        risk_class: "privileged",
        confirmation_required: false,
        executed: true,
        result: { summary: "Staff role changed." },
      },
    });
    render(
      <AssistantChat
        initialConversationId={CONVERSATION_ID}
        initialMessages={[privilegedMessage()] as never}
        remaining={25}
        role="admin"
      />,
    );

    expect(screen.getByText("Review this security change")).toBeVisible();
    expect(
      screen.getAllByText(
        "Sara Ahmed (user 00000000-0000-4000-8000-000000000011)",
      ),
    ).toHaveLength(2);
    expect(screen.getByText("receptionist")).toBeVisible();
    expect(screen.getByText("admin")).toBeVisible();
    const confirm = screen.getByRole("button", {
      name: "Re-authenticate and apply exact change",
    });
    expect(confirm).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Current password"), {
      target: { value: "CurrentPassword123" },
    });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);

    await waitFor(() => {
      expect(mocks.confirm).toHaveBeenCalledWith({
        conversationId: CONVERSATION_ID,
        actionId: "staff.change_role",
        input: privilegedMessage().parts[0].input.input,
        confirmToken: "server-issued-privileged-token-value-1234567890",
        currentPassword: "CurrentPassword123",
      });
      expect(screen.getByText("The confirmed action completed.")).toBeVisible();
    });
    expect(screen.queryByDisplayValue("CurrentPassword123")).not.toBeInTheDocument();
  });

  it.each([
    {
      reason: "confirmation_expired",
      copy: "This confirmation expired. Nothing was changed; ask the assistant for a new preview.",
    },
    {
      reason: "confirmation_replayed",
      copy: "This confirmation was already used. The action was not run again.",
    },
    {
      reason: "unauthorized_role",
      copy: "Your authorization changed or no longer allows this action. The action was not run.",
    },
  ])("renders the specific $reason state", async ({ reason, copy }) => {
    mocks.confirm.mockResolvedValueOnce({ ok: false, reason });
    render(
      <AssistantChat
        initialConversationId={CONVERSATION_ID}
        initialMessages={[message()] as never}
        remaining={25}
        role="admin"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Confirm and execute" }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(copy);
    });
  });
});
