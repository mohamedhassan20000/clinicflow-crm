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
vi.mock("@/actions/assistant-workflows", () => ({
  confirmAssistantWorkflow: mocks.confirm,
}));

import { AssistantChat } from "@/components/assistant/assistant-chat";

const RUN_ID = "00000000-0000-4000-8000-000000000099";
const PLAN = {
  version: 1 as const,
  steps: [
    {
      id: "send",
      tool: "send_appointment_reminders",
      input: {
        appointments: [
          { id: "00000000-0000-4000-8000-000000000020" },
        ],
      },
      depends_on: [],
    },
  ],
};

function message() {
  return {
    id: "assistant-workflow",
    role: "assistant" as const,
    parts: [
      {
        type: "tool-execute_read_only_workflow" as const,
        toolCallId: "tool-workflow",
        state: "output-available" as const,
        input: { plan: PLAN },
        output: {
          run_id: RUN_ID,
          mode: "dry_run",
          state: "previewed",
          partial_failure: false,
          requires_confirmation: true,
          steps: [
            {
              id: "send",
              tool: "send_appointment_reminders",
              status: "previewed",
              started_at: null,
              completed_at: "2026-07-26T10:00:00.000Z",
              duration_ms: 0,
              error_code: null,
              output: {
                action: "send_appointment_reminders",
                draft_status: "awaiting_confirmation",
                count: 1,
                items: [
                  {
                    patient_name: "Mona Ali",
                    scheduled_at: "2026-07-27T09:00:00.000Z",
                    scheduled_at_label: "Monday, July 27, 2026 · 12:00 PM",
                    channels: ["email"],
                  },
                ],
              },
            },
          ],
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
      run_id: RUN_ID,
      mode: "execute",
      state: "succeeded",
      partial_failure: false,
      steps: [],
    },
  });
});

describe("P4.11B workflow confirmation UI", () => {
  it("shows exact preview recipients and requires an explicit button activation", async () => {
    render(
      <AssistantChat
        initialConversationId="00000000-0000-4000-8000-000000000010"
        initialMessages={[message()] as never}
        remaining={25}
        role="admin"
      />,
    );

    expect(screen.getByText("Mona Ali", { exact: false })).toBeVisible();
    expect(
      screen.getByText("Monday, July 27, 2026 · 12:00 PM", { exact: false }),
    ).toBeVisible();
    expect(
      screen.queryByText("2026-07-27T09:00:00.000Z", { exact: false }),
    ).not.toBeInTheDocument();
    expect(mocks.confirm).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Confirm and run these actions" }),
    );
    await waitFor(() => {
      expect(mocks.confirm).toHaveBeenCalledWith({ runId: RUN_ID, plan: PLAN });
      expect(screen.getByText("The confirmed workflow completed.")).toBeVisible();
    });
  });

  it("states the no-auto-send guarantee next to the confirmation control", () => {
    render(
      <AssistantChat
        initialConversationId="00000000-0000-4000-8000-000000000010"
        initialMessages={[message()] as never}
        remaining={25}
        role="admin"
      />,
    );
    expect(
      screen.getByText(/will not auto-send, auto-confirm an appointment/),
    ).toBeVisible();
  });

  it.each([
    {
      reason: "preview_expired",
      message:
        "This preview expired after 15 minutes. Nothing was sent or created; ask the assistant for a new preview.",
    },
    {
      reason: "internal_error",
      message:
        "ClinicFlow could not complete the confirmation because of a temporary system problem. Try again; completed actions will not be repeated.",
    },
  ])("renders a specific $reason confirmation failure", async ({ reason, message: copy }) => {
    mocks.confirm.mockResolvedValueOnce({ ok: false, reason });
    render(
      <AssistantChat
        initialConversationId="00000000-0000-4000-8000-000000000010"
        initialMessages={[message()] as never}
        remaining={25}
        role="admin"
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Confirm and run these actions" }),
    );
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(copy);
    });
  });
});
