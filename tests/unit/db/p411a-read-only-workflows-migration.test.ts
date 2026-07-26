import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  "supabase/migrations/20260726120000_p411a_read_only_workflows.sql",
  "utf8",
);

describe("P4.11A read-only workflow migration", () => {
  it("creates the content-free run and per-step ledger with hard caps", () => {
    expect(migration).toContain("create table public.ai_workflow_runs");
    expect(migration).toContain("jsonb_typeof(plan) = 'object'");
    expect(migration).toContain("jsonb_typeof(step_states) = 'array'");
    expect(migration).toContain("step_count between 1 and 6");
    expect(migration).toContain("cost_units between 1 and 12");
    expect(migration).toContain("dry_run_snapshot_hash ~ '^[0-9a-f]{64}$'");
    expect(migration).not.toMatch(/\b(prompt|completion|tool_output|message_body)\s+(text|jsonb)/i);
  });

  it("makes runs owner-readable, tenant-isolated, and server-write-only", () => {
    expect(migration).toContain("alter table public.ai_workflow_runs enable row level security");
    expect(migration).toContain('create policy "ai_workflow_runs_owner_read"');
    expect(migration).toContain("clinic_id = public.auth_clinic_id()");
    expect(migration).toContain("user_id = auth.uid()");
    expect(migration).toContain(
      "revoke all on table public.ai_workflow_runs from public, anon, authenticated",
    );
    expect(migration).toContain(
      "grant select on table public.ai_workflow_runs to authenticated",
    );
    expect(migration).toContain(
      "grant select, insert, update, delete on table public.ai_workflow_runs to service_role",
    );
    expect(migration).not.toMatch(/for (insert|update|delete|all) to authenticated/i);
  });

  it("seeds ai.workflows only on pro_ai and preserves standard entitlement resolution", () => {
    expect(migration).toContain("'ai.workflows', slug = 'pro_ai'");
    expect(migration).toContain("where slug in ('basic', 'pro', 'pro_ai')");
  });

  it("reserves confirmation columns without implementing P4.11B action behavior", () => {
    expect(migration).toContain("confirmed_by uuid");
    expect(migration).toContain("confirmed_at timestamptz");
    expect(migration).not.toMatch(
      /\b(send|dispatch|create_preliminary_booking|confirm_workflow|resume_workflow)\s*\(/i,
    );
    expect(migration).not.toContain("message_dispatches");
    expect(migration).not.toContain("appointments");
  });

  it("matches the checked-in generated table shape", () => {
    const types = readFileSync("types/database.ts", "utf8");
    expect(types).toContain("ai_workflow_runs: {");
    for (const section of ["Row", "Insert", "Update", "Relationships"]) {
      expect(types).toContain(`${section}:`);
    }
    expect(types).toContain(
      'foreignKeyName: "ai_workflow_runs_user_clinic_fkey"',
    );
    expect(types).toContain(
      'foreignKeyName: "ai_workflow_runs_confirmation_clinic_fkey"',
    );
  });
});
