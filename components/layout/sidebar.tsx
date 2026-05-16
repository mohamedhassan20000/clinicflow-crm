"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Users,
  CalendarDays,
  Settings,
  LogOut,
  Wallet,
  BarChart3,
  PhoneCall,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { signOut } from "@/actions/auth";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { getRolePages, type PageSlug } from "@/lib/page-permissions";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";

interface NavEntry {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  slug: PageSlug;
}

export interface SidebarProps {
  role: string;
  fullName: string;
  avatarUrl?: string | null;
  theme: "light" | "dark";
  visiblePages?: PageSlug[];
  /** "sidebar" renders the <aside> wrapper with collapse support.
   *  "sheet" renders a plain inner div for use inside a Sheet drawer. */
  mode?: "sidebar" | "sheet";
}

const ICONS: Record<PageSlug, typeof LayoutDashboard> = {
  dashboard: LayoutDashboard,
  patients: Users,
  appointments: CalendarDays,
  followups: PhoneCall,
  revenue: Wallet,
  reports: BarChart3,
  settings: Settings,
};

function buildNav(role: string, visiblePages?: PageSlug[]): NavEntry[] {
  const visible = new Set(visiblePages);
  return getRolePages(role)
    .filter((page) => page.alwaysVisible || !visiblePages || visible.has(page.slug))
    .map((page) => ({
      href: page.href,
      label: page.label,
      slug: page.slug,
      icon: ICONS[page.slug],
    }));
}

function NavLink({
  href,
  label,
  icon: Icon,
  collapsed,
}: NavEntry & { collapsed: boolean }) {
  const pathname = usePathname();
  const isActive =
    href === "/dashboard"
      ? pathname === "/dashboard"
      : pathname.startsWith(href);

  return (
    <Link
      href={href}
      title={collapsed ? label : undefined}
      className={cn(
        "flex items-center rounded-lg transition-colors",
        collapsed
          ? "justify-center p-3"
          : "gap-4 px-4 py-3.5 text-[15px] font-medium",
        isActive
          ? "bg-primary/10 text-primary"
          : "text-foreground/60 hover:bg-accent/5 hover:text-foreground",
      )}
    >
      <Icon
        className={cn(
          "shrink-0",
          collapsed ? "h-6 w-6" : "h-[22px] w-[22px]",
          isActive ? "text-primary" : "text-foreground/40",
        )}
      />
      {!collapsed && label}
    </Link>
  );
}

export function Sidebar({
  role,
  fullName,
  avatarUrl,
  theme,
  visiblePages,
  mode = "sidebar",
}: SidebarProps) {
  // Lazy initializer: reads from localStorage on client only; server returns false.
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window !== "undefined") {
      try {
        return localStorage.getItem("sidebar-collapsed") === "true";
      } catch { /* ignore */ }
    }
    return false;
  });

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("sidebar-collapsed", String(next));
      } catch { /* ignore */ }
      return next;
    });
  };

  // Only apply collapse in sidebar mode (not inside sheet drawer)
  const isCollapsed = mode === "sidebar" && collapsed;

  const nav = buildNav(role, visiblePages);
  const initials =
    fullName
      .split(" ")
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part.charAt(0).toUpperCase())
      .join("") || "?";

  const inner = (
    <div className="flex h-full flex-col">
      {/* ── Logo header ── */}
      <div
        className={cn(
          "relative flex h-16 shrink-0 items-center border-b border-border/50",
          isCollapsed ? "justify-center px-2" : "gap-3 px-5",
        )}
      >
        {/* Logo mark — ~2× larger, height visually matches wordmark */}
        <Image
          src="/brand/clinicflow-mark.png"
          alt="ClinicFlow"
          width={37}
          height={32}
          className="h-8 w-auto shrink-0 object-contain"
          priority
        />

        {!isCollapsed && (
          <span className="text-[17px] font-semibold leading-none tracking-tight">
            ClinicFlow
          </span>
        )}

        {/* Collapse/expand toggle — sidebar mode only */}
        {mode === "sidebar" && (
          <button
            onClick={toggleCollapsed}
            aria-label={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            className={cn(
              "absolute flex h-5 w-5 items-center justify-center rounded-full border border-border/60 bg-card text-muted-foreground shadow-sm transition-colors hover:bg-muted hover:text-foreground",
              isCollapsed ? "-right-2.5 top-1/2 -translate-y-1/2" : "right-2 top-1/2 -translate-y-1/2",
            )}
          >
            {isCollapsed ? (
              <ChevronRight className="h-3 w-3" />
            ) : (
              <ChevronLeft className="h-3 w-3" />
            )}
          </button>
        )}
      </div>

      {/* ── Nav ── */}
      <nav
        className={cn(
          "flex-1 overflow-auto space-y-0.5",
          isCollapsed ? "p-2.5 pt-4" : "p-3 pt-5",
        )}
      >
        {nav.map((n) => (
          <NavLink key={n.href} {...n} collapsed={isCollapsed} />
        ))}
      </nav>

      {/* ── Footer ── */}
      <div className={cn("border-t border-border/50", isCollapsed ? "p-2" : "p-4")}>
        {isCollapsed ? (
          /* Collapsed: avatar + theme toggle stacked */
          <div className="flex flex-col items-center gap-2 mb-2">
            <Link href="/profile" title={fullName} className="rounded-md transition-colors hover:bg-accent/5">
              <Avatar className="h-8 w-8">
                {avatarUrl && <AvatarImage src={avatarUrl} alt={fullName} />}
                <AvatarFallback className="bg-primary/10 text-xs font-semibold text-primary">
                  {initials}
                </AvatarFallback>
              </Avatar>
            </Link>
            <ThemeToggle currentTheme={theme} />
          </div>
        ) : (
          /* Expanded: full profile row */
          <div className="flex items-center gap-2.5 mb-2 px-1">
            <Link
              href="/profile"
              className="flex min-w-0 flex-1 items-center gap-3 rounded-md px-1.5 py-1.5 transition-colors hover:bg-accent/5"
              title="My profile"
            >
              <Avatar className="h-9 w-9 shrink-0">
                {avatarUrl && <AvatarImage src={avatarUrl} alt={fullName} />}
                <AvatarFallback className="bg-primary/10 text-xs font-semibold text-primary">
                  {initials}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{fullName}</p>
                <p className="text-xs capitalize text-muted-foreground">{role}</p>
              </div>
            </Link>
            <ThemeToggle currentTheme={theme} />
          </div>
        )}

        <form action={signOut}>
          <button
            type="submit"
            title={isCollapsed ? "Sign out" : undefined}
            className={cn(
              "flex w-full items-center rounded-lg text-sm text-muted-foreground transition-colors hover:bg-destructive/5 hover:text-destructive",
              isCollapsed ? "justify-center p-3" : "gap-3 px-4 py-3",
            )}
          >
            <LogOut className="h-[18px] w-[18px] shrink-0" />
            {!isCollapsed && "Sign out"}
          </button>
        </form>
      </div>
    </div>
  );

  // Sheet mode: plain inner content only (Sheet provides the container)
  if (mode === "sheet") {
    return inner;
  }

  // Sidebar mode: render own <aside> with animated width
  return (
    <aside
      className={cn(
        "hidden shrink-0 border-r border-border/50 bg-card lg:block",
        "transition-[width] duration-200 ease-out",
        isCollapsed ? "w-[64px]" : "w-[280px]",
      )}
    >
      {inner}
    </aside>
  );
}
