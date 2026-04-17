import { redirect } from "next/navigation";
import { requireUser } from "@/lib/rbac";

export default async function ProtectedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();

  if (user.mustChangePassword) {
    redirect("/change-password");
  }

  return (
    <div className="flex min-h-dvh bg-background">
      {/* Sidebar placeholder — full sidebar lands in Phase 4 */}
      <aside className="hidden w-60 shrink-0 border-r border-border/50 bg-card lg:block">
        <div className="flex h-14 items-center gap-2.5 border-b border-border/50 px-4">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary text-primary-foreground text-xs font-bold">
            CF
          </span>
          <span className="text-sm font-semibold tracking-tight">
            ClinicFlow
          </span>
        </div>
        <nav className="p-2 text-sm text-muted-foreground">
          <p className="px-3 py-2 text-xs font-medium uppercase tracking-wider text-muted-foreground/50">
            Navigation
          </p>
          <NavItem href="/dashboard" label="Dashboard" />
          {(user.role === "admin" || user.role === "receptionist") && (
            <>
              <NavItem href="/patients" label="Patients" />
              <NavItem href="/appointments" label="Appointments" />
            </>
          )}
          {user.role === "admin" && (
            <NavItem href="/settings/staff" label="Settings" />
          )}
        </nav>
      </aside>

      {/* Main */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-border/50 bg-card px-4 lg:px-6">
          <div />
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground">
              {user.fullName}
            </span>
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium capitalize text-primary">
              {user.role}
            </span>
          </div>
        </header>
        <main className="flex-1 overflow-auto p-4 lg:p-6">{children}</main>
      </div>
    </div>
  );
}

function NavItem({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      className="block rounded-md px-3 py-2 text-sm text-foreground/70 transition-colors hover:bg-accent/5 hover:text-foreground"
    >
      {label}
    </a>
  );
}
