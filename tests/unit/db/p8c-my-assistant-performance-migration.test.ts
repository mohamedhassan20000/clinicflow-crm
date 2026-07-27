import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function migration(name: string) {
  return readFileSync(resolve(process.cwd(), "supabase/migrations", name), "utf8");
}

const sql = migration("20260727170000_p8c_my_assistant_performance_rpc.sql");

describe("Phase 8C — My Assistant Performance RPC migration", () => {
  it("defines get_my_assistant_performance as SECURITY DEFINER", () => {
    // SECURITY DEFINER is required because the assignment table is not readable
    // by doctors under RLS; the RPC re-derives the caller and constrains every
    // read to their own clinic + doctor_id, so it can widen nothing.
    expect(sql).toContain("function public.get_my_assistant_performance");
    expect(sql).toContain("security definer");
    expect(sql).toContain("owner to postgres");
  });

  it("hard-denies every role except doctor", () => {
    expect(sql).toContain("v_role <> 'doctor'::public.user_role");
    expect(sql).toContain("42501");
  });

  it("lists only assistants assigned to the calling doctor", () => {
    expect(sql).toContain("from public.assistant_doctor_assignments a");
    expect(sql).toContain("where a.doctor_id = v_doctor");
    expect(sql).toContain("a.clinic_id = v_clinic_id");
    // Only active, non-deleted assistant profiles.
    expect(sql).toContain("p.role = 'assistant'::public.user_role");
    expect(sql).toContain("p.is_active = true");
  });

  it("scopes activity to the calling doctor's own entities (multi-assignment isolation)", () => {
    // The event's owning doctor must be the caller: activity the assistant
    // performed for a different doctor must never leak into this report.
    expect(sql).toContain("e.doctor_id = v_doctor");
    expect(sql).toContain("e.actor_id = a.assistant_id");
    expect(sql).toContain("e.clinic_id = v_clinic_id");
  });

  it("counts only factual actor-level actions, no composite score", () => {
    expect(sql).toContain("'appointment.confirmed'");
    expect(sql).toContain("'appointment.rescheduled'");
    expect(sql).toContain("'appointment.replaced'");
    expect(sql).toContain("'follow_up.recorded'");
    // No subjective/weighted score column is emitted from the counts.
    expect(sql).not.toMatch(/as\s+"?\w*score\w*"?/i);
  });

  it("reads no financial/settlement tables (operational report only)", () => {
    expect(sql).not.toMatch(/(from|join)\s+public\.outstanding_settlements/i);
    expect(sql).not.toContain("paid_amount");
  });

  it("is executable only by authenticated/service roles", () => {
    expect(sql).toContain(
      "revoke all on function public.get_my_assistant_performance(timestamptz, timestamptz)",
    );
    expect(sql).toContain("to authenticated, service_role");
  });
});
