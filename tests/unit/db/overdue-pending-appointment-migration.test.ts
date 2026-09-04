import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  "supabase/migrations/20260907121000_overdue_pending_no_show_transition.sql",
  "utf8",
).toLowerCase();

describe("overdue-pending appointment migration", () => {
  it("keeps overdue derived and gates pending no-show by scheduled end", () => {
    expect(sql).toContain("old.status = 'pending'");
    expect(sql).toContain("new.status = 'no_show'");
    expect(sql).toContain("old.scheduled_at + pg_catalog.make_interval");
    expect(sql).toContain("old.replaced_by_appointment_id is null");
    expect(sql).not.toContain("add value 'overdue_pending'");
    expect(sql).not.toMatch(/\bcreate\s+(or\s+replace\s+)?function[^;]*cron/i);
  });

  it("reuses atomic replacement while requiring a future replacement", () => {
    expect(sql).toContain("create or replace function public.replace_appointment");
    expect(sql).toContain("v_original_overdue_pending");
    expect(sql).toContain("p_scheduled_at <= pg_catalog.now()");
    expect(sql).toContain("replaced_by_appointment_id = v_new_id");
  });
});
