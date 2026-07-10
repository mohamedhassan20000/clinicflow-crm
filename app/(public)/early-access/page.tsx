import Link from "next/link";
import { EarlyAccessForm } from "@/components/auth/early-access-form";
import { createClient } from "@/lib/supabase/server";

export default async function EarlyAccessPage() {
  const supabase = await createClient();
  const { data } = await supabase.rpc("get_public_registration_status");
  const status = data?.[0];
  const limit = status?.weekly_invite_limit ?? 20;
  const accepted = Number(status?.accepted_clinics_this_week ?? 0);
  const percentage = Math.min(100, Math.round((accepted / limit) * 100));
  return <section className="rounded-2xl border bg-card p-6 shadow-sm sm:p-8">
    <h1 className="text-3xl font-bold tracking-tight">Early access for thoughtful clinics</h1>
    <p className="mt-3 text-muted-foreground">We currently accept only {limit} clinics per week to ensure the highest quality onboarding.</p>
    <div className="my-6 space-y-2"><div className="flex justify-between text-sm"><span>{accepted} of {limit} spots taken this week</span><span>{percentage}%</span></div><div className="h-2 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary" style={{ width: `${percentage}%` }} /></div></div>
    {status?.registration_mode === 'open' ? <div className="space-y-4 text-center"><p>Registration is currently open.</p><Link className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground" href="/signup">Create your clinic</Link></div> : <EarlyAccessForm />}
    <p className="mt-6 text-center text-sm text-muted-foreground">Already invited? Open the private link in your invitation email.</p>
  </section>;
}

