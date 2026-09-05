/**
 * P13 — owner analytics against the real local database.
 *
 * The unit suites pin the arithmetic and the call sites with doubles. This one
 * asserts the two things only a database can answer:
 *
 *  • `operator_ai_allowance_report` really exists, really refuses a caller who
 *    is not a platform admin, and really returns the shape the console reads.
 *    (Its absence — PostgREST PGRST202 — is exactly the failure that took the
 *    owner console down, so "the function is present and callable" is a
 *    regression worth owning.)
 *  • the aggregate counters are tenant-isolated: an authenticated clinic member
 *    counts their own clinic and gets zero for another one, under RLS.
 *
 * Requires the local Supabase stack (`supabase start`) and the dev clinic
 * fixture, which it seeds itself.
 */
import { createClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";
import { getClinicMetrics } from "@/lib/analytics/clinic-metrics";
import { DEV_CLINIC, seedDevClinic } from "@/scripts/seed-dev-clinic";
import type { Database } from "@/types/database";

const url = process.env.LOCAL_SUPABASE_URL ?? "http://127.0.0.1:54321";

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}

const service = createClient<Database>(url, required("LOCAL_SUPABASE_SECRET_KEY"), {
  auth: { autoRefreshToken: false, persistSession: false },
});

const anon = () =>
  createClient<Database>(url, required("LOCAL_SUPABASE_PUBLISHABLE_KEY"), {
    auth: { autoRefreshToken: false, persistSession: false },
  });

function monthStartUtc(now = new Date()) {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

/** A second clinic, so "isolated" is a claim with something to be isolated from. */
const OTHER_CLINIC_ID = "d0d0d0d0-0000-4000-8000-00000000d13a";

beforeAll(async () => {
  await seedDevClinic();

  const existing = await service.from("clinics").select("id").eq("id", OTHER_CLINIC_ID).maybeSingle();
  if (!existing.data) {
    const { error } = await service.from("clinics").insert({
      id: OTHER_CLINIC_ID,
      name: "P13 Isolation Control Clinic",
      country: "TR",
      timezone: "Europe/Istanbul",
      locale: "en",
      phone: "+905550000000",
    });
    if (error) throw error;
  }
}, 120_000);

describe("operator_ai_allowance_report", () => {
  it("exists and is callable by the service role", async () => {
    const { data, error } = await service.rpc("operator_ai_allowance_report", {
      p_period_start: monthStartUtc(),
    });

    // The regression: a missing function answers PGRST202 and the console goes
    // dark with a generic message.
    expect(error?.code).not.toBe("PGRST202");
    expect(error).toBeNull();
    expect(Array.isArray(data)).toBe(true);
  });

  it("returns the columns the owner console reads", async () => {
    const { data } = await service.rpc("operator_ai_allowance_report", {
      p_period_start: monthStartUtc(),
    });
    const row = (data ?? []).find((candidate) => candidate.clinic_id === DEV_CLINIC.id);
    expect(row, "the Pro + AI dev clinic must appear on the allowance console").toBeDefined();

    for (const column of [
      "clinic_name",
      "plan_slug",
      "plan_included_micros",
      "override_included_micros",
      "effective_included_micros",
      "total_allowance_micros",
      "managed_spent_micros",
      "managed_reserved_micros",
      "remaining_micros",
      "used_percent",
      "period_reset_at",
      "credential_mode",
      "byok_configured",
      "status",
    ]) {
      expect(row, `${column} is missing from the report`).toHaveProperty(column);
    }
    expect(row!.used_percent).toBeGreaterThanOrEqual(0);
    expect(row!.used_percent).toBeLessThanOrEqual(100);
  });

  it("refuses an anonymous caller", async () => {
    const { error } = await anon().rpc("operator_ai_allowance_report", {
      p_period_start: monthStartUtc(),
    });
    expect(error).not.toBeNull();
    expect(error?.code).not.toBe("PGRST202");
  });

  it("rejects a period that is not a month start", async () => {
    const { error } = await service.rpc("operator_ai_allowance_report", {
      p_period_start: "2026-08-15",
    });
    expect(error?.message).toContain("AI_REPORT_INVALID_PERIOD");
  });

  it("scopes to one clinic when asked", async () => {
    const { data, error } = await service.rpc("operator_ai_allowance_report", {
      p_period_start: monthStartUtc(),
      p_clinic_id: DEV_CLINIC.id,
    });
    expect(error).toBeNull();
    expect((data ?? []).every((row) => row.clinic_id === DEV_CLINIC.id)).toBe(true);
  });
});

describe("aggregate counts under RLS", () => {
  it("gives a clinic member their own clinic's counts", async () => {
    const client = anon();
    const admin = DEV_CLINIC.staff.find((member) => member.key === "admin") ?? DEV_CLINIC.staff[0];
    const signIn = await client.auth.signInWithPassword({
      email: admin.email,
      password: DEV_CLINIC.password,
    });
    expect(signIn.error, "the dev clinic admin must be able to sign in").toBeNull();

    const own = await getClinicMetrics(client, DEV_CLINIC.id);
    expect(own.totals.activeStaff).toBeGreaterThan(0);
    expect(own.totals.patients).toBeGreaterThanOrEqual(0);

    // The same helper pointed at another tenant returns nothing, because RLS —
    // not the helper — is what decides which rows are visible.
    const foreign = await getClinicMetrics(client, OTHER_CLINIC_ID);
    expect(foreign.totals).toEqual({
      patients: 0,
      appointments: 0,
      documentsIssued: 0,
      invoicesIssued: 0,
      activeStaff: 0,
      departments: 0,
      insuranceCompanies: 0,
    });

    await client.auth.signOut();
  });

  it("gives an anonymous caller nothing at all", async () => {
    const metrics = await getClinicMetrics(anon(), DEV_CLINIC.id);
    expect(Object.values(metrics.totals).every((count) => count === 0)).toBe(true);
  });
});
