import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20260727140000_p8d_activity_events.sql"),
  "utf8",
);

describe("Phase 8D — activity_events migration contract", () => {
  it("creates the append-only activity_events table with the documented shape", () => {
    expect(sql).toContain("create table if not exists public.activity_events");
    for (const col of [
      "clinic_id uuid not null",
      "actor_id uuid references public.profiles(id) on delete set null",
      "actor_role public.user_role",
      "is_system boolean not null default false",
      "action text not null",
      "entity_type text not null",
      "entity_id uuid not null",
      "patient_id uuid",
      "doctor_id uuid",
      "previous_state jsonb",
      "new_state jsonb",
      "metadata jsonb not null default '{}'::jsonb",
      "occurred_at timestamptz not null default now()",
    ]) {
      expect(sql).toContain(col);
    }
  });

  it("indexes for entity, actor, doctor and patient timelines", () => {
    expect(sql).toContain("activity_events_entity_idx");
    expect(sql).toContain("(clinic_id, entity_type, entity_id, occurred_at desc)");
    expect(sql).toContain("activity_events_actor_idx");
    expect(sql).toContain("activity_events_doctor_idx");
    expect(sql).toContain("activity_events_patient_idx");
  });

  it("writes events only through a SECURITY DEFINER trigger that stamps auth.uid()", () => {
    expect(sql).toContain("function public.record_activity_event()");
    expect(sql).toContain("security definer");
    expect(sql).toContain("v_actor uuid := auth.uid()");
    expect(sql).toContain("v_is_system boolean := (auth.uid() is null)");
    // Fires on every covered entity for all DML.
    expect(sql).toContain("create trigger trg_activity_appointments");
    expect(sql).toContain("after insert or update or delete on public.appointments");
    expect(sql).toContain("create trigger trg_activity_follow_ups");
    expect(sql).toContain("after insert or update or delete on public.follow_ups");
  });

  it("derives the full semantic appointment vocabulary", () => {
    for (const action of [
      "appointment.created",
      "appointment.confirmed",
      "appointment.checked_in",
      "appointment.session_started",
      "appointment.completed",
      "appointment.cancelled",
      "appointment.no_show",
      "appointment.replaced",
      "appointment.rescheduled",
      "appointment.deleted",
      "follow_up.recorded",
      "follow_up.deleted",
    ]) {
      expect(sql, `missing action ${action}`).toContain(action);
    }
  });

  it("is append-only and spoof-proof: SELECT-only grant, no write policies", () => {
    expect(sql).toContain("revoke all on table public.activity_events from anon, authenticated");
    expect(sql).toContain("grant select on table public.activity_events to authenticated");
    // Only a SELECT policy exists; no insert/update/delete policy is defined.
    expect(sql).toContain('create policy "activity_events_select_scoped"');
    expect(sql).not.toContain("for insert");
    expect(sql).not.toContain("for update");
    expect(sql).not.toContain("for delete");
  });

  it("scopes reads by clinic and role, using the supervised-doctor helper for assistants", () => {
    expect(sql).toContain("clinic_id = public.auth_clinic_id()");
    expect(sql).toContain("public.auth_role() = 'doctor'::public.user_role");
    expect(sql).toContain("public.auth_role() = 'assistant'::public.user_role");
    expect(sql).toContain("any (public.auth_supervised_doctor_ids())");
  });
});
