
"use client";

import { useTranslations } from "next-intl";

export function OrphanTruncationWarning({ truncated }: { truncated: boolean }) {
  const t = useTranslations("operator");
  return truncated ? (
    <p role="alert" className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-xs dark:border-amber-700 dark:bg-amber-950">
      {t("warningTheAuthDirectoryScanHit")}</p>
  ) : null;
}
