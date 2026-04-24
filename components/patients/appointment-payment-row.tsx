"use client";

import { useState } from "react";
import {
  AlertCircle,
  Banknote,
  ChevronDown,
  CreditCard,
  Landmark,
  ShieldCheck,
  Wallet,
} from "lucide-react";
import { cn } from "@/lib/utils";

const PAYMENT_META: Record<
  string,
  { label: string; icon: React.ComponentType<{ className?: string }> }
> = {
  cash: { label: "Cash", icon: Banknote },
  credit_card: { label: "Credit card", icon: CreditCard },
  paypal: { label: "PayPal", icon: Wallet },
  bank_transfer: { label: "Bank transfer", icon: Landmark },
  insurance: { label: "Insurance", icon: ShieldCheck },
};

const STATUS_BADGE: Record<string, string> = {
  scheduled: "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20",
  confirmed: "bg-primary/10 text-primary border-primary/20",
  completed:
    "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20",
  cancelled: "bg-destructive/10 text-destructive border-destructive/20",
  no_show: "bg-muted text-muted-foreground border-border",
};

export interface AppointmentPaymentRowData {
  id: string;
  scheduled_at: string;
  status: string;
  paid_at: string | null;
  total_amount: number | null;
  paid_amount: number | null;
  insurance_amount: number | null;
  secondary_amount: number | null;
  deposit_amount: number | null;
  outstanding_amount: number | null;
  payment_method: string | null;
  secondary_payment_method: string | null;
  payment_note: string | null;
  profiles: { full_name: string } | null;
  departments: { name: string; color: string } | null;
  insurance_providers: { name: string } | null;
}

function fmtTRY(n: number) {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "TRY",
    maximumFractionDigits: 2,
  }).format(Number.isFinite(n) ? n : 0);
}

export function AppointmentPaymentRow({ a }: { a: AppointmentPaymentRowData }) {
  const [open, setOpen] = useState(false);
  const dt = new Date(a.scheduled_at);
  const isCompleted = a.status === "completed";
  const primary = a.payment_method ? PAYMENT_META[a.payment_method] : null;
  const secondary = a.secondary_payment_method
    ? PAYMENT_META[a.secondary_payment_method]
    : null;
  const PrimaryIcon = primary?.icon;
  const SecondaryIcon = secondary?.icon;
  const deptColor = a.departments?.color ?? "#64748b";
  const outstanding = a.outstanding_amount ?? 0;
  const paid = a.paid_amount ?? 0;
  const insurance = a.insurance_amount ?? 0;
  const secondaryAmt = a.secondary_amount ?? 0;
  const deposit = a.deposit_amount ?? 0;
  const collected = paid + insurance + secondaryAmt + deposit;

  return (
    <div className="border-b border-border/30 last:border-0">
      <button
        type="button"
        onClick={() => isCompleted && setOpen((v) => !v)}
        disabled={!isCompleted}
        className={cn(
          "flex w-full items-center justify-between gap-4 px-5 py-3.5 text-left transition-colors",
          isCompleted ? "hover:bg-muted/30 cursor-pointer" : "cursor-default",
        )}
      >
        <div className="min-w-0 space-y-0.5">
          <div className="text-sm font-medium">
            {dt.toLocaleDateString("en-GB", {
              day: "2-digit",
              month: "short",
              year: "numeric",
            })}
            <span className="text-muted-foreground font-normal">
              {" · "}
              {dt.toLocaleTimeString("en-GB", {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="truncate">
              Dr. {a.profiles?.full_name ?? "Unassigned"}
            </span>
            {a.departments?.name && (
              <span
                className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider"
                style={{
                  backgroundColor: `color-mix(in oklab, ${deptColor} 14%, transparent)`,
                  color: deptColor,
                }}
              >
                {a.departments.name}
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {isCompleted && (a.total_amount ?? 0) > 0 && (
            <span className="text-sm font-semibold tabular-nums">
              {fmtTRY(a.total_amount ?? 0)}
            </span>
          )}
          {outstanding > 0 && (
            <span className="inline-flex items-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400">
              <AlertCircle className="h-3 w-3" />
              {fmtTRY(outstanding)}
            </span>
          )}
          <span
            className={cn(
              "inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-medium capitalize",
              STATUS_BADGE[a.status] ?? STATUS_BADGE.scheduled,
            )}
          >
            {a.status.replace("_", " ")}
          </span>
          {isCompleted && (
            <ChevronDown
              className={cn(
                "h-4 w-4 text-muted-foreground transition-transform",
                open && "rotate-180",
              )}
            />
          )}
        </div>
      </button>

      {isCompleted && open && (
        <div className="space-y-3 border-t border-border/30 bg-muted/20 px-5 py-4">
          {/* Summary strip */}
          <div className="grid grid-cols-3 gap-px overflow-hidden rounded-lg border border-border/50 bg-border/40">
            <SummaryCell label="Total" amount={a.total_amount ?? 0} />
            <SummaryCell
              label="Collected"
              amount={collected}
              accent="text-emerald-600 dark:text-emerald-400"
            />
            <SummaryCell
              label="Outstanding"
              amount={outstanding}
              accent={
                outstanding > 0
                  ? "text-amber-600 dark:text-amber-400"
                  : "text-muted-foreground"
              }
            />
          </div>

          {/* Breakdown pills */}
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            {deposit > 0 && (
              <Pill className="border-violet-500/30 bg-violet-500/5 text-violet-700 dark:text-violet-400">
                <Wallet className="h-3 w-3" />
                Deposit
                <span className="tabular-nums font-medium">
                  {fmtTRY(deposit)}
                </span>
              </Pill>
            )}
            {primary && PrimaryIcon && paid > 0 && (
              <Pill>
                <PrimaryIcon className="h-3 w-3" />
                {primary.label}
                <span className="tabular-nums font-medium">{fmtTRY(paid)}</span>
              </Pill>
            )}
            {secondary && SecondaryIcon && secondaryAmt > 0 && (
              <Pill className="border-cyan-500/30 bg-cyan-500/5 text-cyan-700 dark:text-cyan-400">
                <SecondaryIcon className="h-3 w-3" />
                {secondary.label}
                <span className="tabular-nums font-medium">
                  {fmtTRY(secondaryAmt)}
                </span>
              </Pill>
            )}
            {insurance > 0 && (
              <Pill className="border-sky-500/30 bg-sky-500/5 text-sky-700 dark:text-sky-400">
                <ShieldCheck className="h-3 w-3" />
                {a.insurance_providers?.name ?? "Insurance"}
                <span className="tabular-nums font-medium">
                  {fmtTRY(insurance)}
                </span>
              </Pill>
            )}
            {outstanding > 0 && (
              <Pill className="border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400">
                <AlertCircle className="h-3 w-3" />
                Outstanding
                <span className="tabular-nums font-semibold">
                  {fmtTRY(outstanding)}
                </span>
              </Pill>
            )}
          </div>

          {a.payment_note && (
            <p className="text-xs italic text-muted-foreground">
              &ldquo;{a.payment_note}&rdquo;
            </p>
          )}
          {a.paid_at && (
            <p className="text-[11px] text-muted-foreground">
              Paid on{" "}
              {new Date(a.paid_at).toLocaleString("en-GB", {
                dateStyle: "medium",
                timeStyle: "short",
              })}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function SummaryCell({
  label,
  amount,
  accent,
}: {
  label: string;
  amount: number;
  accent?: string;
}) {
  return (
    <div className="bg-card px-3 py-2">
      <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p
        className={cn(
          "mt-0.5 text-sm font-semibold tabular-nums",
          accent,
        )}
      >
        {fmtTRY(amount)}
      </p>
    </div>
  );
}

function Pill({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border border-border/60 bg-muted/40 px-2 py-0.5",
        className,
      )}
    >
      {children}
    </span>
  );
}
