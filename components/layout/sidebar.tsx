"use client";

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
  PhoneCall,
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

interface SidebarProps {
  role: string;
  fullName: string;
  avatarUrl?: string | null;
  theme: "light" | "dark";
  visiblePages?: PageSlug[];
}

const ICONS: Record<PageSlug, typeof LayoutDashboard> = {
  dashboard: LayoutDashboard,
  patients: Users,
  appointments: CalendarDays,
  followups: PhoneCall,
  revenue: Wallet,
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

function NavLink({ href, label, icon: Icon }: NavEntry) {
  const pathname = usePathname();
  const isActive =
    href === "/dashboard"
      ? pathname === "/dashboard"
      : pathname.startsWith(href);

  return (
    <Link
      href={href}
      className={cn(
        "flex items-center gap-3.5 rounded-lg px-3.5 py-3 text-base font-medium transition-colors",
        isActive
          ? "bg-primary/10 text-primary"
          : "text-foreground/60 hover:bg-accent/5 hover:text-foreground",
      )}
    >
      <Icon
        className={cn(
          "h-5 w-5 shrink-0",
          isActive ? "text-primary" : "text-foreground/40",
        )}
      />
      {label}
    </Link>
  );
}

export function Sidebar({
  role,
  fullName,
  avatarUrl,
  theme,
  visiblePages,
}: SidebarProps) {
  const nav = buildNav(role, visiblePages);
  const initials = fullName
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("") || "?";

  return (
    <aside className="flex h-full flex-col">
      {/* Logo */}
      <div className="flex h-14 shrink-0 items-center gap-3 border-b border-border/50 px-5">
        <Image
          src="/brand/clinicflow-mark.png"
          alt="ClinicFlow"
          width={44}
          height={44}
          className="h-11 w-11 object-contain"
        />
        <span className="text-base font-semibold tracking-tight">ClinicFlow</span>
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-auto p-2.5 pt-4 space-y-0.5">
        {nav.map((n) => (
          <NavLink key={n.href} {...n} />
        ))}
      </nav>

      {/* Footer */}
      <div className="border-t border-border/50 p-4">
        <div className="flex items-center gap-2.5 mb-2 px-1">
          <Link
            href="/profile"
            className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-1.5 py-1.5 transition-colors hover:bg-accent/5"
            title="My profile"
          >
            <Avatar size="sm" className="h-9 w-9">
              {avatarUrl && <AvatarImage src={avatarUrl} alt={fullName} />}
              <AvatarFallback className="bg-primary/10 text-xs font-semibold text-primary">
                {initials}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{fullName}</p>
              <p className="text-xs capitalize text-muted-foreground">
                {role}
              </p>
            </div>
          </Link>
          <ThemeToggle currentTheme={theme} />
        </div>
        <form action={signOut}>
          <button
            type="submit"
            className="flex w-full items-center gap-2.5 rounded-lg px-3.5 py-2.5 text-sm text-muted-foreground transition-colors hover:bg-destructive/5 hover:text-destructive"
          >
            <LogOut className="h-4 w-4 shrink-0" />
            Sign out
          </button>
        </form>
      </div>
    </aside>
  );
}
