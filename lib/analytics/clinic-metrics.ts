import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Clinic aggregate metrics — one definition, two readers.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The platform owner's clinic page and the clinic admin's own dashboard show
 * the same seven counts. They must mean the same thing on both screens, or the
 * first support conversation that compares them is unwinnable — so the meaning
 * lives here once and each caller supplies only its own client.
 *
 * PRIVACY: every query in this module is `head: true` with `count: "exact"`.
 * PostgREST returns a count and **zero rows**; no patient, appointment,
 * document, invoice, message, or note content can leave through this path even
 * by accident. Adding a non-head select here would break that guarantee, which
 * is why the helper below is the only query builder in the file.
 *
 * TENANT ISOLATION: every query is filtered by `clinic_id`. The clinic-admin
 * caller additionally runs on an RLS client, so its own `clinic_id` is enforced
 * twice — once here and once by the database policy.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DEFINITIONS (what each number counts, and what it deliberately excludes)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *  patients            `patients` rows for the clinic that are not soft-deleted.
 *                      Archived patients ARE counted: archiving is a workflow
 *                      state, not a deletion, and the record still exists.
 *
 *  appointments        `appointments` rows that are not soft-deleted and whose
 *                      status is not `replaced`. A rescheduled appointment
 *                      leaves the original behind as `replaced` pointing at its
 *                      successor; counting both double-counts one booking.
 *                      Cancelled and no-show appointments ARE counted — they
 *                      were booked, and excluding them would make this number
 *                      disagree with every cancellation and no-show report.
 *
 *  documentsIssued     `documents` rows with status `issued`. That status is
 *                      the only one that means "a numbered PDF exists and still
 *                      stands": `rendering`/`failed` never produced one, and
 *                      `void`/`cancelled` were withdrawn afterwards.
 *
 *  invoicesIssued      The `INVOICE` subset of documentsIssued. ClinicFlow has
 *                      no separate invoices table; an invoice IS a document of
 *                      that type, so this is a subset of the count above and
 *                      not an additional independent total.
 *
 *  activeStaff         `profiles` rows for the clinic that are active and not
 *                      soft-deleted — people who can sign in today, not every
 *                      account ever created.
 *
 *  departments         `departments` rows that are not soft-deleted.
 *
 *  insuranceCompanies  `insurance_providers` rows that are not soft-deleted.
 *                      Inactive providers ARE counted: they remain referenced
 *                      by historical appointments and are configuration, not
 *                      activity.
 *
 * Period metrics use the row's own creation/issuance instant:
 * `patients.created_at`, `appointments.created_at` (when the booking was made,
 * not when it is scheduled), `documents.issued_at`.
 */

type Client = SupabaseClient<Database>;

export type ClinicMetricTotals = {
  patients: number;
  appointments: number;
  documentsIssued: number;
  invoicesIssued: number;
  activeStaff: number;
  departments: number;
  insuranceCompanies: number;
};

export type ClinicMetricPeriod = {
  patients: number;
  appointments: number;
  documentsIssued: number;
  invoicesIssued: number;
};

export type ClinicMetricTrend = {
  current: ClinicMetricPeriod;
  previous: ClinicMetricPeriod;
  /** Percent change per metric, or null when the previous period was zero. */
  change: Record<keyof ClinicMetricPeriod, number | null>;
};

export type ClinicMetrics = {
  totals: ClinicMetricTotals;
  trend: ClinicMetricTrend;
  window: { currentStart: string; previousStart: string; nextStart: string };
};

/** Percent change, or null when there is no baseline to compare against. */
export function percentChange(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return Math.round(((current - previous) / previous) * 100);
}

/** UTC month boundaries: previous month start, current month start, next month start. */
export function monthWindow(now: Date): {
  currentStart: string;
  previousStart: string;
  nextStart: string;
} {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const iso = (y: number, m: number) => new Date(Date.UTC(y, m, 1)).toISOString();
  return {
    previousStart: iso(year, month - 1),
    currentStart: iso(year, month),
    nextStart: iso(year, month + 1),
  };
}

/**
 * Turns settled PostgREST count responses into numbers, treating a rejected or
 * errored counter as 0 (see the note on getClinicMetrics).
 */
function unwrap(results: readonly PromiseSettledResult<unknown>[]): number[] {
  return results.map((result) => {
    if (result.status !== "fulfilled") return 0;
    const value = result.value as { count?: number | null; error?: unknown } | null;
    if (!value || value.error) return 0;
    return typeof value.count === "number" ? value.count : 0;
  });
}

/**
 * The only place a metric query is built. `head: true` guarantees the response
 * carries a count and no rows.
 */
function counters(db: Client, clinicId: string) {
  const patients = () =>
    db.from("patients").select("id", { count: "exact", head: true }).eq("clinic_id", clinicId).eq("is_deleted", false);
  const appointments = () =>
    db
      .from("appointments")
      .select("id", { count: "exact", head: true })
      .eq("clinic_id", clinicId)
      .is("deleted_at", null)
      .neq("status", "replaced");
  const documents = () =>
    db.from("documents").select("id", { count: "exact", head: true }).eq("clinic_id", clinicId).eq("status", "issued");
  return { patients, appointments, documents };
}

async function periodCounts(
  db: Client,
  clinicId: string,
  fromInclusive: string,
  toExclusive: string,
): Promise<ClinicMetricPeriod> {
  const { patients, appointments, documents } = counters(db, clinicId);
  const [patientCount, appointmentCount, documentCount, invoiceCount] = unwrap(
    await Promise.allSettled([
      patients().gte("created_at", fromInclusive).lt("created_at", toExclusive),
      appointments().gte("created_at", fromInclusive).lt("created_at", toExclusive),
      documents().gte("issued_at", fromInclusive).lt("issued_at", toExclusive),
      documents().eq("doc_type", "INVOICE").gte("issued_at", fromInclusive).lt("issued_at", toExclusive),
    ]),
  );
  return {
    patients: patientCount,
    appointments: appointmentCount,
    documentsIssued: documentCount,
    invoicesIssued: invoiceCount,
  };
}

/**
 * Aggregate-only clinic metrics. Returns counts and nothing else.
 *
 * A metric whose query fails (a table absent in this environment, a permission
 * refusal) reports 0 rather than failing the whole page: an owner console that
 * goes blank because one counter is unavailable is worse than one that shows
 * the six numbers it does have.
 */
export async function getClinicMetrics(
  db: Client,
  clinicId: string,
  now = new Date(),
): Promise<ClinicMetrics> {
  const window = monthWindow(now);
  const { patients, appointments, documents } = counters(db, clinicId);

  const [settledTotals, current, previous] = await Promise.all([
    Promise.allSettled([
      patients(),
      appointments(),
      documents(),
      documents().eq("doc_type", "INVOICE"),
      db
        .from("profiles")
        .select("id", { count: "exact", head: true })
        .eq("clinic_id", clinicId)
        .eq("is_active", true)
        .eq("is_deleted", false),
      db
        .from("departments")
        .select("id", { count: "exact", head: true })
        .eq("clinic_id", clinicId)
        .is("deleted_at", null),
      db
        .from("insurance_providers")
        .select("id", { count: "exact", head: true })
        .eq("clinic_id", clinicId)
        .is("deleted_at", null),
    ]),
    periodCounts(db, clinicId, window.currentStart, window.nextStart),
    periodCounts(db, clinicId, window.previousStart, window.currentStart),
  ]);

  const totalsRaw = unwrap(settledTotals);
  const totals: ClinicMetricTotals = {
    patients: totalsRaw[0],
    appointments: totalsRaw[1],
    documentsIssued: totalsRaw[2],
    invoicesIssued: totalsRaw[3],
    activeStaff: totalsRaw[4],
    departments: totalsRaw[5],
    insuranceCompanies: totalsRaw[6],
  };

  return {
    totals,
    trend: {
      current,
      previous,
      change: {
        patients: percentChange(current.patients, previous.patients),
        appointments: percentChange(current.appointments, previous.appointments),
        documentsIssued: percentChange(current.documentsIssued, previous.documentsIssued),
        invoicesIssued: percentChange(current.invoicesIssued, previous.invoicesIssued),
      },
    },
    window,
  };
}
