import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/rbac", () => ({ requirePlatformAdmin: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

import { operatorReportRegistry, operatorReports } from "@/lib/operator-reports/registry";

describe("P1.5B operator report registry", () => {
  it("registers every launch report with the shared contract", () => {
    expect(operatorReports.map((report) => report.id)).toEqual([
      "clinics", "users", "invitations", "revenue", "subscriptions", "activity", "growth",
    ]);
    for (const report of operatorReports) {
      expect(operatorReportRegistry.get(report.id)).toBe(report);
      expect(report.columns.length).toBeGreaterThan(0);
      expect(typeof report.query).toBe("function");
      expect(typeof report.export).toBe("function");
    }
  });

  it("exports through the shared CSV path with escaping", () => {
    const report = operatorReportRegistry.get("clinics")!;
    const csv = report.export([{ name: 'Clinic "A", East', country: "KW", created_at: "2026-07-12" }]);
    expect(csv).toContain('"Clinic ""A"", East"');
    expect(csv.split("\n")).toHaveLength(2);
  });

  it("neutralizes spreadsheet formulas in tenant-controlled cells", () => {
    const report = operatorReportRegistry.get("clinics")!;
    expect(report.export([{ name: '=HYPERLINK("https://evil")', country: "KW", created_at: "2026" }])).toContain('"\'=HYPERLINK');
  });
});
