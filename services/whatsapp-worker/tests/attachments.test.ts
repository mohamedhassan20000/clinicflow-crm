import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ingestAttachment,
  mediaKindFor,
  safeFilename,
  sniffMimeType,
  type InboundMediaDiagnostic,
} from "../src/media.ts";
import { CLINIC_A, connectedSession, postedEvents } from "./harness.ts";

/**
 * P8 §7 — patient attachments.
 *
 * The single idea this suite exists to defend: **the sender describes nothing.**
 * Every fact about a file — what it is, what it is called, where it is stored —
 * is decided from the bytes and from values this worker controls. The second
 * idea is that a file we will not take is still news: the message survives, and
 * staff are told there was something ClinicFlow could not open.
 */

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32, 2),
]);
const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(64, 3)]);
const OGG_OPUS = Buffer.concat([Buffer.from("OggS"), Buffer.alloc(64, 6)]);
const MP3 = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(64, 7)]);
const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64, 4)]);
const ELF = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(64, 5)]);
// ISO-BMFF: four size bytes, "ftyp", then the brand. P11P stores video, and a
// container this permissive is exactly why the sender's claim must agree.
const MP4 = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from("ftypisom"),
  Buffer.alloc(64, 8),
]);

describe("sniffing what a file actually is", () => {
  it("recognises the image and document types ClinicFlow stores", () => {
    assert.equal(sniffMimeType(JPEG, null), "image/jpeg");
    assert.equal(sniffMimeType(PNG, null), "image/png");
    assert.equal(sniffMimeType(PDF, null), "application/pdf");
    assert.equal(sniffMimeType(OGG_OPUS, "audio/ogg; codecs=opus"), "audio/ogg");
    assert.equal(sniffMimeType(MP3, "audio/mpeg"), "audio/mpeg");
    assert.equal(sniffMimeType(Buffer.from("just some notes"), "text/plain"), "text/plain");
  });

  it("believes the bytes over the sender's claim", () => {
    // A Linux executable announced as a JPEG is not a JPEG.
    assert.equal(sniffMimeType(ELF, "image/jpeg"), null);
    // A PDF announced as a PNG is still a PDF, and is stored as one.
    assert.equal(sniffMimeType(PDF, "image/png"), "application/pdf");
  });

  it("only honours an Office claim when the container agrees with it", () => {
    assert.equal(
      sniffMimeType(ZIP, "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    // A bare zip claiming to be an image, or claiming nothing, is refused: the
    // signature alone cannot tell a .docx from any other archive.
    assert.equal(sniffMimeType(ZIP, "image/png"), null);
    assert.equal(sniffMimeType(ZIP, null), null);
  });

  it("refuses binary announced as plain text", () => {
    assert.equal(sniffMimeType(ELF, "text/plain"), null);
  });

  it("maps types onto the kinds the inbox renders", () => {
    assert.equal(mediaKindFor("image/png"), "image");
    assert.equal(mediaKindFor("application/pdf"), "document");
    assert.equal(mediaKindFor("audio/ogg; codecs=opus"), "audio");
    // P11P: video is stored now, so it maps to its own kind rather than to the
    // catch-all the inbox renders as "cannot be opened here".
    assert.equal(mediaKindFor("video/mp4"), "video");
    assert.equal(mediaKindFor("video/quicktime"), "video");
    assert.equal(mediaKindFor("video/x-matroska"), "unsupported");
  });
});

describe("filenames from the sender", () => {
  it("flattens path separators rather than following them", () => {
    assert.equal(safeFilename("../../etc/passwd"), ".._.._etc_passwd");
    assert.equal(safeFilename("C:\\Windows\\system32"), "C:_Windows_system32");
  });

  it("strips control and direction characters that disguise an extension", () => {
    assert.equal(safeFilename("report\u202Egpj.exe"), "reportgpj.exe");
  });

  it("refuses a name that is nothing", () => {
    assert.equal(safeFilename(""), null);
    assert.equal(safeFilename(".."), null);
    assert.equal(safeFilename(42), null);
  });
});

function message(mediaType: string, node: Record<string, unknown>) {
  return {
    clinicId: CLINIC_A,
    message: { key: { id: "M-1", remoteJid: "201111111111@s.whatsapp.net" } } as never,
    content: { [mediaType]: node } as Record<string, unknown>,
    mediaType: mediaType as never,
    maxBytes: 1024 * 1024,
  };
}

describe("ingesting one attachment", () => {
  it("stores an image under a path built from the clinic and a fresh id", async () => {
    const uploads: Array<{ path: string; contentType: string }> = [];
    const result = await ingestAttachment({
      ...message("imageMessage", { mimetype: "image/jpeg", fileName: "../x-ray.jpg" }),
      upload: async (input) => {
        uploads.push({ path: input.path, contentType: input.contentType });
        return true;
      },
      download: async () => JPEG,
    });

    assert.equal(result.status, "stored");
    assert.equal(result.mediaKind, "image");
    assert.equal(result.mimeType, "image/jpeg");
    assert.equal(result.byteSize, JPEG.length);
    assert.match(result.sha256 ?? "", /^[0-9a-f]{64}$/);
    // The sender's name is kept as a label only — flattened, and nowhere near
    // the path.
    assert.equal(result.originalFilename, ".._x-ray.jpg");
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0]?.contentType, "image/jpeg");
    assert.match(
      uploads[0]?.path ?? "",
      new RegExp(`^${CLINIC_A}/\\d{4}-\\d{2}/[0-9a-f-]{36}\\.jpg$`),
    );
    assert.equal(result.storagePath, uploads[0]?.path);
  });

  it("refuses a file larger than the cap without downloading it", async () => {
    let downloaded = false;
    const result = await ingestAttachment({
      ...message("documentMessage", { mimetype: "application/pdf", fileLength: 50 * 1024 * 1024 }),
      upload: async () => true,
      download: async () => {
        downloaded = true;
        return PDF;
      },
    });
    assert.equal(result.status, "rejected");
    assert.equal(result.failureReason, "too_large");
    assert.equal(downloaded, false);
  });

  it("refuses a file the stanza understated the size of", async () => {
    const result = await ingestAttachment({
      ...message("documentMessage", { mimetype: "application/pdf", fileLength: 10 }),
      maxBytes: 32,
      upload: async () => true,
      download: async () => PDF,
    });
    assert.equal(result.status, "rejected");
    assert.equal(result.failureReason, "too_large");
  });

  it("refuses a type this stack will not store, and says which", async () => {
    const result = await ingestAttachment({
      ...message("documentMessage", { mimetype: "application/pdf" }),
      upload: async () => true,
      download: async () => ELF,
    });
    assert.equal(result.status, "rejected");
    assert.equal(result.mediaKind, "unsupported");
    assert.equal(result.failureReason, "unsupported_type");
    assert.equal(result.storagePath, null);
  });

  it("stores a PTT voice note as audio and preserves its MIME and duration", async () => {
    const uploads: Array<{ path: string; contentType: string }> = [];
    const result = await ingestAttachment({
      ...message("audioMessage", {
        mimetype: "audio/ogg; codecs=opus",
        ptt: true,
        seconds: 9,
      }),
      upload: async (input) => {
        uploads.push({ path: input.path, contentType: input.contentType });
        return true;
      },
      download: async () => OGG_OPUS,
    });
    assert.equal(result.status, "stored");
    assert.equal(result.mediaKind, "audio");
    assert.equal(result.voiceNote, true);
    assert.equal(result.durationSeconds, 9);
    assert.equal(result.mimeType, "audio/ogg; codecs=opus");
    assert.equal(result.originalFilename, null);
    // The attachment row retains the codec, while Storage receives the base
    // media type that its private bucket allow-list evaluates.
    assert.equal(uploads[0]?.contentType, "audio/ogg");
    assert.match(uploads[0]?.path ?? "", /\.ogg$/);
  });

  it("emits the complete safe PTT download/upload stage sequence", async () => {
    const diagnostics: InboundMediaDiagnostic[] = [];
    const result = await ingestAttachment({
      ...message("audioMessage", {
        mimetype: "audio/ogg; codecs=opus",
        ptt: true,
        seconds: 9,
        mediaKey: Buffer.from("must-never-be-logged"),
        directPath: "/must-never-be-logged",
        url: "https://must-never-be-logged.invalid/media",
      }),
      upload: async () => ({ ok: true }),
      download: async () => OGG_OPUS,
      diagnostic: (event) => diagnostics.push(event),
    });

    assert.equal(result.status, "stored");
    assert.deepEqual(
      diagnostics.map((event) => event.stage),
      [
        "inbound_audio_detected",
        "media_download_started",
        "media_download_completed",
        "storage_upload_started",
        "storage_upload_completed",
      ],
    );
    assert.equal(diagnostics.at(-1)?.byteCount, OGG_OPUS.length);
    assert.ok(diagnostics.every((event) => event.clinicId === CLINIC_A));
    assert.ok(diagnostics.every((event) => event.mediaKind === "audio"));
    assert.ok(diagnostics.every((event) => event.voiceNote));
    assert.ok(diagnostics.every((event) => event.mimeFamily === "audio"));
    assert.ok(diagnostics.every((event) => event.durationPresent));
    const serialized = JSON.stringify(diagnostics);
    assert.doesNotMatch(serialized, /must-never-be-logged|remoteJid|mediaKey|directPath|url/i);
  });

  it("stores an ordinary audio file as audio and preserves its filename", async () => {
    const result = await ingestAttachment({
      ...message("audioMessage", {
        mimetype: "audio/mpeg",
        fileName: "patient-note.mp3",
        ptt: false,
        seconds: 15,
      }),
      upload: async () => true,
      download: async () => MP3,
    });
    assert.equal(result.status, "stored");
    assert.equal(result.mediaKind, "audio");
    assert.equal(result.voiceNote, false);
    assert.equal(result.durationSeconds, 15);
    assert.equal(result.originalFilename, "patient-note.mp3");
  });

  /**
   * P11P — video is downloaded and stored like every other kind.
   *
   * It used to be refused before a byte moved, which is why a clinic's video
   * messages all read "open this on the phone". The refusal was policy, not a
   * limitation, and the policy is gone; everything else about the path — the
   * size cap, the byte sniff, the storage failure handling — is unchanged and
   * still applies.
   */
  it("downloads and stores a video, keeping its duration", async () => {
    let downloaded = false;
    const result = await ingestAttachment({
      ...message("videoMessage", { mimetype: "video/mp4", seconds: 12 }),
      upload: async () => true,
      download: async () => {
        downloaded = true;
        return MP4;
      },
    });
    assert.equal(result.mediaKind, "video");
    assert.equal(result.durationSeconds, 12);
    assert.equal(result.status, "stored");
    assert.equal(result.failureReason, null);
    assert.equal(result.mimeType, "video/mp4");
    assert.ok(result.storagePath?.endsWith(".mp4"));
    assert.equal(downloaded, true);
  });

  it("never relabels non-video bytes from a videoMessage as an image", async () => {
    const result = await ingestAttachment({
      ...message("videoMessage", { mimetype: "video/mp4" }),
      upload: async () => true,
      download: async () => JPEG,
    });
    assert.equal(result.status, "rejected");
    assert.equal(result.failureReason, "unsupported_type");
    // Still named a video, so staff read "video unavailable" and not "unknown
    // file" — refusing to store it is not the same as forgetting what it was.
    assert.equal(result.mediaKind, "video");
  });

  it("refuses a video whose declared length is over the cap without downloading", async () => {
    let downloaded = false;
    const result = await ingestAttachment({
      ...message("videoMessage", { mimetype: "video/mp4", fileLength: 999_000_000 }),
      upload: async () => true,
      download: async () => {
        downloaded = true;
        return MP4;
      },
    });
    assert.equal(result.status, "rejected");
    assert.equal(result.failureReason, "too_large");
    assert.equal(downloaded, false);
  });

  it("never relabels non-audio bytes from an audioMessage as an image", async () => {
    const result = await ingestAttachment({
      ...message("audioMessage", { mimetype: "audio/ogg", ptt: true }),
      upload: async () => true,
      download: async () => JPEG,
    });
    assert.equal(result.mediaKind, "unsupported");
    assert.equal(result.status, "rejected");
    assert.equal(result.failureReason, "unsupported_type");
  });

  it("reports a failed download instead of throwing", async () => {
    const result = await ingestAttachment({
      ...message("imageMessage", { mimetype: "image/jpeg" }),
      upload: async () => true,
      download: async () => {
        throw new Error("media url expired for 201111111111@s.whatsapp.net");
      },
    });
    assert.equal(result.status, "failed");
    assert.equal(result.failureReason, "download_failed");
    // The Baileys error text carries the recipient JID; none of it is retained.
    assert.equal(result.storagePath, null);
  });

  it("reports a failed upload instead of claiming the file is readable", async () => {
    const diagnostics: InboundMediaDiagnostic[] = [];
    const result = await ingestAttachment({
      ...message("imageMessage", { mimetype: "image/jpeg" }),
      upload: async () => ({
        ok: false,
        errorCategory: "storage_api",
        errorCode: "mime_type_not_supported",
      }),
      download: async () => JPEG,
      diagnostic: (event) => diagnostics.push(event),
    });
    assert.equal(result.status, "failed");
    assert.equal(result.failureReason, "storage_failed");
    assert.equal(result.storagePath, null);
    assert.deepEqual(diagnostics.at(-1), {
      stage: "storage_upload_failed",
      clinicId: CLINIC_A,
      mediaKind: "image",
      voiceNote: false,
      mimeFamily: "image",
      byteCount: JPEG.length,
      durationPresent: false,
      errorCategory: "storage_api",
      errorCode: "mime_type_not_supported",
    });
  });
});

describe("attachments on a live session", () => {
  function imageMessage(id: string, caption?: string) {
    return {
      key: { remoteJid: "201111111111@s.whatsapp.net", id, fromMe: false },
      messageTimestamp: Math.floor(Date.now() / 1000),
      message: {
        imageMessage: {
          mimetype: "image/jpeg",
          fileName: "rash.jpg",
          ...(caption ? { caption } : {}),
        },
      },
    };
  }

  function inboundMediaMessage(
    id: string,
    type: "audioMessage" | "videoMessage" | "documentMessage",
    node: Record<string, unknown>,
  ) {
    return {
      key: { remoteJid: "201111111111@s.whatsapp.net", id, fromMe: false },
      messageTimestamp: Math.floor(Date.now() / 1000),
      message: { [type]: node },
    };
  }

  it("delivers the attachment on the message it arrived with", async () => {
    const session = await connectedSession({ media: JPEG });
    try {
      await session.upsert({ type: "notify", messages: [imageMessage("IMG-1", "الطفح ده طبيعي؟")] });
      const inbound = postedEvents(session.posted).filter((event) => event.kind === "inbound");
      assert.equal(inbound.length, 1);
      // The caption is the message body; the file rides alongside it.
      assert.equal(inbound[0]?.body, "الطفح ده طبيعي؟");
      const attachments = inbound[0]?.attachments as Array<Record<string, unknown>>;
      assert.equal(attachments.length, 1);
      assert.equal(attachments[0]?.mediaKind, "image");
      assert.equal(session.store.uploads.size, 1);
    } finally {
      session.restore();
    }
  });

  it("keeps the message when storage is unavailable", async () => {
    const session = await connectedSession({ media: JPEG });
    try {
      session.store.uploadFails = true;
      await session.upsert({ type: "notify", messages: [imageMessage("IMG-2", "صورة الأشعة")] });
      const inbound = postedEvents(session.posted).filter((event) => event.kind === "inbound");
      assert.equal(inbound.length, 1);
      assert.equal(inbound[0]?.body, "صورة الأشعة");
      const attachments = inbound[0]?.attachments as Array<Record<string, unknown>>;
      assert.equal(attachments[0]?.status, "failed");
    } finally {
      session.restore();
    }
  });

  it("delivers a playable PTT voice attachment without an image marker", async () => {
    const session = await connectedSession({ media: OGG_OPUS });
    try {
      await session.upsert({
        type: "notify",
        messages: [inboundMediaMessage("VOICE-1", "audioMessage", {
          mimetype: "audio/ogg; codecs=opus",
          ptt: true,
          seconds: 7,
        })],
      });
      const [event] = postedEvents(session.posted).filter((item) => item.kind === "inbound");
      assert.equal(event?.body, "[voice message]");
      assert.notEqual(event?.body, "[image]");
      const [attachment] = event?.attachments as Array<Record<string, unknown>>;
      assert.equal(attachment?.mediaKind, "audio");
      assert.equal(attachment?.voiceNote, true);
      assert.equal(attachment?.durationSeconds, 7);
      assert.equal(attachment?.status, "stored");
      assert.equal(session.store.uploads.size, 1);
    } finally {
      session.restore();
    }
  });

  it("delivers an ordinary audio file with its filename", async () => {
    const session = await connectedSession({ media: MP3 });
    try {
      await session.upsert({
        type: "notify",
        messages: [inboundMediaMessage("AUDIO-1", "audioMessage", {
          mimetype: "audio/mpeg",
          fileName: "consultation.mp3",
          ptt: false,
          seconds: 18,
        })],
      });
      const [event] = postedEvents(session.posted).filter((item) => item.kind === "inbound");
      assert.equal(event?.body, "[audio]");
      const [attachment] = event?.attachments as Array<Record<string, unknown>>;
      assert.equal(attachment?.mediaKind, "audio");
      assert.equal(attachment?.voiceNote, false);
      assert.equal(attachment?.originalFilename, "consultation.mp3");
      assert.equal(attachment?.status, "stored");
    } finally {
      session.restore();
    }
  });

  it("keeps video classified as video when it degrades to unavailable", async () => {
    const session = await connectedSession({ media: JPEG });
    try {
      await session.upsert({
        type: "notify",
        messages: [inboundMediaMessage("VIDEO-1", "videoMessage", {
          mimetype: "video/mp4",
          seconds: 5,
        })],
      });
      const [event] = postedEvents(session.posted).filter((item) => item.kind === "inbound");
      assert.equal(event?.body, "[video]");
      const [attachment] = event?.attachments as Array<Record<string, unknown>>;
      assert.equal(attachment?.mediaKind, "video");
      assert.equal(attachment?.status, "rejected");
      assert.equal(session.store.uploads.size, 0);
    } finally {
      session.restore();
    }
  });

  it("delivers an inbound document as a document", async () => {
    const session = await connectedSession({ media: PDF });
    try {
      await session.upsert({
        type: "notify",
        messages: [inboundMediaMessage("DOC-1", "documentMessage", {
          mimetype: "application/pdf",
          fileName: "report.pdf",
        })],
      });
      const [event] = postedEvents(session.posted).filter((item) => item.kind === "inbound");
      assert.equal(event?.body, "[document]");
      const [attachment] = event?.attachments as Array<Record<string, unknown>>;
      assert.equal(attachment?.mediaKind, "document");
      assert.equal(attachment?.status, "stored");
    } finally {
      session.restore();
    }
  });

  it("does not fetch media on a message the clinic sent from its own phone", async () => {
    const session = await connectedSession({ media: JPEG });
    try {
      await session.upsert({
        type: "notify",
        messages: [{ ...imageMessage("IMG-3"), key: { ...imageMessage("IMG-3").key, fromMe: true } }],
      });
      const echoes = postedEvents(session.posted).filter((event) => event.kind === "outbound_echo");
      assert.equal(echoes.length, 1);
      assert.equal(echoes[0]?.attachments, undefined);
      assert.equal(session.store.uploads.size, 0);
    } finally {
      session.restore();
    }
  });
});
