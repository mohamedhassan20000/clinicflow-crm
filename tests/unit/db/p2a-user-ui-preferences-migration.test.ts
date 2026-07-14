import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(process.cwd(), "supabase/migrations/20260714120000_p2a_user_ui_preferences.sql"),
  "utf8",
);

describe("P2A user_ui_preferences migration (§4.5)", () => {
  it("keys the store on auth.users, never on profiles", () => {
    // Load-bearing: a Platform Admin has no `profiles` row, so a profiles-keyed column could never
    // store the SaaS Owner's theme or the operator dashboard's language.
    expect(migration).toContain("user_id uuid primary key references auth.users(id) on delete cascade");
    expect(migration).not.toMatch(/references\s+public\.profiles/i);
  });

  it("carries both theme and locale, constrained, with English and light as the defaults", () => {
    expect(migration).toContain("theme text not null default 'light' check (theme in ('light', 'dark'))");
    expect(migration).toContain("locale text not null default 'en' check (locale in ('en', 'ar'))");
  });

  it("enables RLS with self-only policies on every verb", () => {
    expect(migration).toContain("alter table public.user_ui_preferences enable row level security");
    for (const policy of ["select", "insert", "update", "delete"]) {
      expect(migration).toContain(`user_ui_preferences_${policy}_self`);
    }
    // Five self-scoping clauses in total: select USING, insert WITH CHECK, update USING, update
    // WITH CHECK, delete USING. Read and write are both pinned to the caller.
    expect(migration.match(/user_id = \(select auth\.uid\(\)\)/g)).toHaveLength(5);
  });

  it("grants no platform-admin exception and no anonymous access", () => {
    // A platform admin is just another account here: they may read and write their own row, and
    // nobody else's. The absence of `is_platform_admin()` in this file is the whole point.
    expect(migration).not.toContain("is_platform_admin");
    expect(migration).not.toMatch(/to\s+anon/i);
    expect(migration).toContain("revoke all on table public.user_ui_preferences from anon");
  });

  it("retires clinics.locale as a language source without dropping it (§13-Q11)", () => {
    expect(migration).toContain("comment on column public.clinics.locale");
    expect(migration).toMatch(/never resolve any user''s UI language/i);
    expect(migration).not.toMatch(/alter table public\.clinics\s+drop column/i);
  });

  it("ships no backfill, and says so", () => {
    // A browser cookie is not readable server-side outside a request, so historical theme choices
    // cannot be migrated. Rows are created lazily on first write — documented, not invented.
    expect(migration).not.toMatch(/^\s*insert into public\.user_ui_preferences/im);
    expect(migration).toMatch(/Backfill: intentionally NONE/i);
  });
});
