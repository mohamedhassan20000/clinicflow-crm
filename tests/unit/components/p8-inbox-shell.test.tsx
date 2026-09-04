import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import messages from "@/messages/en.json";
import type { InboxData } from "@/lib/messaging/inbox";

/**
 * P8 §2, §6, §7, §8 — the Inbox a clinic actually uses.
 *
 * The regression this file exists for is specific: an AI reply arrived complete
 * on the patient's phone and appeared cut off in the Inbox, because the thread
 * rendered `outbound_messages.body_preview` — a deliberately redacted 120-character
 * summary. The fix is in the data layer, so the assertion here is the one that
 * would have caught it: a long Arabic reply is present in the DOM *in full*, with
 * nothing clamping it.
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
  setConversationHumanTakeover: vi.fn(async () => ({ success: true })),
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
  setConversationHumanTakeover: mocks.setConversationHumanTakeover,
  updateConversationAssignment: vi.fn(),
  updateConversationStatus: vi.fn(),
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

/**
 * A real-shaped AI answer: several paragraphs of Arabic, well past the 120
 * characters the redacted preview column can hold.
 */
const LONG_ARABIC_REPLY = [
  "أهلاً بحضرتك! يسعدني مساعدتك في حجز موعد مع دكتور أحمد في عيادتنا.",
  "المواعيد المتاحة بكرا هي: الساعة ١٠:٠٠ صباحاً، والساعة ١٢:٣٠ ظهراً، والساعة ٥:٠٠ مساءً.",
  "لو أي من دي مناسب لحضرتك، قولي وأنا أسجّل طلب الحجز فوراً، وهيكون طلب مبدئي لحد ما موظفي العيادة يأكدوه.",
  "لو مش مناسب، ممكن أشوف لحضرتك مواعيد يوم تاني قريب.",
].join("\n\n");

const REDACTED_PREVIEW = "أهلاً بحضرتك! يسعدني مساعدتك في حجز موعد مع دكتور أحمد في عيادتنا. المواعيد المتاحة بك…";

function baseData(overrides: Partial<InboxData> = {}): InboxData {
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
        preview: REDACTED_PREVIEW,
        unreadCount: 0,
      },
    ],
    messages: [
      {
        id: "inbound-1",
        direction: "inbound",
        body: "عايز احجز بكرا مع دكتور أحمد أول معاد متاح",
        occurredAt: "2026-08-17T09:00:00.000Z",
        status: null,
        templateId: null,
        attachments: [],
      },
      {
        id: "outbound-1",
        direction: "outbound",
        body: LONG_ARABIC_REPLY,
        occurredAt: "2026-08-17T09:00:30.000Z",
        status: "sent",
        templateId: null,
        attachments: [],
      },
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

function renderInbox(data: InboxData = baseData()) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <InboxShell data={data} clinicId="clinic-1" viewerId="receptionist-1" />
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, {
    status: 200,
    headers: {
      "content-type": "audio/ogg",
      "content-length": "12000",
      "accept-ranges": "bytes",
    },
  })));
});

describe("P8 — the open conversation shows the whole message", () => {
  it("renders a long Arabic AI reply in full, not the redacted preview", () => {
    renderInbox();
    const bubble = screen.getByText((_, element) => element?.textContent === LONG_ARABIC_REPLY);
    expect(bubble).toBeTruthy();
    // Every paragraph, including the last one, which sits far past the 120
    // characters the conversation-list preview is capped at.
    for (const paragraph of LONG_ARABIC_REPLY.split("\n\n")) {
      expect(bubble.textContent).toContain(paragraph);
    }
    expect(bubble.textContent).toHaveLength(LONG_ARABIC_REPLY.length);
  });

  it("does not clamp, truncate or hide the overflow of a message bubble", () => {
    renderInbox();
    const bubble = screen.getByText((_, element) => element?.textContent === LONG_ARABIC_REPLY);
    const className = bubble.className;
    expect(className).not.toMatch(/line-clamp/);
    expect(className).not.toMatch(/truncate/);
    expect(className).not.toMatch(/max-h-/);
    expect(className).not.toMatch(/overflow-hidden/);
    // What it *does* have: preserved paragraph breaks and a wrap rule that
    // breaks an unspaced string instead of widening the bubble.
    expect(className).toMatch(/whitespace-pre-wrap/);
    expect(className).toMatch(/wrap-anywhere/);
  });

  it("lets each message pick its own direction so Arabic and English both read correctly", () => {
    renderInbox();
    const arabic = screen.getByText((_, element) => element?.textContent === LONG_ARABIC_REPLY);
    expect(arabic.getAttribute("dir")).toBe("auto");
  });

  it("keeps the conversation-list preview short", () => {
    renderInbox();
    // The list is a summary and stays one; only the opened thread is full.
    expect(screen.getByText(REDACTED_PREVIEW)).toBeTruthy();
  });
});

describe("P8 — WhatsApp contact names", () => {
  it("shows the WhatsApp display name for a contact with no patient record", () => {
    renderInbox();
    expect(screen.getAllByText("Fatima Ahmed").length).toBeGreaterThan(0);
    // The number remains the identity, and stays left-to-right so it is not
    // reordered by the surrounding script.
    const phone = screen.getByText("+201111111111");
    expect(phone.getAttribute("dir")).toBe("ltr");
  });

  it("prefers the patient record once one is linked, keeping the WhatsApp name as context", () => {
    const data = baseData();
    data.conversations[0]!.patientId = "patient-1";
    data.conversations[0]!.patientName = "Fatima Mahmoud Ahmed";
    renderInbox(data);
    expect(screen.getAllByText("Fatima Mahmoud Ahmed").length).toBeGreaterThan(0);
    expect(screen.getByText(/WhatsApp name: Fatima Ahmed/)).toBeTruthy();
  });
});

describe("P8 — human takeover", () => {
  it("offers a Pause AI control and calls the takeover action", async () => {
    const user = userEvent.setup();
    renderInbox();
    const button = screen.getByRole("button", { name: /Pause AI/i });
    expect(button.getAttribute("aria-pressed")).toBe("false");
    await user.click(button);
    await waitFor(() => {
      expect(mocks.setConversationHumanTakeover).toHaveBeenCalledWith({
        conversationId: "conversation-1",
        paused: true,
      });
    });
  });

  it("shows the paused state clearly and offers resuming", async () => {
    const data = baseData();
    data.conversations[0]!.aiPausedAt = "2026-08-17T09:05:00.000Z";
    data.conversations[0]!.aiPausedByName = "Reception User";
    renderInbox(data);

    expect(screen.getByTestId("ai-paused-banner").textContent).toContain("Reception User");
    expect(screen.getAllByText("AI paused").length).toBeGreaterThan(0);
    const resume = screen.getAllByRole("button", { name: /Resume AI/i })[0]!;
    expect(resume.getAttribute("aria-pressed") ?? "true").toBeTruthy();

    const user = userEvent.setup();
    await user.click(resume);
    await waitFor(() => {
      expect(mocks.setConversationHumanTakeover).toHaveBeenCalledWith({
        conversationId: "conversation-1",
        paused: false,
      });
    });
  });

  it("labels an AI draft as unsent while a human has the conversation", () => {
    const data = baseData();
    data.conversations[0]!.aiPausedAt = "2026-08-17T09:05:00.000Z";
    data.suggestion = {
      id: "suggestion-1",
      conversationId: "conversation-1",
      body: LONG_ARABIC_REPLY,
      escalate: false,
      escalationReason: null,
      createdAt: "2026-08-17T09:06:00.000Z",
    };
    renderInbox(data);
    expect(screen.getByText(/AI draft \(not sent — human takeover\)/)).toBeTruthy();
  });
});

describe("P8 — patient attachments in the thread", () => {
  it("renders a stored image inline with a link to the full size", () => {
    const data = baseData();
    data.messages[0]!.attachments = [
      {
        id: "attachment-1",
        mediaKind: "image",
        voiceNote: false,
        durationSeconds: null,
        mimeType: "image/jpeg",
        fileName: "rash.jpg",
        byteSize: 51_200,
        status: "stored",
        failureReason: null,
        url: "https://storage.test/signed/rash.jpg",
      },
    ];
    renderInbox(data);
    const image = screen.getByRole("img", { name: "rash.jpg" }) as HTMLImageElement;
    expect(image.src).toBe("https://storage.test/signed/rash.jpg");
    expect(image.getAttribute("loading")).toBe("lazy");
    const link = screen.getByRole("link", { name: /Open full-size image/i });
    expect(link.getAttribute("rel")).toContain("noopener");
  });

  it("renders a stored document as a downloadable row", () => {
    const data = baseData();
    data.messages[0]!.attachments = [
      {
        id: "attachment-2",
        mediaKind: "document",
        voiceNote: false,
        durationSeconds: null,
        mimeType: "application/pdf",
        fileName: "تحليل الدم.pdf",
        byteSize: 204_800,
        status: "stored",
        failureReason: null,
        url: "https://storage.test/signed/report.pdf",
      },
    ];
    renderInbox(data);
    const name = screen.getByText("تحليل الدم.pdf");
    // A filename is user content in an unknown script; the browser decides.
    expect(name.getAttribute("dir")).toBe("auto");
    expect(screen.getByText("200 KB")).toBeTruthy();
  });

  it("tells staff what happened instead of showing a broken file", () => {
    const data = baseData();
    data.messages[0]!.attachments = [
      {
        id: "attachment-3",
        mediaKind: "unsupported",
        voiceNote: false,
        durationSeconds: null,
        mimeType: "video/mp4",
        fileName: null,
        byteSize: 0,
        status: "rejected",
        failureReason: "kind_not_stored",
        url: null,
      },
    ];
    renderInbox(data);
    // P11P: video is stored from now on, so this sentence describes the rows
    // that predate that rather than a standing limitation. The guarantee under
    // test is unchanged — a refused file explains itself and never renders as a
    // broken image.
    expect(screen.getByTestId("attachment-unavailable").textContent).toMatch(/video/i);
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("keeps the message text when its attachment could not be stored", () => {
    const data = baseData();
    data.messages[0]!.attachments = [
      {
        id: "attachment-4",
        mediaKind: "image",
        voiceNote: false,
        durationSeconds: null,
        mimeType: "image/jpeg",
        fileName: "x-ray.jpg",
        byteSize: 0,
        status: "failed",
        failureReason: "download_failed",
        url: null,
      },
    ];
    renderInbox(data);
    expect(screen.getByText("عايز احجز بكرا مع دكتور أحمد أول معاد متاح")).toBeTruthy();
    expect(screen.getByTestId("attachment-unavailable")).toBeTruthy();
  });

  it("renders a stored PTT voice note through the stable endpoint and probes safe headers", async () => {
    const diagnostic = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const data = baseData();
    data.messages[0]!.body = "[voice message]";
    data.messages[0]!.attachments = [
      {
        id: "attachment-voice",
        mediaKind: "audio",
        voiceNote: true,
        durationSeconds: 9,
        mimeType: "audio/ogg; codecs=opus",
        fileName: null,
        byteSize: 12_000,
        status: "stored",
        failureReason: null,
        url: "/api/inbox/voice/00000000-0000-4000-8000-000000000001",
      },
    ];
    renderInbox(data);
    const player = screen.getByTestId("voice-note-player");
    expect(player).toHaveAttribute("aria-label", "Play voice note");
    expect(player).toHaveAttribute(
      "src",
      "/api/inbox/voice/00000000-0000-4000-8000-000000000001",
    );
    expect(screen.getByText("· 0:09")).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      "/api/inbox/voice/00000000-0000-4000-8000-000000000001",
      expect.objectContaining({ method: "HEAD", credentials: "same-origin" }),
    ));
    expect(diagnostic).toHaveBeenCalledWith("voice_playback_load", expect.objectContaining({
      stage: "http_probe",
      httpStatus: 200,
      responseMime: "audio/ogg",
      responseByteCount: 12_000,
      acceptRanges: "bytes",
      errorCategory: null,
    }));
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("/api/inbox/voice/");
    diagnostic.mockRestore();
  });

  it("renders ordinary audio with its filename and a distinct audio label", () => {
    const data = baseData();
    data.messages[0]!.body = "[audio]";
    data.messages[0]!.attachments = [
      {
        id: "attachment-audio",
        mediaKind: "audio",
        voiceNote: false,
        durationSeconds: 65,
        mimeType: "audio/mpeg",
        fileName: "consultation.mp3",
        byteSize: 48_000,
        status: "stored",
        failureReason: null,
        url: "https://storage.test/signed/consultation.mp3",
      },
    ];
    renderInbox(data);
    expect(screen.getByText("consultation.mp3")).toHaveAttribute("dir", "auto");
    expect(screen.getByTestId("audio-player")).toHaveAttribute("aria-label", "Play audio");
    expect(screen.getByText("· 1:05")).toBeTruthy();
  });

  it("renders a freshly sent ClinicFlow voice note from its private signed URL", () => {
    const data = baseData();
    data.messages[0]!.direction = "outbound";
    data.messages[0]!.body = "";
    data.messages[0]!.attachments = [
      {
        id: "outbound-voice",
        mediaKind: "audio",
        voiceNote: true,
        durationSeconds: null,
        mimeType: "audio/webm",
        fileName: "voice-note.webm",
        byteSize: 24_000,
        status: "stored",
        failureReason: null,
        url: "https://storage.test/private-signed/outbound-voice.webm",
      },
    ];

    renderInbox(data);
    const player = screen.getByTestId("voice-note-player");
    expect(player).toHaveAttribute("aria-label", "Play voice note");
    expect(player).toHaveAttribute(
      "src",
      "https://storage.test/private-signed/outbound-voice.webm",
    );
  });
});
