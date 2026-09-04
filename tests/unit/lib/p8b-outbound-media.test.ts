import { describe, expect, it } from "vitest";
import {
  outboundMediaKind,
  safeOutboundFilename,
  sniffOutboundMimeType,
} from "@/lib/messaging/outbound-media";
import { isSendableStoragePath } from "@/lib/supabase/admin";

const CLINIC = "11111111-1111-4111-8111-111111111111";

describe("P8B outbound media boundary", () => {
  it("trusts signatures rather than a browser MIME claim", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(sniffOutboundMimeType(png, "application/pdf")).toBe("image/png");
    expect(outboundMediaKind("image/png", false)).toBe("image");
  });

  it("accepts Chrome and Safari recording containers only as voice audio", () => {
    const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
    const mp4 = Buffer.from([0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70]);
    expect(sniffOutboundMimeType(webm, "audio/webm;codecs=opus")).toBe("audio/webm");
    expect(sniffOutboundMimeType(mp4, "audio/mp4")).toBe("audio/mp4");
    expect(outboundMediaKind("audio/webm", true)).toBe("audio");
    expect(outboundMediaKind("audio/webm", false)).toBeNull();
  });

  it("sanitizes names and rejects tenant escapes for every sendable bucket", () => {
    expect(safeOutboundFilename("../\u202ereport.pdf")).toBe(".._report.pdf");
    expect(isSendableStoragePath("whatsapp-outbound", `${CLINIC}/thread/file.pdf`, CLINIC)).toBe(true);
    expect(isSendableStoragePath("patient-assets", `documents/${CLINIC}/patient/file.pdf`, CLINIC)).toBe(true);
    expect(isSendableStoragePath("clinic-documents", `documents/${CLINIC}/issued/file.pdf`, CLINIC)).toBe(true);
    expect(isSendableStoragePath("whatsapp-outbound", `${CLINIC}/../other/file.pdf`, CLINIC)).toBe(false);
    expect(isSendableStoragePath("clinic-documents", `documents/other-clinic/file.pdf`, CLINIC)).toBe(false);
  });
});
