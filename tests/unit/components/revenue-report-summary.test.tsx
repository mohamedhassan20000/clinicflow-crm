import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  RevenueReport,
  type SettlementRow,
  type RevenueSummary,
  type RevenueRow,
} from "@/components/revenue/revenue-report";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams("page=1"),
}));

const summary: RevenueSummary = {
  totalAmount: 2000,
  primaryTotal: 1000,
  secondaryTotal: 250,
  insuranceTotal: 300,
  depositTotal: 150,
  outstandingTotal: 75,
  settlementsTotal: 125,
  grossTotal: 1825,
  transactionCount: 75,
  settlementCount: 3,
  methodBreakdown: [
    { method: "cash", amount: 1100 },
    { method: "credit_card", amount: 25 },
  ],
};

const visibleRows: RevenueRow[] = [
  {
    id: "appt-1",
    scheduled_at: "2026-05-10T09:00:00.000Z",
    paid_at: "2026-05-10T10:00:00.000Z",
    total_amount: 10,
    paid_amount: 10,
    insurance_amount: 0,
    secondary_amount: 0,
    deposit_amount: 0,
    outstanding_amount: 0,
    payment_method: "cash",
    secondary_payment_method: null,
    payment_note: null,
    patients: { full_name: "Visible Patient" },
    profiles: { full_name: "Dr Sara Emad" },
    departments: { name: "Cardiology", color: "#0891b2" },
    insurance_providers: null,
  },
];

const visibleSettlement: SettlementRow = {
  id: "settlement-1",
  settled_at: "2026-05-11T10:00:00.000Z",
  amount: 125,
  payment_method: "cash",
  note: null,
  patient: { full_name: "Visible Patient" },
  appointment: {
    id: "appt-0",
    scheduled_at: "2026-05-01T10:00:00.000Z",
    total_amount: 500,
    outstanding_amount: 0,
    profiles: { full_name: "Dr Sara Emad" },
    departments: { name: "Cardiology", color: "#0891b2" },
  },
};

function renderReport(
  overrides: Partial<RevenueSummary> = {},
  settlements: SettlementRow[] = [],
) {
  return render(
    <RevenueReport
      rows={visibleRows}
      settlements={settlements}
      summary={{ ...summary, ...overrides }}
      page={1}
      pageSize={50}
      settlementDetailLimit={50}
      range={{
        start: "2026-05-01T00:00:00.000Z",
        end: "2026-05-31T23:59:59.999Z",
      }}
      preset="this_month"
      fromInput="2026-05-01"
      toInput="2026-05-31"
      clinicName="ClinicFlow"
      clinicAddress={null}
      clinicPhone={null}
    />,
  );
}

describe("RevenueReport summary totals", () => {
  it("renders full summary totals instead of only the paginated visible row", () => {
    const { container } = renderReport();

    expect(screen.getByText("Visible Patient")).toBeInTheDocument();
    expect(container.textContent).toContain("1,825.00");
    expect(container.textContent).toContain("2,000.00");
    expect(container.textContent).toContain("Showing 1–50 of 75");
  });

  it("shows settlement overflow copy when only a capped settlement detail list is loaded", () => {
    const { container } = renderReport({ settlementCount: 80 }, [visibleSettlement]);

    expect(container.textContent).toContain("80 payment");
    expect(container.textContent).toContain("Totals include all matching settlements");
  });
});
