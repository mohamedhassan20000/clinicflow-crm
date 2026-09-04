/**
 * The application's half of the pairing worker's compatibility handshake.
 *
 * WhatsApp account isolation is a property of both halves of this system: the
 * worker resolves the authenticated account from the Baileys socket identity
 * and stamps it on every row it writes; this application refuses to interpret
 * anything that is not so stamped. A worker that predates that contract still
 * answers `/start` happily and still pairs — and what it then writes is
 * account-less, which is precisely the shape that can never afterwards be
 * attributed to an account and must never be adopted into one.
 *
 * The trap is a deployment-ordering one and it is only ever sprung by a human
 * pressing "Connect with QR" in the window between the two deploys. So the
 * check happens there: before a pairing starts, and therefore before any
 * authentication state, session row or channel exists to be left half-migrated.
 *
 * Kept free of `server-only` so the constant can be asserted from either side
 * of the boundary; it reads nothing and reaches nothing on its own.
 */

/**
 * The lowest worker protocol the account-isolation model can be paired
 * against. Must move in step with `services/whatsapp-worker/src/protocol.ts`.
 */
export const REQUIRED_WORKER_PROTOCOL_VERSION = 2;

export type WorkerCompatibility =
  /** The worker advertises at least the protocol this application requires. */
  | { compatible: true }
  /**
   * The worker answered, but is older than this application — or new enough by
   * version yet not advertising the capability the version is about.
   */
  | { compatible: false; reason: "outdated" }
  /** No usable answer: unreachable, unconfigured, or not a worker at all. */
  | { compatible: false; reason: "unreachable" };

/**
 * Reads a `/healthz` payload strictly.
 *
 * Anything absent, mistyped or below the required version is "outdated" rather
 * than an error to be interpreted: an old worker's health response is a valid
 * response that simply does not make the promise this application needs, and
 * the two are indistinguishable from the outside — a build that predates the
 * advertisement omits the field, and a build that predates health output
 * entirely is unreachable. Neither may pair.
 */
export function readWorkerCompatibility(payload: unknown): WorkerCompatibility {
  if (typeof payload !== "object" || payload === null) {
    return { compatible: false, reason: "outdated" };
  }
  const record = payload as Record<string, unknown>;
  const version = record.workerProtocolVersion;
  if (typeof version !== "number" || !Number.isInteger(version)) {
    return { compatible: false, reason: "outdated" };
  }
  if (version < REQUIRED_WORKER_PROTOCOL_VERSION) {
    return { compatible: false, reason: "outdated" };
  }
  // A newer worker may drop the flag once the capability stops being optional;
  // it may never be *false* while this application requires it.
  if (record.linkedAccountIsolation === false) {
    return { compatible: false, reason: "outdated" };
  }
  return { compatible: true };
}
