import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AiCredentialCryptoError,
  decryptAiCredential,
  encryptAiCredential,
} from "@/lib/ai/platform/credential-crypto";

const CONTEXT = {
  clinicId: "00000000-0000-4000-8000-000000000001",
  provider: "anthropic" as const,
  credentialId: "00000000-0000-4000-8000-000000000002",
};

beforeEach(() => {
  process.env.AI_CREDENTIALS_ACTIVE_KEY_VERSION = "1";
  process.env.AI_CREDENTIALS_KEY_V1 = randomBytes(32).toString("base64");
  process.env.AI_CREDENTIALS_KEY_V2 = randomBytes(32).toString("base64");
});

afterEach(() => {
  delete process.env.AI_CREDENTIALS_ACTIVE_KEY_VERSION;
  delete process.env.AI_CREDENTIALS_KEY_V1;
  delete process.env.AI_CREDENTIALS_KEY_V2;
});

describe("P4.5B credential envelope", () => {
  it("round-trips with randomized AES-GCM envelopes and safe fingerprints", () => {
    const first = encryptAiCredential(CONTEXT, "sk-ant-api03_example-secret-value");
    const second = encryptAiCredential(CONTEXT, "sk-ant-api03_example-secret-value");

    expect(first.encrypted).not.toBe(second.encrypted);
    expect(first.encrypted).not.toContain("example-secret-value");
    expect(first.maskedFingerprint).toMatch(/^sha256:[0-9a-f]{8}…[0-9a-f]{4}$/);
    expect(decryptAiCredential(CONTEXT, first.encrypted))
      .toBe("sk-ant-api03_example-secret-value");
  });

  it("denies cross-clinic, cross-credential, and tampered ciphertext", () => {
    const encrypted = encryptAiCredential(CONTEXT, "sk-ant-api03_example-secret-value").encrypted;
    const tampered = `${encrypted.slice(0, -2)}${encrypted.endsWith("00") ? "01" : "00"}`;

    expect(() => decryptAiCredential({ ...CONTEXT, clinicId: crypto.randomUUID() }, encrypted))
      .toThrow(expect.objectContaining<Partial<AiCredentialCryptoError>>({ code: "DECRYPT_FAILED" }));
    expect(() => decryptAiCredential({ ...CONTEXT, credentialId: crypto.randomUUID() }, encrypted))
      .toThrow(expect.objectContaining<Partial<AiCredentialCryptoError>>({ code: "DECRYPT_FAILED" }));
    expect(() => decryptAiCredential(CONTEXT, tampered))
      .toThrow(expect.objectContaining<Partial<AiCredentialCryptoError>>({ code: "DECRYPT_FAILED" }));
  });

  it("keeps older key versions decryptable during rotation", () => {
    const versionOne = encryptAiCredential(CONTEXT, "sk-ant-api03_version-one");
    process.env.AI_CREDENTIALS_ACTIVE_KEY_VERSION = "2";
    const versionTwo = encryptAiCredential(CONTEXT, "sk-ant-api03_version-two");

    expect(versionOne.keyVersion).toBe(1);
    expect(versionTwo.keyVersion).toBe(2);
    expect(decryptAiCredential(CONTEXT, versionOne.encrypted)).toBe("sk-ant-api03_version-one");
    expect(decryptAiCredential(CONTEXT, versionTwo.encrypted)).toBe("sk-ant-api03_version-two");
  });

  it("fails closed when the configured key is missing or malformed", () => {
    delete process.env.AI_CREDENTIALS_KEY_V1;
    expect(() => encryptAiCredential(CONTEXT, "sk-ant-api03_value"))
      .toThrow(expect.objectContaining<Partial<AiCredentialCryptoError>>({ code: "KEY_MISSING" }));
    process.env.AI_CREDENTIALS_KEY_V1 = Buffer.from("short").toString("base64");
    expect(() => encryptAiCredential(CONTEXT, "sk-ant-api03_value"))
      .toThrow(expect.objectContaining<Partial<AiCredentialCryptoError>>({ code: "KEY_INVALID" }));
  });
});
