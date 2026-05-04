import type { Metadata } from "next";
import { requireRole } from "@/lib/rbac";
import { SettingsNav } from "@/components/settings/settings-nav";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireRole(["admin", "manager"]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Manage your clinic, staff, and configuration.
        </p>
      </div>

      <SettingsNav />

      {children}
    </div>
  );
}
