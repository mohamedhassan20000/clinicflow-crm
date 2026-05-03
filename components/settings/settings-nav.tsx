"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

interface NavItem {
  href: string;
  label: string;
  adminOnly?: boolean;
}

const NAV: NavItem[] = [
  { href: "/settings/staff", label: "Staff" },
  { href: "/settings/departments", label: "Departments" },
  { href: "/settings/services", label: "Services" },
  { href: "/settings/insurance", label: "Insurance" },
  { href: "/settings/clinic", label: "Clinic", adminOnly: true },
  { href: "/settings/customize", label: "Customize", adminOnly: true },
];

export function SettingsNav({ hideClinic = false }: { hideClinic?: boolean }) {
  const pathname = usePathname();
  const visible = NAV.filter((n) => !(hideClinic && n.adminOnly));

  return (
    <nav className="flex gap-1 border-b border-border/50 overflow-x-auto pb-px">
      {visible.map((n) => (
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
          {n.label}
        </Link>
      ))}
    </nav>
  );
}
