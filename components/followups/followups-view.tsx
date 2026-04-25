"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import {
  ChevronLeft,
  CalendarDays,
  CheckCircle2,
  Filter,
  Phone,
  PhoneOff,
  Printer,
  Search,
  Stethoscope,
  Users,
  X,
  AlertCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { RecordFollowupDialog } from "@/components/followups/record-dialog";

type Scope = "day" | "week" | "month";

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

interface Props {
  pending: PendingRow[];
  done: DoneRow[];
  departments: Department[];
  scope: Scope;
  dateInput: string;
  activeDept: string | null;
  activeQuery: string;
  range: { start: string; end: string };
}

const OUTCOME_META = {
  all_fine: {
    label: "All fine",
    className:
      "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
    icon: CheckCircle2,
  },
  has_problem: {
    label: "Has a problem",
    className:
      "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
    icon: AlertCircle,
  },
  no_response: {
    label: "No response",
    className: "border-border/60 bg-muted/40 text-muted-foreground",
    icon: PhoneOff,
  },
} as const;

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-GB", {
    timeZone: "Europe/Istanbul",
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}
function fmtDateTime(iso: string) {
  return new Date(iso).toLocaleString("en-GB", {
    timeZone: "Europe/Istanbul",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function FollowupsView({
  pending,
  done,
  departments,
  scope,
  dateInput,
  activeDept,
  activeQuery,
  range,
}: Props) {
  const router = useRouter();
  const params = useSearchParams();
  const [, startTransition] = useTransition();
  const [q, setQ] = useState(activeQuery);
  const [activeRow, setActiveRow] = useState<PendingRow | null>(null);
  const initialQRef = useRef(activeQuery);

  // Debounce live search input → push the URL change after 300ms of no typing.
  useEffect(() => {
    const trimmed = q.trim();
    if (trimmed === activeQuery) return;
    const handle = setTimeout(() => {
      const p = new URLSearchParams(params?.toString() ?? "");
      if (trimmed) p.set("q", trimmed);
      else p.delete("q");
      startTransition(() => router.push(`/followups?${p.toString()}`));
    }, 300);
    return () => clearTimeout(handle);
    // intentionally exclude params/router/startTransition — only care about q + activeQuery
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, activeQuery]);

  // When the URL clears the query elsewhere (e.g. Clear filters), re-sync the input.
  useEffect(() => {
    if (activeQuery !== initialQRef.current) {
      queueMicrotask(() => setQ(activeQuery));
      initialQRef.current = activeQuery;
    }
  }, [activeQuery]);

  function update(next: Record<string, string | null>) {
    const p = new URLSearchParams(params?.toString() ?? "");
    for (const [k, v] of Object.entries(next)) {
      if (v === null || v === "") p.delete(k);
      else p.set(k, v);
    }
    startTransition(() => router.push(`/followups?${p.toString()}`));
  }

  function clearFilters() {
    const p = new URLSearchParams(params?.toString() ?? "");
    p.delete("dept");
    p.delete("q");
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

  const periodLabel =
    scope === "day"
      ? fmtDate(range.start)
      : scope === "week"
        ? `${fmtDate(range.start)} → ${fmtDate(range.end)}`
        : new Date(range.start).toLocaleDateString("en-GB", {
            timeZone: "Europe/Istanbul",
            month: "long",
            year: "numeric",
          });

  return (
    <div className="space-y-6">
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
            Patient follow-ups
          </h1>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-1.5"
          onClick={() => window.print()}
        >
          <Printer className="h-3.5 w-3.5" />
          Print
        </Button>
      </div>

      {/* Print-only header */}
      <div className="hidden print:block print:mb-4">
        <h1 className="text-xl font-semibold">Patient follow-ups</h1>
        <p className="text-xs text-muted-foreground">
          {scope[0].toUpperCase() + scope.slice(1)} · {periodLabel}
          {activeDept && ` · Department: ${
            departments.find((d) => d.id === activeDept)?.name ?? "—"
          }`}
          {activeQuery && ` · Patient: ${activeQuery}`}
          {" · "}
          Printed {new Date().toLocaleDateString("en-GB")}
        </p>
      </div>

      {/* Period toggle — independent from the search/filter row below */}
      <div className="flex flex-wrap items-center gap-3 print:hidden">
        <div className="inline-flex items-center gap-0.5 rounded-lg border border-border/60 bg-muted/40 p-0.5">
          {(["day", "week", "month"] as const).map((s) => {
            const active = scope === s;
            return (
              <button
                key={s}
                type="button"
                onClick={() => update({ scope: s })}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition",
                  active
                    ? "bg-card text-foreground shadow-sm ring-1 ring-border/60"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <CalendarDays className="h-3.5 w-3.5" />
                {s[0].toUpperCase() + s.slice(1)}
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
        <span className="text-xs text-muted-foreground">{periodLabel}</span>
      </div>

      {/* Search + filter row — independent of the period toggle */}
      <div className="flex flex-wrap items-center gap-2 print:hidden">
        <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Filter className="h-3.5 w-3.5" />
          Filter
        </span>
        <Select
          value={activeDept ?? ""}
          onValueChange={(v) => update({ dept: v || null })}
        >
          <SelectTrigger
            className={cn(
              "h-8 w-[180px] gap-1.5 px-2 text-xs",
              activeDept &&
                "border-primary/40 bg-primary/10 text-primary",
            )}
          >
            <Users className="h-3.5 w-3.5" />
            <SelectValue placeholder="All departments" />
          </SelectTrigger>
          <SelectContent>
            {departments.map((d) => (
              <SelectItem key={d.id} value={d.id}>
                <span className="inline-flex items-center gap-2">
                  <span
                    aria-hidden
                    className="h-2 w-2 rounded-full"
                    style={{ backgroundColor: d.color }}
                  />
                  {d.name}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Name, phone, file # or national ID…"
            className="h-8 w-[260px] pl-7 text-xs"
          />
        </div>
        {(activeDept || activeQuery) && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-xs text-muted-foreground"
            onClick={clearFilters}
          >
            <X className="h-3.5 w-3.5" />
            Clear
          </Button>
        )}
      </div>

      {/* Summary strip */}
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border/50 bg-border/40 sm:grid-cols-4">
        <SummaryCell label="Awaiting follow-up" value={pending.length} />
        <SummaryCell
          label="All fine"
          value={done.filter((d) => d.outcome === "all_fine").length}
          accent="text-emerald-600 dark:text-emerald-400"
        />
        <SummaryCell
          label="Reported a problem"
          value={done.filter((d) => d.outcome === "has_problem").length}
          accent="text-amber-600 dark:text-amber-400"
        />
        <SummaryCell
          label="No response"
          value={done.filter((d) => d.outcome === "no_response").length}
          accent="text-muted-foreground"
        />
      </div>

      {/* Pending — grouped by department */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Awaiting follow-up
          </h2>
          <span className="text-xs text-muted-foreground">
            {pending.length} patient{pending.length !== 1 ? "s" : ""}
          </span>
        </div>

        {pendingGroups.length === 0 ? (
          <div className="rounded-xl border border-border/50 bg-card px-4 py-10 text-center text-sm text-muted-foreground">
            All caught up — no completed sessions waiting for a follow-up call.
          </div>
        ) : (
          <div className="space-y-5">
            {pendingGroups.map((g) => {
              const color = g.dept?.color ?? UNASSIGNED_COLOR;
              const name = g.dept?.name ?? "Unassigned";
              return (
                <section
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
                      {g.rows.length} patient{g.rows.length !== 1 ? "s" : ""}
                    </span>
                  </header>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="border-b border-border/40 bg-muted/30 text-[10px] uppercase tracking-wider text-muted-foreground">
                        <tr>
                          <th className="px-4 py-2.5 text-left font-medium">
                            Session
                          </th>
                          <th className="px-4 py-2.5 text-left font-medium">
                            Patient
                          </th>
                          <th className="px-4 py-2.5 text-left font-medium">
                            File / ID
                          </th>
                          <th className="px-4 py-2.5 text-left font-medium">
                            Phone
                          </th>
                          <th className="px-4 py-2.5 text-left font-medium">
                            Doctor
                          </th>
                          <th className="px-4 py-2.5 text-right font-medium print:hidden">
                            Action
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border/30">
                        {g.rows.map((a) => (
                          <tr
                            key={a.id}
                            className="hover:bg-muted/20 transition-colors"
                          >
                            <td className="px-4 py-3 text-xs whitespace-nowrap">
                              {fmtDate(a.scheduled_at)}
                            </td>
                            <td className="px-4 py-3 font-medium">
                              <Link
                                href={`/patients/${a.patient_id}`}
                                className="hover:underline"
                              >
                                {a.patients?.full_name ?? "—"}
                              </Link>
                            </td>
                            <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                              {a.patients?.file_number ?? "—"}
                              {a.patients?.national_id && (
                                <span className="ml-2">
                                  {a.patients.national_id}
                                </span>
                              )}
                            </td>
                            <td className="px-4 py-3 text-xs">
                              <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                                <Phone className="h-3 w-3" />
                                {a.patients?.phone ?? "—"}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-xs">
                              <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                                <Stethoscope className="h-3 w-3" />
                                Dr. {a.profiles?.full_name ?? "—"}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-right print:hidden">
                              <Button
                                size="sm"
                                variant="default"
                                className="h-7 px-2 text-[11px]"
                                onClick={() => setActiveRow(a)}
                              >
                                Record follow-up
                              </Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </section>

      {/* Completed follow-ups */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Completed follow-ups
          </h2>
          <span className="text-xs text-muted-foreground">
            {done.length} record{done.length !== 1 ? "s" : ""}
          </span>
        </div>

        <div className="overflow-hidden rounded-xl border border-border/50 bg-card">
          {done.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-muted-foreground">
              No follow-ups recorded in this period yet.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-border/40 bg-muted/30 text-[10px] uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2.5 text-left font-medium">
                      Status
                    </th>
                    <th className="px-4 py-2.5 text-left font-medium">
                      Recorded
                    </th>
                    <th className="px-4 py-2.5 text-left font-medium">
                      Patient
                    </th>
                    <th className="px-4 py-2.5 text-left font-medium">
                      Department &amp; Doctor
                    </th>
                    <th className="px-4 py-2.5 text-left font-medium">
                      Outcome
                    </th>
                    <th className="px-4 py-2.5 text-left font-medium">Notes</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/30">
                  {done.map((d) => {
                    const meta = OUTCOME_META[d.outcome];
                    const Icon = meta.icon;
                    const deptColor =
                      d.appointment?.departments?.color ?? UNASSIGNED_COLOR;
                    return (
                      <tr
                        key={d.id}
                        className="hover:bg-muted/20 transition-colors"
                      >
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="inline-flex items-center gap-1 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-400">
                              <CheckCircle2 className="h-3 w-3" />
                              Completed
                            </span>
                            <span
                              className={cn(
                                "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] font-medium",
                                d.notes
                                  ? "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-400"
                                  : "border-border/60 bg-muted/40 text-muted-foreground",
                              )}
                            >
                              {d.notes ? "Note taken" : "No note"}
                            </span>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">
                          {fmtDateTime(d.recorded_at)}
                        </td>
                        <td className="px-4 py-3 font-medium">
                          <Link
                            href={`/patients/${d.patient_id}`}
                            className="hover:underline"
                          >
                            {d.patients?.full_name ?? "—"}
                          </Link>
                          <p className="font-mono text-[10px] text-muted-foreground">
                            {d.patients?.file_number ?? "—"}
                          </p>
                        </td>
                        <td className="px-4 py-3 text-xs">
                          {d.appointment?.departments?.name && (
                            <span
                              className="mr-2 inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider"
                              style={{
                                backgroundColor: `color-mix(in oklab, ${deptColor} 14%, transparent)`,
                                color: deptColor,
                              }}
                            >
                              {d.appointment.departments.name}
                            </span>
                          )}
                          {d.appointment?.profiles?.full_name && (
                            <span className="text-muted-foreground">
                              Dr. {d.appointment.profiles.full_name}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={cn(
                              "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium",
                              meta.className,
                            )}
                          >
                            <Icon className="h-3 w-3" />
                            {meta.label}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-xs">
                          {d.notes ? (
                            <span className="text-foreground">
                              &ldquo;{d.notes}&rdquo;
                            </span>
                          ) : (
                            <span className="italic text-muted-foreground/70">
                              No additional notes
                            </span>
                          )}
                          {d.recorded_by?.full_name && (
                            <p className="mt-0.5 text-[10px] text-muted-foreground">
                              by {d.recorded_by.full_name}
                            </p>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      <RecordFollowupDialog
        row={activeRow}
        open={!!activeRow}
        onOpenChange={(o) => {
          if (!o) setActiveRow(null);
        }}
      />
    </div>
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
