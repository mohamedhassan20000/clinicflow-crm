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
  { href: "/settings/customize", labelKey: "navCustomize", adminOnly: true },
] as const;

export function SettingsNav({
  canCustomize,
}: {
  canCustomize: boolean;
}) {
  const t = useTranslations("settings");
  const pathname = usePathname();
  const nav = NAV.filter(
    (item) => !("adminOnly" in item) || canCustomize,
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
