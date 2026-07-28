import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { WhatsAppHealthDashboard } from "@/components/settings/whatsapp-health-dashboard";
import { getEntitlements, hasFeature } from "@/lib/entitlements";
import { getWhatsAppHealthSnapshot } from "@/lib/messaging/health";
import { requireRole } from "@/lib/rbac";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("protected");
  return { title: t("metadataWhatsAppHealth") };
}

export default async function WhatsAppHealthPage() {
  const user = await requireRole(["admin", "manager"]);
  const [snapshot, entitlements] = await Promise.all([
    getWhatsAppHealthSnapshot(user.clinicId),
    getEntitlements(user.clinicId),
  ]);

  return (
    <WhatsAppHealthDashboard
      snapshot={snapshot}
      entitled={hasFeature(entitlements, "whatsapp")}
    />
  );
}
