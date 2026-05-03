import type { Metadata } from "next";
import { requireRole } from "@/lib/rbac";
import { SettingsNav } from "@/components/settings/settings-nav";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireRole(["admin", "manager"]);
  const isManager = user.role === "manager";

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
          <p className="text-sm text-muted-foreground">
            {isManager
              ? "View clinic configuration and staff."
              : "Manage your clinic, staff, and configuration."}
          </p>
        </div>
        {isManager && (
          <span className="rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
            Read-only
          </span>
        )}
      </div>

      <SettingsNav hideClinic={isManager} />

      {children}
    </div>
  );
}
