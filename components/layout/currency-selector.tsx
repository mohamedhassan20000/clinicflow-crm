"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { updateDisplayCurrency } from "@/actions/profile";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CURRENCIES } from "@/lib/currency/registry";
export function CurrencySelector({ value }: { value: string }) {
  const [pending, startTransition] = useTransition(); const router = useRouter();
  return <Select value={value} disabled={pending} onValueChange={(currency) => startTransition(async () => { const result = await updateDisplayCurrency(currency); if (result.error) { toast.error(result.error); return; } router.refresh(); })}>
    <SelectTrigger aria-label="Display currency" className="h-9 w-[100px]"><SelectValue /></SelectTrigger>
    <SelectContent>{CURRENCIES.map((item) => <SelectItem key={item.code} value={item.code}>{item.flag} {item.countryName} — {item.code}</SelectItem>)}</SelectContent>
  </Select>;
}
