"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Banknote,
  CreditCard,
  Landmark,
  Loader2,
  ShieldCheck,
  Wallet,
  PiggyBank,
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
import { addPatientDeposit } from "@/actions/patients";

type PaymentMethod =
  | "cash"
  | "credit_card"
  | "paypal"
  | "bank_transfer"
  | "insurance";

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

interface Props {
  patientId: string;
  patientName: string;
}

export function AddDepositDialog({ patientId, patientName }: Props) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState<string>("");
  const [method, setMethod] = useState<PaymentMethod>("cash");
  const [note, setNote] = useState("");

  const [state, formAction, isPending] = useActionState(
    addPatientDeposit,
    null,
  );
  const router = useRouter();

  useEffect(() => {
    if (!state) return;
    if (state.error) {
      toast.error(state.error);
    } else if (!state.fieldErrors) {
      toast.success("Deposit added to patient account.");
      router.refresh();
      queueMicrotask(() => {
        setOpen(false);
        setAmount("");
        setMethod("cash");
        setNote("");
      });
    }
  }, [router, state]);

  const amountN = Number(amount) || 0;
  const invalid = amountN <= 0;

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        className="h-8 gap-1.5 border-emerald-500/40 bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/15 hover:text-emerald-800 dark:text-emerald-400 dark:hover:text-emerald-300"
        onClick={() => setOpen(true)}
      >
        <PiggyBank className="h-3.5 w-3.5" />
        Add deposit
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
            <DialogTitle>Add deposit</DialogTitle>
            <DialogDescription>
              Top up {patientName}&apos;s account. The balance will be available
              to apply against future invoices.
            </DialogDescription>
          </DialogHeader>

          <form action={formAction} className="space-y-4 py-1">
            <input type="hidden" name="patient_id" value={patientId} />
            <input type="hidden" name="payment_method" value={method} />

            <div className="space-y-1.5">
              <Label htmlFor="deposit-amount" className="text-xs">
                Amount (₺)
              </Label>
              <Input
                id="deposit-amount"
                name="amount"
                type="number"
                inputMode="decimal"
                min={0}
                step="0.01"
                placeholder="0.00"
                value={amount}
                disabled={isPending}
                onChange={(e) => setAmount(e.target.value)}
                autoFocus
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">Payment method</Label>
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
                        className={cn("h-4 w-4", active ? "text-primary" : "")}
                      />
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="deposit-note" className="text-xs">
                Note (optional)
              </Label>
              <Textarea
                id="deposit-note"
                name="note"
                rows={2}
                placeholder="Receipt number, context, etc."
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
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={isPending || invalid}
                className="gap-2"
              >
                {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                Add deposit
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
