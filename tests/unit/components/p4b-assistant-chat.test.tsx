import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  stop: vi.fn(),
  clearError: vi.fn(),
  refresh: vi.fn(),
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
    stop: mocks.stop,
    clearError: mocks.clearError,
  }),
}));

import { AssistantChat } from "@/components/assistant/assistant-chat";
import { AssistantAccessGate } from "@/components/assistant/assistant-access-gate";

beforeEach(() => vi.clearAllMocks());

describe("P4B assistant UI", () => {
  it("offers patient-context prompts and submits the selected text", () => {
    render(
      <AssistantChat
        initialConversationId="00000000-0000-4000-8000-000000000010"
        initialMessages={[]}
        patient={{ id: "00000000-0000-4000-8000-000000000011", name: "Mona Ali" }}
        remaining={25}
        role="doctor"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Summarize this patient's clinical history" }));
    expect(screen.getByRole("textbox", { name: "Message the clinical assistant" })).toHaveValue(
      "Summarize this patient's clinical history",
    );
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(mocks.sendMessage).toHaveBeenCalledWith({ text: "Summarize this patient's clinical history" });
  });

  it("renders an explicit plan upgrade gate without a misleading chat input", () => {
    render(<AssistantAccessGate access={{ state: "upgrade" }} />);
    expect(screen.getByRole("heading", { name: "Assistant is not included in this plan" })).toBeVisible();
    expect(screen.getByText("Read-only — never changes medical records")).toBeVisible();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("discloses when older conversation history was trimmed", () => {
    render(
      <AssistantChat
        initialConversationId="00000000-0000-4000-8000-000000000010"
        initialMessages={[{
          id: "assistant-1",
          role: "assistant",
          parts: [{ type: "text", text: "Recent context" }],
        }]}
        remaining={25}
        historyTruncated
        role="doctor"
      />,
    );

    expect(screen.getByText(/Only the most recent 40 messages/)).toBeVisible();
    const liveRegions = document.querySelectorAll("[aria-live]");
    expect(liveRegions).toHaveLength(1);
    expect(liveRegions[0]).toHaveAttribute("role", "status");
  });

  it.each(["admin", "manager", "receptionist"] as const)(
    "renders the non-clinical persona for %s",
    (role) => {
      render(
        <AssistantChat
          initialConversationId="00000000-0000-4000-8000-000000000010"
          initialMessages={[]}
          remaining={25}
          role={role}
        />,
      );

      expect(screen.getByRole("heading", { name: "How can I help with clinic operations?" })).toBeVisible();
      expect(screen.getByRole("textbox", { name: "Message the clinic assistant" })).toBeVisible();
      // The disclosure that this persona is non-clinical survived P4.6B's
      // rewrite of the administrative empty state; only its wording changed,
      // because the persona now also covers analytics and reports.
      expect(screen.getByText(/Individual clinical records stay with doctors/)).toBeVisible();
      expect(screen.queryByText("Summarize this patient's clinical history")).not.toBeInTheDocument();
    },
  );
});
