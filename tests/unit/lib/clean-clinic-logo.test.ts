import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { cleanClinicLogo } from "@/lib/images/clean-clinic-logo";

function svgLogo(options: {
  width: number;
  height: number;
  background?: string;
  rect: { x: number; y: number; width: number; height: number; fill: string };
}) {
  const background = options.background
    ? `<rect width="100%" height="100%" fill="${options.background}" />`
    : "";
  const { x, y, width, height, fill } = options.rect;

  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${options.width}" height="${options.height}">${background}<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${fill}" /></svg>`,
  );
}

describe("cleanClinicLogo", () => {
  it("trims transparent padding and adds a four-percent transparent margin", async () => {
    const source = await sharp(
      svgLogo({
        width: 200,
        height: 120,
        rect: { x: 50, y: 30, width: 100, height: 60, fill: "#1264a3" },
      }),
    )
      .png()
      .toBuffer();

    const result = await cleanClinicLogo(source);
    const metadata = await sharp(result.bytes).metadata();

    expect(result.width).toBe(108);
    expect(result.height).toBe(64);
    expect(metadata.format).toBe("png");
    expect(metadata.hasAlpha).toBe(true);
  });

  it("detects and removes near-white JPEG canvas padding", async () => {
    const source = await sharp(
      svgLogo({
        width: 240,
        height: 140,
        background: "#ffffff",
        rect: { x: 70, y: 40, width: 100, height: 60, fill: "#b42318" },
      }),
    )
      .jpeg({ quality: 94 })
      .toBuffer();

    const result = await cleanClinicLogo(source);

    expect(result.width).toBeLessThan(140);
    expect(result.height).toBeLessThan(100);
    expect(result.width).toBeGreaterThanOrEqual(108);
    expect(result.height).toBeGreaterThanOrEqual(64);
  });

  it("processes SVG uploads without resizing their visible content", async () => {
    const source = svgLogo({
      width: 300,
      height: 180,
      rect: { x: 100, y: 60, width: 100, height: 60, fill: "#147d64" },
    });

    const result = await cleanClinicLogo(source);

    expect(result.width).toBe(108);
    expect(result.height).toBe(64);
  });

  it("keeps an already-tight logo intact and only adds the standard margin", async () => {
    const source = await sharp({
      create: {
        width: 100,
        height: 50,
        channels: 4,
        background: { r: 20, g: 80, b: 150, alpha: 1 },
      },
    })
      .png()
      .toBuffer();

    const result = await cleanClinicLogo(source);
    const { data, info } = await sharp(result.bytes)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    expect(info.width).toBe(108);
    expect(info.height).toBe(54);
    expect(data[3]).toBe(0);

    const center = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * 4;
    expect(Array.from(data.subarray(center, center + 4))).toEqual([20, 80, 150, 255]);
  });

  it("rejects an image with no visible content", async () => {
    const source = await sharp({
      create: {
        width: 100,
        height: 100,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .png()
      .toBuffer();

    await expect(cleanClinicLogo(source)).rejects.toThrow(
      "Clinic logo contains no visible content",
    );
  });
});
