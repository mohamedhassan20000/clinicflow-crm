import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/20260729150000_appointment_insurance_allocations.sql",
  ),
  "utf8",
).toLowerCase();

describe("appointment insurance allocation migration", () => {
  it("extends the existing insurance amount instead of creating a second amount model", () => {
    expect(sql).toContain("insurance_calculation_mode");
    expect(sql).toContain("insurance_percentage");
    expect(sql).toContain("patient_responsibility");
    expect(sql).not.toContain("insurance_contribution_amount");
  });

  it("validates percentage reconciliation and patient payments in both completion RPCs", () => {
    expect(sql.match(/create or replace function public\.complete_appointment_billing\(/g)).toHaveLength(1);
    expect(sql).toContain("insurance amount does not match percentage");
    expect(sql).toContain("patient payments exceed patient responsibility");
    expect(sql).toContain("insurance is not a patient payment method");
    expect(sql).toContain(
      "create or replace function public.complete_appointment_billing_with_previous_settlement",
    );
  });

  it("uses valid three-argument transaction-local set_config calls", () => {
    expect(sql).not.toContain(
      "'clinic_crm.insurance_calculation_mode',\n    'clinic_crm.insurance_calculation_mode'",
    );
    expect(sql.match(/perform set_config\(/g)).toHaveLength(16);
  });

  it("moves historical insurance payment methods into insurance_amount without changing gross allocation", () => {
    expect(sql).toContain("when payment_method = 'insurance'");
    expect(sql).toContain("when secondary_payment_method = 'insurance'");
    expect(sql).toContain("set insurance_amount = round(");
    expect(sql).toContain("payment_method = case");
  });

  it("clears insurance metadata whenever billing total is undone", () => {
    expect(sql).toContain("if new.total_amount is null then");
    expect(sql).toContain("new.insurance_calculation_mode := 'amount'");
    expect(sql).toContain("new.insurance_percentage := null");
    expect(sql).toContain("new.patient_responsibility := null");
  });

  it("enriches the existing semantic activity event rather than replacing its action", () => {
    expect(sql).toContain("augment_appointment_activity_financial_state");
    expect(sql).toContain("clinic_crm.insurance_appointment_id");
    expect(sql).toContain("keeps\n  -- completion to one appointment update");
    expect(sql).toContain("'insurance_amount', old.insurance_amount");
    expect(sql).toContain(
      "'insurance_calculation_mode', old.insurance_calculation_mode",
    );
    expect(sql).not.toContain("set insurance_calculation_mode = p_insurance_calculation_mode");
    expect(sql).not.toContain("appointment.billing_completion_undone'::");
  });
});
