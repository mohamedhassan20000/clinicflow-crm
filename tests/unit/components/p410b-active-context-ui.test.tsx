import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  clearContext: vi.fn(),
  chooseContext: vi.fn(),
  refresh: vi.fn(),
  sendMessage: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}));
vi.mock("@ai-sdk/react", () => ({
  useChat: (options: { messages?: unknown[] }) => ({
    messages: options.messages ?? [],
    sendMessage: mocks.sendMessage,
    status: "ready",
    error: undefined,
    stop: vi.fn(),
    clearError: vi.fn(),
  }),
}));
vi.mock("@/actions/assistant-context", () => ({
  clearAssistantConversationContext: mocks.clearContext,
  chooseAssistantConversationContext: mocks.chooseContext,
}));

import {
  AssistantChat,
  buildAssistantChatRequestBody,
  contextChoicesForToolResult,
} from "@/components/assistant/assistant-chat";
import type { ActiveContext } from "@/lib/ai/conversation-context";

const CONVERSATION = "11111111-1111-4111-8111-111111111111";

function slot(
  entityType: keyof ActiveContext,
  entityId: string,
  displayLabel: string,
) {
  return {
    entity_type: entityType,
    entity_id: entityId,
    display_label: displayLabel,
    set_at: "2026-07-26T10:00:00.000Z",
    set_by: "resolution" as const,
  };
}

const activeContext: ActiveContext = {
  patient: slot(
    "patient",
    "22222222-2222-4222-8222-222222222222",
    "Mona Ali",
  ),
  appointment: slot(
    "appointment",
    "33333333-3333-4333-8333-333333333333",
    "Mona · 10:00",
  ),
  invoice: slot(
    "invoice",
    "44444444-4444-4444-8444-444444444444",
    "Mona · 250",
  ),
  staff: slot(
    "staff",
    "55555555-5555-4555-8555-555555555555",
    "Dr Ahmed",
  ),
  department: slot(
    "department",
    "66666666-6666-4666-8666-666666666666",
    "Cardiology",
  ),
  report: slot("report", "no_shows", "No-show report"),
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.clearContext.mockResolvedValue({
    success: true,
    activeContext: {
      ...activeContext,
      patient: undefined,
    },
  });
});

describe("P4.10B visible active-context controls", () => {
  it("renders a labelled chip and accessible clear control for every entity type", () => {
    render(
      <AssistantChat
        initialConversationId={CONVERSATION}
        initialMessages={[]}
        initialActiveContext={activeContext}
        remaining={25}
        role="admin"
      />,
    );

    for (const text of [
      "Patient: Mona Ali",
      "Appointment: Mona · 10:00",
      "Invoice: Mona · 250",
      "Staff: Dr Ahmed",
      "Department: Cardiology",
      "Report: No-show report",
    ]) {
      expect(screen.getByText(text)).toBeVisible();
    }
    for (const context of [
      "Patient",
      "Appointment",
      "Invoice",
      "Staff",
      "Department",
      "Report",
    ]) {
      expect(
        screen.getByRole("button", {
          name: `Clear active ${context} context`,
        }),
      ).toBeVisible();
    }
  });

  it("clears one exact slot without sending a display label or changing another slot", async () => {
    render(
      <AssistantChat
        initialConversationId={CONVERSATION}
        initialMessages={[]}
        initialActiveContext={activeContext}
        remaining={25}
        role="admin"
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Clear active Patient context",
      }),
    );

    await waitFor(() =>
      expect(mocks.clearContext).toHaveBeenCalledWith({
        conversationId: CONVERSATION,
        entityType: "patient",
      }),
    );
    await waitFor(() =>
      expect(screen.queryByText("Patient: Mona Ali")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("Report: No-show report")).toBeVisible();
    expect(mocks.refresh).toHaveBeenCalled();
  });

  it("keeps active-context labels out of every chat request payload", () => {
    const body = buildAssistantChatRequestBody({
      id: CONVERSATION,
      pageContext: null,
      message: {
        id: "message-1",
        role: "user",
        parts: [{ type: "text", text: "What about this one?" }],
      },
    });
    expect(body).not.toHaveProperty("activeContext");
    expect(JSON.stringify(body)).not.toContain("Mona Ali");
    expect(JSON.stringify(body)).not.toContain("No-show report");
  });
});

describe("P4.10B explicit clarification choices", () => {
  it("maps only structured candidates for supported entity fields", () => {
    expect(
      contextChoicesForToolResult(
        {
          needs_clarification: true,
          field: "doctor",
          candidates: [{ id: "doctor-1", name: "Dr Ahmed" }],
        },
        "list_appointments",
      ),
    ).toEqual([
      {
        entityType: "staff",
        entityId: "doctor-1",
        label: "Dr Ahmed",
      },
    ]);
    expect(
      contextChoicesForToolResult(
        {
          needs_clarification: true,
          field: "unknown",
          candidates: [{ id: "forged", name: "Forged" }],
        },
        "unknown_tool",
      ),
    ).toEqual([]);
  });
});
