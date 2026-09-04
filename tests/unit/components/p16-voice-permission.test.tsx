import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "@/messages/en.json";
import ar from "@/messages/ar.json";
import type { InboxConversation } from "@/lib/messaging/inbox";

/**
 * P16 — "Microphone access was not granted."
 *
 * That single toast was the whole of what a receptionist was told when voice
 * notes stopped working, and it faded in four seconds. It named no cause and no
 * remedy, and it was shown identically whether the *site* permission was
 * blocked, the operating system had blocked the browser, or the page was being
 * served over plain HTTP where no browser will ever hand over a microphone.
 *
 * The permission state was already being read — into a development-only console
 * line. These tests pin it being read into the *answer*: the granted path still
 * records, and each way of being refused gets its own persistent, localized,
 * actionable explanation. Nothing here ever reports success the browser did not
 * give.
 */

const mocks = vi.hoisted(() => ({
  prepareUpload: vi.fn(),
  prepareDocument: vi.fn(),
  discard: vi.fn(),
  send: vi.fn(),
  open: vi.fn(),
  refreshContacts: vi.fn(),
  push: vi.fn(),
  refresh: vi.fn(),
  toastError: vi.fn(),
}));
const audioMocks = vi.hoisted(() => ({
  createMonitor: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }),
}));
vi.mock("@/actions/messaging", () => ({
  prepareInboxMediaUpload: mocks.prepareUpload,
  prepareInboxExistingDocument: mocks.prepareDocument,
  discardInboxMedia: mocks.discard,
  sendInboxReply: mocks.send,
  openNewWhatsAppConversation: mocks.open,
  refreshInboxContacts: mocks.refreshContacts,
}));
vi.mock("sonner", () => ({ toast: { error: mocks.toastError, success: vi.fn() } }));
vi.mock("@/lib/messaging/browser-audio", () => ({
  createAudioCaptureMonitor: audioMocks.createMonitor,
  hasLiveAudioSignal: () => true,
}));

import { InboxComposer } from "@/components/inbox/inbox-composer";

const conversation: InboxConversation = {
  id: "conversation-1",
  channel: "whatsapp",
  status: "open",
  patientId: "patient-1",
  patientName: "Mona Ali",
  patientPhone: "+20100000000",
  patientFileNumber: "CF-1",
  displayName: "Mona",
  sender: "+20100000000",
  assignedTo: null,
  assignedName: null,
  lastMessageAt: null,
  lastInboundAt: null,
  windowExpiresAt: null,
  identityVerifiedAt: null,
  escalatedAt: null,
  escalationReason: null,
  aiPausedAt: null,
  aiPausedByName: null,
  preview: "",
  unreadCount: 0,
};

function renderComposer() {
  return render(
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      <InboxComposer
        conversation={conversation}
        templates={[]}
        documents={[]}
        provider="linked_device"
        windowOpen
      />
    </NextIntlClientProvider>,
  );
}

type Environment = {
  secureContext?: boolean;
  /** `null` models a browser with no Permissions API for the microphone. */
  permission?: PermissionState | null;
  getUserMedia?: ReturnType<typeof vi.fn>;
  /** `false` models a browser exposing no recordable container. */
  recorderSupported?: boolean;
  /** `false` models `navigator.mediaDevices` being absent entirely. */
  mediaDevicesAvailable?: boolean;
};

function installMicrophone({
  secureContext = true,
  permission = "prompt",
  getUserMedia,
  recorderSupported = true,
  mediaDevicesAvailable = true,
}: Environment = {}) {
  const track = Object.assign(new EventTarget(), {
    kind: "audio",
    readyState: "live" as MediaStreamTrackState,
    enabled: true,
    muted: false,
    stop: vi.fn(),
    getSettings: () => ({ deviceId: "default-device", channelCount: 1, sampleRate: 48_000 }),
  });
  const stream = {
    getAudioTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream;

  const grant = getUserMedia ?? vi.fn(async () => stream);
  const enumerateDevices = vi.fn(async () => [
    { kind: "audioinput", deviceId: "default-device", groupId: "g1", label: "MacBook Microphone" },
  ] as unknown as MediaDeviceInfo[]);
  const mediaDevices = Object.assign(new EventTarget(), {
    getUserMedia: grant,
    enumerateDevices,
  }) as unknown as EventTarget & MediaDevices;

  Object.defineProperty(window, "isSecureContext", {
    configurable: true,
    value: secureContext,
  });
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: mediaDevicesAvailable ? mediaDevices : undefined,
  });
  Object.defineProperty(navigator, "permissions", {
    configurable: true,
    value: {
      query: vi.fn(async () => {
        if (permission === null) throw new TypeError("microphone is not a valid PermissionName");
        return { state: permission } as PermissionStatus;
      }),
    },
  });

  class FakeMediaRecorder extends EventTarget {
    static isTypeSupported() {
      return recorderSupported;
    }
    state: RecordingState = "inactive";
    start() {
      this.state = "recording";
    }
    stop() {
      this.state = "inactive";
    }
  }
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);

  return { getUserMedia: grant, stream };
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  audioMocks.createMonitor.mockResolvedValue({
    inspect: vi.fn(),
    getLiveInspection: () => ({
      observedSampleCount: 48_000,
      peak: 0.4,
      rms: 0.2,
      maxWindowRms: 0.2,
      activeVoiceSeconds: 1,
      audible: true,
    }),
    resetLiveInspection: vi.fn(),
    close: vi.fn(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("P16 — the granted path still records", () => {
  it("asks the browser normally and opens the recorder when permission is granted", async () => {
    const { getUserMedia } = installMicrophone({ permission: "prompt" });
    renderComposer();

    await userEvent.click(screen.getByRole("button", { name: "Record voice" }));

    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));
    await screen.findByText(en.inbox.composer.microphoneReady);
    // Timer/cancel affordances survive: the recorder lifecycle is untouched.
    expect(screen.getByRole("button", { name: /Cancel/i })).toBeTruthy();
    expect(screen.queryByTestId("microphone-permission-notice")).toBeNull();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("asks even when the browser cannot report a permission state", async () => {
    // Safari has no `permissions.query` for the microphone. That is not a
    // refusal, and the request must still be made.
    const { getUserMedia } = installMicrophone({ permission: null });
    renderComposer();

    await userEvent.click(screen.getByRole("button", { name: "Record voice" }));
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("microphone-permission-notice")).toBeNull();
  });
});

describe("P16 — the Permissions API never vetoes the media request", () => {
  it("records when getUserMedia succeeds even though the API reports denied", async () => {
    // The reported bug. Chrome on macOS can report the site record as `denied`
    // — or hold a stale one across a permission reset — while a real
    // `getUserMedia` call prompts and succeeds. The request is the authority.
    const { getUserMedia } = installMicrophone({ permission: "denied" });
    renderComposer();

    await userEvent.click(screen.getByRole("button", { name: "Record voice" }));

    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));
    await screen.findByText(en.inbox.composer.microphoneReady);
    expect(screen.queryByTestId("microphone-permission-notice")).toBeNull();
    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(audioMocks.createMonitor).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: /Cancel/i })).toBeTruthy();
  });

  it("offers a retry that asks the browser again", async () => {
    const getUserMedia = vi.fn(async () => {
      throw new DOMException("Permission denied", "NotAllowedError");
    });
    installMicrophone({ permission: "denied", getUserMedia });
    renderComposer();
    await userEvent.click(screen.getByRole("button", { name: "Record voice" }));
    await screen.findByTestId("microphone-permission-notice");

    // The staff member has now allowed it in the browser's own UI.
    const { getUserMedia: granted } = installMicrophone({ permission: "granted" });
    await userEvent.click(screen.getByRole("button", { name: en.inbox.composer.microphoneRetry }));

    await waitFor(() => expect(granted).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.queryByTestId("microphone-permission-notice")).toBeNull(),
    );
  });
});

describe("P16 — a refusal is explained, in the interface language", () => {
  it("names the site permission only when the browser confirms it is denied", async () => {
    const getUserMedia = vi.fn(async () => {
      throw new DOMException("Permission denied", "NotAllowedError");
    });
    installMicrophone({ permission: "denied", getUserMedia });
    renderComposer();

    await userEvent.click(screen.getByRole("button", { name: "Record voice" }));

    const notice = await screen.findByTestId("microphone-permission-notice");
    expect(notice.textContent).toContain(en.inbox.composer.microphoneDeniedHelp);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(audioMocks.createMonitor).not.toHaveBeenCalled();
    expect(screen.queryByRole("meter", { name: "Live microphone level" })).toBeNull();
  });

  it("does not blame the site permission when nothing confirms it", async () => {
    // `granted` + `NotAllowedError` is precisely the state that was being
    // mislabeled "your browser is blocking microphone access for this site",
    // sending staff to a setting that was already correct.
    const getUserMedia = vi.fn(async () => {
      throw new DOMException("Denied", "NotAllowedError");
    });
    installMicrophone({ permission: "granted", getUserMedia });
    renderComposer();

    await userEvent.click(screen.getByRole("button", { name: "Record voice" }));

    const notice = await screen.findByTestId("microphone-permission-notice");
    expect(notice.textContent).toContain(en.inbox.composer.microphoneBlockedUnknown);
    expect(notice.textContent).not.toContain(en.inbox.composer.microphoneDeniedHelp);
  });

  it("does not blame the site permission when the browser cannot report one", async () => {
    const getUserMedia = vi.fn(async () => {
      throw new DOMException("Denied", "NotAllowedError");
    });
    installMicrophone({ permission: null, getUserMedia });
    renderComposer();

    await userEvent.click(screen.getByRole("button", { name: "Record voice" }));

    const notice = await screen.findByTestId("microphone-permission-notice");
    expect(notice.textContent).toContain(en.inbox.composer.microphoneBlockedUnknown);
  });

  it("names the operating system when Chrome says the system refused", async () => {
    const getUserMedia = vi.fn(async () => {
      throw new DOMException("Permission denied by system", "NotAllowedError");
    });
    installMicrophone({ permission: "granted", getUserMedia });
    renderComposer();

    await userEvent.click(screen.getByRole("button", { name: "Record voice" }));

    const notice = await screen.findByTestId("microphone-permission-notice");
    expect(notice.textContent).toContain(en.inbox.composer.microphoneBlockedBySystem);
  });

  it("says no microphone was found rather than naming a permission", async () => {
    const getUserMedia = vi.fn(async () => {
      throw new DOMException("Requested device not found", "NotFoundError");
    });
    installMicrophone({ permission: "granted", getUserMedia });
    renderComposer();

    await userEvent.click(screen.getByRole("button", { name: "Record voice" }));

    const notice = await screen.findByTestId("microphone-permission-notice");
    expect(notice.textContent).toContain(en.inbox.composer.microphoneNotFoundHelp);
  });

  it("says the device could not be opened when it is busy", async () => {
    const getUserMedia = vi.fn(async () => {
      throw new DOMException("Could not start audio source", "NotReadableError");
    });
    installMicrophone({ permission: "granted", getUserMedia });
    renderComposer();

    await userEvent.click(screen.getByRole("button", { name: "Record voice" }));

    const notice = await screen.findByTestId("microphone-permission-notice");
    expect(notice.textContent).toContain(en.inbox.composer.microphoneBusyHelp);
  });

  it("says the browser cannot record when no container is supported", async () => {
    const { getUserMedia } = installMicrophone({ recorderSupported: false });
    renderComposer();

    await userEvent.click(screen.getByRole("button", { name: "Record voice" }));

    const notice = await screen.findByTestId("microphone-permission-notice");
    expect(notice.textContent).toContain(en.inbox.composer.microphoneUnsupportedHelp);
    expect(getUserMedia).not.toHaveBeenCalled();
    // Retrying cannot install a codec.
    expect(
      screen.queryByRole("button", { name: en.inbox.composer.microphoneRetry }),
    ).toBeNull();
  });

  it("treats a missing mediaDevices as the environment problem it is", async () => {
    installMicrophone({ mediaDevicesAvailable: false });
    renderComposer();

    await userEvent.click(screen.getByRole("button", { name: "Record voice" }));

    const notice = await screen.findByTestId("microphone-permission-notice");
    expect(notice.textContent).toContain(en.inbox.composer.microphoneInsecureContext);
  });

  it("names the operating system when the site permission is still unset", async () => {
    // macOS blocking the browser itself: `getUserMedia` refuses while the site
    // permission is untouched. Sending staff to the address bar there is the
    // wrong screen.
    const getUserMedia = vi.fn(async () => {
      throw new DOMException("Denied", "NotAllowedError");
    });
    installMicrophone({ permission: "prompt", getUserMedia });
    renderComposer();

    await userEvent.click(screen.getByRole("button", { name: "Record voice" }));

    const notice = await screen.findByTestId("microphone-permission-notice");
    expect(notice.textContent).toContain(en.inbox.composer.microphoneBlockedBySystem);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("says so plainly when the page is not a secure context", async () => {
    const { getUserMedia } = installMicrophone({ secureContext: false });
    renderComposer();

    await userEvent.click(screen.getByRole("button", { name: "Record voice" }));

    const notice = await screen.findByTestId("microphone-permission-notice");
    expect(notice.textContent).toContain(en.inbox.composer.microphoneInsecureContext);
    // No retry is offered for something clicking cannot fix.
    expect(
      screen.queryByRole("button", { name: en.inbox.composer.microphoneRetry }),
    ).toBeNull();
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("carries every explanation in Arabic as well as English", () => {
    // The component translator is pinned to English suite-wide (see
    // `tests/unit/setup.ts`), so the Arabic half is asserted on the catalog.
    for (const key of [
      "microphoneDeniedTitle",
      "microphoneDeniedHelp",
      "microphoneBlockedBySystem",
      "microphoneBlockedUnknown",
      "microphoneNotFoundHelp",
      "microphoneBusyHelp",
      "microphoneUnsupportedHelp",
      "microphoneUnknownHelp",
      "microphoneInsecureContext",
      "microphoneRetry",
      "microphoneDismiss",
    ] as const) {
      expect(en.inbox.composer[key], `en.${key}`).toBeTruthy();
      expect(ar.inbox.composer[key], `ar.${key}`).toBeTruthy();
      // Arabic copy that is still English is the failure this asserts against.
      expect(ar.inbox.composer[key]).not.toBe(en.inbox.composer[key]);
      expect(ar.inbox.composer[key]).toMatch(/[؀-ۿ]/);
    }
  });
});
