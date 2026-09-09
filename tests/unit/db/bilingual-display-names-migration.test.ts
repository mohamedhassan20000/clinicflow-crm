/**
 * The bilingual display-name migration, read as a contract.
 *
 * Two properties matter more than the columns themselves, and both are things
 * a future edit could quietly break:
 *
 *   1. **It is additive and empty.** Every column lands NULL and stays NULL.
 *      A backfill — a transliteration, a translation, anything generated — is
 *      indistinguishable a week later from a name a person at the clinic typed,
 *      and a wrong doctor's name is not a formatting defect.
 *   2. **The canonical columns are untouched.** `departments.name`,
 *      `services.name` and `profiles.full_name` remain what search, invoices,
 *      exports and every staff screen read. The display names accompany them;
 *      they never replace them.
 *
 * The application half of the contract is asserted too: the patient-facing
 * reads must survive on a database where this migration has not been applied,
 * because it is applied on the clinic's own schedule.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const MIGRATION = "supabase/migrations/20260916120000_bilingual_display_names.sql";

const raw = readFileSync(MIGRATION, "utf8");

/**
 * The migration with its `--` commentary removed.
 *
 * Every "this does not happen" assertion below runs against this rather than
 * the file: the file's own comments explain, in prose, exactly the things being
 * asserted absent ("no default", "reverse: three DROP COLUMN statements"), and
 * a negative regex over the whole text would match the explanation and fail on
 * a correct migration.
 */
const sql = raw
  .split("\n")
  .map((line) => line.replace(/--.*$/, ""))
  .join("\n");

describe("bilingual display names", () => {
  it("adds nullable display-name columns to the three directories", () => {
    expect(sql).toContain("alter table public.departments");
    expect(sql).toContain("add column if not exists name_ar text");
    expect(sql).toContain("add column if not exists name_en text");
    expect(sql).toContain("alter table public.services");
    expect(sql).toContain("alter table public.profiles");
    expect(sql).toContain("add column if not exists display_name_ar text");
    expect(sql).toContain("add column if not exists display_name_en text");
  });

  it("declares them nullable, with no default and no NOT NULL", () => {
    expect(sql).not.toMatch(/add column[^;]*not null/i);
    expect(sql).not.toMatch(/add column[^;]*default/i);
  });

  it("backfills nothing", () => {
    // The single most important assertion in this file. No UPDATE, no INSERT,
    // and no expression that could derive one name from another.
    expect(sql).not.toMatch(/\bupdate\s+public\./i);
    expect(sql).not.toMatch(/\binsert\s+into\b/i);
    expect(sql).not.toMatch(/\bcoalesce\s*\(\s*name/i);
    expect(sql).not.toMatch(/\btranslate\s*\(/i);
  });

  it("touches no canonical name column and redefines no function or policy", () => {
    expect(sql).not.toMatch(/alter\s+column\s+name\b/i);
    expect(sql).not.toMatch(/alter\s+column\s+full_name\b/i);
    expect(sql).not.toMatch(/drop\s+column/i);
    expect(sql).not.toMatch(/create\s+or\s+replace\s+function/i);
    expect(sql).not.toMatch(/create\s+policy|drop\s+policy/i);
    expect(sql).not.toMatch(/create\s+trigger/i);
    expect(sql).not.toMatch(/create\s+index/i);
  });

  it("bounds the length and nothing else about the content", () => {
    expect(sql).toContain("char_length(btrim(name_ar))");
    expect(sql).toContain("char_length(btrim(display_name_ar))");
    // No shape check: a clinic's own transliterated brand name is a legitimate
    // Arabic display name and a script test would reject it.
    expect(sql).not.toMatch(/~\s*'\[\\u0600/);
  });

  it("documents what the columns are and are not", () => {
    expect(raw).toContain("comment on column public.departments.name_ar");
    expect(raw).toContain("Never machine-generated");
  });
});

describe("the application does not require the migration to have run", () => {
  it("reads display names through the drop-and-retry helper", () => {
    const helper = readFileSync("lib/settings/display-names.ts", "utf8");
    expect(helper).toContain("export async function selectWithOptional");

    const directory = readFileSync("lib/ai/doctor-directory.ts", "utf8");
    expect(directory).toContain("selectWithOptional");
    expect(directory).toContain("DEPARTMENT_DISPLAY_COLUMNS");
    expect(directory).toContain("STAFF_DISPLAY_COLUMNS");

    const tools = readFileSync("lib/ai/v2/tools.ts", "utf8");
    expect(tools).toContain("SERVICE_DISPLAY_COLUMNS");
    expect(tools).toContain("selectWithOptional");
  });

  it("omits an unset display name from the write instead of storing a blank", () => {
    // P12B — the normaliser moved out of `lib/settings/mutations.ts` and into
    // `lib/settings/display-names.ts`, beside the reader whose blank/NULL
    // equivalence it exists to preserve, when the package templates (which are
    // written by `lib/billing/mutations.ts`, not by the settings directory
    // path) needed the same treatment. One copy, three callers.
    const displayNames = readFileSync("lib/settings/display-names.ts", "utf8");
    expect(displayNames).toContain("export function stripBlankDisplayNames");
    // A clinic that has typed no display name sends the payload it always sent,
    // which is what keeps the settings screens working before the migration.
    expect(displayNames).toContain("else delete next[key];");
    for (const file of ["lib/settings/mutations.ts", "lib/billing/mutations.ts"]) {
      expect(readFileSync(file, "utf8")).toContain("stripBlankDisplayNames");
    }
  });
});
