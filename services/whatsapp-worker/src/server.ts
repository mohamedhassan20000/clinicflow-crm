import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import pino from "pino";
import type { WorkerConfig } from "./config.ts";
import { workerProtocolAdvertisement } from "./protocol.ts";
import type {
  OutboundMediaReference,
  OutboundSendRequest,
  SessionManager,
} from "./sessions.ts";
import type { Store } from "./store.ts";

const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 64 * 1024;
const IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const DOCUMENT_MIME_TYPES = new Set([
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
const AUDIO_MIME_TYPES = new Set(["audio/ogg", "audio/webm", "audio/mp4", "audio/mpeg", "audio/aac"]);

/**
 * The worker's private API. Its only client is the ClinicFlow application,
 * authenticated with a bearer token compared in constant time; there is no
 * per-clinic authorization here because there is no per-clinic caller — the
 * application has already proved the admin's clinic before it calls, and every
 * route is addressed by that clinic's id.
 *
 * This service must never be exposed publicly. Bind it to a private network or
 * put it behind an allow-list; the token is the last line, not the first.
 */

function json(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function authorized(request: IncomingMessage, token: string): boolean {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return false;
  const presented = Buffer.from(header.slice(7), "utf8");
  const expected = Buffer.from(token, "utf8");
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("BODY_TOO_LARGE");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function parseMedia(value: unknown, clinicId: string): OutboundMediaReference | null {
  if (!value || typeof value !== "object") return null;
  const media = value as Record<string, unknown>;
  const kind = media.kind;
  const bucket = media.bucket;
  const mimeType = typeof media.mimeType === "string" ? media.mimeType.trim().toLowerCase() : "";
  const storagePath = typeof media.storagePath === "string" ? media.storagePath.trim() : "";
  const fileName = media.fileName === null || media.fileName === undefined
    ? null
    : typeof media.fileName === "string"
      ? media.fileName.trim()
      : "";
  const prefixes: Record<string, string> = {
    "whatsapp-outbound": `${clinicId}/`,
    "patient-assets": `documents/${clinicId}/`,
    "clinic-documents": `documents/${clinicId}/`,
  };
  if (kind !== "image" && kind !== "document" && kind !== "audio") return null;
  if (typeof bucket !== "string" || !prefixes[bucket]) return null;
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(?:;\s*codecs=opus)?$/i.test(mimeType)) {
    return null;
  }
  if (
    !storagePath.startsWith(prefixes[bucket]) ||
    storagePath.startsWith("/") ||
    storagePath.includes("..") ||
    storagePath.includes("\\") ||
    storagePath.length > 512
  ) {
    return null;
  }
  if (
    fileName !== null &&
    (!fileName || fileName.length > 255 || /[/\\\u0000-\u001F\u007F]/.test(fileName))
  ) {
    return null;
  }
  if (typeof media.voiceNote !== "boolean") return null;
  if (media.voiceNote !== (kind === "audio")) return null;
  if (
    (kind === "image" && !IMAGE_MIME_TYPES.has(mimeType)) ||
    (kind === "document" && !DOCUMENT_MIME_TYPES.has(mimeType)) ||
    (kind === "audio" && !AUDIO_MIME_TYPES.has(mimeType))
  ) {
    return null;
  }
  return {
    kind,
    mimeType,
    bucket: bucket as OutboundMediaReference["bucket"],
    storagePath,
    fileName,
    voiceNote: media.voiceNote,
  };
}

export function createWorkerServer(
  config: WorkerConfig,
  sessions: SessionManager,
  store: Store,
): Server {
  return createServer((request, response) => {
    void handle(request, response, config, sessions, store).catch((error: unknown) => {
      logger.error({ err: error }, "request failed");
      if (!response.headersSent) json(response, 500, { error: "internal" });
    });
  });
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  config: WorkerConfig,
  sessions: SessionManager,
  store: Store,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://worker.local");

  // Liveness is deliberately unauthenticated and says nothing about tenants.
  //
  // It does carry the protocol advertisement, and that placement is the point:
  // the application has to be able to establish that this worker understands
  // account isolation *before* it starts a pairing, and an unauthenticated
  // probe is the one call it can always make. A version integer and a boolean
  // describe the build, not the deployment — see protocol.ts.
  if (request.method === "GET" && url.pathname === "/healthz") {
    json(response, 200, {
      ok: true,
      workerId: config.workerId,
      sessions: sessions.clinicIds().length,
      ...workerProtocolAdvertisement(),
    });
    return;
  }

  if (!authorized(request, config.apiToken)) {
    // The token itself is never logged, nor its length, nor whether one was
    // presented at all beyond this coarse reason — but the fact that a call
    // arrived and was turned away has to be visible, or a token mismatch
    // between the application and this worker is indistinguishable from the
    // application never having called.
    logger.warn(
      { method: request.method, path: url.pathname },
      "rejected a request that did not present this worker's token",
    );
    json(response, 401, { error: "unauthorized" });
    return;
  }

  const match = /^\/v1\/sessions\/([^/]+)(\/[a-z]+)?$/.exec(url.pathname);
  if (!match) {
    json(response, 404, { error: "not_found" });
    return;
  }
  const clinicId = decodeURIComponent(match[1] ?? "");
  const action = match[2] ?? "";
  if (!UUID.test(clinicId)) {
    json(response, 400, { error: "invalid_clinic" });
    return;
  }

  if (request.method === "GET" && action === "") {
    const session = await store.readSession(clinicId);
    json(response, 200, {
      ok: true,
      status: session?.status ?? "not_started",
      phoneNumber: session?.phone_number ?? null,
    });
    return;
  }

  if (request.method === "POST" && action === "/start") {
    // "Connect with QR" arriving here is the single most useful line in this
    // log: it is the boundary that proves the application reached the worker at
    // all, and it used to be silent in both the accepted and the refused case.
    logger.info({ clinicId }, "start requested");
    const started = await sessions.start(clinicId);
    if (!started.ok) {
      // `SessionManager` has already logged which worker holds the session.
      json(response, 409, { error: "owned_elsewhere" });
      return;
    }
    json(response, 200, { ok: true });
    return;
  }

  if (request.method === "POST" && action === "/history") {
    // "Sync WhatsApp history": an explicit request for older messages on an
    // already-paired device. Never a logout, never a re-pair — see
    // history-resync.ts for exactly which Baileys API this reaches and what it
    // cannot do. The refusals are 409 because the request was well formed and
    // the pairing simply is not in a state to answer it.
    logger.info({ clinicId }, "history resync requested");
    const outcome = await sessions.resyncHistory(clinicId);
    // Answered, not failed: every refusal here is a fact about the pairing's
    // current state that the application has to relay verbatim to the admin, so
    // it rides the body rather than an HTTP status the transport layer would
    // flatten into "the service is unavailable".
    json(response, 200, outcome.ok
      ? { ok: true, chats: outcome.chats, requested: outcome.requested }
      : { ok: false, error: outcome.code });
    return;
  }

  if (request.method === "POST" && action === "/logout") {
    await sessions.logout(clinicId);
    json(response, 200, { ok: true });
    return;
  }

  if (request.method === "POST" && action === "/messages") {
    let payload: { recipient?: unknown; body?: unknown; media?: unknown };
    try {
      payload = (await readBody(request)) as { recipient?: unknown; body?: unknown; media?: unknown };
    } catch {
      json(response, 400, { error: "invalid_body" });
      return;
    }
    const recipient = typeof payload.recipient === "string" ? payload.recipient.trim() : "";
    const body = typeof payload.body === "string" ? payload.body : "";
    const hasMedia = payload.media != null;
    const media = hasMedia ? parseMedia(payload.media, clinicId) ?? null : undefined;
    if (hasMedia) {
      logger.info(
        {
          clinicId,
          stage: "worker_media_request_received",
          outcome: media ? "accepted" : "rejected",
          mediaKind: media?.kind ?? "invalid",
          bucket: media?.bucket ?? "invalid",
          pathSendable: Boolean(media),
        },
        "outbound media diagnostic",
      );
    }
    if (!recipient || body.length > 8192 || (!body.trim() && !media) || media === null) {
      json(response, 400, {
        error: hasMedia && media === null ? "MEDIA_REQUEST_REJECTED" : "invalid_message",
      });
      return;
    }
    const message: OutboundSendRequest = { body, ...(media ? { media } : {}) };
    const sent = await sessions.send(clinicId, recipient, message);
    if (!sent.ok) {
      // NO_SESSION / NOT_CONNECTED are 409: the request was well-formed, the
      // pairing simply is not carrying traffic right now.
      const status = sent.code === "INVALID_RECIPIENT"
        ? 400
        : sent.code === "MEDIA_TRANSCODE_FAILED"
          ? 422
          : sent.code === "SEND_FAILED" ||
              sent.code === "MEDIA_STORAGE_FETCH_FAILED" ||
              sent.code === "MEDIA_BAILEYS_SEND_FAILED"
            ? 502
            : 409;
      json(response, status, { ok: false, error: sent.code });
      return;
    }
    json(response, 200, { ok: true, providerMessageId: sent.providerMessageId });
    return;
  }

  json(response, 405, { error: "method_not_allowed" });
}
