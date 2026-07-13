import { getCurrency } from "@/lib/currency/registry";

export const FX_STALE_AFTER_MS = 48 * 60 * 60 * 1000;
export const FX_SUPPRESS_AFTER_MS = 72 * 60 * 60 * 1000;

export type FxRate = { currencyCode: string; rate: number; providerTimestamp: string; fetchedAt: string };
export type DisplayMoney = { canonical: number; canonicalCurrency: string; display: number; displayCurrency: string; approximate: boolean; stale: boolean; rateTimestamp?: string };

export function convertForDisplay(value: number, from: string, to: string, rates: readonly FxRate[], now = Date.now()): DisplayMoney {
  const original = { canonical: value, canonicalCurrency: from, display: value, displayCurrency: from, approximate: false, stale: false };
  if (from === to) return original;
  const source = rates.find((rate) => rate.currencyCode === from);
  const target = rates.find((rate) => rate.currencyCode === to);
  if (!source || !target || source.rate <= 0 || target.rate <= 0) return original;
  const age = now - Math.min(Date.parse(source.fetchedAt), Date.parse(target.fetchedAt));
  if (!Number.isFinite(age) || age > FX_SUPPRESS_AFTER_MS) return original;
  return { ...original, display: (value / source.rate) * target.rate, displayCurrency: to, approximate: true, stale: age > FX_STALE_AFTER_MS, rateTimestamp: source.providerTimestamp < target.providerTimestamp ? source.providerTimestamp : target.providerTimestamp };
}

export function formatMoney(money: DisplayMoney, locale = "en", options: Intl.NumberFormatOptions = {}) {
  const definition = getCurrency(money.displayCurrency);
  const resolved: Intl.NumberFormatOptions = {
    style: "currency",
    currency: money.displayCurrency,
    minimumFractionDigits: definition?.minorUnits,
    maximumFractionDigits: definition?.minorUnits,
    ...options,
  };
  // Intl.NumberFormat throws a RangeError when min > max; a caller override of
  // only one bound (e.g. { maximumFractionDigits: 0 } on a 2-minor-unit
  // currency) must win over the registry default on the other bound.
  const min = resolved.minimumFractionDigits;
  const max = resolved.maximumFractionDigits;
  if (typeof min === "number" && typeof max === "number" && min > max) {
    if (options.maximumFractionDigits !== undefined && options.minimumFractionDigits === undefined) {
      resolved.minimumFractionDigits = max;
    } else {
      resolved.maximumFractionDigits = min;
    }
  }
  const formatted = new Intl.NumberFormat(locale, resolved).format(money.display);
  return money.approximate ? `≈ ${formatted}${money.stale ? " · stale rate" : ""}` : formatted;
}

