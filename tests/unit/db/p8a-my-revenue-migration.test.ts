import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function migration(name: string) {
  return readFileSync(resolve(process.cwd(), "supabase/migrations", name), "utf8");
}

const sql = migration("20260727150000_p8a_my_revenue_rpc.sql");

describe("Phase 8A — My Revenue RPC migration", () => {
  it("defines get_my_revenue_summary as SECURITY INVOKER (RLS scopes the caller)", () => {
    expect(sql).toContain("function public.get_my_revenue_summary");
    expect(sql).toContain("security invoker");
  });

  it("hard-denies every role except doctor and assistant", () => {
    expect(sql).toContain(
      "v_role not in ('doctor'::public.user_role, 'assistant'::public.user_role)",
    );
    expect(sql).toContain("42501");
  });

  it("reads only the RLS-scoped appointments table — never clinic-wide settlements", () => {
    expect(sql).toContain("from public.appointments a");
    // The clinic-wide settlement table doctors/assistants cannot see must not be
    // read: no FROM/JOIN against it (the header comment may still name it to
    // explain why it is intentionally excluded).
    expect(sql).not.toMatch(/(from|join)\s+public\.outstanding_settlements/i);
  });

  it("applies no doctor_id predicate — the assistant aggregate is the supervised union", () => {
    // RLS already scopes rows; adding a doctor filter would narrow the union.
    expect(sql).not.toContain("p_doctor_id");
  });

  it("excludes settlements from the gross total", () => {
    expect(sql).not.toContain("settlementsTotal");
    expect(sql).not.toContain("settlement_scope");
  });

  it("scopes to completed, non-deleted, paid-in-range appointments", () => {
    expect(sql).toContain("a.status = 'completed'::public.appointment_status");
    expect(sql).toContain("a.deleted_at is null");
    expect(sql).toContain("a.paid_at >= p_start");
    expect(sql).toContain("a.paid_at <= p_end");
  });

  it("is executable only by authenticated/service roles", () => {
    expect(sql).toContain(
      "revoke all on function public.get_my_revenue_summary(timestamptz, timestamptz)",
    );
    expect(sql).toContain("to authenticated, service_role");
  });
});
