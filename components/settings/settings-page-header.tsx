"use client";

import { usePathname } from "next/navigation";
import { PageHeader } from "@/components/shared/page-header";
import { useTranslations } from "next-intl";

const SETTINGS_LABELS: Record<string, string> = {
  "/settings/staff": "staff",
  "/settings/departments": "departments",
  "/settings/services": "services",
  "/settings/packages": "packages",
  "/settings/insurance": "insurance",
  "/settings/clinic": "clinic",
  "/settings/customize": "customize",
};

export function SettingsPageHeader() {
  const t = useTranslations("settings");
  const pathname = usePathname();
  const currentKey = SETTINGS_LABELS[pathname];
  const current = currentKey ? t(currentKey) : t("settings2");

  return (
    <PageHeader
      back={{ href: "/dashboard", label: "dashboard" }}
      breadcrumbs={[
        { label: t("dashboard"), href: "/dashboard" },
        { label: t("settings2") },
        { label: current },
      ]}
      title={t("settings")}
      description={t("manageYourClinicStaffAndConfiguration")}
    />
  );
}
