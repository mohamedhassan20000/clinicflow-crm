"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { useTranslations } from "next-intl";

const NAV = [
  { href: "/settings/staff", labelKey: "navStaff" },
  { href: "/settings/departments", labelKey: "navDepartments" },
  { href: "/settings/services", labelKey: "navServices" },
  { href: "/settings/packages", labelKey: "navPackages" },
  { href: "/settings/insurance", labelKey: "navInsurance" },
  { href: "/settings/clinic", labelKey: "navClinic" },
  { href: "/settings/clinical", labelKey: "navClinical", clinicalAdminOnly: true },
  { href: "/settings/documents", labelKey: "navDocuments", adminOnly: true },
  { href: "/settings/messaging", labelKey: "navMessaging" },
  { href: "/settings/templates", labelKey: "navTemplates" },
  { href: "/settings/ai", labelKey: "navAiProvider", aiOnly: true },
  { href: "/settings/patient-ai", labelKey: "navPatientAi", aiOnly: true },
  {
    href: "/settings/assistant",
    labelKey: "navAssistantCustomization",
    adminOnly: true,
  },
  { href: "/settings/customize", labelKey: "navCustomize", adminOnly: true },
  { href: "/settings/audit-log", labelKey: "navAuditLog" },
] as const;

export function SettingsNav({
  canCustomize,
  canManageAi,
  canManageClinical = false,
}: {
  canCustomize: boolean;
  canManageAi: boolean;
  canManageClinical?: boolean;
}) {
  const t = useTranslations("settings");
  const pathname = usePathname();
  const nav = NAV.filter(
    (item) =>
      (!("adminOnly" in item) || canCustomize) &&
      (!("aiOnly" in item) || canManageAi) &&
      (!("clinicalAdminOnly" in item) || canManageClinical),
  );

  return (
    <nav className="flex gap-1 border-b border-border/50 overflow-x-auto pb-px">
      {nav.map((n) => (
        <Link
          key={n.href}
          href={n.href}
          className={cn(
            "shrink-0 rounded-t-md px-4 py-2 text-sm font-medium transition-colors",
            pathname === n.href || pathname.startsWith(n.href + "/")
              ? "border-b-2 border-primary text-primary"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {t(n.labelKey)}
        </Link>
      ))}
    </nav>
  );
}
