import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadOperatorMessagingCostSource: vi.fn(),
  captureMessage: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@sentry/nextjs", () => ({
  captureMessage: mocks.captureMessage,
  captureException: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({
  loadOperatorMessagingCostSource: mocks.loadOperatorMessagingCostSource,
}));

import { runMessagingAlertScan } from "@/lib/ops/alert-scan";

const NOW = new Date("2026-07-28T06:00:00Z");

afterEach(() => {
  vi.clearAllMocks();
});

describe("P6B messaging alert scan", () => {
  it("dispatches a Sentry alert on a current-month delivery-failure spike", async () => {
    mocks.loadOperatorMessagingCostSource.mockResolvedValue({
      error: null,
      data: {
        clinics: [{ id: "clinic-a", name: "Clinic A" }],
        counters: [],
        outbound: [
          ...Array.from({ length: 70 }, (_, i) => ({
            clinic_id: "clinic-a",
            channel: "whatsapp",
            status: "delivered",
            cost_micro: 1000,
            created_at: `2026-07-${String((i % 27) + 1).padStart(2, "0")}T10:00:00Z`,
          })),
          ...Array.from({ length: 30 }, (_, i) => ({
            clinic_id: "clinic-a",
            channel: "whatsapp",
            status: "failed",
            cost_micro: 0,
            created_at: `2026-07-${String((i % 27) + 1).padStart(2, "0")}T11:00:00Z`,
          })),
        ],
        truncated: false,
      },
    });

    const result = await runMessagingAlertScan(NOW);
    expect(result.alerts.some((a) => a.kind === "delivery_failure_rate")).toBe(true);
    expect(mocks.captureMessage).toHaveBeenCalledWith(
      "ops-alert:delivery_failure_rate",
      expect.objectContaining({ level: "error" }),
    );
  });

  it("stays silent when everything is within threshold", async () => {
    mocks.loadOperatorMessagingCostSource.mockResolvedValue({
      error: null,
      data: {
        clinics: [{ id: "clinic-a", name: "Clinic A" }],
        counters: [],
        outbound: Array.from({ length: 100 }, (_, i) => ({
          clinic_id: "clinic-a",
          channel: "whatsapp",
          status: "delivered",
          cost_micro: 1000,
          created_at: `2026-07-${String((i % 27) + 1).padStart(2, "0")}T10:00:00Z`,
        })),
        truncated: false,
      },
    });

    const result = await runMessagingAlertScan(NOW);
    expect(result.alerts).toHaveLength(0);
    expect(mocks.captureMessage).not.toHaveBeenCalled();
    expect(result.scannedClinics).toBe(1);
  });

  it("throws when the source cannot load (surfaced to the cron)", async () => {
    mocks.loadOperatorMessagingCostSource.mockResolvedValue({
      error: { message: "boom" },
      data: null,
    });
    await expect(runMessagingAlertScan(NOW)).rejects.toThrow(/source/i);
  });

  it("requests a trailing window ending in the current month", async () => {
    mocks.loadOperatorMessagingCostSource.mockResolvedValue({
      error: null,
      data: { clinics: [], counters: [], outbound: [], truncated: false },
    });
    await runMessagingAlertScan(NOW);
    expect(mocks.loadOperatorMessagingCostSource).toHaveBeenCalledWith(
      expect.objectContaining({ periodFromMonth: "2026-04", periodToMonth: "2026-07" }),
    );
  });
});
