import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveDateRange, resolveRollingYearRange } from "@/lib/date-range";
import { resolveReportsRange } from "@/lib/reports/data";
import { analyticalDocumentParamsSchema } from "@/lib/documents/resolvers/analytical-report";

// P7 Phase 2 — Date-Filter Parity Across Previews & Documents.
//
// Root cause: report → document links forward the resolved on-screen `from`/`to`
// WITHOUT a `preset`; the old `resolveDateRange` ignored `from`/`to` unless
// `preset === "custom"` and silently recomputed `this_month`. The canonical fix
// honors any present `from`/`to` pair as an explicit range, so every Preview and
// generated document locks to exactly the dates shown on the report page.
describe("P7 Phase 2 date-filter parity", () => {
  const NOW = new Date("2026-08-15T10:00:00.000Z");

  it("honors an explicit from/to pair even when no preset is forwarded", () => {
    // This is the exact shape a report page forwards to its document route.
    const range = resolveDateRange({ from: "2026-01-05", to: "2026-01-09", now: NOW });
    expect(range.preset).toBe("custom");
    expect(range.from).toBe("2026-01-05");
    expect(range.to).toBe("2026-01-09");
    // Must NOT collapse to the current month.
    expect(range.from.startsWith("2026-08")).toBe(false);
  });

  it("resolveReportsRange (the shared reports pipeline) locks to forwarded dates", () => {
    // A document route receives from/to (no preset) in its searchParams.
    const range = resolveReportsRange({ from: "2026-03-02", to: "2026-03-06" });
    expect(range.preset).toBe("custom");
    expect(range.from).toBe("2026-03-02");
    expect(range.to).toBe("2026-03-06");
  });

  it("still computes presets when no explicit range is present", () => {
    expect(resolveDateRange({ preset: "today", now: NOW }).from)
      .toBe(resolveDateRange({ preset: "today", now: NOW }).to);
    expect(resolveDateRange({ preset: "this_month", now: NOW }).from).toBe("2026-08-01");
    expect(resolveDateRange({ preset: "this_month", now: NOW }).to).toBe("2026-08-31");
    // A week preset resolves to a Monday→Sunday span (not the whole month).
    const week = resolveDateRange({ preset: "this_week", now: NOW });
    expect(week.preset).toBe("this_week");
    expect(week.from < week.to).toBe(true);
    // Default (nothing supplied) is still this_month.
    expect(resolveDateRange({ now: NOW }).preset).toBe("this_month");
  });

  it("keeps custom preset + from/to behaving identically to before", () => {
    const range = resolveDateRange({ preset: "custom", from: "2026-02-01", to: "2026-02-14", now: NOW });
    expect(range.preset).toBe("custom");
    expect(range.from).toBe("2026-02-01");
    expect(range.to).toBe("2026-02-14");
  });

  it("resolves Last year as a rolling clinic-local year ending today", () => {
    const range = resolveRollingYearRange(new Date("2026-08-08T10:00:00.000Z"));
    expect(range.from).toBe("2025-08-08");
    expect(range.to).toBe("2026-08-08");
    expect(range.start.toISOString()).toBe("2025-08-07T21:00:00.000Z");
    expect(range.end.toISOString()).toBe("2026-08-08T20:59:59.999Z");
  });

  it("provides the Documents presets through the shared date-range resolver", () => {
    expect(resolveDateRange({ preset: "last_week", now: NOW })).toMatchObject({
      preset: "last_week",
      from: "2026-08-03",
      to: "2026-08-09",
    });
    expect(resolveDateRange({ preset: "this_month", now: NOW })).toMatchObject({
      from: "2026-08-01",
      to: "2026-08-31",
    });
    expect(resolveDateRange({ preset: "last_month", now: NOW })).toMatchObject({
      preset: "last_month",
      from: "2026-07-01",
      to: "2026-07-31",
    });
    expect(resolveDateRange({ preset: "last_year", now: NOW })).toMatchObject({
      preset: "last_year",
      from: "2025-08-15",
      to: "2026-08-15",
    });
  });

  it("uses the clinic date and clamps leap day in the prior non-leap year", () => {
    // 22:30 UTC is already the next clinic-local date (UTC+3 in Istanbul).
    const clinicBoundary = resolveRollingYearRange(new Date("2026-08-07T22:30:00.000Z"));
    expect(clinicBoundary.from).toBe("2025-08-08");
    expect(clinicBoundary.to).toBe("2026-08-08");

    const leapDay = resolveRollingYearRange(new Date("2024-02-29T10:00:00.000Z"));
    expect(leapDay.from).toBe("2023-02-28");
    expect(leapDay.to).toBe("2024-02-29");
  });

  it("routes every Last year consumer through the shared rolling resolver", () => {
    const revenuePage = readFileSync(
      join(process.cwd(), "app/(protected)/revenue/page.tsx"),
      "utf8",
    );
    const patientFileData = readFileSync(
      join(process.cwd(), "lib/patients/file-data.ts"),
      "utf8",
    );

    expect(revenuePage).toContain("case \"last_year\":");
    expect(revenuePage).toContain("return resolveRollingYearRange(now)");
    expect(patientFileData).toContain("const range = resolveRollingYearRange(now)");
  });

  it("propagates the follow-up outcome filter into the analytical document params", () => {
    const parsed = analyticalDocumentParamsSchema.safeParse({
      documentType: "FOLLOW_UP_PAGE_REPORT",
      from: "2026-07-01",
      to: "2026-07-31",
      outcome: "has_problem",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.outcome).toBe("has_problem");

    // Omitting outcome remains valid (all non-follow-up reports).
    expect(analyticalDocumentParamsSchema.safeParse({
      documentType: "CANCELLATION_REPORT",
      from: "2026-07-01",
      to: "2026-07-31",
    }).success).toBe(true);

    // An unknown outcome value is rejected.
    expect(analyticalDocumentParamsSchema.safeParse({
      documentType: "FOLLOW_UP_PAGE_REPORT",
      from: "2026-07-01",
      to: "2026-07-31",
      outcome: "bogus",
    }).success).toBe(false);
  });
});
