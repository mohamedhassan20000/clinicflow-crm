"use client";

import { useRouter, useSearchParams } from "next/navigation";
import {
  Banknote,
  CreditCard,
  Landmark,
  ShieldCheck,
  Wallet,
  Receipt,
  TrendingUp,
  Building2,
} from "lucide-react";
import type { ComponentType } from "react";
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
  outstanding_amount: number | null;
  payment_method: PaymentMethod | null;
  secondary_payment_method: PaymentMethod | null;
  payment_note: string | null;
  patients: { full_name: string } | null;
  profiles: { full_name: string } | null;
  departments: { name: string; color: string } | null;
  insurance_providers: { name: string } | null;
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

  function updateParams(next: Record<string, string | null>) {
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    for (const [k, v] of Object.entries(next)) {
      if (v === null) params.delete(k);
      else params.set(k, v);
    }
    router.push(`/revenue?${params.toString()}`);
  }

  // ── totals ────────────────────────────────────────────────────────────
  const primaryTotal = rows.reduce((s, r) => s + (r.paid_amount ?? 0), 0);
  const secondaryTotal = rows.reduce((s, r) => s + (r.secondary_amount ?? 0), 0);
  const insuranceTotal = rows.reduce((s, r) => s + (r.insurance_amount ?? 0), 0);
  const outstandingTotal = rows.reduce(
    (s, r) => s + (r.outstanding_amount ?? 0),
    0,
  );
  const grossTotal = primaryTotal + secondaryTotal + insuranceTotal;

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
      <div className="rounded-xl border border-border/50 bg-card print:border-none print:bg-transparent">
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
            {rows.length} transaction{rows.length !== 1 ? "s" : ""}
          </div>
        </div>

        {/* Totals strip */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-border/40 border-b border-border/50">
          <SummaryCell
            icon={TrendingUp}
            label="Gross collected"
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
                <th className="px-4 py-2.5 text-right font-medium">Outstanding</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/40">
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-10 text-center text-sm text-muted-foreground">
                    No transactions in this period.
                  </td>
                </tr>
              ) : (
                rows.map((r) => <TxnRow key={r.id} row={r} />)
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
                  <td className="px-4 py-3 text-right tabular-nums text-amber-600 dark:text-amber-400">
                    {fmtTRY(outstandingTotal)}
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>

        {/* Print footer */}
        <div className="hidden print:block px-6 py-4 text-[10px] text-muted-foreground border-t border-border">
          This statement reflects completed appointments with a recorded
          payment within the specified period. Outstanding balances remain
          due and are not included in gross collected.
        </div>
      </div>
    </div>
  );
}

function SummaryCell({
  icon: Icon,
  label,
  amount,
  accent,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
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
    </div>
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
