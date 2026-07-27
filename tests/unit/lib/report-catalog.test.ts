import { describe, expect, it } from "vitest";
import { CLINIC_REPORT_IDS } from "@/lib/ai/clinic-reports";
import { PERMISSION_USER_ROLES } from "@/lib/page-permissions";
import {
  REPORT_CATALOG,
  REPORT_CATALOG_LIST,
  isReportId,
  reportDefaultVisibleForRole,
  reportsOpenableByRole,
} from "@/lib/reports/catalog";

describe("report catalog — single source of truth", () => {
  it("covers every clinic report id, in the same order", () => {
    // Metadata-driven: a new report added to CLINIC_REPORT_IDS must have a
    // catalog entry, or discovery/Customize/reset would silently skip it.
    expect(REPORT_CATALOG_LIST.map((entry) => entry.id)).toEqual([
      ...CLINIC_REPORT_IDS,
    ]);
    for (const id of CLINIC_REPORT_IDS) {
      expect(REPORT_CATALOG[id]).toBeDefined();
      expect(REPORT_CATALOG[id].id).toBe(id);
    }
  });

  it("declares a default visibility for every role on every report", () => {
    for (const entry of REPORT_CATALOG_LIST) {
      for (const role of PERMISSION_USER_ROLES) {
        expect(entry.defaultVisibilityByRole[role]).toBeTypeOf("boolean");
      }
    }
  });

  it("keeps pageRoles and reportsOpenableByRole in agreement", () => {
    for (const role of PERMISSION_USER_ROLES) {
      const openable = reportsOpenableByRole(role);
      for (const entry of REPORT_CATALOG_LIST) {
        expect(openable.includes(entry.id)).toBe(entry.pageRoles.includes(role));
      }
    }
  });

  it("encodes the ClinicFlow product defaults", () => {
    // Doctors & assistants never get clinic-wide financial/administrative
    // reports by default.
    for (const role of ["doctor", "assistant"] as const) {
      expect(reportDefaultVisibleForRole("revenue", role)).toBe(false);
      expect(reportDefaultVisibleForRole("doctor_performance", role)).toBe(false);
      expect(reportDefaultVisibleForRole("receptionist_performance", role)).toBe(
        false,
      );
      // Operational self-scoped reports default on.
      expect(reportDefaultVisibleForRole("cancellations", role)).toBe(true);
      expect(reportDefaultVisibleForRole("no_shows", role)).toBe(true);
      expect(reportDefaultVisibleForRole("followups", role)).toBe(true);
    }
    // Receptionist keeps the revenue report on by default (unchanged behavior).
    expect(reportDefaultVisibleForRole("revenue", "receptionist")).toBe(true);
    expect(reportDefaultVisibleForRole("doctor_performance", "receptionist")).toBe(
      false,
    );
    // Admin & manager see every report they may open by default. `my_revenue`
    // is doctor/assistant-only and is not in their openable set, so it is
    // deliberately excluded from this "see everything" expectation.
    for (const role of ["admin", "manager"] as const) {
      const openable = new Set(reportsOpenableByRole(role));
      for (const entry of REPORT_CATALOG_LIST) {
        if (!openable.has(entry.id)) continue;
        expect(reportDefaultVisibleForRole(entry.id, role)).toBe(true);
      }
    }
  });

  it("registers My Revenue as an opt-in, doctor/assistant-only financial report", () => {
    const entry = REPORT_CATALOG.my_revenue;
    // Doctor-oriented: admins/managers use the clinic-wide revenue report.
    expect([...entry.pageRoles].sort()).toEqual(["assistant", "doctor"]);
    expect(entry.financial).toBe(true);
    expect(entry.administrative).toBe(false);
    // Default OFF for everyone — opt-in only.
    for (const role of PERMISSION_USER_ROLES) {
      expect(reportDefaultVisibleForRole("my_revenue", role)).toBe(false);
    }
    // Openable only by doctor and assistant.
    for (const role of PERMISSION_USER_ROLES) {
      const openable = reportsOpenableByRole(role);
      const canOpen = role === "doctor" || role === "assistant";
      expect(openable.includes("my_revenue")).toBe(canOpen);
    }
  });

  it("registers My Performance as an opt-in, doctor-only operational report", () => {
    const entry = REPORT_CATALOG.my_performance;
    // Doctor's own performance: never admin/manager (they use the clinic-wide
    // doctor_performance report) and never assistant.
    expect([...entry.pageRoles]).toEqual(["doctor"]);
    // Self-scoped operational KPIs, not clinic-wide money or staff rankings.
    expect(entry.financial).toBe(false);
    expect(entry.administrative).toBe(false);
    // Default OFF for everyone — opt-in only.
    for (const role of PERMISSION_USER_ROLES) {
      expect(reportDefaultVisibleForRole("my_performance", role)).toBe(false);
    }
    // Openable only by doctors.
    for (const role of PERMISSION_USER_ROLES) {
      const openable = reportsOpenableByRole(role);
      expect(openable.includes("my_performance")).toBe(role === "doctor");
    }
  });

  it("recognizes only catalog report ids", () => {
    expect(isReportId("revenue")).toBe(true);
    expect(isReportId("not_a_report")).toBe(false);
  });
});
