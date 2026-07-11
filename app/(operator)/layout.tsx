import { cookies } from "next/headers";
import { requirePlatformAdmin } from "@/lib/rbac";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { OPERATOR_SHELL_NAVIGATION } from "@/lib/dashboard-navigation";

export default async function OperatorLayout({ children }: { children: React.ReactNode }) {
  const admin = await requirePlatformAdmin();
  const cookieStore = await cookies();
  const theme = (cookieStore.get("theme")?.value ?? "light") as "light" | "dark";
  return (
    <DashboardShell navItems={OPERATOR_SHELL_NAVIGATION} user={{ fullName: admin.email, email: admin.email, roleLabel: "Platform admin" }} theme={theme} brandLabel="ClinicFlow Operator" contentClassName="mx-auto w-full max-w-7xl space-y-8 px-5 py-8 lg:px-10">
      {children}
    </DashboardShell>
  );
}
