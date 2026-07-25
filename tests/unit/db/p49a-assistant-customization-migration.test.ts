import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  "supabase/migrations/20260722120000_p49a_assistant_customization.sql",
  "utf8",
);

describe("P4.9A Assistant customization migration", () => {
  it("creates only the two placement tables with tenant-scoped primary keys", () => {
    expect(migration).toContain("create table public.assistant_launcher_settings");
    expect(migration).toContain("primary key (clinic_id, area, role)");
    expect(migration).toContain("create table public.assistant_launcher_user_overrides");
    expect(migration).toContain("primary key (clinic_id, user_id, area)");
    expect(migration).toContain("assistant_launcher_user_overrides_user_clinic_fk");
    expect(migration).not.toMatch(/create table public\.(ai_workflow_runs|agent_memor|active_context)/);
  });

  it("enables RLS, scopes reads, and makes writes primary-admin-only", () => {
    expect(migration).toContain(
      "alter table public.assistant_launcher_settings enable row level security",
    );
    expect(migration).toContain(
      "alter table public.assistant_launcher_user_overrides enable row level security",
    );
    expect(migration.match(/clinic_id = public\.auth_clinic_id\(\)/g)).toHaveLength(2);
    expect(migration.match(/public\.is_primary_clinic_admin\(/g)?.length).toBeGreaterThanOrEqual(4);
    expect(migration).toContain("assistant_launcher_settings.updated_by = auth.uid()");
    expect(migration).toContain("revoke all on table public.assistant_launcher_settings from public, anon");
  });

  it("seeds customization true only for pro_ai and preserves the stable slugs", () => {
    expect(migration).toContain("'ai.assistant_customization', slug = 'pro_ai'");
    expect(migration).toContain("where slug in ('basic', 'pro', 'pro_ai')");
  });

  it("documents that placement is UI-only and never a tool authorization source", () => {
    expect(migration).toContain(
      "P4.9 UI-placement preferences only; never an authorization or tool-mount source.",
    );
    expect(migration).not.toMatch(/create policy[\s\S]+?(agent_messages|medical_notes|patients)/i);
  });

  it("audits both composite-key placement tables without the legacy id-based trigger", () => {
    expect(migration).toContain("create or replace function public.audit_assistant_launcher_placement()");
    expect(migration).toContain("'assistant_launcher_placement:' || lower(tg_op)");
    expect(migration).toContain("create trigger trg_audit_assistant_launcher_settings");
    expect(migration).toContain("create trigger trg_audit_assistant_launcher_user_overrides");
    expect(migration).not.toContain("execute function public.write_audit_log()");
  });

  it("requires an authenticated audit actor and keeps service-role placement access read-only", () => {
    expect(migration).toContain("v_actor_id uuid := auth.uid()");
    expect(migration).toContain("ASSISTANT_LAUNCHER_ACTOR_REQUIRED");
    expect(migration).toContain("raise exception 'ASSISTANT_LAUNCHER_ACTOR_REQUIRED'");
    expect(migration).toContain(
      "revoke insert, update, delete on table public.assistant_launcher_settings",
    );
    expect(migration).toContain(
      "revoke insert, update, delete on table public.assistant_launcher_user_overrides",
    );
  });
});
