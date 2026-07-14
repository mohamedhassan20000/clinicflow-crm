import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

const captureNames = ["dashboard", "schedule", "patients", "patient-record", "reports"];
const variants = [
  { suffix: "desktop", width: 1440, height: 960 },
  { suffix: "mobile", width: 390, height: 844 },
] as const;

const avatarRegions = [
  { asset: "dashboard-desktop", left: 1294, top: 18, width: 40, height: 40 },
  { asset: "dashboard-mobile", left: 329, top: 16, width: 40, height: 40 },
  { asset: "patients-desktop", left: 436, top: 392, width: 42, height: 42 },
  { asset: "patients-mobile", left: 128, top: 455, width: 42, height: 42 },
  { asset: "patient-record-desktop", left: 323, top: 187, width: 64, height: 64 },
  { asset: "patient-record-mobile", left: 15, top: 180, width: 66, height: 66 },
] as const;

describe("WS9 marketing screenshot assets", () => {
  it.each(captureNames.flatMap((name) => variants.map((variant) => ({ name, ...variant }))))(
    "$name-$suffix is an optimized AVIF at the capture contract dimensions",
    async ({ name, suffix, width, height }) => {
      const path = resolve("public/marketing", `${name}-${suffix}.avif`);
      const [file, metadata] = await Promise.all([stat(path), sharp(path).metadata()]);

      expect(metadata.format).toBe("heif");
      expect(metadata.compression).toBe("av1");
      expect(metadata.width).toBe(width);
      expect(metadata.height).toBe(height);
      expect(file.size).toBeLessThanOrEqual(300_000);
    },
  );

  it.each(avatarRegions)("$asset contains a visibly rendered fictional portrait", async (region) => {
    const path = resolve("public/marketing", `${region.asset}.avif`);
    const crop = await sharp(path)
      .extract({ left: region.left, top: region.top, width: region.width, height: region.height })
      .png()
      .toBuffer();
    const stats = await sharp(crop).stats();
    const averageDeviation = stats.channels
      .slice(0, 3)
      .reduce((total, channel) => total + channel.stdev, 0) / 3;

    expect(stats.entropy).toBeGreaterThan(2.5);
    expect(averageDeviation).toBeGreaterThan(15);
  });
});
