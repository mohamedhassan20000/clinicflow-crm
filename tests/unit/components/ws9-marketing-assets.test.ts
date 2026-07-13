import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

const captureNames = ["dashboard", "schedule", "patients", "patient-record", "reports"];
const variants = [
  { suffix: "desktop", width: 1440, height: 960 },
  { suffix: "mobile", width: 390, height: 844 },
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
});
