import type { Metadata } from "next";
import { requireUser } from "@/lib/rbac";

export const metadata: Metadata = {
  title: "Dashboard",
};

export default async function DashboardPage() {
  const user = await requireUser();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground">
          Welcome back, {user.fullName}.
        </p>
      </div>

      <div className="rounded-xl border border-border/50 bg-card p-6">
        <p className="text-sm text-muted-foreground">
          You are signed in as{" "}
          <span className="font-medium capitalize text-foreground">
            {user.role}
          </span>
          . Role-scoped dashboards with KPIs and charts will be built in Phase 4.
        </p>
      </div>
    </div>
  );
}
