"use client";

import { useRouter, useSearchParams } from "next/navigation";
import {
  Banknote,
  ChevronLeft,
  ChevronRight,
  CreditCard,
  Landmark,
  ShieldCheck,
  Wallet,
  Wallet2,
  Receipt,
  TrendingUp,
  Building2,
} from "lucide-react";
import type { ComponentType } from "react";
import { useMemo, useTransition } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type PaymentMethod =
  | "cash"
  | "credit_card"
  | "paypal"
  | "bank_transfer"
  | "insurance";

export interface RevenueRow {
  id: string;
  scheduled_at: string;
  paid_at: string | null;
  total_amount: number | null;
  paid_amount: number | null;
  insurance_amount: number | null;
  secondary_amount: number | null;
  deposit_amount: number | null;
  outstanding_amount: number | null;
  payment_method: PaymentMethod | null;
  secondary_payment_method: PaymentMethod | null;
  payment_note: string | null;
  patients: { full_name: string } | null;
  profiles: { full_name: string } | null;
  departments: { name: string; color: string } | null;
  insurance_providers: { name: string } | null;
}

export interface SettlementRow {
  id: string;
  settled_at: string;
  amount: number;
  payment_method: PaymentMethod;
  note: string | null;
  patient: { full_name: string } | null;
  appointment: {
    id: string;
    scheduled_at: string;
    total_amount: number | null;
    outstanding_amount: number | null;
    profiles: { full_name: string } | null;
    departments: { name: string; color: string } | null;
  } | null;
}

const METHOD_META: Record<
  PaymentMethod,
  { label: string; icon: ComponentType<{ className?: string }> }
> = {
  cash: { label: "Cash", icon: Banknote },
  credit_card: { label: "Credit card", icon: CreditCard },
  paypal: { label: "PayPal", icon: Wallet },
  bank_transfer: { label: "Bank transfer", icon: Landmark },
  insurance: { label: "Insurance", icon: ShieldCheck },
};

const PRESETS: { value: string; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "week", label: "This week" },
  { value: "this_month", label: "This month" },
  { value: "last_month", label: "Last month" },
  { value: "last_year", label: "Last year" },
  { value: "custom", label: "Custom range" },
];

function fmtTRY(n: number) {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "TRY",
    maximumFractionDigits: 2,
  }).format(Number.isFinite(n) ? n : 0);
}

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
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function presetLabel(preset: string) {
  return PRESETS.find((p) => p.value === preset)?.label ?? "Custom range";
}

interface Props {
  rows: RevenueRow[];
  settlements?: SettlementRow[];
  range: { start: string; end: string };
  preset: string;
  fromInput: string;
  toInput: string;
  clinicName: string;
  clinicAddress: string | null;
  clinicPhone: string | null;
}

export function RevenueReport({
  rows,
  settlements = [],
  range,
  preset,
  fromInput,
  toInput,
  clinicName,
  clinicAddress,
  clinicPhone,
}: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();

  function updateParams(next: Record<string, string | null>) {
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    for (const [k, v] of Object.entries(next)) {
      if (v === null) params.delete(k);
      else params.set(k, v);
    }
    router.push(`/revenue?${params.toString()}`);
  }

  // ── pagination ────────────────────────────────────────────────────────
  const PAGE_SIZE = 10;
  const pageRaw = Number(searchParams?.get("page") ?? "1");
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const page = Math.min(Math.max(1, Number.isFinite(pageRaw) ? pageRaw : 1), totalPages);
  const visibleRows = useMemo(
    () => rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [rows, page],
  );
  function gotoPage(p: number) {
    const next = Math.min(Math.max(1, p), totalPages);
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    if (next === 1) params.delete("page");
    else params.set("page", String(next));
    startTransition(() => router.push(`/revenue?${params.toString()}`));
  }

  // ── totals ────────────────────────────────────────────────────────────
  const primaryTotal = rows.reduce((s, r) => s + (r.paid_amount ?? 0), 0);
  const secondaryTotal = rows.reduce((s, r) => s + (r.secondary_amount ?? 0), 0);
  const insuranceTotal = rows.reduce((s, r) => s + (r.insurance_amount ?? 0), 0);
  const depositTotal = rows.reduce((s, r) => s + (r.deposit_amount ?? 0), 0);
  const settlementsTotal = settlements.reduce((s, r) => s + (r.amount ?? 0), 0);
  const outstandingTotal = rows.reduce(
    (s, r) => s + (r.outstanding_amount ?? 0),
    0,
  );
  const grossTotal =
    primaryTotal +
    secondaryTotal +
    insuranceTotal +
    depositTotal +
    settlementsTotal;

  // Method breakdown
  const methodMap = new Map<PaymentMethod, number>();
  for (const r of rows) {
    if (r.payment_method && r.paid_amount)
      methodMap.set(
        r.payment_method,
        (methodMap.get(r.payment_method) ?? 0) + r.paid_amount,
      );
    if (r.secondary_payment_method && r.secondary_amount)
      methodMap.set(
        r.secondary_payment_method,
        (methodMap.get(r.secondary_payment_method) ?? 0) + r.secondary_amount,
      );
  }
  for (const s of settlements) {
    if (s.payment_method && s.amount)
      methodMap.set(
        s.payment_method,
        (methodMap.get(s.payment_method) ?? 0) + s.amount,
      );
  }
  const methodBreakdown = Array.from(methodMap.entries())
    .map(([m, v]) => ({ method: m, amount: v }))
    .sort((a, b) => b.amount - a.amount);

  return (
    <div className="space-y-6">
      {/* Filter bar — hidden in print */}
      <div className="print:hidden rounded-xl border border-border/50 bg-card p-4 space-y-3">
        <div className="flex flex-wrap gap-2">
          {PRESETS.map((p) => {
            const active = preset === p.value;
            return (
              <button
                key={p.value}
                type="button"
                onClick={() =>
                  updateParams({
                    preset: p.value,
                    from: p.value === "custom" ? fromInput : null,
                    to: p.value === "custom" ? toInput : null,
                  })
                }
                className={cn(
                  "rounded-full border px-3 py-1 text-xs font-medium transition",
                  active
                    ? "border-primary bg-primary/10 text-foreground"
                    : "border-border/60 bg-background text-muted-foreground hover:border-primary/40 hover:text-foreground",
                )}
              >
                {p.label}
              </button>
            );
          })}
        </div>
        {preset === "custom" && (
          <form
            className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_auto] items-end"
            onSubmit={(e) => {
              e.preventDefault();
              const fd = new FormData(e.currentTarget);
              const from = String(fd.get("from") ?? "");
              const to = String(fd.get("to") ?? "");
              if (from && to) {
                updateParams({ preset: "custom", from, to });
              }
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="from" className="text-xs">From</Label>
              <Input
                id="from"
                name="from"
                type="date"
                defaultValue={fromInput}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="to" className="text-xs">To</Label>
              <Input
                id="to"
                name="to"
                type="date"
                defaultValue={toInput}
                required
              />
            </div>
            <Button type="submit" className="h-10">Apply</Button>
          </form>
        )}
      </div>

      {/* Statement — printable */}
      <div
        data-print-hide-when-settlements
        className="rounded-xl border border-border/50 bg-card print:border-none print:bg-transparent"
      >
        {/* Letterhead — visible in print */}
        <div className="hidden print:block border-b border-border px-6 py-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs uppercase tracking-widest text-muted-foreground">
                Revenue statement
              </p>
              <h1 className="mt-1 text-xl font-semibold tracking-tight">
                {clinicName}
              </h1>
              {clinicAddress && (
                <p className="text-xs text-muted-foreground">{clinicAddress}</p>
              )}
              {clinicPhone && (
                <p className="text-xs text-muted-foreground">{clinicPhone}</p>
              )}
            </div>
            <div className="text-right text-xs text-muted-foreground">
              <p>Generated {fmtDateTime(new Date().toISOString())}</p>
            </div>
          </div>
        </div>

        {/* Period header */}
        <div className="px-5 py-4 border-b border-border/50 flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
              Period
            </p>
            <p className="text-sm font-semibold">
              {presetLabel(preset)} · {fmtDate(range.start)} → {fmtDate(range.end)}
            </p>
          </div>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Receipt className="h-4 w-4" />
            {rows.length + settlements.length} transaction
            {rows.length + settlements.length !== 1 ? "s" : ""}
            {settlements.length > 0 && (
              <span className="text-xs">
                ({rows.length} session{rows.length !== 1 ? "s" : ""} ·{" "}
                {settlements.length} settlement
                {settlements.length !== 1 ? "s" : ""})
              </span>
            )}
          </div>
        </div>

        {/* Totals strip */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-px bg-border/40 border-b border-border/50">
          <SummaryCell
            icon={TrendingUp}
            label="Total revenue"
            sublabel="Sessions + deposit + settlements"
            amount={grossTotal}
            accent="text-primary"
          />
          <SummaryCell
            icon={Banknote}
            label="Primary methods"
            amount={primaryTotal}
            accent="text-emerald-600 dark:text-emerald-400"
          />
          <SummaryCell
            icon={CreditCard}
            label="Secondary methods"
            amount={secondaryTotal}
            accent="text-cyan-600 dark:text-cyan-400"
          />
          <SummaryCell
            icon={ShieldCheck}
            label="Insurance"
            amount={insuranceTotal}
            accent="text-sky-600 dark:text-sky-400"
          />
          <SummaryCell
            icon={Wallet2}
            label="From deposit"
            sublabel="Account credit applied"
            amount={depositTotal}
            accent="text-violet-600 dark:text-violet-400"
          />
          <SummaryCell
            icon={Receipt}
            label="Settlements"
            sublabel="Outstanding paid"
            amount={settlementsTotal}
            accent="text-amber-600 dark:text-amber-400"
          />
        </div>

        {/* Method breakdown */}
        {methodBreakdown.length > 0 && (
          <div className="px-5 py-4 border-b border-border/50">
            <p className="mb-2 text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
              Breakdown by method
            </p>
            <div className="flex flex-wrap gap-2">
              {methodBreakdown.map(({ method, amount }) => {
                const meta = METHOD_META[method];
                const Icon = meta.icon;
                return (
                  <span
                    key={method}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-muted/40 px-2.5 py-1 text-xs"
                  >
                    <Icon className="h-3 w-3" />
                    <span className="font-medium">{meta.label}</span>
                    <span className="tabular-nums">{fmtTRY(amount)}</span>
                  </span>
                );
              })}
              {depositTotal > 0 && (
                <span className="inline-flex items-center gap-1.5 rounded-md border border-violet-500/40 bg-violet-500/10 px-2.5 py-1 text-xs text-violet-700 dark:text-violet-400">
                  <Wallet2 className="h-3 w-3" />
                  From deposit{" "}
                  <span className="tabular-nums">{fmtTRY(depositTotal)}</span>
                </span>
              )}
              {outstandingTotal > 0 && (
                <span className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1 text-xs text-amber-700 dark:text-amber-400">
                  <Building2 className="h-3 w-3" />
                  Outstanding <span className="tabular-nums">{fmtTRY(outstandingTotal)}</span>
                </span>
              )}
            </div>
          </div>
        )}

        {/* Transactions table */}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-[10px] uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-4 py-2.5 text-left font-medium">Paid at</th>
                <th className="px-4 py-2.5 text-left font-medium">Patient</th>
                <th className="px-4 py-2.5 text-left font-medium">Doctor / Dept.</th>
                <th className="px-4 py-2.5 text-right font-medium">Total</th>
                <th className="px-4 py-2.5 text-left font-medium">Primary</th>
                <th className="px-4 py-2.5 text-left font-medium">Secondary</th>
                <th className="px-4 py-2.5 text-right font-medium">Insurance</th>
                <th className="px-4 py-2.5 text-right font-medium">From deposit</th>
                <th className="px-4 py-2.5 text-right font-medium">Outstanding</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/40">
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-10 text-center text-sm text-muted-foreground">
                    No transactions in this period.
                  </td>
                </tr>
              ) : (
                visibleRows.map((r) => <TxnRow key={r.id} row={r} />)
              )}
            </tbody>
            {rows.length > 0 && (
              <tfoot className="bg-muted/30 font-semibold">
                <tr>
                  <td className="px-4 py-3 text-xs uppercase tracking-wider text-muted-foreground" colSpan={3}>
                    Totals
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {fmtTRY(rows.reduce((s, r) => s + (r.total_amount ?? 0), 0))}
                  </td>
                  <td className="px-4 py-3 text-left tabular-nums">
                    {fmtTRY(primaryTotal)}
                  </td>
                  <td className="px-4 py-3 text-left tabular-nums">
                    {fmtTRY(secondaryTotal)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {fmtTRY(insuranceTotal)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-violet-600 dark:text-violet-400">
                    {fmtTRY(depositTotal)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-amber-600 dark:text-amber-400">
                    {fmtTRY(outstandingTotal)}
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>

        {/* Pagination — appears when there are more than one page of rows */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between border-t border-border/50 bg-card px-4 py-3 text-xs text-muted-foreground print:hidden">
            <span>
              Showing{" "}
              <span className="font-medium text-foreground tabular-nums">
                {(page - 1) * PAGE_SIZE + 1}–
                {Math.min(page * PAGE_SIZE, rows.length)}
              </span>{" "}
              of{" "}
              <span className="font-medium text-foreground tabular-nums">
                {rows.length}
              </span>{" "}
              transactions
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-8 w-8 p-0"
                onClick={() => gotoPage(page - 1)}
                disabled={page <= 1}
                aria-label="Previous page"
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="tabular-nums">
                Page <span className="font-medium text-foreground">{page}</span>{" "}
                of <span className="font-medium text-foreground">{totalPages}</span>
              </span>
              <Button
                variant="outline"
                size="sm"
                className="h-8 w-8 p-0"
                onClick={() => gotoPage(page + 1)}
                disabled={page >= totalPages}
                aria-label="Next page"
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}

        {/* Print footer */}
        <div className="hidden print:block px-6 py-4 text-[10px] text-muted-foreground border-t border-border">
          This statement reflects completed appointments recorded within the
          specified period. Outstanding balances remain due and are not
          included in gross collected.
        </div>
      </div>

      {/* Settlement payments — separate card below the main statement */}
      {settlements.length > 0 && (
        <div
          data-print-section="settlements"
          className="rounded-xl border border-amber-500/30 bg-card print:border-none print:bg-transparent"
        >
          {/* Letterhead — visible only when printing */}
          <div className="hidden print:block border-b border-border px-6 py-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs uppercase tracking-widest text-muted-foreground">
                  Settlement payments
                </p>
                <h1 className="mt-1 text-xl font-semibold tracking-tight">
                  {clinicName}
                </h1>
                {clinicAddress && (
                  <p className="text-xs text-muted-foreground">
                    {clinicAddress}
                  </p>
                )}
                {clinicPhone && (
                  <p className="text-xs text-muted-foreground">{clinicPhone}</p>
                )}
              </div>
              <div className="text-right text-xs text-muted-foreground">
                <p>Generated {fmtDateTime(new Date().toISOString())}</p>
                <p className="mt-0.5">
                  {presetLabel(preset)} · {fmtDate(range.start)} →{" "}
                  {fmtDate(range.end)}
                </p>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 bg-amber-500/5 border-b border-border/50">
            <div>
              <p className="text-[10px] font-medium uppercase tracking-widest text-amber-700 dark:text-amber-400">
                Settlement payments
              </p>
              <p className="text-xs text-muted-foreground">
                Payments recorded against previously outstanding balances
              </p>
            </div>
            <div className="flex items-center gap-4 text-sm">
              <span className="text-muted-foreground">
                {settlements.length} payment
                {settlements.length !== 1 ? "s" : ""}
              </span>
              <span>
                <span className="text-muted-foreground">Total settled: </span>
                <span className="font-semibold tabular-nums text-amber-700 dark:text-amber-400">
                  {fmtTRY(settlementsTotal)}
                </span>
              </span>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-[10px] uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-4 py-2.5 text-left font-medium">
                    Settled at
                  </th>
                  <th className="px-4 py-2.5 text-left font-medium">Patient</th>
                  <th className="px-4 py-2.5 text-left font-medium">
                    Department &amp; Doctor
                  </th>
                  <th className="px-4 py-2.5 text-left font-medium">Method</th>
                  <th className="px-4 py-2.5 text-right font-medium">
                    Amount paid
                  </th>
                  <th className="px-4 py-2.5 text-right font-medium">
                    Remaining balance
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/40">
                {settlements.map((s) => (
                  <SettlementTxnRow key={s.id} row={s} />
                ))}
              </tbody>
              <tfoot className="bg-muted/30 font-semibold">
                <tr>
                  <td
                    className="px-4 py-3 text-xs uppercase tracking-wider text-muted-foreground"
                    colSpan={4}
                  >
                    Total settled
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-emerald-600 dark:text-emerald-400">
                    {fmtTRY(settlementsTotal)}
                  </td>
                  <td className="px-4 py-3" />
                </tr>
              </tfoot>
            </table>
          </div>

          <div className="hidden print:block px-6 py-4 text-[10px] text-muted-foreground border-t border-border">
            Settlement payments are amounts collected against outstanding
            balances from prior sessions.
          </div>
        </div>
      )}
    </div>
  );
}

function SummaryCell({
  icon: Icon,
  label,
  sublabel,
  amount,
  accent,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  sublabel?: string;
  amount: number;
  accent: string;
}) {
  return (
    <div className="bg-card px-4 py-4">
      <div className="flex items-center gap-1.5">
        <Icon className={cn("h-3.5 w-3.5", accent)} />
        <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </p>
      </div>
      <p className="mt-1 text-lg font-semibold tabular-nums">{fmtTRY(amount)}</p>
      {sublabel && (
        <p className="text-[10px] text-muted-foreground/80">{sublabel}</p>
      )}
    </div>
  );
}

function SettlementTxnRow({ row }: { row: SettlementRow }) {
  const meta = METHOD_META[row.payment_method];
  const MethodIcon = meta?.icon;
  const appt = row.appointment;
  const deptColor = appt?.departments?.color ?? "#64748b";
  const remaining = appt?.outstanding_amount ?? 0;

  return (
    <tr className="hover:bg-muted/30 transition-colors">
      <td className="px-4 py-2.5 text-xs text-muted-foreground whitespace-nowrap">
        {fmtDateTime(row.settled_at)}
      </td>
      <td className="px-4 py-2.5 font-medium">
        {row.patient?.full_name ?? "Unknown"}
      </td>
      <td className="px-4 py-2.5">
        {appt ? (
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-1.5">
              {appt.departments?.name ? (
                <span
                  className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider"
                  style={{
                    backgroundColor: `color-mix(in oklab, ${deptColor} 15%, transparent)`,
                    color: deptColor,
                  }}
                >
                  {appt.departments.name}
                </span>
              ) : (
                <span className="text-[11px] text-muted-foreground">
                  No department
                </span>
              )}
              {appt.profiles?.full_name && (
                <span className="text-xs font-medium">
                  Dr. {appt.profiles.full_name}
                </span>
              )}
            </div>
            <div className="text-[11px] text-muted-foreground">
              Session {fmtDate(appt.scheduled_at)}
              {appt.total_amount != null && (
                <span className="ml-2">
                  · total{" "}
                  <span className="tabular-nums font-medium text-foreground">
                    {fmtTRY(appt.total_amount)}
                  </span>
                </span>
              )}
            </div>
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">
            Patient-level balance
          </span>
        )}
        {row.note && (
          <p className="mt-1 text-[11px] italic text-muted-foreground">
            &ldquo;{row.note}&rdquo;
          </p>
        )}
      </td>
      <td className="px-4 py-2.5">
        <span className="inline-flex items-center gap-1 rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-0.5 text-xs">
          {MethodIcon && <MethodIcon className="h-3 w-3" />}
          {meta?.label ?? row.payment_method}
        </span>
      </td>
      <td className="px-4 py-2.5 text-right tabular-nums font-semibold text-emerald-600 dark:text-emerald-400">
        {fmtTRY(row.amount)}
      </td>
      <td className="px-4 py-2.5 text-right tabular-nums">
        {remaining > 0 ? (
          <span className="text-amber-600 dark:text-amber-400 font-medium">
            {fmtTRY(remaining)}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
            Settled
          </span>
        )}
      </td>
    </tr>
  );
}

function TxnRow({ row }: { row: RevenueRow }) {
  const primary = row.payment_method ? METHOD_META[row.payment_method] : null;
  const secondary = row.secondary_payment_method
    ? METHOD_META[row.secondary_payment_method]
    : null;
  const deptColor = row.departments?.color ?? "#64748b";

  return (
    <tr className="hover:bg-muted/30 transition-colors">
      <td className="px-4 py-2.5 text-xs text-muted-foreground whitespace-nowrap">
        {row.paid_at ? fmtDateTime(row.paid_at) : "—"}
      </td>
      <td className="px-4 py-2.5 font-medium">
        {row.patients?.full_name ?? "Unknown"}
      </td>
      <td className="px-4 py-2.5">
        <div className="text-xs">Dr. {row.profiles?.full_name ?? "—"}</div>
        {row.departments?.name && (
          <span
            className="mt-0.5 inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider"
            style={{
              backgroundColor: `color-mix(in oklab, ${deptColor} 15%, transparent)`,
              color: deptColor,
            }}
          >
            {row.departments.name}
          </span>
        )}
      </td>
      <td className="px-4 py-2.5 text-right tabular-nums font-medium">
        {fmtTRY(row.total_amount ?? 0)}
      </td>
      <td className="px-4 py-2.5">
        {primary ? (
          <span className="inline-flex items-center gap-1 text-xs">
            <primary.icon className="h-3 w-3 text-muted-foreground" />
            {primary.label}
            <span className="ml-1 tabular-nums font-medium">
              {fmtTRY(row.paid_amount ?? 0)}
            </span>
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </td>
      <td className="px-4 py-2.5">
        {secondary && (row.secondary_amount ?? 0) > 0 ? (
          <span className="inline-flex items-center gap-1 text-xs">
            <secondary.icon className="h-3 w-3 text-muted-foreground" />
            {secondary.label}
            <span className="ml-1 tabular-nums font-medium">
              {fmtTRY(row.secondary_amount ?? 0)}
            </span>
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </td>
      <td className="px-4 py-2.5 text-right tabular-nums text-sky-600 dark:text-sky-400">
        {(row.insurance_amount ?? 0) > 0
          ? fmtTRY(row.insurance_amount ?? 0)
          : "—"}
      </td>
      <td className="px-4 py-2.5 text-right tabular-nums text-violet-600 dark:text-violet-400">
        {(row.deposit_amount ?? 0) > 0
          ? fmtTRY(row.deposit_amount ?? 0)
          : "—"}
      </td>
      <td className="px-4 py-2.5 text-right tabular-nums">
        {(row.outstanding_amount ?? 0) > 0 ? (
          <span className="text-amber-600 dark:text-amber-400 font-medium">
            {fmtTRY(row.outstanding_amount ?? 0)}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </td>
    </tr>
  );
}
