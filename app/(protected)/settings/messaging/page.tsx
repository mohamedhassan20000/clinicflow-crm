import type { Metadata } from "next";
import { Activity } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { WhatsAppConnectionCard } from "@/components/settings/whatsapp-connection-card";
import { WhatsAppOnboardingWizard } from "@/components/settings/whatsapp-onboarding-wizard";
import { ReminderSettingsCard } from "@/components/settings/reminder-settings-card";
import { InvoiceFollowupSettingsCard } from "@/components/settings/invoice-followup-settings-card";
import { Button } from "@/components/ui/button";
import { getEntitlements, hasFeature } from "@/lib/entitlements";
import {
  getMetaChannelState,
  getWhatsAppChannelStatus,
} from "@/lib/messaging/channel-management";
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

/** P6C: the public Embedded Signup config, or null when Meta onboarding is off. */
function metaEmbeddedSignupConfig(): { appId: string; configId: string } | null {
  const appId = process.env.NEXT_PUBLIC_META_APP_ID;
  const configId = process.env.NEXT_PUBLIC_META_CONFIG_ID;
  return appId && configId ? { appId, configId } : null;
}

export default async function MessagingSettingsPage() {
  const settingsT = await getTranslations("settings");
  const user = await requireRole(["admin", "manager"]);
  const supabase = await createClient();
  const [status, metaState, entitlements, clinicResult] = await Promise.all([
    getWhatsAppChannelStatus(user.clinicId),
    getMetaChannelState(user.clinicId),
    getEntitlements(user.clinicId),
    supabase
      .from("clinics")
      .select(
        "name, phone, address, reminders_enabled, invoice_followups_enabled, invoice_followup_first_days, invoice_followup_second_days, invoice_followup_email_subject, invoice_followup_email_body",
      )
      .eq("id", user.clinicId)
      .single(),
  ]);
  const clinic = clinicResult.data;
  const remindersEnabled = clinic?.reminders_enabled ?? true;
  const canManageReminders = user.role === "admin" || user.role === "manager";
  const whatsappEntitled = hasFeature(entitlements, "whatsapp");
  const metaConfig = metaEmbeddedSignupConfig();

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
      <WhatsAppOnboardingWizard
        initialState={metaState}
        clinic={{
          name: clinic?.name ?? null,
          phone: clinic?.phone ?? null,
          address: clinic?.address ?? null,
        }}
        canManage={user.role === "admin"}
        entitled={whatsappEntitled}
        metaConfig={metaConfig}
      />
      <WhatsAppConnectionCard
        status={status}
        canManage={user.role === "admin"}
        entitled={whatsappEntitled}
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
