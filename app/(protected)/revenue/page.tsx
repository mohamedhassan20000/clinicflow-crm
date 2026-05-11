import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { requireUser } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";
import { RevenueReport } from "@/components/revenue/revenue-report";
import { RevenueFilters } from "@/components/revenue/revenue-filters";
import {
  PrintButton,
  PrintSettlementsButton,
} from "@/components/revenue/print-button";

export const metadata: Metadata = { title: "Revenue transactions" };

type PresetKey = "today" | "week" | "this_month" | "last_month" | "last_year" | "custom";
const REVENUE_PAGE_SIZE = 50;
const SETTLEMENT_DETAIL_LIMIT = 50;

// ─── date helpers (Europe/Istanbul) ─────────────────────────────────────────
function toIstanbul(date: Date): Date {
  return new Date(date.toLocaleString("en-US", { timeZone: "Europe/Istanbul" }));
}

function startOfDay(d: Date): Date {
  const n = new Date(d);
  n.setHours(0, 0, 0, 0);
  return n;
}
function endOfDay(d: Date): Date {
  const n = new Date(d);
  n.setHours(23, 59, 59, 999);
  return n;
}
function fmtInput(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function resolveRange(preset: PresetKey, from?: string, to?: string) {
  const now = toIstanbul(new Date());
  if (preset === "custom" && from && to) {
    return {
      start: startOfDay(new Date(from)),
      end: endOfDay(new Date(to)),
    };
  }
  switch (preset) {
    case "today": {
      return { start: startOfDay(now), end: endOfDay(now) };
    }
    case "week": {
      const day = now.getDay();
      const diff = day === 0 ? -6 : 1 - day;
      const mon = new Date(now);
      mon.setDate(mon.getDate() + diff);
      const sun = new Date(mon);
      sun.setDate(sun.getDate() + 6);
      return { start: startOfDay(mon), end: endOfDay(sun) };
    }
    case "last_month": {
      const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const last = new Date(now.getFullYear(), now.getMonth(), 0);
      return { start: startOfDay(first), end: endOfDay(last) };
    }
    case "last_year": {
      const first = new Date(now.getFullYear() - 1, 0, 1);
      const last = new Date(now.getFullYear() - 1, 11, 31);
      return { start: startOfDay(first), end: endOfDay(last) };
    }
    case "this_month":
    default: {
      const first = new Date(now.getFullYear(), now.getMonth(), 1);
      const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      return { start: startOfDay(first), end: endOfDay(last) };
    }
  }
}

interface PageProps {
  searchParams: Promise<{
    preset?: string;
    from?: string;
    to?: string;
    dept?: string;
    doctor?: string;
    q?: string;
    name?: string;
    file?: string;
    nat?: string;
    phone?: string;
    page?: string;
  }>;
}

type RevenueSummary = {
  totalAmount: number;
  primaryTotal: number;
  secondaryTotal: number;
  insuranceTotal: number;
  depositTotal: number;
  outstandingTotal: number;
  settlementsTotal: number;
  grossTotal: number;
  transactionCount: number;
  settlementCount: number;
  methodBreakdown: { method: string; amount: number }[];
};

const EMPTY_REVENUE_SUMMARY: RevenueSummary = {
  totalAmount: 0,
  primaryTotal: 0,
  secondaryTotal: 0,
  insuranceTotal: 0,
  depositTotal: 0,
  outstandingTotal: 0,
  settlementsTotal: 0,
  grossTotal: 0,
  transactionCount: 0,
  settlementCount: 0,
  methodBreakdown: [],
};

function toNumber(value: unknown) {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function normalizeRevenueSummary(value: unknown): RevenueSummary {
  if (!value || typeof value !== "object") return EMPTY_REVENUE_SUMMARY;
  const raw = value as Record<string, unknown>;
  const methodBreakdown = Array.isArray(raw.methodBreakdown)
    ? raw.methodBreakdown
        .map((entry) => {
          if (!entry || typeof entry !== "object") return null;
          const row = entry as Record<string, unknown>;
          const method = typeof row.method === "string" ? row.method : null;
          if (!method) return null;
          return { method, amount: toNumber(row.amount) };
        })
        .filter((entry): entry is { method: string; amount: number } => Boolean(entry))
    : [];

  return {
    totalAmount: toNumber(raw.totalAmount),
    primaryTotal: toNumber(raw.primaryTotal),
    secondaryTotal: toNumber(raw.secondaryTotal),
    insuranceTotal: toNumber(raw.insuranceTotal),
    depositTotal: toNumber(raw.depositTotal),
    outstandingTotal: toNumber(raw.outstandingTotal),
    settlementsTotal: toNumber(raw.settlementsTotal),
    grossTotal: toNumber(raw.grossTotal),
    transactionCount: toNumber(raw.transactionCount),
    settlementCount: toNumber(raw.settlementCount),
    methodBreakdown,
  };
}

export default async function RevenuePage({ searchParams }: PageProps) {
  const user = await requireUser();
  if (user.role === "receptionist") redirect("/dashboard");

  const sp = await searchParams;
  const preset = (sp.preset as PresetKey) ?? "this_month";
  const range = resolveRange(preset, sp.from, sp.to);
  const filterDept = sp.dept?.trim() || null;
  const filterDoctor = sp.doctor?.trim() || null;
  const filterPatientQ = sp.q?.trim() || "";
  const filterName = sp.name?.trim() || "";
  const filterFile = sp.file?.trim() || "";
  const filterNat = sp.nat?.trim() || "";
  const filterPhone = sp.phone?.trim() || "";
  const currentPage = Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1);
  const rowFrom = (currentPage - 1) * REVENUE_PAGE_SIZE;

  const supabase = await createClient();

  // Resolve patient search → list of matching patient IDs (so we can scope
  // appointments + settlements with a single .in() filter).
  let patientIdFilter: string[] | null = null;
  if (filterPatientQ || filterName || filterFile || filterNat || filterPhone) {
    let patientQuery = supabase
      .from("patients")
      .select("id")
      .eq("clinic_id", user.clinicId)
      .limit(500);
    if (filterPatientQ) {
      patientQuery = patientQuery.or(
        `full_name.ilike.%${filterPatientQ}%,phone.ilike.%${filterPatientQ}%,file_number.ilike.%${filterPatientQ}%,national_id.ilike.%${filterPatientQ}%`,
      );
    }
    if (filterName) patientQuery = patientQuery.ilike("full_name", `%${filterName}%`);
    if (filterFile) patientQuery = patientQuery.ilike("file_number", `%${filterFile}%`);
    if (filterNat) patientQuery = patientQuery.ilike("national_id", `%${filterNat}%`);
    if (filterPhone) patientQuery = patientQuery.ilike("phone", `%${filterPhone}%`);
    const { data: matches } = await patientQuery;
    patientIdFilter = (matches ?? []).map((m) => m.id);
  }
  const hasNoPatientMatches = patientIdFilter !== null && patientIdFilter.length === 0;

  const summaryPromise = supabase.rpc("get_revenue_summary" as never, {
    p_start: range.start.toISOString(),
    p_end: range.end.toISOString(),
    p_department_id: filterDept,
    p_doctor_id: filterDoctor,
    p_patient_ids: patientIdFilter,
  } as never);

  let rowsQuery = supabase
    .from("appointments")
    .select(
      "id, scheduled_at, paid_at, total_amount, paid_amount, insurance_amount, secondary_amount, deposit_amount, outstanding_amount, payment_method, secondary_payment_method, payment_note, patients(full_name), profiles!doctor_id(full_name), departments(name, color), insurance_providers(name)",
    )
    .eq("clinic_id", user.clinicId)
    .eq("status", "completed")
    .gte("paid_at", range.start.toISOString())
    .lte("paid_at", range.end.toISOString())
    .order("paid_at", { ascending: false })
    .range(rowFrom, rowFrom + REVENUE_PAGE_SIZE - 1);

  if (filterDept) rowsQuery = rowsQuery.eq("department_id", filterDept);
  if (filterDoctor) rowsQuery = rowsQuery.eq("doctor_id", filterDoctor);
  if (patientIdFilter) rowsQuery = rowsQuery.in("patient_id", patientIdFilter);

  const settlementAppointmentJoin =
    filterDept || filterDoctor
      ? "appointment:appointments!inner(id, scheduled_at, department_id, total_amount, outstanding_amount, doctor_id, profiles!doctor_id(full_name), departments(name, color))"
      : "appointment:appointments!appointment_id(id, scheduled_at, department_id, total_amount, outstanding_amount, doctor_id, profiles!doctor_id(full_name), departments(name, color))";
  let settlementsQuery = supabase
    .from("outstanding_settlements")
    .select(
      `id, appointment_id, settled_at, amount, payment_method, note, patient:patients(full_name), ${settlementAppointmentJoin}`,
    )
    .eq("clinic_id", user.clinicId)
    .gte("settled_at", range.start.toISOString())
    .lte("settled_at", range.end.toISOString())
    .order("settled_at", { ascending: false })
    .limit(SETTLEMENT_DETAIL_LIMIT);

  if (patientIdFilter)
    settlementsQuery = settlementsQuery.in("patient_id", patientIdFilter);
  if (filterDept) settlementsQuery = settlementsQuery.eq("appointment.department_id", filterDept);
  if (filterDoctor) settlementsQuery = settlementsQuery.eq("appointment.doctor_id", filterDoctor);

  const [{ data: summaryRaw }, rowsResult, settlementsResult] =
    hasNoPatientMatches
      ? await Promise.all([
          summaryPromise,
          Promise.resolve({ data: [] }),
          Promise.resolve({ data: [] }),
        ])
      : await Promise.all([summaryPromise, rowsQuery, settlementsQuery]);

  const summary = normalizeRevenueSummary(summaryRaw);
  const rows = rowsResult.data ?? [];
  const settlements = settlementsResult.data ?? [];

  const [{ data: departments }, { data: doctors }] = await Promise.all([
    supabase
      .from("departments")
      .select("id, name, color")
      .eq("clinic_id", user.clinicId)
      .eq("is_active", true)
      .order("name"),
    supabase
      .from("profiles")
      .select("id, full_name")
      .eq("clinic_id", user.clinicId)
      .eq("role", "doctor")
      .eq("is_active", true)
      .order("full_name"),
  ]);

  const { data: clinic } = await supabase
    .from("clinics")
    .select("name, address, phone")
    .eq("id", user.clinicId)
    .single();

  const fromInput = sp.from ?? fmtInput(range.start);
  const toInput = sp.to ?? fmtInput(range.end);

  return (
    <div className="space-y-6">
      {/* Header — hidden in print */}
      <div className="print:hidden flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Link
            href="/dashboard"
            className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <ChevronLeft className="h-4 w-4" />
            Dashboard
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight">
            Revenue &amp; Transactions
          </h1>
        </div>
      </div>

      <div className="print:hidden">
        <RevenueFilters
          departments={departments ?? []}
          doctors={doctors ?? []}
          actions={
            <>
              <PrintSettlementsButton
                disabled={(settlements ?? []).length === 0}
              />
              <PrintButton />
            </>
          }
        />
      </div>

      <RevenueReport
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        rows={(rows ?? []) as any}
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        settlements={(settlements ?? []) as any}
        summary={summary}
        page={currentPage}
        pageSize={REVENUE_PAGE_SIZE}
        settlementDetailLimit={SETTLEMENT_DETAIL_LIMIT}
        range={{
          start: range.start.toISOString(),
          end: range.end.toISOString(),
        }}
        preset={preset}
        fromInput={fromInput}
        toInput={toInput}
        clinicName={clinic?.name ?? "ClinicFlow"}
        clinicAddress={clinic?.address ?? null}
        clinicPhone={clinic?.phone ?? null}
      />
    </div>
  );
}
