import type { Metadata } from "next";
import Link from "next/link";
import { requireRole } from "@/lib/rbac";

export const metadata: Metadata = { title: "Settings" };

const NAV = [
  { href: "/settings/staff", label: "Staff" },
  { href: "/settings/departments", label: "Departments" },
  { href: "/settings/insurance", label: "Insurance" },
  { href: "/settings/clinic", label: "Clinic" },
] as const;

export default async function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireRole("admin");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Manage your clinic, staff, and configuration.
        </p>
      </div>

      {/* Tab nav */}
      <nav className="flex gap-1 border-b border-border/50 overflow-x-auto pb-px">
        {NAV.map((n) => (
          <Link
            key={n.href}
            href={n.href}
            className="shrink-0 rounded-t-md px-4 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground data-[active]:border-b-2 data-[active]:border-primary data-[active]:text-primary"
          >
            {n.label}
          </Link>
        ))}
      </nav>

      {children}
    </div>
  );
}
