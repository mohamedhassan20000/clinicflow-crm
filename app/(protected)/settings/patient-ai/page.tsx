import type { Metadata } from "next";
import { LockKeyhole, MessagesSquare } from "lucide-react";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getPatientAiSettings } from "@/lib/ai/patient-faq-settings";
import { isPrimaryClinicAdmin } from "@/lib/primary-admin";
import { requireRole } from "@/lib/rbac";
import { PatientAiSettingsPanel } from "@/components/settings/patient-ai-settings";

export async function generateMetadata(): Promise<Metadata> {
  const metadataT = await getTranslations("protected");
  return { title: metadataT("metadataPatientAi") };
}

export default async function PatientAiSettingsPage() {
  const t = await getTranslations("settings");
  const user = await requireRole("admin");
  const primary = await isPrimaryClinicAdmin(user.id, user.clinicId);
  if (!primary) redirect("/dashboard");

  const settings = await getPatientAiSettings(user.clinicId);

  return (
    <div className="space-y-5">
      <div>
        <h2 className="flex items-center gap-2 font-semibold">
          <MessagesSquare className="size-4 text-primary" aria-hidden="true" />
          {t("patientAiTitle")}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("patientAiDescription")}</p>
      </div>

      {!settings.entitled ? (
        <div className="flex min-h-72 flex-col items-center justify-center rounded-2xl border border-border/70 bg-card px-6 py-12 text-center shadow-sm">
          <div className="mb-4 grid size-12 place-items-center rounded-2xl border border-primary/20 bg-primary/8 text-primary">
            <LockKeyhole className="size-5" aria-hidden="true" />
          </div>
          <h3 className="font-heading text-lg font-semibold">{t("patientAiUpgradeTitle")}</h3>
          <p className="mt-2 max-w-lg text-sm leading-6 text-muted-foreground">
            {t("patientAiUpgradeDescription")}
          </p>
        </div>
      ) : settings.error ? (
        <div
          role="alert"
          className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"
        >
          {t("patientAiLoadError")}
        </div>
      ) : (
        <PatientAiSettingsPanel
          replyMode={settings.replyMode}
          autoEntitled={settings.autoEntitled}
          faqs={settings.faqs}
        />
      )}
    </div>
  );
}
