import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InboxData } from "@/lib/messaging/inbox";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  removeChannel: vi.fn(),
  approveAiSuggestion: vi.fn(),
  dismissAiSuggestion: vi.fn(),
  clearConversationEscalation: vi.fn(),
  channel: null as unknown as { on: ReturnType<typeof vi.fn>; subscribe: ReturnType<typeof vi.fn> },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh, replace: vi.fn() }),
}));
vi.mock("@/actions/messaging", () => ({
  linkConversationPatient: vi.fn(),
  sendInboxReply: vi.fn(),
  updateConversationAssignment: vi.fn(),
  updateConversationStatus: vi.fn(),
  approveAiSuggestion: mocks.approveAiSuggestion,
  dismissAiSuggestion: mocks.dismissAiSuggestion,
  clearConversationEscalation: mocks.clearConversationEscalation,
}));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: { getSession: async () => ({ data: { session: null } }) },
    channel: () => mocks.channel,
    removeChannel: mocks.removeChannel,
    realtime: { setAuth: vi.fn() },
  }),
}));

import { InboxShell } from "@/components/inbox/inbox-shell";

function baseData(overrides: Partial<InboxData> = {}): InboxData {
  return {
    conversations: [
      {
        id: "conversation-1",
        channel: "whatsapp",
        status: "open",
        patientId: "patient-1",
        patientName: "Mona Ali",
        patientPhone: "+96550000000",
        patientFileNumber: "CF-0001",
        sender: "+96550000000",
        assignedTo: null,
        assignedName: null,
        lastMessageAt: "2026-07-28T09:00:00.000Z",
        lastInboundAt: "2026-07-28T09:00:00.000Z",
        windowExpiresAt: "2026-07-28T20:00:00.000Z",
        identityVerifiedAt: "2026-07-28T08:00:00.000Z",
        escalatedAt: null,
        escalationReason: null,
        preview: "Can I book?",
        unreadCount: 0,
      },
    ],
    messages: [],
    assignees: [],
    patients: [],
    templates: [],
    suggestion: null,
    selectedConversationId: "conversation-1",
    loadedAt: "2026-07-28T09:05:00.000Z",
    error: false,
    ...overrides,
  };
}

beforeEach(() => {
  const channel = { on: vi.fn(), subscribe: vi.fn() };
  channel.on.mockReturnValue(channel);
  channel.subscribe.mockReturnValue(channel);
  mocks.channel = channel;
  localStorage.clear();
  vi.clearAllMocks();
  mocks.approveAiSuggestion.mockResolvedValue({ success: true });
  mocks.dismissAiSuggestion.mockResolvedValue({ success: true });
  mocks.clearConversationEscalation.mockResolvedValue({ success: true });
});

describe("P5B inbox suggestion card", () => {
  it("renders a pending AI suggestion and approves it through the action", async () => {
    render(
      <InboxShell
        data={baseData({
          suggestion: {
            id: "sugg-1",
            conversationId: "conversation-1",
            body: "We are open 9am to 5pm.",
            escalate: false,
            escalationReason: null,
            createdAt: "2026-07-28T09:01:00.000Z",
          },
        })}
        clinicId="clinic-1"
        viewerId="viewer-1"
      />,
    );
    expect(screen.getByTestId("ai-suggestion")).toBeInTheDocument();
    expect(screen.getByText("We are open 9am to 5pm.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Approve & send/i }));
    await waitFor(() =>
      expect(mocks.approveAiSuggestion).toHaveBeenCalledWith({
        suggestionId: "sugg-1",
        body: undefined,
      }),
    );
  });

  it("shows the escalation banner and returns the conversation to the AI", async () => {
    render(
      <InboxShell
        data={baseData({
          conversations: [
            {
              ...baseData().conversations[0],
              escalatedAt: "2026-07-28T09:02:00.000Z",
              escalationReason: "emergency",
            },
          ],
        })}
        clinicId="clinic-1"
        viewerId="viewer-1"
      />,
    );
    expect(screen.getByText(/Handed to a human/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Return to AI/i }));
    await waitFor(() =>
      expect(mocks.clearConversationEscalation).toHaveBeenCalledWith({
        conversationId: "conversation-1",
      }),
    );
  });

  it("does not render a suggestion belonging to another conversation", () => {
    render(
      <InboxShell
        data={baseData({
          suggestion: {
            id: "sugg-2",
            conversationId: "other-conversation",
            body: "stale",
            escalate: false,
            escalationReason: null,
            createdAt: "2026-07-28T09:01:00.000Z",
          },
        })}
        clinicId="clinic-1"
        viewerId="viewer-1"
      />,
    );
    expect(screen.queryByTestId("ai-suggestion")).not.toBeInTheDocument();
  });
});
