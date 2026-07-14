import { notFound } from "next/navigation";
import { ClinicSignupForm } from "@/components/auth/clinic-signup-form";
import { createClient } from "@/lib/supabase/server";
import { hashInvitationToken } from "@/lib/signup";
import { getTranslations } from "next-intl/server";

export default async function InvitedSignupPage({ params }: { params: Promise<{ token: string }> }) {
  const t = await getTranslations("public");
  const { token } = await params;
  const supabase = await createClient();
  const { data } = await supabase.rpc("validate_clinic_signup", { p_token_hash: hashInvitationToken(token) });
  const invitation = data?.[0];
  if (!invitation?.allowed) notFound();
  return <section className="rounded-2xl border bg-card p-6 sm:p-8"><h1 className="mb-2 text-2xl font-bold">{t("welcomeToClinicflow")}</h1><p className="mb-6 text-sm text-muted-foreground">{t("completeYourOwnerAccountToAccept")}</p><ClinicSignupForm defaults={{ token, clinicName: invitation.clinic_name ?? '', ownerName: invitation.owner_name ?? '', email: invitation.email ?? '' }} /></section>;
}
