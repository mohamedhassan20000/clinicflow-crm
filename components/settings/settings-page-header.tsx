"use client";

import { usePathname } from "next/navigation";
import { PageHeader } from "@/components/shared/page-header";

const SETTINGS_LABELS: Record<string, string> = {
  "/settings/staff": "Staff",
  "/settings/departments": "Departments",
  "/settings/services": "Services",
  "/settings/packages": "Packages",
  "/settings/insurance": "Insurance",
  "/settings/clinic": "Clinic",
  "/settings/customize": "Customize",
};

export function SettingsPageHeader() {
  const pathname = usePathname();
  const current = SETTINGS_LABELS[pathname] ?? "Settings";

  return (
    <PageHeader
      back={{ href: "/dashboard", label: "dashboard" }}
      breadcrumbs={[
        { label: "Dashboard", href: "/dashboard" },
        { label: "Settings" },
        { label: current },
      ]}
      title="Settings"
      description="Manage your clinic, staff, and configuration."
    />
  );
}
