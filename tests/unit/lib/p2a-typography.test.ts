import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const fonts = readFileSync("app/fonts.ts", "utf8");
const css = readFileSync("app/globals.css", "utf8");

/**
 * Guards the font mapping against the weights the family does not actually have. thmanyah sans ships
 * five upright faces — 300/400/500/700/900 — with no SemiBold (600) and no italics. A future edit
 * that "adds" a 600 or an italic would be declaring a face that does not exist.
 */
const SHIPPED_WEIGHTS = ["300", "400", "500", "700", "900"] as const;

describe("P2A typography — Thmanyah mapping (§4.3)", () => {
  it("ships exactly the five real weights, all upright", () => {
    for (const weight of SHIPPED_WEIGHTS) {
      expect(fonts).toContain(`weight: "${weight}", style: "normal"`);
    }
    expect(fonts.match(/weight: "\d{3}"/g)).toHaveLength(SHIPPED_WEIGHTS.length);
    expect(fonts).not.toContain('style: "italic"');
    // The family has no 600 — declaring one would point at a file that does not exist.
    expect(fonts).not.toContain('weight: "600"');
  });

  it("references font files that actually exist on disk", () => {
    const referenced = [...fonts.matchAll(/path: "\.\/(fonts\/thmanyah\/[^"]+)"/g)].map((m) => m[1]);
    expect(referenced).toHaveLength(SHIPPED_WEIGHTS.length);

    for (const relative of referenced) {
      const absolute = join(process.cwd(), "app", relative);
      expect(existsSync(absolute), `${relative} is missing`).toBe(true);
      expect(statSync(absolute).size).toBeGreaterThan(1000);
      expect(relative.endsWith(".woff2")).toBe(true);
    }
  });

  it("keeps Manrope as the Latin face for the whole application", () => {
    expect(fonts).toContain("Manrope");
    expect(css).toContain("--font-sans: var(--font-manrope)");
  });

  it("applies the Arabic stack only under lang=ar, so English renders unchanged", () => {
    expect(css).toContain('html[lang="ar"]');
    expect(css).toContain(
      '--font-sans: var(--font-thmanyah), var(--font-plex-arabic), "Segoe UI", system-ui, sans-serif;',
    );
    // The fallback tier from §4.3 is present and ordered after the licensed face.
    expect(fonts).toContain("IBM_Plex_Sans_Arabic");
    expect(css.indexOf("var(--font-thmanyah)")).toBeLessThan(
      css.indexOf("var(--font-plex-arabic)"),
    );
  });
});
