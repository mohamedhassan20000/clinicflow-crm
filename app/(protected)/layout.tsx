import Image from "next/image";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { requireUser } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";
import { Sidebar } from "@/components/layout/sidebar";
import { MobileNav } from "@/components/layout/mobile-nav";
import { getVisiblePageSlugs } from "@/lib/server-page-permissions";
import { ClinicSettingsProvider } from "@/contexts/clinic-settings-context";
import type { TimeFormat } from "@/lib/format-time";

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
  const visiblePages = await getVisiblePageSlugs(user);

  const supabase = await createClient();
  const { data: clinic } = await supabase
    .from("clinics")
    .select("time_format")
    .eq("id", user.clinicId)
    .single();

  const timeFormat: TimeFormat =
    clinic?.time_format === "12h" ? "12h" : "24h";

  return (
    <ClinicSettingsProvider timeFormat={timeFormat}>
      <div className="flex min-h-dvh bg-background">
        {/* Desktop sidebar */}
        <aside className="hidden w-72 shrink-0 border-r border-border/50 bg-card lg:block">
          <Sidebar
            role={user.role}
            fullName={user.fullName}
            avatarUrl={user.avatarUrl}
            theme={theme}
            visiblePages={visiblePages}
          />
        </aside>

        {/* Main column */}
        <div className="flex flex-1 flex-col min-w-0">
          {/* Top header */}
          <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border/50 bg-card px-4 lg:px-6">
            <MobileNav
              role={user.role}
              fullName={user.fullName}
              avatarUrl={user.avatarUrl}
              theme={theme}
              visiblePages={visiblePages}
            />
            {/* ClinicFlow brand for mobile */}
            <span className="flex items-center gap-2 lg:hidden">
              <Image
                src="/brand/clinicflow-mark.png"
                alt="ClinicFlow"
                width={36}
                height={36}
                className="h-9 w-9 object-contain"
              />
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

          <main className="flex-1 overflow-auto px-6 py-4 lg:px-10 lg:py-6">
            {children}
          </main>
        </div>
      </div>
    </ClinicSettingsProvider>
  );
}
