"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import {
  FileText,
  Loader2,
  Mic,
  MicOff,
  Paperclip,
  RotateCcw,
  Send,
  Square,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  discardInboxMedia,
  prepareInboxExistingDocument,
  prepareInboxMediaUpload,
  sendInboxReply,
} from "@/actions/messaging";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type {
  InboxConversation,
  InboxDocumentOption,
  InboxTemplate,
} from "@/lib/messaging/inbox";
import { getWhatsAppProviderCapabilities } from "@/lib/messaging/provider-policy";
import type { MessagingProviderId } from "@/lib/messaging/types";
import {
  createAudioCaptureMonitor,
  hasLiveAudioSignal,
  type AudioCaptureMonitor,
} from "@/lib/messaging/browser-audio";

type PreparedMedia = {
  id: string;
  fileName: string | null;
  mimeType: string;
  kind: "image" | "document" | "audio";
  byteSize: number;
};

type RetrySource =
  | { type: "file"; file: File; source: "upload" | "voice_note" }
  | { type: "document"; document: InboxDocumentOption };

type AttachmentState = {
  status: "uploading" | "ready" | "sending" | "error";
  media: PreparedMedia | null;
  label: string;
  retry: RetrySource;
  error: string | null;
  /** Browser-local preview only. Never submitted to the server or persisted. */
  localPreviewUrl: string | null;
};

const MAX_RECORDING_SECONDS = 5 * 60;
const MICROPHONE_CALIBRATION_MS = 1_200;
const MICROPHONE_SIGNAL_POLL_MS = 100;
const MICROPHONE_STORAGE_KEY = "clinicflow.voice-note.microphone-device-id";

type RecordingState =
  | "idle"
  | "requesting"
  | "calibrating"
  | "ready"
  | "recording"
  | "checking";

type MicrophoneSignal = "checking" | "active" | "silent";

type MicrophoneEnvironmentDiagnostics = {
  permissionState: PermissionState | "unsupported" | "unavailable";
  audioInputDeviceCount: number | null;
};

function voiceRecorderDiagnostic(stage: string, details: Record<string, unknown>) {
  if (process.env.NODE_ENV === "production") return;
  // Aggregate capture metadata only. Never add labels, raw device IDs, sample
  // arrays, Blob contents, object URLs, or recorded audio to this diagnostic.
  console.info("voice_recorder", { stage, ...details });
}

function voiceOutboundValidationDiagnostic(stage: string, details: Record<string, unknown>) {
  // This event is intentionally production-safe. It contains aggregate signal
  // and container metadata only — never audio bytes, Blob URLs, filenames,
  // conversation identifiers, phone numbers or provider addresses.
  console.info("voice_outbound_validation_stage", { stage, ...details });
}

async function readMicrophoneEnvironment(): Promise<MicrophoneEnvironmentDiagnostics> {
  let permissionState: MicrophoneEnvironmentDiagnostics["permissionState"] = "unsupported";
  let audioInputDeviceCount: number | null = null;

  try {
    if (navigator.permissions?.query) {
      const permission = await navigator.permissions.query({
        name: "microphone" as PermissionName,
      });
      permissionState = permission.state;
    }
  } catch {
    permissionState = "unavailable";
  }

  try {
    if (navigator.mediaDevices?.enumerateDevices) {
      const devices = await navigator.mediaDevices.enumerateDevices();
      audioInputDeviceCount = devices.filter((device) => device.kind === "audioinput").length;
    }
  } catch {
    audioInputDeviceCount = null;
  }

  return { permissionState, audioInputDeviceCount };
}

/**
 * Why a microphone request failed, as far as the browser actually said.
 *
 * The categories are deliberately narrower than the copy they select. Chrome on
 * macOS raises `NotAllowedError` for the site permission, for an operating
 * system block on the browser itself, and for a prompt the user dismissed — and
 * the Permissions API reports only the *site* record, which can read `granted`
 * while `getUserMedia` refuses and `denied` while it succeeds. So a refusal is
 * only called a site block when something says so; otherwise the interface says
 * it does not know, rather than sending staff to a setting that is already
 * correct.
 */
type MicrophoneBlockKind =
  | "denied"
  | "system"
  | "unconfirmed"
  | "insecure"
  | "notFound"
  | "busy"
  | "unsupported"
  | "unknown";

const MICROPHONE_BLOCK_HELP_KEY: Record<MicrophoneBlockKind, string> = {
  denied: "composer.microphoneDeniedHelp",
  system: "composer.microphoneBlockedBySystem",
  unconfirmed: "composer.microphoneBlockedUnknown",
  insecure: "composer.microphoneInsecureContext",
  notFound: "composer.microphoneNotFoundHelp",
  busy: "composer.microphoneBusyHelp",
  unsupported: "composer.microphoneUnsupportedHelp",
  unknown: "composer.microphoneUnknownHelp",
};

/** Short toast copy. The persistent notice carries the actionable half. */
const MICROPHONE_BLOCK_TOAST_KEY: Record<MicrophoneBlockKind, string> = {
  denied: "composer.microphoneDenied",
  system: "composer.microphoneDenied",
  unconfirmed: "composer.microphoneDenied",
  insecure: "composer.microphoneInsecureContext",
  notFound: "composer.microphoneNotFound",
  busy: "composer.microphoneUnavailable",
  unsupported: "composer.recordingUnsupported",
  unknown: "composer.microphoneUnavailable",
};

/** Nothing the staff member can click changes these two. */
const MICROPHONE_BLOCK_RETRYABLE: Record<MicrophoneBlockKind, boolean> = {
  denied: true,
  system: true,
  unconfirmed: true,
  insecure: false,
  notFound: true,
  busy: true,
  unsupported: false,
  unknown: true,
};

function classifyMicrophoneFailure(
  error: unknown,
  permissionState: MicrophoneEnvironmentDiagnostics["permissionState"],
): MicrophoneBlockKind {
  // Read structurally rather than through `instanceof`. A `DOMException` that
  // crossed a realm boundary — an iframe, a test environment — fails the
  // identity check while still carrying the only two fields that matter, and
  // treating a real `NotAllowedError` as "unknown" is a misdiagnosis too.
  const details = (error ?? {}) as { name?: unknown; message?: unknown };
  const name = typeof details.name === "string" ? details.name : "";
  const message = typeof details.message === "string" ? details.message.toLowerCase() : "";
  if (name === "SecurityError") return "insecure";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "notFound";
  if (name === "NotReadableError" || name === "AbortError") return "busy";
  // `getUserMedia` itself is missing or was handed an unusable constraint set:
  // an old browser, not a refusal.
  if (name === "TypeError" || name === "NotSupportedError") return "unsupported";
  if (name === "NotAllowedError") {
    // Chrome names the operating system in the message when macOS — not the
    // site permission — is the refusal. That is direct evidence about *this*
    // request, so it outranks the Permissions API, which reports only the
    // site's stored record.
    if (message.includes("system") || message.includes("os")) return "system";
    // A site permission the browser itself reports as denied is the one case
    // where pointing at the address-bar control is certainly right.
    if (permissionState === "denied") return "denied";
    // `prompt` means no site-level refusal was ever recorded, so the refusal
    // came from outside the site: the OS, or a dismissed prompt.
    if (permissionState === "prompt") return "system";
    // `granted`, `unsupported` and `unavailable` prove nothing about who
    // refused. Claiming "your browser is blocking this site" here is exactly
    // the misdiagnosis this branch exists to prevent.
    return "unconfirmed";
  }
  return "unknown";
}

function safeTrackSettings(track: MediaStreamTrack): Record<string, unknown> {
  const settings = track.getSettings?.() ?? {};
  const extendedSettings = settings as MediaTrackSettings & { latency?: number };
  return {
    deviceId: settings.deviceId ? "[redacted]" : undefined,
    groupId: settings.groupId ? "[redacted]" : undefined,
    channelCount: settings.channelCount,
    sampleRate: settings.sampleRate,
    sampleSize: settings.sampleSize,
    echoCancellation: settings.echoCancellation,
    noiseSuppression: settings.noiseSuppression,
    autoGainControl: settings.autoGainControl,
    latency: extendedSettings.latency,
  };
}

function renderTemplate(template: InboxTemplate, parameters: readonly string[]): string {
  let body = template.body;
  template.variableNames.forEach((name, index) => {
    const value = parameters[index]?.trim() ?? "";
    body = body.replaceAll(`{{${index + 1}}}`, value);
    body = body.replaceAll(`{{${name}}}`, value);
  });
  return body;
}

function recordingMimeType(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  for (const type of [
    "audio/webm;codecs=opus",
    "audio/mp4;codecs=mp4a.40.2",
    "audio/mp4",
    "audio/webm",
  ]) {
    // MediaRecorder output is normalized and independently validated by the
    // worker. Native `<audio>` support controls the optional local preview, not
    // whether an audible recording may be sent.
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return null;
}

function microphoneConstraints(deviceId: string | null): MediaStreamConstraints {
  return {
    audio: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      channelCount: { ideal: 1 },
      sampleRate: { ideal: 48_000 },
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  };
}

function audioInputDevices(devices: MediaDeviceInfo[]): MediaDeviceInfo[] {
  return devices.filter((device) => device.kind === "audioinput");
}

async function enumerateAudioInputs(): Promise<MediaDeviceInfo[]> {
  try {
    return navigator.mediaDevices?.enumerateDevices
      ? audioInputDevices(await navigator.mediaDevices.enumerateDevices())
      : [];
  } catch {
    return [];
  }
}

export function InboxComposer({
  conversation,
  templates,
  documents,
  provider,
  windowOpen,
}: {
  conversation: InboxConversation;
  templates: InboxTemplate[];
  documents: InboxDocumentOption[];
  provider: MessagingProviderId | null;
  windowOpen: boolean;
}) {
  const t = useTranslations("inbox");
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const recorderStream = useRef<MediaStream | null>(null);
  const audioMonitor = useRef<AudioCaptureMonitor | null>(null);
  const microphoneRequest = useRef(0);
  const microphoneSignalTimer = useRef<number | null>(null);
  const selectedMicrophoneIdRef = useRef<string | null>(null);
  const recordingStateRef = useRef<RecordingState>("idle");
  const activateMicrophoneRef = useRef<(
    deviceId: string | null,
    requestedDevice: "browser_default" | "stored_selection" | "user_selected" | "devicechange_fallback",
    allowDefaultFallback?: boolean,
  ) => Promise<void>>(async () => undefined);
  const pendingMicrophonePreference = useRef<string | null>(null);
  const cancelRecordingRef = useRef(false);
  const chunks = useRef<Blob[]>([]);
  const recordingStartedAt = useRef(0);
  const localPreviewUrl = useRef<string | null>(null);
  const [reply, setReply] = useState("");
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [templateParameters, setTemplateParameters] = useState<string[]>([]);
  const [attachment, setAttachment] = useState<AttachmentState | null>(null);
  const [recordingState, setRecordingState] = useState<RecordingState>("idle");
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [recordingLevel, setRecordingLevel] = useState(0);
  const [microphones, setMicrophones] = useState<MediaDeviceInfo[]>([]);
  const [selectedMicrophoneId, setSelectedMicrophoneId] = useState<string | null>(null);
  const [microphoneSignal, setMicrophoneSignal] = useState<MicrophoneSignal>("checking");
  /**
   * P16 — why the microphone is unavailable, kept on screen.
   *
   * A denial used to be one flat `composer.microphoneDenied` toast that faded
   * after a few seconds and said nothing a receptionist could act on. Each
   * distinguishable situation now gets its own answer, localized and persistent
   * until the staff member retries — see `classifyMicrophoneFailure` for how
   * each one is established, and for the two the browser does not let us tell
   * apart, which say so rather than guessing.
   *
   * Nothing here fakes a grant, and nothing here refuses to ask: the notice is
   * only ever raised by an actual `getUserMedia` failure, or by an environment
   * in which `getUserMedia` provably cannot exist.
   */
  const [microphoneBlock, setMicrophoneBlock] = useState<MicrophoneBlockKind | null>(null);
  const [preparing, startPreparing] = useTransition();
  const [sending, startSending] = useTransition();

  const selectedTemplate = useMemo(
    () => templates.find((template) => template.id === templateId) ?? null,
    [templateId, templates],
  );
  const attachmentPreviewUrl = attachment?.localPreviewUrl ?? null;
  const capabilities = getWhatsAppProviderCapabilities(provider);
  const freeformAllowed = !capabilities.serviceWindowRequired || windowOpen;
  const templateReady = Boolean(
    selectedTemplate && templateParameters.every((parameter) => parameter.trim().length > 0),
  );
  const busy = preparing || sending || attachment?.status === "uploading";
  const recording = recordingState === "recording";
  const recordingBusy = recordingState !== "idle";

  /**
   * P10 — why the ClinicFlow document control is unavailable, in words.
   *
   * The control was disabled whenever the list was empty, and the only
   * explanation shown was the "link a patient" line — which appeared *only*
   * when no patient was linked. A conversation that was correctly linked but
   * whose documents could not be listed therefore produced a control that was
   * greyed out for no stated reason, which reads to a staff member as a broken
   * button rather than as an empty list. Three states, three answers:
   *
   *   * no patient linked — the original message, still the right one;
   *   * a patient linked but nothing they are authorized to send — say that,
   *     rather than looking broken;
   *   * a patient linked with documents — enabled.
   *
   * Nothing here changes what may be sent. The list is built server-side under
   * the caller's own RLS, and `sendConversationDocument` re-checks the clinic,
   * the patient and the document independently on every send.
   */
  const documentsDisabled =
    busy || recordingBusy || Boolean(attachment) || documents.length === 0;
  const documentHint =
    documents.length > 0
      ? null
      : conversation.patientId
        ? t("composer.noDocumentsForPatient")
        : t("composer.linkPatientForDocuments");
  const microphoneOpen = recorderStream.current !== null && (
    recordingState === "calibrating" ||
    recordingState === "ready" ||
    recordingState === "recording"
  );
  const selectedMicrophoneIndex = selectedMicrophoneId
    ? microphones.findIndex((device) => device.deviceId === selectedMicrophoneId)
    : -1;
  const selectedMicrophoneValue = selectedMicrophoneIndex >= 0
    ? `microphone-${selectedMicrophoneIndex}`
    : "";

  function updateRecordingState(state: RecordingState) {
    recordingStateRef.current = state;
    setRecordingState(state);
  }

  useEffect(() => {
    if (!recording) return;
    const timer = window.setInterval(() => {
      const elapsed = Math.floor((Date.now() - recordingStartedAt.current) / 1000);
      setRecordingSeconds(elapsed);
      if (elapsed >= MAX_RECORDING_SECONDS && recorder.current?.state === "recording") {
        recorder.current.stop();
      }
    }, 250);
    return () => window.clearInterval(timer);
  }, [recording]);

  useEffect(() => () => {
    microphoneRequest.current += 1;
    if (microphoneSignalTimer.current !== null) {
      window.clearInterval(microphoneSignalTimer.current);
    }
    recorderStream.current?.getTracks().forEach((track) => track.stop());
    if (recorder.current?.state === "recording") recorder.current.stop();
    void audioMonitor.current?.close();
    if (localPreviewUrl.current && typeof URL.revokeObjectURL === "function") {
      URL.revokeObjectURL(localPreviewUrl.current);
      localPreviewUrl.current = null;
    }
  }, []);

  function replaceLocalPreview(source: RetrySource): string | null {
    if (localPreviewUrl.current && typeof URL.revokeObjectURL === "function") {
      URL.revokeObjectURL(localPreviewUrl.current);
    }
    const next =
      source.type === "file" && typeof URL.createObjectURL === "function"
        ? URL.createObjectURL(source.file)
        : null;
    localPreviewUrl.current = next;
    return next;
  }

  function releaseLocalPreview() {
    if (localPreviewUrl.current && typeof URL.revokeObjectURL === "function") {
      URL.revokeObjectURL(localPreviewUrl.current);
    }
    localPreviewUrl.current = null;
  }

  function chooseTemplate(id: string) {
    const template = templates.find((item) => item.id === id);
    if (!template) return;
    const values = template.variableNames.map((name) =>
      name === "patient_name" ? conversation.patientName ?? "" : "",
    );
    setTemplateId(id);
    setTemplateParameters(values);
    if (values.every(Boolean)) setReply(renderTemplate(template, values));
  }

  function insertTemplate() {
    if (!selectedTemplate || !templateReady) return;
    setReply(renderTemplate(selectedTemplate, templateParameters));
  }

  async function prepare(source: RetrySource) {
    const previewUrl = replaceLocalPreview(source);
    setAttachment({
      status: "uploading",
      media: null,
      label: source.type === "file" ? source.file.name : source.document.label,
      retry: source,
      error: null,
      localPreviewUrl: previewUrl,
    });
    const result = source.type === "file"
      ? await (() => {
          const formData = new FormData();
          formData.set("conversationId", conversation.id);
          formData.set("source", source.source);
          formData.set("file", source.file);
          return prepareInboxMediaUpload(formData);
        })()
      : await prepareInboxExistingDocument({
          conversationId: conversation.id,
          source: source.document.source,
          recordId: source.document.id,
        });
    if (result.error || !result.media) {
      setAttachment({
        status: "error",
        media: null,
        label: source.type === "file" ? source.file.name : source.document.label,
        retry: source,
        error: result.error ?? t("composer.prepareFailed"),
        localPreviewUrl: previewUrl,
      });
      return;
    }
    setAttachment({
      status: "ready",
      media: result.media,
      label: result.media.fileName ?? t("composer.voiceNote"),
      retry: source,
      error: null,
      localPreviewUrl: previewUrl,
    });
  }

  function prepareTransition(source: RetrySource) {
    startPreparing(() => prepare(source));
  }

  function selectFile(file: File | null) {
    if (!file) return;
    prepareTransition({ type: "file", file, source: "upload" });
    if (fileInput.current) fileInput.current.value = "";
  }

  function removeAttachment() {
    const current = attachment;
    setAttachment(null);
    releaseLocalPreview();
    if (current?.media && current.status !== "sending") {
      void discardInboxMedia({
        conversationId: conversation.id,
        mediaId: current.media.id,
      });
    }
  }

  function clearMicrophoneSignalTimer() {
    if (microphoneSignalTimer.current === null) return;
    window.clearInterval(microphoneSignalTimer.current);
    microphoneSignalTimer.current = null;
  }

  async function releaseCurrentMicrophone() {
    clearMicrophoneSignalTimer();
    const monitor = audioMonitor.current;
    const stream = recorderStream.current;
    audioMonitor.current = null;
    recorderStream.current = null;
    recorder.current = null;
    stream?.getTracks().forEach((track) => track.stop());
    await monitor?.close();
    setRecordingLevel(0);
  }

  function persistWorkingMicrophone() {
    const deviceId = pendingMicrophonePreference.current;
    pendingMicrophonePreference.current = null;
    if (!deviceId) return;
    try {
      window.localStorage.setItem(MICROPHONE_STORAGE_KEY, deviceId);
    } catch {
      // Recording remains available when browser preference storage is blocked.
    }
  }

  function calibrateMicrophone(monitor: AudioCaptureMonitor) {
    clearMicrophoneSignalTimer();
    setMicrophoneSignal("checking");
    updateRecordingState("calibrating");
    const calibrationEndsAt = Date.now() + MICROPHONE_CALIBRATION_MS;
    let calibrationExpired = false;

    const inspectSignal = () => {
      if (audioMonitor.current !== monitor) {
        clearMicrophoneSignalTimer();
        return;
      }
      const inspection = monitor.getLiveInspection();
      if (hasLiveAudioSignal(inspection)) {
        voiceRecorderDiagnostic("microphone-signal-ready", {
          livePeak: inspection.peak,
          liveRms: inspection.rms,
          liveMaxWindowRms: inspection.maxWindowRms,
        });
        setMicrophoneSignal("active");
        updateRecordingState("ready");
        persistWorkingMicrophone();
        clearMicrophoneSignalTimer();
        return;
      }
      if (!calibrationExpired && Date.now() >= calibrationEndsAt) {
        calibrationExpired = true;
        voiceRecorderDiagnostic("microphone-signal-silent", {
          livePeak: inspection.peak,
          liveRms: inspection.rms,
          liveMaxWindowRms: inspection.maxWindowRms,
        });
        setMicrophoneSignal("silent");
        updateRecordingState("ready");
      }
    };

    inspectSignal();
    if (recordingStateRef.current === "calibrating") {
      microphoneSignalTimer.current = window.setInterval(
        inspectSignal,
        MICROPHONE_SIGNAL_POLL_MS,
      );
    }
  }

  function reportMicrophoneFailure(
    error: unknown,
    permissionState: MicrophoneEnvironmentDiagnostics["permissionState"],
  ) {
    const kind = classifyMicrophoneFailure(error, permissionState);
    setMicrophoneBlock(kind);
    toast.error(t(MICROPHONE_BLOCK_TOAST_KEY[kind]));
    return kind;
  }

  async function activateMicrophone(
    requestedDeviceId: string | null,
    requestedDevice: "browser_default" | "stored_selection" | "user_selected" | "devicechange_fallback",
    allowDefaultFallback = true,
  ) {
    const mimeType = recordingMimeType();
    const secureContext = typeof window === "undefined" || window.isSecureContext;
    const mediaDevicesAvailable = Boolean(navigator.mediaDevices?.getUserMedia);
    voiceRecorderDiagnostic("microphone-environment", {
      // `isSecureContext` is the browser's own answer, which is what decides
      // whether `getUserMedia` exists — not what the address bar reads. It is
      // true on `http://localhost`, and that is deliberate.
      isSecureContext: secureContext,
      mediaDevicesAvailable,
      mediaRecorderSupported: typeof MediaRecorder !== "undefined",
      selectedMimeType: mimeType ?? "none",
      requestedDevice,
    });
    // A page served over plain HTTP (a LAN address, a tunnel) is not a secure
    // context, and no browser exposes `getUserMedia` there. That is a
    // deployment fact with its own fix, not "this browser cannot record".
    // `http://localhost` *is* a secure context, so this never fires there.
    if (!secureContext) {
      setMicrophoneBlock("insecure");
      toast.error(t("composer.microphoneInsecureContext"));
      return;
    }
    if (!mediaDevicesAvailable) {
      setMicrophoneBlock("insecure");
      toast.error(t("composer.microphoneInsecureContext"));
      return;
    }
    // No recordable container means no voice note whatever the microphone
    // says. This is a recorder-support fact, not a permission judgement.
    if (mimeType === null) {
      setMicrophoneBlock("unsupported");
      toast.error(t("composer.recordingUnsupported"));
      return;
    }
    const requestId = microphoneRequest.current + 1;
    microphoneRequest.current = requestId;
    updateRecordingState("requesting");
    setMicrophoneSignal("checking");
    setMicrophoneBlock(null);
    await releaseCurrentMicrophone();
    // Read for diagnostics and for classifying a *failure*. It is deliberately
    // never allowed to short-circuit the request: Chrome reports the site's
    // stored record here, which on macOS can read `denied` while a real
    // `getUserMedia` call still prompts and succeeds. The media request is the
    // authority on whether recording can happen; this is corroboration only.
    const environmentBeforeRequest = readMicrophoneEnvironment();
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia(
        microphoneConstraints(requestedDeviceId),
      );
      if (microphoneRequest.current !== requestId) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const track = stream.getAudioTracks()[0];
      const beforeRequest = await environmentBeforeRequest;
      const afterRequest = await readMicrophoneEnvironment();
      const devices = await enumerateAudioInputs();
      voiceRecorderDiagnostic("microphone-selected", {
        permissionStateBeforeRequest: beforeRequest.permissionState,
        permissionState: afterRequest.permissionState,
        audioInputDeviceCount: devices.length || afterRequest.audioInputDeviceCount,
        audioTrackCount: stream.getAudioTracks().length,
        trackReadyState: track?.readyState ?? "missing",
        trackEnabled: track?.enabled ?? false,
        trackMuted: track?.muted ?? null,
        trackSettings: track ? safeTrackSettings(track) : null,
        requestedDevice,
      });
      if (!track || track.readyState !== "live" || !track.enabled || track.muted) {
        stream.getTracks().forEach((item) => item.stop());
        throw new DOMException("No live unmuted microphone track", "NotReadableError");
      }

      const monitor = await createAudioCaptureMonitor(stream, setRecordingLevel);
      if (microphoneRequest.current !== requestId) {
        stream.getTracks().forEach((item) => item.stop());
        await monitor.close();
        return;
      }
      track.addEventListener("mute", () => {
        voiceRecorderDiagnostic("track-muted", {
          trackReadyState: track.readyState,
          trackEnabled: track.enabled,
          trackMuted: track.muted,
        });
        setMicrophoneSignal("silent");
      });
      track.addEventListener("ended", () => {
        voiceRecorderDiagnostic("track-ended", {
          trackReadyState: track.readyState,
          trackEnabled: track.enabled,
          trackMuted: track.muted,
        });
        setMicrophoneSignal("silent");
      });
      const trackDeviceId = track.getSettings?.().deviceId ?? null;
      const activeDeviceId = requestedDeviceId ?? (
        devices.some((device) => device.deviceId === trackDeviceId)
          ? trackDeviceId
          : devices.find((device) => device.deviceId === "default")?.deviceId ??
            devices[0]?.deviceId ??
            null
      );
      setMicrophones(devices);
      selectedMicrophoneIdRef.current = activeDeviceId;
      setSelectedMicrophoneId(activeDeviceId);
      recorderStream.current = stream;
      audioMonitor.current = monitor;
      pendingMicrophonePreference.current = requestedDevice === "user_selected"
        ? requestedDeviceId
        : null;
      calibrateMicrophone(monitor);
    } catch (error) {
      stream?.getTracks().forEach((track) => track.stop());
      if (microphoneRequest.current !== requestId) return;
      const name = error instanceof DOMException ? error.name : "";
      if (
        requestedDeviceId &&
        allowDefaultFallback &&
        (name === "NotFoundError" || name === "OverconstrainedError")
      ) {
        try {
          if (window.localStorage.getItem(MICROPHONE_STORAGE_KEY) === requestedDeviceId) {
            window.localStorage.removeItem(MICROPHONE_STORAGE_KEY);
          }
        } catch {
          // Continue with the browser default when storage is unavailable.
        }
        pendingMicrophonePreference.current = null;
        await activateMicrophone(null, "browser_default", false);
        return;
      }
      await releaseCurrentMicrophone();
      updateRecordingState("idle");
      const before = await environmentBeforeRequest;
      // Re-read after the refusal: a prompt the user answered during the call
      // changes the stored record, and the later value is the one that
      // describes the state the staff member is now actually in.
      const after = await readMicrophoneEnvironment();
      const kind = reportMicrophoneFailure(error, after.permissionState);
      voiceRecorderDiagnostic("microphone-error", {
        permissionStateBeforeRequest: before.permissionState,
        permissionState: after.permissionState,
        audioInputDeviceCount: after.audioInputDeviceCount,
        errorName: name || (error instanceof Error ? error.name : "UnknownError"),
        classifiedAs: kind,
      });
    }
  }

  activateMicrophoneRef.current = activateMicrophone;

  async function requestMicrophone() {
    let storedDeviceId: string | null = null;
    try {
      storedDeviceId = window.localStorage.getItem(MICROPHONE_STORAGE_KEY);
    } catch {
      // The browser default still works if localStorage is unavailable.
    }
    await activateMicrophone(
      storedDeviceId,
      storedDeviceId ? "stored_selection" : "browser_default",
    );
  }

  async function selectMicrophone(value: string) {
    const index = Number(value.replace("microphone-", ""));
    const device = Number.isInteger(index) ? microphones[index] : undefined;
    if (!device) return;
    await activateMicrophone(device.deviceId, "user_selected");
  }

  async function beginRecording() {
    const stream = recorderStream.current;
    const monitor = audioMonitor.current;
    const mimeType = recordingMimeType();
    const track = stream?.getAudioTracks()[0];
    if (
      !stream ||
      !monitor ||
      mimeType === null ||
      microphoneSignal !== "active" ||
      !track ||
      track.readyState !== "live" ||
      !track.enabled ||
      track.muted
    ) {
      toast.error(t("composer.microphoneUnavailable"));
      return;
    }

    try {
      clearMicrophoneSignalTimer();
      monitor.resetLiveInspection();
      const nextRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      voiceRecorderDiagnostic("recorder-ready", {
        mediaRecorderMimeType: nextRecorder.mimeType || "browser_default",
        trackReadyState: track.readyState,
        trackEnabled: track.enabled,
        trackMuted: track.muted,
      });
      recorder.current = nextRecorder;
      cancelRecordingRef.current = false;
      chunks.current = [];
      nextRecorder.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) chunks.current.push(event.data);
      });
      nextRecorder.addEventListener("stop", async () => {
        const recordingDurationSeconds = Math.max(
          0,
          (Date.now() - recordingStartedAt.current) / 1_000,
        );
        const liveInspection = monitor.getLiveInspection();
        stream.getTracks().forEach((track) => track.stop());
        recorderStream.current = null;
        recorder.current = null;
        updateRecordingState("checking");
        const actualType = nextRecorder.mimeType || chunks.current[0]?.type || "audio/webm";
        const blob = new Blob(chunks.current, { type: actualType });
        voiceRecorderDiagnostic("recording-stopped", {
          mediaRecorderMimeType: actualType,
          recordingDurationSeconds,
          blobSize: blob.size,
          liveObservedSampleCount: liveInspection.observedSampleCount,
          livePeak: liveInspection.peak,
          liveRms: liveInspection.rms,
          liveMaxWindowRms: liveInspection.maxWindowRms,
          liveActiveVoiceSeconds: liveInspection.activeVoiceSeconds,
        });
        voiceOutboundValidationDiagnostic("blob_ready", {
          mediaRecorderMimeType: actualType,
          recordingDurationSeconds,
          blobSize: blob.size,
          liveObservedSampleCount: liveInspection.observedSampleCount,
        });
        chunks.current = [];
        const cancelled = cancelRecordingRef.current;
        cancelRecordingRef.current = false;
        if (cancelled) {
          await monitor.close();
          audioMonitor.current = null;
          updateRecordingState("idle");
          return;
        }
        if (blob.size <= 0) {
          await monitor.close();
          audioMonitor.current = null;
          updateRecordingState("idle");
          toast.error(t("composer.recordingFailed"));
          return;
        }
        try {
          const inspection = await monitor.inspect(blob, recordingDurationSeconds);
          voiceRecorderDiagnostic("recording-inspected", {
            validationMode: inspection.validationMode,
            recordingDurationSeconds,
            blobSize: blob.size,
            decodedDurationSeconds: inspection.durationSeconds,
            decodedSampleCount: inspection.decodedSampleCount,
            observedSampleCount: inspection.observedSampleCount,
            peak: inspection.peak,
            rms: inspection.rms,
            maxWindowRms: inspection.maxWindowRms,
            activeVoiceSeconds: inspection.activeVoiceSeconds,
            audible: inspection.audible,
          });
          voiceOutboundValidationDiagnostic("pcm_inspected", {
            validationMode: inspection.validationMode,
            recordingDurationSeconds,
            blobSize: blob.size,
            decodedDurationSeconds: inspection.durationSeconds,
            decodedSampleCount: inspection.decodedSampleCount,
            observedSampleCount: inspection.observedSampleCount,
            peak: inspection.peak,
            rms: inspection.rms,
            maxWindowRms: inspection.maxWindowRms,
            activeVoiceSeconds: inspection.activeVoiceSeconds,
            audible: inspection.audible,
          });
          if (!inspection.audible) {
            voiceOutboundValidationDiagnostic("rejected_silence", {
              validationMode: inspection.validationMode,
              blobSize: blob.size,
            });
            toast.error(t("composer.recordingSilent"));
            return;
          }
        } catch (error) {
          voiceRecorderDiagnostic("recording-unreadable", {
            mediaRecorderMimeType: actualType,
            recordingDurationSeconds,
            blobSize: blob.size,
            errorName: error instanceof DOMException || error instanceof Error
              ? error.name
              : "UnknownError",
          });
          voiceOutboundValidationDiagnostic("rejected_unreadable", {
            mediaRecorderMimeType: actualType,
            recordingDurationSeconds,
            blobSize: blob.size,
            errorName: error instanceof DOMException || error instanceof Error
              ? error.name
              : "UnknownError",
          });
          toast.error(t("composer.recordingUnreadable"));
          return;
        } finally {
          await monitor.close();
          audioMonitor.current = null;
          updateRecordingState("idle");
        }
        const extension = actualType.includes("mp4") ? "m4a" : "webm";
        const file = new File([blob], `voice-note.${extension}`, { type: actualType });
        prepareTransition({ type: "file", file, source: "voice_note" });
      }, { once: true });
      recordingStartedAt.current = Date.now();
      setRecordingSeconds(0);
      updateRecordingState("recording");
      nextRecorder.start(500);
    } catch (error) {
      await releaseCurrentMicrophone();
      updateRecordingState("idle");
      const environment = await readMicrophoneEnvironment();
      // The recorder, not the request, failed here — an unsupported container
      // from `new MediaRecorder` classifies as such rather than as a refusal.
      const kind = reportMicrophoneFailure(error, environment.permissionState);
      voiceRecorderDiagnostic("recorder-error", {
        selectedMimeType: recordingMimeType() ?? "none",
        errorName: error instanceof Error ? error.name : "UnknownError",
        classifiedAs: kind,
      });
    }
  }

  function stopRecording() {
    if (recorder.current?.state === "recording") recorder.current.stop();
  }

  async function cancelRecording() {
    if (recorder.current?.state === "recording") {
      cancelRecordingRef.current = true;
      recorder.current.stop();
      return;
    }
    microphoneRequest.current += 1;
    pendingMicrophonePreference.current = null;
    await releaseCurrentMicrophone();
    updateRecordingState("idle");
  }

  useEffect(() => {
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.addEventListener || !mediaDevices.enumerateDevices) return;

    const handleDeviceChange = async () => {
      if (!recorderStream.current) return;
      try {
        const devices = audioInputDevices(await mediaDevices.enumerateDevices());
        setMicrophones(devices);
        const selectedId = selectedMicrophoneIdRef.current;
        if (!selectedId || devices.some((device) => device.deviceId === selectedId)) return;
        selectedMicrophoneIdRef.current = null;
        setSelectedMicrophoneId(null);
        try {
          if (window.localStorage.getItem(MICROPHONE_STORAGE_KEY) === selectedId) {
            window.localStorage.removeItem(MICROPHONE_STORAGE_KEY);
          }
        } catch {
          // Fallback selection does not depend on preference storage.
        }
        if (
          recordingStateRef.current !== "recording" &&
          recordingStateRef.current !== "checking" &&
          recordingStateRef.current !== "requesting"
        ) {
          await activateMicrophoneRef.current(null, "devicechange_fallback", false);
        }
      } catch {
        // Keep the current live stream if enumeration temporarily fails.
      }
    };

    mediaDevices.addEventListener("devicechange", handleDeviceChange);
    return () => mediaDevices.removeEventListener("devicechange", handleDeviceChange);
  }, []);

  function handleSend(retryMedia?: PreparedMedia) {
    const media = retryMedia ?? (attachment?.status === "ready" ? attachment.media : null);
    if (freeformAllowed) {
      if (!reply.trim() && !media) return;
    } else if (!templateReady) {
      return;
    }
    if (attachment && attachment.status !== "ready" && !retryMedia) return;
    if (attachment) setAttachment((current) => current ? { ...current, status: "sending" } : null);

    startSending(async () => {
      const result = await sendInboxReply({
        conversationId: conversation.id,
        body: freeformAllowed ? reply : "",
        templateId: freeformAllowed ? null : selectedTemplate?.id,
        templateParameters: freeformAllowed ? [] : templateParameters,
        mediaId: media?.id ?? null,
      });
      if (result.error) {
        toast.error(result.error);
        if (attachment) {
          setAttachment((current) => current ? {
            ...current,
            media: result.mediaRetryable ? current.media : null,
            status: "error",
            error: result.error ?? null,
          } : null);
        }
        return;
      }
      setReply("");
      setTemplateId(null);
      setTemplateParameters([]);
      setAttachment(null);
      releaseLocalPreview();
      toast.success(t("replySent"));
      router.refresh();
    });
  }

  return (
    <div className="space-y-3" data-testid="inbox-composer">
      {!freeformAllowed ? (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-800 dark:text-amber-300">
          <p className="font-medium">{t("windowClosedTitle")}</p>
          <p className="mt-1 text-xs">{t("windowClosedDescription")}</p>
        </div>
      ) : null}

      {templates.length > 0 ? (
        <div className="space-y-2 rounded-lg border bg-muted/15 p-2.5">
          <Select value={templateId ?? ""} onValueChange={chooseTemplate}>
            <SelectTrigger className="w-full" aria-label={t("chooseTemplate")}>
              <SelectValue placeholder={t("composer.quickReplyPlaceholder")} />
            </SelectTrigger>
            <SelectContent>
              {templates.map((template) => (
                <SelectItem key={template.id} value={template.id}>
                  {template.name} · {template.language.toUpperCase()}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {selectedTemplate ? (
            <div className="space-y-2">
              {selectedTemplate.variableNames.map((name, index) => (
                <Input
                  key={`${selectedTemplate.id}-${name}-${index}`}
                  value={templateParameters[index] ?? ""}
                  onChange={(event) =>
                    setTemplateParameters((current) =>
                      current.map((value, parameterIndex) =>
                        parameterIndex === index ? event.target.value : value,
                      ),
                    )
                  }
                  placeholder={t("templateVariable", { name })}
                  aria-label={t("templateVariable", { name })}
                  maxLength={1000}
                />
              ))}
              {freeformAllowed ? (
                <Button variant="outline" size="sm" disabled={!templateReady} onClick={insertTemplate}>
                  {t("composer.insertTemplate")}
                </Button>
              ) : (
                <p className="whitespace-pre-wrap text-sm" dir="auto">
                  {templateReady ? renderTemplate(selectedTemplate, templateParameters) : selectedTemplate.body}
                </p>
              )}
            </div>
          ) : null}
        </div>
      ) : !freeformAllowed ? (
        <p className="text-sm text-muted-foreground">{t("noApprovedTemplates")}</p>
      ) : null}

      {attachment ? (
        <div
          className="space-y-2 rounded-xl border border-primary/25 bg-primary/5 px-3 py-2"
          role={attachment.status === "error" ? "alert" : "status"}
        >
          {attachmentPreviewUrl && attachment.media?.kind === "image" ? (
            <Image
              src={attachmentPreviewUrl}
              alt={attachment.label}
              width={640}
              height={360}
              unoptimized
              className="max-h-44 w-auto max-w-full rounded-lg object-contain"
            />
          ) : null}
          {attachmentPreviewUrl && attachment.media?.kind === "audio" ? (
            <audio className="w-full" controls preload="metadata" src={attachmentPreviewUrl}>
              {attachment.label}
            </audio>
          ) : null}
          <div className="flex items-center gap-3">
            {attachment.status === "uploading" || attachment.status === "sending" ? (
              <Loader2 className="size-4 shrink-0 animate-spin text-primary" aria-hidden />
            ) : (
              <FileText className="size-4 shrink-0 text-primary" aria-hidden />
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium" dir="auto">{attachment.label}</span>
              <span className="block text-xs text-muted-foreground">
                {attachment.status === "uploading"
                  ? t("composer.uploading")
                  : attachment.status === "sending"
                    ? t("composer.sendingAttachment")
                    : attachment.status === "error"
                      ? attachment.error
                      : t("composer.readyToSend")}
              </span>
            </span>
            {attachment.status === "error" ? (
              <Button
                variant="outline"
                size="sm"
                disabled={preparing || sending}
                onClick={() => attachment.media
                  ? handleSend(attachment.media)
                  : prepareTransition(attachment.retry)}
              >
                <RotateCcw className="size-3.5" aria-hidden />
                {t("composer.retry")}
              </Button>
            ) : null}
            <Button variant="ghost" size="icon-sm" disabled={attachment.status === "sending"} onClick={removeAttachment} aria-label={t("composer.removeAttachment")}>
              <X className="size-4" aria-hidden />
            </Button>
          </div>
        </div>
      ) : null}

      {freeformAllowed ? (
        <Textarea
          value={reply}
          onChange={(event) => setReply(event.target.value)}
          maxLength={4096}
          placeholder={t("replyPlaceholder")}
          aria-label={t("replyLabel")}
          dir="auto"
          className="max-h-40 min-h-20 resize-none"
        />
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {capabilities.mediaSupported ? (
          <>
            <input
              ref={fileInput}
              type="file"
              className="sr-only"
              accept="image/jpeg,image/png,image/webp,image/gif,application/pdf,text/plain,text/csv,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.zip"
              onChange={(event) => selectFile(event.target.files?.[0] ?? null)}
            />
            <Button variant="outline" size="sm" disabled={busy || recordingBusy || Boolean(attachment)} onClick={() => fileInput.current?.click()}>
              <Paperclip className="size-4" aria-hidden />
              {t("composer.attachFile")}
            </Button>
            <Select
              disabled={documentsDisabled}
              onValueChange={(value) => {
                const [source, id] = value.split(":", 2);
                const document = documents.find((item) => item.source === source && item.id === id);
                if (document) prepareTransition({ type: "document", document });
              }}
            >
              <SelectTrigger
                className="w-auto min-w-44"
                aria-label={t("composer.chooseDocument")}
                aria-describedby={documentHint ? "composer-document-hint" : undefined}
                title={documentHint ?? undefined}
                data-testid="composer-document-select"
              >
                <SelectValue placeholder={t("composer.chooseDocument")} />
              </SelectTrigger>
              <SelectContent>
                {documents.map((document) => (
                  <SelectItem key={`${document.source}:${document.id}`} value={`${document.source}:${document.id}`}>
                    {document.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant={recording ? "destructive" : "outline"}
              size="sm"
              disabled={
                busy ||
                Boolean(attachment) ||
                recordingState === "requesting" ||
                recordingState === "calibrating" ||
                recordingState === "checking" ||
                (recordingState === "ready" && microphoneSignal !== "active")
              }
              aria-pressed={recording}
              onClick={recording
                ? stopRecording
                : recordingState === "ready"
                  ? beginRecording
                  : requestMicrophone}
            >
              {recordingState === "requesting" ||
              recordingState === "calibrating" ||
              recordingState === "checking" ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : recording ? (
                <Square className="size-3.5 fill-current" aria-hidden />
              ) : (
                <Mic className="size-4" aria-hidden />
              )}
              {recording
                ? t("composer.stopRecording", { seconds: recordingSeconds })
                : recordingState === "requesting"
                  ? t("composer.requestingMicrophone")
                  : recordingState === "calibrating"
                    ? t("composer.calibratingMicrophone")
                  : recordingState === "checking"
                    ? t("composer.checkingRecording")
                    : recordingState === "ready"
                      ? t("composer.startRecording")
                    : t("composer.recordVoice")}
            </Button>
            {microphoneOpen ? (
              <>
                {microphones.length > 1 ? (
                  <Select
                    value={selectedMicrophoneValue}
                    disabled={recording || recordingState === "calibrating"}
                    onValueChange={selectMicrophone}
                  >
                    <SelectTrigger
                      className="h-8 w-auto max-w-52 min-w-40"
                      aria-label={t("composer.microphoneInput")}
                    >
                      <SelectValue placeholder={t("composer.microphoneInput")} />
                    </SelectTrigger>
                    <SelectContent>
                      {microphones.map((device, index) => (
                        <SelectItem
                          key={`microphone-${index}`}
                          value={`microphone-${index}`}
                        >
                          {device.label || t("composer.unnamedMicrophone", { number: index + 1 })}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : null}
                <div
                  className="h-2 w-24 overflow-hidden rounded-full bg-muted"
                  role="meter"
                  aria-label={t("composer.microphoneLevel")}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(recordingLevel * 100)}
                >
                  <div
                    className="h-full rounded-full bg-emerald-500 transition-[width] duration-75"
                    style={{ width: `${recordingLevel * 100}%` }}
                  />
                </div>
                {microphoneSignal === "silent" ? (
                  <span className="basis-full text-xs text-destructive" role="alert">
                    {microphones.length > 1
                      ? t("composer.noSoundFromMicrophone")
                      : t("composer.noSoundFromOnlyMicrophone")}
                  </span>
                ) : (
                  <span className="text-xs text-muted-foreground" aria-live="polite">
                    {recordingState === "ready" && microphoneSignal === "active"
                      ? t("composer.microphoneReady")
                      : recordingLevel >= 0.08
                        ? t("composer.microphoneActivityDetected")
                        : t("composer.speakToTestMicrophone")}
                  </span>
                )}
                <Button variant="ghost" size="sm" onClick={cancelRecording}>
                  <X className="size-4" aria-hidden />
                  {t("composer.cancelRecording")}
                </Button>
              </>
            ) : null}
          </>
        ) : (
          <Badge variant="outline">{t("composer.cloudMediaUnavailable")}</Badge>
        )}

        <Button
          className="ms-auto"
          disabled={
            busy ||
            recordingBusy ||
            Boolean(attachment && attachment.status !== "ready") ||
            (freeformAllowed ? !reply.trim() && !attachment?.media : !templateReady)
          }
          onClick={() => handleSend()}
        >
          {sending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Send className="size-4 rtl:-scale-x-100" aria-hidden />}
          {freeformAllowed ? t("sendReply") : t("sendTemplate")}
        </Button>
      </div>

      {microphoneBlock ? (
        <div
          role="alert"
          data-testid="microphone-permission-notice"
          className="flex flex-wrap items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-xs"
        >
          <MicOff className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
          <div className="min-w-0 flex-1 space-y-1">
            <p className="font-medium text-destructive">
              {t("composer.microphoneDeniedTitle")}
            </p>
            <p className="text-muted-foreground">
              {t(MICROPHONE_BLOCK_HELP_KEY[microphoneBlock])}
            </p>
          </div>
          {MICROPHONE_BLOCK_RETRYABLE[microphoneBlock] ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setMicrophoneBlock(null);
                void requestMicrophone();
              }}
            >
              {t("composer.microphoneRetry")}
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("composer.microphoneDismiss")}
            onClick={() => setMicrophoneBlock(null)}
          >
            <X className="size-4" aria-hidden />
          </Button>
        </div>
      ) : null}

      {capabilities.mediaSupported && documentHint ? (
        <p id="composer-document-hint" className="text-xs text-muted-foreground">
          {documentHint}
        </p>
      ) : null}
    </div>
  );
}
