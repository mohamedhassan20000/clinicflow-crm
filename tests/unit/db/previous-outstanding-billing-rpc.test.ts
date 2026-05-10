import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/20260510120000_previous_outstanding_billing_rpc.sql",
  ),
  "utf8",
);

const normalized = migration.replace(/\s+/g, " ");

describe("previous outstanding billing RPC migration", () => {
  it("adds nullable settlement provenance without changing legacy rows", () => {
    expect(migration).toContain(
      "add column if not exists source_appointment_id uuid",
    );
    expect(migration).toContain(
      "where source_appointment_id is not null",
    );
    expect(migration).not.toMatch(
      /source_appointment_id[\s\S]{0,120}references public\.appointments/i,
    );
  });

  it("creates an opt-in RPC instead of replacing existing billing RPC behavior", () => {
    expect(migration).toContain(
      "create or replace function public.complete_appointment_billing_with_previous_settlement",
    );
    expect(migration).not.toContain(
      "create or replace function public.complete_appointment_billing(",
    );
    expect(migration).not.toContain(
      "create or replace function public.settle_patient_outstanding(",
    );
  });

  it("rejects negative and excessive previous settlement amounts", () => {
    expect(normalized).toContain("if v_previous_payment < 0 then");
    expect(normalized).toContain(
      "raise exception 'Previous settlement amount cannot be negative'",
    );
    expect(normalized).toContain(
      "if v_previous_payment > v_previous_before + 0.001 then",
    );
    expect(normalized).toContain(
      "raise exception 'Previous settlement exceeds previous outstanding balance'",
    );
  });

  it("calculates previous outstanding from same patient and excludes the current appointment", () => {
    expect(normalized).toContain("where patient_id = v_appt.patient_id");
    expect(normalized).toContain("and clinic_id = v_clinic_id");
    expect(normalized).toContain("and id <> p_appointment_id");
    expect(normalized).toContain("and deleted_at is null");
    expect(normalized).toContain("and outstanding_amount > 0");
  });

  it("allocates previous settlement oldest-first to prior appointments", () => {
    expect(normalized).toContain("order by scheduled_at asc for update");
    expect(normalized).toContain(
      "v_apply := round(least(v_debt.outstanding_amount, v_previous_remaining), 2)",
    );
    expect(normalized).toContain(
      "set outstanding_amount = round(greatest(0, v_debt.outstanding_amount - v_apply), 2)",
    );
    expect(normalized).toContain(
      "v_affected := array_append(v_affected, v_debt.id)",
    );
  });

  it("records previous settlement rows separately from current invoice line items", () => {
    const serviceInsertStart = normalized.indexOf(
      "insert into public.appointment_services ( appointment_id, clinic_id, service_id, name, price, quantity )",
    );
    const serviceInsertEnd = normalized.indexOf("end loop;", serviceInsertStart);
    const appointmentServicesInsert = normalized.slice(
      serviceInsertStart,
      serviceInsertEnd,
    );

    expect(normalized).toContain(
      "insert into public.outstanding_settlements ( patient_id, appointment_id, source_appointment_id",
    );
    expect(normalized).toContain("v_debt.id, p_appointment_id");
    expect(normalized).toContain(
      "insert into public.appointment_services ( appointment_id, clinic_id, service_id, name, price, quantity )",
    );
    expect(appointmentServicesInsert).toContain("p_appointment_id");
    expect(appointmentServicesInsert).not.toContain("v_previous");
    expect(appointmentServicesInsert).not.toContain("v_debt");
  });

  it("returns a financial summary for later server action and UI integration", () => {
    expect(normalized).toContain("current_total numeric");
    expect(normalized).toContain("current_collected numeric");
    expect(normalized).toContain("current_outstanding numeric");
    expect(normalized).toContain("previous_outstanding_before numeric");
    expect(normalized).toContain("previous_settled_now numeric");
    expect(normalized).toContain("previous_outstanding_after numeric");
    expect(normalized).toContain("affected_prior_appointment_ids uuid[]");
  });
});
