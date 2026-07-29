import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/20260729130000_fix_replacement_chain_billing_completion.sql",
  ),
  "utf8",
).toLowerCase();

describe("replacement-chain billing completion migration", () => {
  it("redefines both billing completion RPCs", () => {
    expect(sql).toContain(
      "create or replace function public.complete_appointment_billing(",
    );
    expect(sql).toContain(
      "create or replace function public.complete_appointment_billing_with_previous_settlement(",
    );
  });

  it("updates the appointment in place instead of deleting and reinserting it", () => {
    const basic = sql.slice(
      sql.indexOf(
        "create or replace function public.complete_appointment_billing(",
      ),
      sql.indexOf(
        "create or replace function public.complete_appointment_billing_with_previous_settlement(",
      ),
    );
    const previous = sql.slice(
      sql.indexOf(
        "create or replace function public.complete_appointment_billing_with_previous_settlement(",
      ),
      sql.indexOf(
        "revoke all on function public.complete_appointment_billing(",
      ),
    );

    for (const fn of [basic, previous]) {
      expect(fn).toContain("update public.appointments");
      expect(fn).toContain(
        "set status = 'completed'::public.appointment_status",
      );
      expect(fn).not.toContain("delete from public.appointments");
      expect(fn).not.toContain("insert into public.appointments");
      expect(fn).not.toContain(
        "clinic_crm.allow_appointment_delete_replacement",
      );
    }
  });

  it("keeps billing, service lines, and previous settlements in one database transaction", () => {
    expect(sql).toContain("delete from public.appointment_services");
    expect(sql).toContain("insert into public.appointment_services");
    expect(sql).toContain("insert into public.outstanding_settlements");
    expect(sql).toContain("for update");
  });

  it("makes replacement foreign keys deferred without destructive set-null cascades", () => {
    const constraints = sql.slice(
      sql.indexOf("alter table public.appointments"),
      sql.indexOf(
        "create or replace function public.complete_appointment_billing(",
      ),
    );
    for (const constraint of [
      "appointments_replaces_appointment_id_fkey",
      "appointments_replaced_by_appointment_id_fkey",
      "appointments_original_appointment_id_fkey",
    ]) {
      expect(constraints).toContain(`add constraint ${constraint}`);
    }
    expect(constraints.match(/deferrable initially deferred/g)).toHaveLength(3);
    expect(constraints).not.toContain("on delete set null");
  });

  it("retains the financial role allowlist and RPC grants", () => {
    expect(sql).toContain("'admin'::public.user_role");
    expect(sql).toContain("'receptionist'::public.user_role");
    expect(sql).toContain("'manager'::public.user_role");
    expect(sql).not.toContain("'assistant'::public.user_role");
    expect(sql).toContain("from public, anon");
    expect(sql).toContain("to authenticated, service_role");
  });
});
