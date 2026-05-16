"use client";

export function formatNumber(value: number | null | undefined) {
  const n = Number(value ?? 0);
  return new Intl.NumberFormat("en-GB", {
    maximumFractionDigits: Number.isInteger(n) ? 0 : 1,
  }).format(Number.isFinite(n) ? n : 0);
}

export function formatPercent(value: number | null | undefined) {
  const n = Number(value ?? 0);
  return `${new Intl.NumberFormat("en-GB", {
    maximumFractionDigits: 1,
  }).format(Number.isFinite(n) ? n : 0)}%`;
}

export function formatCurrency(value: number | null | undefined) {
  const n = Number(value ?? 0);
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "TRY",
    maximumFractionDigits: 2,
  }).format(Number.isFinite(n) ? n : 0);
}

export function formatDateRangeLabel(from: string, to: string) {
  const format = new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });

  return `${format.format(new Date(`${from}T00:00:00`))} - ${format.format(
    new Date(`${to}T00:00:00`),
  )}`;
}

export function humanizeKey(value: string) {
  return value
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
