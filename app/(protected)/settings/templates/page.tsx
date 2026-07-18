import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { MessageTemplatesManager, type TemplateListItem } from "@/components/settings/message-templates-manager";
import { getEntitlements, hasFeature } from "@/lib/entitlements";
import { requireRole } from "@/lib/rbac";
import { createClinicScopedAdminClient } from "@/lib/supabase/admin";

export async function generateMetadata(): Promise<Metadata> {
  const metadataT = await getTranslations("protected");
  return { title: metadataT("metadataMessageTemplates") };
}

export default async function TemplatesSettingsPage() {
  const settingsT = await getTranslations("settings");
  const user = await requireRole(["admin", "manager"]);

  // The settings surface is Admin/Manager while the message_templates read
  // policy is the inbox's Admin/Receptionist, so this page reads through the
  // clinic-scoped service-role boundary (the /settings/messaging precedent).
  const client = createClinicScopedAdminClient(user.clinicId);
  const [templates, entitlements] = await Promise.all([
    client
      .from("message_templates")
      .select(
        "id, channel, name, language, body, variables, approval_status, provider_template_id, updated_at",
      )
      .order("updated_at", { ascending: false }),
    getEntitlements(user.clinicId),
  ]);

  const items: TemplateListItem[] = (templates.data ?? []).map((row) => ({
    id: row.id,
    channel: row.channel,
    name: row.name,
    language: row.language as "ar" | "en",
    body: row.body,
    variables: Array.isArray(row.variables)
      ? row.variables.filter((value): value is string => typeof value === "string")
      : [],
    approvalStatus: row.approval_status,
    updatedAt: row.updated_at,
  }));

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-semibold">{settingsT("templatesTitle")}</h2>
        <p className="text-sm text-muted-foreground">
          {settingsT("templatesDescription")}
        </p>
      </div>
      <MessageTemplatesManager
        templates={items}
        whatsappEntitled={hasFeature(entitlements, "whatsapp")}
      />
    </div>
  );
}
