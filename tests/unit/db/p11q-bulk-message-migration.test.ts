import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATION_PATH = "supabase/migrations/20260902130000_p11q_bulk_message_jobs.sql";
const migration = fs.readFileSync(path.join(process.cwd(), MIGRATION_PATH), "utf8");

/**
 * P11Q — the schema is where most of the safety actually lives, so it is
 * asserted rather than assumed.
 */
describe("P11Q bulk message migration", () => {
  it("is additive: it creates, and never alters or drops, existing objects", () => {
    expect(migration).not.toMatch(/\bdrop\s+table\b/i);
    expect(migration).not.toMatch(/\balter\s+table\s+public\.(conversations|outbound_messages)\b/i);
    expect(migration).not.toMatch(/\b(truncate|delete\s+from)\b/i);
  });

  it("makes one row per recipient per job impossible to duplicate", () => {
    expect(migration).toMatch(
      /create unique index[\s\S]*bulk_message_recipients[\s\S]*\(job_id, conversation_id\)/i,
    );
  });

  /** The claim is the idempotency mechanism; its predicate is the guarantee. */
  it("claims a recipient only from pending or failed", () => {
    expect(migration).toContain("claim_bulk_message_recipient");
    expect(migration).toMatch(/status\s*=\s*'sending'/i);
    expect(migration).toMatch(/status in \('pending', 'failed'\)/i);
    // A sent recipient must be unreachable by the claim.
    expect(migration).not.toMatch(/status in \([^)]*'sent'[^)]*\)\s*;?\s*$/im);
  });

  it("records who initiated the send, for audit", () => {
    expect(migration).toMatch(/created_by uuid not null/i);
    expect(migration).toMatch(/bulk_message_jobs_created_by_clinic_fkey/i);
  });

  it("keeps a partial send distinguishable from a clean one", () => {
    expect(migration).toContain("completed_with_failures");
  });

  it("points a sent recipient at the ordinary outbound record rather than copying it", () => {
    expect(migration).toMatch(/outbound_message_id uuid/i);
    expect(migration).toMatch(/status <> 'sent' or outbound_message_id is not null/i);
    // Delivery state is not duplicated into this table.
    expect(migration).not.toMatch(/\bdelivered_at\b|\bread_at\b/i);
  });

  it("always names a reason when a recipient is skipped", () => {
    expect(migration).toMatch(/status <> 'skipped' or failure_code is not null/i);
  });

  it("caps a job at an operational size", () => {
    expect(migration).toMatch(/total_recipients integer not null check \(total_recipients between 1 and 50\)/i);
  });

  it("enables RLS and keeps writes off the authenticated role", () => {
    expect(migration).toMatch(/alter table public\.bulk_message_jobs enable row level security/i);
    expect(migration).toMatch(/alter table public\.bulk_message_recipients enable row level security/i);
    expect(migration).toContain("grant select on table public.bulk_message_jobs to authenticated");
    expect(migration).toContain("grant select on table public.bulk_message_recipients to authenticated");
    expect(migration).not.toMatch(/grant (insert|update|delete|all)[\s\S]{0,80}to authenticated/i);
  });

  it("restricts the claim function to the service role", () => {
    expect(migration).toMatch(
      /revoke all on function public\.claim_bulk_message_recipient\(uuid, uuid\) from public, anon, authenticated/i,
    );
    expect(migration).toMatch(
      /grant execute on function public\.claim_bulk_message_recipient\(uuid, uuid\) to service_role/i,
    );
  });

  it("reuses the existing realtime publication instead of adding polling", () => {
    expect(migration).toContain(
      "alter publication supabase_realtime add table public.bulk_message_recipients",
    );
  });

  it("stores no clinical data about a recipient", () => {
    expect(migration).not.toMatch(/\b(diagnosis|patient_id|note|complaint)\b/i);
  });
});
