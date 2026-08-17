import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import pino from "pino";
import type { WorkerConfig } from "./config.ts";
import type { SessionManager } from "./sessions.ts";
import type { Store } from "./store.ts";

const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 64 * 1024;

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

export function createWorkerServer(
  config: WorkerConfig,
  sessions: SessionManager,
  store: Store,
): Server {
  return createServer((request, response) => {
    void handle(request, response, config, sessions, store).catch((error: unknown) => {
      logger.error({ error }, "request failed");
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
  if (request.method === "GET" && url.pathname === "/healthz") {
    json(response, 200, { ok: true, workerId: config.workerId, sessions: sessions.clinicIds().length });
    return;
  }

  if (!authorized(request, config.apiToken)) {
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
    const started = await sessions.start(clinicId);
    if (!started.ok) {
      json(response, 409, { error: "owned_elsewhere" });
      return;
    }
    json(response, 200, { ok: true });
    return;
  }

  if (request.method === "POST" && action === "/logout") {
    await sessions.logout(clinicId);
    json(response, 200, { ok: true });
    return;
  }

  if (request.method === "POST" && action === "/messages") {
    let payload: { recipient?: unknown; body?: unknown };
    try {
      payload = (await readBody(request)) as { recipient?: unknown; body?: unknown };
    } catch {
      json(response, 400, { error: "invalid_body" });
      return;
    }
    const recipient = typeof payload.recipient === "string" ? payload.recipient.trim() : "";
    const body = typeof payload.body === "string" ? payload.body : "";
    if (!recipient || body.trim().length === 0) {
      json(response, 400, { error: "invalid_message" });
      return;
    }
    const sent = await sessions.send(clinicId, recipient, body);
    if (!sent.ok) {
      // NO_SESSION / NOT_CONNECTED are 409: the request was well-formed, the
      // pairing simply is not carrying traffic right now.
      const status = sent.code === "INVALID_RECIPIENT" ? 400 : sent.code === "SEND_FAILED" ? 502 : 409;
      json(response, status, { ok: false, error: sent.code });
      return;
    }
    json(response, 200, { ok: true, providerMessageId: sent.providerMessageId });
    return;
  }

  json(response, 405, { error: "method_not_allowed" });
}
