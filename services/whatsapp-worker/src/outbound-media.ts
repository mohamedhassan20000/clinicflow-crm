import { spawn } from "node:child_process";

/**
 * Chrome records WebM/Opus and Safari commonly records MP4/AAC. WhatsApp voice
 * notes need OGG/Opus with ptt=true, so the worker normalizes every recording
 * through ffmpeg instead of making the browser matrix a product limitation.
 */

export const VOICE_FFMPEG_ARGS = [
  "-hide_banner",
  "-loglevel",
  "error",
  "-i",
  "pipe:0",
  "-vn",
  "-c:a",
  "libopus",
  "-b:a",
  "32k",
  "-vbr",
  "on",
  "-application",
  "voip",
  "-ar",
  "48000",
  "-ac",
  "1",
  "-f",
  "ogg",
  "pipe:1",
] as const;

export const VOICE_FFPROBE_ARGS = [
  "-v",
  "error",
  "-select_streams",
  "a:0",
  "-show_entries",
  "stream=codec_name,codec_type,sample_rate,channels",
  "-of",
  "json",
  "pipe:0",
] as const;

export const VOICE_SOURCE_FFPROBE_ARGS = [
  "-v",
  "error",
  "-select_streams",
  "a:0",
  "-show_entries",
  "stream=codec_type,sample_rate,channels",
  "-of",
  "json",
  "pipe:0",
] as const;

export const VOICE_ANALYZE_ARGS = [
  "-hide_banner",
  "-nostats",
  "-i",
  "pipe:0",
  "-map",
  "0:a:0",
  "-af",
  "astats=metadata=0:reset=0",
  "-f",
  "null",
  "-",
] as const;

const TRANSCODE_TIMEOUT_MS = 30_000;
const VALIDATION_TIMEOUT_MS = 10_000;
const MAX_TRANSCODED_BYTES = 20 * 1024 * 1024;
const MAX_DIAGNOSTIC_BYTES = 512 * 1024;
const WHATSAPP_OPUS_SAMPLE_RATE = 48_000;
const WHATSAPP_OPUS_CHANNELS = 1;
const SILENCE_PEAK_THRESHOLD_DBFS = -80;

export type VoiceTranscoder = (bytes: Buffer) => Promise<Buffer>;

type PipeCommandOptions = {
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  unavailableCode: string;
  timeoutCode: string;
  tooLargeCode: string;
  failedCode: string;
};

const runPipeCommand = (
  command: string,
  args: readonly string[],
  input: Buffer,
  options: PipeCommandOptions,
) =>
  new Promise<{ stdout: Buffer; stderr: Buffer }>((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutSize = 0;
    let stderrSize = 0;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    };
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(options.timeoutCode));
    }, options.timeoutMs);
    timeout.unref();

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutSize += chunk.length;
      if (stdoutSize > options.maxStdoutBytes) {
        child.kill("SIGKILL");
        finish(new Error(options.tooLargeCode));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrSize += chunk.length;
      if (stderrSize > options.maxStderrBytes) {
        child.kill("SIGKILL");
        finish(new Error(options.tooLargeCode));
        return;
      }
      stderr.push(chunk);
    });
    child.on("error", () => finish(new Error(options.unavailableCode)));
    child.on("close", (code) => {
      if (code !== 0) {
        finish(new Error(options.failedCode));
        return;
      }
      finish();
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });

const lastMetric = (diagnostics: string, label: string) => {
  const matches = [...diagnostics.matchAll(new RegExp(`${label}:\\s*(-?inf|[-+]?\\d+(?:\\.\\d+)?)`, "gi"))];
  const raw = matches.at(-1)?.[1]?.toLowerCase();
  if (!raw) return null;
  if (raw === "-inf") return Number.NEGATIVE_INFINITY;
  const parsed = Number(raw);
  return Number.isNaN(parsed) ? null : parsed;
};

export const validateVoiceInspection = (probeOutput: string, analysisOutput: string) => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(probeOutput);
  } catch {
    throw new Error("VOICE_INVALID_STREAM");
  }

  const stream = (parsed as { streams?: Array<Record<string, unknown>> }).streams?.[0];
  const sampleRate = Number(stream?.sample_rate);
  const channels = Number(stream?.channels);
  if (
    stream?.codec_name !== "opus" ||
    stream.codec_type !== "audio" ||
    sampleRate !== WHATSAPP_OPUS_SAMPLE_RATE ||
    channels !== WHATSAPP_OPUS_CHANNELS
  ) {
    throw new Error("VOICE_INVALID_STREAM");
  }

  const sampleCount = lastMetric(analysisOutput, "Number of samples");
  if (sampleCount === null || !Number.isFinite(sampleCount) || sampleCount <= 0 || sampleCount / sampleRate <= 0) {
    throw new Error("VOICE_INVALID_DURATION");
  }

  const peakDbfs = lastMetric(analysisOutput, "Peak level dB");
  if (peakDbfs === null || peakDbfs <= SILENCE_PEAK_THRESHOLD_DBFS) {
    throw new Error("VOICE_SILENT_AUDIO");
  }
};

const validateVoiceSourceInspection = (probeOutput: string, analysisOutput: string) => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(probeOutput);
  } catch {
    throw new Error("VOICE_SOURCE_INVALID_STREAM");
  }
  const stream = (parsed as { streams?: Array<Record<string, unknown>> }).streams?.[0];
  const sampleRate = Number(stream?.sample_rate);
  const channels = Number(stream?.channels);
  if (
    stream?.codec_type !== "audio" ||
    !Number.isFinite(sampleRate) ||
    sampleRate <= 0 ||
    !Number.isFinite(channels) ||
    channels <= 0
  ) {
    throw new Error("VOICE_SOURCE_INVALID_STREAM");
  }
  const sampleCount = lastMetric(analysisOutput, "Number of samples");
  if (sampleCount === null || !Number.isFinite(sampleCount) || sampleCount <= 0) {
    throw new Error("VOICE_SOURCE_INVALID_DURATION");
  }
  const peakDbfs = lastMetric(analysisOutput, "Peak level dB");
  if (peakDbfs === null || peakDbfs <= SILENCE_PEAK_THRESHOLD_DBFS) {
    throw new Error("VOICE_SOURCE_SILENT_AUDIO");
  }
};

const validateSourceVoice = async (bytes: Buffer) => {
  const validationOptions: PipeCommandOptions = {
    timeoutMs: VALIDATION_TIMEOUT_MS,
    maxStdoutBytes: MAX_DIAGNOSTIC_BYTES,
    maxStderrBytes: MAX_DIAGNOSTIC_BYTES,
    unavailableCode: "VOICE_VALIDATION_UNAVAILABLE",
    timeoutCode: "VOICE_VALIDATION_TIMEOUT",
    tooLargeCode: "VOICE_SOURCE_VALIDATION_FAILED",
    failedCode: "VOICE_SOURCE_VALIDATION_FAILED",
  };
  const [probe, analysis] = await Promise.all([
    runPipeCommand("ffprobe", VOICE_SOURCE_FFPROBE_ARGS, bytes, validationOptions),
    runPipeCommand("ffmpeg", VOICE_ANALYZE_ARGS, bytes, validationOptions),
  ]);
  validateVoiceSourceInspection(
    probe.stdout.toString("utf8"),
    analysis.stderr.toString("utf8"),
  );
};

const validateTranscodedVoice = async (bytes: Buffer) => {
  const validationOptions: PipeCommandOptions = {
    timeoutMs: VALIDATION_TIMEOUT_MS,
    maxStdoutBytes: MAX_DIAGNOSTIC_BYTES,
    maxStderrBytes: MAX_DIAGNOSTIC_BYTES,
    unavailableCode: "VOICE_VALIDATION_UNAVAILABLE",
    timeoutCode: "VOICE_VALIDATION_TIMEOUT",
    tooLargeCode: "VOICE_VALIDATION_FAILED",
    failedCode: "VOICE_VALIDATION_FAILED",
  };
  const [probe, analysis] = await Promise.all([
    runPipeCommand("ffprobe", VOICE_FFPROBE_ARGS, bytes, validationOptions),
    runPipeCommand("ffmpeg", VOICE_ANALYZE_ARGS, bytes, validationOptions),
  ]);
  validateVoiceInspection(probe.stdout.toString("utf8"), analysis.stderr.toString("utf8"));
};

export const transcodeVoiceToOggOpus: VoiceTranscoder = async (bytes) => {
  // Prove the browser upload itself contains audible samples. Without this
  // boundary a valid but silent WebM/MP4 is indistinguishable from ffmpeg
  // muting good input, and ClinicFlow would send a known-bad voice note.
  await validateSourceVoice(bytes);
  const { stdout } = await runPipeCommand("ffmpeg", VOICE_FFMPEG_ARGS, bytes, {
    timeoutMs: TRANSCODE_TIMEOUT_MS,
    maxStdoutBytes: MAX_TRANSCODED_BYTES,
    maxStderrBytes: MAX_DIAGNOSTIC_BYTES,
    unavailableCode: "VOICE_TRANSCODE_UNAVAILABLE",
    timeoutCode: "VOICE_TRANSCODE_TIMEOUT",
    tooLargeCode: "VOICE_TRANSCODE_TOO_LARGE",
    failedCode: "VOICE_TRANSCODE_FAILED",
  });
  if (stdout.length === 0) throw new Error("VOICE_TRANSCODE_FAILED");
  await validateTranscodedVoice(stdout);
  return stdout;
};
