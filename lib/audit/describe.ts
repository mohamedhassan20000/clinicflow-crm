/**
 * P18 — turning a stored diff into something an admin can read.
 *
 * The audit table stores structured before/after values because that is what
 * survives a schema change and a year of hindsight. What an administrator needs
 * on screen is a sentence: *Mohamed changed Consultation price, 25.000 KWD →
 * 30.000 KWD*. This module is the bridge, and it is isomorphic on purpose — the
 * server-rendered first page and the client-rendered "load more" page must not
 * be able to describe the same event two different ways.
 *
 * It deliberately does no translating. It classifies each changed value so the
 * component can render money as money, a toggle as on/off and an absent value
 * as an em dash in the reader's own language.
 */

import type { AuditFeedEvent } from "@/lib/audit/feed";

export type AuditValue =
  | { kind: "money"; amount: string; currency: string | null }
  | { kind: "boolean"; value: boolean }
  | { kind: "list"; count: number; items: string[] }
  | { kind: "text"; value: string }
  | { kind: "empty" };

export type AuditChangeLine = {
  field: string;
  before: AuditValue;
  after: AuditValue;
};

/** Fields whose value is money and must be shown with the clinic's currency. */
const MONEY_FIELDS = new Set(["price", "amount", "total_amount", "paid_amount"]);

/**
 * Fields that exist in the diff to give the money its denomination rather than
 * as a change in their own right, and fields whose transition the event's own
 * title already states. Listing them again would read as noise.
 */
const IMPLIED_FIELDS = new Set(["currency", "deleted_at"]);

const MAX_LIST_ITEMS = 12;

function classify(
  raw: unknown,
  field: string,
  currency: string | null,
): AuditValue {
  if (raw === null || raw === undefined || raw === "") return { kind: "empty" };
  if (typeof raw === "boolean") return { kind: "boolean", value: raw };
  if (MONEY_FIELDS.has(field)) {
    return { kind: "money", amount: String(raw), currency };
  }
  if (Array.isArray(raw)) {
    return {
      kind: "list",
      count: raw.length,
      items: raw.slice(0, MAX_LIST_ITEMS).map((item) => String(item)),
    };
  }
  if (typeof raw === "object") {
    const record = raw as Record<string, unknown>;
    // The summarized shapes written for schedule replaces.
    const items = record.shifts ?? record.templates;
    if (Array.isArray(items)) {
      return {
        kind: "list",
        count: items.length,
        items: items.slice(0, MAX_LIST_ITEMS).map((item) => String(item)),
      };
    }
    return { kind: "text", value: JSON.stringify(record).slice(0, 200) };
  }
  return { kind: "text", value: String(raw).slice(0, 200) };
}

function currencyOf(event: AuditFeedEvent): string | null {
  const fromMetadata = event.metadata?.currency;
  if (typeof fromMetadata === "string") return fromMetadata;
  const fromAfter = event.after?.currency ?? event.before?.currency;
  return typeof fromAfter === "string" ? fromAfter : null;
}

/**
 * The before → after pairs worth showing, most meaningful first.
 *
 * `changed_fields` is authoritative for *what* changed — it was computed by the
 * writer against an allowlist — so this never re-derives it from the payloads,
 * which may legitimately carry context (a currency, a status) that did not
 * change.
 */
export function auditChangeLines(
  event: AuditFeedEvent,
  limit = 3,
): AuditChangeLine[] {
  const currency = currencyOf(event);
  const fields = event.changedFields.filter((field) => !IMPLIED_FIELDS.has(field));
  return fields.slice(0, limit).map((field) => ({
    field,
    before: classify(event.before?.[field], field, currency),
    after: classify(event.after?.[field], field, currency),
  }));
}

/** Every allowlisted value on the event, for the expandable detail view. */
export function auditDetailLines(event: AuditFeedEvent): AuditChangeLine[] {
  const currency = currencyOf(event);
  const keys = new Set([
    ...Object.keys(event.before ?? {}),
    ...Object.keys(event.after ?? {}),
  ]);
  return [...keys].map((field) => ({
    field,
    before: classify(event.before?.[field], field, currency),
    after: classify(event.after?.[field], field, currency),
  }));
}

/**
 * True when the event is a creation or a removal, where a "before → after" pair
 * would be half empty and say less than the action title already does.
 */
export function isLifecycleEvent(event: AuditFeedEvent): boolean {
  return event.changedFields.length === 0;
}

/**
 * Money in the currency the *event* recorded, not the one the reader currently
 * prefers.
 *
 * `useClinicSettings().formatCurrency` converts into the viewer's display
 * currency at today's rate, which is exactly right for a revenue figure and
 * exactly wrong for an audit record: "25.000 KWD → 30.000 KWD" must keep saying
 * that after the clinic switches currency or the rate moves. So the stored
 * decimal string and the stored currency code are rendered as they are, with
 * only the digits and grouping localized.
 */
export function formatAuditMoney(
  amount: string,
  currency: string | null,
  numberingLocale: string,
  minorUnits?: number,
): string {
  const value = Number(amount);
  if (!Number.isFinite(value)) return amount;
  if (!currency) {
    return new Intl.NumberFormat(numberingLocale, {
      minimumFractionDigits: minorUnits,
      maximumFractionDigits: minorUnits,
    }).format(value);
  }
  try {
    return new Intl.NumberFormat(numberingLocale, {
      style: "currency",
      currency,
      minimumFractionDigits: minorUnits,
      maximumFractionDigits: minorUnits,
    }).format(value);
  } catch {
    return `${amount} ${currency}`;
  }
}
