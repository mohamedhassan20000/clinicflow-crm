"use client";

import { useTranslations } from "next-intl";
import { useClinicSettings } from "@/contexts/clinic-settings-context";
import { formatAuditMoney, type AuditValue } from "@/lib/audit/describe";
import { getCurrency } from "@/lib/currency/registry";
import { toNumberingLocale } from "@/lib/datetime";

/**
 * One side of a before → after pair.
 *
 * Money is the reason this is a component rather than a string helper: a price
 * has to be rendered with the clinic's digits and the currency the *event*
 * recorded, and rendering it as a bare number — or converting it to today's
 * display currency — is exactly the distortion this trail exists to prevent.
 */
export function AuditValueText({ value }: { value: AuditValue }) {
  const t = useTranslations("auditLog");
  const { locale } = useClinicSettings();

  switch (value.kind) {
    case "empty":
      return <span className="text-muted-foreground">{t("valueNone")}</span>;
    case "boolean":
      return <span>{value.value ? t("valueOn") : t("valueOff")}</span>;
    case "money":
      return (
        <span className="tabular-nums">
          {formatAuditMoney(
            value.amount,
            value.currency,
            toNumberingLocale(locale),
            getCurrency(value.currency ?? locale.currency)?.minorUnits,
          )}
        </span>
      );
    case "list":
      return (
        <span className="text-xs">
          {value.count === 0 ? t("valueNone") : t("valueItems", { count: value.count })}
        </span>
      );
    default:
      return <span className="break-words">{value.value}</span>;
  }
}
