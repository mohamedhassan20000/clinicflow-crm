/**
 * P12 — selecting a conversation must not throw the reader back to the top of
 * the list.
 *
 * ### The root cause these tests pin down
 *
 * `app/(protected)/inbox/page.tsx` rendered `<InboxShell key={selectedConversationId}>`.
 * Selecting a name navigates to `/inbox?conversation=<id>`, the key changed,
 * and React unmounted the entire Inbox and mounted a new one. Scroll position
 * is a property of a DOM node, and the node was gone — so the further down
 * someone had scrolled to find a thread, the more work opening it undid.
 *
 * The fix is structural, not a scroll-restoring timeout: the remount boundary
 * moved off the whole shell and onto the thread `<section>`, which is the part
 * that is actually about one conversation. So the assertion that matters below
 * is **node identity** — the list's scroll container is the same element before
 * and after a selection — because that is the thing the browser's scroll
 * position hangs off, and nothing in this file has to simulate scrolling for it
 * to be true.
 */

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import messages from "@/messages/en.json";
import type { InboxConversation, InboxData, InboxThreadMessage } from "@/lib/messaging/inbox";

const mocks = vi.hoisted(() => ({
  channel: {
    on() {
      return this;
    },
    subscribe(callback: (status: string) => void) {
      callback("SUBSCRIBED");
      return this;
    },
  },
  removeChannel: vi.fn(),
  refresh: vi.fn(),
  push: vi.fn(),
  replace: vi.fn(),
  listConversationPatientAppointments: vi.fn(),
  searchParams: new URLSearchParams(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh, push: mocks.push, replace: mocks.replace }),
  useSearchParams: () => mocks.searchParams,
}));
vi.mock("@/actions/messaging", () => ({
  approveAiSuggestion: vi.fn(),
  dismissAiSuggestion: vi.fn(),
  linkConversationPatient: vi.fn(),
  sendInboxReply: vi.fn(),
  setConversationHumanTakeover: vi.fn(),
  updateConversationAssignment: vi.fn(),
  updateConversationStatus: vi.fn(),
  clearConversationEscalation: vi.fn(),
  prepareConversationMedia: vi.fn(),
  sendConversationDocument: vi.fn(),
  discardConversationMedia: vi.fn(),
}));
vi.mock("@/actions/inbox-patient-appointments", () => ({
  listConversationPatientAppointments: mocks.listConversationPatientAppointments,
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

function conversation(
  id: string,
  overrides: Partial<InboxConversation> = {},
): InboxConversation {
  return {
    id,
    channel: "whatsapp",
    status: "open",
    patientId: `patient-${id}`,
    patientName: `Patient ${id}`,
    patientPhone: "+201111111111",
    patientFileNumber: "F-001",
    displayName: null,
    sender: "+201111111111",
    assignedTo: null,
    assignedName: null,
    lastMessageAt: "2026-08-17T09:00:00.000Z",
    lastInboundAt: "2026-08-17T09:00:00.000Z",
    windowExpiresAt: "2026-08-18T09:00:00.000Z",
    identityVerifiedAt: null,
    escalatedAt: null,
    escalationReason: null,
    hasActiveEpisode: true,
    aiPausedAt: null,
    aiPausedByName: null,
    preview: `preview ${id}`,
    unreadCount: 0,
    ...overrides,
  } as InboxConversation;
}

function message(id: string, body: string): InboxThreadMessage {
  return {
    id,
    direction: "inbound",
    body,
    occurredAt: "2026-08-17T09:00:00.000Z",
    status: null,
    templateId: null,
    attachments: [],
  } as InboxThreadMessage;
}

/** Twenty threads, which is what makes the list a scrolling list at all. */
const CONVERSATIONS = Array.from({ length: 20 }, (_, index) =>
  conversation(`conversation-${index + 1}`),
);

function inboxData(selectedId: string, overrides: Partial<InboxData> = {}): InboxData {
  return {
    conversations: CONVERSATIONS,
    messages: [message(`message-for-${selectedId}`, `body of ${selectedId}`)],
    assignees: [],
    patients: [],
    templates: [],
    contacts: [],
    documents: [],
    whatsappProvider: "linked_device",
    search: "",
    suggestion: null,
    selectedConversationId: selectedId,
    loadedAt: "2026-08-17T09:01:00.000Z",
    error: false,
    messagesTruncated: false,
    degraded: false,
    ...overrides,
  };
}

function renderInbox(data: InboxData) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <InboxShell data={data} clinicId="clinic-1" viewerId="receptionist-1" />
    </NextIntlClientProvider>,
  );
}

function rerenderInbox(
  rerender: ReturnType<typeof renderInbox>["rerender"],
  data: InboxData,
) {
  rerender(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <InboxShell data={data} clinicId="clinic-1" viewerId="receptionist-1" />
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listConversationPatientAppointments.mockResolvedValue({
    patient: {
      id: "patient-conversation-1",
      fullName: "Patient conversation-1",
      phone: "+201111111111",
      fileNumber: "F-001",
      nationalId: null,
      departmentId: null,
    },
    appointments: [],
  });
});

describe("P12 · the conversation list keeps its place when a thread is opened", () => {
  it("filters by the derived status and clearing restores the original order", async () => {
    const user = userEvent.setup();
    const conversations = [
      conversation("ai"),
      conversation("new", {
        patientId: null,
        patientName: null,
        displayName: "New Sender",
      }),
      conversation("done", { status: "closed", hasActiveEpisode: false }),
    ];
    renderInbox(inboxData("ai", { conversations }));

    await user.click(screen.getByRole("combobox", { name: "Filter by status" }));
    await user.click(screen.getByRole("option", { name: "New contact" }));

    const list = screen.getByTestId("conversation-list-scroll");
    expect(within(list).getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual([
      "/inbox?conversation=new",
    ]);

    // Text search and status filtering compose; neither replaces the other.
    await user.type(screen.getByRole("textbox", { name: "Search conversations" }), "no match");
    expect(within(list).queryAllByRole("link")).toHaveLength(0);
    await user.clear(screen.getByRole("textbox", { name: "Search conversations" }));
    expect(within(list).getAllByRole("link")).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Clear filter" }));
    expect(within(list).getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual([
      "/inbox?conversation=ai",
      "/inbox?conversation=new",
      "/inbox?conversation=done",
    ]);
  });

  it("keeps the very same scroll container across a selection", () => {
    const { rerender } = renderInbox(inboxData("conversation-1"));
    const before = screen.getByTestId("conversation-list-scroll");

    // Exactly what the router does when a name is clicked: the same page, with
    // a different conversation selected.
    rerenderInbox(rerender, inboxData("conversation-7"));

    const after = screen.getByTestId("conversation-list-scroll");
    // Identity, not equality. A new node is a node whose scrollTop is 0, which
    // is the bug this file exists for.
    expect(after).toBe(before);
  });

  it("leaves a non-zero scroll position exactly where the reader left it", () => {
    const { rerender } = renderInbox(inboxData("conversation-1"));
    const pane = screen.getByTestId("conversation-list-scroll");
    // jsdom lays nothing out, so the scroll offset is simulated. It survives a
    // re-render only if the node does.
    Object.defineProperty(pane, "scrollTop", {
      value: 640,
      writable: true,
      configurable: true,
    });

    rerenderInbox(rerender, inboxData("conversation-7"));

    expect(screen.getByTestId("conversation-list-scroll").scrollTop).toBe(640);
  });

  it("changes the thread to the conversation that was selected", () => {
    const { rerender } = renderInbox(inboxData("conversation-1"));
    expect(screen.getByText("body of conversation-1")).toBeTruthy();

    rerenderInbox(rerender, inboxData("conversation-7"));

    expect(screen.queryByText("body of conversation-1")).toBeNull();
    expect(screen.getByText("body of conversation-7")).toBeTruthy();
    // And the header follows it, so the pane that should change did.
    expect(
      within(screen.getByRole("heading", { level: 2 })).queryByText(
        /Patient conversation-7/,
      ),
    ).toBeTruthy();
  });

  it("never scrolls a row into view, whether or not it is on screen", () => {
    const scrolled = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrolled;
    try {
      const { rerender } = renderInbox(inboxData("conversation-1"));
      rerenderInbox(rerender, inboxData("conversation-18"));
      expect(scrolled).not.toHaveBeenCalled();
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it("keeps every row in the list, so pagination and filtering are untouched", () => {
    const { rerender } = renderInbox(inboxData("conversation-1"));
    const rowsBefore = within(
      screen.getByTestId("conversation-list-scroll"),
    ).getAllByRole("link").length;

    rerenderInbox(rerender, inboxData("conversation-7"));

    expect(
      within(screen.getByTestId("conversation-list-scroll")).getAllByRole("link"),
    ).toHaveLength(rowsBefore);
    expect(rowsBefore).toBe(CONVERSATIONS.length);
  });

  it("still remounts the thread pane, so nothing from one thread reaches another", () => {
    const { rerender } = renderInbox(inboxData("conversation-1"));
    const threadBefore = screen.getByTestId("inbox-thread");

    rerenderInbox(rerender, inboxData("conversation-7"));

    // The other half of the fix: the list survives, the thread does not. A
    // reply draft or a staged attachment must never cross between patients.
    expect(screen.getByTestId("inbox-thread")).not.toBe(threadBefore);
  });

  /**
   * The bug did not live in the shell — it lived in the page that rendered it.
   * A component test alone would keep passing if the key came back, so this
   * asserts the page itself.
   */
  it("does not key the whole Inbox on the selected conversation", () => {
    const page = readFileSync(
      path.join(process.cwd(), "app/(protected)/inbox/page.tsx"),
      "utf8",
    );
    const shellTag = page.slice(page.indexOf("<InboxShell"), page.indexOf("/>"));
    expect(shellTag).not.toMatch(/\bkey=/);
  });
});

describe("P12 · the past-appointments panel follows the selected conversation", () => {
  it("asks for the conversation that is currently open, and no other", async () => {
    const { rerender } = renderInbox(inboxData("conversation-1"));
    rerenderInbox(rerender, inboxData("conversation-7"));

    const trigger = screen.getByTestId("past-appointments-trigger");
    trigger.click();

    // Not conversation-1: the panel is rebuilt with the thread, so it cannot be
    // left holding the previous conversation's id.
    const { waitFor } = await import("@testing-library/react");
    await waitFor(() =>
      expect(mocks.listConversationPatientAppointments).toHaveBeenCalledWith({
        conversationId: "conversation-7",
      }),
    );
    expect(mocks.listConversationPatientAppointments).not.toHaveBeenCalledWith({
      conversationId: "conversation-1",
    });
  });
});
