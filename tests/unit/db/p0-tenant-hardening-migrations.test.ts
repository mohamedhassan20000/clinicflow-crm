import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migrationsDir = join(process.cwd(), "supabase", "migrations");

function migration(name: string) {
  return readFileSync(join(migrationsDir, name), "utf8");
}

describe("P0 tenant hardening migrations", () => {
  it("drops broad clinic admin policies and keeps clinic reads scoped to auth_clinic_id", () => {
    const sql = migration("20260709090000_fix_clinics_cross_tenant_policies.sql");

    expect(sql).toContain('drop policy if exists "clinics_select_admin_all"');
    expect(sql).toContain('drop policy if exists "clinics_insert_admin"');
    expect(sql).toContain('create policy "clinics_select_own"');
    expect(sql).toContain("using (id = public.auth_clinic_id())");
    expect(sql).not.toContain("auth_role() = 'admin'");
  });

  it("adds per-clinic localization columns with safe defaults and checks", () => {
    const sql = migration("20260709091000_clinic_localization_columns.sql");

    expect(sql).toContain("add column if not exists timezone text not null default 'Asia/Kuwait'");
    expect(sql).toContain("add column if not exists currency char(3) not null default 'KWD'");
    expect(sql).toContain("add column if not exists locale text not null default 'ar'");
    expect(sql).toContain("add column if not exists country char(2) not null default 'KW'");
    expect(sql).toContain("clinics_week_start_check check (week_start between 0 and 6)");
    expect(sql).toContain("clinics_digits_check check (digits in ('latin', 'arabic'))");
  });

  it("backfills existing clinics to preserve legacy locale behavior", () => {
    const sql = migration("20260710090000_backfill_legacy_clinic_localization.sql");

    expect(sql).toContain("timezone = 'Europe/Istanbul'");
    expect(sql).toContain("currency = 'TRY'");
    expect(sql).toContain("locale = 'en'");
    expect(sql).toContain("created_at < timestamp with time zone '2026-07-10 00:00:00+00'");
  });
});
