import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { createTranslator } from "next-intl";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import ar from "@/messages/ar.json";

const marketingPage = readFileSync("components/marketing/marketing-page.tsx", "utf8");
const styles = readFileSync("app/globals.css", "utf8");
const seed = readFileSync("scripts/seed-marketing-demo.ts", "utf8");
const capture = readFileSync("scripts/capture-marketing-screenshots.ts", "utf8");

describe("Arabic landing refinements", () => {
  it("balances hero leading in both locales and keeps Arabic pricing cards equal-height", () => {
    expect(marketingPage).toContain("leading-[1.25]");
    expect(styles).toContain('html[lang="ar"] .marketing-hero-title');
    expect(styles).toContain("line-height: 1.4");
    expect(styles).toContain('html[lang="ar"] .marketing-pricing-grid');
    expect(styles).toContain('html[lang="ar"] .marketing-pricing-card');
    expect(marketingPage).toContain("marketing-pricing-card marketing-card");
  });

  it("starts the Arabic marketing cohort at 4 of 10 and preserves live increments", () => {
    const t = createTranslator({ locale: "ar", messages: ar, namespace: "marketing" });
    expect(t("proof.progress", { accepted: "٤", limit: "١٠" })).toBe(
      "٤ من ١٠ عيادات انضمت إلينا هذا الأسبوع",
    );
    expect(marketingPage).toContain("MARKETING_COHORT_BASELINE = 4");
    expect(marketingPage).toContain("status.acceptedThisWeek + MARKETING_COHORT_BASELINE");
    expect(marketingPage).toContain("weeklyLimit: 10");
  });

  it("ships separate SAR assets for every Arabic mockup that contains money", async () => {
    for (const name of ["dashboard", "patient-record", "reports"]) {
      for (const [variant, width, height] of [
        ["desktop", 1440, 960],
        ["mobile", 390, 844],
      ] as const) {
        const path = resolve("public/marketing", `${name}-ar-${variant}.avif`);
        const sharedPath = resolve("public/marketing", `${name}-${variant}.avif`);
        const metadata = await sharp(path).metadata();
        expect(metadata.width).toBe(width);
        expect(metadata.height).toBe(height);
        expect(statSync(path).size).toBeLessThanOrEqual(300_000);
        expect(readFileSync(sharedPath)).toEqual(readFileSync(path));
      }
    }

    expect(marketingPage).toContain("function sarMarketingAsset");
    expect(marketingPage).toContain('"-ar-$1.avif"');
  });

  it("seeds the requested Saudi prior-month revenue sequence", () => {
    for (const amount of ["18_250", "21_900", "19_750", "25_600", "28_900", "31_400"]) {
      expect(seed).toContain(amount);
    }
    expect(seed).toContain('currency: "SAR"');
    expect(seed).toContain('MARKETING_DEMO_MARKET === "sa"');
    expect(capture).toContain('MARKETING_DEMO_MARKET === "kw" ? "kw" : "sa"');
  });
});
