import "server-only";
import * as Sentry from "@sentry/nextjs";
import QRCode from "qrcode";
import {
  asLinkedDeviceErrorCode,
  asLinkedDeviceStatus,
  NOT_STARTED_LINKED_DEVICE_VIEW,
  type LinkedDeviceView,
} from "@/lib/messaging/linked-device-view";
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

type WorkerResult<T> = { ok: true; data: T } | { ok: false; code: "UNAVAILABLE" | "REJECTED" };

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
    if (response.status >= 500) return { ok: false, code: "UNAVAILABLE" };
    if (!response.ok) return { ok: false, code: "REJECTED" };
    return { ok: true, data: (await response.json()) as T };
  } catch {
    // A timeout, DNS failure or connection refusal all mean the same thing to
    // the clinic: the pairing service is not answering right now.
    return { ok: false, code: "UNAVAILABLE" };
  }
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
  | { ok: false; code: "UNAVAILABLE" | "OWNED_BY_META" | "REJECTED" };

/**
 * Starts (or restarts) this clinic's pairing.
 *
 * The clinic holds exactly one WhatsApp channel, so a channel already owned by
 * the Meta Cloud API method blocks this rather than racing it — the clinic is
 * told to disconnect there first. The worker is idempotent: asking it to start a
 * session that is already up returns that session's state instead of opening a
 * second socket.
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
