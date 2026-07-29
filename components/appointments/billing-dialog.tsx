"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
  Package,
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
import { useClinicSettings } from "@/contexts/clinic-settings-context";
import { useTranslations } from "next-intl";
import { ScopedAssistantLauncher } from "@/components/assistant/assistant-launcher-scope";
import {
  calculateInsuranceAmount,
  calculatePatientResponsibility,
  calculateRemainingPatientPayment,
  roundBillingCurrency,
  type InsuranceCalculationMode,
} from "@/lib/billing/appointment-allocation";

export type PaymentMethod =
  | "cash"
  | "credit_card"
  | "paypal"
  | "bank_transfer"
  | "insurance";
export type PatientPaymentMethod = Exclude<PaymentMethod, "insurance">;

export interface InvoiceLine {
  service_id: string | null;
  name: string;
  price: number;
  quantity: number;
}

export interface BillingPayload {
  line_items: InvoiceLine[];
  paid_amount: number;
  payment_method: PatientPaymentMethod;
  insurance_amount: number;
  insurance_calculation_mode: InsuranceCalculationMode;
  insurance_percentage: number | null;
  patient_responsibility: number;
  secondary_payment_method: PatientPaymentMethod | null;
  secondary_amount: number;
  deposit_amount: number;
  payment_note: string | null;
  previous_settlement_amount?: number;
  previous_payment_method?: PatientPaymentMethod | null;
  previous_note?: string | null;
}

export interface ServiceOption {
  id: string;
  name: string;
  price: number;
  department_id: string;
}

export interface BillingPackageInfo {
  name: string;
  totalSessions: number;
  usedSessions: number;
  remainingSessions: number;
  sessionNumber: number | null;
  pricePerSession: number | null;
}

const METHODS: {
  value: PatientPaymentMethod;
  labelKey: string;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  { value: "cash", labelKey: "paymentCash", icon: Banknote },
  { value: "credit_card", labelKey: "paymentCreditCard", icon: CreditCard },
  { value: "paypal", labelKey: "paymentPaypal", icon: Wallet },
  { value: "bank_transfer", labelKey: "paymentBankTransfer", icon: Landmark },
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
  previousOutstandingAction?: React.ReactNode;
  patientName?: string;
  /** True while the billing context is being fetched from the server */
  loadingContext?: boolean;
  insuranceProviderName?: string | null;
  departmentName?: string | null;
  departmentColor?: string | null;
  packageInfo?: BillingPackageInfo | null;
  initialPayload?: BillingPayload | null;
  draftKey?: number;
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
  previousOutstandingAction,
  patientName,
  loadingContext,
  insuranceProviderName,
  departmentName,
  departmentColor,
  packageInfo,
  initialPayload,
  draftKey = 0,
}: BillingDialogProps) {
  const t = useTranslations("appointments");
  const { formatCurrency } = useClinicSettings();
  const fmtMoney = (n: number) => formatCurrency(n);
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [pickerValue, setPickerValue] = useState<string>("");
  const [paid, setPaid] = useState<string>("");
  const [insurance, setInsurance] = useState<string>("");
  const [insuranceMode, setInsuranceMode] =
    useState<InsuranceCalculationMode>("amount");
  const [insurancePercentage, setInsurancePercentage] = useState<string>("");
  const [deposit, setDeposit] = useState<string>("");
  const [method, setMethod] = useState<PatientPaymentMethod>("cash");
  const [showSplit, setShowSplit] = useState(false);
  const [secondaryMethod, setSecondaryMethod] =
    useState<PatientPaymentMethod>("credit_card");
  const [secondaryAmount, setSecondaryAmount] = useState<string>("");
  const [note, setNote] = useState("");
  const [deferAll, setDeferAll] = useState(false);
  const [previousSettlement, setPreviousSettlement] = useState("");
  const [previousMethod, setPreviousMethod] =
    useState<PatientPaymentMethod | null>(null);
  const [previousNote, setPreviousNote] = useState("");
  const didPrefillRef = useRef(false);

  const totalN = useMemo(
    () =>
      Number(
        lines.reduce((s, l) => s + l.price * l.quantity, 0).toFixed(2),
      ),
    [lines],
  );

  const paidN = roundBillingCurrency(Math.max(0, Number(paid) || 0));
  const insuranceAmountRaw =
    insurance.trim() === "" ? 0 : Number(insurance);
  const insurancePercentageRaw =
    insurancePercentage.trim() === "" ? 0 : Number(insurancePercentage);
  const insuranceAmountInputInvalid =
    insuranceMode === "amount" &&
    insurance.trim() !== "" &&
    (!Number.isFinite(insuranceAmountRaw) || insuranceAmountRaw < 0);
  const insurancePercentageInputInvalid =
    insuranceMode === "percentage" &&
    (insurancePercentage.trim() === "" ||
      !Number.isFinite(insurancePercentageRaw) ||
      insurancePercentageRaw < 0 ||
      insurancePercentageRaw > 100);
  const insurancePercentageMissing =
    insuranceMode === "percentage" && insurancePercentage.trim() === "";
  const insuranceN =
    insuranceAmountInputInvalid || insurancePercentageInputInvalid
      ? 0
      : calculateInsuranceAmount({
          invoiceTotal: totalN,
          mode: insuranceMode,
          amount: insuranceAmountRaw,
          percentage:
            insuranceMode === "percentage" ? insurancePercentageRaw : null,
        });
  const insuranceAboveTotal = insuranceN > totalN + 0.001;
  const patientResponsibility = insuranceAboveTotal
    ? 0
    : calculatePatientResponsibility(totalN, insuranceN);

  const depositRaw = Math.max(0, Number(deposit) || 0);
  const depositN = roundBillingCurrency(depositRaw);
  const depositAboveBalance = depositN > accountBalance + 0.001;

  const secondaryRaw = showSplit ? Number(secondaryAmount) || 0 : 0;
  const secondaryN = Number.isFinite(secondaryRaw)
    ? Math.max(0, secondaryRaw)
    : 0;

  const patientPaid = roundBillingCurrency(paidN + secondaryN);
  const patientAllocated = roundBillingCurrency(patientPaid + depositN);
  const patientPaymentsAboveResponsibility =
    patientAllocated > patientResponsibility + 0.001;
  const totalAllocated = roundBillingCurrency(insuranceN + patientAllocated);
  const remaining = Math.max(
    0,
    roundBillingCurrency(patientResponsibility - patientAllocated),
  );
  const primaryRemainingAmount = calculateRemainingPatientPayment(
    patientResponsibility,
    secondaryN,
    depositN,
  );
  const secondaryRemainingAmount = calculateRemainingPatientPayment(
    patientResponsibility,
    paidN,
    depositN,
  );
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
    (
      patientPaid +
      (previousAboveBalance ? 0 : previousSettlementN)
    ).toFixed(2),
  );

  const canSubmit =
    lines.length > 0 &&
    totalN > 0 &&
    !insuranceAmountInputInvalid &&
    !insurancePercentageInputInvalid &&
    !insuranceAboveTotal &&
    !depositAboveBalance &&
    !patientPaymentsAboveResponsibility &&
    totalAllocated <= totalN + 0.001 &&
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
    setInsuranceMode("amount");
    setInsurancePercentage("");
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
    setInsuranceMode(payload.insurance_calculation_mode ?? "amount");
    setInsurancePercentage(
      payload.insurance_calculation_mode === "percentage" &&
        payload.insurance_percentage != null
        ? String(payload.insurance_percentage)
        : "",
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

  useEffect(() => {
    if (!open) {
      didPrefillRef.current = false;
      return;
    }
    if (initialPayload || didPrefillRef.current || !packageInfo?.pricePerSession) {
      return;
    }
    didPrefillRef.current = true;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setLines((current) =>
        current.length > 0
          ? current
          : [
              {
                _key: uid(),
                service_id: null,
                name: `${packageInfo.name} session`,
                price: Number(packageInfo.pricePerSession),
                quantity: 1,
              },
            ],
      );
    });
    return () => {
      cancelled = true;
    };
  }, [initialPayload, open, packageInfo]);

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
        name: l.name.trim() || t("service"),
        price: Number(Number(l.price).toFixed(2)),
        quantity: Math.max(1, Math.floor(l.quantity)),
      })),
      paid_amount: Number(paidN.toFixed(2)),
      payment_method: method,
      insurance_amount: Number(insuranceN.toFixed(2)),
      insurance_calculation_mode: insuranceMode,
      insurance_percentage:
        insuranceMode === "percentage"
          ? Number(insurancePercentageRaw.toFixed(2))
          : null,
      patient_responsibility: patientResponsibility,
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
        if (!next) {
          didPrefillRef.current = false;
          reset();
        }
        onOpenChange(next);
      }}
    >
      <DialogContent
        layout="flex"
        className="max-h-[calc(100dvh-1rem)] flex-col gap-0 overflow-hidden p-0 sm:max-h-[calc(100dvh-2rem)] sm:max-w-2xl"
      >
        <DialogHeader className="shrink-0 border-b border-border/60 p-4">
          <div className="flex flex-wrap items-start justify-between gap-2 pe-6">
            <DialogTitle>{t("invoiceCompleteAppointment")}</DialogTitle>
            <ScopedAssistantLauncher />
          </div>
          <DialogDescription>
            {t("billingDescription", { patient: patientName ? t("patientnamedsuffix", { patient: patientName }) : "" })}
          </DialogDescription>
          {(departmentName || patientName) && (
            <div className="flex flex-wrap items-center gap-2 pt-2">
              {departmentName && (
                <span
                  className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-muted/50 px-2.5 py-1 text-[11px] font-medium"
                  title={t("department")}
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

        <div
          className="billing-dialog-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4"
          data-testid="billing-dialog-scroll-area"
        >
          {loadingContext && (
            <div className="mb-4 flex items-center gap-2 rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t("loadingPriceListAndPatientBilling")}
            </div>
          )}

          <div className="space-y-5">
          {packageInfo && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-800 dark:text-emerald-300">
              <Package className="h-3.5 w-3.5" />
              <span className="font-medium">{packageInfo.name}</span>
              <span>{t("sessionOfTotal", { session: packageInfo.sessionNumber ?? "—", total: packageInfo.totalSessions })}</span>
              <span>{t("remainingCount", { count: packageInfo.remainingSessions })}</span>
              {packageInfo.pricePerSession != null && (
                <span>{fmtMoney(packageInfo.pricePerSession)} {t("session2")}</span>
              )}
            </div>
          )}

          {/* Financial allocation summary */}
          <div
            className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border/60 bg-border/40 sm:grid-cols-4"
            aria-label={t("billingSummary")}
          >
            <SummaryCell
              label={t("invoiceTotal")}
              amount={totalN}
              formatAmount={fmtMoney}
            />
            <SummaryCell
              label={t("insuranceContribution")}
              amount={insuranceN}
              formatAmount={fmtMoney}
              accent="text-sky-700 dark:text-sky-400"
            />
            <SummaryCell
              label={t("patientResponsibility")}
              amount={patientResponsibility}
              formatAmount={fmtMoney}
            />
            <SummaryCell
              label={t("primaryPaymentAmount")}
              amount={paidN}
              formatAmount={fmtMoney}
            />
            <SummaryCell
              label={t("secondaryPaymentAmount")}
              amount={secondaryN}
              formatAmount={fmtMoney}
            />
            <SummaryCell
              label={t("totalPatientPaid")}
              amount={patientPaid}
              formatAmount={fmtMoney}
              accent="text-emerald-600 dark:text-emerald-400"
            />
            <SummaryCell
              label={t("depositApplied")}
              amount={depositN}
              formatAmount={fmtMoney}
            />
            <SummaryCell
              label={t("remainingPatientBalance")}
              amount={remaining}
              formatAmount={fmtMoney}
              accent={
                remaining > 0
                  ? "text-amber-600 dark:text-amber-400"
                  : "text-muted-foreground"
              }
            />
          </div>

          {/* Line items */}
          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs">{t("services")}</Label>
              <span className="text-[11px] text-muted-foreground">
                {t("itemCount", { count: lines.length })}
              </span>
            </div>

            <div className="rounded-lg border border-border/60 bg-card overflow-hidden">
              {lines.length === 0 ? (
                <div className="px-4 py-6 text-center text-xs text-muted-foreground">
                  {t("noServicesOnTheInvoiceYet")}</div>
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
                              placeholder={t("customService")}
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
                        <div className="col-span-1 text-end text-xs font-semibold tabular-nums">
                          {fmtMoney(lineTotal)}
                        </div>
                        <div className="col-span-1 flex justify-end">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={isPending}
                            onClick={() => removeLine(l._key)}
                            className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                            aria-label={t("removeLine")}
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
                          ? t("noservicesinthisdepartment")
                          : t("addaservicefromtheprice")
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {services.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        <span className="flex justify-between gap-4 w-full">
                          <span className="truncate">{s.name}</span>
                          <span className="text-muted-foreground tabular-nums">
                            {fmtMoney(s.price)}
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
                {t("customLine")}</Button>
            </div>
          </section>

          {/* Pay-later toggle */}
          <button
            type="button"
            disabled={isPending}
            onClick={() => setDeferAll((v) => !v)}
            className={cn(
              "flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2.5 text-start text-xs transition",
              deferAll
                ? "border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                : "border-dashed border-border/70 text-muted-foreground hover:border-amber-500/40 hover:text-foreground",
            )}
          >
            <span className="flex items-center gap-2">
              <Clock3 className="h-4 w-4" />
              <span className="font-medium">
                {t("payLaterCollectPartNowRemainder")}</span>
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
              {t("enterAnyPartialPaymentCollectedNow")}</p>
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
                  {t("applyFromPatientAccount")}</Label>
                <span className="text-[11px] text-muted-foreground">
                  {t("available")}{" "}
                  <span className="font-semibold tabular-nums text-emerald-700 dark:text-emerald-400">
                    {fmtMoney(accountBalance)}
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
                      String(
                        Math.min(accountBalance, patientResponsibility).toFixed(
                          2,
                        ),
                      ),
                    )
                  }
                >
                  {t("useMax")}</Button>
              </div>
              {depositN > 0 && (
                <p className="text-[11px] text-muted-foreground">
                  {t("remainingAccountBalanceAfterThisInvoice")}{" "}
                  <span className="font-semibold tabular-nums">
                    {fmtMoney(remainingBalanceAfter)}
                  </span>
                </p>
              )}
              {depositAboveBalance && (
                <p className="text-[11px] text-destructive" role="alert">
                  {t("depositCannotExceedAccountBalance")}
                </p>
              )}
            </section>
          )}

          {/* Patient paid now */}
          <div className={cn("space-y-1.5")}>
            <Label htmlFor="bill-paid" className="text-xs">
              {t("primaryPaymentAmount")}</Label>
            <div className="flex items-center gap-2">
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
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-9 shrink-0 px-2.5 text-xs"
                disabled={isPending || primaryRemainingAmount === 0}
                onClick={() => setPaid(primaryRemainingAmount.toFixed(2))}
                data-testid="fill-primary-remaining"
              >
                {t("fillRemaining")}
              </Button>
            </div>
          </div>

          {/* Primary method */}
          <div className={cn("space-y-1.5")}>
            <Label className="text-xs">{t("primaryPaymentMethod")}</Label>
            <div className="grid grid-cols-4 gap-1.5" role="group" aria-label={t("primaryPaymentMethod")}>
              {METHODS.map(({ value, labelKey, icon: Icon }) => {
                const active = method === value;
                return (
                  <button
                    key={value}
                    type="button"
                    disabled={isPending}
                    onClick={() => setMethod(value)}
                    aria-pressed={active}
                    aria-label={t(labelKey)}
                    className={cn(
                      "flex flex-col items-center gap-1 rounded-lg border px-1 py-2 text-[10px] font-medium transition-all",
                      active
                        ? "border-primary bg-primary/10 text-foreground ring-2 ring-primary/20"
                        : "border-border/60 bg-card text-muted-foreground hover:border-primary/50 hover:bg-primary/5",
                    )}
                  >
                    <Icon className={cn("h-4 w-4", active ? "text-primary" : "")} />
                    {t(labelKey)}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Insurance is an allocation, separate from patient payment methods. */}
          <section
            className="space-y-3 rounded-lg border border-sky-500/30 bg-sky-500/5 p-3"
            aria-labelledby="billing-insurance-heading"
          >
            <div className="space-y-1">
              <h3
                id="billing-insurance-heading"
                className="flex items-center gap-1.5 text-xs font-semibold"
              >
                <ShieldCheck
                  className="h-3.5 w-3.5 text-sky-700 dark:text-sky-400"
                  aria-hidden
                />
                {t("insurance")}
              </h3>
              <p className="text-[11px] text-muted-foreground">
                {insuranceProviderName
                  ? t("insuranceContributionDescriptionProvider", {
                      provider: insuranceProviderName,
                    })
                  : hasInsurance
                    ? t("insuranceContributionDescription")
                    : t("insuranceContributionNoProviderDescription")}
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-[minmax(140px,0.45fr)_1fr]">
              <div className="space-y-1.5">
                <Label htmlFor="bill-insurance-mode" className="text-xs">
                  {t("insuranceCalculationMode")}
                </Label>
                <Select
                  value={insuranceMode}
                  onValueChange={(value) =>
                    setInsuranceMode(value as InsuranceCalculationMode)
                  }
                  disabled={isPending}
                >
                  <SelectTrigger id="bill-insurance-mode">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="amount">
                      {t("insuranceModeAmount")}
                    </SelectItem>
                    <SelectItem value="percentage">
                      {t("insuranceModePercentage")}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {insuranceMode === "amount" ? (
                <div className="space-y-1.5">
                  <Label htmlFor="bill-insurance" className="text-xs">
                    {t("insuranceAmount")}
                  </Label>
                  <Input
                    id="bill-insurance"
                    type="number"
                    inputMode="decimal"
                    min={0}
                    max={totalN}
                    step="0.01"
                    placeholder="0.00"
                    value={insurance}
                    disabled={isPending}
                    onChange={(event) => setInsurance(event.target.value)}
                    aria-invalid={
                      insuranceAmountInputInvalid || insuranceAboveTotal
                    }
                    aria-describedby="bill-insurance-help"
                  />
                </div>
              ) : (
                <div className="space-y-1.5">
                  <Label htmlFor="bill-insurance-percentage" className="text-xs">
                    {t("insurancePercentage")}
                  </Label>
                  <div className="relative">
                    <Input
                      id="bill-insurance-percentage"
                      type="number"
                      inputMode="decimal"
                      min={0}
                      max={100}
                      step="0.01"
                      placeholder="0"
                      value={insurancePercentage}
                      disabled={isPending}
                      onChange={(event) =>
                        setInsurancePercentage(event.target.value)
                      }
                      aria-invalid={insurancePercentageInputInvalid}
                      aria-describedby="bill-insurance-help"
                      className="pe-8"
                    />
                    <span
                      className="pointer-events-none absolute inset-y-0 end-3 flex items-center text-xs text-muted-foreground"
                      aria-hidden
                    >
                      %
                    </span>
                  </div>
                </div>
              )}
            </div>

            <div
              id="bill-insurance-help"
              className="flex items-center justify-between gap-3 rounded-md border border-sky-500/20 bg-card/70 px-3 py-2 text-xs"
              aria-live="polite"
            >
              <span className="text-muted-foreground">
                {insuranceMode === "percentage"
                  ? t("calculatedInsuranceAmount")
                  : t("insuranceContribution")}
              </span>
              <span
                className="font-semibold tabular-nums text-sky-700 dark:text-sky-400"
                data-testid="calculated-insurance-amount"
              >
                {fmtMoney(insuranceN)}
              </span>
            </div>

            {(insuranceAmountInputInvalid ||
              insurancePercentageInputInvalid ||
              insuranceAboveTotal) && (
              <p className="text-[11px] text-destructive" role="alert">
                {insuranceAboveTotal
                  ? t("insuranceAmountCannotExceedInvoiceTotal")
                  : insuranceMode === "percentage"
                    ? insurancePercentageMissing
                      ? t("insurancePercentageRequired")
                      : t("insurancePercentageMustBeBetween")
                    : t("insuranceAmountCannotBeNegative")}
              </p>
            )}
          </section>

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
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="bill-secondary" className="text-xs">
                    {t("paidViaAnotherMethod")}</Label>
                  <div className="flex items-center gap-2">
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
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-9 shrink-0 px-2.5 text-xs"
                      disabled={isPending || secondaryRemainingAmount === 0}
                      onClick={() =>
                        setSecondaryAmount(
                          secondaryRemainingAmount.toFixed(2),
                        )
                      }
                      data-testid="fill-secondary-remaining"
                    >
                      {t("fillRemaining")}
                    </Button>
                  </div>
                </div>
                <div className="flex items-end">
                  <p className="text-[11px] text-muted-foreground pb-2">
                    {t("outstanding2")}{" "}
                    <span
                      className={cn(
                        "font-semibold tabular-nums",
                        remaining > 0
                          ? "text-amber-600 dark:text-amber-400"
                          : "text-emerald-600 dark:text-emerald-400",
                      )}
                    >
                      {fmtMoney(remaining)}
                    </span>
                  </p>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs">{t("secondaryPaymentMethod")}</Label>
                <div className="grid grid-cols-4 gap-1.5" role="group" aria-label={t("secondaryPaymentMethod")}>
                  {METHODS.map(({ value, labelKey, icon: Icon }) => {
                    const active = secondaryMethod === value;
                    const disabled = value === method;
                    return (
                      <button
                        key={value}
                        type="button"
                        disabled={isPending || disabled}
                        onClick={() => setSecondaryMethod(value)}
                        aria-pressed={active}
                        aria-label={t(labelKey)}
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
                        {t(labelKey)}
                      </button>
                    );
                  })}
                </div>
              </div>
            </>
          )}

          {remaining > 0 && totalN > 0 && (
            <p className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-400">
              {t("remainingSavedAsOutstanding", { amount: fmtMoney(remaining) })}
            </p>
          )}

          {patientPaymentsAboveResponsibility && (
            <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[11px] text-destructive" role="alert">
              {t("patientPaymentsCannotExceedResponsibility")}
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
                    {t("previousOutstandingBalance")}</Label>
                  <p className="text-[11px] text-muted-foreground">
                    {t("olderOutstandingPaymentDescription")}
                  </p>
                </div>
                <span className="text-[11px] text-muted-foreground">
                  {t("previousBalance2")}{" "}
                  <span className="font-semibold tabular-nums text-amber-700 dark:text-amber-400">
                    {fmtMoney(previousBalanceN)}
                  </span>
                </span>
              </div>
              {previousOutstandingAction && (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-500/20 bg-card/70 px-3 py-2">
                  <p className="text-[11px] text-muted-foreground">
                    {t("preferNotToIncludeItOn")}</p>
                  {previousOutstandingAction}
                </div>
              )}

              <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
                <div className="space-y-1.5">
                  <Label htmlFor="previous-settlement" className="text-xs">
                    {t("settleNow")}</Label>
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
                  {t("useFullBalance")}</Button>
              </div>

              {(previousInputInvalid || previousAboveBalance) && (
                <p className="text-[11px] text-destructive">
                  {previousInputInvalid
                    ? t("enterAPositiveAmountOrLeave")
                    : t("amountCannotExceedThePreviousBalance")}
                </p>
              )}

              <div className="space-y-1.5">
                <Label className="text-xs">{t("previousBalancePaymentMethod")}</Label>
                <div className="grid grid-cols-4 gap-1.5" role="group" aria-label={t("previousBalancePaymentMethod")}>
                  {METHODS.map(({ value, labelKey, icon: Icon }) => {
                    const active = previousMethod === value;
                    return (
                      <button
                        key={value}
                        type="button"
                        disabled={isPending}
                        onClick={() => setPreviousMethod(value)}
                        aria-pressed={active}
                        aria-label={t(labelKey)}
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
                        {t(labelKey)}
                      </button>
                    );
                  })}
                </div>
                {previousMethodMissing && (
                  <p className="text-[11px] text-destructive">
                    {t("selectAPaymentMethodForPrevious")}</p>
                )}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="previous-note" className="text-xs">
                  {t("previousBalanceNoteOptional")}</Label>
                <Textarea
                  id="previous-note"
                  rows={2}
                  placeholder={t("receiptNumberContextEtc")}
                  value={previousNote}
                  disabled={isPending}
                  onChange={(event) => setPreviousNote(event.target.value)}
                  className="resize-none text-sm"
                />
              </div>

              <div className="grid grid-cols-3 gap-px overflow-hidden rounded-lg border border-border/50 bg-border/40">
                <SummaryCell
                  label={t("previousBalance")}
                  amount={previousBalanceN}
                  formatAmount={fmtMoney}
                />
                <SummaryCell
                  label={t("settledNow")}
                  amount={previousAboveBalance ? 0 : previousSettlementN}
                  formatAmount={fmtMoney}
                  accent={
                    previousSettlementN > 0 && !previousAboveBalance
                      ? "text-emerald-600 dark:text-emerald-400"
                      : "text-muted-foreground"
                  }
                />
                <SummaryCell
                  label={t("remainingPreviousBalance")}
                  amount={previousRemaining}
                  formatAmount={fmtMoney}
                  accent={
                    previousRemaining > 0
                      ? "text-amber-600 dark:text-amber-400"
                      : "text-muted-foreground"
                  }
                />
              </div>

              <div className="flex items-center justify-between gap-2 rounded-md border border-border/50 bg-card px-3 py-2 text-xs">
                <span className="font-medium text-muted-foreground">
                  {t("totalCollectedToday")}</span>
                <span className="font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
                  {fmtMoney(totalCollectedToday)}
                </span>
              </div>
            </section>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="bill-note" className="text-xs">
              {t("billingNoteOptional")}</Label>
            <Textarea
              id="bill-note"
              rows={2}
              placeholder={t("discountReasonReceiptNumberEtc")}
              value={note}
              disabled={isPending}
              onChange={(e) => setNote(e.target.value)}
              className="resize-none text-sm"
            />
          </div>
          </div>
        </div>

        <DialogFooter
          flush
          className="shrink-0 gap-2 rounded-none rounded-b-xl sm:gap-2"
        >
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isPending}
          >
            {t("cancel")}</Button>
          <Button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="gap-2"
          >
            {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            {remaining > 0 && totalN > 0
              ? t("completeWithOutstanding")
              : t("completeCharge")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SummaryCell({
  label,
  amount,
  formatAmount,
  accent,
}: {
  label: string;
  amount: number;
  formatAmount: (amount: number) => string;
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
        {formatAmount(amount)}
      </p>
    </div>
  );
}
