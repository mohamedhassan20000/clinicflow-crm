import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  "supabase/migrations/20260728120000_p5b_inbox_ai_booking.sql",
  "utf8",
);
const types = readFileSync("types/database.ts", "utf8");

describe("P5B inbox AI migration", () => {
  it("adds the per-clinic reply-mode toggle constrained to off/suggest/auto", () => {
    expect(migration).toContain("add column ai_reply_mode text not null default 'off'");
    expect(migration).toContain("check (ai_reply_mode in ('off', 'suggest', 'auto'))");
  });

  it("adds conversation-level escalation / handoff state", () => {
    expect(migration).toContain("add column ai_escalated_at timestamptz");
    expect(migration).toMatch(/ai_escalation_reason text[\s\S]*?'emergency'[\s\S]*?'low_confidence'/);
    expect(migration).toContain("add column ai_last_replied_at timestamptz");
  });

  it("creates ai_suggested_replies with a single-pending guard and read-only staff RLS", () => {
    expect(migration).toContain("create table public.ai_suggested_replies");
    expect(migration).toContain("status in ('pending', 'sent', 'dismissed', 'superseded')");
    expect(migration).toMatch(
      /create unique index ai_suggested_replies_one_pending_idx[\s\S]*?where status = 'pending'/,
    );
    // Read-only for the inbox roles; no authenticated write policy exists.
    expect(migration).toContain("inbox_staff_read_own_ai_suggested_replies");
    expect(migration).toContain("for select to authenticated");
    expect(migration).not.toMatch(/ai_suggested_replies[\s\S]*?for (insert|update|delete) to authenticated/);
  });

  it("publishes the suggestion table to realtime for the live inbox", () => {
    expect(migration).toContain(
      "alter publication supabase_realtime add table public.ai_suggested_replies",
    );
  });

  it("regenerated database types expose the new objects", () => {
    expect(types).toContain("ai_suggested_replies: {");
    expect(types).toMatch(/clinics:[\s\S]*?ai_reply_mode: string/);
    expect(types).toMatch(/conversations:[\s\S]*?ai_escalated_at: string \| null/);
  });
});
