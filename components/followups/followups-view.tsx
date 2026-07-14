"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";
import {
  ChevronLeft,
  ChevronRight,
  CalendarDays,
  CheckCircle2,
  Phone,
  PhoneOff,
  Pencil,
  Printer,
  Stethoscope,
  X,
  AlertCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { RecordFollowupDialog } from "@/components/followups/record-dialog";
import { PatientScopeFilterBar } from "@/components/shared/patient-scope-filter-bar";
import { PrintHeader } from "@/components/shared/print-header";
import { formatDoctorName } from "@/lib/format-doctor";
import { useTranslations } from "next-intl";
import { useClinicSettings } from "@/contexts/clinic-settings-context";

type Scope = "day" | "yesterday" | "week" | "month";

const SCOPE_OPTIONS: { value: Scope; labelKey: string }[] = [
  { value: "day", labelKey: "scopeToday" },
  { value: "yesterday", labelKey: "scopeYesterday" },
  { value: "week", labelKey: "scopeLastWeek" },
  { value: "month", labelKey: "scopeLastMonth" },
];

const UNASSIGNED_COLOR = "#94a3b8";
const UNASSIGNED_KEY = "__unassigned__";

interface Department {
  id: string;
  name: string;
  color: string;
}

interface PatientLite {
  id: string;
  full_name: string;
  phone: string;
  file_number: string | null;
  national_id: string | null;
  department_id: string | null;
}

export interface PendingRow {
  id: string;
  scheduled_at: string;
  paid_at: string | null;
  patient_id: string;
  department_id: string | null;
  doctor_id: string | null;
  total_amount: number | null;
  payment_note: string | null;
  patients: PatientLite | null;
  profiles: { full_name: string } | null;
  departments: Department | null;
}

export interface DoneRow {
  id: string;
  recorded_at: string;
  outcome: "all_fine" | "has_problem" | "no_response";
  notes: string | null;
  patient_id: string;
  appointment_id: string | null;
  patients: PatientLite | null;
  recorded_by: { full_name: string } | null;
  appointment: {
    id: string;
    scheduled_at: string;
    department_id: string | null;
    doctor_id: string | null;
    profiles: { full_name: string } | null;
    departments: Department | null;
  } | null;
}

type OutcomeFilter = "all_fine" | "has_problem" | "no_response" | null;

export interface FollowupsSummary {
  pendingCount: number;
  completedCount: number;
  allFineCount: number;
  hasProblemCount: number;
  noResponseCount: number;
}

interface Props {
  pending: PendingRow[];
  done: DoneRow[];
  summary: FollowupsSummary;
  pendingPreviewLimit: number;
  completedPage: number;
  completedPageSize: number;
  departments: Department[];
  doctors: { id: string; full_name: string }[];
  scope: Scope;
  dateInput: string;
  activeDept: string | null;
  hideScopeFilters?: boolean;
  activeOutcome: OutcomeFilter;
  activeQuery: string;
  range: { start: string; end: string };
  readOnly?: boolean;
  clinicName?: string;
  clinicAddress?: string | null;
  clinicPhone?: string | null;
  clinicLogoUrl?: string | null;
  generatedAt?: string;
}

const OUTCOME_META = {
  all_fine: {
    labelKey: "outcomeAllFine",
    className:
      "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
    icon: CheckCircle2,
  },
  has_problem: {
    labelKey: "outcomeHasProblem",
    className:
      "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
    icon: AlertCircle,
  },
  no_response: {
    labelKey: "outcomeNoResponse",
    className: "border-border/60 bg-muted/40 text-muted-foreground",
    icon: PhoneOff,
  },
} as const;

export function FollowupsView({
  pending,
  done,
  summary,
  pendingPreviewLimit,
  completedPage,
  completedPageSize,
  departments,
  doctors,
  scope,
  dateInput,
  activeDept,
  hideScopeFilters = false,
  activeOutcome,
  activeQuery,
  range,
  readOnly = false,
  clinicName,
  clinicAddress,
  clinicPhone,
  clinicLogoUrl,
  generatedAt,
}: Props) {
  const t = useTranslations("followups");
  const { formatDate, formatDateTime } = useClinicSettings();
  const fmtDate = (value: string) => formatDate(value, { day: "2-digit", month: "short", year: "numeric" });
  const fmtDateTime = (value: string) => formatDateTime(value, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  const router = useRouter();
  const params = useSearchParams();
  const [, startTransition] = useTransition();
  const [activeRow, setActiveRow] = useState<PendingRow | null>(null);
  const [editRow, setEditRow] = useState<DoneRow | null>(null);

  // Per-table pagination: each Awaiting group + the Completed table keeps its
  // own page index in local state. Reset to 1 whenever filters change.
  const PAGE_SIZE = 10;
  const [pendingPages, setPendingPages] = useState<Record<string, number>>({});
  const [donePages, setDonePages] = useState<Record<string, number>>({});
  const filtersKey = `${scope}|${dateInput}|${activeDept ?? ""}|${activeOutcome ?? ""}|${activeQuery}`;
  useEffect(() => {
    queueMicrotask(() => {
      setPendingPages({});
      setDonePages({});
    });
  }, [filtersKey]);
  function pendingPageFor(key: string) {
    return pendingPages[key] ?? 1;
  }
  function setPendingPage(key: string, n: number) {
    setPendingPages((prev) => ({ ...prev, [key]: Math.max(1, n) }));
  }
  function donePageFor(key: string) {
    return donePages[key] ?? 1;
  }
  function setDonePage(key: string, n: number) {
    setDonePages((prev) => ({ ...prev, [key]: Math.max(1, n) }));
  }

  function update(next: Record<string, string | null>) {
    const p = new URLSearchParams(params?.toString() ?? "");
    for (const [k, v] of Object.entries(next)) {
      if (v === null || v === "") p.delete(k);
      else p.set(k, v);
    }
    if (!Object.prototype.hasOwnProperty.call(next, "completedPage")) {
      p.delete("completedPage");
    }
    startTransition(() => router.push(`/followups?${p.toString()}`));
  }

  // Group pending by department.
  const pendingGroups = useMemo(() => {
    const map = new Map<
      string,
      { dept: Department | null; rows: PendingRow[] }
    >();
    for (const a of pending) {
      const dept = a.departments;
      const key = dept?.id ?? UNASSIGNED_KEY;
      if (!map.has(key)) map.set(key, { dept, rows: [] });
      map.get(key)!.rows.push(a);
    }
    return Array.from(map.values()).sort((a, b) => {
      if (!a.dept) return 1;
      if (!b.dept) return -1;
      return a.dept.name.localeCompare(b.dept.name);
    });
  }, [pending]);

  // Group done (Completed follow-ups) by department too — pulls from the
  // joined appointment row.
  const doneGroups = useMemo(() => {
    const map = new Map<string, { dept: Department | null; rows: DoneRow[] }>();
    for (const d of done) {
      const dept = d.appointment?.departments ?? null;
      const key = dept?.id ?? UNASSIGNED_KEY;
      if (!map.has(key)) map.set(key, { dept, rows: [] });
      map.get(key)!.rows.push(d);
    }
    return Array.from(map.values()).sort((a, b) => {
      if (!a.dept) return 1;
      if (!b.dept) return -1;
      return a.dept.name.localeCompare(b.dept.name);
    });
  }, [done]);

  const periodLabel =
    scope === "day" || scope === "yesterday"
      ? fmtDate(range.start)
      : `${fmtDate(range.start)} → ${fmtDate(range.end)}`;
  return (
    <div className="space-y-6">
      {clinicName !== undefined && (
        <PrintHeader
          clinicName={clinicName}
          clinicAddress={clinicAddress}
          clinicPhone={clinicPhone}
          logoUrl={clinicLogoUrl}
          documentName={t("patientFollowUps")}
          generatedAt={generatedAt ?? formatDateTime(new Date(), { dateStyle: "long", timeStyle: "short" })}
        />
      )}

      <div className="print:hidden flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Link
            href="/dashboard"
            className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <ChevronLeft className="h-4 w-4 rtl:rotate-180" />
            {t("dashboard")}</Link>
          <h1 className="text-2xl font-semibold tracking-tight">
            {t("patientFollowUps")}</h1>
        </div>
      </div>

      {/* Print-only document subtitle */}
      <div className="hidden print:block print:mb-4">
        <h1 className="text-xl font-semibold">{t("patientFollowUps")}</h1>
        <p className="text-xs text-muted-foreground">
          {t(SCOPE_OPTIONS.find((o) => o.value === scope)?.labelKey ?? t("scopetoday"))} ·{" "}
          {periodLabel}
          {activeDept && t("departmentFilter", { department: departments.find((d) => d.id === activeDept)?.name ?? "—" })}
          {activeQuery && t("patientFilter", { patient: activeQuery })}
        </p>
      </div>

      {/* Period toggle — independent from the search/filter row below */}
      <div className="flex flex-wrap items-center gap-3 print:hidden">
        <div className="inline-flex flex-wrap items-center gap-0.5 rounded-lg border border-border/60 bg-muted/40 p-0.5">
          {SCOPE_OPTIONS.map(({ value, labelKey }) => {
            const active = scope === value;
            return (
              <button
                key={value}
                type="button"
                onClick={() => update({ scope: value })}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition",
                  active
                    ? "bg-card text-foreground shadow-sm ring-1 ring-border/60"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <CalendarDays className="h-3.5 w-3.5" />
                {t(labelKey)}
              </button>
            );
          })}
        </div>
        <Input
          type="date"
          value={dateInput}
          onChange={(e) => update({ date: e.target.value || null })}
          className="h-8 w-[160px] text-xs"
        />
        {dateInput && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-xs text-muted-foreground"
            onClick={() => update({ date: null })}
          >
            <X className="h-3.5 w-3.5" />
            {t("clearDate")}</Button>
        )}
        <span className="text-xs text-muted-foreground">{periodLabel}</span>
      </div>

      {/* Day picker — visible when scope is "week" (strip) or "month"
          (calendar grid). Clicking a day drills into that day's follow-ups. */}
      {(scope === "week" || scope === "month") && (
        <DayPicker
          scope={scope}
          range={range}
          onPickDay={(d) => update({ scope: "day", date: d })}
        />
      )}

      {/* Search + filter row — independent of the period toggle */}
      <PatientScopeFilterBar
        basePath="/followups"
        doctors={doctors}
        departments={departments}
        hideDoctorFilter={readOnly || hideScopeFilters}
        hideDeptFilter={readOnly || hideScopeFilters}
        className="print:hidden"
        fallbackParams={{ name: ["q"] }}
        resetParamsOnApply={["completedPage"]}
        clearExtraParams={["q"]}
        actions={<FollowupsPrintButton />}
      />

      {/* Summary strip */}
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border/50 bg-border/40 sm:grid-cols-4">
        <SummaryCell label={t("awaitingFollowUp")} value={summary.pendingCount} />
        <SummaryCell
          label={t("allFine")}
          value={summary.allFineCount}
          accent="text-emerald-600 dark:text-emerald-400"
        />
        <SummaryCell
          label={t("reportedAProblem")}
          value={summary.hasProblemCount}
          accent="text-amber-600 dark:text-amber-400"
        />
        <SummaryCell
          label={t("noResponse")}
          value={summary.noResponseCount}
          accent="text-muted-foreground"
        />
      </div>

      {/* Pending — grouped by department */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            {t("awaitingFollowUp")}</h2>
          <span className="text-xs text-muted-foreground">
            {t("patientCount", { count: summary.pendingCount })}
          </span>
        </div>

        {summary.pendingCount === 0 ? (
          <div className="rounded-xl border border-border/50 bg-card px-4 py-10 text-center text-sm text-muted-foreground">
            {t("allCaughtUpNoCompletedSessions")}</div>
        ) : (
          <div className="space-y-5">
            {pendingGroups.map((g) => {
              const color = g.dept?.color ?? UNASSIGNED_COLOR;
              const name = g.dept?.name ?? t("unassigned");
              return (
                <section
                  data-print-table-section
                  key={g.dept?.id ?? UNASSIGNED_KEY}
                  className="overflow-hidden rounded-xl border bg-card shadow-sm"
                  style={{
                    borderColor: `color-mix(in oklab, ${color} 35%, transparent)`,
                  }}
                >
                  <header
                    className="flex items-center justify-between gap-3 border-b px-4 py-3"
                    style={{
                      backgroundColor: `color-mix(in oklab, ${color} 10%, transparent)`,
                      borderColor: `color-mix(in oklab, ${color} 25%, transparent)`,
                    }}
                  >
                    <div className="flex items-center gap-3">
                      <span
                        aria-hidden
                        className="inline-block h-3 w-3 rounded-full"
                        style={{ backgroundColor: color }}
                      />
                      <h3
                        className="text-sm font-semibold tracking-tight"
                        style={{ color }}
                      >
                        {name}
                      </h3>
                    </div>
                    <span className="text-[11px] font-medium" style={{ color }}>
                      {t("patientCount", { count: g.rows.length })}
                    </span>
                  </header>
                  <div className="overflow-x-auto">
                    <Table className="min-w-[1040px] table-fixed">
                      <colgroup>
                        <col className="w-36" />
                        <col className="w-[22%]" />
                        <col className="w-32" />
                        <col className="w-44" />
                        <col className="w-40" />
                        <col className="w-48" />
                        <col className="w-36 print:hidden" />
                      </colgroup>
                      <TableHeader>
                        <TableRow>
                          <TableHead>{t("session")}</TableHead>
                          <TableHead>{t("patient")}</TableHead>
                          <TableHead>{t("file")}</TableHead>
                          <TableHead>{t("nationalId")}</TableHead>
                          <TableHead>{t("phone")}</TableHead>
                          <TableHead>{t("doctor")}</TableHead>
                          <TableHead className="text-end print:hidden">{t("action")}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {g.rows.map((a, i) => {
                          const groupKey = g.dept?.id ?? UNASSIGNED_KEY;
                          const gp = pendingPageFor(groupKey);
                          const onPage =
                            i >= (gp - 1) * PAGE_SIZE && i < gp * PAGE_SIZE;
                          return (
                          <TableRow
                            key={a.id}
                            className={cn(!onPage && "hidden print:table-row")}
                          >
                            <TableCell className="text-xs whitespace-nowrap">
                              {fmtDate(a.scheduled_at)}
                            </TableCell>
                            <TableCell className="max-w-0 font-medium">
                              <Link
                                href={`/patients/${a.patient_id}`}
                                className="block truncate hover:underline"
                              >
                                {a.patients?.full_name ?? "—"}
                              </Link>
                            </TableCell>
                            <TableCell className="font-mono text-xs text-muted-foreground whitespace-nowrap">
                              {a.patients?.file_number ?? "—"}
                            </TableCell>
                            <TableCell className="font-mono text-xs text-muted-foreground whitespace-nowrap">
                              <span className="block min-w-0 truncate">
                                {a.patients?.national_id ?? "—"}
                              </span>
                            </TableCell>
                            <TableCell className="text-xs whitespace-nowrap">
                              <span className="inline-flex min-w-0 items-center gap-1.5 text-muted-foreground">
                                <Phone className="h-3 w-3" />
                                <span className="truncate">{a.patients?.phone ?? "—"}</span>
                              </span>
                            </TableCell>
                            <TableCell className="text-xs">
                              <span className="inline-flex min-w-0 items-center gap-1.5 text-muted-foreground">
                                <Stethoscope className="h-3 w-3" />
                                <span className="truncate">
                                  {formatDoctorName(a.profiles?.full_name)}
                                </span>
                              </span>
                            </TableCell>
                            <TableCell className="text-end print:hidden">
                              {!readOnly && (
                                <Button
                                  size="sm"
                                  variant="default"
                                  className="h-7 px-2 text-[11px]"
                                  onClick={() => setActiveRow(a)}
                                >
                                  {t("recordFollowUp")}</Button>
                              )}
                            </TableCell>
                          </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>
                  {(() => {
                    const groupKey = g.dept?.id ?? UNASSIGNED_KEY;
                    const totalPages = Math.max(
                      1,
                      Math.ceil(g.rows.length / PAGE_SIZE),
                    );
                    if (totalPages <= 1) return null;
                    const gp = Math.min(pendingPageFor(groupKey), totalPages);
                    const start = (gp - 1) * PAGE_SIZE + 1;
                    const end = Math.min(gp * PAGE_SIZE, g.rows.length);
                    return (
                      <div className="flex items-center justify-between border-t border-border/40 bg-card px-4 py-2.5 text-xs text-muted-foreground print:hidden">
                        <span>
                          {t("showing")}{" "}
                          <span className="font-medium text-foreground tabular-nums">
                            {start}–{end}
                          </span>{" "}
                          {t("of")}{" "}
                          <span className="font-medium text-foreground tabular-nums">
                            {g.rows.length}
                          </span>
                        </span>
                        <div className="flex items-center gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 w-7 p-0"
                            disabled={gp <= 1}
                            onClick={() => setPendingPage(groupKey, gp - 1)}
                            aria-label={t("previousPage")}
                          >
                            <ChevronLeft className="h-3.5 w-3.5 rtl:rotate-180" />
                          </Button>
                          <span className="tabular-nums">
                            {t("page")}{" "}
                            <span className="font-medium text-foreground">
                              {gp}
                            </span>{" "}
                            {t("of")}{" "}
                            <span className="font-medium text-foreground">
                              {totalPages}
                            </span>
                          </span>
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 w-7 p-0"
                            disabled={gp >= totalPages}
                            onClick={() => setPendingPage(groupKey, gp + 1)}
                            aria-label={t("nextPage")}
                          >
                            <ChevronRight className="h-3.5 w-3.5 rtl:rotate-180" />
                          </Button>
                        </div>
                      </div>
                    );
                  })()}
                </section>
              );
            })}
            {summary.pendingCount > pending.length && (
              <div className="rounded-lg border border-border/50 bg-muted/20 px-4 py-2 text-xs text-muted-foreground print:hidden">
                {t("awaitingPreviewNotice", {
                  limit: pendingPreviewLimit,
                  remaining: summary.pendingCount - pending.length,
                })}
              </div>
            )}
          </div>
        )}
      </section>

      {/* Completed follow-ups */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            {t("completedFollowUps")}</h2>
          <span className="text-xs text-muted-foreground">
            {t("recordCount", { count: summary.completedCount })}
          </span>
        </div>

        <div className="inline-flex flex-wrap items-center gap-0.5 rounded-lg border border-border/60 bg-muted/40 p-0.5 print:hidden">
          {(
            [
              { value: null, label: t("all"), count: summary.completedCount },
              {
                value: "has_problem" as const,
                label: t("reportedAProblem2"),
                count: summary.hasProblemCount,
              },
              {
                value: "all_fine" as const,
                label: t("allFine2"),
                count: summary.allFineCount,
              },
              {
                value: "no_response" as const,
                label: t("noResponse2"),
                count: summary.noResponseCount,
              },
            ] as const
          ).map(({ value, label, count }) => {
            const active = activeOutcome === value;
            return (
              <button
                key={String(value)}
                type="button"
                onClick={() => update({ outcome: value })}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition",
                  active
                    ? "bg-card text-foreground shadow-sm ring-1 ring-border/60"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
                <span
                  className={cn(
                    "inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px]",
                    active
                      ? "bg-primary/15 text-primary"
                      : "bg-muted text-muted-foreground",
                  )}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>

        {summary.completedCount === 0 ? (
          <div className="rounded-xl border border-border/50 bg-card px-4 py-10 text-center text-sm text-muted-foreground">
            {t("noFollowUpsRecordedInThis")}</div>
        ) : (
          <div className="space-y-5">
            {doneGroups.map((g) => {
              const color = g.dept?.color ?? UNASSIGNED_COLOR;
              const name = g.dept?.name ?? t("unassigned");
              const groupKey = `done-${g.dept?.id ?? UNASSIGNED_KEY}`;
              const totalPages = Math.max(
                1,
                Math.ceil(g.rows.length / PAGE_SIZE),
              );
              const gp = Math.min(donePageFor(groupKey), totalPages);
              return (
                <section
                  data-print-table-section
                  key={groupKey}
                  className="overflow-hidden rounded-xl border bg-card shadow-sm"
                  style={{
                    borderColor: `color-mix(in oklab, ${color} 35%, transparent)`,
                  }}
                >
                  <header
                    className="flex items-center justify-between gap-3 border-b px-4 py-3"
                    style={{
                      backgroundColor: `color-mix(in oklab, ${color} 10%, transparent)`,
                      borderColor: `color-mix(in oklab, ${color} 25%, transparent)`,
                    }}
                  >
                    <div className="flex items-center gap-3">
                      <span
                        aria-hidden
                        className="inline-block h-3 w-3 rounded-full"
                        style={{ backgroundColor: color }}
                      />
                      <h3
                        className="text-sm font-semibold tracking-tight"
                        style={{ color }}
                      >
                        {name}
                      </h3>
                    </div>
                    <span className="text-[11px] font-medium" style={{ color }}>
                      {t("recordCount", { count: g.rows.length })}
                    </span>
                  </header>
                  <div className="overflow-x-auto">
                    <Table className="table-fixed">
                      <colgroup>
                        <col className="w-44" />
                        <col className="w-36" />
                        <col />
                        <col className="w-36" />
                        <col className="w-32" />
                        <col className="w-48" />
                        <col className="w-24 print:hidden" />
                      </colgroup>
                      <TableHeader>
                        <TableRow>
                          <TableHead>{t("status")}</TableHead>
                          <TableHead>{t("recorded")}</TableHead>
                          <TableHead>{t("patient")}</TableHead>
                          <TableHead>{t("doctor")}</TableHead>
                          <TableHead>{t("outcome")}</TableHead>
                          <TableHead>{t("notes")}</TableHead>
                          <TableHead className="text-end print:hidden">{t("action")}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {g.rows.map((d, i) => {
                          const onPage =
                            i >= (gp - 1) * PAGE_SIZE && i < gp * PAGE_SIZE;
                          const meta = OUTCOME_META[d.outcome];
                          const Icon = meta.icon;
                          return (
                            <TableRow
                              key={d.id}
                              className={cn(!onPage && "hidden print:table-row")}
                            >
                              <TableCell>
                                <div className="flex flex-wrap items-center gap-1.5">
                                  <span className="inline-flex items-center gap-1 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-400">
                                    <CheckCircle2 className="h-3 w-3" />
                                    {t("completed")}</span>
                                  <span
                                    className={cn(
                                      "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] font-medium",
                                      d.notes
                                        ? "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-400"
                                        : "border-border/60 bg-muted/40 text-muted-foreground",
                                    )}
                                  >
                                    {d.notes ? t("notetaken") : t("nonote")}
                                  </span>
                                </div>
                              </TableCell>
                              <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                                {fmtDateTime(d.recorded_at)}
                              </TableCell>
                              <TableCell className="max-w-0 font-medium">
                                <Link
                                  href={`/patients/${d.patient_id}`}
                                  className="block truncate hover:underline"
                                >
                                  {d.patients?.full_name ?? "—"}
                                </Link>
                                <p className="truncate font-mono text-[10px] text-muted-foreground">
                                  {d.patients?.file_number ?? "—"}
                                </p>
                              </TableCell>
                              <TableCell className="text-xs">
                                {d.appointment?.profiles?.full_name ? (
                                  <span className="text-muted-foreground">
                                    {formatDoctorName(d.appointment.profiles.full_name)}
                                  </span>
                                ) : (
                                  <span className="text-muted-foreground/40">
                                    —
                                  </span>
                                )}
                              </TableCell>
                              <TableCell>
                                <span
                                  className={cn(
                                    "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium",
                                    meta.className,
                                  )}
                                >
                                  <Icon className="h-3 w-3" />
                                  {t(meta.labelKey)}
                                </span>
                              </TableCell>
                              <TableCell className="text-xs">
                                {d.notes ? (
                                  <span className="text-foreground">
                                    &ldquo;{d.notes}&rdquo;
                                  </span>
                                ) : (
                                  <span className="italic text-muted-foreground/70">
                                    {t("noAdditionalNotes")}</span>
                                )}
                                {d.recorded_by?.full_name && (
                                  <p className="mt-0.5 text-[10px] text-muted-foreground">
                                    {t("byName", { name: d.recorded_by.full_name })}
                                  </p>
                                )}
                              </TableCell>
                              <TableCell className="text-end print:hidden">
                                {!readOnly && (
                                  <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    className="h-7 gap-1 px-2 text-[11px]"
                                    onClick={() => setEditRow(d)}
                                  >
                                    <Pencil className="h-3 w-3" />
                                    {t("edit")}</Button>
                                )}
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>
                  {totalPages > 1 && (
                    <div className="flex items-center justify-between border-t border-border/40 bg-card px-4 py-2.5 text-xs text-muted-foreground print:hidden">
                      <span>
                        {t("showing")}{" "}
                        <span className="font-medium text-foreground tabular-nums">
                          {(gp - 1) * PAGE_SIZE + 1}–
                          {Math.min(gp * PAGE_SIZE, g.rows.length)}
                        </span>{" "}
                        {t("of")}{" "}
                        <span className="font-medium text-foreground tabular-nums">
                          {g.rows.length}
                        </span>
                      </span>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 w-7 p-0"
                          disabled={gp <= 1}
                          onClick={() => setDonePage(groupKey, gp - 1)}
                          aria-label={t("previousPage")}
                        >
                          <ChevronLeft className="h-3.5 w-3.5 rtl:rotate-180" />
                        </Button>
                        <span className="tabular-nums">
                          {t("page")}{" "}
                          <span className="font-medium text-foreground">
                            {gp}
                          </span>{" "}
                          {t("of")}{" "}
                          <span className="font-medium text-foreground">
                            {totalPages}
                          </span>
                        </span>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 w-7 p-0"
                          disabled={gp >= totalPages}
                          onClick={() => setDonePage(groupKey, gp + 1)}
                          aria-label={t("nextPage")}
                        >
                          <ChevronRight className="h-3.5 w-3.5 rtl:rotate-180" />
                        </Button>
                      </div>
                    </div>
                  )}
                </section>
              );
            })}
            <CompletedPager
              page={completedPage}
              pageSize={completedPageSize}
              total={summary.completedCount}
              onPage={(page) => update({ completedPage: String(page) })}
            />
          </div>
        )}
      </section>

      {!readOnly && (
        <>
          <RecordFollowupDialog
            row={activeRow}
            open={!!activeRow}
            onOpenChange={(o) => {
              if (!o) setActiveRow(null);
            }}
            onUndoReopen={() => {
              if (activeRow) setActiveRow(activeRow);
            }}
          />
          <RecordFollowupDialog
            row={null}
            followup={editRow}
            mode="edit"
            open={!!editRow}
            onOpenChange={(o) => {
              if (!o) setEditRow(null);
            }}
            onUndoReopen={() => {
              if (editRow) setEditRow(editRow);
            }}
          />
        </>
      )}
    </div>
  );
}

function FollowupsPrintButton() {
  const t = useTranslations("followups");
  return (
    <Button
      variant="outline"
      size="sm"
      className="h-7 gap-1.5 px-2 text-xs"
      onClick={() => window.print()}
    >
      <Printer className="h-3.5 w-3.5" />
      {t("print")}</Button>
  );
}

function SummaryCell({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent?: string;
}) {
  return (
    <div className="bg-card px-4 py-3">
      <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className={cn("mt-1 text-lg font-semibold tabular-nums", accent)}>
        {value}
      </p>
    </div>
  );
}

function CompletedPager({
  page,
  pageSize,
  total,
  onPage,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
}) {
  const t = useTranslations("followups");
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (totalPages <= 1) return null;

  const currentPage = Math.min(Math.max(1, page), totalPages);
  const start = (currentPage - 1) * pageSize + 1;
  const end = Math.min(currentPage * pageSize, total);

  return (
    <div className="flex items-center justify-between rounded-xl border border-border/50 bg-card px-4 py-2.5 text-xs text-muted-foreground print:hidden">
      <span>
        {t("showing")}{" "}
        <span className="font-medium text-foreground tabular-nums">
          {start}–{end}
        </span>{" "}
        {t("of")}{" "}
        <span className="font-medium text-foreground tabular-nums">{total}</span>{" "}
        {t("completedFollowUps2")}</span>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className="h-7 w-7 p-0"
          disabled={currentPage <= 1}
          onClick={() => onPage(currentPage - 1)}
          aria-label={t("previousCompletedFollowUpsPage")}
        >
          <ChevronLeft className="h-3.5 w-3.5 rtl:rotate-180" />
        </Button>
        <span className="tabular-nums">
          {t("page")}{" "}
          <span className="font-medium text-foreground">{currentPage}</span> {t("of")}{" "}
          <span className="font-medium text-foreground">{totalPages}</span>
        </span>
        <Button
          variant="outline"
          size="sm"
          className="h-7 w-7 p-0"
          disabled={currentPage >= totalPages}
          onClick={() => onPage(currentPage + 1)}
          aria-label={t("nextCompletedFollowUpsPage")}
        >
          <ChevronRight className="h-3.5 w-3.5 rtl:rotate-180" />
        </Button>
      </div>
    </div>
  );
}

function fmtIsoDay(d: Date): string {
  // Returns YYYY-MM-DD in the local browser TZ. The page resolves date strings
  // with the same convention so this stays consistent.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function DayPicker({
  scope,
  range,
  onPickDay,
}: {
  scope: Scope;
  range: { start: string; end: string };
  onPickDay: (isoDay: string) => void;
}) {
  const { formatDate, formatNumber } = useClinicSettings();
  const start = new Date(range.start);
  const end = new Date(range.end);
  const days: Date[] = [];
  const cursor = new Date(start);
  cursor.setHours(0, 0, 0, 0);
  while (cursor <= end) {
    days.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }

  if (scope === "week") {
    return (
      <div className="grid grid-cols-7 gap-1.5 print:hidden">
        {days.map((d) => (
          <button
            key={d.toISOString()}
            type="button"
            onClick={() => onPickDay(fmtIsoDay(d))}
            className="flex flex-col items-center gap-0.5 rounded-lg border border-border/60 bg-card px-2 py-2.5 text-xs transition hover:border-primary/40 hover:bg-primary/5"
          >
            <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              {formatDate(d, { weekday: "short" })}
            </span>
            <span className="text-base font-semibold tabular-nums">
              {formatNumber(d.getDate())}
            </span>
            <span className="text-[10px] text-muted-foreground">
              {formatDate(d, { month: "short" })}
            </span>
          </button>
        ))}
      </div>
    );
  }

  // scope === "month" → render a calendar grid with weekday headers.
  // Pad the first row with empty cells so the 1st falls under its weekday.
  // We use Mon-first layout to match the rest of the app.
  const first = days[0];
  if (!first) return null;
  const firstDow = first.getDay(); // 0 = Sun, 1 = Mon, ..., 6 = Sat
  const monFirstOffset = (firstDow + 6) % 7; // 0 if Mon, 6 if Sun
  const weekdayLabels = Array.from({ length: 7 }, (_, index) =>
    formatDate(new Date(Date.UTC(2024, 0, index + 1)), { weekday: "short", timeZone: "UTC" }),
  );

  return (
    <div className="space-y-1.5 print:hidden">
      <div className="grid grid-cols-7 gap-1 text-center text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {weekdayLabels.map((w) => (
          <div key={w}>{w}</div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {Array.from({ length: monFirstOffset }, (_, i) => (
          <div key={`pad-${i}`} aria-hidden />
        ))}
        {days.map((d) => (
          <button
            key={d.toISOString()}
            type="button"
            onClick={() => onPickDay(fmtIsoDay(d))}
            className="flex aspect-square flex-col items-center justify-center gap-0.5 rounded-md border border-border/50 bg-card text-sm font-medium tabular-nums transition hover:border-primary/40 hover:bg-primary/5"
          >
            <span className="text-base font-semibold leading-none">
              {formatNumber(d.getDate())}
            </span>
            <span className="text-[10px] font-normal uppercase tracking-wider text-muted-foreground">
              {formatDate(d, { month: "short" })}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
