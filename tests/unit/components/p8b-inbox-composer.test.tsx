import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import messages from "@/messages/en.json";
import type { InboxConversation } from "@/lib/messaging/inbox";

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
  inspect: vi.fn(),
  close: vi.fn(),
  resetLiveInspection: vi.fn(),
  createMonitor: vi.fn(),
  getLiveInspection: vi.fn(),
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
vi.mock("sonner", () => ({
  toast: { error: mocks.toastError, success: vi.fn() },
}));
vi.mock("@/lib/messaging/browser-audio", () => ({
  createAudioCaptureMonitor: audioMocks.createMonitor,
  hasLiveAudioSignal: (inspection: { peak: number; rms: number; maxWindowRms: number }) =>
    inspection.peak >= 0.001 || inspection.rms >= 0.0001 || inspection.maxWindowRms >= 0.0001,
}));

import { InboxComposer } from "@/components/inbox/inbox-composer";
import { NewConversationDialog } from "@/components/inbox/new-conversation-dialog";

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

function provider(children: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      {children}
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  mocks.send.mockResolvedValue({ success: true });
  mocks.discard.mockResolvedValue({ success: true });
  audioMocks.inspect.mockResolvedValue({
    durationSeconds: 1,
    decodedSampleCount: 48_000,
    observedSampleCount: 48_000,
    peak: 0.2,
    rms: 0.05,
    maxWindowRms: 0.06,
    activeVoiceSeconds: 0.8,
    audible: true,
    validationMode: "decoded_pcm",
  });
  audioMocks.getLiveInspection.mockReturnValue({
    observedSampleCount: 4_096,
    peak: 0.2,
    rms: 0.05,
    maxWindowRms: 0.06,
    activeVoiceSeconds: 0.1,
    audible: true,
  });
  audioMocks.close.mockResolvedValue(undefined);
  audioMocks.createMonitor.mockResolvedValue({
    inspect: audioMocks.inspect,
    close: audioMocks.close,
    resetLiveInspection: audioMocks.resetLiveInspection,
    getLiveInspection: audioMocks.getLiveInspection,
  });
});

describe("P8B Inbox composer", () => {
  function installRecorder({
    muted = false,
    playableTypes = ["audio/webm", "audio/mp4"],
    devices = [{
      kind: "audioinput",
      deviceId: "default-device",
      groupId: "group-1",
      label: "MacBook Microphone",
    }],
  }: {
    muted?: boolean;
    playableTypes?: string[];
    devices?: Array<{
      kind: string;
      deviceId: string;
      groupId: string;
      label: string;
    }>;
  } = {}) {
    Object.defineProperty(HTMLMediaElement.prototype, "canPlayType", {
      configurable: true,
      value: vi.fn((type: string) =>
        playableTypes.some((playable) => type.toLowerCase().startsWith(playable))
          ? "probably"
          : ""),
    });
    let availableDevices = devices;
    const stopTracks: Array<ReturnType<typeof vi.fn>> = [];
    const streams: MediaStream[] = [];
    const mediaDevices = new EventTarget() as EventTarget & MediaDevices;
    const enumerateDevices = vi.fn(async () => availableDevices as MediaDeviceInfo[]);
    const getUserMedia = vi.fn(async (constraints: MediaStreamConstraints) => {
      const audio = constraints.audio as MediaTrackConstraints;
      const exactDevice = typeof audio?.deviceId === "object" && "exact" in audio.deviceId
        ? String(audio.deviceId.exact)
        : null;
      if (exactDevice && !availableDevices.some((device) => device.deviceId === exactDevice)) {
        throw new DOMException("Missing microphone", "OverconstrainedError");
      }
      const activeDeviceId = exactDevice ?? availableDevices[0]?.deviceId ?? "browser-default";
      const stopTrack = vi.fn();
      stopTracks.push(stopTrack);
      const track = Object.assign(new EventTarget(), {
        kind: "audio",
        readyState: "live" as MediaStreamTrackState,
        enabled: true,
        muted,
        stop: stopTrack,
        getSettings: () => ({
          deviceId: activeDeviceId,
          channelCount: 1,
          sampleRate: 48_000,
          echoCancellation: true,
        }),
      });
      const stream = {
        getAudioTracks: () => [track],
        getTracks: () => [track],
      } as unknown as MediaStream;
      streams.push(stream);
      return stream;
    });
    Object.assign(mediaDevices, { getUserMedia, enumerateDevices });
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: mediaDevices,
    });
    class FakeMediaRecorder extends EventTarget {
      static isTypeSupported() { return true; }
      readonly mimeType: string;
      state: RecordingState = "inactive";
      constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
        super();
        this.mimeType = options?.mimeType || "audio/webm;codecs=opus";
      }
      start() { this.state = "recording"; }
      stop() {
        this.state = "inactive";
        this.dispatchEvent(new BlobEvent("dataavailable", {
          data: new Blob(["recorded-audio"], { type: this.mimeType }),
        }));
        this.dispatchEvent(new Event("stop"));
      }
    }
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    return {
      enumerateDevices,
      getUserMedia,
      mediaDevices,
      setDevices(nextDevices: typeof devices) {
        availableDevices = nextDevices;
      },
      stopTracks,
      streams,
    };
  }

  it("reuses a linked-device draft template as editable rendered text", async () => {
    const user = userEvent.setup();
    provider(
      <InboxComposer
        conversation={conversation}
        templates={[{
          id: "template-1",
          name: "appointment_ready",
          language: "en",
          body: "Hello {{patient_name}}, your appointment is ready.",
          variableNames: ["patient_name"],
          approvalStatus: "draft",
        }]}
        documents={[]}
        provider="linked_device"
        windowOpen={false}
      />,
    );

    await user.click(screen.getByRole("combobox", { name: "Choose an approved template" }));
    await user.click(screen.getByRole("option", { name: /appointment_ready/i }));
    const variable = screen.getByRole("textbox", { name: "Value for patient_name" });
    expect(variable).toHaveValue("Mona Ali");
    await user.click(screen.getByRole("button", { name: "Insert editable text" }));
    expect(screen.getByRole("textbox", { name: "Reply message" })).toHaveValue(
      "Hello Mona Ali, your appointment is ready.",
    );
    expect(screen.queryByText("The 24-hour service window is closed")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Attach file" })).toBeEnabled();
    expect(screen.queryByText("Media requires linked device")).not.toBeInTheDocument();
    await user.clear(screen.getByRole("textbox", { name: "Reply message" }));
    await user.type(screen.getByRole("textbox", { name: "Reply message" }), "Edited before send");
    expect(screen.getByRole("textbox", { name: "Reply message" })).toHaveValue("Edited before send");
  });

  it("prepares a local file, exposes a ready state, and sends only its opaque media id", async () => {
    mocks.prepareUpload.mockResolvedValue({
      success: true,
      media: {
        id: "media-1",
        fileName: "scan.pdf",
        mimeType: "application/pdf",
        kind: "document",
        byteSize: 8,
      },
    });
    const view = provider(
      <InboxComposer
        conversation={conversation}
        templates={[]}
        documents={[]}
        provider="linked_device"
        windowOpen={false}
      />,
    );

    const input = view.container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["%PDF-1.7"], "scan.pdf", { type: "application/pdf" });
    fireEvent.change(input, { target: { files: [file] } });

    expect(await screen.findByText("Ready to send")).toBeInTheDocument();
    const form = mocks.prepareUpload.mock.calls[0]![0] as FormData;
    expect(form.get("conversationId")).toBe("conversation-1");
    expect(form.get("source")).toBe("upload");
    expect(form.get("file")).toBe(file);

    await userEvent.click(screen.getByRole("button", { name: "Send reply" }));
    await waitFor(() => {
      expect(mocks.send).toHaveBeenCalledWith({
        conversationId: "conversation-1",
        body: "",
        templateId: null,
        templateParameters: [],
        mediaId: "media-1",
      });
    });
  });

  it("shows a retryable attachment error and never submits the failed draft", async () => {
    mocks.prepareUpload.mockResolvedValueOnce({ error: "Unsupported file type." });
    const view = provider(
      <InboxComposer
        conversation={conversation}
        templates={[]}
        documents={[]}
        provider="linked_device"
        windowOpen
      />,
    );
    const input = view.container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(["binary"], "malware.exe", { type: "application/octet-stream" })] },
    });

    expect(await screen.findByRole("alert")).toHaveTextContent("Unsupported file type.");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("retries a released send claim with the same prepared media id", async () => {
    mocks.prepareUpload.mockResolvedValue({
      success: true,
      media: {
        id: "media-1",
        fileName: "scan.pdf",
        mimeType: "application/pdf",
        kind: "document",
        byteSize: 8,
      },
    });
    mocks.send
      .mockResolvedValueOnce({
        error: "The worker rejected the media request.",
        mediaRetryable: true,
      })
      .mockResolvedValueOnce({ success: true });
    const view = provider(
      <InboxComposer
        conversation={conversation}
        templates={[]}
        documents={[]}
        provider="linked_device"
        windowOpen
      />,
    );
    const input = view.container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(["%PDF-1.7"], "scan.pdf", { type: "application/pdf" })] },
    });
    expect(await screen.findByText("Ready to send")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Send reply" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The worker rejected the media request.",
    );
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(2));
    expect(mocks.send.mock.calls[0]?.[0]).toMatchObject({ mediaId: "media-1" });
    expect(mocks.send.mock.calls[1]?.[0]).toMatchObject({ mediaId: "media-1" });
    expect(mocks.prepareUpload).toHaveBeenCalledTimes(1);
  });

  it("requests a real audio input and refuses a locally verified silent Blob", async () => {
    const { getUserMedia } = installRecorder();
    audioMocks.inspect.mockResolvedValue({
      durationSeconds: 1,
      decodedSampleCount: 48_000,
      observedSampleCount: 48_000,
      peak: 0,
      rms: 0,
      maxWindowRms: 0,
      activeVoiceSeconds: 0,
      audible: false,
      validationMode: "decoded_pcm",
    });
    provider(
      <InboxComposer conversation={conversation} templates={[]} documents={[]}
        provider="linked_device" windowOpen />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Record voice" }));
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: expect.objectContaining({
        channelCount: { ideal: 1 },
        sampleRate: { ideal: 48_000 },
      }),
    });
    const constraints = getUserMedia.mock.calls[0]?.[0] as MediaStreamConstraints;
    expect(constraints.audio).not.toHaveProperty("deviceId");
    expect(screen.getByRole("meter", { name: "Live microphone level" })).toBeInTheDocument();
    expect(screen.getByText("Microphone ready. Start recording.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Start recording" }));
    await userEvent.click(screen.getByRole("button", { name: /Stop/ }));
    await waitFor(() => expect(audioMocks.inspect).toHaveBeenCalled());
    expect(audioMocks.inspect).toHaveBeenCalledWith(expect.any(Blob), expect.any(Number));
    expect(mocks.prepareUpload).not.toHaveBeenCalled();
  });

  it("refuses a muted track before creating a recorder or monitor", async () => {
    const { stopTracks } = installRecorder({ muted: true });
    provider(
      <InboxComposer conversation={conversation} templates={[]} documents={[]}
        provider="linked_device" windowOpen />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Record voice" }));
    await waitFor(() => expect(stopTracks[0]).toHaveBeenCalled());
    expect(audioMocks.createMonitor).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Record voice" })).toBeEnabled();
  });

  it("enumerates multiple microphones after permission and shows only their labels", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const devices = [
      { kind: "audioinput", deviceId: "macbook-private-id", groupId: "g1", label: "MacBook Microphone" },
      { kind: "audioinput", deviceId: "airpods-private-id", groupId: "g2", label: "AirPods" },
    ];
    const { enumerateDevices } = installRecorder({ devices });
    provider(
      <InboxComposer conversation={conversation} templates={[]} documents={[]}
        provider="linked_device" windowOpen />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Record voice" }));
    expect(await screen.findByRole("combobox", { name: "Microphone input" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("combobox", { name: "Microphone input" }));
    expect(screen.getByRole("option", { name: "MacBook Microphone" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "AirPods" })).toBeInTheDocument();
    expect(enumerateDevices).toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("private-id");
    expect(JSON.stringify(info.mock.calls)).not.toContain("private-id");
    info.mockRestore();
  });

  it("switches with an exact device constraint, stops the old stream, and persists the working choice", async () => {
    const devices = [
      { kind: "audioinput", deviceId: "macbook-id", groupId: "g1", label: "MacBook Microphone" },
      { kind: "audioinput", deviceId: "airpods-id", groupId: "g2", label: "AirPods" },
    ];
    const { getUserMedia, stopTracks } = installRecorder({ devices });
    provider(
      <InboxComposer conversation={conversation} templates={[]} documents={[]}
        provider="linked_device" windowOpen />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Record voice" }));
    await userEvent.click(await screen.findByRole("combobox", { name: "Microphone input" }));
    await userEvent.click(screen.getByRole("option", { name: "AirPods" }));

    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2));
    expect(stopTracks[0]).toHaveBeenCalledTimes(1);
    expect(getUserMedia.mock.calls[1]?.[0]).toEqual({
      audio: expect.objectContaining({ deviceId: { exact: "airpods-id" } }),
    });
    expect(window.localStorage.getItem("clinicflow.voice-note.microphone-device-id"))
      .toBe("airpods-id");
    expect(screen.getByText("Microphone ready. Start recording.")).toBeInTheDocument();
  });

  it("restores the previously working microphone with an exact constraint", async () => {
    const devices = [
      { kind: "audioinput", deviceId: "macbook-id", groupId: "g1", label: "MacBook Microphone" },
      { kind: "audioinput", deviceId: "external-id", groupId: "g2", label: "External microphone" },
    ];
    window.localStorage.setItem("clinicflow.voice-note.microphone-device-id", "external-id");
    const { getUserMedia } = installRecorder({ devices });
    provider(
      <InboxComposer conversation={conversation} templates={[]} documents={[]}
        provider="linked_device" windowOpen />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Record voice" }));
    await screen.findByText("Microphone ready. Start recording.");
    expect(getUserMedia.mock.calls[0]?.[0]).toEqual({
      audio: expect.objectContaining({ deviceId: { exact: "external-id" } }),
    });
    expect(screen.getByRole("combobox", { name: "Microphone input" })).toHaveTextContent(
      "External microphone",
    );
  });

  it("falls back to the browser default when the stored device disappeared", async () => {
    window.localStorage.setItem("clinicflow.voice-note.microphone-device-id", "missing-id");
    const { getUserMedia } = installRecorder();
    provider(
      <InboxComposer conversation={conversation} templates={[]} documents={[]}
        provider="linked_device" windowOpen />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Record voice" }));
    await screen.findByText("Microphone ready. Start recording.");
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(getUserMedia.mock.calls[0]?.[0]).toEqual({
      audio: expect.objectContaining({ deviceId: { exact: "missing-id" } }),
    });
    expect((getUserMedia.mock.calls[1]?.[0]?.audio as MediaTrackConstraints))
      .not.toHaveProperty("deviceId");
    expect(window.localStorage.getItem("clinicflow.voice-note.microphone-device-id")).toBeNull();
  });

  it("blocks a digitally silent default and directs the employee to another input", async () => {
    const devices = [
      { kind: "audioinput", deviceId: "silent-id", groupId: "g1", label: "Browser default" },
      { kind: "audioinput", deviceId: "active-id", groupId: "g2", label: "External microphone" },
    ];
    installRecorder({ devices });
    audioMocks.getLiveInspection.mockReturnValue({
      observedSampleCount: 4_096,
      peak: 2.03e-34,
      rms: 2.03e-34,
      maxWindowRms: 2.03e-34,
      activeVoiceSeconds: 0,
      audible: false,
    });
    provider(
      <InboxComposer conversation={conversation} templates={[]} documents={[]}
        provider="linked_device" windowOpen />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Record voice" }));
    expect(await screen.findByText(
      "No sound is coming from this microphone. Choose another input.",
      {},
      { timeout: 2_500 },
    )).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start recording" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Microphone input" })).toBeEnabled();
  });

  it("accepts an active alternate device after the default calibrates as silent", async () => {
    const devices = [
      { kind: "audioinput", deviceId: "silent-id", groupId: "g1", label: "Browser default" },
      { kind: "audioinput", deviceId: "active-id", groupId: "g2", label: "External microphone" },
    ];
    installRecorder({ devices });
    audioMocks.createMonitor
      .mockResolvedValueOnce({
        inspect: audioMocks.inspect,
        close: audioMocks.close,
        resetLiveInspection: audioMocks.resetLiveInspection,
        getLiveInspection: () => ({
          observedSampleCount: 4_096,
          peak: 0,
          rms: 0,
          maxWindowRms: 0,
          activeVoiceSeconds: 0,
          audible: false,
        }),
      })
      .mockResolvedValueOnce({
        inspect: audioMocks.inspect,
        close: audioMocks.close,
        resetLiveInspection: audioMocks.resetLiveInspection,
        getLiveInspection: () => ({
          observedSampleCount: 4_096,
          peak: 0.2,
          rms: 0.05,
          maxWindowRms: 0.06,
          activeVoiceSeconds: 0.1,
          audible: true,
        }),
      });
    provider(
      <InboxComposer conversation={conversation} templates={[]} documents={[]}
        provider="linked_device" windowOpen />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Record voice" }));
    await screen.findByText(
      "No sound is coming from this microphone. Choose another input.",
      {},
      { timeout: 2_500 },
    );
    await userEvent.click(screen.getByRole("combobox", { name: "Microphone input" }));
    await userEvent.click(screen.getByRole("option", { name: "External microphone" }));
    expect(await screen.findByText("Microphone ready. Start recording.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start recording" })).toBeEnabled();
  });

  it("refreshes devices and falls back safely on devicechange", async () => {
    const devices = [
      { kind: "audioinput", deviceId: "macbook-id", groupId: "g1", label: "MacBook Microphone" },
      { kind: "audioinput", deviceId: "airpods-id", groupId: "g2", label: "AirPods" },
    ];
    const recorder = installRecorder({ devices });
    provider(
      <InboxComposer conversation={conversation} templates={[]} documents={[]}
        provider="linked_device" windowOpen />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Record voice" }));
    await screen.findByText("Microphone ready. Start recording.");

    recorder.setDevices([devices[1]!]);
    recorder.mediaDevices.dispatchEvent(new Event("devicechange"));

    await waitFor(() => expect(recorder.getUserMedia).toHaveBeenCalledTimes(2));
    expect(recorder.stopTracks[0]).toHaveBeenCalled();
    expect((recorder.getUserMedia.mock.calls[1]?.[0]?.audio as MediaTrackConstraints))
      .not.toHaveProperty("deviceId");
    expect(screen.queryByRole("combobox", { name: "Microphone input" })).not.toBeInTheDocument();
  });

  it("handles denied microphone permission without exposing recorder controls", async () => {
    const { getUserMedia } = installRecorder();
    getUserMedia.mockRejectedValueOnce(new DOMException("Denied", "NotAllowedError"));
    provider(
      <InboxComposer conversation={conversation} templates={[]} documents={[]}
        provider="linked_device" windowOpen />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Record voice" }));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith(
      "Microphone access was not granted.",
    ));
    expect(audioMocks.createMonitor).not.toHaveBeenCalled();
    expect(screen.queryByRole("meter", { name: "Live microphone level" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Record voice" })).toBeEnabled();
  });

  it("keeps the one-device experience compact while showing the pre-recording meter", async () => {
    installRecorder();
    provider(
      <InboxComposer conversation={conversation} templates={[]} documents={[]}
        provider="linked_device" windowOpen />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Record voice" }));
    expect(await screen.findByRole("meter", { name: "Live microphone level" })).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Microphone input" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start recording" })).toBeEnabled();
  });

  it("records normally after switching to another microphone", async () => {
    const devices = [
      { kind: "audioinput", deviceId: "macbook-id", groupId: "g1", label: "MacBook Microphone" },
      { kind: "audioinput", deviceId: "external-id", groupId: "g2", label: "External microphone" },
    ];
    installRecorder({ devices });
    mocks.prepareUpload.mockResolvedValue({
      success: true,
      media: { id: "voice-2", fileName: "voice-note.webm", mimeType: "audio/webm", kind: "audio", byteSize: 14 },
    });
    provider(
      <InboxComposer conversation={conversation} templates={[]} documents={[]}
        provider="linked_device" windowOpen />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Record voice" }));
    await userEvent.click(await screen.findByRole("combobox", { name: "Microphone input" }));
    await userEvent.click(screen.getByRole("option", { name: "External microphone" }));
    await userEvent.click(await screen.findByRole("button", { name: "Start recording" }));
    expect(audioMocks.resetLiveInspection).toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: /Stop/ }));
    await waitFor(() => expect(mocks.prepareUpload).toHaveBeenCalledTimes(1));
  });

  it("shows live activity when the direct stream analyser reports speech", async () => {
    installRecorder();
    audioMocks.createMonitor.mockImplementationOnce(async (
      _stream: MediaStream,
      onLevel: (level: number) => void,
    ) => {
      onLevel(0.4);
      return {
        inspect: audioMocks.inspect,
        close: audioMocks.close,
        resetLiveInspection: audioMocks.resetLiveInspection,
        getLiveInspection: audioMocks.getLiveInspection,
      };
    });
    provider(
      <InboxComposer conversation={conversation} templates={[]} documents={[]}
        provider="linked_device" windowOpen />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Record voice" }));
    expect(await screen.findByText("Microphone ready. Start recording.")).toBeInTheDocument();
    expect(screen.getByRole("meter", { name: "Live microphone level" })).toHaveAttribute(
      "aria-valuenow",
      "40",
    );
    await userEvent.click(screen.getByRole("button", { name: /Cancel/ }));
  });

  it("uploads the exact Blob only after local audible-sample verification", async () => {
    installRecorder();
    mocks.prepareUpload.mockResolvedValue({
      success: true,
      media: { id: "voice-1", fileName: "voice-note.webm", mimeType: "audio/webm", kind: "audio", byteSize: 14 },
    });
    provider(
      <InboxComposer conversation={conversation} templates={[]} documents={[]}
        provider="linked_device" windowOpen />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Record voice" }));
    await userEvent.click(screen.getByRole("button", { name: "Start recording" }));
    await userEvent.click(screen.getByRole("button", { name: /Stop/ }));
    await waitFor(() => expect(mocks.prepareUpload).toHaveBeenCalledTimes(1));
    expect(audioMocks.inspect).toHaveBeenCalledBefore(mocks.prepareUpload);
    const form = mocks.prepareUpload.mock.calls[0]![0] as FormData;
    expect(form.get("source")).toBe("voice_note");
    expect(form.get("file")).toBeInstanceOf(File);
  });

  it("keeps the ready voice preview URL live and stable until the file is removed", async () => {
    installRecorder();
    const createObjectURL = vi.fn(() => "blob:voice-preview");
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
    mocks.prepareUpload.mockResolvedValue({
      success: true,
      media: {
        id: "voice-preview-1",
        fileName: "voice-note.webm",
        mimeType: "audio/webm",
        kind: "audio",
        byteSize: 14,
      },
    });
    const view = provider(
      <InboxComposer conversation={conversation} templates={[]} documents={[]}
        provider="linked_device" windowOpen />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Record voice" }));
    await userEvent.click(screen.getByRole("button", { name: "Start recording" }));
    await userEvent.click(screen.getByRole("button", { name: /Stop/ }));
    expect(await screen.findByText("Ready to send")).toBeInTheDocument();
    const player = view.container.querySelector("audio");
    expect(player).toHaveAttribute("src", "blob:voice-preview");
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).not.toHaveBeenCalledWith("blob:voice-preview");

    await userEvent.click(screen.getByRole("button", { name: "Remove attachment" }));
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:voice-preview");
  });

  it("keeps a recorder-supported format sendable when native preview support differs", async () => {
    installRecorder({ playableTypes: ["audio/mp4"] });
    mocks.prepareUpload.mockResolvedValue({
      success: true,
      media: {
        id: "voice-mp4-1",
        fileName: "voice-note.m4a",
        mimeType: "audio/mp4",
        kind: "audio",
        byteSize: 14,
      },
    });
    provider(
      <InboxComposer conversation={conversation} templates={[]} documents={[]}
        provider="linked_device" windowOpen />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Record voice" }));
    await userEvent.click(screen.getByRole("button", { name: "Start recording" }));
    await userEvent.click(screen.getByRole("button", { name: /Stop/ }));
    await waitFor(() => expect(mocks.prepareUpload).toHaveBeenCalledTimes(1));
    const form = mocks.prepareUpload.mock.calls[0]![0] as FormData;
    const file = form.get("file") as File;
    expect(file.type).toBe("audio/webm;codecs=opus");
    expect(file.name).toBe("voice-note.webm");
  });

  it.each(["meta", "dialog360"] as const)(
    "keeps %s media disabled while preserving its template-only closed-window rule",
    (cloudProvider) => {
    provider(
      <InboxComposer
        conversation={conversation}
        templates={[]}
        documents={[]}
        provider={cloudProvider}
        windowOpen={false}
      />,
    );
    expect(screen.getByText("Media requires linked device")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Attach file" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Reply message" })).not.toBeInTheDocument();
    },
  );
});

describe("P8B new WhatsApp conversation", () => {
  it("opens a contact thread without presenting patient creation as part of the flow", async () => {
    mocks.open.mockResolvedValue({ success: true, conversationId: "conversation-2" });
    provider(
      <NewConversationDialog
        contacts={[{
          id: "contact-1",
          participantAddress: "+201111111111",
          displayName: "Fatima Ahmed",
          patientId: null,
          patientName: null,
          patientFileNumber: null,
        }]}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "New conversation" }));
    expect(screen.getByText(/does not create or verify a patient/i)).toBeInTheDocument();

    // The directory is two tabs and only the active one is mounted, so a
    // contact is reachable through its own group and nowhere else. This one has
    // no `patientId`, which is precisely what puts it under WhatsApp contacts:
    // asserting it is absent from the default Clinic tab is asserting that the
    // groups are real rather than two headings over one list.
    expect(screen.getByRole("tab", { name: /Clinic contacts/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getAllByRole("listbox")).toHaveLength(1);
    expect(screen.queryByRole("option", { name: /Fatima Ahmed/ })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("tab", { name: /WhatsApp contacts/ }));
    // Each tab carries its own labelled search rather than one shared box.
    expect(
      screen.getByRole("textbox", { name: /Search WhatsApp contacts/ }),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole("option", { name: /Fatima Ahmed/ }));
    // Choosing a contact fills the recipient and does nothing else: the thread
    // exists only once the explicit action is pressed.
    expect(mocks.open).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Open conversation" }));

    await waitFor(() => {
      expect(mocks.open).toHaveBeenCalledWith({
        participant: "+201111111111",
        displayName: "Fatima Ahmed",
      });
      expect(mocks.push).toHaveBeenCalledWith("/inbox?conversation=conversation-2");
    });
  });
});
