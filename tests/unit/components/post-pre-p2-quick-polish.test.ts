import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("Post-Pre-P2 quick UI polish", () => {
  it("centers the existing Preferences column without changing its width", () => {
    const preferences = source("app/(protected)/preferences/page.tsx");
    expect(preferences).toContain('className="mx-auto max-w-2xl space-y-6"');
  });

  it("uses a neutral icon fallback for patient avatars instead of initials", () => {
    const patients = source("components/patients/patient-table.tsx");
    expect(patients).toContain('<UserRound className="size-4" aria-hidden="true" />');
    expect(patients).not.toContain("initials(patient.full_name)");
  });

  it("composes the marketing calendar from a focused five-day clinic week", () => {
    const seed = source("scripts/seed-marketing-demo.ts");
    expect(seed).toContain("[1, 2, 3, 4, 5].flatMap((dayOfWeek)");
    expect(seed).toContain("[1, 2, 3, 4, 5].map((dayOfWeek)");
  });

  it("keeps the static hexagon texture restrained and scoped to the hero", () => {
    const styles = source("app/globals.css");
    expect(styles).toContain(".marketing-hero::before");
    expect(styles).toContain("inset-inline: 0");
    expect(styles).toContain("rgb(0 0 0 / 50%) 100%");
    expect(styles).toContain("opacity: .07");
    expect(styles).not.toContain(".marketing-page::before");
  });

  it("seeds fictional photo avatars and realistic Kuwaiti revenue totals", () => {
    const seed = source("scripts/seed-marketing-demo.ts");
    expect(seed).toContain('public/marketing/demo-avatars/user-admin.webp');
    expect(seed).toContain('avatar_path: patientAvatarPaths[index]');
    expect(seed).toContain('2865.75');
    expect(seed).toContain('3615');
  });

  it("reflows the two affected mobile capture surfaces without changing desktop columns", () => {
    const dashboardRevenue = source("components/dashboard/revenue-widget.tsx");
    const revenuePage = source("app/(protected)/reports/revenue/page.tsx");
    const reportShell = source("components/reports/report-section-shell.tsx");
    const capture = source("scripts/capture-marketing-screenshots.ts");

    expect(dashboardRevenue).toContain("grid-cols-1");
    expect(dashboardRevenue).toContain("min-[360px]:grid-cols-2 sm:grid-cols-3");
    expect(dashboardRevenue).toContain("min-[360px]:col-span-2 sm:col-span-1");
    expect(revenuePage).toContain('className="order-1 md:order-2"');
    expect(revenuePage).toContain('className="order-2 space-y-6 md:order-1"');
    expect(reportShell).toContain("grid-cols-1 min-[360px]:grid-cols-2");
    for (const viewport of [
      "{ width: 320, height: 568 }",
      "{ width: 360, height: 800 }",
      "{ width: 390, height: 844 }",
      "{ width: 430, height: 932 }",
    ]) {
      expect(capture).toContain(viewport);
    }
  });

  it("keeps the Back-to-Top control landing-only, accessible, and reduced-motion safe", () => {
    const marketingPage = source("components/marketing/marketing-page.tsx");
    const backToTop = source("components/marketing/back-to-top-button.tsx");
    const styles = source("app/globals.css");

    // P2C: the control is still landing-only and still the same control — but its accessible name
    // is now a translated string, so the assertion is that the label is *passed in* rather than
    // hardcoded. A screen-reader user on Arabic must not hear "Back to top" in English.
    expect(marketingPage).toContain("<BackToTopButton label={copy.backToTop} />");
    expect(backToTop).toContain("aria-label={label}");
    expect(backToTop).not.toContain('aria-label="Back to top"');
    expect(backToTop).toContain('behavior: prefersReducedMotion ? "auto" : "smooth"');
    expect(backToTop).toContain("z-30");
    expect(styles).toContain(".marketing-back-to-top { transition: none; }");
  });
});
