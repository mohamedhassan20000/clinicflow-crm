import "server-only";

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

const ENVELOPE_FORMAT_VERSION = 1;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const HEADER_LENGTH = 3;

export type AiCredentialProvider = "anthropic";

export type AiCredentialContext = {
  clinicId: string;
  provider: AiCredentialProvider;
  credentialId: string;
};

export class AiCredentialCryptoError extends Error {
  constructor(
    public readonly code:
      | "KEY_VERSION_INVALID"
      | "KEY_MISSING"
      | "KEY_INVALID"
      | "ENVELOPE_INVALID"
      | "DECRYPT_FAILED",
  ) {
    super(`AI credential encryption failed: ${code}`);
    this.name = "AiCredentialCryptoError";
  }
}

function parseKeyVersion(raw: string | undefined): number {
  const version = Number(raw);
  if (!Number.isInteger(version) || version < 1 || version > 65_535) {
    throw new AiCredentialCryptoError("KEY_VERSION_INVALID");
  }
  return version;
}

export function activeAiCredentialKeyVersion(): number {
  return parseKeyVersion(process.env.AI_CREDENTIALS_ACTIVE_KEY_VERSION);
}

function loadKey(version: number): Buffer {
  const raw = process.env[`AI_CREDENTIALS_KEY_V${version}`];
  if (!raw) throw new AiCredentialCryptoError("KEY_MISSING");
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new AiCredentialCryptoError("KEY_INVALID");
  return key;
}

function authenticatedContext(context: AiCredentialContext): Buffer {
  return Buffer.from(
    [
      "clinicflow-ai-credential",
      `format:${ENVELOPE_FORMAT_VERSION}`,
      `clinic:${context.clinicId}`,
      `provider:${context.provider}`,
      `credential:${context.credentialId}`,
    ].join("\u0000"),
    "utf8",
  );
}

function toByteaHex(value: Buffer): string {
  return `\\x${value.toString("hex")}`;
}

function fromByteaHex(stored: string): Buffer {
  const hex = stored.startsWith("\\x") ? stored.slice(2) : stored;
  if (!hex || hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) {
    throw new AiCredentialCryptoError("ENVELOPE_INVALID");
  }
  return Buffer.from(hex, "hex");
}

export function aiCredentialFingerprint(secret: string): string {
  const digest = createHash("sha256").update(secret, "utf8").digest("hex");
  return `sha256:${digest.slice(0, 8)}…${digest.slice(-4)}`;
}

export function encryptAiCredential(
  context: AiCredentialContext,
  secret: string,
): { encrypted: string; keyVersion: number; maskedFingerprint: string } {
  const keyVersion = activeAiCredentialKeyVersion();
  const key = loadKey(keyVersion);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(authenticatedContext(context));
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(secret, "utf8")),
    cipher.final(),
  ]);
  const version = Buffer.alloc(2);
  version.writeUInt16BE(keyVersion);
  const envelope = Buffer.concat([
    Buffer.from([ENVELOPE_FORMAT_VERSION]),
    version,
    iv,
    cipher.getAuthTag(),
    ciphertext,
  ]);
  return {
    encrypted: toByteaHex(envelope),
    keyVersion,
    maskedFingerprint: aiCredentialFingerprint(secret),
  };
}

export function decryptAiCredential(
  context: AiCredentialContext,
  stored: string,
): string {
  const envelope = fromByteaHex(stored);
  if (
    envelope.length < HEADER_LENGTH + IV_LENGTH + TAG_LENGTH + 1 ||
    envelope[0] !== ENVELOPE_FORMAT_VERSION
  ) {
    throw new AiCredentialCryptoError("ENVELOPE_INVALID");
  }
  const keyVersion = envelope.readUInt16BE(1);
  const key = loadKey(keyVersion);
  const ivStart = HEADER_LENGTH;
  const tagStart = ivStart + IV_LENGTH;
  const ciphertextStart = tagStart + TAG_LENGTH;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, envelope.subarray(ivStart, tagStart));
    decipher.setAAD(authenticatedContext(context));
    decipher.setAuthTag(envelope.subarray(tagStart, ciphertextStart));
    return Buffer.concat([
      decipher.update(envelope.subarray(ciphertextStart)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new AiCredentialCryptoError("DECRYPT_FAILED");
  }
}
