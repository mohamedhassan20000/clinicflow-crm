import { describe, expect, it } from "vitest";
import { operatorReportRegistry, operatorReports } from "@/lib/operator-reports/registry";
import {
  clearedReportSearchParams,
  parseReportParams,
  reportParamsToSearchParams,
} from "@/lib/operator-reports/types";

const now = new Date("2026-07-13T12:00:00.000Z");

function report(id: string) {
  return operatorReportRegistry.get(id)!;
}

describe("Pre-P2 WS7 report filter contracts", () => {
  it("declares the approved report-specific matrix without universal noise", () => {
    expect(Object.fromEntries(operatorReports.map((item) => [
      item.id,
      item.filters.map((filter) => filter.key),
    ]))).toEqual({
      clinics: ["country", "onboarding", "createdFrom", "createdTo"],
      users: ["clinic", "signupFrom", "signupTo"],
      invitations: ["status", "clinic", "createdFrom", "createdTo", "emailSent"],
      revenue: ["plan", "status", "renewalFrom", "renewalTo"],
      subscriptions: ["status", "provider", "plan", "trialFrom", "trialTo"],
      activity: ["action", "targetType", "createdFrom", "createdTo"],
      growth: ["monthFrom", "monthTo"],
    });
    for (const item of operatorReports) {
      expect(item.filters.map((filter) => filter.key)).not.toContain("usageMetric");
      expect(item.filters.map((filter) => filter.key)).not.toContain("featureEntitlement");
    }
  });

  it("applies the documented rolling defaults", () => {
    expect(parseReportParams(report("clinics"), {}, now)).toMatchObject({
      filters: { country: "all", onboarding: "all", createdFrom: "2026-04-15", createdTo: "2026-07-13" },
      sort: "created_at",
      direction: "desc",
      page: 1,
      pageSize: 25,
    });
    expect(parseReportParams(report("invitations"), {}, now).filters).toMatchObject({
      status: "pending",
      createdFrom: "2026-06-14",
      createdTo: "2026-07-13",
    });
    expect(parseReportParams(report("revenue"), {}, now).filters.status).toBe("live");
    expect(parseReportParams(report("activity"), {}, now).filters).toMatchObject({
      createdFrom: "2026-07-07",
      createdTo: "2026-07-13",
    });
    expect(parseReportParams(report("growth"), {}, now).filters).toEqual({
      monthFrom: "2025-08",
      monthTo: "2026-07",
    });
  });

  it("falls back safely for malformed filters, sorting, and pagination", () => {
    const parsed = parseReportParams(report("clinics"), {
      country: "../../patients",
      onboarding: "broken",
      createdFrom: "not-a-date",
      createdTo: "2026-99-99",
      sort: "drop_table",
      dir: "sideways",
      page: "-40",
      pageSize: "100000",
    }, now);
    expect(parsed).toMatchObject({
      filters: { country: "all", onboarding: "all", createdFrom: "2026-04-15", createdTo: "2026-07-13" },
      sort: "created_at",
      direction: "desc",
      page: 1,
      pageSize: 25,
    });
  });

  it("keeps malformed Invitations URL state out of the database query", () => {
    expect(parseReportParams(report("invitations"), {
      status: ["not-a-status", "accepted"],
      clinic: "not-a-uuid",
      createdFrom: "2026-02-31",
      createdTo: "yesterday",
      emailSent: "sometimes",
      sort: "email",
      dir: "sideways",
      page: "0",
      pageSize: "5000",
    }, now)).toMatchObject({
      filters: {
        status: "pending",
        clinic: "all",
        createdFrom: "2026-06-14",
        createdTo: "2026-07-13",
        emailSent: "all",
      },
      sort: "created_at",
      direction: "desc",
      page: 1,
      pageSize: 25,
    });
  });

  it("resets inverted ranges and constrains a trial-ending window to trialing", () => {
    expect(parseReportParams(report("activity"), {
      createdFrom: "2026-07-13",
      createdTo: "2026-07-01",
    }, now).filters).toMatchObject({ createdFrom: "2026-07-07", createdTo: "2026-07-13" });

    expect(parseReportParams(report("subscriptions"), {
      status: "active",
      trialFrom: "2026-07-01",
      trialTo: "2026-07-31",
    }, now).filters.status).toBe("trialing");
  });

  it("treats explicit empty range parameters as shareable all-time state", () => {
    const parsed = parseReportParams(report("clinics"), {
      country: "all",
      onboarding: "all",
      createdFrom: "",
      createdTo: "",
    }, now);
    expect(parsed.filters.createdFrom).toBe("");
    expect(parsed.filters.createdTo).toBe("");
    const serialized = reportParamsToSearchParams(report("clinics"), parsed);
    expect(serialized.has("createdFrom")).toBe(true);
    expect(serialized.get("createdFrom")).toBe("");
    expect(parseReportParams(report("clinics"), Object.fromEntries(serialized), now)).toEqual(parsed);
  });

  it("round-trips active URL state and preserves sorting within filters", () => {
    const parsed = parseReportParams(report("users"), {
      clinic: "42ea1bf2-8078-44a4-b499-b84dd4585320",
      signupFrom: "2026-01-01",
      signupTo: "2026-06-30",
      sort: "latest_signup",
      dir: "asc",
      page: "3",
      pageSize: "50",
    }, now);
    const url = reportParamsToSearchParams(report("users"), parsed);
    expect(Object.fromEntries(url)).toMatchObject({
      clinic: "42ea1bf2-8078-44a4-b499-b84dd4585320",
      signupFrom: "2026-01-01",
      signupTo: "2026-06-30",
      sort: "latest_signup",
      dir: "asc",
      page: "3",
      pageSize: "50",
    });
    expect(parseReportParams(report("users"), Object.fromEntries(url), now)).toEqual(parsed);
  });

  it("builds a real clear-filter URL instead of silently restoring date defaults", () => {
    expect(Object.fromEntries(clearedReportSearchParams(report("invitations")))).toEqual({
      status: "all",
      clinic: "all",
      createdFrom: "",
      createdTo: "",
      emailSent: "all",
      sort: "created_at",
      dir: "desc",
      pageSize: "25",
      page: "1",
    });
  });
});
