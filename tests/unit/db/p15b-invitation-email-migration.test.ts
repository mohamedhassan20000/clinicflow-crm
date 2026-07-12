import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("P1.5B invitation email migration", () => {
  const sql = readFileSync("supabase/migrations/20260712090000_p15b_invitation_email.sql", "utf8");
  it("adds only the nullable delivery timestamp and never stores a raw token", () => {
    expect(sql).toMatch(/add column if not exists email_sent_at timestamptz/i);
    expect(sql).not.toMatch(/raw_token|invitation_link/i);
  });
});
