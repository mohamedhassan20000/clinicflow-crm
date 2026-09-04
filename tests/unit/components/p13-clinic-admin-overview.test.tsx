/**
 * P13 — the clinic-admin dashboard overview.
 *
 * Two things matter here. First, the clinic sees its own numbers: the component
 * is handed the session's clinic id and passes it, unmodified, to the shared
 * metrics reader on an RLS client. Second, it degrades: a clinic whose plan has
 * no AI allowance, or an environment where the commercial tables are missing,
 * must still get its activity counts instead of an error page.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  getClinicMetrics: vi.fn(),
  getClinicAiCommercialUsage: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/analytics/clinic-metrics", () => ({ getClinicMetrics: mocks.getClinicMetrics }));
vi.mock("@/lib/ai/commercial", () => ({
  getClinicAiCommercialUsage: mocks.getClinicAiCommercialUsage,
}));

import { ClinicOverviewKpis } from "@/components/dashboard/clinic-overview-kpis";

const CLINIC = "55555555-5555-4555-8555-555555555555";
const RLS_CLIENT = { tag: "rls" };

function metrics(overrides: Record<string, unknown> = {}) {
  return {
    totals: {
      patients: 412,
      appointments: 1_305,
      documentsIssued: 88,
      invoicesIssued: 37,
      activeStaff: 9,
      departments: 4,
      insuranceCompanies: 6,
    },
    trend: {
      current: { patients: 22, appointments: 140, documentsIssued: 11, invoicesIssued: 5 },
      previous: { patients: 20, appointments: 100, documentsIssued: 0, invoicesIssued: 10 },
      change: { patients: 10, appointments: 40, documentsIssued: null, invoicesIssued: -50 },
    },
    window: {
      previousStart: "2026-07-01T00:00:00.000Z",
      currentStart: "2026-08-01T00:00:00.000Z",
      nextStart: "2026-09-01T00:00:00.000Z",
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createClient.mockResolvedValue(RLS_CLIENT);
  mocks.getClinicMetrics.mockResolvedValue(metrics());
  mocks.getClinicAiCommercialUsage.mockResolvedValue({
    managedAllowanceConfigured: true,
    usedPercent: 42,
    resetDate: "2026-09-01",
  });
});

describe("clinic-admin overview", () => {
  it("reads its own clinic through the RLS client", async () => {
    render(await ClinicOverviewKpis({ clinicId: CLINIC }));

    expect(mocks.createClient).toHaveBeenCalledTimes(1);
    expect(mocks.getClinicMetrics).toHaveBeenCalledWith(RLS_CLIENT, CLINIC);
    expect(mocks.getClinicAiCommercialUsage).toHaveBeenCalledWith(CLINIC);
  });

  it("renders every clinic-local KPI the dashboard promises", async () => {
    render(await ClinicOverviewKpis({ clinicId: CLINIC }));

    for (const [label, value] of [
      ["Patients", "412"],
      ["Appointments", "1,305"],
      ["Documents issued", "88"],
      ["Invoices issued", "37"],
      ["Staff", "9"],
      ["Departments", "4"],
      ["Insurance companies", "6"],
    ] as const) {
      const card = screen.getByText(label).closest("div.rounded-xl");
      expect(card, `${label} card is missing`).not.toBeNull();
      expect(within(card as HTMLElement).getByText(value)).toBeInTheDocument();
    }
  });

  it("shows the current-period figure and the month-over-month trend", async () => {
    render(await ClinicOverviewKpis({ clinicId: CLINIC }));

    expect(screen.getByText("22 this month")).toBeInTheDocument();
    expect(screen.getByText(/\+10% vs previous month/)).toBeInTheDocument();
    expect(screen.getByText(/-50% vs previous month/)).toBeInTheDocument();
  });

  it("omits the trend entirely when the previous month has no baseline", async () => {
    render(await ClinicOverviewKpis({ clinicId: CLINIC }));

    const card = screen.getByText("Documents issued").closest("div.rounded-xl") as HTMLElement;
    // 11 issued this month against a previous month of zero: no "+100%" fiction.
    expect(within(card).getByText("11 this month")).toBeInTheDocument();
    expect(within(card).queryByText(/vs previous month/)).not.toBeInTheDocument();
  });

  it("renders the AI allowance as a percentage with an accessible meter", async () => {
    render(await ClinicOverviewKpis({ clinicId: CLINIC }));

    expect(screen.getByText("42%")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "AI allowance used" })).toHaveAttribute(
      "aria-valuenow",
      "42",
    );
  });

  it("says the allowance is not configured rather than showing a false 0%", async () => {
    mocks.getClinicAiCommercialUsage.mockResolvedValue({
      managedAllowanceConfigured: false,
      usedPercent: 0,
      resetDate: "2026-09-01",
    });

    render(await ClinicOverviewKpis({ clinicId: CLINIC }));

    expect(screen.getByText("No included AI allowance configured")).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("still renders the activity counts when the AI usage read fails", async () => {
    mocks.getClinicAiCommercialUsage.mockRejectedValue(new Error("column does not exist"));

    render(await ClinicOverviewKpis({ clinicId: CLINIC }));

    expect(screen.getByText("412")).toBeInTheDocument();
    expect(screen.getByText("No included AI allowance configured")).toBeInTheDocument();
  });

  it("shows no platform commercial control to the clinic", async () => {
    const { container } = render(await ClinicOverviewKpis({ clinicId: CLINIC }));

    expect(container.textContent).not.toMatch(/override|allowance source|plan default|micros|\$/i);
    expect(container.querySelector("form")).toBeNull();
  });
});

describe("clinic-admin dashboard placement", () => {
  const page = readFileSync(
    join(process.cwd(), "app/(protected)/dashboard/page.tsx"),
    "utf8",
  );

  it("renders the overview exactly once", () => {
    expect(page.match(/<ClinicOverviewKpis\b/g)).toHaveLength(1);
  });

  it("places the overview last, after the whole admin dashboard tree", () => {
    const admin = page.indexOf("<AdminDashboard");
    const overview = page.indexOf("<ClinicOverviewKpis");

    expect(admin).toBeGreaterThan(-1);
    expect(overview).toBeGreaterThan(admin);
  });
});
