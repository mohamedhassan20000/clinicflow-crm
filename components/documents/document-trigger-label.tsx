"use client";

import { useTranslations } from "next-intl";

export function DocumentTriggerLabel({ kind }: {
  kind: "patient-list" | "patient-file" | "system-members";
}) {
  const t = useTranslations("documentPlatform.ui");
  if (kind === "patient-list") return t("patientListDocument");
  if (kind === "patient-file") return t("patientFileDocument");
  return t("systemMembersDocument");
}
