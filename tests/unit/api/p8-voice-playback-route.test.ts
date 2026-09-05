import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: vi.fn(),
  createClient: vi.fn(),
  maybeSingle: vi.fn(),
  download: vi.fn(),
  diagnostic: vi.fn(),
}));

vi.mock("@/lib/rbac", () => ({ getAuthedUser: mocks.user }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/supabase/admin", () => ({
  downloadWhatsAppAttachment: mocks.download,
}));
vi.mock("@/lib/messaging/inbound-media-diagnostics", () => ({
  logVoicePlaybackLoadDiagnostic: mocks.diagnostic,
}));

import {
  GET,
  HEAD,
  parseSingleByteRange,
} from "@/app/api/inbox/voice/[attachmentId]/route";

const ATTACHMENT_ID = "00000000-0000-4000-8000-000000000001";
const CLINIC_ID = "00000000-0000-4000-8000-000000000002";
const AUDIO = Buffer.from([
  0x4f, 0x67, 0x67, 0x53, 0x00, 0x02, 0x00, 0x00,
  0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64,
]);

function queryClient() {
  const chain = {
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle: mocks.maybeSingle,
  };
  chain.select.mockReturnValue(chain);
  chain.eq.mockReturnValue(chain);
  return { from: vi.fn(() => chain) };
}

function context() {
  return { params: Promise.resolve({ attachmentId: ATTACHMENT_ID }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.user.mockResolvedValue({
    id: "user-1",
    clinicId: CLINIC_ID,
    role: "receptionist",
  });
  mocks.createClient.mockResolvedValue(queryClient());
  mocks.maybeSingle.mockResolvedValue({
    data: {
      storage_path: `${CLINIC_ID}/2026-08/voice.ogg`,
      byte_size: AUDIO.length,
      mime_type: "audio/ogg; codecs=opus",
      sha256: createHash("sha256").update(AUDIO).digest("hex"),
    },
    error: null,
  });
  mocks.download.mockResolvedValue({
    data: new Blob([AUDIO], { type: "audio/ogg" }),
    error: null,
  });
});

describe("P8 inbound voice playback route", () => {
  it("parses the single byte ranges browsers use for media", () => {
    expect(parseSingleByteRange("bytes=0-3", 16)).toEqual({ start: 0, end: 3 });
    expect(parseSingleByteRange("bytes=8-", 16)).toEqual({ start: 8, end: 15 });
    expect(parseSingleByteRange("bytes=-4", 16)).toEqual({ start: 12, end: 15 });
    expect(parseSingleByteRange("bytes=16-20", 16)).toBeNull();
    expect(parseSingleByteRange("bytes=0-1,4-5", 16)).toBeNull();
  });

  it("serves verified stored audio with browser media headers", async () => {
    const response = await GET(
      new Request(`https://clinicflow.test/api/inbox/voice/${ATTACHMENT_ID}`),
      context(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/ogg");
    expect(response.headers.get("content-length")).toBe(String(AUDIO.length));
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(AUDIO);
    expect(mocks.download).toHaveBeenCalledWith({
      clinicId: CLINIC_ID,
      storagePath: `${CLINIC_ID}/2026-08/voice.ogg`,
    });
    expect(mocks.diagnostic).toHaveBeenCalledWith(expect.objectContaining({
      stage: "response_ready",
      httpStatus: 200,
      mimeType: "audio/ogg",
      objectByteCount: AUDIO.length,
      responseByteCount: AUDIO.length,
      rangeRequested: false,
    }));
  });

  it("returns a correct 206 response without exposing the object URL", async () => {
    const response = await GET(
      new Request(`https://clinicflow.test/api/inbox/voice/${ATTACHMENT_ID}`, {
        headers: { range: "bytes=4-7" },
      }),
      context(),
    );

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(`bytes 4-7/${AUDIO.length}`);
    expect(response.headers.get("content-length")).toBe("4");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(AUDIO.subarray(4, 8));
  });

  it("supports metadata probes without returning audio bytes", async () => {
    const response = await HEAD(
      new Request(`https://clinicflow.test/api/inbox/voice/${ATTACHMENT_ID}`, {
        method: "HEAD",
      }),
      context(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe(String(AUDIO.length));
    expect((await response.arrayBuffer()).byteLength).toBe(0);
  });

  it("refuses unauthenticated access before metadata or storage reads", async () => {
    mocks.user.mockResolvedValueOnce(null);
    const response = await GET(
      new Request(`https://clinicflow.test/api/inbox/voice/${ATTACHMENT_ID}`),
      context(),
    );

    expect(response.status).toBe(401);
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it("fails closed when stored length or integrity no longer matches metadata", async () => {
    mocks.maybeSingle.mockResolvedValueOnce({
      data: {
        storage_path: `${CLINIC_ID}/2026-08/voice.ogg`,
        byte_size: AUDIO.length + 1,
        mime_type: "audio/ogg",
        sha256: createHash("sha256").update(AUDIO).digest("hex"),
      },
      error: null,
    });
    const response = await GET(
      new Request(`https://clinicflow.test/api/inbox/voice/${ATTACHMENT_ID}`),
      context(),
    );

    expect(response.status).toBe(502);
    expect(mocks.diagnostic).toHaveBeenCalledWith(expect.objectContaining({
      errorCategory: "byte_count_mismatch",
      objectByteCount: AUDIO.length + 1,
      responseByteCount: AUDIO.length,
    }));
  });
});
