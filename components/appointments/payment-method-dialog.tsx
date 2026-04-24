"use client";

import { useState } from "react";
import { Banknote, CreditCard, Landmark, ShieldCheck, Wallet, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type PaymentMethod =
  | "cash"
  | "credit_card"
  | "paypal"
  | "bank_transfer"
  | "insurance";

const OPTIONS: { value: PaymentMethod; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { value: "cash", label: "Cash", icon: Banknote },
  { value: "credit_card", label: "Credit card", icon: CreditCard },
  { value: "paypal", label: "PayPal", icon: Wallet },
  { value: "bank_transfer", label: "Bank transfer", icon: Landmark },
  { value: "insurance", label: "Insurance", icon: ShieldCheck },
];

interface PaymentMethodDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (method: PaymentMethod) => void;
  isPending?: boolean;
}

export function PaymentMethodDialog({
  open,
  onOpenChange,
  onConfirm,
  isPending,
}: PaymentMethodDialogProps) {
  const [selected, setSelected] = useState<PaymentMethod | null>(null);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setSelected(null);
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>How did the patient pay?</DialogTitle>
          <DialogDescription>
            Select a payment method to mark this appointment as completed.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-2 py-2">
          {OPTIONS.map(({ value, label, icon: Icon }) => {
            const active = selected === value;
            return (
              <button
                key={value}
                type="button"
                onClick={() => setSelected(value)}
                disabled={isPending}
                className={cn(
                  "flex items-center gap-2 rounded-lg border px-3 py-2.5 text-sm transition-all",
                  "hover:border-primary/50 hover:bg-primary/5",
                  active
                    ? "border-primary bg-primary/10 text-foreground ring-2 ring-primary/20"
                    : "border-border/60 bg-card text-muted-foreground",
                  isPending && "opacity-50 cursor-not-allowed",
                )}
              >
                <Icon className={cn("h-4 w-4 shrink-0", active && "text-primary")} />
                <span className="font-medium">{label}</span>
              </button>
            );
          })}
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
            onClick={() => selected && onConfirm(selected)}
            disabled={!selected || isPending}
            className="gap-2"
          >
            {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            Confirm payment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
