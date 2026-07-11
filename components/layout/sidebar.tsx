"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { BarChart3, Building2, CalendarDays, ChevronLeft, ChevronRight, Gift, LayoutDashboard, Mail, PhoneCall, Settings, Users, Wallet, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { OperatorIconKey, ShellNavItem } from "@/lib/dashboard-navigation";
import type { PageSlug } from "@/lib/page-permissions";

const TENANT_ICONS: Record<PageSlug, LucideIcon> = {
  dashboard: LayoutDashboard,
  patients: Users,
  appointments: CalendarDays,
  followups: PhoneCall,
  revenue: Wallet,
  reports: BarChart3,
  settings: Settings,
};

const OPERATOR_ICONS: Record<OperatorIconKey, LucideIcon> = {
  "mission-control": LayoutDashboard,
  clinics: Building2,
  invitations: Mail,
  coupons: Gift,
  settings: Settings,
};

function resolveIcon(item: ShellNavItem): LucideIcon {
  return "mission-control" === item.icon || "clinics" === item.icon || "invitations" === item.icon || "coupons" === item.icon
    ? OPERATOR_ICONS[item.icon]
    : TENANT_ICONS[item.icon];
}

type SidebarProps = {
  items: readonly ShellNavItem[];
  collapsed: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
  mode?: "sidebar" | "sheet";
  brandLabel?: string;
};

export function Sidebar({
  items,
  collapsed,
  onCollapsedChange,
  mode = "sidebar",
  brandLabel = "ClinicFlow",
}: SidebarProps) {
  const pathname = usePathname();
  const isCollapsed = mode === "sidebar" && collapsed;

  return (
    <aside
      data-testid={mode === "sidebar" ? "dashboard-sidebar" : "mobile-sidebar"}
      data-collapsed={isCollapsed}
      className={cn(
        "flex h-full shrink-0 flex-col border-e border-sidebar-border bg-sidebar text-sidebar-foreground",
        mode === "sidebar" && "sticky top-0 hidden h-dvh self-start md:flex transition-[width] duration-200 ease-out",
        mode === "sidebar" && (isCollapsed ? "w-20" : "w-72"),
      )}
    >
      <div className={cn("relative flex h-18 shrink-0 items-center border-b border-sidebar-border", isCollapsed ? "justify-center px-3" : "gap-3 px-5")}>
        <Image src="/brand/clinicflow-mark.png" alt="ClinicFlow" width={38} height={34} className="h-9 w-auto shrink-0 object-contain" priority />
        {isCollapsed ? null : <span className="truncate text-lg font-semibold tracking-tight">{brandLabel}</span>}
        {mode === "sidebar" ? (
          <button
            type="button"
            onClick={() => onCollapsedChange?.(!collapsed)}
            aria-label={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-expanded={!isCollapsed}
            className="absolute inset-e-0 top-1/2 flex size-7 translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-sidebar-border bg-sidebar text-sidebar-foreground shadow-sm transition-colors hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sidebar-ring rtl:-translate-x-1/2"
          >
            {isCollapsed ? <ChevronRight className="size-4 rtl:rotate-180" /> : <ChevronLeft className="size-4 rtl:rotate-180" />}
          </button>
        ) : null}
      </div>

      <nav aria-label={`${brandLabel} navigation`} className={cn("flex-1 space-y-1 overflow-y-auto py-5", isCollapsed ? "px-3" : "px-4")}>
        {items.map((item) => {
          const { href, label } = item;
          const Icon = resolveIcon(item);
          const active = href === "/dashboard" || href === "/operator" ? pathname === href : pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              title={isCollapsed ? label : undefined}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex min-h-11 items-center rounded-xl text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sidebar-ring",
                isCollapsed ? "justify-center px-3" : "gap-3 px-3.5",
                active ? "bg-sidebar-primary text-sidebar-primary-foreground shadow-sm" : "text-sidebar-foreground/75 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
              )}
            >
              <Icon className="size-5 shrink-0" aria-hidden="true" />
              {isCollapsed ? null : <span>{label}</span>}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
