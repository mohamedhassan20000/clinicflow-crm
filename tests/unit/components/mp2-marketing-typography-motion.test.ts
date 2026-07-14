import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync("app/globals.css", "utf8");
// P2A moved the font declarations out of `app/layout.tsx` into `app/fonts.ts`, because the app now
// loads three families (Manrope, Thmanyah, and the IBM Plex Sans Arabic fallback tier) rather than
// one. MP2's contract is unchanged and still asserted below: Manrope is the primary English face,
// and no other family touches an English surface.
const fonts = readFileSync("app/fonts.ts", "utf8");
const marketingPage = readFileSync(
  "components/marketing/marketing-page.tsx",
  "utf8",
);

/** The Arabic-only block, which by construction applies to nothing until the root element is `ar`. */
const arabicScope = css.slice(css.indexOf('html[lang="ar"]'));
const englishScope = css.slice(0, css.indexOf('html[lang="ar"]'));

describe("Post-Pre-P2 MP2 marketing typography and motion", () => {
  it("uses Manrope as the primary English font through shared variables", () => {
    expect(fonts).toContain("Manrope");
    expect(fonts).toContain('variable: "--font-manrope"');

    for (const role of ["sans", "heading", "display", "mono"]) {
      expect(css).toContain(
        `--font-${role}: var(--font-manrope), "Segoe UI", system-ui`,
      );
    }

    // The English cascade is untouched by P2A: no Arabic face and no serif reaches it.
    expect(englishScope).not.toMatch(/font-(?:plex|geist|instrument|thmanyah)|Georgia|Times New Roman/);
    expect(css).not.toMatch(/Geist_Mono|DM_Sans|Instrument_Serif/);
  });

  it("confines the Arabic faces to lang=ar (P2A §4.3)", () => {
    expect(arabicScope).toContain("var(--font-thmanyah)");
    expect(arabicScope).toContain("var(--font-plex-arabic)");
    // Thmanyah is the primary Arabic face and IBM Plex Sans Arabic is only the fallback tier.
    expect(arabicScope.indexOf("var(--font-thmanyah)")).toBeLessThan(
      arabicScope.indexOf("var(--font-plex-arabic)"),
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
