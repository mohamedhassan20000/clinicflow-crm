import "server-only";
import * as Sentry from "@sentry/nextjs";
import QRCode from "qrcode";
import {
  asLinkedDeviceErrorCode,
  asLinkedDeviceStatus,
  NOT_STARTED_LINKED_DEVICE_VIEW,
  type LinkedDeviceView,
} from "@/lib/messaging/linked-device-view";
import {
  readWorkerCompatibility,
  type WorkerCompatibility,
} from "@/lib/messaging/worker-protocol";
import { createClinicScopedAdminClient } from "@/lib/supabase/admin";

/**
 * P7E — the Next.js half of the "Connect with QR" (WhatsApp Linked Devices)
 * transport.
 *
 * Why there is a worker at all: a linked device is a *long-lived* authenticated
 * websocket to WhatsApp. This application is deployed to a serverless platform
 * where no process is guaranteed to outlive a request, so a socket opened inside
 * a route handler would be torn down moments later, mid-handshake, and the
 * clinic would be asked to scan again on every request. The socket therefore
 * lives in one always-on worker (services/whatsapp-worker); this module only
 * ever asks that worker to do something and reads the state it publishes.
 *
 * Everything in here is clinic-scoped by argument. The caller has already
 * proven the clinic through requireMutationRole/requireRole, the database reads
 * go through the clinic-scoped admin client, and the worker's API is addressed
 * per clinic — no call in this module can observe or mutate another tenant.
 */

const WORKER_TIMEOUT_MS = 8_000;

type WorkerConfig = { baseUrl: string; token: string };

function workerConfig(): WorkerConfig | null {
  const raw = process.env.WHATSAPP_WORKER_URL;
  const token = process.env.WHATSAPP_WORKER_TOKEN;
  if (!raw || !token) return null;
  try {
    const url = new URL(raw);
    // Plain HTTP is only tolerated for a loopback worker in development; the
    // bearer token must never travel a public network in the clear.
    if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
      return null;
    }
    return { baseUrl: url.origin, token };
  } catch {
    return null;
  }
}

/** Whether the QR method can be offered at all in this environment. */
export function isLinkedDeviceConfigured(): boolean {
  return workerConfig() !== null;
}

/**
 * `OWNED_ELSEWHERE` is deliberately its own outcome rather than a flavour of
 * `REJECTED`. It is the one refusal that is not a fault of the request: another
 * worker instance holds this clinic's session — the situation a developer runs
 * a local worker against a shared database into — and telling the clinic the
 * service is "unavailable" sends everyone looking at the wrong thing.
 */
type WorkerFailureCode = "UNAVAILABLE" | "REJECTED" | "OWNED_ELSEWHERE";

type WorkerResult<T> = { ok: true; data: T } | { ok: false; code: WorkerFailureCode };

/**
 * Says which worker a call went to and how it ended, without ever naming the
 * bearer token.
 *
 * The origin is the one detail that makes a misrouted call diagnosable at a
 * glance — a local run silently talking to the deployed worker looks exactly
 * like a local run talking to nothing — and an origin is an address, not a
 * secret. Only failures are reported, so a healthy deployment stays quiet.
 */
function reportWorkerFailure(
  baseUrl: string,
  path: string,
  code: WorkerFailureCode,
  status: number | null,
): void {
  const origin = (() => {
    try {
      return new URL(baseUrl).origin;
    } catch {
      return "invalid";
    }
  })();
  Sentry.addBreadcrumb({
    category: "messaging.linked_device",
    level: "warning",
    message: "pairing worker call failed",
    data: { origin, path, code, status },
  });
  // Server-side only. A 401 here means this deployment and its worker disagree
  // about the shared token, which is an operator's problem and must be visible
  // as one — while the clinic still only ever sees one generic sentence.
  console.warn(
    `[messaging] linked-device worker call failed: origin=${origin} path=${path} code=${code} status=${status ?? "none"}`,
  );
}

async function callWorker<T>(
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<WorkerResult<T>> {
  const config = workerConfig();
  if (!config) return { ok: false, code: "UNAVAILABLE" };
  try {
    const response = await fetch(new URL(path, config.baseUrl), {
      method: init?.method ?? "POST",
      headers: {
        authorization: `Bearer ${config.token}`,
        "content-type": "application/json",
      },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
      cache: "no-store",
      signal: AbortSignal.timeout(WORKER_TIMEOUT_MS),
    });
    if (response.ok) return { ok: true, data: (await response.json()) as T };
    const code: WorkerFailureCode =
      response.status >= 500
        ? "UNAVAILABLE"
        : response.status === 409
          ? "OWNED_ELSEWHERE"
          : "REJECTED";
    reportWorkerFailure(config.baseUrl, path, code, response.status);
    return { ok: false, code };
  } catch {
    // A timeout, DNS failure or connection refusal all mean the same thing to
    // the clinic: the pairing service is not answering right now.
    reportWorkerFailure(config.baseUrl, path, "UNAVAILABLE", null);
    return { ok: false, code: "UNAVAILABLE" };
  }
}

/**
 * Asks the configured worker what protocol it speaks.
 *
 * `/healthz` is the worker's unauthenticated liveness route; the bearer token
 * goes along anyway because `callWorker` always sends it and the worker ignores
 * it there. Nothing tenant-specific is sent or read — the question is about the
 * build, not this clinic — and the answer is never surfaced to the browser
 * beyond the single outcome the pairing action maps to one sentence.
 */
async function readWorkerProtocol(): Promise<WorkerCompatibility> {
  const health = await callWorker<unknown>("/healthz", { method: "GET" });
  if (!health.ok) return { compatible: false, reason: "unreachable" };
  return readWorkerCompatibility(health.data);
}

type SessionRow = {
  status: string;
  qr_payload: string | null;
  qr_expires_at: string | null;
  phone_number: string | null;
  connected_at: string | null;
  last_error: string | null;
};

const SESSION_COLUMNS =
  "status, qr_payload, qr_expires_at, phone_number, connected_at, last_error";

/**
 * Turns the stored pairing payload into the image the admin scans.
 *
 * The payload is rendered here, on the server, rather than shipped to the
 * browser as a string: the client then needs no QR library, and the value that
 * reaches the page is a picture of a code that is only useful for the seconds it
 * remains valid.
 */
async function renderQr(payload: string | null, expiresAt: string | null): Promise<string | null> {
  if (!payload) return null;
  if (expiresAt && new Date(expiresAt).valueOf() <= Date.now()) return null;
  try {
    return await QRCode.toDataURL(payload, { margin: 1, width: 320, errorCorrectionLevel: "L" });
  } catch (error) {
    Sentry.captureException(error, { tags: { scope: "messaging", provider: "linked_device" } });
    return null;
  }
}

async function toView(row: SessionRow | null): Promise<LinkedDeviceView> {
  if (!row) return NOT_STARTED_LINKED_DEVICE_VIEW;
  const status = asLinkedDeviceStatus(row.status);
  const qrImage = status === "awaiting_scan" ? await renderQr(row.qr_payload, row.qr_expires_at) : null;
  return {
    status,
    qrImage,
    // Only surfaced alongside a live code, so the UI never counts down a code
    // it is not showing.
    qrExpiresAt: qrImage ? row.qr_expires_at : null,
    phoneNumber: status === "connected" ? row.phone_number : null,
    connectedAt: status === "connected" ? row.connected_at : null,
    errorCode: status === "error" ? (asLinkedDeviceErrorCode(row.last_error) ?? "unknown") : null,
  };
}

/**
 * The current pairing state for one clinic, read straight from the durable row
 * the worker maintains. This is the poll the QR panel runs: it never touches the
 * worker, so a busy or restarting worker cannot make the page hang.
 */
export async function readLinkedDeviceSession(clinicId: string): Promise<LinkedDeviceView> {
  const result = await createClinicScopedAdminClient(clinicId)
    .from("whatsapp_linked_device_sessions")
    .select(SESSION_COLUMNS)
    .maybeSingle();
  if (result.error) {
    return { ...NOT_STARTED_LINKED_DEVICE_VIEW, status: "error", errorCode: "unknown" };
  }
  return toView(result.data);
}

export type LinkedDeviceStartResult =
  | { ok: true; view: LinkedDeviceView }
  | {
      ok: false;
      code:
        | "UNAVAILABLE"
        | "OWNED_BY_META"
        | "OWNED_ELSEWHERE"
        | "REJECTED"
        /**
         * The worker answered but predates linked-account isolation. A release
         * blocker, not a transient fault: retrying cannot fix it, and pairing
         * across it would write rows no account can ever be proved for.
         */
        | "WORKER_UPDATE_REQUIRED";
    };

/**
 * Starts (or restarts) this clinic's pairing.
 *
 * The clinic holds exactly one WhatsApp channel, so a channel already owned by
 * the Meta Cloud API method blocks this rather than racing it — the clinic is
 * told to disconnect there first. The worker is idempotent: asking it to start a
 * session that is already up returns that session's state instead of opening a
 * second socket.
 *
 * The worker answers this call as soon as it has durably recorded the request,
 * not when WhatsApp has answered — so what comes back here is normally
 * `starting`, and the code itself appears in the session row a moment later,
 * which the panel's poll picks up. `WORKER_TIMEOUT_MS` therefore bounds a
 * two-statement write, not a handshake.
 */
export async function startLinkedDeviceSession(
  clinicId: string,
): Promise<LinkedDeviceStartResult> {
  const client = createClinicScopedAdminClient(clinicId);
  const existingChannel = await client
    .from("clinic_channels")
    .select("provider")
    .eq("channel", "whatsapp")
    .neq("provider", "linked_device")
    .eq("status", "active")
    .maybeSingle();
  if (existingChannel.error) return { ok: false, code: "REJECTED" };
  if (existingChannel.data) return { ok: false, code: "OWNED_BY_META" };

  // Then, and still before anything is written: a worker that cannot scope what
  // it writes to an authenticated account must not be allowed to begin a
  // pairing. Everything above this line is a read, so refusing here leaves no
  // auth state created, no session row mutated, no channel activated and no
  // ownership changed — the clinic is exactly as it was, and an operator has a
  // specific thing to go and do. (The Meta conflict is checked first only
  // because it is the more specific answer and needs no worker at all.)
  const protocol = await readWorkerProtocol();
  if (!protocol.compatible) {
    return {
      ok: false,
      code: protocol.reason === "outdated" ? "WORKER_UPDATE_REQUIRED" : "UNAVAILABLE",
    };
  }

  const started = await callWorker<{ ok: true }>(
    `/v1/sessions/${encodeURIComponent(clinicId)}/start`,
  );
  if (!started.ok) return { ok: false, code: started.code };
  return { ok: true, view: await readLinkedDeviceSession(clinicId) };
}

/**
 * Ends this clinic's pairing and releases the number.
 *
 * The worker is asked first, so WhatsApp itself is told to drop the linked
 * device and the encrypted authentication state is discarded at its source. If
 * the worker cannot be reached the local teardown still runs: a clinic must
 * never be stuck "connected" to a session nothing is serving. Both halves are
 * scoped to this clinic and cannot reach another tenant's rows.
 */
export async function disconnectLinkedDeviceSession(
  clinicId: string,
): Promise<{ ok: true; workerReached: boolean } | { ok: false }> {
  const stopped = await callWorker<{ ok: true }>(
    `/v1/sessions/${encodeURIComponent(clinicId)}/logout`,
  );

  const client = createClinicScopedAdminClient(clinicId);
  const channel = await client
    .from("clinic_channels")
    .delete()
    .eq("channel", "whatsapp")
    .eq("provider", "linked_device");
  if (channel.error) return { ok: false };

  // Whatever the worker managed to do, the clinic's stored intent is now
  // "offline" and no pairing secret of theirs remains.
  const session = await client
    .from("whatsapp_linked_device_sessions")
    .update({
      status: "disconnected",
      desired_state: "offline",
      qr_payload: null,
      qr_expires_at: null,
      phone_number: null,
      connected_at: null,
      last_error: null,
    })
    .eq("clinic_id", clinicId);
  if (session.error) return { ok: false };
  const auth = await client.from("whatsapp_linked_device_auth").delete().eq("clinic_id", clinicId);
  if (auth.error) return { ok: false };

  // No transport is promoted in its place. A pairing can only be started while
  // no other WhatsApp channel is active, so anything still on this clinic is a
  // pending, unverified row that must not be silently made live; the clinic is
  // simply left with no WhatsApp channel, which the send path degrades to email.
  return { ok: true, workerReached: stopped.ok };
}

export type HistoryImportView = {
  status: "idle" | "importing" | "partial" | "complete" | "unavailable";
  chatsImported: number;
  messagesImported: number;
  completedAt: string | null;
};

const IDLE_HISTORY_IMPORT_VIEW: HistoryImportView = {
  status: "idle",
  chatsImported: 0,
  messagesImported: 0,
  completedAt: null,
};

function asHistoryStatus(value: string | null): HistoryImportView["status"] {
  return value === "importing" ||
    value === "partial" ||
    value === "complete" ||
    value === "unavailable"
    ? value
    : "idle";
}

/**
 * Import progress for one clinic.
 *
 * P8B: there is no held-for-review list any more. The import no longer stages
 * anything — every chat it carries becomes a conversation in the Inbox — so
 * what a clinic needs from this surface is how far the import got, and nothing
 * else.
 */
export async function readHistoryImportView(clinicId: string): Promise<HistoryImportView> {
  const client = createClinicScopedAdminClient(clinicId);
  const session = await client
    .from("whatsapp_linked_device_sessions")
    .select(
      "history_status, history_chats_imported, history_messages_imported, history_completed_at",
    )
    .maybeSingle();
  if (session.error) return IDLE_HISTORY_IMPORT_VIEW;
  return {
    status: asHistoryStatus(session.data?.history_status ?? null),
    chatsImported: session.data?.history_chats_imported ?? 0,
    messagesImported: session.data?.history_messages_imported ?? 0,
    completedAt: session.data?.history_completed_at ?? null,
  };
}

/**
 * The refusals "Sync WhatsApp history" can come back with, as the worker names
 * them. Each is a fact about the pairing's current state, not a transport
 * failure, so each gets its own sentence in the panel rather than collapsing
 * into "unavailable".
 */
export type HistorySyncResult =
  | { ok: true; chats: number; requested: number }
  | {
      ok: false;
      code:
        /** Nothing paired, or this clinic's socket is not held by the worker. */
        | "NO_SESSION"
        /** Paired but not yet identified: no authenticated account is bound. */
        | "NOT_CONNECTED"
        /** The worker's Baileys build has no on-demand history API. */
        | "UNSUPPORTED"
        /**
         * Nothing to extend backwards from. On-demand history is anchored on a
         * message the device already has; an inbox with no imported messages
         * has no anchor, and WhatsApp offers no anchorless request.
         */
        | "NO_ANCHORS"
        | "COOLDOWN"
        | "IN_PROGRESS"
        | "UNAVAILABLE";
    };

type HistorySyncFailureCode = Extract<HistorySyncResult, { ok: false }>["code"];

const HISTORY_SYNC_CODES: ReadonlySet<string> = new Set<HistorySyncFailureCode>([
  "NO_SESSION",
  "NOT_CONNECTED",
  "UNSUPPORTED",
  "NO_ANCHORS",
  "COOLDOWN",
  "IN_PROGRESS",
]);

/**
 * Asks this clinic's live session to fetch older history for the account it is
 * already authenticated as.
 *
 * Nothing is written here. The worker owns every guard that matters — account
 * scope, ownership fencing, the bound on how much is requested — because it is
 * the only side that can see which account the socket is actually authenticated
 * as. This function's whole job is to address the right clinic and relay the
 * answer.
 */
export async function requestLinkedDeviceHistorySync(
  clinicId: string,
): Promise<HistorySyncResult> {
  const answered = await callWorker<{
    ok?: boolean;
    error?: string;
    chats?: number;
    requested?: number;
  }>(`/v1/sessions/${encodeURIComponent(clinicId)}/history`);
  if (!answered.ok) return { ok: false, code: "UNAVAILABLE" };
  const body = answered.data;
  if (body?.ok) {
    return { ok: true, chats: body.chats ?? 0, requested: body.requested ?? 0 };
  }
  // An unrecognised code is reported as "unavailable" rather than passed
  // through: the panel only has sentences for the codes above.
  const code = typeof body?.error === "string" && HISTORY_SYNC_CODES.has(body.error)
    ? (body.error as HistorySyncFailureCode)
    : "UNAVAILABLE";
  return { ok: false, code };
}
