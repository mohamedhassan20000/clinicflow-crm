"use client";

import { useMemo, useState } from "react";
import {
  Banknote,
  CreditCard,
  Landmark,
  ShieldCheck,
  Wallet,
  Loader2,
  Plus,
  X,
} from "lucide-react";
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

export type PaymentMethod =
  | "cash"
  | "credit_card"
  | "paypal"
  | "bank_transfer"
  | "insurance";

export interface BillingPayload {
  total_amount: number;
  paid_amount: number;
  payment_method: PaymentMethod;
  insurance_amount: number;
  outstanding_amount: number;
  secondary_payment_method: PaymentMethod | null;
  secondary_amount: number;
  payment_note: string | null;
}

const METHODS: {
  value: PaymentMethod;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  { value: "cash", label: "Cash", icon: Banknote },
  { value: "credit_card", label: "Credit card", icon: CreditCard },
  { value: "paypal", label: "PayPal", icon: Wallet },
  { value: "bank_transfer", label: "Bank transfer", icon: Landmark },
  { value: "insurance", label: "Insurance", icon: ShieldCheck },
];

interface BillingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (payload: BillingPayload) => void;
  isPending?: boolean;
  hasInsurance?: boolean;
  defaultTotal?: number;
}

function fmtTRY(n: number) {
  return new Intl.NumberFormat("tr-TR", {
    style: "currency",
    currency: "TRY",
    maximumFractionDigits: 2,
  }).format(Number.isFinite(n) ? n : 0);
}

export function BillingDialog({
  open,
  onOpenChange,
  onConfirm,
  isPending,
  hasInsurance,
  defaultTotal = 0,
}: BillingDialogProps) {
  const [total, setTotal] = useState<string>(defaultTotal ? String(defaultTotal) : "");
  const [paid, setPaid] = useState<string>("");
  const [insurance, setInsurance] = useState<string>("");
  const [method, setMethod] = useState<PaymentMethod>("cash");
  const [showSplit, setShowSplit] = useState(false);
  const [secondaryMethod, setSecondaryMethod] =
    useState<PaymentMethod>("credit_card");
  const [secondaryAmount, setSecondaryAmount] = useState<string>("");
  const [note, setNote] = useState("");

  const totalN = Number(total) || 0;
  const paidN = Number(paid) || 0;
  const insuranceN = Number(insurance) || 0;

  const secondaryRaw = showSplit ? Number(secondaryAmount) || 0 : 0;
  const secondaryN = Number.isFinite(secondaryRaw) ? Math.max(0, secondaryRaw) : 0;

  const collected = paidN + insuranceN + secondaryN;
  const remaining = useMemo(
    () => Math.max(0, totalN - collected),
    [totalN, collected],
  );

  const canSubmit =
    totalN > 0 &&
    paidN >= 0 &&
    insuranceN >= 0 &&
    secondaryN >= 0 &&
    collected <= totalN + 0.001 &&
    !isPending;

  function reset() {
    setTotal(defaultTotal ? String(defaultTotal) : "");
    setPaid("");
    setInsurance("");
    setMethod("cash");
    setShowSplit(false);
    setSecondaryMethod("credit_card");
    setSecondaryAmount("");
    setNote("");
  }

  function handleSubmit() {
    if (!canSubmit) return;
    const payload: BillingPayload = {
      total_amount: Number(totalN.toFixed(2)),
      paid_amount: Number(paidN.toFixed(2)),
      payment_method: method,
      insurance_amount: Number(insuranceN.toFixed(2)),
      outstanding_amount: Number(remaining.toFixed(2)),
      secondary_payment_method: showSplit && secondaryN > 0 ? secondaryMethod : null,
      secondary_amount: showSplit ? Number(secondaryN.toFixed(2)) : 0,
      payment_note: note.trim() || null,
    };
    onConfirm(payload);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Complete appointment — billing</DialogTitle>
          <DialogDescription>
            Record the total charge, how much was collected, and whether
            anything remains.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-1">
          {/* Summary strip */}
          <div className="grid grid-cols-3 gap-2 rounded-lg border border-border/60 bg-muted/30 p-3 text-center">
            <div>
              <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                Total
              </p>
              <p className="text-sm font-semibold tabular-nums">
                {fmtTRY(totalN)}
              </p>
            </div>
            <div>
              <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                Collected
              </p>
              <p className="text-sm font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
                {fmtTRY(collected)}
              </p>
            </div>
            <div>
              <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                Remaining
              </p>
              <p
                className={cn(
                  "text-sm font-semibold tabular-nums",
                  remaining > 0
                    ? "text-amber-600 dark:text-amber-400"
                    : "text-muted-foreground",
                )}
              >
                {fmtTRY(remaining)}
              </p>
            </div>
          </div>

          {/* Totals inputs */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="bill-total" className="text-xs">
                Total amount (₺)
              </Label>
              <Input
                id="bill-total"
                type="number"
                inputMode="decimal"
                min={0}
                step="0.01"
                placeholder="0.00"
                value={total}
                disabled={isPending}
                onChange={(e) => setTotal(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="bill-paid" className="text-xs">
                Patient paid now (₺)
              </Label>
              <Input
                id="bill-paid"
                type="number"
                inputMode="decimal"
                min={0}
                step="0.01"
                placeholder="0.00"
                value={paid}
                disabled={isPending}
                onChange={(e) => setPaid(e.target.value)}
              />
            </div>
          </div>

          {/* Primary method */}
          <div className="space-y-1.5">
            <Label className="text-xs">Primary payment method</Label>
            <div className="grid grid-cols-5 gap-1.5">
              {METHODS.map(({ value, label, icon: Icon }) => {
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
                      className={cn(
                        "h-4 w-4",
                        active ? "text-primary" : "",
                      )}
                    />
                    {label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Insurance */}
          {hasInsurance && (
            <div className="space-y-1.5 rounded-lg border border-sky-500/30 bg-sky-500/5 p-3">
              <Label htmlFor="bill-insurance" className="text-xs">
                Covered by insurance (₺)
              </Label>
              <Input
                id="bill-insurance"
                type="number"
                inputMode="decimal"
                min={0}
                step="0.01"
                placeholder="0.00"
                value={insurance}
                disabled={isPending}
                onChange={(e) => setInsurance(e.target.value)}
              />
            </div>
          )}

          {/* Split payment toggle */}
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
                  : "border-dashed border-border/70 text-muted-foreground hover:border-primary/50 hover:text-foreground",
              )}
            >
              {showSplit ? (
                <>
                  <X className="h-3.5 w-3.5" />
                  Remove split payment
                </>
              ) : (
                <>
                  <Plus className="h-3.5 w-3.5" />
                  Add split payment
                </>
              )}
            </button>
          </div>

          {/* Secondary method — mirrors Primary payment method section */}
          {showSplit && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="bill-secondary" className="text-xs">
                    Paid via another method (₺)
                  </Label>
                  <Input
                    id="bill-secondary"
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="0.01"
                    placeholder="0.00"
                    value={secondaryAmount}
                    disabled={isPending}
                    onChange={(e) => setSecondaryAmount(e.target.value)}
                  />
                </div>
                <div className="flex items-end">
                  <p className="text-[11px] text-muted-foreground pb-2">
                    Remaining{" "}
                    <span
                      className={cn(
                        "font-semibold tabular-nums",
                        remaining > 0
                          ? "text-amber-600 dark:text-amber-400"
                          : "text-emerald-600 dark:text-emerald-400",
                      )}
                    >
                      {fmtTRY(remaining)}
                    </span>
                  </p>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs">Secondary payment method</Label>
                <div className="grid grid-cols-5 gap-1.5">
                  {METHODS.map(({ value, label, icon: Icon }) => {
                    const active = secondaryMethod === value;
                    return (
                      <button
                        key={value}
                        type="button"
                        disabled={isPending}
                        onClick={() => setSecondaryMethod(value)}
                        className={cn(
                          "flex flex-col items-center gap-1 rounded-lg border px-1 py-2 text-[10px] font-medium transition-all",
                          active
                            ? "border-primary bg-primary/10 text-foreground ring-2 ring-primary/20"
                            : "border-border/60 bg-card text-muted-foreground hover:border-primary/50 hover:bg-primary/5",
                        )}
                      >
                        <Icon
                          className={cn(
                            "h-4 w-4",
                            active ? "text-primary" : "",
                          )}
                        />
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>
            </>
          )}

          {remaining > 0 && totalN > 0 && (
            <p className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-400">
              {fmtTRY(remaining)} will be saved as outstanding on the patient&apos;s file.
            </p>
          )}

          {/* Note */}
          <div className="space-y-1.5">
            <Label htmlFor="bill-note" className="text-xs">
              Billing note (optional)
            </Label>
            <Textarea
              id="bill-note"
              rows={2}
              placeholder="Discount reason, receipt number, etc."
              value={note}
              disabled={isPending}
              onChange={(e) => setNote(e.target.value)}
              className="resize-none text-sm"
            />
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isPending}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="gap-2"
          >
            {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            Complete & charge
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
