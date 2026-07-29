import { describe, expect, it } from "vitest";
import {
  calculateInsuranceAmount,
  calculatePatientResponsibility,
  calculateRemainingPatientPayment,
} from "@/lib/billing/appointment-allocation";

describe("appointment insurance allocation", () => {
  it("rounds percentage coverage with the existing two-decimal billing rule", () => {
    expect(
      calculateInsuranceAmount({
        invoiceTotal: 999.99,
        mode: "percentage",
        amount: 0,
        percentage: 15,
      }),
    ).toBe(150);
  });

  it("supports zero and full coverage", () => {
    expect(
      calculateInsuranceAmount({
        invoiceTotal: 1000,
        mode: "percentage",
        amount: 0,
        percentage: 0,
      }),
    ).toBe(0);
    expect(
      calculateInsuranceAmount({
        invoiceTotal: 1000,
        mode: "percentage",
        amount: 0,
        percentage: 100,
      }),
    ).toBe(1000);
  });

  it("derives patient responsibility from the final insurance amount", () => {
    expect(calculatePatientResponsibility(1000, 300)).toBe(700);
  });

  it("rounds a patient payment remainder and never returns a negative amount", () => {
    expect(calculateRemainingPatientPayment(4930, 2800, 0)).toBe(2130);
    expect(calculateRemainingPatientPayment(10.005, 0, 0)).toBe(10.01);
    expect(calculateRemainingPatientPayment(100, 90, 20)).toBe(0);
  });
});
