import type { Metadata } from "next";
import { LockKeyhole, Sparkles } from "lucide-react";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { AI_ASSISTANT_CUSTOMIZATION_FEATURE } from "@/lib/ai/authorization";
import { getAssistantLauncherCustomization } from "@/lib/ai/launcher-customization";
import type { AssistantLauncherCustomizationData } from "@/lib/ai/launcher-customization-types";
import { getEntitlements, hasFeature } from "@/lib/entitlements";
import { isPrimaryClinicAdmin } from "@/lib/primary-admin";
import { requireRole } from "@/lib/rbac";
import { AssistantLauncherCustomizer } from "@/components/settings/assistant-launcher-customizer";

export async function generateMetadata(): Promise<Metadata> {
  const metadataT = await getTranslations("protected");
  return { title: metadataT("metadataAssistantCustomization") };
}

export default async function AssistantCustomizationPage() {
  const t = await getTranslations("settings");
  const user = await requireRole("admin");
  const [primary, entitlements] = await Promise.all([
    isPrimaryClinicAdmin(user.id, user.clinicId),
    getEntitlements(user.clinicId),
  ]);
  if (!primary) redirect("/dashboard");

  const entitled = hasFeature(
    entitlements,
    AI_ASSISTANT_CUSTOMIZATION_FEATURE,
  );

  let content: React.ReactNode;
  if (!entitled) {
    content = (
      <div className="flex min-h-80 flex-col items-center justify-center rounded-2xl border border-border/70 bg-card px-6 py-12 text-center shadow-sm">
        <div className="mb-4 grid size-12 place-items-center rounded-2xl border border-primary/20 bg-primary/8 text-primary">
          <LockKeyhole className="size-5" aria-hidden="true" />
        </div>
        <h2 className="font-heading text-lg font-semibold">
          {t("assistantCustomizationUpgradeTitle")}
        </h2>
        <p className="mt-2 max-w-lg text-sm leading-6 text-muted-foreground">
          {t("assistantCustomizationUpgradeDescription")}
        </p>
        <p className="mt-5 rounded-full border border-border/70 bg-muted/40 px-3 py-1.5 text-xs font-medium text-muted-foreground">
          {t("assistantCustomizationDefaultsRemainActive")}
        </p>
      </div>
    );
  } else {
    let data: AssistantLauncherCustomizationData | null = null;
    try {
      data = await getAssistantLauncherCustomization(user);
    } catch {
      data = null;
    }
    content = data ? (
      <AssistantLauncherCustomizer initialData={data} />
    ) : (
      <div
        role="alert"
        className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"
      >
        {t("assistantCustomizationLoadError")}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="flex items-center gap-2 font-semibold">
          <Sparkles className="size-4 text-primary" aria-hidden="true" />
          {t("assistantCustomizationTitle")}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("assistantCustomizationDescription")}
        </p>
      </div>
      {content}
    </div>
  );
}
