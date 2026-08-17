import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * P7D — per-clinic Meta webhook verification token.
 *
 * A clinic connecting its *own* Meta app configures the callback URL inside its
 * own Meta dashboard, and Meta then performs the `hub.mode=subscribe` handshake
 * against a token the clinic chose to paste there. The platform token
 * (META_WEBHOOK_VERIFY_TOKEN) must never be handed to clinics — it is a shared
 * secret across every platform-brokered channel — so each clinic gets its own.
 *
 * The token is *derived*, not stored: an HMAC of the clinic id under the
 * platform messaging key. That means
 *   * the GET handshake needs no database read and no credential decryption,
 *   * the token is stable across reconnects, so a clinic pastes it once,
 *   * it is one-way — showing it to a clinic admin reveals nothing about the
 *     key or about any other clinic's token.
 *
 * The callback URL carries `?clinic=<uuid>` so the handshake knows which token
 * to derive. That identifier is not a secret and grants nothing on its own: the
 * handshake still requires the matching token, and every POST is still
 * authenticated by X-Hub-Signature-256 and routed by the provider ids in the
 * payload — never by this parameter.
 */

const DOMAIN = "clinicflow:wa-webhook-verify:v1";
/** 32 base64url chars ≈ 192 bits — ample for a handshake token, and pasteable. */
const TOKEN_LENGTH = 32;

function messagingKey(): Buffer | null {
  const raw = process.env.MESSAGING_CREDENTIALS_KEY;
  if (!raw) return null;
  let key: Buffer;
  try {
    key = Buffer.from(raw, "base64");
  } catch {
    return null;
  }
  return key.length === 32 ? key : null;
}

/**
 * The verify token for one clinic, or null when the messaging key is absent or
 * malformed (the same condition that already makes credential storage fail).
 */
export function deriveWebhookVerifyToken(clinicId: string): string | null {
  const key = messagingKey();
  if (!key || !clinicId.trim()) return null;
  return createHmac("sha256", key)
    .update(`${DOMAIN}:${clinicId}`, "utf8")
    .digest("base64url")
    .slice(0, TOKEN_LENGTH);
}

/** Constant-time comparison of a presented handshake token. */
export function matchesWebhookVerifyToken(
  clinicId: string,
  presented: string | null | undefined,
): boolean {
  const expected = deriveWebhookVerifyToken(clinicId);
  if (!expected || !presented) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(presented, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
