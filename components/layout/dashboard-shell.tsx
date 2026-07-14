"use client";

import { useState, useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";
import Image from "next/image";
import Link from "next/link";
import { LogOut, Menu, SlidersHorizontal, UserRound } from "lucide-react";
import { signOut } from "@/actions/auth";
import { Sidebar } from "@/components/layout/sidebar";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import type { ShellNavItem } from "@/lib/dashboard-navigation";

const STORAGE_KEY = "clinicflow:sidebar-collapsed";
const STORAGE_EVENT = "clinicflow:sidebar-change";

function subscribeToSidebarState(callback: () => void) {
  window.addEventListener("storage", callback);
  window.addEventListener(STORAGE_EVENT, callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener(STORAGE_EVENT, callback);
  };
}

function getSidebarState() {
  try {
    const current = localStorage.getItem(STORAGE_KEY);
    if (current !== null) return current === "true";
    const legacy = localStorage.getItem("sidebar-collapsed");
    if (legacy !== null) {
      localStorage.setItem(STORAGE_KEY, legacy);
      localStorage.removeItem("sidebar-collapsed");
      return legacy === "true";
    }
    return false;
  } catch { return false; }
}

/**
 * The audience the shell is rendered for. It is passed explicitly by the layout that owns the
 * route group — `(protected)` passes "clinic", `(operator)` passes "operator" — and is never
 * inferred from a role string: a Platform Admin has no `profiles` row, so no clinic role label
 * can describe the operator surface.
 */
type DashboardSurface = "clinic" | "operator";

type DashboardShellProps = {
  children: React.ReactNode;
  navItems: readonly ShellNavItem[];
  user: { fullName: string; email?: string; roleLabel: string; avatarUrl?: string | null; profileHref?: string };
  theme: "light" | "dark";
  surface: DashboardSurface;
  brandLabel?: string;
  /**
   * Header utility rendered before the theme toggle. Today only the `(operator)` layout passes one —
   * the Operator Language Switcher, in the slot reserved for it (§6.A). The **clinic** header gets no
   * language control at all: clinic users switch language in Preferences.
   */
  headerSlot?: React.ReactNode;
  contentClassName?: string;
};

export function DashboardShell({ children, navItems, user, theme, surface, brandLabel, headerSlot, contentClassName = "px-5 py-6 lg:px-10 lg:py-8" }: DashboardShellProps) {
  const t = useTranslations("shell");
  const collapsed = useSyncExternalStore(subscribeToSidebarState, getSidebarState, () => false);
  const [mobileOpen, setMobileOpen] = useState(false);

  const updateCollapsed = (next: boolean) => {
    try {
      localStorage.setItem(STORAGE_KEY, String(next));
      window.dispatchEvent(new Event(STORAGE_EVENT));
    } catch { /* storage may be unavailable */ }
  };

  const initials = user.fullName.split(" ").filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "?";

  return (
    <div className="flex min-h-dvh bg-background">
      <Sidebar items={navItems} collapsed={collapsed} onCollapsedChange={updateCollapsed} brandLabel={brandLabel} />
      <div className="flex min-w-0 flex-1 flex-col">
        <header data-testid="dashboard-header" className="flex h-[var(--shell-header-h)] shrink-0 items-center gap-3 border-b bg-card/95 px-4 backdrop-blur md:px-6">
          <Button variant="ghost" size="icon" className="md:hidden" onClick={() => setMobileOpen(true)} aria-label={t("openNavigation")}><Menu className="size-5" /></Button>
          <span className="flex items-center gap-2 md:hidden"><Image src="/brand/clinicflow-mark.png" alt={t("brand")} width={28} height={24} className="h-6 w-auto" /><span className="text-sm font-semibold">{brandLabel ?? t("brand")}</span></span>
          <div className="flex-1" />
          {headerSlot}
          <ThemeToggle currentTheme={theme} />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" className="h-11 gap-2 rounded-xl px-2" aria-label={t("openUserMenu")}>
                <Avatar className="size-8"><AvatarImage src={user.avatarUrl ?? undefined} alt={user.fullName} /><AvatarFallback className="bg-primary/10 text-xs font-semibold text-primary">{initials}</AvatarFallback></Avatar>
                <span className="hidden max-w-40 text-start sm:block"><span className="block truncate text-sm font-medium">{user.fullName}</span><span className="block truncate text-xs capitalize text-muted-foreground">{user.roleLabel}</span></span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60 p-2">
              <DropdownMenuLabel><span className="block truncate text-sm text-foreground">{user.fullName}</span>{user.email ? <span className="block truncate font-normal">{user.email}</span> : null}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {user.profileHref ? <DropdownMenuItem asChild><Link href={user.profileHref} className="gap-2 py-2"><UserRound />{t("myProfile")}</Link></DropdownMenuItem> : null}
              {/*
                Clinic surface only. `/preferences` is a clinic-user route (`requireUser()` + `profiles`),
                so a Platform Admin has no row to read and the entry is a broken link there.
                i18n-allow: implementation note inside a JSX comment, never rendered.
                On the operator surface this position is the RESERVED SLOT for the P2 Operator Language
                Switcher (AI_AGENT_PLAN.md §4.1) — reserved means left empty, never stubbed: it will govern
                the operator dashboard's language for that platform-admin user only, never a clinic.
              */}
              {surface === "clinic" ? <DropdownMenuItem asChild><Link href="/preferences" className="gap-2 py-2"><SlidersHorizontal />{t("preferences")}</Link></DropdownMenuItem> : null}
              <form action={signOut}><DropdownMenuItem asChild variant="destructive" onSelect={(event) => event.preventDefault()}><button type="submit" className="w-full gap-2 py-2"><LogOut className="rtl:rotate-180" />{t("signOut")}</button></DropdownMenuItem></form>
            </DropdownMenuContent>
          </DropdownMenu>
        </header>
        <main className={`flex-1 overflow-x-hidden ${contentClassName}`}>{children}</main>
      </div>
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="inline-start" className="w-72 p-0"><SheetTitle className="sr-only">{t("navigationMenu")}</SheetTitle><div className="h-full" onClick={() => setMobileOpen(false)}><Sidebar mode="sheet" items={navItems} collapsed={false} brandLabel={brandLabel} /></div></SheetContent>
      </Sheet>
    </div>
  );
}
