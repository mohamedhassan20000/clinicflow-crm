import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function migration(name: string) {
  return readFileSync(resolve(process.cwd(), "supabase/migrations", name), "utf8");
}

const sql = migration("20260727160000_p8b_my_performance_rpc.sql");

describe("Phase 8B — My Performance RPC migration", () => {
  it("defines get_my_performance_summary as SECURITY INVOKER", () => {
    expect(sql).toContain("function public.get_my_performance_summary");
    expect(sql).toContain("security invoker");
  });

  it("hard-denies every role except doctor", () => {
    expect(sql).toContain("v_role <> 'doctor'::public.user_role");
    expect(sql).toContain("42501");
  });

  it("scopes to the caller's OWN sessions with an explicit doctor_id predicate", () => {
    // "My performance" is the appointments the caller is the treating doctor
    // for — not the broader doctor RLS scope (department / assigned patients).
    expect(sql).toContain("a.doctor_id = auth.uid()");
    expect(sql).toContain("a.deleted_at is null");
  });

  it("keeps `replaced` as its own reschedule KPI, out of the appointment denominator", () => {
    expect(sql).toContain(
      "count(*) filter (where status <> 'replaced'::public.appointment_status) as appointment_count",
    );
    expect(sql).toContain(
      "count(*) filter (where status = 'replaced'::public.appointment_status) as replaced_count",
    );
  });

  it("derives follow-up completion from the doctor's own completed appointments", () => {
    expect(sql).toContain("from public.follow_ups f");
    expect(sql).toContain("f.appointment_id = a.id");
    expect(sql).toContain("followupCompletionRate");
    expect(sql).toContain("overdueFollowups");
  });

  it("computes a completed-appointment trend vs the previous equal-length period", () => {
    expect(sql).toContain("v_prev_start timestamptz := p_start - v_span");
    expect(sql).toContain("previousCompletedCount");
    // Null (not a misleading 0%) when there is no prior baseline.
    expect(sql).toContain("case when p.prev_completed = 0 then null");
  });

  it("reads no financial/settlement tables (operational report only)", () => {
    expect(sql).not.toMatch(/(from|join)\s+public\.outstanding_settlements/i);
    // No payment aggregation — this is not a revenue report.
    expect(sql).not.toContain("paid_amount");
  });

  it("is executable only by authenticated/service roles", () => {
    expect(sql).toContain(
      "revoke all on function public.get_my_performance_summary(timestamptz, timestamptz)",
    );
    expect(sql).toContain("to authenticated, service_role");
  });
});
