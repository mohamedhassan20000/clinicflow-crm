import Link from "next/link";
import { requirePlatformAdmin } from "@/lib/rbac";

const NAV = [
  { href: "/operator", label: "Mission Control" },
  { href: "/operator/clinics", label: "Clinics" },
  { href: "/operator/invitations", label: "Invitations" },
  { href: "/operator/coupons", label: "Coupons" },
  { href: "/operator/settings", label: "Settings" },
];

export default async function OperatorLayout({ children }: { children: React.ReactNode }) {
  const admin = await requirePlatformAdmin();
  return (
    <div className="min-h-dvh bg-background">
      <header className="border-b bg-card">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-5 py-3">
          <span className="text-lg font-bold tracking-tight text-primary">ClinicFlow Operator</span>
          <nav className="flex flex-wrap gap-4 text-sm">
            {NAV.map((item) => (
              <Link key={item.href} href={item.href} className="text-muted-foreground hover:text-foreground">
                {item.label}
              </Link>
            ))}
          </nav>
          <span className="ms-auto text-xs text-muted-foreground">{admin.email}</span>
        </div>
      </header>
      <main className="mx-auto max-w-6xl space-y-8 px-5 py-8">{children}</main>
    </div>
  );
}
