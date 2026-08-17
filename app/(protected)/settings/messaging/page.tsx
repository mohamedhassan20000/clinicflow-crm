import type { Metadata } from "next";
import { Activity } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { MetaApiConnectCard } from "@/components/settings/meta-api-connect-card";
import { WhatsAppQrConnectCard } from "@/components/settings/whatsapp-qr-connect-card";
import { ReminderSettingsCard } from "@/components/settings/reminder-settings-card";
import { InvoiceFollowupSettingsCard } from "@/components/settings/invoice-followup-settings-card";
import { Button } from "@/components/ui/button";
import { getEntitlements, hasFeature } from "@/lib/entitlements";
import {
  getMetaWebhookSetup,
  getWhatsAppConnectionView,
} from "@/lib/messaging/channel-management";
import {
  isLinkedDeviceConfigured,
  readLinkedDeviceSession,
} from "@/lib/messaging/linked-device";
import { requireRole } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";

export async function generateMetadata(): Promise<Metadata> {
  const metadataT = await getTranslations("protected");
  return { title: metadataT("metadataMessagingSettings") };
}

/**
 * P7E — the messaging page offers exactly two ways to connect WhatsApp:
 * scanning a QR code from the clinic's own phone, or the clinic's own Meta
 * Cloud API credentials. The earlier platform-brokered onboarding surfaces
 * (Meta Embedded Signup / Coexistence and 360dialog) are no longer offered to
 * clinics; their server-side code is untouched for the channels that already use
 * it, but nothing here launches a Facebook login any more.
 */
export default async function MessagingSettingsPage() {
  const settingsT = await getTranslations("settings");
  const user = await requireRole(["admin", "manager"]);
  const supabase = await createClient();
  const [connectionView, linkedDeviceView, entitlements, clinicResult] = await Promise.all([
    getWhatsAppConnectionView(user.clinicId),
    readLinkedDeviceSession(user.clinicId),
    getEntitlements(user.clinicId),
    supabase
      .from("clinics")
      .select(
        "reminders_enabled, invoice_followups_enabled, invoice_followup_first_days, invoice_followup_second_days, invoice_followup_email_subject, invoice_followup_email_body",
      )
      .eq("id", user.clinicId)
      .single(),
  ]);
  const clinic = clinicResult.data;
  const remindersEnabled = clinic?.reminders_enabled ?? true;
  const canManageReminders = user.role === "admin" || user.role === "manager";
  const whatsappEntitled = hasFeature(entitlements, "whatsapp");

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="font-semibold">{settingsT("messagingSettingsTitle")}</h2>
          <p className="text-sm text-muted-foreground">
            {settingsT("messagingSettingsDescription")}
          </p>
        </div>
        <Button asChild variant="outline">
          <Link href="/settings/messaging/health">
            <Activity className="size-4" aria-hidden />
            {settingsT("healthOpenDashboard")}
          </Link>
        </Button>
      </div>
      {/* The two per-clinic methods. Both write the same single clinic-scoped channel, so each card says when the other owns it. */}
      <section className="space-y-4">
        <div>
          <h3 className="text-sm font-semibold">{settingsT("waMethodsTitle")}</h3>
          <p className="text-sm text-muted-foreground">
            {settingsT("waMethodsDescription")}
          </p>
        </div>
        <WhatsAppQrConnectCard
          initialView={linkedDeviceView}
          ownedBy={connectionView.mode}
          canManage={user.role === "admin"}
          entitled={whatsappEntitled}
          available={isLinkedDeviceConfigured()}
        />
        <MetaApiConnectCard
          initialConnection={connectionView}
          canManage={user.role === "admin"}
          entitled={whatsappEntitled}
          webhookSetup={getMetaWebhookSetup(user.clinicId)}
        />
      </section>

      <ReminderSettingsCard enabled={remindersEnabled} canManage={canManageReminders} />
      <InvoiceFollowupSettingsCard
        enabled={clinic?.invoice_followups_enabled ?? true}
        firstDays={clinic?.invoice_followup_first_days ?? 3}
        secondDays={clinic?.invoice_followup_second_days ?? 7}
        emailSubject={clinic?.invoice_followup_email_subject ?? null}
        emailBody={clinic?.invoice_followup_email_body ?? null}
        canManage={canManageReminders}
      />
    </div>
  );
}
