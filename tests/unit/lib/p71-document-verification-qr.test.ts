import { describe, expect, it } from "vitest";
import {
  buildDocumentVerificationUrl,
  generateDocumentVerificationQrDataUrl,
} from "@/lib/documents/verification-qr";

describe("P7-1 document verification QR", () => {
  it("binds opaque tokens to the canonical production verification origin", () => {
    expect(buildDocumentVerificationUrl("0123456789abcdef0123456789abcdef")).toBe(
      "https://clinicflow.fit/verify/0123456789abcdef0123456789abcdef",
    );
  });

  it.each(["short", "../../admin", "token with spaces", "https://evil.test/token"])(
    "rejects unsafe token %s",
    (token) => expect(() => buildDocumentVerificationUrl(token)).toThrow("opaque"),
  );

  it("generates a self-contained scannable PNG data URI", async () => {
    const result = await generateDocumentVerificationQrDataUrl(
      "P71VerificationToken_00000001",
    );
    expect(result).toMatch(/^data:image\/png;base64,/);
    expect(Buffer.from(result.split(",")[1], "base64").byteLength).toBeGreaterThan(500);
  });
});
