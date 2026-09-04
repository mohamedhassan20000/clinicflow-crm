import { render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import en from "@/messages/en.json";
import ar from "@/messages/ar.json";
import type { InboxAttachment, InboxData } from "@/lib/messaging/inbox";

/**
 * P16 — media in the Inbox, after the manual-QA pass that found none of it
 * rendering.
 *
 * The pipeline was never the problem: the worker downloaded the patient's
 * photo, stored it, and wrote the row; the clinic's image and PDF reached the
 * patient's handset. What staff saw for all three was "No message preview".
 * These tests pin the two halves of the fix that live in the UI — the thread
 * renders the media it is given, and the conversation list names the kind of
 * message instead of falling through to the blank last-resort line.
 */

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
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh, push: vi.fn() }),
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
}));
vi.mock("@/actions/bulk-messaging", () => ({
  createBulkSend: vi.fn(),
  runBulkSend: vi.fn(),
  readBulkSendJob: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: { getSession: async () => ({ data: { session: null } }) },
    channel: () => mocks.channel,
    removeChannel: mocks.removeChannel,
    realtime: { setAuth: vi.fn() },
  }),
}));

import { InboxShell } from "@/components/inbox/inbox-shell";

function attachment(overrides: Partial<InboxAttachment> = {}): InboxAttachment {
  return {
    id: "attachment-1",
    mediaKind: "image",
    voiceNote: false,
    durationSeconds: null,
    mimeType: "image/jpeg",
    fileName: null,
    byteSize: 295_703,
    status: "stored",
    failureReason: null,
    url: "/signed/patient-photo.jpg",
    ...overrides,
  } as InboxAttachment;
}

function conversation(overrides: Record<string, unknown> = {}) {
  return {
    id: "conversation-1",
    channel: "whatsapp" as const,
    status: "open" as const,
    patientId: null,
    patientName: null,
    patientPhone: null,
    patientFileNumber: null,
    displayName: "Mohamed Hassan",
    sender: "+905384316956",
    assignedTo: null,
    assignedName: null,
    lastMessageAt: "2026-09-03T01:36:29.000Z",
    lastInboundAt: "2026-09-03T01:32:15.000Z",
    windowExpiresAt: "2026-09-04T01:32:15.000Z",
    identityVerifiedAt: null,
    escalatedAt: null,
    escalationReason: null,
    aiPausedAt: null,
    aiPausedByName: null,
    preview: "[image]",
    unreadCount: 0,
    ...overrides,
  };
}

function message(
  overrides: Partial<InboxData["messages"][number]> = {},
): InboxData["messages"][number] {
  return {
    id: "inbound-1",
    direction: "inbound" as const,
    body: "",
    occurredAt: "2026-09-03T01:32:15.000Z",
    status: null,
    templateId: null,
    attachments: [],
    ...overrides,
  };
}

function baseData(overrides: Partial<InboxData> = {}): InboxData {
  return {
    conversations: [conversation()],
    messages: [],
    assignees: [{ id: "receptionist-1", name: "Reception User" }],
    patients: [],
    templates: [],
    contacts: [],
    documents: [],
    whatsappProvider: "linked_device",
    search: "",
    suggestion: null,
    selectedConversationId: "conversation-1",
    loadedAt: "2026-09-03T01:40:00.000Z",
    error: false,
    messagesTruncated: false,
    degraded: false,
    ...overrides,
  } as InboxData;
}

function renderInbox(data: InboxData = baseData()) {
  return render(
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      <InboxShell data={data} clinicId="clinic-1" viewerId="receptionist-1" />
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));
});

describe("P16 — a live inbound image renders in the thread", () => {
  it("shows the photo itself, not 'No message preview'", () => {
    renderInbox(
      baseData({
        messages: [message({ body: "[image]", attachments: [attachment()] })],
      }),
    );
    const thread = screen.getByTestId("message-attachments");
    const image = within(thread).getByRole("img");
    expect(image).toHaveProperty(
      "src",
      expect.stringContaining("/signed/patient-photo.jpg") as unknown as string,
    );
    // Openable through the same signed link, never a raw storage path.
    const link = image.closest("a");
    expect(link?.getAttribute("href")).toBe("/signed/patient-photo.jpg");
    expect(screen.queryByText(en.inbox.noPreview)).toBeNull();
    expect(document.body.textContent).not.toContain("2026-09/");
  });

  it("keeps the sender side and the timestamp of the media message", () => {
    renderInbox(
      baseData({
        messages: [message({ body: "[image]", attachments: [attachment()] })],
      }),
    );
    // An inbound bubble is not the outbound one: the thread row must not be
    // end-aligned, which is the only direction signal the bubble carries.
    const bubble = screen.getByTestId("message-attachments").closest("div.flex");
    expect(bubble?.className).not.toContain("justify-end");
  });

  it("falls back to naming the kind, never to a blank line, when media is missing", () => {
    renderInbox(baseData({ messages: [message({ body: "[image]", attachments: [] })] }));
    expect(screen.getAllByText(en.inbox.mediaPreview.image).length).toBeGreaterThan(0);
    expect(screen.queryByText(en.inbox.noPreview)).toBeNull();
  });
});

describe("P16 — outbound media renders in the thread", () => {
  it("renders a sent image rather than 'No message preview'", () => {
    renderInbox(
      baseData({
        conversations: [conversation({ preview: "[image]" })],
        messages: [
          message({
            id: "outbound-1",
            direction: "outbound",
            body: "[image]",
            status: "read",
            attachments: [
              attachment({
                id: "outbound-media-1",
                fileName: "NewPDF_page-0001 2.jpg",
                url: "/signed/sent-image.jpg",
              }),
            ],
          }),
        ],
      }),
    );
    const thread = screen.getByTestId("message-attachments");
    expect(within(thread).getByRole("img")).toHaveProperty(
      "src",
      expect.stringContaining("/signed/sent-image.jpg") as unknown as string,
    );
    expect(screen.queryByText(en.inbox.noPreview)).toBeNull();
  });

  it("renders a sent PDF as a downloadable document card with its filename", () => {
    renderInbox(
      baseData({
        conversations: [conversation({ preview: "[document]" })],
        messages: [
          message({
            id: "outbound-1",
            direction: "outbound",
            body: "[document]",
            status: "read",
            attachments: [
              attachment({
                id: "outbound-media-1",
                mediaKind: "document",
                mimeType: "application/pdf",
                fileName: "referral.pdf",
                byteSize: 676_968,
                url: "/signed/referral.pdf",
              }),
            ],
          }),
        ],
      }),
    );
    expect(screen.getByText("referral.pdf")).toBeTruthy();
    // Size shown from what the row already knows; nothing is invented.
    expect(screen.getByText("661 KB")).toBeTruthy();
    const link = screen.getByText("referral.pdf").closest("a");
    expect(link?.getAttribute("href")).toBe("/signed/referral.pdf");
    expect(link?.getAttribute("download")).toBe("referral.pdf");
    expect(screen.queryByText(en.inbox.noPreview)).toBeNull();
  });

  it("renders an inbound document the same way", () => {
    renderInbox(
      baseData({
        messages: [
          message({
            body: "[document]",
            attachments: [
              attachment({
                mediaKind: "document",
                mimeType: "application/pdf",
                fileName: "lab-result.pdf",
                url: "/signed/lab-result.pdf",
              }),
            ],
          }),
        ],
      }),
    );
    expect(screen.getByText("lab-result.pdf")).toBeTruthy();
    expect(screen.queryByText(en.inbox.noPreview)).toBeNull();
  });

  it("plays a sent voice note and a received one through the media path", () => {
    renderInbox(
      baseData({
        messages: [
          message({
            id: "inbound-voice",
            body: "[voice message]",
            attachments: [
              attachment({
                id: "inbound-voice-media",
                mediaKind: "audio",
                mimeType: "audio/ogg",
                voiceNote: true,
                durationSeconds: 7,
                url: "/api/inbox/voice/inbound-voice-media",
              }),
            ],
          }),
          message({
            id: "outbound-voice",
            direction: "outbound",
            body: "[voice message]",
            status: "read",
            occurredAt: "2026-09-03T01:33:00.000Z",
            attachments: [
              attachment({
                id: "outbound-voice-media",
                mediaKind: "audio",
                mimeType: "audio/ogg",
                voiceNote: true,
                fileName: "voice-note.webm",
                url: "/signed/voice-note.ogg",
              }),
            ],
          }),
        ],
      }),
    );
    const players = screen.getAllByTestId("voice-note-player");
    expect(players).toHaveLength(2);
    expect(players[0]?.getAttribute("src")).toBe("/api/inbox/voice/inbound-voice-media");
    expect(players[1]?.getAttribute("src")).toBe("/signed/voice-note.ogg");
    expect(screen.queryByText(en.inbox.noPreview)).toBeNull();
  });
});

describe("P16 — the conversation list names the message it cannot quote", () => {
  it("localizes an inbound image preview in English", () => {
    renderInbox(baseData({ conversations: [conversation({ preview: "[image]" })] }));
    expect(screen.getAllByText(en.inbox.mediaPreview.image).length).toBeGreaterThan(0);
    expect(screen.queryByText("[image]")).toBeNull();
  });

  it("carries the Arabic label for the same preview", () => {
    // `tests/unit/setup.ts` pins the component translator to English
    // suite-wide, so the Arabic half of this feature is asserted against the
    // catalog — the same split `p11p-inbox-copy.test.ts` uses. The renderer is
    // locale-agnostic: it looks up `mediaPreview.<kind>` and shows whatever the
    // active catalog holds.
    expect(ar.inbox.mediaPreview.image).toBe("صورة");
    expect(ar.inbox.mediaPreview.document).toBe("ملف");
    expect(ar.inbox.mediaPreview.voiceMessage).toBe("رسالة صوتية");
    expect(Object.keys(ar.inbox.mediaPreview).sort()).toEqual(
      Object.keys(en.inbox.mediaPreview).sort(),
    );
  });

  it("localizes an outbound image and an outbound document preview", () => {
    renderInbox(baseData({ conversations: [conversation({ preview: "[image]" })] }));
    expect(screen.getAllByText(en.inbox.mediaPreview.image).length).toBeGreaterThan(0);

    renderInbox(baseData({ conversations: [conversation({ preview: "[document]" })] }));
    expect(screen.getAllByText(en.inbox.mediaPreview.document).length).toBeGreaterThan(0);
    expect(en.inbox.mediaPreview.document).toBe("Document");
    expect(ar.inbox.mediaPreview.document).toBe("ملف");
  });

  it("keeps 'No message preview' for a message nothing can describe", () => {
    renderInbox(baseData({ conversations: [conversation({ preview: "" })], messages: [] }));
    expect(screen.getAllByText(en.inbox.noPreview).length).toBeGreaterThan(0);
  });

  it("never replaces a real caption with a label", () => {
    renderInbox(
      baseData({ conversations: [conversation({ preview: "ده تحليل الدم بتاعي" })] }),
    );
    expect(screen.getAllByText("ده تحليل الدم بتاعي").length).toBeGreaterThan(0);
  });
});
