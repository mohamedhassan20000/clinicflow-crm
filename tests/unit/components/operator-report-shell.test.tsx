import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ReportShell } from "@/components/operator/report-shell";
import { operatorReportRegistry } from "@/lib/operator-reports/registry";
import { parseReportParams } from "@/lib/operator-reports/types";

const now = new Date("2026-07-13T12:00:00.000Z");
const definition = operatorReportRegistry.get("clinics")!;
const params = parseReportParams(definition, {
  country: "KW",
  onboarding: "complete",
  createdFrom: "2026-01-01",
  createdTo: "2026-07-13",
  sort: "created_at",
  dir: "desc",
  page: "2",
  pageSize: "25",
}, now);

describe("Pre-P2 WS7 ReportShell", () => {
  it("renders URL-owned filters, accessible sort state, pagination, and filtered export", () => {
    render(
      <ReportShell
        definition={definition}
        params={params}
        filterOptions={{ country: [{ value: "all", label: "All" }, { value: "KW", label: "KW" }] }}
        result={{
          rows: [{ clinic_id: "clinic-26", name: "Clinic 26", country: "KW", onboarding: "Complete", created_at: "2026-07-01" }],
          total: 26,
          page: 2,
          pageSize: 25,
          totalPages: 2,
          hasAnyData: true,
        }}
      />,
    );

    expect(screen.getByRole("combobox", { name: "Country" })).toHaveTextContent("KW");
    expect(screen.getByRole("columnheader", { name: /Created/ })).toHaveAttribute("aria-sort", "descending");
    expect(screen.getByText("Showing 26–26 of 26")).toBeInTheDocument();
    expect(screen.getByText("Page 2 of 2")).toBeInTheDocument();

    const sortHref = screen.getByRole("link", { name: "Sort by Clinic ascending" }).getAttribute("href")!;
    const sortUrl = new URL(sortHref, "https://clinicflow.local");
    expect(sortUrl.searchParams.get("country")).toBe("KW");
    expect(sortUrl.searchParams.get("onboarding")).toBe("complete");
    expect(sortUrl.searchParams.get("sort")).toBe("name");
    expect(sortUrl.searchParams.get("page")).toBe("1");

    const exportHref = screen.getByRole("link", { name: /Export filtered CSV/ }).getAttribute("href")!;
    const exportUrl = new URL(exportHref, "https://clinicflow.local");
    expect(exportUrl.searchParams.get("country")).toBe("KW");
    expect(exportUrl.searchParams.get("createdFrom")).toBe("2026-01-01");
    expect(exportUrl.searchParams.has("page")).toBe(false);
    expect(exportUrl.searchParams.has("pageSize")).toBe(false);
  });

  it("distinguishes an empty platform from a filtered empty result", () => {
    const { rerender } = render(
      <ReportShell
        definition={definition}
        params={params}
        filterOptions={{ country: [{ value: "all", label: "All" }, { value: "KW", label: "KW" }] }}
        result={{ rows: [], total: 0, page: 1, pageSize: 25, totalPages: 1, hasAnyData: true }}
      />,
    );
    expect(screen.getByText("No rows match these filters")).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Clear filters" }).length).toBeGreaterThan(0);

    rerender(
      <ReportShell
        definition={definition}
        params={params}
        filterOptions={{ country: [{ value: "all", label: "All" }] }}
        result={{ rows: [], total: 0, page: 1, pageSize: 25, totalPages: 1, hasAnyData: false }}
      />,
    );
    expect(screen.getByText("No report data yet")).toBeInTheDocument();
  });
});
