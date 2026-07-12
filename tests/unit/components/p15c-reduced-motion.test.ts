import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("P1.5C reduced-motion contract", () => {
  it("disables marketing animation, transitions, and hover movement", () => {
    const css = readFileSync("app/globals.css", "utf8");
    const reducedMotion = css.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/)?.[1];

    expect(reducedMotion).toContain(".marketing-reveal, .marketing-float");
    expect(reducedMotion).toContain("animation: none");
    expect(reducedMotion).toContain("transition: none");
    expect(reducedMotion).toContain("transform: none");
  });
});
