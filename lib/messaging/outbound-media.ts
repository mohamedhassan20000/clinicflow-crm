import "server-only";

/**
 * Server-side validation for files staff prepare for a linked-device send.
 * Browser MIME values and filenames are labels only; the bytes decide the type.
 */

export const MAX_OUTBOUND_MEDIA_BYTES = 10 * 1024 * 1024;

const IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

const DOCUMENT_TYPES = new Set([
  "application/pdf",
  "text/plain",
  "text/csv",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/zip",
]);

const VOICE_TYPES = new Set([
  "audio/ogg",
  "audio/webm",
  "audio/mp4",
  "audio/mpeg",
  "audio/aac",
]);

const EXTENSIONS: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/csv": "csv",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/zip": "zip",
  "audio/ogg": "ogg",
  "audio/webm": "webm",
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
  "audio/aac": "aac",
};

function startsWith(bytes: Buffer, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

function normalizedClaim(value: string | null | undefined): string | null {
  return value?.split(";", 1)[0]?.trim().toLowerCase() || null;
}

function isProbablyUtf8Text(bytes: Buffer): boolean {
  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, 4096));
  if (decoded.includes("�")) return false;
  return !/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(decoded);
}

/** Returns the type proven by the file signature, or null when it is unknown. */
export function sniffOutboundMimeType(
  bytes: Buffer,
  claimedType: string | null | undefined,
): string | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif";
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return "image/webp";
  }
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf";
  if (startsWith(bytes, [0x4f, 0x67, 0x67, 0x53])) return "audio/ogg";
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return "audio/webm";
  if (startsWith(bytes, [0x49, 0x44, 0x33]) || startsWith(bytes, [0xff, 0xfb])) {
    return "audio/mpeg";
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xf6) === 0xf0) return "audio/aac";

  const claim = normalizedClaim(claimedType);
  if (startsWith(bytes, [0x66, 0x74, 0x79, 0x70], 4)) {
    return claim === "audio/mp4" ? "audio/mp4" : null;
  }
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    return claim && DOCUMENT_TYPES.has(claim) ? claim : null;
  }
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    return claim && DOCUMENT_TYPES.has(claim) ? claim : null;
  }
  if ((claim === "text/plain" || claim === "text/csv") && isProbablyUtf8Text(bytes)) {
    return claim;
  }
  return null;
}

export function outboundMediaKind(
  mimeType: string,
  voiceNote: boolean,
): "image" | "document" | "audio" | null {
  if (voiceNote) return VOICE_TYPES.has(mimeType) ? "audio" : null;
  if (IMAGE_TYPES.has(mimeType)) return "image";
  if (DOCUMENT_TYPES.has(mimeType)) return "document";
  return null;
}

export function extensionForOutboundMime(mimeType: string): string {
  return EXTENSIONS[mimeType] ?? "bin";
}

/** A staff filename is display text, never part of a storage path. */
export function safeOutboundFilename(value: string | null | undefined): string | null {
  if (!value) return null;
  const cleaned = value
    .replace(/[\u0000-\u001F\u007F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, "")
    .replace(/[/\\]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || cleaned === "." || cleaned === "..") return null;
  return cleaned.slice(0, 255);
}

export function isAllowedOutboundDocumentMime(mimeType: string): boolean {
  return IMAGE_TYPES.has(mimeType) || DOCUMENT_TYPES.has(mimeType);
}
