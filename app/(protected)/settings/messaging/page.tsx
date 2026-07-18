import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { WhatsAppConnectionCard } from "@/components/settings/whatsapp-connection-card";
import { ReminderSettingsCard } from "@/components/settings/reminder-settings-card";
import { InvoiceFollowupSettingsCard } from "@/components/settings/invoice-followup-settings-card";
import { getEntitlements, hasFeature } from "@/lib/entitlements";
import { getWhatsAppChannelStatus } from "@/lib/messaging/channel-management";
import { requireRole } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";

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
  const supabase = await createClient();
  const [status, entitlements, clinicResult] = await Promise.all([
    getWhatsAppChannelStatus(user.clinicId),
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
