/**
 * Browser-side microphone inspection for Inbox voice notes.
 *
 * MediaRecorder producing bytes only proves that a container was written. It
 * does not prove that the selected input delivered useful samples. These
 * helpers keep one AudioContext attached to the captured microphone so the UI
 * can show a privacy-safe level meter, then inspect the exact Blob that would
 * be uploaded and refuse silence before any bytes leave the device.
 */

export const MIN_VOICE_DURATION_SECONDS = 0.25;
export const MIN_VOICE_PEAK = 0.001;
export const MIN_VOICE_RMS = 0.0001;
export const MIN_ACTIVE_VOICE_SECONDS = 0.06;

const ANALYSIS_WINDOW_SECONDS = 0.02;
const PLAYABILITY_TIMEOUT_MS = 2_000;

export type RecordedAudioInspection = {
  durationSeconds: number;
  decodedSampleCount: number | null;
  observedSampleCount: number;
  peak: number;
  rms: number;
  maxWindowRms: number;
  activeVoiceSeconds: number;
  audible: boolean;
  validationMode: "decoded_pcm" | "live_pcm_playable_blob";
};

type LiveAudioInspection = Omit<
  RecordedAudioInspection,
  "durationSeconds" | "decodedSampleCount" | "validationMode"
>;

export type AudioCaptureMonitor = {
  inspect(blob: Blob, recordingDurationSeconds: number): Promise<RecordedAudioInspection>;
  getLiveInspection(): LiveAudioInspection;
  resetLiveInspection(): void;
  close(): Promise<void>;
};

export function hasLiveAudioSignal(
  inspection: Pick<LiveAudioInspection, "peak" | "rms" | "maxWindowRms">,
): boolean {
  return (
    inspection.peak >= MIN_VOICE_PEAK ||
    inspection.rms >= MIN_VOICE_RMS ||
    inspection.maxWindowRms >= MIN_VOICE_RMS
  );
}

function finiteMagnitude(sample: number | undefined): number {
  return Number.isFinite(sample) ? Math.abs(sample ?? 0) : 0;
}

function isAudible(input: {
  durationSeconds: number;
  sampleCount: number;
  peak: number;
  maxWindowRms: number;
  activeVoiceSeconds: number;
}): boolean {
  return (
    input.durationSeconds >= MIN_VOICE_DURATION_SECONDS &&
    input.sampleCount > 0 &&
    input.peak >= MIN_VOICE_PEAK &&
    input.maxWindowRms >= MIN_VOICE_RMS &&
    input.activeVoiceSeconds >= MIN_ACTIVE_VOICE_SECONDS
  );
}

export function inspectDecodedAudioBuffer(
  buffer: Pick<
    AudioBuffer,
    "length" | "numberOfChannels" | "duration" | "sampleRate" | "getChannelData"
  >,
): RecordedAudioInspection {
  const decodedSampleCount = buffer.length * buffer.numberOfChannels;
  const durationSeconds = Number.isFinite(buffer.duration) ? buffer.duration : 0;
  const inferredSampleRate = durationSeconds > 0 ? buffer.length / durationSeconds : 0;
  const sampleRate = Number.isFinite(buffer.sampleRate) && buffer.sampleRate > 0
    ? buffer.sampleRate
    : inferredSampleRate;
  const windowFrames = Math.max(1, Math.round(sampleRate * ANALYSIS_WINDOW_SECONDS));
  let peak = 0;
  let sumSquares = 0;
  let inspectedSamples = 0;
  let maxWindowRms = 0;
  let maxConsecutiveActiveWindows = 0;

  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const samples = buffer.getChannelData(channel);
    let windowSquares = 0;
    let windowSamples = 0;
    let consecutiveActiveWindows = 0;

    for (let index = 0; index < samples.length; index += 1) {
      const absolute = finiteMagnitude(samples[index]);
      peak = Math.max(peak, absolute);
      sumSquares += absolute * absolute;
      inspectedSamples += 1;
      windowSquares += absolute * absolute;
      windowSamples += 1;

      if (windowSamples === windowFrames || index === samples.length - 1) {
        const windowRms = Math.sqrt(windowSquares / windowSamples);
        maxWindowRms = Math.max(maxWindowRms, windowRms);
        if (windowRms >= MIN_VOICE_RMS) {
          consecutiveActiveWindows += 1;
          maxConsecutiveActiveWindows = Math.max(
            maxConsecutiveActiveWindows,
            consecutiveActiveWindows,
          );
        } else {
          consecutiveActiveWindows = 0;
        }
        windowSquares = 0;
        windowSamples = 0;
      }
    }
  }

  const rms = inspectedSamples > 0 ? Math.sqrt(sumSquares / inspectedSamples) : 0;
  const activeVoiceSeconds = maxConsecutiveActiveWindows * ANALYSIS_WINDOW_SECONDS;
  return {
    durationSeconds,
    decodedSampleCount,
    observedSampleCount: inspectedSamples,
    peak,
    rms,
    maxWindowRms,
    activeVoiceSeconds,
    audible: isAudible({
      durationSeconds,
      sampleCount: decodedSampleCount,
      peak,
      maxWindowRms,
      activeVoiceSeconds,
    }),
    validationMode: "decoded_pcm",
  };
}

function meterLevelFromRms(rms: number): number {
  if (rms <= 0 || !Number.isFinite(rms)) return 0;
  // A logarithmic display makes quiet laptop/phone speech visibly move while
  // still leaving headroom for loud input. -80 dBFS maps to 0, -12 dBFS to 1.
  const decibels = 20 * Math.log10(rms);
  return Math.max(0, Math.min(1, (decibels + 80) / 68));
}

async function blobIsPlayable(blob: Blob): Promise<boolean> {
  if (
    typeof document === "undefined" ||
    typeof URL.createObjectURL !== "function" ||
    typeof URL.revokeObjectURL !== "function"
  ) {
    return false;
  }

  const url = URL.createObjectURL(blob);
  const audio = document.createElement("audio");
  audio.preload = "metadata";
  audio.muted = true;

  try {
    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (result: boolean) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        audio.removeAttribute("src");
        audio.load();
        resolve(result);
      };
      const timeout = window.setTimeout(() => finish(false), PLAYABILITY_TIMEOUT_MS);
      audio.addEventListener("loadedmetadata", () => finish(true), { once: true });
      audio.addEventListener("error", () => finish(false), { once: true });
      audio.src = url;
      audio.load();
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function createAudioCaptureMonitor(
  stream: MediaStream,
  onLevel: (level: number) => void,
): Promise<AudioCaptureMonitor> {
  const context = new AudioContext();
  if (context.state === "suspended") await context.resume();

  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.65;
  source.connect(analyser);

  const samples = new Float32Array(analyser.fftSize);
  let frame = 0;
  let closed = false;
  let observedSampleCount = 0;
  let observedSumSquares = 0;
  let observedPeak = 0;
  let observedMaxWindowRms = 0;
  let currentActiveVoiceSeconds = 0;
  let maxActiveVoiceSeconds = 0;
  let previousFrameAt: number | null = null;

  const resetLiveInspection = () => {
    observedSampleCount = 0;
    observedSumSquares = 0;
    observedPeak = 0;
    observedMaxWindowRms = 0;
    currentActiveVoiceSeconds = 0;
    maxActiveVoiceSeconds = 0;
    previousFrameAt = null;
  };

  const getLiveInspection = (): LiveAudioInspection => {
    const rms = observedSampleCount > 0
      ? Math.sqrt(observedSumSquares / observedSampleCount)
      : 0;
    return {
      observedSampleCount,
      peak: observedPeak,
      rms,
      maxWindowRms: observedMaxWindowRms,
      activeVoiceSeconds: maxActiveVoiceSeconds,
      audible: isAudible({
        durationSeconds: maxActiveVoiceSeconds,
        sampleCount: observedSampleCount,
        peak: observedPeak,
        maxWindowRms: observedMaxWindowRms,
        activeVoiceSeconds: maxActiveVoiceSeconds,
      }),
    };
  };

  const update = (timestamp: number) => {
    if (closed) return;
    analyser.getFloatTimeDomainData(samples);
    let frameSquares = 0;
    let framePeak = 0;
    for (const sample of samples) {
      const absolute = finiteMagnitude(sample);
      framePeak = Math.max(framePeak, absolute);
      frameSquares += absolute * absolute;
    }
    const frameRms = Math.sqrt(frameSquares / samples.length);
    observedSampleCount += samples.length;
    observedSumSquares += frameSquares;
    observedPeak = Math.max(observedPeak, framePeak);
    observedMaxWindowRms = Math.max(observedMaxWindowRms, frameRms);
    if (frameRms >= MIN_VOICE_RMS && previousFrameAt !== null) {
      currentActiveVoiceSeconds += Math.min(
        0.1,
        Math.max(0, (timestamp - previousFrameAt) / 1_000),
      );
      maxActiveVoiceSeconds = Math.max(maxActiveVoiceSeconds, currentActiveVoiceSeconds);
    } else if (frameRms < MIN_VOICE_RMS) {
      currentActiveVoiceSeconds = 0;
    }
    previousFrameAt = timestamp;
    onLevel(meterLevelFromRms(frameRms));
    frame = requestAnimationFrame(update);
  };
  frame = requestAnimationFrame(update);

  return {
    async inspect(blob, recordingDurationSeconds) {
      try {
        const decoded = await context.decodeAudioData(await blob.arrayBuffer());
        return inspectDecodedAudioBuffer(decoded);
      } catch {
        // MediaRecorder support and decodeAudioData support are not identical
        // across Safari/Chrome versions. Native metadata is useful here only as
        // evidence that a decode-incompatible recorder container is real. It is
        // deliberately not checked on the decoded-PCM path above: a valid,
        // audible Blob remains sendable even when the local `<audio>` preview
        // cannot read that browser/container combination. The worker performs
        // its own source decode, silence check, transcode and output validation.
        const playable = await blobIsPlayable(blob);
        if (!playable) {
          throw new DOMException("Recorded audio could not be decoded", "EncodingError");
        }
        const live = getLiveInspection();
        return {
          durationSeconds: recordingDurationSeconds,
          decodedSampleCount: null,
          ...live,
          audible: isAudible({
            durationSeconds: recordingDurationSeconds,
            sampleCount: live.observedSampleCount,
            peak: live.peak,
            maxWindowRms: live.maxWindowRms,
            activeVoiceSeconds: live.activeVoiceSeconds,
          }),
          validationMode: "live_pcm_playable_blob",
        };
      }
    },
    getLiveInspection,
    resetLiveInspection,
    async close() {
      if (closed) return;
      closed = true;
      cancelAnimationFrame(frame);
      source.disconnect();
      analyser.disconnect();
      onLevel(0);
      await context.close().catch(() => undefined);
    },
  };
}
