import "server-only";

import type { InboundAttachment } from "@/lib/messaging/types";

export type AttachmentPersistStage =
  | "attachment_persist_started"
  | "attachment_persist_completed"
  | "attachment_persist_failed";

export type VoicePlaybackLoadStage =
  | "request_started"
  | "response_ready"
  | "request_failed";

function safeToken(value: string | null | undefined, fallback: string): string {
  const token = value?.trim() ?? "";
  return /^[A-Za-z0-9_.-]{1,64}$/.test(token) ? token : fallback;
}

/**
 * Emits the deliberately small, privacy-safe attachment persistence contract.
 * Do not add message ids, filenames, paths, URLs, bodies, senders, or raw errors.
 */
export function logAttachmentPersistDiagnostic(input: {
  stage: AttachmentPersistStage;
  clinicId: string;
  attachment: InboundAttachment;
  errorCategory?: string;
  errorCode?: string | null;
}): void {
  const diagnostic = {
    stage: input.stage,
    clinicId: input.clinicId,
    mediaKind: input.attachment.mediaKind,
    voiceNote: input.attachment.voiceNote,
    mimeFamily: input.attachment.mimeType.split("/")[0]?.toLowerCase() || "unknown",
    byteCount: input.attachment.byteSize,
    durationPresent: input.attachment.durationSeconds !== null,
    ...(input.errorCategory
      ? { errorCategory: safeToken(input.errorCategory, "unknown") }
      : {}),
    ...(input.errorCode
      ? { errorCode: safeToken(input.errorCode, "unknown") }
      : {}),
  };
  console.info("inbound_media", diagnostic);
}

function safeAudioMime(value: string | null | undefined): string {
  const mime = value?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return /^audio\/[a-z0-9.+-]{1,64}$/.test(mime) ? mime : "audio/unknown";
}

/**
 * Privacy-safe HTTP delivery diagnostics for the authenticated voice endpoint.
 * Attachment ids, object paths, URLs and request headers are intentionally not
 * accepted by this API, which prevents signed links or patient identifiers from
 * entering logs by accident.
 */
export function logVoicePlaybackLoadDiagnostic(input: {
  stage: VoicePlaybackLoadStage;
  clinicId: string;
  httpStatus: number;
  mimeType?: string | null;
  objectByteCount?: number | null;
  responseByteCount?: number | null;
  rangeRequested: boolean;
  readyState?: "authorized" | "stored" | "response_ready";
  errorCategory?: string | null;
}): void {
  console.info("voice_playback_load", {
    stage: input.stage,
    clinicId: input.clinicId,
    httpStatus: input.httpStatus,
    mimeType: safeAudioMime(input.mimeType),
    objectByteCount: input.objectByteCount ?? null,
    responseByteCount: input.responseByteCount ?? null,
    rangeRequested: input.rangeRequested,
    readyState: input.readyState ?? null,
    errorCategory: input.errorCategory
      ? safeToken(input.errorCategory, "unknown")
      : null,
  });
}
