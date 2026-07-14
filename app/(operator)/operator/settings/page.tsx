import { updatePlatformSettings } from "@/actions/operator";
import { OperatorActionForm } from "@/components/operator/operator-action-form";
import { createClient } from "@/lib/supabase/server";
import { getTranslations } from "next-intl/server";

export default async function OperatorSettingsPage() {
  const t = await getTranslations("operator");
  const supabase = await createClient();
  const { data: settings } = await supabase
    .from("platform_settings")
    .select("registration_mode, weekly_invite_limit, invitation_expiry_days, updated_at")
    .eq("id", true)
    .single();

  return (
    <>
      <header>
        <h1 className="text-3xl font-bold tracking-tight">{t("platformSettings")}</h1>
        <p className="mt-1 text-muted-foreground">
          {t("changesApplyToThePublicRegistration")}</p>
      </header>

      <section className="max-w-lg rounded-xl border bg-card p-5">
        <OperatorActionForm action={updatePlatformSettings} submitLabel={t("saveSettings")}>
          <label className="block text-sm">
            {t("registrationMode")}<select
              name="registrationMode"
              defaultValue={settings?.registration_mode ?? "invite_only"}
              className="mt-1 block w-full rounded-md border bg-background px-2 py-1"
            >
              <option value="invite_only">{t("inviteOnly")}</option>
              <option value="open">{t("open")}</option>
            </select>
          </label>
          <label className="block text-sm">
            {t("weeklyInviteLimit")}<input
              name="weeklyInviteLimit"
              type="number"
              min={1}
              max={1000}
              defaultValue={settings?.weekly_invite_limit ?? 20}
              className="mt-1 block w-full rounded-md border bg-background px-2 py-1"
            />
          </label>
          <label className="block text-sm">
            {t("invitationExpiryDays")}<input
              name="invitationExpiryDays"
              type="number"
              min={1}
              max={90}
              defaultValue={settings?.invitation_expiry_days ?? 7}
              className="mt-1 block w-full rounded-md border bg-background px-2 py-1"
            />
          </label>
        </OperatorActionForm>
        <p className="mt-4 text-xs text-muted-foreground">
          {t("lastUpdated")}{settings?.updated_at ? settings.updated_at.slice(0, 16).replace("T", " ") : "—"} {t("utc")}</p>
      </section>
    </>
  );
}
