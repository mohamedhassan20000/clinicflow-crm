import "server-only";

import sharp from "sharp";

const MAX_INPUT_PIXELS = 40_000_000;
const MARGIN_RATIO = 0.04;
const TRANSPARENT_ALPHA_MAX = 16;
const WHITE_CHANNEL_MIN = 245;

type CanvasBackground = "transparent" | "white" | "unknown";

interface Bounds {
  left: number; // rtl-allow: physical image pixel bound, not UI layout
  top: number;
  right: number; // rtl-allow: physical image pixel bound, not UI layout
  bottom: number;
}

export interface CleanClinicLogoResult {
  bytes: Buffer;
  width: number;
  height: number;
}

function pixelOffset(width: number, x: number, y: number) {
  return (y * width + x) * 4;
}

function isTransparent(data: Buffer, offset: number) {
  return data[offset + 3] <= TRANSPARENT_ALPHA_MAX;
}

function isOpaqueWhite(data: Buffer, offset: number) {
  return (
    data[offset + 3] >= 240 &&
    data[offset] >= WHITE_CHANNEL_MIN &&
    data[offset + 1] >= WHITE_CHANNEL_MIN &&
    data[offset + 2] >= WHITE_CHANNEL_MIN
  );
}

function classifyCanvasBackground(
  data: Buffer,
  width: number,
  height: number,
): CanvasBackground {
  let sampleCount = 0;
  let transparentCount = 0;
  let whiteCount = 0;

  const sample = (x: number, y: number) => {
    const offset = pixelOffset(width, x, y);
    sampleCount += 1;
    if (isTransparent(data, offset)) transparentCount += 1;
    if (isOpaqueWhite(data, offset)) whiteCount += 1;
  };

  for (let x = 0; x < width; x += 1) {
    sample(x, 0);
    if (height > 1) sample(x, height - 1);
  }
  for (let y = 1; y < height - 1; y += 1) {
    sample(0, y);
    if (width > 1) sample(width - 1, y);
  }

  if (transparentCount / sampleCount >= 0.9) return "transparent";
  if (whiteCount / sampleCount >= 0.9) return "white";
  return "unknown";
}

function isVisibleAgainstWhite(data: Buffer, offset: number) {
  const alpha = data[offset + 3] / 255;
  const red = data[offset] * alpha + 255 * (1 - alpha);
  const green = data[offset + 1] * alpha + 255 * (1 - alpha);
  const blue = data[offset + 2] * alpha + 255 * (1 - alpha);

  return (
    red < WHITE_CHANNEL_MIN ||
    green < WHITE_CHANNEL_MIN ||
    blue < WHITE_CHANNEL_MIN
  );
}

function findContentBounds(
  data: Buffer,
  width: number,
  height: number,
  background: CanvasBackground,
): Bounds | null {
  if (background === "unknown") {
    return { left: 0, top: 0, right: width - 1, bottom: height - 1 }; // rtl-allow: physical image pixel bounds, not UI layout
  }

  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = pixelOffset(width, x, y);
      const isContent =
        background === "transparent"
          ? !isTransparent(data, offset)
          : isVisibleAgainstWhite(data, offset);

      if (!isContent) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }

  return right >= left && bottom >= top
    ? { left, top, right, bottom }
    : null;
}

/**
 * Removes transparent or near-white logo canvas padding once, at upload time.
 * The content pixels are never resized; a small transparent margin is added
 * around the detected bounds and the cleaned asset is encoded losslessly.
 */
export async function cleanClinicLogo(
  input: Uint8Array,
): Promise<CleanClinicLogoResult> {
  const decoded = await sharp(input, {
    failOn: "error",
    limitInputPixels: MAX_INPUT_PIXELS,
  })
    .rotate()
    .toColourspace("srgb")
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = decoded.info;
  if (width < 1 || height < 1 || channels !== 4) {
    throw new Error("Clinic logo could not be decoded as an RGBA image");
  }

  const background = classifyCanvasBackground(decoded.data, width, height);
  const bounds = findContentBounds(decoded.data, width, height, background);
  if (!bounds) {
    throw new Error("Clinic logo contains no visible content");
  }

  const contentWidth = bounds.right - bounds.left + 1;
  const contentHeight = bounds.bottom - bounds.top + 1;
  const horizontalMargin = Math.max(1, Math.round(contentWidth * MARGIN_RATIO));
  const verticalMargin = Math.max(1, Math.round(contentHeight * MARGIN_RATIO));

  const cleaned = await sharp(decoded.data, {
    raw: { width, height, channels: 4 },
  })
    .extract({
      left: bounds.left, // rtl-allow: Sharp physical pixel coordinate, not UI layout
      top: bounds.top,
      width: contentWidth,
      height: contentHeight,
    })
    .extend({
      top: verticalMargin,
      bottom: verticalMargin,
      left: horizontalMargin, // rtl-allow: Sharp physical pixel padding, not UI layout
      right: horizontalMargin, // rtl-allow: Sharp physical pixel padding, not UI layout
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png({ compressionLevel: 9, palette: false })
    .toBuffer({ resolveWithObject: true });

  return {
    bytes: cleaned.data,
    width: cleaned.info.width,
    height: cleaned.info.height,
  };
}
