import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAudioCaptureMonitor,
  inspectDecodedAudioBuffer,
} from "@/lib/messaging/browser-audio";

function decoded(samples: number[], duration = 1) {
  const channel = Float32Array.from(samples);
  return {
    length: channel.length,
    numberOfChannels: 1,
    duration,
    sampleRate: duration > 0 ? channel.length / duration : 48_000,
    getChannelData: () => channel,
  };
}

describe("P8C browser voice sample inspection", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("accepts a recording only when decoded PCM has meaningful energy", () => {
    const samples = Array.from({ length: 48_000 }, (_, index) =>
      0.08 * Math.sin((2 * Math.PI * 440 * index) / 48_000));
    const inspection = inspectDecodedAudioBuffer(decoded(samples));
    expect(inspection.audible).toBe(true);
    expect(inspection.decodedSampleCount).toBe(48_000);
    expect(inspection.peak).toBeGreaterThan(0.07);
    expect(inspection.rms).toBeGreaterThan(0.05);
    expect(inspection.maxWindowRms).toBeGreaterThan(0.05);
    expect(inspection.validationMode).toBe("decoded_pcm");
  });

  it("accepts quiet speech even when whole-recording RMS is diluted by silence", () => {
    const samples = new Array(480_000).fill(0);
    for (let index = 48_000; index < 52_800; index += 1) {
      samples[index] = 0.0012 * Math.sin((2 * Math.PI * 220 * index) / 48_000);
    }
    const inspection = inspectDecodedAudioBuffer(decoded(samples, 10));
    expect(inspection.rms).toBeLessThan(0.0001);
    expect(inspection.peak).toBeGreaterThan(0.001);
    expect(inspection.activeVoiceSeconds).toBeGreaterThanOrEqual(0.08);
    expect(inspection.audible).toBe(true);
  });

  it("refuses zero PCM, zero samples, and audio shorter than the duration floor", () => {
    expect(inspectDecodedAudioBuffer(decoded(new Array(48_000).fill(0))).audible).toBe(false);
    expect(inspectDecodedAudioBuffer(decoded([], 0)).audible).toBe(false);
    expect(inspectDecodedAudioBuffer(decoded([0, 0.4, 0], 0.05)).audible).toBe(false);
  });

  it("refuses a single click instead of mistaking one peak for speech", () => {
    const samples = new Array(48_000).fill(0);
    samples[24_000] = 0.5;
    const inspection = inspectDecodedAudioBuffer(decoded(samples));
    expect(inspection.peak).toBe(0.5);
    expect(inspection.activeVoiceSeconds).toBeLessThan(0.06);
    expect(inspection.audible).toBe(false);
  });

  it("requires contiguous activity rather than adding isolated clicks together", () => {
    const samples = new Array(48_000).fill(0);
    for (const index of [4_800, 14_400, 24_000, 33_600]) samples[index] = 0.5;
    const inspection = inspectDecodedAudioBuffer(decoded(samples));
    expect(inspection.peak).toBe(0.5);
    expect(inspection.activeVoiceSeconds).toBeLessThan(0.06);
    expect(inspection.audible).toBe(false);
  });

  it("uses sustained live PCM only when the recorder Blob is browser-playable", async () => {
    const animationFrames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
      animationFrames.push(callback);
      return animationFrames.length;
    }));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:voice-note"),
      revokeObjectURL: vi.fn(),
    });

    class FakeAudioContext {
      state: AudioContextState = "running";
      sampleRate = 48_000;
      createMediaStreamSource() {
        return { connect: vi.fn(), disconnect: vi.fn() };
      }
      createAnalyser() {
        return {
          fftSize: 0,
          smoothingTimeConstant: 0,
          getFloatTimeDomainData: (samples: Float32Array) => samples.fill(0.01),
          disconnect: vi.fn(),
        };
      }
      decodeAudioData() {
        return Promise.reject(new DOMException("Unsupported decoder", "EncodingError"));
      }
      close() {
        return Promise.resolve();
      }
    }
    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(function load(
      this: HTMLMediaElement,
    ) {
      queueMicrotask(() => this.dispatchEvent(new Event("loadedmetadata")));
    });

    const monitor = await createAudioCaptureMonitor({} as MediaStream, vi.fn());
    for (const timestamp of [0, 20, 40, 60, 80, 100]) {
      animationFrames.shift()?.(timestamp);
    }
    const inspection = await monitor.inspect(
      new Blob(["browser-format-audio"], { type: "audio/webm;codecs=opus" }),
      1,
    );

    expect(inspection.validationMode).toBe("live_pcm_playable_blob");
    expect(inspection.decodedSampleCount).toBeNull();
    expect(inspection.peak).toBeCloseTo(0.01);
    expect(inspection.activeVoiceSeconds).toBeGreaterThanOrEqual(0.06);
    expect(inspection.audible).toBe(true);
    monitor.resetLiveInspection();
    expect(monitor.getLiveInspection()).toMatchObject({
      observedSampleCount: 0,
      peak: 0,
      rms: 0,
      maxWindowRms: 0,
      activeVoiceSeconds: 0,
    });
    await monitor.close();
  });

  it("accepts audible decoded PCM when the native preview player cannot load it", async () => {
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:unplayable"),
      revokeObjectURL: vi.fn(),
    });

    class FakeAudioContext {
      state: AudioContextState = "running";
      createMediaStreamSource() {
        return { connect: vi.fn(), disconnect: vi.fn() };
      }
      createAnalyser() {
        return {
          fftSize: 0,
          smoothingTimeConstant: 0,
          getFloatTimeDomainData: vi.fn(),
          disconnect: vi.fn(),
        };
      }
      decodeAudioData() {
        return Promise.resolve(decoded(new Array(48_000).fill(0.1)) as unknown as AudioBuffer);
      }
      close() {
        return Promise.resolve();
      }
    }
    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(function load(
      this: HTMLMediaElement,
    ) {
      queueMicrotask(() => this.dispatchEvent(new Event("error")));
    });

    const monitor = await createAudioCaptureMonitor({} as MediaStream, vi.fn());
    const inspection = await monitor.inspect(new Blob(["decoded-but-unplayable"]), 1);
    expect(inspection).toMatchObject({
      validationMode: "decoded_pcm",
      audible: true,
      decodedSampleCount: 48_000,
    });
    await monitor.close();
  });
});
