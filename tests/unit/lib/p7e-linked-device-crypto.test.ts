import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decryptChannelCredentials,
  encryptChannelCredentials,
} from "@/lib/messaging/crypto";
import {
  decryptAuthValue,
  encryptAuthValue,
} from "../../../services/whatsapp-worker/src/crypto";

/**
 * P7E — the pairing worker is a separate deployable and cannot import the
 * application's encryption module, so it carries a byte-for-byte mirror of it.
 * This suite is what keeps the two honest: if either side's envelope drifts, a
 * clinic's stored device identity becomes unreadable and every clinic would be
 * asked to scan again. That must fail here, in CI, not in production.
 */

const KEY = Buffer.alloc(32, 9);

beforeEach(() => {
  process.env.MESSAGING_CREDENTIALS_KEY = KEY.toString("base64");
});

afterEach(() => {
  delete process.env.MESSAGING_CREDENTIALS_KEY;
});

describe("linked-device auth envelope", () => {
  it("round-trips through the worker's own implementation", () => {
    const value = JSON.stringify({ registered: true, noise: "AAAA" });
    expect(decryptAuthValue(encryptAuthValue(value, KEY), KEY)).toBe(value);
  });

  it("produces an envelope the application can decrypt", () => {
    // The worker seals the clinic_channels credential envelope for a paired
    // number, and the application's send path opens it.
    const sealed = encryptAuthValue(
      JSON.stringify({ clinicId: "clinic-1", displayPhoneNumber: "+201000000000" }),
      KEY,
    );
    expect(decryptChannelCredentials(sealed)).toEqual({
      clinicId: "clinic-1",
      displayPhoneNumber: "+201000000000",
    });
  });

  it("reads an envelope the application produced", () => {
    const sealed = encryptChannelCredentials({ clinicId: "clinic-2" });
    expect(JSON.parse(decryptAuthValue(sealed, KEY)) as unknown).toEqual({
      clinicId: "clinic-2",
    });
  });

  it("stores ciphertext, never the plaintext it was given", () => {
    const sealed = encryptAuthValue(JSON.stringify({ secret: "device-identity" }), KEY);
    expect(sealed.startsWith("\\x01")).toBe(true);
    expect(sealed).not.toContain("device-identity");
  });

  it("refuses a value sealed with a different key", () => {
    const sealed = encryptAuthValue("payload", Buffer.alloc(32, 1));
    expect(() => decryptAuthValue(sealed, KEY)).toThrow(/DECRYPT_FAILED/);
  });

  it("refuses a malformed envelope", () => {
    expect(() => decryptAuthValue("\\xzz", KEY)).toThrow(/ENVELOPE_INVALID/);
  });
});
