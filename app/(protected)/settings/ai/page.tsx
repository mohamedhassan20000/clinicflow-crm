import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import {
  AI_ASSISTANT_FEATURE,
  AI_FINANCIAL_INSIGHTS_FEATURE,
} from "@/lib/ai/authorization";
import { AI_FINANCIAL_INSIGHTS_PERMISSION } from "@/lib/ai/permissions";
import { listStaffAiPermissions } from "@/actions/ai-permissions";
import { getAiProviderSettings } from "@/lib/ai/platform/provider-connections";
import { AiFinancialPermissions } from "@/components/settings/ai-financial-permissions";
import { AiProviderSettingsPanel } from "@/components/settings/ai-provider-settings";
import { AiUsageSummary } from "@/components/settings/ai-usage-summary";
import { getClinicAiCommercialUsage } from "@/lib/ai/commercial";
import { getEntitlements, hasAiProviderMode, hasFeature } from "@/lib/entitlements";
import type { AiCredentialMode } from "@/lib/ai/platform/types";
import { isPrimaryClinicAdmin } from "@/lib/primary-admin";
import { requireRole } from "@/lib/rbac";

export async function generateMetadata(): Promise<Metadata> {
  const metadataT = await getTranslations("protected");
  return { title: metadataT("metadataAiProviderSettings") };
}

export default async function AiProviderSettingsPage() {
  const t = await getTranslations("settings");
  const user = await requireRole("admin");
  const [primary, entitlements] = await Promise.all([
    isPrimaryClinicAdmin(user.id, user.clinicId),
    getEntitlements(user.clinicId),
  ]);
  if (!primary || !hasFeature(entitlements, AI_ASSISTANT_FEATURE)) redirect("/dashboard");
  const financialEntitled = hasFeature(entitlements, AI_FINANCIAL_INSIGHTS_FEATURE);
  const [settings, usage, financialStaff] = await Promise.all([
    getAiProviderSettings(user.clinicId),
    getClinicAiCommercialUsage(user.clinicId),
    // Skipped entirely when the plan has no financial AI: the panel renders an
    // explanatory state instead, and there is no reason to read staff for a
    // list nobody can act on.
    // The *permission* key, not the entitlement constant. The two namespaces
    // share the literal "ai.financial_insights" but are resolved by different
    // authorities (hasFeature over the plan vs. a user_ai_permissions row), so
    // passing one where the other belongs worked only by coincidence.
    financialEntitled
      ? listStaffAiPermissions(AI_FINANCIAL_INSIGHTS_PERMISSION)
      : Promise.resolve({ data: [] as const, error: undefined }),
  ]);

  // Advisory display gate only. The server action and the database
  // (setAiProviderMode → hasAiProviderMode, and the trg_ai_provider_policy_
  // entitlement trigger) remain the independent, authoritative enforcement.
  const modeEntitlements: Record<AiCredentialMode, boolean> = {
    managed: hasAiProviderMode(entitlements, "managed"),
    byok_strict: hasAiProviderMode(entitlements, "byok_strict"),
    hybrid: hasAiProviderMode(entitlements, "hybrid"),
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-semibold">{t("aiProviderSettingsTitle")}</h2>
        <p className="text-sm text-muted-foreground">{t("aiProviderSettingsDescription")}</p>
      </div>
      <AiUsageSummary usage={usage} />
      <AiProviderSettingsPanel settings={settings} modeEntitlements={modeEntitlements} />
      <AiFinancialPermissions
        staff={[...(financialStaff.data ?? [])]}
        entitled={financialEntitled}
        // A failed permission lookup used to render as an empty list, which is
        // indistinguishable from "this clinic has no managers" — an admin would
        // reasonably conclude there was nobody to grant.
        loadError={financialStaff.error ?? null}
      />
    </div>
  );
}
