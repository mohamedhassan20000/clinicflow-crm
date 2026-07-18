import "server-only";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import type { ChannelCredentials } from "@/lib/messaging/types";

/**
 * At-rest encryption for clinic_channels.credentials_encrypted (§9.2, HP6).
 *
 * AES-256-GCM with a platform key held only in the server environment
 * (MESSAGING_CREDENTIALS_KEY, base64-encoded 32 bytes). Encryption and
 * decryption happen exclusively in this module, inside lib/messaging/ server
 * code — ciphertext is what the database and any DB-level actor ever see,
 * and the clinic_channels table has no authenticated read policy at all.
 *
 * Envelope layout (bytea): [1-byte version][12-byte IV][16-byte auth tag][ciphertext].
 * The version byte exists so key/algorithm rotation can coexist with old rows.
 */

const ENVELOPE_VERSION = 1;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export class MessagingCryptoError extends Error {
  constructor(
    public readonly code:
      | "KEY_MISSING"
      | "KEY_INVALID"
      | "ENVELOPE_INVALID"
      | "DECRYPT_FAILED",
  ) {
    super(`Messaging credential encryption failed: ${code}`);
    this.name = "MessagingCryptoError";
  }
}

function loadKey(): Buffer {
  const raw = process.env.MESSAGING_CREDENTIALS_KEY;
  if (!raw) throw new MessagingCryptoError("KEY_MISSING");
  let key: Buffer;
  try {
    key = Buffer.from(raw, "base64");
  } catch {
    throw new MessagingCryptoError("KEY_INVALID");
  }
  if (key.length !== 32) throw new MessagingCryptoError("KEY_INVALID");
  return key;
}

/** PostgREST transports bytea as a `\x`-prefixed hex string. */
function toByteaHex(buffer: Buffer): string {
  return `\\x${buffer.toString("hex")}`;
}

function fromByteaHex(stored: string): Buffer {
  const hex = stored.startsWith("\\x") ? stored.slice(2) : stored;
  if (hex.length === 0 || hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) {
    throw new MessagingCryptoError("ENVELOPE_INVALID");
  }
  return Buffer.from(hex, "hex");
}

/** Encrypts a flat credential map for storage in clinic_channels. */
export function encryptChannelCredentials(
  credentials: ChannelCredentials,
): string {
  const key = loadKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(credentials), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return toByteaHex(
    Buffer.concat([Buffer.from([ENVELOPE_VERSION]), iv, tag, ciphertext]),
  );
}

/** Decrypts a stored envelope. Throws MessagingCryptoError; never logs inputs. */
export function decryptChannelCredentials(stored: string): ChannelCredentials {
  const key = loadKey();
  const envelope = fromByteaHex(stored);
  if (
    envelope.length < 1 + IV_LENGTH + TAG_LENGTH + 1 ||
    envelope[0] !== ENVELOPE_VERSION
  ) {
    throw new MessagingCryptoError("ENVELOPE_INVALID");
  }
  const iv = envelope.subarray(1, 1 + IV_LENGTH);
  const tag = envelope.subarray(1 + IV_LENGTH, 1 + IV_LENGTH + TAG_LENGTH);
  const ciphertext = envelope.subarray(1 + IV_LENGTH + TAG_LENGTH);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    const parsed: unknown = JSON.parse(plaintext.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new MessagingCryptoError("DECRYPT_FAILED");
    }
    const entries = Object.entries(parsed as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    );
    return Object.fromEntries(entries);
  } catch (error) {
    if (error instanceof MessagingCryptoError) throw error;
    throw new MessagingCryptoError("DECRYPT_FAILED");
  }
}
