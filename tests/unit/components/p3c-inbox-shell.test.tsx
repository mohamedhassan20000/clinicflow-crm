import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InboxData } from "@/lib/messaging/inbox";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  replace: vi.fn(),
  removeChannel: vi.fn(),
  channel: null as unknown as {
    on: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh, replace: mocks.replace }),
}));
vi.mock("@/actions/messaging", () => ({
  linkConversationPatient: vi.fn(),
  sendInboxReply: vi.fn(),
  updateConversationAssignment: vi.fn(),
  updateConversationStatus: vi.fn(),
  approveAiSuggestion: vi.fn(),
  dismissAiSuggestion: vi.fn(),
  clearConversationEscalation: vi.fn(),
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

const baseData: InboxData = {
  conversations: [{
    id: "conversation-1",
    channel: "whatsapp",
    status: "open",
    patientId: "patient-1",
    patientName: "Mona Ali",
    patientPhone: "+96550000000",
    patientFileNumber: "CF-0001",
    displayName: null,
    aiPausedAt: null,
    aiPausedByName: null,
    sender: "+96550000000",
    assignedTo: null,
    assignedName: null,
    lastMessageAt: "2026-07-17T09:00:00.000Z",
    lastInboundAt: "2026-07-17T09:00:00.000Z",
    windowExpiresAt: "2026-07-17T09:30:00.000Z",
    identityVerifiedAt: "2026-07-17T08:00:00.000Z",
    escalatedAt: null,
    escalationReason: null,
    preview: "Can I confirm my appointment?",
    unreadCount: 1,
  }],
  messages: [{
    id: "inbound-1",
    direction: "inbound",
    body: "Can I confirm my appointment?",
    occurredAt: "2026-07-17T09:00:00.000Z",
    status: null,
    templateId: null,
    attachments: [],
  }],
  assignees: [{ id: "receptionist-1", name: "Reception User" }],
  patients: [{ id: "patient-1", name: "Mona Ali", phone: "+96550000000", fileNumber: "CF-0001" }],
  templates: [{
    id: "template-1",
    name: "follow_up",
    language: "en",
    body: "Hello {{1}}",
    variableNames: ["name"],
    approvalStatus: "approved",
  }],
  contacts: [],
  documents: [],
  whatsappProvider: "meta",
  search: "",
  suggestion: null,
  selectedConversationId: "conversation-1",
  loadedAt: "2026-07-17T10:00:00.000Z",
  error: false,
  messagesTruncated: false,
  degraded: false,
};

beforeEach(() => {
  const channel = {
    on: vi.fn(),
    subscribe: vi.fn(),
  };
  channel.on.mockReturnValue(channel);
  channel.subscribe.mockReturnValue(channel);
  mocks.channel = channel;
  localStorage.clear();
  vi.clearAllMocks();
});

describe("P3C inbox shell", () => {
  it("shows verified identity and requires an approved template outside the service window", () => {
    render(<InboxShell data={baseData} clinicId="clinic-1" viewerId="viewer-1" />);
    expect(screen.getByRole("heading", { level: 1, name: "Inbox" })).toBeInTheDocument();
    expect(screen.getByText("Verified")).toBeInTheDocument();
    expect(screen.getByText("The 24-hour service window is closed")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Choose an approved template" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Reply message" })).not.toBeInTheDocument();
  });

  it("shows the freeform reply composer while the service window is open", () => {
    render(<InboxShell
      data={{
        ...baseData,
        conversations: [{
          ...baseData.conversations[0],
          windowExpiresAt: "2026-07-17T10:30:00.000Z",
          identityVerifiedAt: null,
        }],
      }}
      clinicId="clinic-1"
      viewerId="viewer-1"
    />);
    expect(screen.getByText("Not verified")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Reply message" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send reply" })).toBeDisabled();
  });
});
