import { Mail } from "lucide-react";
import { createClinicInvitation } from "@/actions/early-access";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TableEmptyState } from "@/components/shared/data-table";
import { issueInvitationForm, revokeInvitationForm } from "@/actions/operator";
import { OperatorActionForm } from "@/components/operator/operator-action-form";
import { InvitationStatusBadge } from "@/components/operator/invitation-status-badge";
import { InternationalPhoneField } from "@/components/shared/international-phone-input";
import { createClient } from "@/lib/supabase/server";
import { getTranslations } from "next-intl/server";

export default async function OperatorInvitationsPage() {
  const t = await getTranslations("operator");
  const supabase = await createClient();
  // The open-invitation total is an exact count query, not a filter over the
  // bounded 200-row list, so the quota banner matches the issuance guard.
  const [status, invitations, openInvitations] = await Promise.all([
    supabase.rpc("get_public_registration_status"),
    supabase
      .from("clinic_invitations")
      .select("id, clinic_name, owner_name, email, phone, status, token_hash, expires_at, created_at, accepted_at, email_sent_at")
      .order("created_at", { ascending: false })
      .limit(200),
    supabase
      .from("clinic_invitations")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending")
      .not("token_hash", "is", null)
      .gt("expires_at", new Date().toISOString()),
  ]);
  const registration = status.data?.[0];
  const rows = invitations.data ?? [];
  const openCount = openInvitations.count ?? 0;
  const projected = Number(registration?.accepted_clinics_this_week ?? 0) + openCount;
  const limit = registration?.weekly_invite_limit ?? 0;

  return (
    <>
      <header>
        <h1 className="text-3xl font-bold tracking-tight">{t("invitations")}</h1>
        <p className="mt-1 text-muted-foreground">
          {registration?.accepted_clinics_this_week ?? 0} {t("acceptedThisWeek")}{openCount} {t("openInvitationsLimit")}{limit}.
        </p>
        {projected >= limit ? (
          <p className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm dark:border-amber-700 dark:bg-amber-950">
            {t("conservativeProjection")}{projected}{"): accepted this week plus all open invitations, whichever week they were issued in — not an exact weekly total. New issuance is soft-blocked unless you tick the override; acceptance is never blocked and issued invitations always stay redeemable (§3.2)."}</p>
        ) : null}
      </header>

      <section className="rounded-xl border bg-card p-5">
        <h2 className="font-semibold">{t("createInvitation")}</h2>
        <OperatorActionForm action={createClinicInvitation} submitLabel={t("createAndIssue")}>
          <div className="grid gap-3 sm:grid-cols-2">
            <input name="clinicName" placeholder={t("clinicName")} required className="rounded-md border bg-background px-2 py-1 text-sm" />
            <input name="ownerName" placeholder={t("ownerName")} required className="rounded-md border bg-background px-2 py-1 text-sm" />
            <InternationalPhoneField name="phone" required />
            <input name="email" type="email" placeholder={t("ownerExampleCom")} required className="rounded-md border bg-background px-2 py-1 text-sm" />
          </div>
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <input type="checkbox" name="force" value="true" /> {t("overrideTheWeeklyLimit")}</label>
        </OperatorActionForm>
      </section>

      <section className="overflow-hidden rounded-xl border bg-card">
        {rows.length === 0 ? (
          <TableEmptyState
            icon={Mail}
            title={t("noInvitationsYet")}
            description={t("earlyAccessRequestsAndInvitationsYou")}
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                {[t("clinic"), t("owner"), t("email"), t("status"), t("expires"), t("actions")].map((heading) => (
                  <TableHead key={heading}>{heading}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id} className="align-top">
                  <TableCell className="font-medium">{row.clinic_name}</TableCell>
                  <TableCell>{row.owner_name}</TableCell>
                  <TableCell>{row.email}</TableCell>
                  <TableCell>
                    <InvitationStatusBadge status={row.status} hasToken={Boolean(row.token_hash)} />
                    {row.accepted_at ? <span className="ms-2 text-xs text-muted-foreground">{row.accepted_at.slice(0, 10)}</span> : null}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{row.expires_at ? row.expires_at.slice(0, 10) : "—"}{row.email_sent_at ? <span className="mt-1 block text-xs text-emerald-700">{t("emailSent")}{row.email_sent_at.slice(0, 10)}</span> : null}</TableCell>
                  <TableCell>
                    {row.status === "pending" ? (
                      <div className="flex flex-wrap items-start gap-3">
                        <OperatorActionForm
                          action={issueInvitationForm}
                          submitLabel={row.token_hash ? t("resendRotateToken") : t("issue")}
                          submitVariant="outline"
                          className="space-y-2"
                        >
                          <input type="hidden" name="invitationId" value={row.id} />
                          <label className="flex items-center gap-1 text-xs text-muted-foreground">
                            <input type="checkbox" name="force" value="true" /> {t("overrideLimit")}</label>
                        </OperatorActionForm>
                        <OperatorActionForm action={revokeInvitationForm} submitLabel={t("revoke")} submitVariant="destructive" className="space-y-2">
                          <input type="hidden" name="invitationId" value={row.id} />
                        </OperatorActionForm>
                      </div>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
    </>
  );
}
