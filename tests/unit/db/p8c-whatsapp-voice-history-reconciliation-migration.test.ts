import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migration = fs.readFileSync(
  path.join(process.cwd(), "supabase/migrations/20260821120000_p8c_whatsapp_voice_history_reconciliation.sql"),
  "utf8",
);

describe("P8C WhatsApp voice/history reconciliation migration", () => {
  it("keeps asserted LID mappings immutable and service-role only", () => {
    expect(migration).toContain("raise exception 'LID_MAPPING_CONFLICT'");
    expect(migration).toContain("where existing.participant_address = excluded.participant_address");
    expect(migration).toContain("alter table public.whatsapp_lid_mappings enable row level security");
    expect(migration).toContain("revoke all on table public.whatsapp_lid_mappings from public, anon, authenticated");
  });

  it("durably stages unresolved chats and messages without creating patients", () => {
    expect(migration).toContain("create table if not exists public.whatsapp_pending_history_chats");
    expect(migration).toContain("create table if not exists public.whatsapp_pending_history_messages");
    expect(migration).toContain("where status = 'pending'");
    expect(migration).not.toMatch(/insert\s+into\s+public\.patients/i);
  });

  it("records received, deduplicated, pending, and unsupported message counts idempotently", () => {
    expect(migration).toContain("metrics_recorded boolean not null default false");
    expect(migration).toContain("and not batch.metrics_recorded");
    expect(migration).toContain("history_messages_deduplicated");
    expect(migration).toContain("history_messages_pending = v_pending");
    expect(migration).toContain("history_messages_unsupported");
    expect(migration).toContain("when v_imported = 0 and v_chats_imported = 0 then 'unavailable'");
  });
});
