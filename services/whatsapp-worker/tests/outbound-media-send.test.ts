import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { describe, it } from "node:test";
import {
  validateVoiceInspection,
  VOICE_ANALYZE_ARGS,
  VOICE_FFMPEG_ARGS,
  VOICE_FFPROBE_ARGS,
} from "../src/outbound-media.ts";
import { CLINIC_A, connectedSession } from "./harness.ts";

const RECIPIENT = "+20100000000";
const hasMediaTools =
  spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0 &&
  spawnSync("ffprobe", ["-version"], { stdio: "ignore" }).status === 0;

function audibleBrowserRecording(): Buffer {
  const generated = spawnSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-f", "lavfi",
    "-i", "sine=frequency=523:duration=1.1", "-c:a", "libopus",
    "-f", "webm", "pipe:1",
  ], { encoding: null, maxBuffer: 2 * 1024 * 1024 });
  assert.equal(generated.status, 0, generated.stderr?.toString("utf8"));
  return generated.stdout;
}

describe("typed outbound media", () => {
  it("downloads and sends an image from the clinic-scoped private bucket", async () => {
    const harness = await connectedSession();
    try {
      const path = `${CLINIC_A}/conversation/media.png`;
      const bytes = Buffer.from("real-image-bytes");
      harness.store.outboundMedia.set(`whatsapp-outbound:${path}`, bytes);

      const outcome = await harness.sessions.send(CLINIC_A, RECIPIENT, {
        body: "A caption",
        media: {
          kind: "image",
          mimeType: "image/png",
          bucket: "whatsapp-outbound",
          storagePath: path,
          fileName: "media.png",
          voiceNote: false,
        },
      });

      assert.equal(outcome.ok, true);
      assert.deepEqual(harness.socket.sends[0]?.content, {
        image: bytes,
        mimetype: "image/png",
        caption: "A caption",
      });
    } finally {
      harness.restore();
    }
  });

  it("sends an authorized existing ClinicFlow document without copying it", async () => {
    const harness = await connectedSession();
    try {
      const path = `documents/${CLINIC_A}/issued/report.pdf`;
      const bytes = Buffer.from("issued-pdf");
      harness.store.outboundMedia.set(`clinic-documents:${path}`, bytes);

      const outcome = await harness.sessions.send(CLINIC_A, RECIPIENT, {
        body: "",
        media: {
          kind: "document",
          mimeType: "application/pdf",
          bucket: "clinic-documents",
          storagePath: path,
          fileName: "report.pdf",
          voiceNote: false,
        },
      });

      assert.equal(outcome.ok, true);
      assert.deepEqual(harness.socket.sends[0]?.content, {
        document: bytes,
        mimetype: "application/pdf",
        fileName: "report.pdf",
      });
    } finally {
      harness.restore();
    }
  });

  it("normalizes browser audio to OGG/Opus and marks it as a WhatsApp voice note", async () => {
    const input = Buffer.from("webm-opus");
    const output = Buffer.from("ogg-opus");
    const transcoded: Buffer[] = [];
    const harness = await connectedSession({
      transcodeVoice: async (bytes) => {
        transcoded.push(bytes);
        return output;
      },
    });
    try {
      const path = `${CLINIC_A}/conversation/voice.webm`;
      harness.store.outboundMedia.set(`whatsapp-outbound:${path}`, input);

      const outcome = await harness.sessions.send(CLINIC_A, RECIPIENT, {
        body: "",
        media: {
          kind: "audio",
          mimeType: "audio/webm",
          bucket: "whatsapp-outbound",
          storagePath: path,
          fileName: "voice-note.webm",
          voiceNote: true,
        },
      });

      assert.equal(outcome.ok, true);
      assert.deepEqual(transcoded, [input]);
      assert.deepEqual(harness.socket.sends[0]?.content, {
        audio: output,
        mimetype: "audio/ogg; codecs=opus",
        ptt: true,
      });
    } finally {
      harness.restore();
    }
  });

  it("carries audible browser bytes through storage, real ffmpeg, and the Baileys PTT payload", { skip: !hasMediaTools }, async () => {
    const harness = await connectedSession();
    try {
      const path = `${CLINIC_A}/conversation/real-voice.webm`;
      harness.store.outboundMedia.set(`whatsapp-outbound:${path}`, audibleBrowserRecording());

      const outcome = await harness.sessions.send(CLINIC_A, RECIPIENT, {
        body: "",
        media: {
          kind: "audio",
          mimeType: "audio/webm",
          bucket: "whatsapp-outbound",
          storagePath: path,
          fileName: "voice-note.webm",
          voiceNote: true,
        },
      });

      assert.equal(outcome.ok, true);
      const content = harness.socket.sends[0]?.content as {
        audio?: Buffer;
        mimetype?: string;
        ptt?: boolean;
      };
      assert.equal(content.mimetype, "audio/ogg; codecs=opus");
      assert.equal(content.ptt, true);
      assert.equal(content.audio?.subarray(0, 4).toString("ascii"), "OggS");
    } finally {
      harness.restore();
    }
  });

  it("refuses a cross-tenant storage reference before WhatsApp sees it", async () => {
    const harness = await connectedSession();
    try {
      const hostilePath = "22222222-2222-4222-8222-222222222222/stolen.pdf";
      harness.store.outboundMedia.set(`whatsapp-outbound:${hostilePath}`, Buffer.from("secret"));

      const outcome = await harness.sessions.send(CLINIC_A, RECIPIENT, {
        body: "",
        media: {
          kind: "document",
          mimeType: "application/pdf",
          bucket: "whatsapp-outbound",
          storagePath: hostilePath,
          fileName: "stolen.pdf",
          voiceNote: false,
        },
      });

      assert.deepEqual(outcome, { ok: false, code: "MEDIA_STORAGE_FETCH_FAILED" });
      assert.equal(harness.socket.sends.length, 0);
    } finally {
      harness.restore();
    }
  });

  it("keeps storage, transcode, and Baileys failures stage-specific", async () => {
    const storageHarness = await connectedSession();
    try {
      const missing = await storageHarness.sessions.send(CLINIC_A, RECIPIENT, {
        body: "",
        media: {
          kind: "image",
          mimeType: "image/png",
          bucket: "whatsapp-outbound",
          storagePath: `${CLINIC_A}/missing.png`,
          fileName: "missing.png",
          voiceNote: false,
        },
      });
      assert.deepEqual(missing, { ok: false, code: "MEDIA_STORAGE_FETCH_FAILED" });
    } finally {
      storageHarness.restore();
    }

    const transcodeHarness = await connectedSession({
      transcodeVoice: async () => {
        throw new Error("VOICE_TRANSCODE_UNAVAILABLE");
      },
    });
    try {
      const path = `${CLINIC_A}/voice.webm`;
      transcodeHarness.store.outboundMedia.set(`whatsapp-outbound:${path}`, Buffer.from("webm"));
      const failed = await transcodeHarness.sessions.send(CLINIC_A, RECIPIENT, {
        body: "",
        media: {
          kind: "audio",
          mimeType: "audio/webm",
          bucket: "whatsapp-outbound",
          storagePath: path,
          fileName: "voice-note.webm",
          voiceNote: true,
        },
      });
      assert.deepEqual(failed, { ok: false, code: "MEDIA_TRANSCODE_FAILED" });
      assert.equal(transcodeHarness.socket.sends.length, 0);
    } finally {
      transcodeHarness.restore();
    }

    const baileysHarness = await connectedSession();
    try {
      const path = `${CLINIC_A}/report.pdf`;
      baileysHarness.store.outboundMedia.set(`whatsapp-outbound:${path}`, Buffer.from("pdf"));
      baileysHarness.socket.sendError = new Error("transport refused");
      const failed = await baileysHarness.sessions.send(CLINIC_A, RECIPIENT, {
        body: "caption",
        media: {
          kind: "document",
          mimeType: "application/pdf",
          bucket: "whatsapp-outbound",
          storagePath: path,
          fileName: "report.pdf",
          voiceNote: false,
        },
      });
      assert.deepEqual(failed, { ok: false, code: "MEDIA_BAILEYS_SEND_FAILED" });
    } finally {
      baileysHarness.restore();
    }
  });
});

describe("voice-note runtime", () => {
  it("uses a fixed pipe-only OGG/Opus ffmpeg command", () => {
    assert.deepEqual(VOICE_FFMPEG_ARGS, [
      "-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-vn",
      "-c:a", "libopus", "-b:a", "32k", "-vbr", "on",
      "-application", "voip", "-ar", "48000", "-ac", "1",
      "-f", "ogg", "pipe:1",
    ]);
    assert.deepEqual(VOICE_FFPROBE_ARGS, [
      "-v", "error", "-select_streams", "a:0",
      "-show_entries", "stream=codec_name,codec_type,sample_rate,channels",
      "-of", "json", "pipe:0",
    ]);
    assert.deepEqual(VOICE_ANALYZE_ARGS, [
      "-hide_banner", "-nostats", "-i", "pipe:0", "-map", "0:a:0",
      "-af", "astats=metadata=0:reset=0", "-f", "null", "-",
    ]);
  });

  it("requires a nonempty 48 kHz mono Opus stream with audible samples", () => {
    const probe = JSON.stringify({
      streams: [{ codec_name: "opus", codec_type: "audio", sample_rate: "48000", channels: 1 }],
    });
    assert.doesNotThrow(() =>
      validateVoiceInspection(probe, "Peak level dB: -24.5\nNumber of samples: 48000"),
    );
    assert.throws(
      () => validateVoiceInspection(probe, "Peak level dB: -24.5\nNumber of samples: 0"),
      /VOICE_INVALID_DURATION/,
    );
    assert.throws(
      () => validateVoiceInspection(probe, "Peak level dB: -90.3\nNumber of samples: 48000"),
      /VOICE_SILENT_AUDIO/,
    );
    assert.throws(
      () =>
        validateVoiceInspection(
          JSON.stringify({ streams: [{ codec_name: "aac", codec_type: "audio", sample_rate: "48000", channels: 1 }] }),
          "Peak level dB: -24.5\nNumber of samples: 48000",
        ),
      /VOICE_INVALID_STREAM/,
    );
  });

  it("installs ffmpeg before the container drops to the unprivileged user", () => {
    const dockerfile = fs.readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
    const installAt = dockerfile.indexOf("apt-get install -y --no-install-recommends ffmpeg");
    const userAt = dockerfile.indexOf("USER node");
    assert.ok(installAt >= 0);
    assert.ok(userAt > installAt);
    assert.match(dockerfile, /rm -rf \/var\/lib\/apt\/lists\/\*/);
  });
});
