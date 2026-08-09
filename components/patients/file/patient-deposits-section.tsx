import Link from "next/link";
import { ArrowRight, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AddDepositDialog } from "@/components/patients/add-deposit-dialog";
import { formatClinicDate, type ClinicLocale } from "@/lib/datetime";
import type { PatientDepositTransaction } from "@/lib/patients/file-data";

/** Minimal translator shape (next-intl `getTranslations` result). */
type Translator = (key: string, values?: Record<string, string | number>) => string;

interface Props {
  t: Translator;
  patientId: string;
  patientName: string;
  accountBalance: number;
  transactions: PatientDepositTransaction[];
  formatMoney: (amount: number) => string;
  clinicLocale: ClinicLocale;
  canManage: boolean;
  viewAllHref: string;
  /** Existing patient billing summary, kept inside the financial/deposits group. */
  billingSummary?: React.ReactNode;
  /** Hide the "View all" link on the dedicated deposits page. */
  showViewAll?: boolean;
}

/**
 * P7-11 — Deposits section: current derived balance + recent transactions with
 * a link to the dedicated deposits page. Never rendered for scoped clinical
 * roles (financial). No ledger table exists — the balance is derived upstream.
 * Synchronous server component; the parent page passes `t`.
 */
export function PatientDepositsSection({
  t,
  patientId,
  patientName,
  accountBalance,
  transactions,
  formatMoney,
  clinicLocale,
  canManage,
  viewAllHref,
  billingSummary,
  showViewAll = true,
}: Props) {
  return (
    <section className="space-y-3" aria-labelledby="patient-deposits-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2
          id="patient-deposits-heading"
          className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground"
        >
          <Wallet className="h-4 w-4" />
          {t("deposits")}
        </h2>
        {canManage && (
          <AddDepositDialog patientId={patientId} patientName={patientName} />
        )}
      </div>

      <div className="rounded-xl border border-border/50 bg-card">
        <div className="flex items-center justify-between gap-4 border-b border-border/40 px-5 py-4">
          <div>
            <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              {t("accountBalance")}
            </p>
            <p className="mt-1 text-2xl font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
              {formatMoney(accountBalance)}
            </p>
          </div>
          {showViewAll && (
            <Button asChild variant="ghost" size="sm" className="h-8 gap-1">
              <Link href={viewAllHref}>
                {t("viewAllDeposits")}
                <ArrowRight className="h-3.5 w-3.5 rtl:rotate-180" />
              </Link>
            </Button>
          )}
        </div>

        {transactions.length > 0 ? (
          <ul className="divide-y divide-border/30">
            {transactions.map((tx) => (
              <li
                key={tx.id}
                className="flex flex-wrap items-center justify-between gap-2 px-5 py-3"
              >
                <div className="min-w-0 space-y-0.5">
                  <p className="text-sm font-medium tabular-nums text-emerald-600 dark:text-emerald-400">
                    + {formatMoney(tx.amount)}
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    {formatClinicDate(tx.created_at, clinicLocale, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                    {tx.recorded_by_name ? ` · ${tx.recorded_by_name}` : ""}
                  </p>
                  {tx.note && (
                    <p className="text-xs italic text-muted-foreground">
                      &ldquo;{tx.note}&rdquo;
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <div className="px-5 py-8 text-center text-sm text-muted-foreground">
            {t("noDepositsYet")}
          </div>
        )}
      </div>

      {billingSummary}
    </section>
  );
}
