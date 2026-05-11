import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/20260511213000_followups_dashboard_rpc.sql",
  ),
  "utf8",
);

describe("follow-ups dashboard RPC migration", () => {
  it("adds a security-invoker RPC so existing RLS remains in force", () => {
    expect(migration).toContain(
      "create or replace function public.get_followups_dashboard",
    );
    expect(migration).toContain("security invoker");
    expect(migration).toContain("public.auth_clinic_id()");
    expect(migration).toContain("public.auth_role()");
    expect(migration).toContain("v_role = 'manager'::public.user_role");
  });

  it("uses a DB not-exists check for awaiting follow-ups", () => {
    expect(migration).toContain("not exists");
    expect(migration).toContain("from public.follow_ups f");
    expect(migration).toContain("f.appointment_id = a.id");
  });

  it("moves completed follow-up filters and pagination server-side", () => {
    expect(migration).toContain("p_outcome is null or f.outcome = p_outcome");
    expect(migration).toContain("p_department_id is null or a.department_id = p_department_id");
    expect(migration).toContain("p_doctor_id is null or a.doctor_id = p_doctor_id");
    expect(migration).toContain("limit greatest(0, p_done_limit)");
    expect(migration).toContain("offset greatest(0, p_done_offset)");
  });

  it("returns full summary counts separately from paginated rows", () => {
    expect(migration).toContain("'pendingCount', (select count(*) from pending_scope)");
    expect(migration).toContain("'completedCount', (select count(*) from done_scope)");
    expect(migration).toContain("'allFineCount'");
    expect(migration).toContain("'hasProblemCount'");
    expect(migration).toContain("'noResponseCount'");
  });
});
