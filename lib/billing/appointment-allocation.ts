export type InsuranceCalculationMode = "amount" | "percentage";

/** Matches the two-decimal rounding already used by appointment billing. */
export function roundBillingCurrency(value: number): number {
  return Number(value.toFixed(2));
}

export function calculateInsuranceAmount({
  invoiceTotal,
  mode,
  amount,
  percentage,
}: {
  invoiceTotal: number;
  mode: InsuranceCalculationMode;
  amount: number;
  percentage: number | null;
}): number {
  if (mode === "percentage") {
    return roundBillingCurrency(
      (invoiceTotal * Math.max(0, percentage ?? 0)) / 100,
    );
  }

  return roundBillingCurrency(Math.max(0, amount));
}

export function calculatePatientResponsibility(
  invoiceTotal: number,
  insuranceAmount: number,
): number {
  return roundBillingCurrency(
    Math.max(0, invoiceTotal - insuranceAmount),
  );
}

export function calculateRemainingPatientPayment(
  patientResponsibility: number,
  otherPatientPayment: number,
  depositAmount: number,
): number {
  return Math.max(
    0,
    roundBillingCurrency(
      patientResponsibility - otherPatientPayment - depositAmount,
    ),
  );
}
