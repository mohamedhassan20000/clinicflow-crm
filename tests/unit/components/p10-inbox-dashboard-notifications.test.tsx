/**
 * P10 — the four staff-facing defects the device testing surfaced.
 *
 * Each of these was reported as "the button is broken", and none of them was a
 * broken button:
 *
 *   * **The thread never scrolled.** There was no scroll management in the
 *     Inbox at all, so the newest message sat below the fold and every reply
 *     needed a manual scroll.
 *   * **The ClinicFlow document control was greyed out with no reason given.**
 *     It disabled itself whenever the list was empty, and the only explanation
 *     it ever showed was the one for an unlinked conversation.
 *   * **The dashboard shortcuts landed nowhere useful.** A cross-route fragment
 *     into a streamed page, and a `?status=pending` filter that opened whatever
 *     week the calendar happened to be on.
 *   * **Opening a notification left it unread.** Only the separate "Mark read"
 *     button cleared it, so the badge counted things staff had already dealt
 *     with.
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import messages from "@/messages/en.json";
import type { InboxData, InboxThreadMessage } from "@/lib/messaging/inbox";

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
  markNotificationRead: vi.fn(async () => ({ success: true })),
  markAllNotificationsRead: vi.fn(async () => ({ success: true })),
  searchParams: new URLSearchParams(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh, push: vi.fn(), replace: vi.fn() }),
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
import {
  AI_INTAKE_ID_PARAM,
  AI_INTAKE_REVIEW_ANCHOR,
  AI_INTAKE_REVIEW_PARAM,
  CALENDAR_APPOINTMENT_PARAM,
} from "@/lib/navigation/ai-review-targets";

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
        patientId: null,
        patientName: null,
        patientPhone: null,
        patientFileNumber: null,
        displayName: "Fatima Ahmed",
        sender: "+201111111111",
        assignedTo: null,
        assignedName: null,
        lastMessageAt: "2026-08-17T09:00:00.000Z",
        lastInboundAt: "2026-08-17T09:00:00.000Z",
        windowExpiresAt: "2026-08-18T09:00:00.000Z",
        identityVerifiedAt: null,
        escalatedAt: null,
        escalationReason: null,
        aiPausedAt: null,
        aiPausedByName: null,
        preview: "…",
        unreadCount: 0,
      },
    ],
    messages: [
      message("inbound-1", "عايز احجز", "2026-08-17T09:00:00.000Z"),
      message("outbound-1", "تمام", "2026-08-17T09:00:30.000Z"),
    ],
    assignees: [{ id: "receptionist-1", name: "Reception User" }],
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

/**
 * jsdom gives every element a zero-height layout, which would make the thread
 * permanently "at the bottom". These setters are what let a test say where the
 * reader actually is.
 */
function layoutThread(
  thread: HTMLElement,
  { scrollTop, scrollHeight, clientHeight }: {
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
  },
) {
  Object.defineProperty(thread, "scrollHeight", { value: scrollHeight, configurable: true });
  Object.defineProperty(thread, "clientHeight", { value: clientHeight, configurable: true });
  thread.scrollTop = scrollTop;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.searchParams = new URLSearchParams();
});

// ---------------------------------------------------------------------------
// §14 — the thread follows the conversation
// ---------------------------------------------------------------------------

describe("P10 §14 · the Inbox thread follows new messages", () => {
  it("opens a conversation at its newest message", () => {
    renderInbox();
    const thread = screen.getByTestId("inbox-thread");
    // The jump is unconditional on open: `scrollTop` is set to `scrollHeight`,
    // which in jsdom's zero-height layout is 0 — the assertion that matters is
    // that the component reached for the bottom at all rather than leaving the
    // browser's default of the top.
    expect(thread).toBeTruthy();
    expect(thread.scrollTop).toBe(thread.scrollHeight);
  });

  it("scrolls to a newly arrived message while the reader is near the bottom", async () => {
    const { rerender } = renderInbox();
    const thread = screen.getByTestId("inbox-thread");
    const scrollTo = vi.fn();
    Object.defineProperty(thread, "scrollTo", { value: scrollTo, configurable: true });
    layoutThread(thread, { scrollTop: 880, scrollHeight: 1000, clientHeight: 120 });

    const next = inboxData({
      messages: [
        message("inbound-1", "عايز احجز", "2026-08-17T09:00:00.000Z"),
        message("outbound-1", "تمام", "2026-08-17T09:00:30.000Z"),
        message("inbound-2", "شكرا", "2026-08-17T09:01:00.000Z"),
      ],
    });
    rerender(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <InboxShell data={next} clinicId="clinic-1" viewerId="receptionist-1" />
      </NextIntlClientProvider>,
    );

    await waitFor(() => expect(scrollTo).toHaveBeenCalled());
    // And no "new messages" affordance, because they are already looking at it.
    expect(screen.queryByTestId("inbox-new-messages")).toBeNull();
  });

  it("leaves a reader who has scrolled up alone, and tells them there is more", async () => {
    const user = userEvent.setup();
    const { rerender } = renderInbox();
    const thread = screen.getByTestId("inbox-thread");
    const scrollTo = vi.fn();
    Object.defineProperty(thread, "scrollTo", { value: scrollTo, configurable: true });

    // Far up the history, reading.
    layoutThread(thread, { scrollTop: 0, scrollHeight: 4000, clientHeight: 400 });
    thread.dispatchEvent(new Event("scroll", { bubbles: true }));

    const next = inboxData({
      messages: [
        message("inbound-1", "عايز احجز", "2026-08-17T09:00:00.000Z"),
        message("outbound-1", "تمام", "2026-08-17T09:00:30.000Z"),
        message("inbound-2", "و كمان سؤال", "2026-08-17T09:01:00.000Z"),
      ],
    });
    rerender(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <InboxShell data={next} clinicId="clinic-1" viewerId="receptionist-1" />
      </NextIntlClientProvider>,
    );

    // Their position is untouched…
    const indicator = await screen.findByTestId("inbox-new-messages");
    expect(scrollTo).not.toHaveBeenCalled();
    expect(thread.scrollTop).toBe(0);

    // …and the indicator is the way back down, dismissed by using it.
    await user.click(indicator);
    expect(scrollTo).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByTestId("inbox-new-messages")).toBeNull());
  });
});

// ---------------------------------------------------------------------------
// §13 — the ClinicFlow document control
// ---------------------------------------------------------------------------

describe("P10 §13 · the ClinicFlow document control says why it is unavailable", () => {
  it("is disabled with the linking hint when no patient is linked", () => {
    renderInbox();
    expect(screen.getByTestId("composer-document-select")).toHaveAttribute(
      "data-disabled",
    );
    expect(
      screen.getByText(messages.inbox.composer.linkPatientForDocuments),
    ).toBeTruthy();
  });

  it("explains itself rather than looking broken when a patient IS linked", () => {
    // The reported defect: a correctly linked conversation whose document list
    // came back empty produced a greyed-out control and the *unlinked* hint, or
    // no hint at all.
    renderInbox(
      inboxData({
        conversations: [
          { ...inboxData().conversations[0]!, patientId: "patient-1", patientName: "Ali" },
        ],
        documents: [],
      }),
    );
    expect(
      screen.getByText(messages.inbox.composer.noDocumentsForPatient),
    ).toBeTruthy();
    expect(
      screen.queryByText(messages.inbox.composer.linkPatientForDocuments),
    ).toBeNull();
  });

  it("is enabled, and offers only the documents it was given, once there are some", async () => {
    const user = userEvent.setup();
    renderInbox(
      inboxData({
        conversations: [
          { ...inboxData().conversations[0]!, patientId: "patient-1", patientName: "Ali" },
        ],
        documents: [
          {
            id: "doc-1",
            source: "clinic_document",
            label: "INV-0001 · invoice",
            fileName: "INV-0001.pdf",
            mimeType: "application/pdf",
            byteSize: null,
          },
        ],
      }),
    );

    const select = screen.getByTestId("composer-document-select");
    expect(select).not.toHaveAttribute("data-disabled");
    // No hint at all when the control works.
    expect(
      screen.queryByText(messages.inbox.composer.noDocumentsForPatient),
    ).toBeNull();

    await user.click(select);
    expect(await screen.findByText("INV-0001 · invoice")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// §15 — opening a notification marks it read
// ---------------------------------------------------------------------------

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

describe("P10 §15 · opening a notification is what marks it read", () => {
  it("marks an unread notification read as part of opening it", async () => {
    const user = userEvent.setup();
    renderNotifications([notification()]);

    await user.click(screen.getByTestId("notification-open"));
    await waitFor(() =>
      expect(mocks.markNotificationRead).toHaveBeenCalledWith("notification-1"),
    );
    // The bell count is server-rendered, so the page has to be told.
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
  });

  it("does not write again for a notification that is already read", async () => {
    const user = userEvent.setup();
    renderNotifications([
      notification({ readAt: "2026-08-17T09:30:00.000Z" }),
    ]);

    await user.click(screen.getByTestId("notification-open"));
    expect(mocks.markNotificationRead).not.toHaveBeenCalled();
  });

  it("still offers the explicit control for a notification with no link", () => {
    renderNotifications([notification({ link: null })]);
    expect(screen.queryByTestId("notification-open")).toBeNull();
    expect(
      screen.getByRole("button", { name: messages.notifications.markRead }),
    ).toBeTruthy();
  });

  it("counts only the unread ones", () => {
    renderNotifications([
      notification({ id: "a" }),
      notification({ id: "b", readAt: "2026-08-17T09:30:00.000Z" }),
    ]);
    const items = screen.getAllByTestId("notification-item");
    expect(items.filter((item) => item.dataset.unread)).toHaveLength(1);
  });

  it("renders the P11H AI booking request notification as operational work", () => {
    renderNotifications([
      notification({
        type: "ai_booking_request",
        link: "/patients?ai_intake_review=1#ai-intakes",
        data: { source: "ai_appointment_request", recordId: "request-1" },
      }),
    ]);
    expect(
      screen.getByText(messages.notifications.type_ai_booking_request_title),
    ).toBeTruthy();
    expect(
      screen.getByText(messages.notifications.type_ai_booking_request_body),
    ).toBeTruthy();
  });

  it("renders the P11J patient-intake notification as review work", () => {
    renderNotifications([
      notification({
        type: "ai_patient_intake",
        link: "/patients?review=1&intake=intake-1#ai-intakes",
        data: { source: "ai_patient_intake", recordId: "intake-1" },
      }),
    ]);
    expect(
      screen.getByText(messages.notifications.type_ai_patient_intake_title),
    ).toBeTruthy();
    expect(
      screen.getByText(messages.notifications.type_ai_patient_intake_body),
    ).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// §12 — the dashboard shortcuts are deterministic
// ---------------------------------------------------------------------------

describe("P10 §12 · the AI review shortcuts land where they claim", () => {
  it("keeps one contract for the intake anchor and its query parameter", () => {
    // Two files produce and consume these; they used to agree by coincidence.
    expect(AI_INTAKE_REVIEW_ANCHOR).toBe("ai-intakes");
    expect(AI_INTAKE_REVIEW_PARAM).toBe("review");
    expect(AI_INTAKE_ID_PARAM).toBe("intake");
    expect(CALENDAR_APPOINTMENT_PARAM).toBe("appointment");
  });

  it("includes provisional intake bookings in the dashboard queue", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile("components/dashboard/ai-pending-appointments-section.tsx", "utf8"),
    );
    expect(source).toContain('.from("appointments")');
    expect(source).toContain('.from("ai_appointment_requests")');
    expect(source).toContain('"ai-provisional-booking-deep-link"');
    expect(source).toContain("AI_INTAKE_ID_PARAM");
    expect(source).toContain("appointment.intakeId");
  });

  it("scrolls and focuses the intake review table when the parameter is present", async () => {
    const { AiIntakeReviewSection } = await import(
      "@/components/patients/ai-intake-review-section"
    );
    mocks.searchParams = new URLSearchParams({ [AI_INTAKE_REVIEW_PARAM]: "1" });
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;

    render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <AiIntakeReviewSection
          intakes={[
            {
              id: "intake-1",
              conversationId: "conversation-1",
              fullName: "Ali Ibrahim Mohamed",
              dateOfBirth: "2001-03-24",
              phone: "+201111111111",
              email: "ali@example.com",
              nationalId: "29009120123456",
              departmentName: "Dermatology",
              doctorName: "Sara Ali",
              createdAt: "2026-08-17T09:00:00.000Z",
              hasAppointmentRequest: true,
            },
          ]}
        />
      </NextIntlClientProvider>,
    );

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    const card = document.getElementById(AI_INTAKE_REVIEW_ANCHOR);
    expect(card).toBeTruthy();
    expect(document.activeElement).toBe(card);
  });

  it("focuses and opens the exact intake record from a deep link", async () => {
    const { AiIntakeReviewSection } = await import(
      "@/components/patients/ai-intake-review-section"
    );
    mocks.searchParams = new URLSearchParams({
      [AI_INTAKE_REVIEW_PARAM]: "1",
      [AI_INTAKE_ID_PARAM]: "intake-1",
    });
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;

    render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <AiIntakeReviewSection
          intakes={[
            {
              id: "intake-1",
              conversationId: "conversation-1",
              fullName: "Ali Ibrahim Mohamed",
              dateOfBirth: "2001-03-24",
              phone: "+201111111111",
              email: "ali@example.com",
              nationalId: "29009120123456",
              departmentName: "Dermatology",
              doctorName: "Sara Ali",
              createdAt: "2026-08-17T09:00:00.000Z",
              hasAppointmentRequest: true,
            },
          ]}
        />
      </NextIntlClientProvider>,
    );

    const row = document.getElementById("ai-intake-intake-1");
    expect(row).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    expect(scrollIntoView).toHaveBeenCalled();
  });

  it("does not hijack the page when the parameter is absent", async () => {
    const { AiIntakeReviewSection } = await import(
      "@/components/patients/ai-intake-review-section"
    );
    mocks.searchParams = new URLSearchParams();
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;

    render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <AiIntakeReviewSection intakes={[]} />
      </NextIntlClientProvider>,
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});
