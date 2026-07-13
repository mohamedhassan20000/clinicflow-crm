import type { Metadata } from "next";
import { requireRole } from "@/lib/rbac";
import { SettingsNav } from "@/components/settings/settings-nav";
import { SettingsPageHeader } from "@/components/settings/settings-page-header";
import { isPrimaryClinicAdmin } from "@/lib/primary-admin";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireRole(["admin", "manager"]);
  const canCustomize =
    user.role === "admin" &&
    await isPrimaryClinicAdmin(user.id, user.clinicId);

  return (
    <div className="space-y-6">
      <SettingsPageHeader />

      <SettingsNav canCustomize={canCustomize} />

      {children}
    </div>
  );
}
