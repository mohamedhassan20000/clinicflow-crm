"use client";

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

interface NavEntry {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
}

interface SidebarProps {
  role: string;
  fullName: string;
  theme: "light" | "dark";
}

function buildNav(role: string): NavEntry[] {
  const items: NavEntry[] = [
    { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  ];
  if (role === "admin" || role === "receptionist") {
    items.push(
      { href: "/patients", label: "Patients", icon: Users },
      { href: "/appointments", label: "Appointments", icon: CalendarDays },
      { href: "/followups", label: "Follow-ups", icon: PhoneCall },
    );
  }
  if (role === "doctor") {
    items.push(
      { href: "/patients", label: "Patients", icon: Users },
      { href: "/appointments", label: "Appointments", icon: CalendarDays },
      { href: "/followups", label: "Follow-ups", icon: PhoneCall },
    );
  }
  if (role === "admin" || role === "manager") {
    items.push({ href: "/revenue", label: "Revenue", icon: Wallet });
  }
  if (role === "admin") {
    items.push({ href: "/settings", label: "Settings", icon: Settings });
  }
  return items;
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
        "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
        isActive
          ? "bg-primary/10 text-primary"
          : "text-foreground/60 hover:bg-accent/5 hover:text-foreground",
      )}
    >
      <Icon
        className={cn(
          "h-4 w-4 shrink-0",
          isActive ? "text-primary" : "text-foreground/40",
        )}
      />
      {label}
    </Link>
  );
}

export function Sidebar({ role, fullName, theme }: SidebarProps) {
  const nav = buildNav(role);

  return (
    <aside className="flex h-full flex-col">
      {/* Logo */}
      <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-border/50 px-4">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary text-primary-foreground text-xs font-bold select-none">
          CF
        </span>
        <span className="text-sm font-semibold tracking-tight">ClinicFlow</span>
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-auto p-2 pt-3 space-y-0.5">
        {nav.map((n) => (
          <NavLink key={n.href} {...n} />
        ))}
      </nav>

      {/* Footer */}
      <div className="border-t border-border/50 p-3">
        <div className="flex items-center gap-2 mb-2 px-1">
          <Link
            href="/profile"
            className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1 transition-colors hover:bg-accent/5"
            title="My profile"
          >
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
              {fullName.charAt(0).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium">{fullName}</p>
              <p className="text-[10px] capitalize text-muted-foreground">
                {role}
              </p>
            </div>
          </Link>
          <ThemeToggle currentTheme={theme} />
        </div>
        <form action={signOut}>
          <button
            type="submit"
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-xs text-muted-foreground transition-colors hover:bg-destructive/5 hover:text-destructive"
          >
            <LogOut className="h-3.5 w-3.5 shrink-0" />
            Sign out
          </button>
        </form>
      </div>
    </aside>
  );
}
