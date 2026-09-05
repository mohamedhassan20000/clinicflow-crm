import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  "supabase/migrations/20260901130000_patient_assistant_stale_patient_episode_reset.sql",
  "utf8",
);

describe("Patient Assistant stale-patient episode reset migration", () => {
  it("locks and atomically clears the invalid link plus all episode-owned state", () => {
    const runtime = migration.slice(
      migration.indexOf("function public.normalize_stale_patient_conversation_episode"),
      migration.indexOf("-- Existing-row repair"),
    );
    expect(runtime).toContain("for update");
    for (const assignment of [
      "patient_id = null",
      "patient_link_status = 'unlinked'",
      "booking_identity_confirmed_at = null",
      "identity_verified_at = null",
      "ai_collected_data = '{}'::jsonb",
      "ai_pending_clarification = null",
      "ai_booking_stage = null",
      "ai_escalated_at = null",
      "ai_paused_at = null",
      "ai_last_replied_at = null",
      "ai_context_reset_at = v_boundary",
    ]) {
      expect(runtime, assignment).toContain(assignment);
    }
    expect(runtime).toContain("status = 'superseded'");
  });

  it("is idempotent and refuses to clear a valid active patient", () => {
    expect(migration).toContain("if v_conversation.patient_id is null or exists");
    expect(migration).toContain("not p.is_deleted");
    expect(migration).toContain("p.deleted_at is null");
    expect(migration).toContain("reset_performed := false");
  });

  it("backfills only conversations linked to an explicitly soft-deleted patient", () => {
    const backfill = migration.slice(
      migration.indexOf("-- Existing-row repair"),
      migration.indexOf("-- The authoritative resolver"),
    );
    expect(backfill).toContain("join public.patients p");
    expect(backfill).toContain("where p.is_deleted or p.deleted_at is not null");
    expect(backfill).not.toContain("delete from");
    expect(backfill).not.toContain("inbound_messages");
    expect(backfill).not.toContain("outbound_messages");
    expect(backfill).not.toContain("audit_logs");
  });

  it("normalizes before authoritative context is returned and changes no authorization policy", () => {
    const resolver = migration.slice(
      migration.indexOf("function public.resolve_patient_ai_context"),
    );
    expect(resolver.indexOf("normalize_stale_patient_conversation_episode")).toBeLessThan(
      resolver.indexOf("return query"),
    );
    expect(migration).toContain("PATIENT_AI_SERVICE_ROLE_REQUIRED");
    expect(migration).toContain("grant execute on function public.normalize_stale_patient_conversation_episode");
    expect(migration).not.toMatch(/disable row level security/i);
    expect(migration).not.toMatch(/drop policy|create policy|alter policy/i);
  });
});
