import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/20260813150000_ai_assistant_phase3_action_foundation.sql",
  ),
  "utf8",
);

describe("Phase 3 action foundation migration", () => {
  it("creates content-free confirmations and receipts with tenant-integrity FKs", () => {
    expect(migration).toContain("create table public.ai_action_confirmations");
    expect(migration).toContain("create table public.ai_action_receipts");
    expect(migration).toContain("foreign key (actor_id, clinic_id)");
    expect(migration).toContain("foreign key (conversation_id, clinic_id)");
    expect(migration).toContain("input_digest text not null");
    expect(migration).not.toMatch(/\b(action_input|input_payload|prompt|completion)\b\s+(jsonb|text)/i);
  });

  it("allows only in-clinic admins and managers to read receipts and exposes no confirmation table access", () => {
    expect(migration).toContain('create policy "ai_action_receipts_admin_manager_read"');
    expect(migration).toContain("clinic_id = public.auth_clinic_id()");
    expect(migration).toContain("'admin'::public.user_role");
    expect(migration).toContain("'manager'::public.user_role");
    expect(migration).toMatch(
      /revoke all on table public\.ai_action_confirmations\s+from public, anon, authenticated;/,
    );
    expect(migration).not.toContain("on public.ai_action_confirmations for");
  });

  it("makes issue, claim, begin, and finalize service-role-only at runtime and privilege level", () => {
    for (const name of [
      "issue_ai_action_confirmation",
      "claim_ai_action_confirmation",
      "begin_ai_action_receipt",
      "finalize_ai_action_receipt",
    ]) {
      expect(migration).toContain(`function public.${name}`);
      expect(migration).toContain(`grant execute on function public.${name}`);
    }
    expect(migration.match(/coalesce\(auth\.role\(\), ''\) <> 'service_role'/g))
      .toHaveLength(4);
  });

  it("claims once with exact token, tenant, actor, conversation, action, input, and expiry bindings", () => {
    for (const predicate of [
      "token_hash = p_token_hash",
      "clinic_id = p_clinic_id",
      "actor_id = p_actor_id",
      "conversation_id = p_conversation_id",
      "action_id = p_action_id",
      "input_digest = p_input_digest",
      "consumed_at is null",
      "expires_at > p_consumed_at",
    ]) {
      expect(migration).toContain(predicate);
    }
  });
});
