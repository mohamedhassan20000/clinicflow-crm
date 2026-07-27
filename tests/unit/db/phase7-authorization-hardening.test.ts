import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  "supabase/migrations/20260727136000_phase7_authorization_hardening.sql",
  "utf8",
);

describe("Phase 7 database authorization hardening", () => {
  it("binds page/report overrides to the target user's real clinic", () => {
    expect(migration).toContain("user_page_permissions_user_clinic_fk");
    expect(migration).toContain("user_report_permissions_user_clinic_fk");
    expect(migration).toContain(
      "references public.profiles (id, clinic_id)",
    );
  });

  it("makes direct page/report customization primary-admin-only", () => {
    expect(migration).toContain(
      'create policy "Primary admin can manage clinic page permissions"',
    );
    expect(migration).toContain(
      'create policy "Primary admin can manage clinic report permissions"',
    );
    expect(migration.match(/public\.is_primary_clinic_admin/g)?.length).toBe(8);
    expect(migration.match(/not public\.is_primary_clinic_admin/g)?.length).toBe(
      4,
    );
  });

  it("validates supervision links and replaces a non-empty doctor set atomically", () => {
    expect(migration).toContain(
      "function public.validate_assistant_doctor_assignment()",
    );
    expect(migration).toContain(
      "function public.replace_assistant_doctor_assignments(",
    );
    expect(migration).toContain("cardinality(v_doctor_ids) = 0");
    expect(migration).toContain("v_valid_count <> cardinality(v_doctor_ids)");
    expect(migration).toContain(
      "delete from public.assistant_doctor_assignments",
    );
    expect(migration).toContain(
      "insert into public.assistant_doctor_assignments",
    );
  });

  it("allows last-login tracking only through the guarded self RPC", () => {
    expect(migration).toContain(
      "create or replace function public.record_own_last_login()",
    );
    expect(migration).toContain(
      "app.allow_profile_last_login_touch",
    );
    expect(migration).toContain(
      "new.display_currency is not distinct from old.display_currency",
    );
  });

  it("uses an explicit AI analytics role allowlist that excludes assistants", () => {
    const guard = migration.slice(
      migration.indexOf(
        "create or replace function public.ai_assert_analytics_caller",
      ),
      migration.indexOf(
        "-- Assistant-owned AI conversations",
      ),
    );
    expect(guard).toContain("'admin'::public.user_role");
    expect(guard).toContain("'manager'::public.user_role");
    expect(guard).toContain("'receptionist'::public.user_role");
    expect(guard).not.toContain("'assistant'::public.user_role");
    expect(guard).not.toContain("'doctor'::public.user_role");
  });

  it("permits assistant conversations but patient-binds them through scoped patient RLS", () => {
    expect(migration).toContain("'assistant'::public.user_role");
    expect(migration).toContain("from public.patients p");
    expect(migration).toContain(
      "p.id = agent_conversations.patient_id",
    );
    expect(migration).toContain("p.is_deleted = false");
  });
});
