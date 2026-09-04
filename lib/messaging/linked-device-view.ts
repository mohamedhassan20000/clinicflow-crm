/**
 * P7E — the client-visible projection of a WhatsApp linked-device pairing.
 *
 * The settings page and the server actions both produce this from the same
 * rule, so it is deliberately not `server-only`. Everything that could identify
 * the session to anyone but its own clinic stays behind the boundary: the
 * authentication state, the worker's identity, the socket, the raw library
 * error. What crosses is a coarse status, the image the admin has to scan, the
 * number that ended up paired, and a stable failure code.
 */

export type LinkedDeviceStatus =
  /** No pairing has ever been started for this clinic. */
  | "not_started"
  /** The worker accepted the request; the pairing socket is coming up. */
  | "starting"
  /** A pairing code is on screen and waiting to be scanned. */
  | "awaiting_scan"
  /** Scanned; WhatsApp is finishing the handshake. */
  | "connecting"
  | "connected"
  /** Deliberately ended, by the clinic or by WhatsApp. */
  | "disconnected"
  | "error";

/**
 * Stable, non-technical failure codes. The UI maps each to one localized
 * sentence; no library, socket or provider text is ever carried across.
 */
export type LinkedDeviceErrorCode =
  /** The pairing service is not configured or not reachable right now. */
  | "unavailable"
  /** The code expired or was refused before it was scanned. */
  | "pairing_failed"
  /** The number was unlinked from the phone's Linked Devices screen. */
  | "logged_out"
  /**
   * The pairing service is reachable but older than this application. Only ever
   * produced by the pre-pairing handshake, never stored on a session row: it
   * describes the deployment, not the clinic.
   */
  | "worker_outdated"
  | "unknown";

export type LinkedDeviceView = {
  status: LinkedDeviceStatus;
  /** PNG data URL of the current pairing code; only while `awaiting_scan`. */
  qrImage: string | null;
  qrExpiresAt: string | null;
  /** The paired WhatsApp number, once known. */
  phoneNumber: string | null;
  connectedAt: string | null;
  errorCode: LinkedDeviceErrorCode | null;
};

export const NOT_STARTED_LINKED_DEVICE_VIEW: LinkedDeviceView = {
  status: "not_started",
  qrImage: null,
  qrExpiresAt: null,
  phoneNumber: null,
  connectedAt: null,
  errorCode: null,
};

/** The states in which the clinic should keep polling for a change. */
export function isLinkedDeviceTransient(status: LinkedDeviceStatus): boolean {
  return status === "starting" || status === "awaiting_scan" || status === "connecting";
}

const STATUSES = new Set<LinkedDeviceStatus>([
  "not_started",
  "starting",
  "awaiting_scan",
  "connecting",
  "connected",
  "disconnected",
  "error",
]);

const ERROR_CODES = new Set<LinkedDeviceErrorCode>([
  "unavailable",
  "pairing_failed",
  "logged_out",
  "worker_outdated",
  "unknown",
]);

/** Narrows the free-text status column written by the worker. */
export function asLinkedDeviceStatus(value: string | null): LinkedDeviceStatus {
  return value && STATUSES.has(value as LinkedDeviceStatus)
    ? (value as LinkedDeviceStatus)
    : "not_started";
}

/** Narrows the stored failure code; anything unrecognized reads as `unknown`. */
export function asLinkedDeviceErrorCode(
  value: string | null,
): LinkedDeviceErrorCode | null {
  if (!value) return null;
  return ERROR_CODES.has(value as LinkedDeviceErrorCode)
    ? (value as LinkedDeviceErrorCode)
    : "unknown";
}
