"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Banknote,
  CreditCard,
  Landmark,
  Loader2,
  Plus,
  ShieldCheck,
  Wallet,
  X,
} from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { settleOutstanding } from "@/actions/patients";
import { useClinicSettings } from "@/contexts/clinic-settings-context";
import { useTranslations } from "next-intl";

type PaymentMethod =
  | "cash"
  | "credit_card"
  | "paypal"
  | "bank_transfer"
  | "insurance";

const METHODS: {
  value: PaymentMethod;
  labelKey: string;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  { value: "cash", labelKey: "paymentCash", icon: Banknote },
  { value: "credit_card", labelKey: "paymentCreditCard", icon: CreditCard },
  { value: "paypal", labelKey: "paymentPaypal", icon: Wallet },
  { value: "bank_transfer", labelKey: "paymentBankTransfer", icon: Landmark },
  { value: "insurance", labelKey: "paymentInsurance", icon: ShieldCheck },
];

interface Props {
  patientId: string;
  outstanding: number;
  patientName: string;
  triggerLabel?: string;
}

export function SettleOutstandingDialog({
  patientId,
  outstanding,
  patientName,
  triggerLabel = "Settle outstanding",
}: Props) {
  const t = useTranslations("patients");
  const { formatCurrency } = useClinicSettings();
  const fmtMoney = (n: number) => formatCurrency(n);
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState<string>("");
  const [method, setMethod] = useState<PaymentMethod>("cash");
  const [note, setNote] = useState("");
  const [showSplit, setShowSplit] = useState(false);
  const [secondaryMethod, setSecondaryMethod] =
    useState<PaymentMethod>("credit_card");
  const [secondaryAmount, setSecondaryAmount] = useState<string>("");

  const [state, formAction, isPending] = useActionState(
    settleOutstanding,
    null,
  );
  const router = useRouter();

  useEffect(() => {
    if (!state) return;
    if (state.error) {
      toast.error(state.error);
    } else {
      toast.success(t("outstandingBalanceSettled"));
      router.refresh();
      // Defer state resets so we don't trigger cascading renders within the effect.
      queueMicrotask(() => {
        setOpen(false);
        setAmount("");
        setMethod("cash");
        setNote("");
        setShowSplit(false);
        setSecondaryAmount("");
        setSecondaryMethod("credit_card");
      });
    }
  }, [router, state]);

  const amountN = Number(amount) || 0;
  const secondaryN = showSplit ? Math.max(0, Number(secondaryAmount) || 0) : 0;
  const totalN = Number((amountN + secondaryN).toFixed(2));
  const invalid =
    totalN <= 0 ||
    totalN > outstanding + 0.001 ||
    (showSplit && (secondaryN <= 0 || secondaryMethod === method));

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-8 gap-1.5 border-amber-500/40 bg-amber-500/10 text-amber-700 hover:bg-amber-500/15 hover:text-amber-800 dark:text-amber-400 dark:hover:text-amber-300"
        onClick={() => {
          setAmount(outstanding > 0 ? String(outstanding) : "");
          setOpen(true);
        }}
      >
        <Wallet className="h-3.5 w-3.5" />
        {triggerLabel}
      </Button>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (isPending) return;
          setOpen(next);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("settleOutstandingBalance")}</DialogTitle>
            <DialogDescription>
              {t("recordOutstandingPayment", {
                patient: patientName,
                amount: fmtMoney(outstanding),
              })}
            </DialogDescription>
          </DialogHeader>

          <form action={formAction} className="space-y-4 py-1">
            <input type="hidden" name="patient_id" value={patientId} />
            <input type="hidden" name="payment_method" value={method} />
            {showSplit && secondaryN > 0 && (
              <>
                <input
                  type="hidden"
                  name="secondary_payment_method"
                  value={secondaryMethod}
                />
                <input
                  type="hidden"
                  name="secondary_amount"
                  value={secondaryN.toFixed(2)}
                />
              </>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="settle-amount" className="text-xs">
                {t("amount")}</Label>
              <Input
                id="settle-amount"
                name="amount"
                type="number"
                inputMode="decimal"
                min={0}
                max={outstanding}
                step="0.01"
                placeholder="0.00"
                value={amount}
                disabled={isPending}
                onChange={(e) => setAmount(e.target.value)}
                autoFocus
              />
              <p className="text-[11px] text-muted-foreground">
                {t("max")}{fmtMoney(outstanding)}
                {showSplit && totalN > outstanding + 0.001 && (
                  <span className="ms-2 text-destructive">
                    {t("combinedTotalExceedsOutstanding")}</span>
                )}
              </p>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">{t("paymentMethod")}</Label>
              <div className="grid grid-cols-5 gap-1.5">
                {METHODS.map(({ value, labelKey, icon: Icon }) => {
                  const active = method === value;
                  return (
                    <button
                      key={value}
                      type="button"
                      disabled={isPending}
                      onClick={() => setMethod(value)}
                      className={cn(
                        "flex flex-col items-center gap-1 rounded-lg border px-1 py-2 text-[10px] font-medium transition-all",
                        active
                          ? "border-primary bg-primary/10 text-foreground ring-2 ring-primary/20"
                          : "border-border/60 bg-card text-muted-foreground hover:border-primary/50 hover:bg-primary/5",
                      )}
                    >
                      <Icon
                        className={cn("h-4 w-4", active ? "text-primary" : "")}
                      />
                      {t(labelKey)}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Split toggle */}
            <div>
              <button
                type="button"
                disabled={isPending}
                onClick={() => {
                  setShowSplit((v) => !v);
                  if (showSplit) setSecondaryAmount("");
                }}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition",
                  showSplit
                    ? "border-primary/40 bg-primary/5 text-primary hover:bg-primary/10"
                    : "border-dashed border-border/70 text-muted-foreground hover:border-amber-500/40 hover:text-foreground",
                )}
              >
                {showSplit ? (
                  <>
                    <X className="h-3.5 w-3.5" />
                    {t("removeSplitPayment")}</>
                ) : (
                  <>
                    <Plus className="h-3.5 w-3.5" />
                    {t("addSplitPayment")}</>
                )}
              </button>
            </div>

            {showSplit && (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="settle-secondary" className="text-xs">
                    {t("secondAmount")}</Label>
                  <Input
                    id="settle-secondary"
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="0.01"
                    placeholder="0.00"
                    value={secondaryAmount}
                    disabled={isPending}
                    onChange={(e) => setSecondaryAmount(e.target.value)}
                  />
                  <p className="text-[11px] text-muted-foreground">
                    {t("totalAgainstOutstanding")}{" "}
                    <span className="tabular-nums font-medium text-foreground">
                      {fmtMoney(totalN)}
                    </span>{" "}
                    / {fmtMoney(outstanding)}
                  </p>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs">{t("secondPaymentMethod")}</Label>
                  <div className="grid grid-cols-5 gap-1.5">
                    {METHODS.map(({ value, labelKey, icon: Icon }) => {
                      const active = secondaryMethod === value;
                      const disabled = value === method;
                      return (
                        <button
                          key={value}
                          type="button"
                          disabled={isPending || disabled}
                          onClick={() => setSecondaryMethod(value)}
                          className={cn(
                            "flex flex-col items-center gap-1 rounded-lg border px-1 py-2 text-[10px] font-medium transition-all",
                            active
                              ? "border-primary bg-primary/10 text-foreground ring-2 ring-primary/20"
                              : "border-border/60 bg-card text-muted-foreground hover:border-primary/50 hover:bg-primary/5",
                            disabled && "opacity-40 cursor-not-allowed",
                          )}
                        >
                          <Icon
                            className={cn(
                              "h-4 w-4",
                              active ? "text-primary" : "",
                            )}
                          />
                          {t(labelKey)}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="settle-note" className="text-xs">
                {t("noteOptional")}</Label>
              <Textarea
                id="settle-note"
                name="note"
                rows={2}
                placeholder={t("receiptNumberContextEtc")}
                value={note}
                disabled={isPending}
                onChange={(e) => setNote(e.target.value)}
                className="resize-none text-sm"
              />
            </div>

            <DialogFooter className="gap-2 sm:gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setOpen(false)}
                disabled={isPending}
              >
                {t("cancel")}</Button>
              <Button
                type="submit"
                disabled={isPending || invalid}
                className="gap-2"
              >
                {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                {t("recordPayment")}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
