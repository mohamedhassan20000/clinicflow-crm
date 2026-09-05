"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { BarChart3, BrainCircuit, Building2, CalendarDays, ChevronLeft, ChevronRight, FileText, Gift, Inbox, LayoutDashboard, Mail, PhoneCall, Settings, Users, Wallet, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { OperatorIconKey, ShellNavItem } from "@/lib/dashboard-navigation";
import type { PageSlug } from "@/lib/page-permissions";

const TENANT_ICONS: Record<PageSlug, LucideIcon> = {
  dashboard: LayoutDashboard,
  patients: Users,
  appointments: CalendarDays,
  assistant: BrainCircuit,
  inbox: Inbox,
  followups: PhoneCall,
  revenue: Wallet,
  reports: BarChart3,
  documents: FileText,
  settings: Settings,
};

const OPERATOR_ICONS: Record<OperatorIconKey, LucideIcon> = {
  "mission-control": LayoutDashboard,
  clinics: Building2,
  invitations: Mail,
  reports: BarChart3,
  "ai-allowance": BrainCircuit,
  coupons: Gift,
  settings: Settings,
};

function resolveIcon(item: ShellNavItem): LucideIcon {
  return "mission-control" === item.icon ||
    "clinics" === item.icon ||
    "invitations" === item.icon ||
    "coupons" === item.icon ||
    "ai-allowance" === item.icon ||
    "reports" === item.icon
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
  brandLabel,
}: SidebarProps) {
  const t = useTranslations("nav");
  const shell = useTranslations("shell");
  const pathname = usePathname();
  const brand = brandLabel ?? shell("brand");
  const isCollapsed = mode === "sidebar" && collapsed;
  const navigationId = mode === "sidebar" ? "dashboard-navigation" : "mobile-navigation";
  const toggleLabel = isCollapsed ? shell("expandNavigation") : shell("collapseNavigation");

  const brandContents = (
    <>
      <Image src="/brand/clinicflow-mark.png" alt={shell("brand")} width={38} height={34} className="h-9 w-auto shrink-0 object-contain" priority />
      {isCollapsed ? null : <span className="truncate text-lg font-semibold tracking-tight">{brand}</span>}
      {mode === "sidebar" ? (
        isCollapsed ? (
          <ChevronRight aria-hidden="true" className="absolute inset-e-1.5 top-1/2 size-4 -translate-y-1/2 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 rtl:rotate-180" />
        ) : (
          <ChevronLeft aria-hidden="true" className="ms-auto size-4 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 rtl:rotate-180" />
        )
      ) : null}
    </>
  );

  return (
    <aside
      data-testid={mode === "sidebar" ? "dashboard-sidebar" : "mobile-sidebar"}
      data-collapsed={isCollapsed}
      className={cn(
        "flex h-full shrink-0 flex-col border-e border-sidebar-border bg-sidebar text-sidebar-foreground",
        mode === "sidebar" && "sticky top-0 z-40 hidden h-dvh self-start md:flex transition-[width] duration-200 ease-out",
        mode === "sidebar" && (isCollapsed ? "w-20" : "w-72"),
      )}
    >
      <div data-testid="sidebar-brand-row" className="flex h-[var(--shell-header-h)] shrink-0 border-b border-sidebar-border">
        {mode === "sidebar" ? (
          <button
            type="button"
            onClick={() => onCollapsedChange?.(!collapsed)}
            aria-label={toggleLabel}
            aria-expanded={!isCollapsed}
            aria-controls={navigationId}
            title={toggleLabel}
            className={cn(
              "group relative flex h-full w-full items-center transition-colors hover:bg-sidebar-accent/60 focus-visible:bg-sidebar-accent/60 focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-sidebar-ring",
              isCollapsed ? "justify-center px-3" : "gap-3 px-5",
            )}
          >
            {brandContents}
          </button>
        ) : (
          <div className="flex h-full w-full items-center gap-3 px-5">{brandContents}</div>
        )}
      </div>

      <nav id={navigationId} aria-label={shell("navigationLabel", { brand })} className={cn("flex-1 space-y-1 overflow-y-auto py-5", isCollapsed ? "px-3" : "px-4")}>
        {items.map((item) => {
          const { href, labelKey } = item;
          const label = t(labelKey);
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
                active ? "bg-sidebar-primary text-sidebar-primary-foreground shadow-sm" : "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
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
