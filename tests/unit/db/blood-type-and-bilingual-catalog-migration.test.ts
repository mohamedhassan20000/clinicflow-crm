/**
 * Two schema-side contracts this pass depends on, asserted against the SQL.
 *
 * ## 1. Blood type survives approval
 *
 * Manual QA found blood type missing from the pending-patient review modal and
 * asked whether the seam dropped it. It does not, and this pins that: the
 * currently-effective `approve_ai_patient_intake` — the last `create or
 * replace` of it, in the identity-discovery migration — names `blood_type` in
 * both the column list and the values list of its `insert into public.patients`.
 * Nothing about that write changed in this pass; the missing part was the read
 * on the review screen, which now shows the field.
 *
 * The assertion is deliberately against the SQL rather than a live database:
 * this is a property of the migration history, it must hold on any clinic's
 * schema, and it must fail loudly if a future `create or replace` of that
 * function drops the column the way the two versions before it did.
 *
 * ## 2. The bilingual catalog migration is additive and unapplied-safe
 *
 * The package and insurance display names follow the shape the department,
 * service and staff names already established: two nullable columns, a length
 * check, comments, and nothing else. No backfill, no RPC, no policy, no
 * trigger, no index.
 */

import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const MIGRATIONS = "supabase/migrations";
const BILINGUAL_CATALOG =
  `${MIGRATIONS}/20260917120000_bilingual_package_and_insurance_names.sql`;

const catalog = readFileSync(BILINGUAL_CATALOG, "utf8");

/**
 * The file with its `--` commentary stripped.
 *
 * The destructive-SQL assertions below have to read statements, not prose: this
 * migration's header explains how to reverse it, and "four DROP COLUMN
 * statements" in a sentence is documentation rather than something that runs.
 */
const statements = catalog
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");

/** The last `create or replace` of a function across the whole history. */
function effectiveDefinition(functionName: string): string {
  const files = readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  let latest = "";
  for (const file of files) {
    const sql = readFileSync(`${MIGRATIONS}/${file}`, "utf8");
    const marker = `create or replace function public.${functionName}(`;
    const at = sql.lastIndexOf(marker);
    if (at === -1) continue;
    const end = sql.indexOf("\n$$;", at);
    latest = sql.slice(at, end === -1 ? undefined : end);
  }
  return latest;
}

describe("blood type reaches the patient record on approval", () => {
  const approve = effectiveDefinition("approve_ai_patient_intake");

  it("has an effective definition to read", () => {
    expect(approve).not.toBe("");
  });

  it("copies the intake's blood group onto the new patients row", () => {
    const insert = approve.slice(approve.indexOf("insert into public.patients"));
    expect(insert).toContain("blood_type");
    expect(insert).toContain("v_intake.blood_type");
  });
});

describe("the bilingual package and insurance migration", () => {
  it("adds nullable display-name columns to both tables", () => {
    expect(catalog).toContain("alter table public.package_templates");
    expect(catalog).toContain("alter table public.insurance_providers");
    expect(catalog).toContain("add column if not exists name_ar text");
    expect(catalog).toContain("add column if not exists name_en text");
  });

  it("bounds them by length and by nothing else", () => {
    expect(catalog).toContain("package_templates_display_name_length");
    expect(catalog).toContain("insurance_providers_display_name_length");
    expect(catalog).toContain("char_length(btrim(name_ar))");
  });

  it("writes no data", () => {
    // The rule that keeps a patient-facing name one a person authored: there is
    // no statement here that can put a value into these columns.
    expect(statements).not.toMatch(/\bupdate\s+public\./i);
    expect(statements).not.toMatch(/\binsert\s+into\b/i);
  });

  it("redefines no function, policy, trigger or index", () => {
    // In particular `list_clinic_public_packages` keeps its exact signature —
    // the localized catalog is read from the table under the same visibility
    // rule rather than by changing an applied RPC.
    expect(statements).not.toMatch(/create\s+(or\s+replace\s+)?function/i);
    expect(statements).not.toMatch(/create\s+policy|alter\s+policy|drop\s+policy/i);
    expect(statements).not.toMatch(/create\s+trigger|drop\s+trigger/i);
    expect(statements).not.toMatch(/create\s+(unique\s+)?index/i);
    expect(statements).not.toMatch(/drop\s+column|drop\s+table/i);
  });

  it("sorts after the display-name migration it extends", () => {
    // A timestamp before `20260916120000` would order ahead of an already
    // applied file and never run.
    expect(BILINGUAL_CATALOG > `${MIGRATIONS}/20260916120000_bilingual_display_names.sql`).toBe(
      true,
    );
  });

  it("does not edit the migration that has already been applied", () => {
    const applied = readFileSync(
      `${MIGRATIONS}/20260916120000_bilingual_display_names.sql`,
      "utf8",
    );
    expect(applied).not.toContain("package_templates");
    expect(applied).not.toContain("insurance_providers");
  });
});

describe("the types keep step with the migration", () => {
  const types = readFileSync("types/database.ts", "utf8");

  it("declares the new columns on both tables", () => {
    const insurance = types.slice(
      types.indexOf("insurance_providers: {"),
      types.indexOf("lab_request_tests: {"),
    );
    expect(insurance).toContain("name_ar");
    expect(insurance).toContain("name_en");
    const packages = types.slice(types.indexOf("package_templates: {"));
    expect(packages.slice(0, 2000)).toContain("name_ar");
    expect(packages.slice(0, 2000)).toContain("name_en");
  });
});
