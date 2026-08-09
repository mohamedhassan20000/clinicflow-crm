import { execFileSync } from "node:child_process";
import { lstatSync, readdirSync, realpathSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DOCUMENT_FONT_SOURCE_PATHS } from "@/lib/documents/pdf/fonts";

const RENDERER_PACKAGES = [
  "node_modules/@sparticuz/chromium",
  "node_modules/puppeteer-core",
  "node_modules/qrcode",
] as const;

function directoryBytes(path: string): number {
  const resolved = lstatSync(path).isSymbolicLink() ? realpathSync(path) : path;
  const entry = statSync(resolved);
  if (entry.isFile()) return entry.size;
  return readdirSync(resolved).reduce(
    (total, child) => total + directoryBytes(join(resolved, child)),
    0,
  );
}

describe("P7-1 serverless renderer bundle gate", () => {
  it("keeps the approved renderer packages below the 120 MiB operational budget", () => {
    const bytes = RENDERER_PACKAGES.reduce(
      (total, path) => total + directoryBytes(join(process.cwd(), path)),
      0,
    );
    expect(bytes).toBeLessThan(120 * 1024 * 1024);
  });

  it("externalizes the Chromium binary and traces only approved local fonts", () => {
    const config = readFileSync(join(process.cwd(), "next.config.ts"), "utf8");
    expect(config).toContain('serverExternalPackages: ["@sparticuz/chromium"]');
    expect(config).toContain('"./app/fonts/manrope/*.woff2"');
    expect(config).toContain('"./app/fonts/thmanyah/*.woff2"');
  });

  it("keeps every runtime font source available in a clean checkout", () => {
    for (const relativePath of DOCUMENT_FONT_SOURCE_PATHS) {
      const absolutePath = join(process.cwd(), relativePath);
      expect(statSync(absolutePath).size).toBeGreaterThan(0);
      expect(
        execFileSync("git", ["ls-files", "--error-unmatch", relativePath], {
          cwd: process.cwd(),
          encoding: "utf8",
        }).trim(),
      ).toBe(relativePath);
    }
  });
});
