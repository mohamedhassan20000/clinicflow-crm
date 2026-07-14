import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const layout = readFileSync("app/layout.tsx", "utf8");
const css = readFileSync("app/globals.css", "utf8");
const marketingPage = readFileSync(
  "components/marketing/marketing-page.tsx",
  "utf8",
);

describe("Post-Pre-P2 MP2 marketing typography and motion", () => {
  it("uses Manrope as the primary English font through shared variables", () => {
    expect(layout).toContain("Manrope");
    expect(layout).toContain('variable: "--font-manrope"');
    expect(layout).not.toMatch(/IBM_Plex|Geist_Mono|DM_Sans|Instrument_Serif/);

    for (const role of ["sans", "heading", "display", "mono"]) {
      expect(css).toContain(
        `--font-${role}: var(--font-manrope), "Segoe UI", system-ui`,
      );
    }
    expect(css).not.toMatch(/font-(?:plex|geist|instrument)|Georgia|Times New Roman/);
  });

  it("keeps marketing motion CSS-first, transform-based, and centrally timed", () => {
    const motionCore = css.slice(
      css.indexOf("@keyframes marketing-hero-step-in"),
      css.indexOf("@supports (animation-timeline: view())"),
    );

    expect(css).toContain("--m-motion-ease:");
    expect(css).toContain("--m-motion-spring:");
    expect(css).toContain("@keyframes marketing-hero-step-in");
    expect(css).toContain("@keyframes marketing-section-in");
    expect(css).toContain("@keyframes marketing-edge-draw");
    expect(css).toContain("@keyframes marketing-frame-parallax");
    expect(css).toContain("animation-timeline: view()");
    expect(motionCore).not.toMatch(/\b(?:width|height|top|left):/);
  });

  it("stages the hero without changing its copy or information architecture", () => {
    for (const className of [
      "marketing-hero-eyebrow",
      "marketing-hero-title",
      "marketing-hero-body",
      "marketing-hero-actions",
      "marketing-hero-assurances",
    ]) {
      expect(marketingPage).toContain(className);
    }

    expect(marketingPage).toContain(
      "text-[clamp(3.05rem,6.2vw,6.65rem)]",
    );
    expect(marketingPage).toContain("{copy.hero.title}");
    expect(marketingPage).toContain("{copy.hero.body}");
  });
});
