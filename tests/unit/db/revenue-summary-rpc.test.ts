import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/20260511210000_revenue_summary_rpc.sql",
  ),
  "utf8",
);

describe("revenue summary RPC migration", () => {
  it("adds a security-invoker RPC so existing RLS remains in force", () => {
    expect(migration).toContain(
      "create or replace function public.get_revenue_summary",
    );
    expect(migration).toContain("security invoker");
    expect(migration).toContain("public.auth_clinic_id()");
    expect(migration).toContain("public.auth_role()");
    expect(migration).toContain("v_role = 'receptionist'::public.user_role");
  });

  it("matches current revenue total calculation buckets", () => {
    expect(migration).toContain("sum(total_amount)");
    expect(migration).toContain("sum(paid_amount)");
    expect(migration).toContain("sum(secondary_amount)");
    expect(migration).toContain("sum(insurance_amount)");
    expect(migration).toContain("sum(deposit_amount)");
    expect(migration).toContain("sum(outstanding_amount)");
    expect(migration).toContain("st.settlements_amount");
    expect(migration).toContain("'grossTotal'");
  });

  it("calculates payment method breakdown from primary, secondary, and settlements", () => {
    expect(migration).toContain("payment_method::text as method");
    expect(migration).toContain("secondary_payment_method::text as method");
    expect(migration).toContain("from settlement_scope");
    expect(migration).toContain("'methodBreakdown'");
  });

  it("filters settlement summaries by appointment doctor and department server-side", () => {
    expect(migration).toContain("left join public.appointments a on a.id = s.appointment_id");
    expect(migration).toContain("p_department_id is null or a.department_id = p_department_id");
    expect(migration).toContain("p_doctor_id is null or a.doctor_id = p_doctor_id");
  });
});
