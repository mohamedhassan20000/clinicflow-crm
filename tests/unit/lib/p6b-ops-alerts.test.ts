import { describe, expect, it } from "vitest";
import {
  COST_ANOMALY_THRESHOLDS,
  DELIVERY_FAILURE_THRESHOLDS,
  deliveryFailureRate,
  evaluateClinicCostAnomalies,
  evaluateDeliveryFailureAlerts,
} from "@/lib/ops/alerts";

describe("P6B delivery-failure alerting", () => {
  it("fires on a simulated delivery-failure spike (acceptance)", () => {
    const alerts = evaluateDeliveryFailureAlerts([
      // 30% failure over 100 terminal sends → critical.
      { clinicId: "c1", clinicName: "Spiking Clinic", delivered: 70, failed: 30 },
    ]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      kind: "delivery_failure_rate",
      severity: "critical",
      clinicId: "c1",
    });
    expect(alerts[0]!.message).toContain("%");
  });

  it("raises a warning between the warning and critical thresholds", () => {
    const alerts = evaluateDeliveryFailureAlerts([
      { clinicId: "c2", clinicName: "Warn Clinic", delivered: 85, failed: 15 },
    ]);
    expect(alerts[0]!.severity).toBe("warning");
  });

  it("does not fire below the warning threshold", () => {
    const alerts = evaluateDeliveryFailureAlerts([
      { clinicId: "c3", clinicName: "Healthy Clinic", delivered: 98, failed: 2 },
    ]);
    expect(alerts).toHaveLength(0);
  });

  it("suppresses noise below the minimum sample size", () => {
    // 1/1 = 100% failure, but only 1 terminal send → not a spike.
    const alerts = evaluateDeliveryFailureAlerts([
      { clinicId: "c4", clinicName: "Tiny Sample", delivered: 0, failed: 1 },
    ]);
    expect(alerts).toHaveLength(0);
    expect(DELIVERY_FAILURE_THRESHOLDS.minSample).toBeGreaterThan(1);
  });

  it("treats an all-zero clinic as a 0% rate", () => {
    expect(deliveryFailureRate({ clinicId: "c", clinicName: "c", delivered: 0, failed: 0 })).toBe(0);
  });
});

describe("P6B per-clinic cost anomaly alerting", () => {
  it("fires when current spend exceeds the baseline multiplier", () => {
    const alerts = evaluateClinicCostAnomalies([
      // baseline $2, current $9 → 4.5× > 3× multiplier.
      { clinicId: "c1", clinicName: "Runaway", currentMicros: 9_000_000, baselineMicros: 2_000_000 },
    ]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: "clinic_cost_anomaly", severity: "warning", clinicId: "c1" });
  });

  it("does not fire on ordinary growth below the multiplier", () => {
    const alerts = evaluateClinicCostAnomalies([
      { clinicId: "c2", clinicName: "Growing", currentMicros: 4_000_000, baselineMicros: 2_000_000 },
    ]);
    expect(alerts).toHaveLength(0);
  });

  it("ignores tiny absolute spend even on a large multiple", () => {
    const alerts = evaluateClinicCostAnomalies([
      // 10× jump but only $0.50 current → below minCurrentMicros ($1).
      { clinicId: "c3", clinicName: "Trivial", currentMicros: 500_000, baselineMicros: 50_000 },
    ]);
    expect(alerts).toHaveLength(0);
  });

  it("raises critical on an absolute runaway even without a baseline", () => {
    const alerts = evaluateClinicCostAnomalies([
      { clinicId: "c4", clinicName: "No History", currentMicros: 150_000_000, baselineMicros: 0 },
    ]);
    expect(alerts[0]).toMatchObject({ severity: "critical", clinicId: "c4" });
    expect(COST_ANOMALY_THRESHOLDS.absoluteCriticalMicros).toBe(100_000_000);
  });

  it("cannot compute a relative spike without a baseline", () => {
    const alerts = evaluateClinicCostAnomalies([
      { clinicId: "c5", clinicName: "First Month", currentMicros: 5_000_000, baselineMicros: 0 },
    ]);
    expect(alerts).toHaveLength(0);
  });
});
