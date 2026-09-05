import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  "supabase/migrations/20260903120000_p11r_whatsapp_inbound_boundary.sql",
  "utf8",
).toLowerCase();

describe("P11R WhatsApp inbound boundary migration", () => {
  it("adds a durable boundary and message provenance without destructive cleanup", () => {
    expect(sql).toContain("add column if not exists inbound_active_from timestamptz");
    expect(sql).toContain("add column if not exists ingestion_origin text not null default 'live'");
    expect(sql).toContain("'history_sync'");
    expect(sql).not.toMatch(/\bdelete\s+from\b/);
    expect(sql).not.toMatch(/\btruncate\b/);
    expect(sql).not.toMatch(/\bdrop\s+table\b/);
  });
});
