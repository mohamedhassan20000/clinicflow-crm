import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * At-rest encryption for whatsapp_linked_device_auth.value_encrypted.
 *
 * This is a deliberate, byte-for-byte mirror of lib/messaging/crypto.ts in the
 * application: same AES-256-GCM algorithm, same MESSAGING_CREDENTIALS_KEY, same
 * envelope layout, same PostgREST bytea hex transport. The two are separate
 * deployables and cannot share a module, so a round-trip test in the
 * application's suite (tests/unit/lib/p7e-linked-device-crypto.test.ts) pins
 * them together instead.
 *
 * Envelope layout (bytea): [1-byte version][12-byte IV][16-byte auth tag][ciphertext].
 */

const ENVELOPE_VERSION = 1;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export class LinkedDeviceCryptoError extends Error {
  // Not a constructor parameter property: `node --experimental-strip-types`
  // runs this source directly in development and cannot desugar those.
  readonly code: "ENVELOPE_INVALID" | "DECRYPT_FAILED";

  constructor(code: "ENVELOPE_INVALID" | "DECRYPT_FAILED") {
    super(`Linked-device state encryption failed: ${code}`);
    this.name = "LinkedDeviceCryptoError";
    this.code = code;
  }
}

/** PostgREST transports bytea as a `\x`-prefixed hex string. */
function toByteaHex(buffer: Buffer): string {
  return `\\x${buffer.toString("hex")}`;
}

function fromByteaHex(stored: string): Buffer {
  const hex = stored.startsWith("\\x") ? stored.slice(2) : stored;
  if (hex.length === 0 || hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) {
    throw new LinkedDeviceCryptoError("ENVELOPE_INVALID");
  }
  return Buffer.from(hex, "hex");
}

export function encryptAuthValue(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(plaintext, "utf8")),
    cipher.final(),
  ]);
  return toByteaHex(
    Buffer.concat([Buffer.from([ENVELOPE_VERSION]), iv, cipher.getAuthTag(), ciphertext]),
  );
}

export function decryptAuthValue(stored: string, key: Buffer): string {
  const envelope = fromByteaHex(stored);
  if (
    envelope.length < 1 + IV_LENGTH + TAG_LENGTH + 1 ||
    envelope[0] !== ENVELOPE_VERSION
  ) {
    throw new LinkedDeviceCryptoError("ENVELOPE_INVALID");
  }
  const iv = envelope.subarray(1, 1 + IV_LENGTH);
  const tag = envelope.subarray(1 + IV_LENGTH, 1 + IV_LENGTH + TAG_LENGTH);
  const ciphertext = envelope.subarray(1 + IV_LENGTH + TAG_LENGTH);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new LinkedDeviceCryptoError("DECRYPT_FAILED");
  }
}
