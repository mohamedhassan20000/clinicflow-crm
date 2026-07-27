import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function migration(name: string) {
  return readFileSync(resolve(process.cwd(), "supabase/migrations", name), "utf8");
}

const authSql = migration("20260727125000_manager_operational_authorization.sql");
const rpcSql = migration("20260727126000_manager_appointment_lifecycle_rpcs.sql");

describe("manager operational authorization migration", () => {
  it("adds manager to appointment insert/update policies", () => {
    expect(authSql).toContain('create policy "appointments_write_staff"');
    expect(authSql).toContain('create policy "appointments_update_staff"');
    // Both operational policies now include the manager role.
    const managerCount = (authSql.match(/'manager'::public\.user_role/g) ?? [])
      .length;
    expect(managerCount).toBeGreaterThanOrEqual(4);
  });

  it("adds manager to follow_ups insert/update/delete policies", () => {
    for (const policy of [
      "follow_ups_staff_write",
      "follow_ups_staff_update",
      "follow_ups_staff_delete",
    ]) {
      expect(authSql).toContain(`create policy "${policy}"`);
    }
  });

  it("removes the manager deny from get_followups_dashboard", () => {
    expect(authSql).toContain("function public.get_followups_dashboard");
    expect(authSql).not.toContain("if v_role = 'manager'::public.user_role then");
  });

  it("does not grant managers appointment delete (admin-only preserved)", () => {
    expect(authSql).not.toContain("appointments_delete");
  });

  it("extends appointment-lifecycle RPC guards to managers only (not deletes)", () => {
    for (const fn of [
      "undo_appointment_status",
      "complete_appointment_billing",
      "undo_appointment_billing",
    ]) {
      expect(rpcSql).toContain(`function public.${fn}`);
    }
    // Every reproduced guard now admits manager.
    expect(rpcSql).toContain(
      "array['admin'::public.user_role, 'receptionist'::public.user_role, 'manager'::public.user_role]",
    );
    // Standalone patient-balance settlement is intentionally NOT widened here.
    expect(rpcSql).not.toContain("function public.settle_patient_outstanding");
  });
});
