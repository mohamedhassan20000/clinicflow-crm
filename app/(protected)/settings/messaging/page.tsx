import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { WhatsAppConnectionCard } from "@/components/settings/whatsapp-connection-card";
import { getEntitlements, hasFeature } from "@/lib/entitlements";
import { getWhatsAppChannelStatus } from "@/lib/messaging/channel-management";
import { requireRole } from "@/lib/rbac";

export async function generateMetadata(): Promise<Metadata> {
  const metadataT = await getTranslations("protected");
  return { title: metadataT("metadataMessagingSettings") };
}

function hostedSignupUrl(): string | null {
  const raw = process.env.DIALOG360_SIGNUP_URL;
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export default async function MessagingSettingsPage() {
  const settingsT = await getTranslations("settings");
  const user = await requireRole(["admin", "manager"]);
  const [status, entitlements] = await Promise.all([
    getWhatsAppChannelStatus(user.clinicId),
    getEntitlements(user.clinicId),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-semibold">{settingsT("messagingSettingsTitle")}</h2>
        <p className="text-sm text-muted-foreground">
          {settingsT("messagingSettingsDescription")}
        </p>
      </div>
      <WhatsAppConnectionCard
        status={status}
        canManage={user.role === "admin"}
        entitled={hasFeature(entitlements, "whatsapp")}
        signupUrl={hostedSignupUrl()}
      />
    </div>
  );
}
