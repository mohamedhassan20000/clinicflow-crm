import { convertForDisplay, formatMoney, type FxRate } from "@/lib/currency/conversion";
import { formatClinicCurrency, toNumberingLocale, type ClinicLocale } from "@/lib/datetime";

/**
 * Single money-composition helper (Pre-P2 WS4, closes P15-P1). Both the client
 * settings context and the server money formatter compose the same
 * `≈ <converted> (<canonical>)` string; this is the one place it lives so the
 * two can never drift, and the natural home for P2C translation keys.
 *
 * Isomorphic (no server-only imports) so client and server share it.
 */
export function composeDisplayMoney(
  value: number | null | undefined,
  clinicLocale: ClinicLocale,
  preferredCurrency: string,
  fxRates: readonly FxRate[],
  options?: Intl.NumberFormatOptions,
): string {
  const canonical = Number(value ?? 0);
  const money = convertForDisplay(canonical, clinicLocale.currency, preferredCurrency, fxRates);
  const display = formatMoney(money, toNumberingLocale(clinicLocale), options);
  return money.approximate
    ? `${display} (${formatClinicCurrency(canonical, clinicLocale, options)})`
    : display;
}
