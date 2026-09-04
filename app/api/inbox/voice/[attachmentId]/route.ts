import { createHash } from "node:crypto";
import {
  logVoicePlaybackLoadDiagnostic,
} from "@/lib/messaging/inbound-media-diagnostics";
import { getAuthedUser } from "@/lib/rbac";
import { downloadWhatsAppAttachment } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

type RouteContext = { params: Promise<{ attachmentId: string }> };

type ByteRange = { start: number; end: number };

const AUDIO_MIME = /^audio\/[a-z0-9.+-]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function audioMime(value: string | null | undefined): string | null {
  const mime = value?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return AUDIO_MIME.test(mime) ? mime : null;
}

export function parseSingleByteRange(value: string, size: number): ByteRange | null {
  if (!value.startsWith("bytes=") || value.includes(",") || size <= 0) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match) return null;
  const startText = match[1] ?? "";
  const endText = match[2] ?? "";
  if (!startText && !endText) return null;

  if (!startText) {
    const suffixLength = Number(endText);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }

  const start = Number(startText);
  const requestedEnd = endText ? Number(endText) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    start >= size ||
    requestedEnd < start
  ) {
    return null;
  }
  return { start, end: Math.min(requestedEnd, size - 1) };
}

function errorResponse(status: number, headers?: HeadersInit): Response {
  return new Response(null, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  });
}

async function serveVoice(request: Request, context: RouteContext, head: boolean): Promise<Response> {
  const rangeHeader = request.headers.get("range");
  const rangeRequested = rangeHeader !== null;
  const user = await getAuthedUser();
  if (!user) return errorResponse(401);
  if (user.role !== "admin" && user.role !== "receptionist") {
    logVoicePlaybackLoadDiagnostic({
      stage: "request_failed",
      clinicId: user.clinicId,
      httpStatus: 403,
      rangeRequested,
      errorCategory: "role_forbidden",
    });
    return errorResponse(403);
  }

  logVoicePlaybackLoadDiagnostic({
    stage: "request_started",
    clinicId: user.clinicId,
    httpStatus: 0,
    rangeRequested,
    readyState: "authorized",
  });

  const { attachmentId } = await context.params;
  if (!UUID.test(attachmentId)) {
    logVoicePlaybackLoadDiagnostic({
      stage: "request_failed",
      clinicId: user.clinicId,
      httpStatus: 404,
      rangeRequested,
      errorCategory: "not_found",
    });
    return errorResponse(404);
  }

  const supabase = await createClient();
  const attachmentResult = await supabase
    .from("inbound_message_attachments")
    .select("storage_path, byte_size, mime_type, sha256")
    .eq("id", attachmentId)
    .eq("clinic_id", user.clinicId)
    .eq("media_kind", "audio")
    .eq("status", "stored")
    .maybeSingle();
  const attachment = attachmentResult.data;
  if (attachmentResult.error || !attachment?.storage_path) {
    const status = attachmentResult.error ? 503 : 404;
    logVoicePlaybackLoadDiagnostic({
      stage: "request_failed",
      clinicId: user.clinicId,
      httpStatus: status,
      rangeRequested,
      errorCategory: attachmentResult.error ? "metadata_read_failed" : "not_found",
    });
    return errorResponse(status);
  }

  const downloaded = await downloadWhatsAppAttachment({
    clinicId: user.clinicId,
    storagePath: attachment.storage_path,
  });
  if (downloaded.error || !downloaded.data) {
    logVoicePlaybackLoadDiagnostic({
      stage: "request_failed",
      clinicId: user.clinicId,
      httpStatus: 502,
      mimeType: attachment.mime_type,
      objectByteCount: attachment.byte_size,
      rangeRequested,
      readyState: "stored",
      errorCategory: "storage_download_failed",
    });
    return errorResponse(502);
  }

  const bytes = Buffer.from(await downloaded.data.arrayBuffer());
  const mimeType = audioMime(downloaded.data.type) ?? audioMime(attachment.mime_type);
  const shaMatches = !attachment.sha256 ||
    createHash("sha256").update(bytes).digest("hex") === attachment.sha256;
  if (!mimeType || bytes.length <= 0 || bytes.length !== attachment.byte_size || !shaMatches) {
    let category = "integrity_mismatch";
    if (!mimeType) category = "wrong_mime";
    else if (bytes.length <= 0) category = "empty_object";
    else if (bytes.length !== attachment.byte_size) category = "byte_count_mismatch";
    logVoicePlaybackLoadDiagnostic({
      stage: "request_failed",
      clinicId: user.clinicId,
      httpStatus: 502,
      mimeType: mimeType ?? attachment.mime_type,
      objectByteCount: attachment.byte_size,
      responseByteCount: bytes.length,
      rangeRequested,
      readyState: "stored",
      errorCategory: category,
    });
    return errorResponse(502);
  }

  const range = rangeHeader ? parseSingleByteRange(rangeHeader, bytes.length) : null;
  if (rangeHeader && !range) {
    logVoicePlaybackLoadDiagnostic({
      stage: "request_failed",
      clinicId: user.clinicId,
      httpStatus: 416,
      mimeType,
      objectByteCount: bytes.length,
      responseByteCount: 0,
      rangeRequested: true,
      readyState: "stored",
      errorCategory: "invalid_range",
    });
    return errorResponse(416, {
      "Accept-Ranges": "bytes",
      "Content-Range": `bytes */${bytes.length}`,
    });
  }

  const status = range ? 206 : 200;
  const responseBytes = range ? bytes.subarray(range.start, range.end + 1) : bytes;
  const headers = new Headers({
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
    "Content-Length": String(responseBytes.length),
    "Content-Type": mimeType,
    "X-Content-Type-Options": "nosniff",
  });
  if (range) headers.set("Content-Range", `bytes ${range.start}-${range.end}/${bytes.length}`);

  logVoicePlaybackLoadDiagnostic({
    stage: "response_ready",
    clinicId: user.clinicId,
    httpStatus: status,
    mimeType,
    objectByteCount: bytes.length,
    responseByteCount: responseBytes.length,
    rangeRequested,
    readyState: "response_ready",
  });
  return new Response(head ? null : new Uint8Array(responseBytes), { status, headers });
}

export function GET(request: Request, context: RouteContext) {
  return serveVoice(request, context, false);
}

export function HEAD(request: Request, context: RouteContext) {
  return serveVoice(request, context, true);
}
