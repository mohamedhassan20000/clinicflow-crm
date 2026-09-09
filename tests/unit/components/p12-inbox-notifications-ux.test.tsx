/**
 * P12 — the Inbox and Notifications UX pass.
 *
 *   * **A notification could only be opened from the word "Open".** Every part
 *     of the card describes one destination; only 40px of it went there.
 *   * **Threads a colleague had taken over said "AI handling".** The badge was
 *     telling staff nobody needed to answer the one thread somebody was
 *     answering.
 *   * **Answering "when was she last in?" meant leaving the thread.**
 *   * **Recording the follow-up that conversation produced meant leaving it
 *     twice.**
 */

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import messages from "@/messages/en.json";
import type { InboxData, InboxThreadMessage } from "@/lib/messaging/inbox";
import type { InboxPastAppointment } from "@/actions/inbox-patient-appointments";

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
  markNotificationRead: vi.fn(async () => ({ success: true })),
  markAllNotificationsRead: vi.fn(async () => ({ success: true })),
  listConversationPatientAppointments: vi.fn(),
  recordFollowup: vi.fn(async () => ({
    followup: {
      id: "followup-1",
      appointment_id: "appointment-1",
      patient_id: "patient-1",
      outcome: "all_fine",
      notes: null,
    },
  })),
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
  setConversationHumanTakeover: vi.fn(async () => ({ success: true })),
  updateConversationAssignment: vi.fn(),
  updateConversationStatus: vi.fn(),
  clearConversationEscalation: vi.fn(),
  prepareConversationMedia: vi.fn(),
  sendConversationDocument: vi.fn(),
  discardConversationMedia: vi.fn(),
}));
vi.mock("@/actions/notifications", () => ({
  markNotificationRead: mocks.markNotificationRead,
  markAllNotificationsRead: mocks.markAllNotificationsRead,
}));
vi.mock("@/actions/inbox-patient-appointments", () => ({
  listConversationPatientAppointments: mocks.listConversationPatientAppointments,
}));
vi.mock("@/actions/followups", () => ({
  recordFollowup: mocks.recordFollowup,
  updateFollowup: vi.fn(),
  deleteFollowup: vi.fn(async () => ({})),
  restoreFollowup: vi.fn(async () => ({})),
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
import {
  NotificationsList,
  type NotificationListItem,
} from "@/components/notifications/notifications-list";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function message(id: string, body: string, at: string): InboxThreadMessage {
  return {
    id,
    direction: id.startsWith("in") ? "inbound" : "outbound",
    body,
    occurredAt: at,
    status: null,
    templateId: null,
    attachments: [],
  } as InboxThreadMessage;
}

function inboxData(overrides: Partial<InboxData> = {}): InboxData {
  return {
    conversations: [
      {
        id: "conversation-1",
        channel: "whatsapp",
        status: "open",
        patientId: "patient-1",
        patientName: "Fatima Mahmoud",
        patientPhone: "+201111111111",
        patientFileNumber: "F-001",
        displayName: "Fatima",
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
        preview: "…",
        unreadCount: 0,
      },
    ],
    messages: [message("inbound-1", "عايز احجز", "2026-08-17T09:00:00.000Z")],
    assignees: [],
    patients: [],
    templates: [],
    contacts: [],
    documents: [],
    whatsappProvider: "linked_device",
    search: "",
    suggestion: null,
    selectedConversationId: "conversation-1",
    loadedAt: "2026-08-17T09:01:00.000Z",
    error: false,
    messagesTruncated: false,
    degraded: false,
    ...overrides,
  };
}

function renderInbox(data: InboxData = inboxData()) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <InboxShell data={data} clinicId="clinic-1" viewerId="receptionist-1" />
    </NextIntlClientProvider>,
  );
}

function notification(overrides: Partial<NotificationListItem> = {}): NotificationListItem {
  return {
    id: "notification-1",
    type: "inbox_message",
    link: "/inbox?conversation=conversation-1",
    data: { patientName: "Ali" },
    readAt: null,
    createdAt: "2026-08-17T09:00:00.000Z",
    ...overrides,
  };
}

function renderNotifications(items: NotificationListItem[]) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <NotificationsList notifications={items} />
    </NextIntlClientProvider>,
  );
}

function appointment(
  overrides: Partial<InboxPastAppointment> = {},
): InboxPastAppointment {
  return {
    id: "appointment-1",
    scheduledAt: "2026-08-10T09:00:00.000Z",
    status: "completed",
    doctorId: "doctor-1",
    doctorName: "Dr Salma Nabil",
    departmentId: "department-1",
    departmentName: "Dermatology",
    departmentColor: "#10b981",
    paidAt: "2026-08-10T09:40:00.000Z",
    totalAmount: 500,
    paymentNote: null,
    followup: null,
    followupPending: true,
    ...overrides,
  };
}

function historyResult(appointments: InboxPastAppointment[]) {
  return {
    patient: {
      id: "patient-1",
      fullName: "Fatima Mahmoud",
      phone: "+201111111111",
      fileNumber: "F-001",
      nationalId: null,
      departmentId: "department-1",
    },
    appointments,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listConversationPatientAppointments.mockResolvedValue(
    historyResult([appointment()]),
  );
});

// ---------------------------------------------------------------------------
// A — the whole notification card is the target
// ---------------------------------------------------------------------------

describe("P12 · a notification is one thing you can click", () => {
  it("opens from a click anywhere on the card, not only on Open", async () => {
    const user = userEvent.setup();
    renderNotifications([notification()]);

    // The body text — the part people actually aim at.
    await user.click(screen.getByText(messages.notifications.type_inbox_message_title));

    await waitFor(() =>
      expect(mocks.markNotificationRead).toHaveBeenCalledWith("notification-1"),
    );
    expect(mocks.markNotificationRead).toHaveBeenCalledTimes(1);
  });

  it("shows the card is clickable — pointer cursor and a hover state", () => {
    renderNotifications([notification()]);
    const card = screen.getByTestId("notification-item");
    expect(card.className).toContain("cursor-pointer");
    expect(card.className).toContain("hover:bg-primary/10");
    // The whole card is the anchor's hit area, not just the button's box.
    expect(screen.getByTestId("notification-open").className).toContain("after:inset-0");
  });

  it("draws focus on the card when its link is focused", () => {
    renderNotifications([notification()]);
    const card = screen.getByTestId("notification-item");
    expect(card.className).toContain("has-[a:focus-visible]:outline-2");
  });

  it("opens on Enter and on Space from the keyboard", async () => {
    const user = userEvent.setup();
    renderNotifications([notification()]);

    screen.getByTestId("notification-open").focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(mocks.markNotificationRead).toHaveBeenCalledTimes(1));

    mocks.markNotificationRead.mockClear();
    screen.getByTestId("notification-open").focus();
    await user.keyboard(" ");
    await waitFor(() => expect(mocks.markNotificationRead).toHaveBeenCalledTimes(1));
  });

  it("opens exactly once when the Open control itself is clicked", async () => {
    const user = userEvent.setup();
    renderNotifications([notification()]);

    await user.click(screen.getByTestId("notification-open"));
    await waitFor(() => expect(mocks.markNotificationRead).toHaveBeenCalledTimes(1));
  });

  it("leaves Mark read to itself — it marks read without opening", async () => {
    const user = userEvent.setup();
    renderNotifications([notification()]);

    await user.click(
      screen.getByRole("button", { name: messages.notifications.markRead }),
    );
    await waitFor(() =>
      expect(mocks.markNotificationRead).toHaveBeenCalledWith("notification-1"),
    );
    // One write, from the button. The card handler must not have fired too.
    expect(mocks.markNotificationRead).toHaveBeenCalledTimes(1);
  });

  it("keeps exactly one link per card, so there is one tab stop and one target", () => {
    renderNotifications([notification()]);
    expect(within(screen.getByTestId("notification-item")).getAllByRole("link")).toHaveLength(1);
  });

  it("is inert, and says so, when the notification has nowhere to go", () => {
    renderNotifications([notification({ link: null })]);
    const card = screen.getByTestId("notification-item");
    expect(card.dataset.interactive).toBeUndefined();
    expect(card.className).not.toContain("cursor-pointer");
  });

  it("keeps the unread treatment the card already had", () => {
    renderNotifications([
      notification({ id: "a" }),
      notification({ id: "b", readAt: "2026-08-17T09:30:00.000Z" }),
    ]);
    const [unread, read] = screen.getAllByTestId("notification-item");
    expect(unread!.dataset.unread).toBe("true");
    expect(unread!.className).toContain("bg-primary/5");
    expect(read!.dataset.unread).toBeUndefined();
    expect(read!.className).toContain("bg-card");
  });
});

// ---------------------------------------------------------------------------
// B/E — human vs AI handling, in the Inbox itself
// ---------------------------------------------------------------------------

describe("P12 · the badge says who is handling the thread", () => {
  it("says a staff member has it once the AI is paused and they have answered", () => {
    const data = inboxData();
    data.conversations[0]!.aiPausedAt = "2026-08-17T09:05:00.000Z";
    data.conversations[0]!.aiPausedByName = "Reception User";
    // P15: pausing says a colleague owns the thread; their reply is what says
    // they are actively handling it. Until they answer, an unanswered patient
    // message reads "Awaiting patient" — which is still never "AI handling",
    // the property this suite exists to guarantee (see the test below).
    data.conversations[0]!.lastHumanReplyAt = "2026-08-17T09:06:00.000Z";
    renderInbox(data);

    const badges = screen.getAllByTestId("conversation-status-badge");
    expect(badges.every((badge) => badge.dataset.state === "humanHandling")).toBe(true);
    expect(
      screen.getAllByText(messages.inbox.statusBadge.humanHandling).length,
    ).toBeGreaterThan(0);
  });

  it("never calls a human-held thread the AI's", () => {
    const data = inboxData();
    data.conversations[0]!.aiPausedAt = "2026-08-17T09:05:00.000Z";
    renderInbox(data);

    expect(screen.queryByText(messages.inbox.statusBadge.aiHandling)).toBeNull();
  });

  it("shows one status chip per row, not a status and a contradicting one", () => {
    const data = inboxData();
    data.conversations[0]!.aiPausedAt = "2026-08-17T09:05:00.000Z";
    renderInbox(data);

    // The list row used to carry an "AI paused" chip beside the status badge.
    // The status badge now says it, and the row says it once.
    const row = screen.getAllByTestId("conversation-status-badge")[0]!.closest("span");
    expect(within(row!).queryByText(messages.inbox.ai.pausedBadge)).toBeNull();
  });

  it("hands the badge back to the assistant when the AI is resumed", () => {
    renderInbox();
    const badges = screen.getAllByTestId("conversation-status-badge");
    expect(badges.every((badge) => badge.dataset.state === "aiHandling")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// C/D — past appointments, and the follow-up that comes out of them
// ---------------------------------------------------------------------------

describe("P12 · past appointments from inside the thread", () => {
  /**
   * P18 moved the secondary thread controls into one overflow menu, so the
   * history is now two clicks from the thread rather than one. The control
   * itself, what it is offered for and what it refuses are unchanged — these
   * tests open the menu first and assert exactly what they always did.
   */
  async function openPastAppointments(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByTestId("conversation-more-actions"));
    await user.click(await screen.findByTestId("past-appointments-trigger"));
  }

  it("offers the history for a conversation linked to a patient", async () => {
    const user = userEvent.setup();
    renderInbox();

    await user.click(screen.getByTestId("conversation-more-actions"));
    const trigger = await screen.findByTestId("past-appointments-trigger");
    expect(trigger.getAttribute("aria-disabled")).not.toBe("true");
    await user.click(trigger);

    await waitFor(() =>
      expect(mocks.listConversationPatientAppointments).toHaveBeenCalledWith({
        conversationId: "conversation-1",
      }),
    );
    expect(await screen.findByTestId("past-appointments-panel")).toBeTruthy();
  });

  it("refuses to invent a history for an unlinked new contact", async () => {
    const user = userEvent.setup();
    const data = inboxData();
    data.conversations[0]!.patientId = null;
    data.conversations[0]!.patientName = null;
    renderInbox(data);

    await user.click(screen.getByTestId("conversation-more-actions"));
    const trigger = await screen.findByTestId("past-appointments-trigger");
    expect(trigger.getAttribute("aria-disabled")).toBe("true");
    expect(trigger.textContent).toContain(
      messages.inbox.pastAppointments.linkPatientFirst,
    );
    expect(mocks.listConversationPatientAppointments).not.toHaveBeenCalled();
  });

  it("renders each visit with its date, doctor and status", async () => {
    const user = userEvent.setup();
    renderInbox();
    await openPastAppointments(user);

    const row = await screen.findByTestId("past-appointment-row");
    expect(within(row).getByText(/Dr Salma Nabil/)).toBeTruthy();
    expect(within(row).getByText(messages.appointments.statusCompleted)).toBeTruthy();
    expect(within(row).getByText(/Aug 10, 2026/)).toBeTruthy();
  });

  /**
   * A linked patient who has simply never been seen yet is not a failure. The
   * panel used to be able to say "Conversation not found." here — the read
   * re-authorized the thread through RLS and lost it — so the two outcomes are
   * asserted apart: an empty history renders the empty state and no retry.
   */
  it("shows the empty state, not an error, when there is no history", async () => {
    mocks.listConversationPatientAppointments.mockResolvedValue(historyResult([]));
    const user = userEvent.setup();
    renderInbox();
    await openPastAppointments(user);

    expect(await screen.findByText(messages.inbox.pastAppointments.empty)).toBeTruthy();
    expect(screen.queryByText(messages.inbox.pastAppointments.error)).toBeNull();
    expect(
      screen.queryByRole("button", { name: messages.inbox.pastAppointments.retry }),
    ).toBeNull();
    expect(screen.queryAllByTestId("past-appointment-row")).toHaveLength(0);
  });

  it("says so, rather than emptying the panel, when the read fails", async () => {
    mocks.listConversationPatientAppointments.mockResolvedValue({
      error: "Conversation not found.",
    });
    const user = userEvent.setup();
    renderInbox();
    await openPastAppointments(user);

    expect(await screen.findByText("Conversation not found.")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: messages.inbox.pastAppointments.retry }),
    ).toBeTruthy();
  });

  it("offers the follow-up only where one is actually pending", async () => {
    mocks.listConversationPatientAppointments.mockResolvedValue(
      historyResult([
        appointment(),
        appointment({
          id: "appointment-2",
          status: "cancelled",
          followupPending: false,
        }),
      ]),
    );
    const user = userEvent.setup();
    renderInbox();
    await openPastAppointments(user);

    await screen.findAllByTestId("past-appointment-row");
    expect(screen.getAllByTestId("past-appointment-add-followup")).toHaveLength(1);
  });

  it("shows the recorded outcome, and no second follow-up, once one exists", async () => {
    mocks.listConversationPatientAppointments.mockResolvedValue(
      historyResult([
        appointment({
          followupPending: false,
          followup: {
            id: "followup-1",
            outcome: "all_fine",
            notes: null,
            recordedAt: "2026-08-11T09:00:00.000Z",
          },
        }),
      ]),
    );
    const user = userEvent.setup();
    renderInbox();
    await openPastAppointments(user);

    expect(await screen.findByTestId("past-appointment-followup-done")).toBeTruthy();
    expect(screen.queryByTestId("past-appointment-add-followup")).toBeNull();
  });

  it("records the follow-up through the existing dialog and stays in the Inbox", async () => {
    const user = userEvent.setup();
    renderInbox();
    await openPastAppointments(user);
    await user.click(await screen.findByTestId("past-appointment-add-followup"));

    // The Follow-ups page's own dialog, with its own outcomes.
    await user.click(
      await screen.findByRole("button", {
        name: new RegExp(messages.followups.outcomeEverythingFine),
      }),
    );
    await user.click(
      screen.getByRole("button", { name: messages.followups.savefollowup }),
    );

    await waitFor(() => expect(mocks.recordFollowup).toHaveBeenCalled());
    // The one write went through `recordFollowup`, carrying the appointment and
    // patient this thread is about.
    const form = (mocks.recordFollowup.mock.calls as unknown as [
      unknown,
      FormData,
    ][])[0]![1];
    expect(form.get("appointment_id")).toBe("appointment-1");
    expect(form.get("patient_id")).toBe("patient-1");
    expect(form.get("outcome")).toBe("all_fine");

    // The proof the user did not leave: no navigation of any kind, the Inbox
    // thread is still rendered, and the panel re-read its own rows in place.
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
    expect(mocks.push).not.toHaveBeenCalled();
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(screen.getByTestId("conversation-more-actions")).toBeTruthy();
    await waitFor(() =>
      expect(mocks.listConversationPatientAppointments).toHaveBeenCalledTimes(2),
    );
  });
});
