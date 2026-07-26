import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const sql = fs.readFileSync(
  path.join(
    process.cwd(),
    "supabase/migrations/20260726170000_p411b_workflow_actions.sql",
  ),
  "utf8",
);

describe("P4.11B workflow action migration", () => {
  it("keeps confirmations server-write-only and same-owner RLS unchanged", () => {
    expect(sql).not.toMatch(/grant\s+(insert|update|delete).*authenticated/i);
    expect(sql).not.toMatch(/create policy/i);
    expect(sql).toContain("confirmed_by is not null");
    expect(sql).toContain("confirmed_at is not null");
  });

  it("adds content-free, tenant-bound pending-booking idempotency", () => {
    expect(sql).toContain("appointments_ai_workflow_run_clinic_fkey");
    expect(sql).toContain("references public.ai_workflow_runs(id, clinic_id)");
    expect(sql).toContain("appointments_ai_workflow_step_uidx");
    expect(sql).toContain("ai_workflow_step_id ~");
  });

  it("adds a softer clarification terminal state without adding destructive vocabulary", () => {
    expect(sql).toContain("'needs_clarification'");
    expect(sql).not.toMatch(/\b(delete|truncate)\s+from\b/i);
  });

  it("documents the content-free resume binding without persisting action inputs", () => {
    expect(sql).toContain("server-resolved action inputs after the atomic claim");
    expect(sql).not.toMatch(
      /\b(action_inputs|recipient|patient_id|appointment_id)\s+(text|jsonb|uuid)/i,
    );
  });
});
