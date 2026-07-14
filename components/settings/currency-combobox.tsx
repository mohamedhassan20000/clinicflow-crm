"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { updateDisplayCurrency } from "@/actions/profile";
import { SearchableCombobox } from "@/components/shared/searchable-combobox";
import { CURRENCIES } from "@/lib/currency/registry";

/**
 * Searchable display-currency picker (Pre-P2 WS4) — shares the cmdk combobox
 * pattern built in WS3. Persists via the same `updateDisplayCurrency` action
 * and offers only registry (= FX-provider-covered) currencies.
 */
export function CurrencyCombobox({ value }: { value: string }) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function choose(code: string) {
    if (code === value) return;
    startTransition(async () => {
      const result = await updateDisplayCurrency(code);
      if (result.error) {
        toast.error(result.error);
        return;
      }
      toast.success("Display currency updated.");
      router.refresh();
    });
  }

  return (
    <SearchableCombobox
      items={CURRENCIES}
      value={value}
      onValueChange={choose}
      getValue={(item) => item.code}
      getSearchValue={(item) => `${item.currencyName}|${item.code}|${item.countryName}`}
      ariaLabel="Display currency"
      searchPlaceholder="Search currency or code…"
      emptyMessage="No currency found."
      disabled={pending}
      triggerClassName="w-full max-w-xs gap-2 sm:w-80"
      contentClassName="w-[min(22rem,calc(100vw-2rem))]"
      filter={(value, search) =>
        value.toLowerCase().includes(search.toLowerCase()) ? 1 : 0
      }
      renderTrigger={(active) => (
        <span className="flex min-w-0 items-center gap-2">
          <span aria-hidden>{active?.flag}</span>
          <span className="truncate">
            {active ? `${active.currencyName} — ${active.code}` : value}
          </span>
        </span>
      )}
      renderItem={(item) => (
        <span className="currency-option-grid grid min-w-0 flex-1 grid-cols-[2.75rem_minmax(0,1fr)_2.5rem_3.25rem] items-center gap-1.5">
          <span className="truncate text-center font-medium text-foreground">
            {item.symbol}
          </span>
          <span className="min-w-0 truncate">{item.currencyName}</span>
          <span className="text-center font-mono text-xs uppercase text-muted-foreground">
            {item.countryCode}
          </span>
          <span className="text-end font-mono text-xs font-medium tabular-nums text-muted-foreground">
            {item.code}
          </span>
        </span>
      )}
    />
  );
}
