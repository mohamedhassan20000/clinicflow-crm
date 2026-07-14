import { notFound } from "next/navigation";
import { ClinicSignupForm } from "@/components/auth/clinic-signup-form";
import { createClient } from "@/lib/supabase/server";
import { getTranslations } from "next-intl/server";

export default async function OpenSignupPage() {
  const t = await getTranslations("public");
  const supabase = await createClient();
  const { data } = await supabase.rpc("validate_clinic_signup", {});
  if (!data?.[0]?.allowed) notFound();
  return <section className="rounded-2xl border bg-card p-6 sm:p-8"><h1 className="mb-6 text-2xl font-bold">{t("createYourClinic")}</h1><ClinicSignupForm defaults={{}} /></section>;
}
