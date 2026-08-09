import type { Metadata } from "next";
import { requireRole } from "@/lib/rbac";
import { SettingsNav } from "@/components/settings/settings-nav";
import { SettingsPageHeader } from "@/components/settings/settings-page-header";
import { isPrimaryClinicAdmin } from "@/lib/primary-admin";
import { getTranslations } from "next-intl/server";
import { AI_ASSISTANT_FEATURE } from "@/lib/ai/authorization";
import { getEntitlements, hasFeature } from "@/lib/entitlements";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("protected");
  return { title: t("metadataSettings") };
}

export default async function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireRole(["admin", "manager"]);
  const [primary, entitlements] = await Promise.all([
    user.role === "admin" ? isPrimaryClinicAdmin(user.id, user.clinicId) : false,
    getEntitlements(user.clinicId),
  ]);
  const canCustomize = user.role === "admin" && primary;
  const canManageAi = canCustomize && hasFeature(entitlements, AI_ASSISTANT_FEATURE);

  return (
    <div className="space-y-6">
      <SettingsPageHeader />

      <SettingsNav
        canCustomize={canCustomize}
        canManageAi={canManageAi}
        canManageClinical={user.role === "admin"}
      />

      {children}
    </div>
  );
}
