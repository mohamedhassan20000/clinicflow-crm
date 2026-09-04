import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { transcodeVoiceToOggOpus } from "../src/outbound-media.ts";

const hasMediaTools =
  spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0 &&
  spawnSync("ffprobe", ["-version"], { stdio: "ignore" }).status === 0;

const browserRecording = (source: string) => {
  const generated = spawnSync(
    "ffmpeg",
    [
      "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", source,
      "-c:a", "libopus", "-f", "webm", "pipe:1",
    ],
    { encoding: null, maxBuffer: 2 * 1024 * 1024 },
  );
  assert.equal(generated.status, 0, generated.stderr?.toString("utf8"));
  return generated.stdout;
};

describe("voice-note media toolchain", () => {
  it("turns a browser WebM/Opus recording into validated audible OGG/Opus", { skip: !hasMediaTools }, async () => {
    const output = await transcodeVoiceToOggOpus(browserRecording("sine=frequency=440:duration=1.25"));
    assert.ok(output.length > 0);

    const probe = spawnSync(
      "ffprobe",
      [
        "-v", "error", "-select_streams", "a:0",
        "-show_entries", "stream=codec_name,sample_rate,channels",
        "-of", "json", "pipe:0",
      ],
      { input: output, encoding: "utf8", maxBuffer: 512 * 1024 },
    );
    assert.equal(probe.status, 0, probe.stderr);
    const metadata = JSON.parse(probe.stdout) as {
      streams: Array<{ codec_name: string; sample_rate: string; channels: number }>;
    };
    assert.equal(metadata.streams[0]?.codec_name, "opus");
    assert.equal(metadata.streams[0]?.sample_rate, "48000");
    assert.equal(metadata.streams[0]?.channels, 1);

    // OGG written to a non-seekable pipe has no container duration. Count the
    // decoded samples instead, which is what the production validator uses.
    const analysis = spawnSync(
      "ffmpeg",
      [
        "-hide_banner", "-nostats", "-i", "pipe:0", "-map", "0:a:0",
        "-af", "astats=metadata=0:reset=0", "-f", "null", "-",
      ],
      { input: output, encoding: "utf8", maxBuffer: 512 * 1024 },
    );
    assert.equal(analysis.status, 0, analysis.stderr);
    const samples = [...analysis.stderr.matchAll(/Number of samples:\s*(\d+)/g)].at(-1)?.[1];
    assert.ok(Number(samples) > 0);
  });

  it("rejects a nonempty but silent browser recording", { skip: !hasMediaTools }, async () => {
    const silent = browserRecording("anullsrc=channel_layout=mono:sample_rate=48000:d=1.25");
    await assert.rejects(() => transcodeVoiceToOggOpus(silent), /VOICE_SOURCE_SILENT_AUDIO/);
  });
});
