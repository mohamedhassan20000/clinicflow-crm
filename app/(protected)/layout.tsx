import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { requireUser } from "@/lib/rbac";
import { Sidebar } from "@/components/layout/sidebar";
import { MobileNav } from "@/components/layout/mobile-nav";
import { fetchUserCustomizationMap, getHiddenPages } from "@/lib/get-user-customizations";

export default async function ProtectedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();

  if (user.mustChangePassword) {
    redirect("/change-password");
  }

  const cookieStore = await cookies();
  const theme = (cookieStore.get("theme")?.value ?? "light") as "light" | "dark";

  const customMap = await fetchUserCustomizationMap(user.id);
  const hiddenPages = getHiddenPages(customMap, user.role);

  return (
    <div className="flex min-h-dvh bg-background">
      {/* Desktop sidebar */}
      <aside className="hidden w-60 shrink-0 border-r border-border/50 bg-card lg:block">
        <Sidebar role={user.role} fullName={user.fullName} theme={theme} hiddenPages={hiddenPages} />
      </aside>

      {/* Main column */}
      <div className="flex flex-1 flex-col min-w-0">
        {/* Top header */}
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border/50 bg-card px-4 lg:px-6">
          <MobileNav role={user.role} fullName={user.fullName} theme={theme} hiddenPages={hiddenPages} />
          {/* ClinicFlow brand for mobile */}
          <span className="flex items-center gap-2 lg:hidden">
            <span className="flex h-6 w-6 items-center justify-center rounded bg-primary text-primary-foreground text-[10px] font-bold">
              CF
            </span>
            <span className="text-sm font-semibold">ClinicFlow</span>
          </span>
          <div className="flex-1" />
          {/* Desktop: user chip */}
          <div className="hidden lg:flex items-center gap-2">
            <span className="text-sm text-muted-foreground">{user.fullName}</span>
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium capitalize text-primary">
              {user.role}
            </span>
          </div>
        </header>

        <main className="flex-1 overflow-auto p-4 lg:p-6 max-w-7xl w-full mx-auto">
          {children}
        </main>
      </div>
    </div>
  );
}
