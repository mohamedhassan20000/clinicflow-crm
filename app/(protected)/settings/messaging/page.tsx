import type { Metadata } from "next";
import { Activity } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { MetaApiConnectCard } from "@/components/settings/meta-api-connect-card";
import { WhatsAppHistoryImportCard } from "@/components/settings/whatsapp-history-import-card";
import { WhatsAppAiRepliesCard } from "@/components/settings/whatsapp-ai-replies-card";
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
  readHistoryImportView,
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
  const [connectionView, linkedDeviceView, historyView, entitlements, clinicResult] =
    await Promise.all([
    getWhatsAppConnectionView(user.clinicId),
    readLinkedDeviceSession(user.clinicId),
    readHistoryImportView(user.clinicId),
    getEntitlements(user.clinicId),
    supabase
      .from("clinics")
      .select(
        "name, ai_reply_mode, reminders_enabled, invoice_followups_enabled, invoice_followup_first_days, invoice_followup_second_days, invoice_followup_email_subject, invoice_followup_email_body",
      )
      .eq("id", user.clinicId)
      .single(),
  ]);
  // P15 (§3) — how many conversations currently override the clinic-wide
  // switch. Shown on the card so a clinic that has turned the assistant off
  // everywhere and still sees replies is told why on the same screen instead of
  // filing a bug. A database without the column answers zero, which is the
  // truthful pre-P15 count.
  const aiExceptionResult = await supabase
    .from("conversations")
    .select("id", { count: "exact", head: true })
    .eq("clinic_id", user.clinicId)
    .not("ai_enabled_override", "is", null);
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
        {/* P8B: how far the linked account's history import got. WhatsApp
            decides how much it sends, so the count is reported rather than
            promised. Renders itself away when there has never been one. */}
        <WhatsAppHistoryImportCard
          view={historyView}
          connected={linkedDeviceView.status === "connected"}
          canManage={user.role === "admin"}
        />
        <MetaApiConnectCard
          initialConnection={connectionView}
          canManage={user.role === "admin"}
          entitled={whatsappEntitled}
          webhookSetup={getMetaWebhookSetup(user.clinicId)}
        />
      </section>

      {/* P15 (§3): the clinic-wide AI reply switch, beside the connection it
          governs. Same stored value and same entitlement gate as the mode
          selector on the Patient AI page — this is a second view of one
          setting, never a second setting. */}
      <WhatsAppAiRepliesCard
        mode={
          clinic?.ai_reply_mode === "auto" || clinic?.ai_reply_mode === "suggest"
            ? clinic.ai_reply_mode
            : "off"
        }
        canManage={user.role === "admin"}
        exceptionCount={aiExceptionResult.error ? 0 : aiExceptionResult.count ?? 0}
      />

      <ReminderSettingsCard enabled={remindersEnabled} canManage={canManageReminders} />
      <InvoiceFollowupSettingsCard
        enabled={clinic?.invoice_followups_enabled ?? true}
        firstDays={clinic?.invoice_followup_first_days ?? 3}
        secondDays={clinic?.invoice_followup_second_days ?? 7}
        emailSubject={clinic?.invoice_followup_email_subject ?? null}
        emailBody={clinic?.invoice_followup_email_body ?? null}
        clinicName={clinic?.name ?? ""}
        canManage={canManageReminders}
      />
    </div>
  );
}
