import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(process.cwd(), "supabase/migrations/20260813160000_ai_assistant_phase4_orchestration.sql"),
  "utf8",
);

function filesContaining(needle: string): string[] {
  const matches: string[] = [];

  function visit(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile() && readFileSync(path, "utf8").includes(needle)) {
        matches.push(relative(process.cwd(), path));
      }
    }
  }

  for (const root of ["lib", "app", "actions"]) {
    visit(join(process.cwd(), root));
  }
  return matches;
}

describe("Phase 4 orchestration migration", () => {
  it("persists bounded UI message parts without changing the message RLS boundary", () => {
    expect(migration).toContain("add column if not exists parts jsonb");
    expect(migration).toContain("Sanitized, size-bounded AI SDK UI message parts");
    expect(migration).not.toMatch(/create policy[\s\S]*agent_messages/i);
  });

  it("anchors new pending bookings to a confirmed action receipt and preserves the existing caps", () => {
    expect(migration).toContain("add column if not exists ai_action_receipt_id uuid");
    expect(migration).toContain("appointments_ai_action_receipt_fkey");
    expect(migration).toContain("action_id = 'appointments.create_pending'");
    expect(migration).toContain("AI_PENDING_PATIENT_CAP");
    expect(migration).toContain("AI_PENDING_SLOT_CAP");
    expect(migration).toContain("AI_BOOKING_METADATA_SERVER_ONLY");
  });

  it("keeps every AI booking provenance field server-owned", () => {
    const guardBody = migration.slice(
      migration.indexOf("create or replace function public.protect_ai_booking_metadata"),
      migration.indexOf("drop trigger if exists trg_appointments_guard_ai_metadata"),
    );
    const trigger = migration.slice(
      migration.indexOf("create trigger trg_appointments_guard_ai_metadata"),
      migration.indexOf("create or replace function public.enforce_ai_pending_booking_policy"),
    );
    expect(guardBody).toContain("new.ai_workflow_step_id is not null");
    expect(guardBody).toContain(
      "old.ai_workflow_step_id is distinct from new.ai_workflow_step_id",
    );
    expect(trigger).toContain("ai_workflow_run_id, ai_workflow_step_id");
  });

  it("retires the legacy workflow ledger and seeds the live plan step ceiling", () => {
    expect(migration).toContain("Retired after Phase 4");
    expect(migration).toContain("all new action attempts use ai_action_receipts");
    expect(migration).toContain(
      "revoke insert, update, delete on table public.ai_workflow_runs from service_role",
    );
    expect(migration).toContain("'{ai_turn_steps_max}'");
    expect(migration).toContain("'25'::jsonb");
  });

  it("has no production writer for the retired workflow ledger", () => {
    for (const file of filesContaining("ai_workflow_runs")) {
      expect(readFileSync(join(process.cwd(), file), "utf8"), file)
        .not.toMatch(/from\(["']ai_workflow_runs["']\)[\s\S]{0,160}\.insert\(/);
    }
  });

  it("returns an empty reference list when the repository-native scan has no matches", () => {
    expect(filesContaining("__phase4_reference_that_does_not_exist__")).toEqual([]);
  });
});
