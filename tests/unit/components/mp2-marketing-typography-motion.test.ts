import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const layout = readFileSync("app/layout.tsx", "utf8");
const css = readFileSync("app/globals.css", "utf8");
const marketingPage = readFileSync(
  "components/marketing/marketing-page.tsx",
  "utf8",
);

describe("Post-Pre-P2 MP2 marketing typography and motion", () => {
  it("uses the selected self-hosted IBM Plex stack through shared variables", () => {
    expect(layout).toContain("IBM_Plex_Sans");
    expect(layout).toContain("IBM_Plex_Serif");
    expect(layout).toContain('variable: "--font-plex-sans"');
    expect(layout).toContain('variable: "--font-plex-serif"');
    expect(layout).not.toMatch(/DM_Sans|Instrument_Serif/);

    expect(css).toContain(
      '--font-sans: var(--font-plex-sans), "Segoe UI", system-ui',
    );
    expect(css).toContain(
      '--font-display: var(--font-plex-serif), Georgia, "Times New Roman", serif',
    );
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
