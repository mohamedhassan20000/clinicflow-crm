import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/20260729140000_appointment_undo_activity_events.sql",
  ),
  "utf8",
).toLowerCase();

function functionBody(name: string, nextName: string) {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  const end = sql.indexOf(
    `create or replace function public.${nextName}(`,
    start + 1,
  );
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
}

describe("appointment undo activity migration", () => {
  it("uses an explicit reversal vocabulary and original-event metadata", () => {
    for (const action of [
      "appointment.confirmation_undone",
      "appointment.check_in_undone",
      "appointment.session_start_undone",
      "appointment.billing_completion_undone",
      "appointment.cancellation_undone",
      "appointment.no_show_undone",
      "appointment.replacement_undone",
      "appointment.status_undone",
    ]) {
      expect(sql).toContain(action);
    }
    expect(sql).toContain("'operation', 'undo'");
    expect(sql).toContain("'original_event_id', v_original_event_id");
    expect(sql).toContain("'original_action', v_original_action");
    expect(sql).toContain("'target_status', new.status");
  });

  it("updates status undo in place instead of emitting delete/create events", () => {
    const body = functionBody(
      "undo_appointment_status",
      "apply_appointment_billing_undo",
    );
    expect(body).toContain("update public.appointments");
    expect(body).not.toContain("delete from public.appointments");
    expect(body).not.toContain("insert into public.appointments");
  });

  it("updates billing undo in place and tags it as billing completion undone", () => {
    const body = functionBody(
      "apply_appointment_billing_undo",
      "undo_appointment_billing",
    );
    expect(body).toContain("update public.appointments");
    expect(body).toContain("appointment.billing_completion_undone");
    expect(body).not.toContain("delete from public.appointments");
    expect(body).not.toContain("insert into public.appointments");
  });

  it("keeps normal completed, cancelled, and deleted events distinct", () => {
    expect(sql).toContain("when 'completed' then 'appointment.completed'");
    expect(sql).toContain("when 'cancelled' then 'appointment.cancelled'");
    expect(sql).toContain("v_action := 'appointment.deleted'");
  });
});
