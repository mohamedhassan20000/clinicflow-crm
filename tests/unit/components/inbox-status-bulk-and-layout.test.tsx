import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import messages from "@/messages/en.json";
import type { InboxData } from "@/lib/messaging/inbox";

/**
 * P18 — the Inbox pass: the status control, the bulk lifecycle action, the
 * wider recipient selection, and a header that fits on a laptop.
 *
 * Everything here is asserted through the Inbox a receptionist actually uses,
 * because three of the four defects were only visible once the pieces were
 * assembled: a status that persisted in the database and not in the list, a
 * recipient set that silently excluded most of the clinic, and a header whose
 * controls overlapped the name they belonged to.
 */

const mocks = vi.hoisted(() => ({
  channel: {
    on() {
      return this;
    },
    subscribe(callback?: (status: string) => void) {
      callback?.("SUBSCRIBED");
      return this;
    },
  },
  removeChannel: vi.fn(),
  refresh: vi.fn(),
  updateConversationStatus: vi.fn(),
  countOpenConversations: vi.fn(),
  closeOpenConversations: vi.fn(),
  createBulkSend: vi.fn(),
  runBulkSend: vi.fn(),
  readBulkSendJob: vi.fn(),
  toastSuccess: vi.fn(),
  toastWarning: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh, push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/actions/messaging", () => ({
  approveAiSuggestion: vi.fn(),
  dismissAiSuggestion: vi.fn(),
  linkConversationPatient: vi.fn(),
  sendInboxReply: vi.fn(),
  setConversationAiEnabled: vi.fn(),
  setConversationHumanTakeover: vi.fn(),
  updateConversationAssignment: vi.fn(),
  updateConversationStatus: mocks.updateConversationStatus,
  clearConversationEscalation: vi.fn(),
  countOpenConversations: mocks.countOpenConversations,
  closeOpenConversations: mocks.closeOpenConversations,
  openNewWhatsAppConversation: vi.fn(),
  refreshInboxContacts: vi.fn(),
  setPatientAiReplyMode: vi.fn(),
}));
vi.mock("@/actions/bulk-messaging", () => ({
  createBulkSend: mocks.createBulkSend,
  runBulkSend: mocks.runBulkSend,
  readBulkSendJob: mocks.readBulkSendJob,
  resolveInterruptedBulkRecipient: vi.fn(),
}));
vi.mock("sonner", () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
    warning: mocks.toastWarning,
  },
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

type Conversation = InboxData["conversations"][number];

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: "conversation-1",
    channel: "whatsapp",
    status: "open",
    patientId: "patient-1",
    patientName: "Fatima Ahmed",
    patientPhone: "+201000000001",
    patientFileNumber: "F-001",
    displayName: "Fatima",
    sender: "+201000000001",
    assignedTo: null,
    assignedName: null,
    lastMessageAt: "2026-09-01T09:00:00.000Z",
    lastInboundAt: "2026-09-01T09:00:00.000Z",
    windowExpiresAt: "2026-09-02T09:00:00.000Z",
    identityVerifiedAt: null,
    escalatedAt: null,
    escalationReason: null,
    hasDeliveryFailure: false,
    hasActiveEpisode: false,
    hasOutstandingReview: false,
    aiPausedAt: null,
    aiPausedByName: null,
    aiEnabled: false,
    aiEnabledOverride: null,
    // No episode was ever opened on this clinic — the assistant is off — so no
    // boundary was ever drawn. This is the production shape that made every
    // thread read "Done".
    contextResetAt: null,
    statusUpdatedAt: "2026-09-01T08:00:00.000Z",
    lastAssistantReplyAt: null,
    lastHumanReplyAt: null,
    preview: "Hello",
    unreadCount: 0,
    ...overrides,
  } as Conversation;
}

function baseData(overrides: Partial<InboxData> = {}): InboxData {
  return {
    conversations: [conversation()],
    messages: [],
    assignees: [{ id: "receptionist-1", name: "Reception User" }],
    patients: [],
    templates: [],
    contacts: [],
    contactDirectory: undefined,
    documents: [],
    whatsappProvider: "linked_device",
    clinicAi: { mode: "off", overrideCount: 0 },
    search: "",
    suggestion: null,
    selectedConversationId: "conversation-1",
    loadedAt: "2026-09-01T09:01:00.000Z",
    error: false,
    messagesTruncated: false,
    degraded: false,
    ...overrides,
  } as InboxData;
}

function renderInbox(data: InboxData = baseData(), role: "admin" | "receptionist" = "admin") {
  return render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <InboxShell data={data} clinicId="clinic-1" viewerId="user-1" viewerRole={role} />
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  try {
    sessionStorage.clear();
  } catch {
    // jsdom always has it; a browser that refuses is handled in the component.
  }
  mocks.updateConversationStatus.mockResolvedValue({ success: true });
  mocks.countOpenConversations.mockResolvedValue({ total: 4 });
  mocks.closeOpenConversations.mockResolvedValue({ total: 4, closed: 4, failed: 0 });
  mocks.createBulkSend.mockResolvedValue({ success: true, jobId: "job-1" });
  mocks.runBulkSend.mockResolvedValue({ success: true });
  mocks.readBulkSendJob.mockResolvedValue({
    job: { id: "job-1", status: "completed", totalRecipients: 1, recipients: [] },
  });
});

// ---------------------------------------------------------------------------
// 1. The status control
// ---------------------------------------------------------------------------

describe("changing a conversation's status", () => {
  it("fires the mutation with the opposite of the stored status", async () => {
    const user = userEvent.setup();
    renderInbox();
    await user.click(screen.getByRole("button", { name: messages.inbox.close }));
    expect(mocks.updateConversationStatus).toHaveBeenCalledWith({
      conversationId: "conversation-1",
      status: "closed",
    });
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
  });

  it("offers Reopen once the stored status is closed", () => {
    renderInbox(baseData({ conversations: [conversation({ status: "closed" })] }));
    const actions = screen.getByTestId("conversation-actions");
    expect(within(actions).getByRole("button", { name: messages.inbox.reopen })).toBeTruthy();
  });

  it("shows the persisted status in the list rather than a derived Done", () => {
    // The whole defect: an open thread on a clinic whose assistant never runs.
    // Before the fix this row read "Done" and no amount of reopening changed it.
    renderInbox();
    const badges = screen.getAllByTestId("conversation-status-badge");
    expect(badges[0]!.textContent).toBe(messages.inbox.statusBadge.waitingPatient);
    expect(badges[0]!.textContent).not.toBe(messages.inbox.statusBadge.done);
  });

  it("reads Done once, and only once, the row is actually closed", () => {
    renderInbox(
      baseData({
        conversations: [
          conversation({
            status: "closed",
            statusUpdatedAt: "2026-09-01T09:30:00.000Z",
            contextResetAt: "2026-09-01T09:30:00.000Z",
          }),
        ],
      }),
    );
    expect(screen.getAllByTestId("conversation-status-badge")[0]!.textContent).toBe(
      messages.inbox.statusBadge.done,
    );
  });

  it("filters on the persisted status, so a reopened thread leaves Done", async () => {
    const user = userEvent.setup();
    renderInbox(
      baseData({
        conversations: [
          conversation({ id: "conversation-1" }),
          conversation({
            id: "conversation-2",
            patientName: "Omar Khaled",
            sender: "+201000000002",
            status: "closed",
            statusUpdatedAt: "2026-09-01T09:30:00.000Z",
            contextResetAt: "2026-09-01T09:30:00.000Z",
          }),
        ],
      }),
    );
    await user.click(screen.getByLabelText(messages.inbox.statusFilter.label));
    // The listbox option, not the badge of the same word already in the list.
    await user.click(
      await screen.findByRole("option", { name: messages.inbox.statusBadge.done }),
    );

    const list = screen.getByTestId("conversation-list-scroll");
    expect(within(list).queryByText("Fatima Ahmed")).toBeNull();
    expect(within(list).getByText("Omar Khaled")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 2. Bulk close
// ---------------------------------------------------------------------------

describe("closing all open conversations", () => {
  it("is offered to an admin and withheld from a receptionist", () => {
    renderInbox(baseData(), "receptionist");
    expect(screen.queryByTestId("bulk-close-trigger")).toBeNull();
  });

  it("never closes anything without a confirmation", async () => {
    const user = userEvent.setup();
    renderInbox();
    await user.click(screen.getByTestId("bulk-close-trigger"));
    await screen.findByTestId("bulk-close-confirm");
    expect(mocks.closeOpenConversations).not.toHaveBeenCalled();
  });

  it("states how many conversations will be affected, from the server", async () => {
    const user = userEvent.setup();
    renderInbox();
    await user.click(screen.getByTestId("bulk-close-trigger"));
    await waitFor(() => expect(mocks.countOpenConversations).toHaveBeenCalled());
    expect((await screen.findByTestId("bulk-close-count")).textContent).toContain("4");
    expect(screen.getByTestId("bulk-close-confirm").textContent).toContain("4");
  });

  it("offers nothing to confirm when nothing is open", async () => {
    const user = userEvent.setup();
    mocks.countOpenConversations.mockResolvedValue({ total: 0 });
    renderInbox();
    await user.click(screen.getByTestId("bulk-close-trigger"));
    await waitFor(() =>
      expect(screen.getByTestId("bulk-close-confirm")).toBeDisabled(),
    );
  });

  it("closes and refreshes the list once confirmed", async () => {
    const user = userEvent.setup();
    renderInbox();
    await user.click(screen.getByTestId("bulk-close-trigger"));
    await user.click(await screen.findByTestId("bulk-close-confirm"));
    await waitFor(() => expect(mocks.closeOpenConversations).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
    expect(mocks.toastSuccess).toHaveBeenCalled();
  });

  it("does not claim success when the run did not get through the set", async () => {
    // No row was rejected, but a read failed part-way and rows are still open.
    // Saying "all closed" here would be the same lie by another route.
    const user = userEvent.setup();
    mocks.closeOpenConversations.mockResolvedValue({ total: 400, closed: 100, failed: 0 });
    renderInbox();
    await user.click(screen.getByTestId("bulk-close-trigger"));
    await user.click(await screen.findByTestId("bulk-close-confirm"));
    await waitFor(() => expect(mocks.toastWarning).toHaveBeenCalled());
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(String(mocks.toastWarning.mock.calls[0]![0])).toContain("300");
  });

  it("states a count well past one page, exactly as the server reports it", async () => {
    const user = userEvent.setup();
    mocks.countOpenConversations.mockResolvedValue({ total: 450 });
    renderInbox();
    await user.click(screen.getByTestId("bulk-close-trigger"));
    expect((await screen.findByTestId("bulk-close-count")).textContent).toContain("450");
    expect(screen.getByTestId("bulk-close-confirm").textContent).toContain("450");
  });

  it("reports a partial result as a partial result, never as a success", async () => {
    const user = userEvent.setup();
    mocks.closeOpenConversations.mockResolvedValue({ total: 4, closed: 3, failed: 1 });
    renderInbox();
    await user.click(screen.getByTestId("bulk-close-trigger"));
    await user.click(await screen.findByTestId("bulk-close-confirm"));
    await waitFor(() => expect(mocks.toastWarning).toHaveBeenCalled());
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3. Bulk send recipients
// ---------------------------------------------------------------------------

function dataWithDirectory() {
  return baseData({
    conversations: [
      conversation({ id: "conversation-1", sender: "+201000000001" }),
    ],
    contacts: [
      {
        id: "contact-1",
        displayName: "Omar Khaled",
        participantAddress: "+201000000002",
        patientId: null,
        patientName: null,
        patientFileNumber: null,
      },
      // The same number as the open conversation above, from the other list.
      {
        id: "contact-dup",
        displayName: "Fatima (WhatsApp)",
        participantAddress: "+20 100 000 0001",
        patientId: null,
        patientName: null,
        patientFileNumber: null,
      },
    ],
    patients: [
      { id: "patient-2", name: "Mona Sayed", phone: "+201000000003", fileNumber: "F-003" },
      // No phone: cannot be written to, so it is not offered.
      { id: "patient-3", name: "Nour Adel", phone: "", fileNumber: "F-004" },
    ],
  });
}

async function openBulkSend(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByTestId("bulk-start-selecting"));
  // One row ticked in the list, which is what seeds the picker's selection.
  await user.click(screen.getAllByTestId("bulk-selectable-row")[0]!);
  await user.click(screen.getByTestId("bulk-compose"));
  return screen.findByTestId("bulk-recipient-picker");
}

describe("choosing bulk-send recipients", () => {
  it("offers conversations, contacts and patient files together", async () => {
    const user = userEvent.setup();
    renderInbox(dataWithDirectory());
    await openBulkSend(user);
    const rows = screen.getAllByTestId("bulk-recipient-row");
    expect(rows.map((row) => row.getAttribute("data-source")).sort()).toEqual([
      "contact",
      "conversation",
      "patient",
    ]);
  });

  it("deduplicates a number that appears in both a conversation and a contact", async () => {
    const user = userEvent.setup();
    renderInbox(dataWithDirectory());
    await openBulkSend(user);
    const rows = screen.getAllByTestId("bulk-recipient-row");
    expect(rows.filter((row) => row.textContent?.includes("201000000001"))).toHaveLength(1);
  });

  it("excludes a patient file with no usable number", async () => {
    const user = userEvent.setup();
    renderInbox(dataWithDirectory());
    await openBulkSend(user);
    expect(screen.queryByText("Nour Adel")).toBeNull();
  });

  it("searches by name and by phone", async () => {
    const user = userEvent.setup();
    renderInbox(dataWithDirectory());
    await openBulkSend(user);
    const search = screen.getByTestId("bulk-recipient-search");

    await user.type(search, "mona");
    expect(screen.getAllByTestId("bulk-recipient-row")).toHaveLength(1);

    await user.clear(search);
    await user.type(search, "+20 100 000 0002");
    const matched = screen.getAllByTestId("bulk-recipient-row");
    expect(matched).toHaveLength(1);
    expect(matched[0]!.textContent).toContain("Omar Khaled");
  });

  it("counts the selection, and clears it", async () => {
    const user = userEvent.setup();
    renderInbox(dataWithDirectory());
    await openBulkSend(user);
    // The conversation the staff member ticked in the list seeds the picker.
    expect(screen.getByTestId("bulk-recipient-count").textContent).toContain("1");

    await user.click(screen.getByTestId("bulk-select-visible"));
    expect(screen.getByTestId("bulk-recipient-count").textContent).toContain("3");

    await user.click(screen.getByTestId("bulk-clear-selection"));
    expect(screen.getByTestId("bulk-recipient-count").textContent).toContain(
      "No recipients selected",
    );
  });

  it("sends threads as ids and contacts as addresses, in one job", async () => {
    const user = userEvent.setup();
    renderInbox(dataWithDirectory());
    await openBulkSend(user);
    await user.click(screen.getByTestId("bulk-select-visible"));
    await user.type(screen.getByTestId("bulk-body"), "The clinic is closed tomorrow.");
    await user.click(screen.getByTestId("bulk-continue"));
    await user.click(screen.getByTestId("bulk-confirm"));

    await waitFor(() => expect(mocks.createBulkSend).toHaveBeenCalledTimes(1));
    expect(mocks.createBulkSend).toHaveBeenCalledWith({
      body: "The clinic is closed tomorrow.",
      conversationIds: ["conversation-1"],
      addresses: ["+201000000002", "+201000000003"],
    });
  });
});

// ---------------------------------------------------------------------------
// 4. The responsive header and the collapsible list
// ---------------------------------------------------------------------------

describe("the laptop layout", () => {
  it("hides the conversation list on request and gives the width to the thread", async () => {
    const user = userEvent.setup();
    const { container } = renderInbox();
    expect(screen.getByTestId("conversation-list-scroll")).toBeTruthy();

    await user.click(screen.getByTestId("conversation-list-toggle"));

    expect(screen.queryByTestId("conversation-list-scroll")).toBeNull();
    const grid = container.querySelector("[data-list-collapsed]");
    expect(grid?.getAttribute("data-list-collapsed")).toBe("true");
    expect(grid?.className).toContain("lg:grid-cols-[minmax(0,1fr)]");
  });

  it("brings the list back", async () => {
    const user = userEvent.setup();
    renderInbox();
    await user.click(screen.getByTestId("conversation-list-toggle"));
    await user.click(screen.getByTestId("conversation-list-toggle"));
    expect(screen.getByTestId("conversation-list-scroll")).toBeTruthy();
  });

  it("remembers the choice for the session", async () => {
    const user = userEvent.setup();
    const first = renderInbox();
    await user.click(screen.getByTestId("conversation-list-toggle"));
    first.unmount();

    renderInbox();
    await waitFor(() =>
      expect(screen.queryByTestId("conversation-list-scroll")).toBeNull(),
    );
  });

  it("keeps the primary controls on the bar at every width", () => {
    renderInbox();
    const actions = screen.getByTestId("conversation-actions");
    expect(within(actions).getByRole("button", { name: messages.inbox.close })).toBeTruthy();
    expect(within(actions).getByText(messages.inbox.ai.pauseAi)).toBeTruthy();
    expect(within(actions).getByLabelText(messages.inbox.assignConversation)).toBeTruthy();
  });

  it("puts the secondary controls in the overflow menu, and only there", async () => {
    const user = userEvent.setup();
    renderInbox();
    // Closed, they are not a second copy of anything hidden by a media query.
    expect(screen.queryByText(messages.inbox.changePatient)).toBeNull();
    expect(screen.queryByTestId("past-appointments-trigger")).toBeNull();

    await user.click(screen.getByTestId("conversation-more-actions"));
    expect(await screen.findByText(messages.inbox.changePatient)).toBeTruthy();
    expect(screen.getByTestId("past-appointments-trigger")).toBeTruthy();
  });

  it("renders each action exactly once, so nothing is duplicated on a narrow header", async () => {
    const user = userEvent.setup();
    renderInbox();
    await user.click(screen.getByTestId("conversation-more-actions"));
    await screen.findByTestId("past-appointments-trigger");
    expect(screen.getAllByTestId("past-appointments-trigger")).toHaveLength(1);
    expect(screen.getAllByText(messages.inbox.changePatient)).toHaveLength(1);
    // Queried by text rather than by role: an open Radix menu marks the rest of
    // the page `aria-hidden`, which is exactly the behaviour that keeps a
    // duplicated control from being reachable twice.
    expect(screen.getAllByText(messages.inbox.close)).toHaveLength(1);
  });

  it("bounds the identity block so it cannot grow into the actions", () => {
    renderInbox(
      baseData({
        conversations: [
          conversation({
            patientName:
              "A very long patient name that would otherwise push the header controls off the row",
          }),
        ],
      }),
    );
    const identity = screen.getByTestId("conversation-identity");
    expect(identity.className).toContain("min-w-0");
    expect(identity.className).toContain("xl:max-w-md");
    expect(identity.querySelector("h2")?.className).toContain("truncate");
  });
});
