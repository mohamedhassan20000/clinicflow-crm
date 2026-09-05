import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import messages from "@/messages/en.json";
import type { InboxAttachment, InboxData } from "@/lib/messaging/inbox";

/**
 * P11P — what a WhatsApp message looks like in the Inbox, and what a thread's
 * badge says about it.
 *
 * Two regressions are pinned here.
 *
 *   1. A media message rendered its worker-written marker as a text bubble, so
 *      a photo the patient sent appeared as the literal characters `[image]` —
 *      sometimes *above the photo itself*.
 *   2. Imported history, which never carried bytes, fell through to the generic
 *      "could not be stored" sentence, which reads like a fault to retry rather
 *      than the permanent, explainable absence it is.
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
    fileName: "photo.jpg",
    byteSize: 24_000,
    status: "stored",
    failureReason: null,
    url: "/signed/photo.jpg",
    ...overrides,
  } as InboxAttachment;
}

function conversation(overrides: Partial<InboxData["conversations"][number]> = {}) {
  return {
    id: "conversation-1",
    channel: "whatsapp" as const,
    status: "open" as const,
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
    preview: "[image]",
    unreadCount: 0,
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
    loadedAt: "2026-08-17T09:01:00.000Z",
    error: false,
    messagesTruncated: false,
    degraded: false,
    ...overrides,
  } as InboxData;
}

function message(
  overrides: Partial<InboxData["messages"][number]> = {},
): InboxData["messages"][number] {
  return {
    id: "inbound-1",
    direction: "inbound" as const,
    // An empty body is how the loader represents "no text": the column is
    // non-null in `InboxThreadMessage`.
    body: "",
    occurredAt: "2026-08-17T09:00:00.000Z",
    status: null,
    templateId: null,
    attachments: [],
    ...overrides,
  };
}

/**
 * English only, deliberately. `tests/unit/setup.ts` resolves every key through
 * next-intl's real translator against `messages/en.json`, so a missing or
 * misspelled key fails here — but the locale is pinned suite-wide. The Arabic
 * copy this feature adds is asserted against the catalog itself, in
 * `tests/unit/lib/p11p-inbox-copy.test.ts`.
 */
function renderInbox(data: InboxData = baseData()) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <InboxShell data={data} clinicId="clinic-1" viewerId="receptionist-1" />
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));
});

describe("P11P — media messages render as media, not as a marker", () => {
  it("shows the image and never the literal [image] bubble", () => {
    renderInbox(
      baseData({ messages: [message({ body: "[image]", attachments: [attachment()] })] }),
    );
    const thread = screen.getByTestId("message-attachments");
    expect(within(thread).getByRole("img")).toHaveProperty(
      "src",
      expect.stringContaining("/signed/photo.jpg") as unknown as string,
    );
    // The marker must not survive anywhere in the thread bubble.
    expect(screen.queryByText("[image]", { selector: "p" })).toBeNull();
  });

  it("keeps a real caption, which is the patient's own words", () => {
    renderInbox(
      baseData({
        messages: [
          message({ body: "ده تحليل الدم بتاعي", attachments: [attachment()] }),
        ],
      }),
    );
    expect(screen.getByText("ده تحليل الدم بتاعي")).toBeTruthy();
  });

  it("renders a video message with a player rather than a [video] bubble", () => {
    renderInbox(
      baseData({
        messages: [
          message({
            body: "[video]",
            attachments: [
              attachment({
                mediaKind: "video",
                mimeType: "video/mp4",
                fileName: "clip.mp4",
                durationSeconds: 12,
                url: "/signed/clip.mp4",
              }),
            ],
          }),
        ],
      }),
    );
    const player = screen.getByTestId("video-player");
    expect(player.tagName).toBe("VIDEO");
    // Long histories must not pull every clip on open.
    expect(player.getAttribute("preload")).toBe("metadata");
    expect(screen.queryByText("[video]", { selector: "p" })).toBeNull();
  });

  it("renders a document as a named, downloadable row", () => {
    renderInbox(
      baseData({
        messages: [
          message({
            body: "[document]",
            attachments: [
              attachment({
                mediaKind: "document",
                mimeType: "application/pdf",
                fileName: "report.pdf",
                url: "/signed/report.pdf",
              }),
            ],
          }),
        ],
      }),
    );
    expect(screen.getByText("report.pdf")).toBeTruthy();
    expect(screen.queryByText("[document]", { selector: "p" })).toBeNull();
  });

  it("renders a voice note with an audio player", () => {
    renderInbox(
      baseData({
        messages: [
          message({
            body: "[voice message]",
            attachments: [
              attachment({
                mediaKind: "audio",
                mimeType: "audio/ogg",
                fileName: null,
                voiceNote: true,
                durationSeconds: 7,
                url: "/api/inbox/voice/attachment-1",
              }),
            ],
          }),
        ],
      }),
    );
    expect(screen.getByTestId("voice-note-player")).toBeTruthy();
    expect(screen.queryByText("[voice message]", { selector: "p" })).toBeNull();
  });

  /**
   * The imported-history case. There are no bytes and there never will be, so
   * the only honest thing to show is a short sentence saying exactly that —
   * not "[image]", and not the generic storage-failure copy that invites a
   * pointless retry.
   */
  it("tells staff an old imported image is unavailable, in their own language", () => {
    const data = baseData({
      messages: [
        message({
          body: "[image]",
          attachments: [
            attachment({
              status: "rejected",
              failureReason: "historical_media_unavailable",
              byteSize: 0,
              url: null,
            }),
          ],
        }),
      ],
    });
    renderInbox(data);
    expect(screen.getByText(messages.inbox.attachments.historicalImage)).toBeTruthy();
    expect(screen.queryByText("[image]", { selector: "p" })).toBeNull();
  });

  it("names the right kind for an old imported voice message", () => {
    renderInbox(
      baseData({
        messages: [
          message({
            body: "[voice message]",
            attachments: [
              attachment({
                mediaKind: "audio",
                voiceNote: true,
                status: "rejected",
                failureReason: "historical_media_unavailable",
                url: null,
              }),
            ],
          }),
        ],
      }),
    );
    expect(screen.getByText(messages.inbox.attachments.historicalAudio)).toBeTruthy();
  });

  it("still says something when a message has no body and no attachment", () => {
    renderInbox(baseData({ messages: [message({ body: "" })] }));
    expect(screen.getByText(messages.inbox.noPreview)).toBeTruthy();
  });
});

describe("P11P — the conversation status badge", () => {
  it("shows one compact badge beside the contact name", () => {
    renderInbox();
    const badges = screen.getAllByTestId("conversation-status-badge");
    expect(badges.length).toBeGreaterThan(0);
    for (const badge of badges) {
      // 1–2 words, and never the internal enum.
      expect(badge.textContent!.trim().split(/\s+/).length).toBeLessThanOrEqual(2);
      expect(badge.textContent).not.toMatch(/ai_escalated_at|conversation_status|closed/);
    }
  });

  it("reads Done for a closed thread", () => {
    renderInbox(
      baseData({ conversations: [conversation({ status: "closed" })] }),
    );
    expect(screen.getAllByTestId("conversation-status-badge")[0]!.dataset.state).toBe("done");
    expect(screen.getAllByTestId("conversation-status-badge")[0]!.textContent).toContain("Done");
  });

  it("reads Needs review when the AI escalated", () => {
    renderInbox(
      baseData({
        conversations: [conversation({ escalatedAt: "2026-08-17T09:05:00.000Z" })],
      }),
    );
    expect(screen.getAllByTestId("conversation-status-badge")[0]!.dataset.state).toBe("needsReview");
  });

  it("reads Problem when an outbound message failed to deliver", () => {
    renderInbox(
      baseData({ conversations: [conversation({ hasDeliveryFailure: true })] }),
    );
    expect(screen.getAllByTestId("conversation-status-badge")[0]!.dataset.state).toBe("problem");
  });

  /**
   * P15 redefined this status. "Awaiting patient" used to mean *the clinic
   * spoke last*, which labelled every thread the assistant had just answered
   * as one nobody needed to look at. It now means *a patient message is
   * sitting unanswered in front of a person*, so it is the assistant's
   * enablement — not the message order — that produces it.
   */
  it("reads Awaiting patient when the assistant is off and the patient wrote last", () => {
    renderInbox(
      baseData({
        conversations: [
          conversation({
            // A linked thread: an unlinked one is a New contact, which outranks
            // "awaiting patient" — see the two cases below.
            patientId: "11111111-1111-4111-8111-111111111111",
            aiEnabled: false,
            lastInboundAt: "2026-08-17T10:00:00.000Z",
            lastMessageAt: "2026-08-17T10:00:00.000Z",
          }),
        ],
      }),
    );
    expect(screen.getAllByTestId("conversation-status-badge")[0]!.dataset.state).toBe("waitingPatient");
  });

  it("reads AI handling when the assistant is on and spoke last", () => {
    renderInbox(
      baseData({
        conversations: [
          conversation({
            patientId: "11111111-1111-4111-8111-111111111111",
            lastInboundAt: "2026-08-17T09:00:00.000Z",
            lastMessageAt: "2026-08-17T10:00:00.000Z",
          }),
        ],
      }),
    );
    expect(screen.getAllByTestId("conversation-status-badge")[0]!.dataset.state).toBe("aiHandling");
  });

  it("reads New contact for a live thread with no patient linked to it", () => {
    renderInbox(baseData({ conversations: [conversation({ patientId: null })] }));
    expect(screen.getAllByTestId("conversation-status-badge")[0]!.dataset.state).toBe("newContact");
  });

  it("still reads Needs review when a stranger's thread is genuinely escalated", () => {
    renderInbox(
      baseData({
        conversations: [
          conversation({ patientId: null, escalatedAt: "2026-08-17T09:05:00.000Z" }),
        ],
      }),
    );
    expect(screen.getAllByTestId("conversation-status-badge")[0]!.dataset.state).toBe("needsReview");
  });

  it("labels the badge from the catalog rather than from the enum", () => {
    renderInbox(baseData({ conversations: [conversation({ status: "closed" })] }));
    expect(screen.getAllByTestId("conversation-status-badge")[0]!.textContent).toContain(
      messages.inbox.statusBadge.done,
    );
  });
});


/**
 * P11Q — bulk selection must not tax the common case.
 *
 * The Inbox is read one conversation at a time. A checkbox on every row, all
 * day, would be permanent clutter charged to that case for the sake of the rare
 * one — so selection is a mode, and these tests pin that it stays one.
 */
describe("P11Q — bulk selection is opt-in", () => {
  it("shows no checkboxes or selection controls until asked", () => {
    renderInbox(baseData({ conversations: [conversation(), conversation({ id: "conversation-2" })] }));
    expect(screen.queryAllByTestId("bulk-selectable-row")).toHaveLength(0);
    expect(screen.queryByTestId("bulk-selected-count")).toBeNull();
    expect(screen.queryByTestId("bulk-compose")).toBeNull();
    // Only the entry point is present.
    expect(screen.getByTestId("bulk-start-selecting")).toBeTruthy();
  });

  it("turns rows into selectable ones only in selection mode", async () => {
    const user = userEvent.setup();
    renderInbox(baseData({ conversations: [conversation(), conversation({ id: "conversation-2" })] }));
    await user.click(screen.getByTestId("bulk-start-selecting"));
    expect(screen.getAllByTestId("bulk-selectable-row")).toHaveLength(2);
  });

  it("counts the selection and refuses to compose with nobody selected", async () => {
    const user = userEvent.setup();
    renderInbox(baseData({ conversations: [conversation(), conversation({ id: "conversation-2" })] }));
    await user.click(screen.getByTestId("bulk-start-selecting"));
    expect(screen.getByTestId("bulk-compose")).toBeDisabled();

    await user.click(screen.getAllByTestId("bulk-selectable-row")[0]!);
    expect(screen.getByTestId("bulk-selected-count").textContent).toContain("1");
    expect(screen.getByTestId("bulk-compose")).not.toBeDisabled();
  });

  it("toggles a row off again, so a misclick is recoverable", async () => {
    const user = userEvent.setup();
    renderInbox(baseData({ conversations: [conversation()] }));
    await user.click(screen.getByTestId("bulk-start-selecting"));
    const row = screen.getAllByTestId("bulk-selectable-row")[0]!;
    await user.click(row);
    expect(row.getAttribute("aria-checked")).toBe("true");
    await user.click(row);
    expect(screen.getAllByTestId("bulk-selectable-row")[0]!.getAttribute("aria-checked")).toBe("false");
  });

  it("leaves selection mode cleanly on cancel", async () => {
    const user = userEvent.setup();
    renderInbox(baseData({ conversations: [conversation()] }));
    await user.click(screen.getByTestId("bulk-start-selecting"));
    await user.click(screen.getAllByTestId("bulk-selectable-row")[0]!);
    await user.click(screen.getByTestId("bulk-cancel"));
    expect(screen.queryAllByTestId("bulk-selectable-row")).toHaveLength(0);
    expect(screen.getByTestId("bulk-start-selecting")).toBeTruthy();
  });
});
