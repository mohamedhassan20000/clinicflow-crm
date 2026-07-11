import { updatePlatformSettings } from "@/actions/operator";
import { OperatorActionForm } from "@/components/operator/operator-action-form";
import { createClient } from "@/lib/supabase/server";

export default async function OperatorSettingsPage() {
  const supabase = await createClient();
  const { data: settings } = await supabase
    .from("platform_settings")
    .select("registration_mode, weekly_invite_limit, invitation_expiry_days, updated_at")
    .eq("id", true)
    .single();

  return (
    <>
      <header>
        <h1 className="text-3xl font-bold tracking-tight">Platform settings</h1>
        <p className="mt-1 text-muted-foreground">
          Changes apply to the public registration flow immediately — no deploy required (§3.2).
        </p>
      </header>

      <section className="max-w-lg rounded-xl border bg-card p-5">
        <OperatorActionForm action={updatePlatformSettings} submitLabel="Save settings">
          <label className="block text-sm">
            Registration mode
            <select
              name="registrationMode"
              defaultValue={settings?.registration_mode ?? "invite_only"}
              className="mt-1 block w-full rounded-md border bg-background px-2 py-1"
            >
              <option value="invite_only">invite only</option>
              <option value="open">open</option>
            </select>
          </label>
          <label className="block text-sm">
            Weekly invite limit
            <input
              name="weeklyInviteLimit"
              type="number"
              min={1}
              max={1000}
              defaultValue={settings?.weekly_invite_limit ?? 20}
              className="mt-1 block w-full rounded-md border bg-background px-2 py-1"
            />
          </label>
          <label className="block text-sm">
            Invitation expiry (days)
            <input
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
          Last updated {settings?.updated_at ? settings.updated_at.slice(0, 16).replace("T", " ") : "—"} UTC.
        </p>
      </section>
    </>
  );
}
