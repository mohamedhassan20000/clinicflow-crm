import { describe, expect, it } from "vitest";
import {
  normalizeMyRevenueSummary,
  normalizeRevenueSummary,
} from "@/lib/reports/data";

describe("insurance reporting accounting", () => {
  it("preserves gross allocation while excluding insurance from patient collected", () => {
    const result = normalizeRevenueSummary({
      totalAmount: 1000,
      primaryTotal: 500,
      secondaryTotal: 100,
      insuranceTotal: 250,
      depositTotal: 50,
      settlementsTotal: 25,
      outstandingTotal: 75,
      grossTotal: 925,
      methodBreakdown: [
        { method: "cash", amount: 600 },
        { method: "insurance", amount: 250 },
      ],
    });

    expect(result.grossTotal).toBe(925);
    expect(result.insuranceTotal).toBe(250);
    expect(result.patientCollectedTotal).toBe(675);
    expect(result.methodBreakdown).toEqual([{ method: "cash", amount: 600 }]);
  });

  it("keeps self-scoped patient collection free of insurance", () => {
    const result = normalizeMyRevenueSummary({
      totalAmount: 1000,
      primaryTotal: 500,
      secondaryTotal: 100,
      insuranceTotal: 350,
      depositTotal: 50,
      outstandingTotal: 0,
      grossTotal: 1000,
    });

    expect(result.grossTotal).toBe(1000);
    expect(result.patientCollectedTotal).toBe(650);
  });
});
