import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decryptChannelCredentials,
  encryptChannelCredentials,
  MessagingCryptoError,
} from "@/lib/messaging/crypto";

const KEY = randomBytes(32).toString("base64");
const OTHER_KEY = randomBytes(32).toString("base64");

beforeEach(() => {
  process.env.MESSAGING_CREDENTIALS_KEY = KEY;
});

afterEach(() => {
  delete process.env.MESSAGING_CREDENTIALS_KEY;
});

describe("messaging credential encryption", () => {
  it("round-trips a credential map through a bytea hex envelope", () => {
    const credentials = { appSid: "app-sid-123456", webhookSecret: "whsec_abc" };
    const stored = encryptChannelCredentials(credentials);
    expect(stored.startsWith("\\x")).toBe(true);
    expect(stored).not.toContain("app-sid-123456");
    expect(decryptChannelCredentials(stored)).toEqual(credentials);
  });

  it("produces a fresh envelope per encryption (random IV)", () => {
    const credentials = { appSid: "same" };
    expect(encryptChannelCredentials(credentials)).not.toEqual(
      encryptChannelCredentials(credentials),
    );
  });

  it("fails closed when the key is missing", () => {
    delete process.env.MESSAGING_CREDENTIALS_KEY;
    expect(() => encryptChannelCredentials({ a: "b" })).toThrowError(
      MessagingCryptoError,
    );
    try {
      encryptChannelCredentials({ a: "b" });
    } catch (error) {
      expect((error as MessagingCryptoError).code).toBe("KEY_MISSING");
    }
  });

  it("rejects keys that are not 32 bytes", () => {
    process.env.MESSAGING_CREDENTIALS_KEY = randomBytes(16).toString("base64");
    expect(() => encryptChannelCredentials({ a: "b" })).toThrowError(
      MessagingCryptoError,
    );
  });

  it("rejects decryption with the wrong key", () => {
    const stored = encryptChannelCredentials({ appSid: "secret" });
    process.env.MESSAGING_CREDENTIALS_KEY = OTHER_KEY;
    expect(() => decryptChannelCredentials(stored)).toThrowError(
      MessagingCryptoError,
    );
  });

  it("rejects tampered ciphertext (auth tag failure)", () => {
    const stored = encryptChannelCredentials({ appSid: "secret" });
    const hex = stored.slice(2);
    const flipped = `${hex.slice(0, -2)}${hex.slice(-2) === "00" ? "01" : "00"}`;
    expect(() => decryptChannelCredentials(`\\x${flipped}`)).toThrowError(
      MessagingCryptoError,
    );
  });

  it("rejects malformed envelopes", () => {
    expect(() => decryptChannelCredentials("\\xzz")).toThrowError(
      MessagingCryptoError,
    );
    expect(() => decryptChannelCredentials("\\x00")).toThrowError(
      MessagingCryptoError,
    );
    expect(() => decryptChannelCredentials("")).toThrowError(
      MessagingCryptoError,
    );
  });

  it("drops non-string values instead of returning them as credentials", () => {
    const stored = encryptChannelCredentials({ good: "value" });
    expect(decryptChannelCredentials(stored)).toEqual({ good: "value" });
  });
});
