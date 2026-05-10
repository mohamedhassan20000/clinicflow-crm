"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Banknote,
  CreditCard,
  Landmark,
  ShieldCheck,
  Wallet,
  Loader2,
  Plus,
  X,
  Trash2,
  Wallet2,
  Clock3,
  Receipt,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

export type PaymentMethod =
  | "cash"
  | "credit_card"
  | "paypal"
  | "bank_transfer"
  | "insurance";

export interface InvoiceLine {
  service_id: string | null;
  name: string;
  price: number;
  quantity: number;
}

export interface BillingPayload {
  line_items: InvoiceLine[];
  paid_amount: number;
  payment_method: PaymentMethod;
  insurance_amount: number;
  secondary_payment_method: PaymentMethod | null;
  secondary_amount: number;
  deposit_amount: number;
  payment_note: string | null;
  previous_settlement_amount?: number;
  previous_payment_method?: PaymentMethod | null;
  previous_note?: string | null;
}

export interface ServiceOption {
  id: string;
  name: string;
  price: number;
  department_id: string;
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
  /** Services scoped to the appointment's department */
  services: ServiceOption[];
  /** Patient's available account balance (un-spent deposits) */
  accountBalance: number;
  /** Existing unpaid balance from earlier appointments, excluding this invoice */
  previousOutstandingBalance?: number;
  patientName?: string;
  /** True while the billing context is being fetched from the server */
  loadingContext?: boolean;
  insuranceProviderName?: string | null;
  departmentName?: string | null;
  departmentColor?: string | null;
  initialPayload?: BillingPayload | null;
  draftKey?: number;
}

function fmtTRY(n: number) {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "TRY",
    maximumFractionDigits: 2,
  }).format(Number.isFinite(n) ? n : 0);
}

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

interface DraftLine extends InvoiceLine {
  _key: string;
}

export function BillingDialog({
  open,
  onOpenChange,
  onConfirm,
  isPending,
  hasInsurance,
  services,
  accountBalance,
  previousOutstandingBalance = 0,
  patientName,
  loadingContext,
  insuranceProviderName,
  departmentName,
  departmentColor,
  initialPayload,
  draftKey = 0,
}: BillingDialogProps) {
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [pickerValue, setPickerValue] = useState<string>("");
  const [paid, setPaid] = useState<string>("");
  const [insurance, setInsurance] = useState<string>("");
  const [deposit, setDeposit] = useState<string>("");
  const [method, setMethod] = useState<PaymentMethod>("cash");
  const [showSplit, setShowSplit] = useState(false);
  const [secondaryMethod, setSecondaryMethod] =
    useState<PaymentMethod>("credit_card");
  const [secondaryAmount, setSecondaryAmount] = useState<string>("");
  const [note, setNote] = useState("");
  const [deferAll, setDeferAll] = useState(false);
  const [previousSettlement, setPreviousSettlement] = useState("");
  const [previousMethod, setPreviousMethod] = useState<PaymentMethod | null>(null);
  const [previousNote, setPreviousNote] = useState("");

  const totalN = useMemo(
    () =>
      Number(
        lines.reduce((s, l) => s + l.price * l.quantity, 0).toFixed(2),
      ),
    [lines],
  );

  const paidN = Math.max(0, Number(paid) || 0);
  const insuranceN = Math.max(0, Number(insurance) || 0);

  // Cap deposit at min(balance, total - other payments) to keep math sane
  const depositRaw = Math.max(0, Number(deposit) || 0);
  const depositN = Math.min(
    depositRaw,
    accountBalance,
    Math.max(0, totalN),
  );

  const secondaryRaw = showSplit ? Number(secondaryAmount) || 0 : 0;
  const secondaryN = Number.isFinite(secondaryRaw)
    ? Math.max(0, secondaryRaw)
    : 0;

  const collected = paidN + insuranceN + secondaryN + depositN;
  const remaining = Math.max(0, Number((totalN - collected).toFixed(2)));
  const previousBalanceN = Math.max(0, Number(previousOutstandingBalance) || 0);
  const previousRaw =
    previousSettlement.trim() === "" ? 0 : Number(previousSettlement);
  const previousInputInvalid =
    previousSettlement.trim() !== "" &&
    (!Number.isFinite(previousRaw) || previousRaw < 0);
  const previousSettlementN = previousInputInvalid
    ? 0
    : Number(Math.max(0, previousRaw).toFixed(2));
  const previousAboveBalance = previousSettlementN > previousBalanceN + 0.001;
  const previousMethodMissing = previousSettlementN > 0 && !previousMethod;
  const previousRemaining = Math.max(
    0,
    Number((previousBalanceN - Math.min(previousSettlementN, previousBalanceN)).toFixed(2)),
  );
  const totalCollectedToday = Number(
    (collected + (previousAboveBalance ? 0 : previousSettlementN)).toFixed(2),
  );

  const canSubmit =
    lines.length > 0 &&
    totalN > 0 &&
    collected <= totalN + 0.001 &&
    (!showSplit || secondaryMethod !== method) &&
    !previousInputInvalid &&
    !previousAboveBalance &&
    !previousMethodMissing &&
    !isPending;

  function reset() {
    setLines([]);
    setPickerValue("");
    setPaid("");
    setInsurance("");
    setDeposit("");
    setMethod("cash");
    setShowSplit(false);
    setSecondaryMethod("credit_card");
    setSecondaryAmount("");
    setNote("");
    setDeferAll(false);
    setPreviousSettlement("");
    setPreviousMethod(null);
    setPreviousNote("");
  }

  function applyPayload(payload: BillingPayload) {
    setLines(
      payload.line_items.map((line) => ({
        ...line,
        _key: uid(),
      })),
    );
    setPickerValue("");
    setPaid(payload.paid_amount ? String(payload.paid_amount) : "");
    setInsurance(
      payload.insurance_amount ? String(payload.insurance_amount) : "",
    );
    setDeposit(payload.deposit_amount ? String(payload.deposit_amount) : "");
    setMethod(payload.payment_method);
    setShowSplit(Boolean(payload.secondary_payment_method));
    setSecondaryMethod(payload.secondary_payment_method ?? "credit_card");
    setSecondaryAmount(
      payload.secondary_amount ? String(payload.secondary_amount) : "",
    );
    setNote(payload.payment_note ?? "");
    setDeferAll(false);
    setPreviousSettlement(
      payload.previous_settlement_amount
        ? String(payload.previous_settlement_amount)
        : "",
    );
    setPreviousMethod(payload.previous_payment_method ?? null);
    setPreviousNote(payload.previous_note ?? "");
  }

  // Reset when dialog re-opens (so we don't keep stale state across appointments)
  useEffect(() => {
    if (!open) return;
    queueMicrotask(() => {
      if (initialPayload) applyPayload(initialPayload);
      else reset();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, draftKey]);

  function addServiceById(serviceId: string) {
    const svc = services.find((s) => s.id === serviceId);
    if (!svc) return;
    setLines((prev) => {
      // Bump quantity if already present
      const idx = prev.findIndex((l) => l.service_id === svc.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = { ...next[idx], quantity: next[idx].quantity + 1 };
        return next;
      }
      return [
        ...prev,
        {
          _key: uid(),
          service_id: svc.id,
          name: svc.name,
          price: Number(svc.price),
          quantity: 1,
        },
      ];
    });
    setPickerValue("");
  }

  function addCustomLine() {
    setLines((prev) => [
      ...prev,
      { _key: uid(), service_id: null, name: "", price: 0, quantity: 1 },
    ]);
  }

  function updateLine(key: string, patch: Partial<DraftLine>) {
    setLines((prev) =>
      prev.map((l) => (l._key === key ? { ...l, ...patch } : l)),
    );
  }

  function removeLine(key: string) {
    setLines((prev) => prev.filter((l) => l._key !== key));
  }

  function handleSubmit() {
    if (!canSubmit) return;
    const payload: BillingPayload = {
      line_items: lines.map((l) => ({
        service_id: l.service_id,
        name: l.name.trim() || "Service",
        price: Number(Number(l.price).toFixed(2)),
        quantity: Math.max(1, Math.floor(l.quantity)),
      })),
      paid_amount: Number(paidN.toFixed(2)),
      payment_method: method,
      insurance_amount: Number(insuranceN.toFixed(2)),
      secondary_payment_method:
        showSplit && secondaryN > 0 ? secondaryMethod : null,
      secondary_amount: showSplit ? Number(secondaryN.toFixed(2)) : 0,
      deposit_amount: Number(depositN.toFixed(2)),
      payment_note: note.trim() || null,
      ...(previousSettlementN > 0 && previousMethod
        ? {
            previous_settlement_amount: previousSettlementN,
            previous_payment_method: previousMethod,
            previous_note: previousNote.trim() || null,
          }
        : {}),
    };
    onConfirm(payload);
  }

  const remainingBalanceAfter = Math.max(
    0,
    Number((accountBalance - depositN).toFixed(2)),
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Invoice — complete appointment</DialogTitle>
          <DialogDescription>
            Add the services performed, then record how the patient paid.
            {patientName ? ` Patient: ${patientName}.` : ""}
          </DialogDescription>
          {(departmentName || patientName) && (
            <div className="flex flex-wrap items-center gap-2 pt-2">
              {departmentName && (
                <span
                  className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-muted/50 px-2.5 py-1 text-[11px] font-medium"
                  title="Department"
                >
                  <span
                    className="h-2 w-2 rounded-full"
                    style={{ backgroundColor: departmentColor ?? "#0891B2" }}
                    aria-hidden
                  />
                  {departmentName}
                </span>
              )}
              {insuranceProviderName && (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-sky-500/30 bg-sky-500/10 px-2.5 py-1 text-[11px] font-medium text-sky-700 dark:text-sky-300">
                  <ShieldCheck className="h-3 w-3" />
                  {insuranceProviderName}
                </span>
              )}
            </div>
          )}
        </DialogHeader>

        {loadingContext && (
          <div className="flex items-center gap-2 rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading price list and patient billing details in the background.
          </div>
        )}

        <div className="space-y-5 py-1">
          {/* Summary strip */}
          <div className="grid grid-cols-3 gap-2 rounded-lg border border-border/60 bg-muted/30 p-3 text-center">
            <div>
              <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                Invoice total
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
                Outstanding
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

          {/* Line items */}
          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs">Services</Label>
              <span className="text-[11px] text-muted-foreground">
                {lines.length} item{lines.length !== 1 ? "s" : ""}
              </span>
            </div>

            <div className="rounded-lg border border-border/60 bg-card overflow-hidden">
              {lines.length === 0 ? (
                <div className="px-4 py-6 text-center text-xs text-muted-foreground">
                  No services on the invoice yet. Pick one from the list below
                  or add a custom line.
                </div>
              ) : (
                <div className="divide-y divide-border/60">
                  {lines.map((l) => {
                    const lineTotal = Number(
                      (l.price * l.quantity).toFixed(2),
                    );
                    return (
                      <div
                        key={l._key}
                        className="grid grid-cols-12 gap-2 items-center px-3 py-2"
                      >
                        <div className="col-span-5">
                          {l.service_id ? (
                            <p className="text-sm font-medium truncate">
                              {l.name}
                            </p>
                          ) : (
                            <Input
                              value={l.name}
                              placeholder="Custom service"
                              disabled={isPending}
                              onChange={(e) =>
                                updateLine(l._key, { name: e.target.value })
                              }
                              className="h-8 text-sm"
                            />
                          )}
                        </div>
                        <div className="col-span-3">
                          <Input
                            type="number"
                            inputMode="decimal"
                            min={0}
                            step="0.01"
                            value={l.price}
                            disabled={isPending}
                            onChange={(e) =>
                              updateLine(l._key, {
                                price: Math.max(0, Number(e.target.value) || 0),
                              })
                            }
                            className="h-8 text-sm tabular-nums"
                          />
                        </div>
                        <div className="col-span-2">
                          <Input
                            type="number"
                            inputMode="numeric"
                            min={1}
                            step={1}
                            value={l.quantity}
                            disabled={isPending}
                            onChange={(e) =>
                              updateLine(l._key, {
                                quantity: Math.max(
                                  1,
                                  Math.floor(Number(e.target.value) || 1),
                                ),
                              })
                            }
                            className="h-8 text-sm tabular-nums"
                          />
                        </div>
                        <div className="col-span-1 text-right text-xs font-semibold tabular-nums">
                          {fmtTRY(lineTotal)}
                        </div>
                        <div className="col-span-1 flex justify-end">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={isPending}
                            onClick={() => removeLine(l._key)}
                            className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                            aria-label="Remove line"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <div className="flex-1 min-w-[200px]">
                <Select
                  value={pickerValue}
                  onValueChange={(v) => addServiceById(v)}
                  disabled={isPending || services.length === 0}
                >
                  <SelectTrigger className="h-9 text-sm">
                    <SelectValue
                      placeholder={
                        services.length === 0
                          ? "No services in this department"
                          : "Add a service from the price list…"
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {services.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        <span className="flex justify-between gap-4 w-full">
                          <span className="truncate">{s.name}</span>
                          <span className="text-muted-foreground tabular-nums">
                            {fmtTRY(s.price)}
                          </span>
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={isPending}
                onClick={addCustomLine}
                className="gap-1.5 h-9"
              >
                <Plus className="h-3.5 w-3.5" />
                Custom line
              </Button>
            </div>
          </section>

          {/* Pay-later toggle */}
          <button
            type="button"
            disabled={isPending}
            onClick={() => setDeferAll((v) => !v)}
            className={cn(
              "flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2.5 text-left text-xs transition",
              deferAll
                ? "border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                : "border-dashed border-border/70 text-muted-foreground hover:border-amber-500/40 hover:text-foreground",
            )}
          >
            <span className="flex items-center gap-2">
              <Clock3 className="h-4 w-4" />
              <span className="font-medium">
                Pay later — collect part now, remainder on patient file
              </span>
            </span>
            <span
              aria-hidden
              className={cn(
                "inline-flex h-4 w-7 items-center rounded-full border transition",
                deferAll
                  ? "border-amber-500 bg-amber-500/30 justify-end"
                  : "border-border bg-muted justify-start",
              )}
            >
              <span className="m-0.5 h-3 w-3 rounded-full bg-card shadow-sm" />
            </span>
          </button>

          {deferAll && totalN > 0 && (
            <p className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-400">
              Enter any partial payment collected now below — the unpaid
              difference will become outstanding and can be settled from the
              patient&apos;s file.
            </p>
          )}

          {/* Account balance */}
          {accountBalance > 0 && (
            <section className="space-y-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3">
              <div className="flex items-center justify-between gap-2">
                <Label
                  htmlFor="bill-deposit"
                  className="flex items-center gap-1.5 text-xs"
                >
                  <Wallet2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                  Apply from patient account
                </Label>
                <span className="text-[11px] text-muted-foreground">
                  Available{" "}
                  <span className="font-semibold tabular-nums text-emerald-700 dark:text-emerald-400">
                    {fmtTRY(accountBalance)}
                  </span>
                </span>
              </div>
              <div className="flex gap-2 items-center">
                <Input
                  id="bill-deposit"
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step="0.01"
                  placeholder="0.00"
                  value={deposit}
                  disabled={isPending}
                  onChange={(e) => setDeposit(e.target.value)}
                  className="h-9 text-sm"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={isPending}
                  onClick={() =>
                    setDeposit(
                      String(Math.min(accountBalance, totalN).toFixed(2)),
                    )
                  }
                >
                  Use max
                </Button>
              </div>
              {depositN > 0 && (
                <p className="text-[11px] text-muted-foreground">
                  Remaining account balance after this invoice:{" "}
                  <span className="font-semibold tabular-nums">
                    {fmtTRY(remainingBalanceAfter)}
                  </span>
                </p>
              )}
            </section>
          )}

          {/* Patient paid now */}
          <div className={cn("space-y-1.5")}>
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

          {/* Primary method */}
          <div className={cn("space-y-1.5")}>
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
                    <Icon className={cn("h-4 w-4", active ? "text-primary" : "")} />
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
                {insuranceProviderName
                  ? `Covered by ${insuranceProviderName} (₺)`
                  : "Covered by insurance (₺)"}
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

          {/* Split toggle */}
          <div className={cn(deferAll && "hidden")}>
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
                    Outstanding{" "}
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
                          className={cn("h-4 w-4", active ? "text-primary" : "")}
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
              {fmtTRY(remaining)} will be saved as outstanding on the
              patient&apos;s file (settle later).
            </p>
          )}

          {previousBalanceN > 0 && (
            <section className="space-y-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="space-y-1">
                  <Label
                    htmlFor="previous-settlement"
                    className="flex items-center gap-1.5 text-xs"
                  >
                    <Receipt className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
                    Previous outstanding balance
                  </Label>
                  <p className="text-[11px] text-muted-foreground">
                    Optional payment toward older unpaid appointments. This is
                    recorded separately from today&apos;s invoice.
                  </p>
                </div>
                <span className="text-[11px] text-muted-foreground">
                  Previous balance:{" "}
                  <span className="font-semibold tabular-nums text-amber-700 dark:text-amber-400">
                    {fmtTRY(previousBalanceN)}
                  </span>
                </span>
              </div>

              <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
                <div className="space-y-1.5">
                  <Label htmlFor="previous-settlement" className="text-xs">
                    Settle now (₺)
                  </Label>
                  <Input
                    id="previous-settlement"
                    type="number"
                    inputMode="decimal"
                    min={0}
                    max={previousBalanceN}
                    step="0.01"
                    placeholder="0.00"
                    value={previousSettlement}
                    disabled={isPending}
                    onChange={(event) => setPreviousSettlement(event.target.value)}
                    className="h-9 text-sm"
                    aria-invalid={previousInputInvalid || previousAboveBalance}
                  />
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={isPending}
                  onClick={() => setPreviousSettlement(previousBalanceN.toFixed(2))}
                >
                  Use full balance
                </Button>
              </div>

              {(previousInputInvalid || previousAboveBalance) && (
                <p className="text-[11px] text-destructive">
                  {previousInputInvalid
                    ? "Enter a positive amount or leave this blank."
                    : "Amount cannot exceed the previous balance."}
                </p>
              )}

              <div className="space-y-1.5">
                <Label className="text-xs">Previous balance payment method</Label>
                <div className="grid grid-cols-5 gap-1.5">
                  {METHODS.map(({ value, label, icon: Icon }) => {
                    const active = previousMethod === value;
                    return (
                      <button
                        key={value}
                        type="button"
                        disabled={isPending}
                        onClick={() => setPreviousMethod(value)}
                        className={cn(
                          "flex flex-col items-center gap-1 rounded-lg border px-1 py-2 text-[10px] font-medium transition-all",
                          active
                            ? "border-amber-500 bg-amber-500/10 text-foreground ring-2 ring-amber-500/20"
                            : "border-border/60 bg-card text-muted-foreground hover:border-amber-500/50 hover:bg-amber-500/5",
                        )}
                      >
                        <Icon
                          className={cn(
                            "h-4 w-4",
                            active && "text-amber-600 dark:text-amber-400",
                          )}
                        />
                        {label}
                      </button>
                    );
                  })}
                </div>
                {previousMethodMissing && (
                  <p className="text-[11px] text-destructive">
                    Select a payment method for previous balance.
                  </p>
                )}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="previous-note" className="text-xs">
                  Previous balance note (optional)
                </Label>
                <Textarea
                  id="previous-note"
                  rows={2}
                  placeholder="Receipt number, context, etc."
                  value={previousNote}
                  disabled={isPending}
                  onChange={(event) => setPreviousNote(event.target.value)}
                  className="resize-none text-sm"
                />
              </div>

              <div className="grid grid-cols-3 gap-px overflow-hidden rounded-lg border border-border/50 bg-border/40">
                <SummaryCell label="Previous balance" amount={previousBalanceN} />
                <SummaryCell
                  label="Settled now"
                  amount={previousAboveBalance ? 0 : previousSettlementN}
                  accent={
                    previousSettlementN > 0 && !previousAboveBalance
                      ? "text-emerald-600 dark:text-emerald-400"
                      : "text-muted-foreground"
                  }
                />
                <SummaryCell
                  label="Remaining previous balance"
                  amount={previousRemaining}
                  accent={
                    previousRemaining > 0
                      ? "text-amber-600 dark:text-amber-400"
                      : "text-muted-foreground"
                  }
                />
              </div>

              <div className="flex items-center justify-between gap-2 rounded-md border border-border/50 bg-card px-3 py-2 text-xs">
                <span className="font-medium text-muted-foreground">
                  Total collected today
                </span>
                <span className="font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
                  {fmtTRY(totalCollectedToday)}
                </span>
              </div>
            </section>
          )}

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
            {remaining > 0 && totalN > 0
              ? "Complete with outstanding"
              : "Complete & charge"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
