import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const MIGRATION_PATH =
  "supabase/migrations/20260813120000_ai_assistant_phase0_foundations.sql";

describe("AI Assistant Phase 0 foundations", () => {
  it("keeps the approved plan copy byte-identical", () => {
    expect(readFileSync("docs/plans/AI_ASSISTANT_FULL_CAPABILITY_PLAN.md"))
      .toEqual(readFileSync("docs/AI_ASSISTANT_FULL_CAPABILITY_PLAN.md"));
  });

  it("does not cross into Phase 0b entitlement decoupling", () => {
    const sql = readFileSync(MIGRATION_PATH, "utf8");
    expect(sql).not.toContain("create or replace function public.effective_ai_feature");
    expect(sql).not.toContain("create or replace function public.resolve_ai_commercial_limits");
    expect(sql).not.toContain("accepted_at");
  });
});
