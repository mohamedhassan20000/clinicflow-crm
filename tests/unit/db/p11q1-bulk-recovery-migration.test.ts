import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATION_PATH =
  "supabase/migrations/20260902140000_p11q1_bulk_recipient_recovery.sql";
const migration = fs.readFileSync(path.join(process.cwd(), MIGRATION_PATH), "utf8");

/**
 * P11Q.1 — the recovery migration, and the one thing it must never do.
 */
describe("P11Q.1 bulk recovery migration", () => {
  it("is additive and does not rewrite the applied bulk migration", () => {
    expect(migration).not.toMatch(/\bdrop\s+table\b/i);
    expect(migration).not.toMatch(/\b(truncate|delete\s+from)\b/i);
    expect(migration).toMatch(/add column if not exists claimed_at timestamptz/i);
  });

  /**
   * The critical negative. A timeout-based reclaim is the obvious fix and the
   * one that can send a patient the same message twice, so the claim must still
   * refuse anything that is not pending or failed.
   */
  it("never returns an interrupted recipient to the claim automatically", () => {
    const claim = migration.slice(
      migration.indexOf("function public.claim_bulk_message_recipient"),
      migration.indexOf("function public.flag_stalled_bulk_recipients"),
    );
    // Only the predicate matters here: `set status = 'sending'` is the correct
    // assignment, while 'sending' or 'review' appearing in the WHERE clause
    // would mean an interrupted row could be claimed again.
    // Bounded at `returning`, so the next function's prose cannot leak in.
    const predicate = claim.slice(claim.indexOf("where "), claim.indexOf("returning"));
    expect(predicate).toMatch(/status in \('pending', 'failed'\)/i);
    expect(predicate).not.toMatch(/'sending'/i);
    expect(predicate).not.toMatch(/'review'/i);
  });

  it("flags stale sends into a state that needs a human decision", () => {
    expect(migration).toMatch(/set status = 'review'/i);
    expect(migration).toMatch(/failure_code = 'interrupted'/i);
    expect(migration).toMatch(/status = 'sending'/i);
  });

  /** A caller must not be able to flag a send that is merely in progress. */
  it("clamps the staleness threshold to its own floor", () => {
    expect(migration).toMatch(/greatest\(p_stale_seconds, 60\)/i);
  });

  it("only ever releases a recipient that is in review", () => {
    const release = migration.slice(migration.indexOf("function public.release_bulk_recipient_for_retry"));
    expect(release).toMatch(/set status = 'pending'/i);
    expect(release).toMatch(/and recipient\.status = 'review'/i);
  });

  it("keeps every recovery function off the authenticated role", () => {
    for (const fn of [
      "claim_bulk_message_recipient\\(uuid, uuid\\)",
      "flag_stalled_bulk_recipients\\(uuid, uuid, integer\\)",
      "release_bulk_recipient_for_retry\\(uuid, uuid\\)",
    ]) {
      expect(migration).toMatch(
        new RegExp(`revoke all on function public\\.${fn} from public, anon, authenticated`, "i"),
      );
      expect(migration).toMatch(
        new RegExp(`grant execute on function public\\.${fn} to service_role`, "i"),
      );
    }
  });

  it("requires a reason on a row awaiting review", () => {
    expect(migration).toMatch(/status <> 'review' or failure_code is not null/i);
  });
});
