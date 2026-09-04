import { createHash, randomUUID } from "node:crypto";
import { downloadMediaMessage, type WAMessage } from "baileys";
import type { CallbackAttachment } from "./callback.ts";

/**
 * Patient attachments, from an encrypted WhatsApp blob to a row the clinic can
 * open.
 *
 * Three rules shape everything in this file.
 *
 * **The sender describes nothing.** A WhatsApp media stanza carries a `mimetype`
 * and a `fileName` chosen by the sending client. Neither is evidence. The type is
 * decided by sniffing the first bytes of the decrypted file, and the storage path
 * is built from a fresh UUID, so a filename cannot traverse, collide, or
 * overwrite. The sender's filename survives only as a label staff see.
 *
 * **A refusal is an outcome, not an error.** A 60 MB video, or a format this
 * stack will not store, produces an attachment row with `status: "rejected"` and
 * a short machine reason. The clinic sees "this patient sent something we cannot
 * open" instead of an empty message, and the patient-facing assistant is told the
 * same thing rather than inventing a description.
 *
 * **The message outlives its files.** Every failure path here returns an
 * attachment record; none of them throws into the caller. A download that times
 * out must not lose the text the patient sent with it.
 */

/** The kinds ClinicFlow stores, and what each one is for. */
const IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
]);

const DOCUMENT_TYPES = new Set([
  "application/pdf",
  "text/plain",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

const AUDIO_TYPES = new Set([
  "audio/aac",
  "audio/flac",
  "audio/mp4",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
]);

/**
 * P11P — video, which WhatsApp patients send constantly and which ClinicFlow
 * previously refused before downloading a byte.
 *
 * The set is deliberately narrow: the four containers WhatsApp clients actually
 * produce. Every one of them is also a container that *can* carry other things,
 * so none of them is trusted on its signature alone — `sniffMimeType` requires
 * the sender's own `videoMessage` claim to agree with the container bytes, the
 * same rule audio already lives under.
 */
const VIDEO_TYPES = new Set([
  "video/mp4",
  "video/3gpp",
  "video/quicktime",
  "video/webm",
]);

/** Extension per stored type, so a signed URL downloads with a sane name. */
const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/heic": "heic",
  "image/heif": "heif",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "audio/aac": "aac",
  "audio/flac": "flac",
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/webm": "webm",
  "video/mp4": "mp4",
  "video/3gpp": "3gp",
  "video/quicktime": "mov",
  "video/webm": "webm",
};

/** Message types that carry a downloadable file. */
const MEDIA_MESSAGE_TYPES = [
  "imageMessage",
  "documentMessage",
  "videoMessage",
  "audioMessage",
  "stickerMessage",
  "ptvMessage",
] as const;

export type MediaMessageType = (typeof MEDIA_MESSAGE_TYPES)[number];

const MIME_TOKEN = "[a-z0-9!#$&^_.+-]+";
const MIME_WITH_OPTIONAL_CODEC = new RegExp(
  `^(${MIME_TOKEN}/${MIME_TOKEN})(?:\\s*;\\s*codecs\\s*=\\s*\"?(${MIME_TOKEN})\"?)?$`,
  "i",
);

/** A safe canonical MIME value, retaining WhatsApp's codec when it supplied one. */
export function normalizeMimeType(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 128) return null;
  const match = value.trim().match(MIME_WITH_OPTIONAL_CODEC);
  if (!match?.[1]) return null;
  const base = match[1].toLowerCase();
  return match[2] ? `${base}; codecs=${match[2].toLowerCase()}` : base;
}

export function mimeBase(value: string | null | undefined): string {
  return (value ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

function startsWith(bytes: Buffer, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

/**
 * What a file actually is, from its leading bytes.
 *
 * Returns null when nothing recognizable is there — which is treated as "will not
 * store", not as "probably what the sender said". The ZIP and OLE containers are
 * reported as their Office types only when the sender's claim agrees with the
 * container, because `PK\x03\x04` alone cannot distinguish a .docx from any other
 * zip; the container check is what stops an arbitrary archive from being stored
 * under an Office mime type.
 */
export function sniffMimeType(bytes: Buffer, claimed: string | null | undefined): string | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif";
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) {
    return "image/webp";
  }
  // ISO-BMFF: "ftyp" at offset 4, then a HEIF/HEIC brand.
  if (startsWith(bytes, [0x66, 0x74, 0x79, 0x70], 4)) {
    const brand = bytes.subarray(8, 12).toString("latin1");
    if (["heic", "heix", "heim", "heis", "mif1", "msf1"].includes(brand)) return "image/heic";
  }
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf";

  // Audio formats used by WhatsApp clients. Container-only formats that may
  // also carry video (WebM and ISO-BMFF) require a matching audio claim; the
  // bytes prove the container while the `audioMessage` envelope proves the
  // media family.
  if (startsWith(bytes, [0x4f, 0x67, 0x67, 0x53])) return "audio/ogg";
  if (startsWith(bytes, [0x66, 0x4c, 0x61, 0x43])) return "audio/flac";
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes, [0x57, 0x41, 0x56, 0x45], 8)
  ) {
    return "audio/wav";
  }
  if (startsWith(bytes, [0x49, 0x44, 0x33])) return "audio/mpeg";
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0) {
    const normalizedClaim = mimeBase(claimed);
    return normalizedClaim === "audio/aac" ? "audio/aac" : "audio/mpeg";
  }

  const normalizedClaim = mimeBase(claimed);
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3]) && normalizedClaim === "audio/webm") {
    return "audio/webm";
  }
  if (
    startsWith(bytes, [0x66, 0x74, 0x79, 0x70], 4) &&
    normalizedClaim === "audio/mp4"
  ) {
    return "audio/mp4";
  }

  // Video containers, under the same rule as audio above: the bytes prove the
  // container, the sender's `videoMessage` claim proves the media family. An
  // ISO-BMFF or WebM file is not assumed to be video just because it parses —
  // that is how an `audioMessage` would get relabelled as a video.
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3]) && normalizedClaim === "video/webm") {
    return "video/webm";
  }
  if (startsWith(bytes, [0x66, 0x74, 0x79, 0x70], 4)) {
    const brand = bytes.subarray(8, 12).toString("latin1");
    const isQuickTime = brand === "qt  ";
    const is3gp = brand.startsWith("3g");
    if (normalizedClaim === "video/quicktime" && (isQuickTime || brand.startsWith("mp4") || brand === "isom")) {
      return "video/quicktime";
    }
    if (normalizedClaim === "video/3gpp" && is3gp) return "video/3gpp";
    if (normalizedClaim === "video/mp4" && !isQuickTime) return "video/mp4";
  }

  const normalizedDocumentClaim = mimeBase(claimed) || null;

  // OOXML is a zip. Only honour the claim when the container matches it.
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    if (
      normalizedDocumentClaim ===
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
      normalizedDocumentClaim === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    ) {
      return normalizedDocumentClaim;
    }
    return null;
  }
  // Legacy Office is an OLE compound file, same reasoning.
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    if (
      normalizedDocumentClaim === "application/msword" ||
      normalizedDocumentClaim === "application/vnd.ms-excel"
    ) {
      return normalizedDocumentClaim;
    }
    return null;
  }

  // Plain text has no signature. Accept it only when the sender said so *and*
  // the bytes really are decodable UTF-8 without control characters.
  if (normalizedDocumentClaim === "text/plain" && isProbablyUtf8Text(bytes)) return "text/plain";
  return null;
}

function isProbablyUtf8Text(bytes: Buffer): boolean {
  const sample = bytes.subarray(0, 4096);
  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(sample);
  if (decoded.includes("�")) return false;
  // Tab, newline and carriage return are the only control characters expected.
  return !/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(decoded);
}

export function mediaKindFor(
  mimeType: string,
): "image" | "document" | "audio" | "video" | "unsupported" {
  const base = mimeBase(mimeType);
  if (IMAGE_TYPES.has(base)) return "image";
  if (DOCUMENT_TYPES.has(base)) return "document";
  if (AUDIO_TYPES.has(base)) return "audio";
  if (VIDEO_TYPES.has(base)) return "video";
  return "unsupported";
}

/** The media node on a message, after Baileys' envelope unwrapping. */
export function mediaTypeOf(
  content: Record<string, unknown> | null | undefined,
): MediaMessageType | null {
  if (!content) return null;
  for (const type of MEDIA_MESSAGE_TYPES) {
    if (content[type]) return type;
  }
  return null;
}

/** The declared kind, before anything is downloaded. Only used to refuse early. */
function declaredKind(type: MediaMessageType): "image" | "document" | "audio" | "video" {
  switch (type) {
    case "imageMessage":
    case "stickerMessage":
      return "image";
    case "audioMessage":
      return "audio";
    case "videoMessage":
    case "ptvMessage":
      return "video";
    case "documentMessage":
      return "document";
  }
}

function durationSeconds(value: unknown): number | null {
  const duration = Number(value);
  return Number.isInteger(duration) && duration >= 0 && duration <= 7 * 24 * 60 * 60
    ? duration
    : null;
}

/** Metadata shared by live downloads and history-only attachment records. */
export function mediaMetadataFor(
  content: Record<string, unknown>,
  type: MediaMessageType,
): {
  mediaKind: "image" | "document" | "audio" | "video";
  voiceNote: boolean;
  durationSeconds: number | null;
  mimeType: string;
  originalFilename: string | null;
} {
  const node = content[type] as Record<string, unknown> | undefined;
  return {
    mediaKind: declaredKind(type),
    voiceNote: type === "audioMessage" && node?.ptt === true,
    durationSeconds:
      type === "audioMessage" || type === "videoMessage" || type === "ptvMessage"
        ? durationSeconds(node?.seconds)
        : null,
    mimeType: normalizeMimeType(node?.mimetype) ?? "application/octet-stream",
    originalFilename: safeFilename(node?.fileName),
  };
}

/** Strips a sender-supplied filename down to something safe to display. */
export function safeFilename(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const flattened = value
    .replace(/[\u0000-\u001F\u007F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, "")
    .replace(/[/\\]/g, "_")
    .trim();
  if (flattened.length === 0 || flattened === "." || flattened === "..") return null;
  return flattened.slice(0, 255);
}

function rejected(
  kind: CallbackAttachment["mediaKind"],
  mimeType: string,
  reason: string,
  extra: Partial<CallbackAttachment> = {},
): CallbackAttachment {
  return {
    mediaKind: kind,
    voiceNote: false,
    durationSeconds: null,
    mimeType,
    originalFilename: null,
    byteSize: 0,
    sha256: null,
    storagePath: null,
    status: "rejected",
    failureReason: reason,
    ...extra,
  };
}

/** Where the bytes go, and who is allowed to read them. */
export type MediaUploader = (input: {
  clinicId: string;
  path: string;
  bytes: Buffer;
  contentType: string;
}) => Promise<boolean | MediaUploadResult>;

export type MediaUploadResult =
  | { ok: true }
  | {
      ok: false;
      /** Coarse, privacy-safe failure family. Never an upstream error message. */
      errorCategory: string;
      /** A sanitized HTTP/service code, never an object path or response body. */
      errorCode: string;
    };

export type MediaDownloader = (message: WAMessage) => Promise<Buffer>;

export type InboundMediaDiagnosticStage =
  | "inbound_audio_detected"
  | "media_download_started"
  | "media_download_completed"
  | "media_download_failed"
  | "storage_upload_started"
  | "storage_upload_completed"
  | "storage_upload_failed";

export type InboundMediaDiagnostic = {
  stage: InboundMediaDiagnosticStage;
  clinicId: string;
  mediaKind: "image" | "document" | "audio" | "video" | "unsupported";
  voiceNote: boolean;
  mimeFamily: string;
  byteCount: number;
  durationPresent: boolean;
  errorCategory?: string;
  errorCode?: string;
};

type BaileysDownloadContext = NonNullable<Parameters<typeof downloadMediaMessage>[3]>;

/**
 * Uses Baileys' complete media-message downloader, not a raw URL fetch.
 *
 * Passing the original WAMessage is what lets Baileys consume the encrypted
 * `mediaKey` plus `directPath`/`url`. The optional socket context also enables
 * Baileys' 404/410 re-upload request for media WhatsApp can still refresh.
 */
export function createBaileysMediaDownloader(
  context?: BaileysDownloadContext,
): MediaDownloader {
  return (message) => downloadMediaMessage(message, "buffer", {}, context);
}

function safeErrorToken(value: unknown, fallback: string): string {
  if (typeof value === "number" && Number.isInteger(value)) return String(value);
  if (typeof value !== "string") return fallback;
  const token = value.trim();
  return /^[A-Za-z0-9_.-]{1,64}$/.test(token) ? token : fallback;
}

/** Extracts only transport/category codes; error messages can contain JIDs and URLs. */
function safeDownloadFailure(error: unknown): { errorCategory: string; errorCode: string } {
  if (!error || typeof error !== "object") {
    return { errorCategory: "baileys", errorCode: "unknown" };
  }
  const value = error as {
    code?: unknown;
    output?: { statusCode?: unknown };
    response?: { status?: unknown };
  };
  const status = value.response?.status ?? value.output?.statusCode;
  if (typeof status === "number" && Number.isInteger(status)) {
    return { errorCategory: "media_http", errorCode: String(status) };
  }
  return {
    errorCategory: "baileys",
    errorCode: safeErrorToken(value.code, "unknown"),
  };
}

export type IngestMediaOptions = {
  clinicId: string;
  message: WAMessage;
  content: Record<string, unknown>;
  mediaType: MediaMessageType;
  maxBytes: number;
  upload: MediaUploader;
  download?: MediaDownloader;
  diagnostic?: (event: InboundMediaDiagnostic) => void;
};

/**
 * Downloads one attachment and hands back the record that describes it.
 *
 * Never throws. Every branch — a refused kind, an oversized file, a download that
 * failed, a byte pattern we do not store, an upload that did not land — resolves
 * to an attachment whose `status` says so.
 */
export async function ingestAttachment(
  options: IngestMediaOptions,
): Promise<CallbackAttachment> {
  const node = options.content[options.mediaType] as Record<string, unknown> | undefined;
  const metadata = mediaMetadataFor(options.content, options.mediaType);
  const claimedMime = normalizeMimeType(node?.mimetype);
  const claimedName = metadata.originalFilename;
  const kind = metadata.mediaKind;
  const diagnosticBase = () => ({
    clinicId: options.clinicId,
    mediaKind: kind,
    voiceNote: metadata.voiceNote,
    mimeFamily: mimeBase(claimedMime).split("/")[0] || "unknown",
    durationPresent: metadata.durationSeconds !== null,
  });
  const diagnose = (
    stage: InboundMediaDiagnosticStage,
    byteCount: number,
    failure?: { errorCategory: string; errorCode: string },
  ) => {
    try {
      options.diagnostic?.({ stage, ...diagnosticBase(), byteCount, ...failure });
    } catch {
      // Diagnostics must never be allowed to alter message ingestion.
    }
  };

  if (kind === "audio") diagnose("inbound_audio_detected", 0);

  // WhatsApp puts the length in the stanza. Refusing here avoids pulling
  // megabytes over the wire only to discard them.
  const declaredLength = Number(node?.fileLength ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > options.maxBytes) {
    return rejected(kind, claimedMime ?? "application/octet-stream", "too_large", {
      originalFilename: claimedName,
      voiceNote: metadata.voiceNote,
      durationSeconds: metadata.durationSeconds,
    });
  }

  let bytes: Buffer;
  diagnose("media_download_started", 0);
  try {
    const download = options.download ?? createBaileysMediaDownloader();
    bytes = await download(options.message);
    diagnose("media_download_completed", bytes.length);
  } catch (error) {
    diagnose("media_download_failed", 0, safeDownloadFailure(error));
    // The reason is deliberately not carried: a Baileys media error frequently
    // embeds the media URL and the sender JID in its message.
    return {
      mediaKind: kind,
      voiceNote: metadata.voiceNote,
      durationSeconds: metadata.durationSeconds,
      mimeType: claimedMime ?? "application/octet-stream",
      originalFilename: claimedName,
      byteSize: 0,
      sha256: null,
      storagePath: null,
      status: "failed",
      failureReason: "download_failed",
    };
  }

  if (bytes.length === 0) {
    return rejected(kind, claimedMime ?? "application/octet-stream", "empty_file", {
      originalFilename: claimedName,
      voiceNote: metadata.voiceNote,
      durationSeconds: metadata.durationSeconds,
    });
  }
  // The stanza may have lied about the length, so the real size is checked too.
  if (bytes.length > options.maxBytes) {
    return rejected(kind, claimedMime ?? "application/octet-stream", "too_large", {
      originalFilename: claimedName,
      byteSize: bytes.length,
      voiceNote: metadata.voiceNote,
      durationSeconds: metadata.durationSeconds,
    });
  }

  const mimeType = sniffMimeType(bytes, claimedMime);
  if (!mimeType) {
    // A `videoMessage` whose bytes do not verify is still a video as far as
    // staff are concerned, and the inbox says so ("old video unavailable")
    // rather than calling it an unknown file. Refusing to *store* it and
    // refusing to *name* it are separate decisions, and only the first one is
    // warranted here.
    return rejected(kind === "video" ? "video" : "unsupported", claimedMime ?? "application/octet-stream", "unsupported_type", {
      originalFilename: claimedName,
      byteSize: bytes.length,
      voiceNote: metadata.voiceNote,
      durationSeconds: metadata.durationSeconds,
    });
  }
  const resolvedKind = mediaKindFor(mimeType);
  // An `audioMessage` must remain audio all the way through. If the downloaded
  // bytes are not recognized audio, reject the file rather than relabeling it as
  // an image/document based on coincidental or malicious bytes.
  if (
    resolvedKind === "unsupported" ||
    (kind === "audio" && resolvedKind !== "audio") ||
    (kind === "video" && resolvedKind !== "video")
  ) {
    return rejected(kind === "video" ? "video" : "unsupported", mimeType, "unsupported_type", {
      originalFilename: claimedName,
      byteSize: bytes.length,
      voiceNote: metadata.voiceNote,
      durationSeconds: metadata.durationSeconds,
    });
  }

  const preservedMime =
    claimedMime && mimeBase(claimedMime) === mimeType ? claimedMime : mimeType;

  const sha256 = createHash("sha256").update(bytes).digest("hex");
  // Path built entirely from values this worker controls: the clinic it is
  // authorized for, a date bucket, and a fresh identifier. Nothing the sender
  // supplied reaches it.
  const path = `${options.clinicId}/${new Date().toISOString().slice(0, 7)}/${randomUUID()}.${EXTENSIONS[mimeBase(preservedMime)] ?? "bin"}`;
  diagnose("storage_upload_started", bytes.length);
  let uploadResult: boolean | MediaUploadResult;
  try {
    uploadResult = await options.upload({
      clinicId: options.clinicId,
      path,
      bytes,
      // Storage allow-lists operate on the media type. Codec parameters remain
      // in the attachment row for the browser, but must not turn `audio/ogg`
      // into a different bucket allow-list token.
      contentType: mimeBase(preservedMime),
    });
  } catch (error) {
    uploadResult = {
      ok: false,
      errorCategory: "storage_client",
      errorCode: safeErrorToken(
        error && typeof error === "object" ? (error as { code?: unknown }).code : null,
        "unknown",
      ),
    };
  }
  if (uploadResult === false || (typeof uploadResult !== "boolean" && !uploadResult.ok)) {
    let failure: { errorCategory: string; errorCode: string };
    if (typeof uploadResult === "boolean") {
      failure = { errorCategory: "storage", errorCode: "rejected" };
    } else {
      failure = {
        errorCategory: safeErrorToken(uploadResult.errorCategory, "storage"),
        errorCode: safeErrorToken(uploadResult.errorCode, "unknown"),
      };
    }
    diagnose("storage_upload_failed", bytes.length, failure);
    return {
      mediaKind: resolvedKind,
      voiceNote: metadata.voiceNote,
      durationSeconds: metadata.durationSeconds,
      mimeType: preservedMime,
      originalFilename: claimedName,
      byteSize: bytes.length,
      sha256,
      storagePath: null,
      status: "failed",
      failureReason: "storage_failed",
    };
  }

  diagnose("storage_upload_completed", bytes.length);

  return {
    mediaKind: resolvedKind,
    voiceNote: metadata.voiceNote,
    durationSeconds: metadata.durationSeconds,
    mimeType: preservedMime,
    originalFilename: claimedName,
    byteSize: bytes.length,
    sha256,
    storagePath: path,
    status: "stored",
    failureReason: null,
  };
}
