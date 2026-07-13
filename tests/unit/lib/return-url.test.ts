import { describe, expect, it } from "vitest";
import {
  pathWithSearch,
  resolveReturnTo,
  withReturnTo,
} from "@/lib/navigation/return-url";

describe("return URL navigation", () => {
  it("preserves search, pagination, sorting, and date-range state", () => {
    const listUrl = pathWithSearch(
      "/patients",
      new URLSearchParams({
        name: "Ada Lovelace",
        page: "3",
        sort: "created_desc",
        from: "2026-07-01",
        to: "2026-07-13",
      }),
    );
    const detailUrl = withReturnTo("/patients/patient-1", listUrl);
    const encodedReturn = new URL(detailUrl, "https://clinicflow.local").searchParams.get("returnTo");

    expect(encodedReturn).toBe(listUrl);
    expect(resolveReturnTo(encodedReturn, "/patients", ["/patients"])).toBe(listUrl);
  });

  it("supports nested drill-down return URLs without losing the parent list", () => {
    const patientUrl = withReturnTo("/patients/patient-1", "/patients?name=Ada&page=2");
    const reportUrl = withReturnTo("/patients/patient-1/appointments-report", patientUrl);
    const reportReturn = new URL(reportUrl, "https://clinicflow.local").searchParams.get("returnTo");

    expect(resolveReturnTo(reportReturn, "/patients/patient-1", ["/patients/patient-1"])).toBe(patientUrl);
  });

  it.each([
    "https://example.com/operator/clinics",
    "//example.com/operator/clinics",
    "/operator/reports",
    "/operator/clinics/other",
  ])("rejects external or unauthorized return destination %s", (candidate) => {
    expect(resolveReturnTo(candidate, "/operator/clinics", ["/operator/clinics"])).toBe("/operator/clinics");
  });

  it("does not attach an invalid return URL", () => {
    expect(withReturnTo("/patients/patient-1", "https://example.com/patients")).toBe("/patients/patient-1");
  });
});
