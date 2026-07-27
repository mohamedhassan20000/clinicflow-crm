import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function migration(name: string) {
  return readFileSync(resolve(process.cwd(), "supabase/migrations", name), "utf8");
}

const enumSql = migration("20260727120000_assistant_role_enum.sql");
const assignSql = migration("20260727121000_assistant_doctor_assignments.sql");
const rlsSql = migration("20260727123000_assistant_scoped_rls.sql");
const rpcSql = migration("20260727124000_scope_aware_report_rpcs.sql");
const writeSql = migration("20260727127000_assistant_operational_writes.sql");

describe("assistant role + scope migrations", () => {
  it("adds the assistant enum value in its own migration", () => {
    expect(enumSql).toContain("add value if not exists 'assistant'");
  });

  it("creates the many-to-many assignment table and union-scope helper", () => {
    expect(assignSql).toContain("create table if not exists public.assistant_doctor_assignments");
    expect(assignSql).toContain("primary key (assistant_id, doctor_id)");
    expect(assignSql).toContain("function public.auth_supervised_doctor_ids()");
    expect(assignSql).toContain("security definer");
    // Fails closed: empty array for non-/unassigned assistants.
    expect(assignSql).toContain("array[]::uuid[]");
    expect(assignSql).toContain("a.assistant_id = auth.uid()");
  });

  it("scopes patients/appointments/follow_ups to the supervised doctor set only", () => {
    for (const table of ["patients", "appointments", "follow_ups"]) {
      expect(rlsSql).toContain(`on public.${table}`);
    }
    // Assistant branch is keyed on the helper, never department- or clinic-wide.
    expect(rlsSql).toContain("public.auth_role() = 'assistant'::public.user_role");
    expect(rlsSql).toContain("any (public.auth_supervised_doctor_ids())");
  });

  it("removes the blanket doctor deny from the operational report RPCs", () => {
    for (const fn of ["get_cancellation_report", "get_no_show_report"]) {
      expect(rpcSql).toContain(`function public.${fn}`);
    }
    // The old hard-deny is gone; RLS now scopes doctor/assistant callers.
    expect(rpcSql).not.toContain("if v_role = 'doctor'::public.user_role then");
    expect(rpcSql).toContain("security invoker");
  });

  it("grants assistants scoped insert/update on appointments & follow_ups, never delete", () => {
    expect(writeSql).toContain('create policy "appointments_write_staff"');
    expect(writeSql).toContain('create policy "appointments_update_staff"');
    expect(writeSql).toContain('create policy "follow_ups_staff_write"');
    expect(writeSql).toContain('create policy "follow_ups_staff_update"');
    // Assistant writes are gated on the supervised-doctor set (anti-spoof).
    expect(writeSql).toContain("public.auth_role() = 'assistant'::public.user_role");
    expect(writeSql).toContain("any (public.auth_supervised_doctor_ids())");
    // No delete policy is granted to assistants here.
    expect(writeSql).not.toContain("for delete");
  });
});
