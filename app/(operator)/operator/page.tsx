import Link from "next/link";
import { listOperatorClinics, listOrphanedSignupUsers } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums">{value}</p>
      {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export default async function MissionControlPage() {
  const supabase = await createClient();
  const now = new Date();
  const nowIso = now.toISOString();
  const inSevenDays = new Date(now.getTime() + 7 * 86_400_000).toISOString();
  const monthStart = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;

  // Headline totals are exact count queries: row arrays are capped by
  // PostgREST max_rows, so counting fetched rows would silently plateau.
  const [
    status,
    subscriptionsTotal,
    subscriptionsActive,
    trialsActive,
    expiringTrials,
    pendingRequestCount,
    openInvitationCount,
    recentInvitations,
    couponsTotal,
    couponsActive,
    overridesCount,
    usage,
    clinics,
    orphanLookup,
  ] = await Promise.all([
    supabase.rpc("get_public_registration_status"),
    supabase.from("subscriptions").select("id", { count: "exact", head: true }),
    supabase
      .from("subscriptions")
      .select("id", { count: "exact", head: true })
      .eq("status", "active")
      .or(`current_period_end.is.null,current_period_end.gt.${nowIso}`),
    supabase
      .from("subscriptions")
      .select("id", { count: "exact", head: true })
      .eq("status", "trialing")
      .gt("trial_ends_at", nowIso),
    supabase
      .from("subscriptions")
      .select("clinic_id, trial_ends_at")
      .eq("status", "trialing")
      .gt("trial_ends_at", nowIso)
      .lte("trial_ends_at", inSevenDays)
      .order("trial_ends_at")
      .limit(50),
    supabase
      .from("clinic_invitations")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending")
      .is("token_hash", null),
    supabase
      .from("clinic_invitations")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending")
      .not("token_hash", "is", null),
    supabase
      .from("clinic_invitations")
      .select("id, clinic_name, email, status")
      .order("updated_at", { ascending: false })
      .limit(8),
    supabase.from("coupons").select("id", { count: "exact", head: true }),
    supabase.from("coupons").select("id", { count: "exact", head: true }).eq("is_active", true),
    supabase.from("clinic_feature_overrides").select("clinic_id", { count: "exact", head: true }),
    supabase
      .from("usage_counters")
      .select("clinic_id, metric, used, limit_snapshot")
      .eq("period_start", monthStart)
      .order("used", { ascending: false })
      .limit(10),
    listOperatorClinics(),
    listOrphanedSignupUsers(),
  ]);

  const clinicNames = new Map((clinics.data ?? []).map((clinic) => [clinic.id, clinic.name]));
  const activeCount = subscriptionsActive.count ?? 0;
  const trialCount = trialsActive.count ?? 0;
  const lockedCount = Math.max(0, (subscriptionsTotal.count ?? 0) - activeCount - trialCount);
  const registration = status.data?.[0];
  const orphans = orphanLookup.data?.orphans ?? [];
  const orphansTruncated = orphanLookup.data?.truncated ?? false;

  return (
    <>
      <header>
        <h1 className="text-3xl font-bold tracking-tight">Mission Control</h1>
        <p className="mt-1 text-muted-foreground">
          Platform state at a glance — tenant clinical data is never shown here.
        </p>
      </header>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Clinics" value={clinics.count ?? 0} />
        <Stat label="Active subscriptions" value={activeCount} />
        <Stat label="Active trials" value={trialCount} hint={`${(expiringTrials.data ?? []).length} expiring within 7 days`} />
        <Stat label="Locked / expired" value={lockedCount} />
        <Stat
          label="Accepted this week"
          value={`${registration?.accepted_clinics_this_week ?? 0} / ${registration?.weekly_invite_limit ?? "—"}`}
          hint={`Registration mode: ${registration?.registration_mode ?? "unknown"}`}
        />
        <Stat label="Pending requests" value={pendingRequestCount.count ?? 0} hint={`${openInvitationCount.count ?? 0} open invitations`} />
        <Stat label="Coupons" value={couponsActive.count ?? 0} hint={`${couponsTotal.count ?? 0} total`} />
        <Stat label="Feature overrides" value={overridesCount.count ?? 0} />
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-xl border bg-card p-5">
          <h2 className="font-semibold">Trials expiring within 7 days</h2>
          <ul className="mt-3 space-y-2 text-sm">
            {(expiringTrials.data ?? []).length === 0 ? <li className="text-muted-foreground">None.</li> : null}
            {(expiringTrials.data ?? []).map((row) => (
              <li key={row.clinic_id} className="flex justify-between gap-3">
                <Link href={`/operator/clinics/${row.clinic_id}`} className="underline-offset-2 hover:underline">
                  {clinicNames.get(row.clinic_id) ?? row.clinic_id}
                </Link>
                <span className="text-muted-foreground">ends {row.trial_ends_at?.slice(0, 10)}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="rounded-xl border bg-card p-5">
          <h2 className="font-semibold">Top usage this month</h2>
          <ul className="mt-3 space-y-2 text-sm">
            {(usage.data ?? []).length === 0 ? <li className="text-muted-foreground">No usage recorded.</li> : null}
            {(usage.data ?? []).map((row) => (
              <li key={`${row.clinic_id}-${row.metric}`} className="flex justify-between gap-3">
                <span>
                  {clinicNames.get(row.clinic_id) ?? row.clinic_id} · {row.metric}
                </span>
                <span className="tabular-nums text-muted-foreground">
                  {row.used} / {row.limit_snapshot}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className="rounded-xl border bg-card p-5">
          <h2 className="font-semibold">Recent invitation activity</h2>
          <ul className="mt-3 space-y-2 text-sm">
            {(recentInvitations.data ?? []).map((row) => (
              <li key={row.id} className="flex justify-between gap-3">
                <span>
                  {row.clinic_name} <span className="text-muted-foreground">({row.email})</span>
                </span>
                <span className="text-muted-foreground">{row.status}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="rounded-xl border bg-card p-5">
          <h2 className="font-semibold">Orphaned signup accounts</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Clinic-owner signups whose Auth user exists but has no profile (compensation backstop).
          </p>
          <ul className="mt-3 space-y-2 text-sm">
            {orphanLookup.error ? <li className="text-destructive">Lookup failed.</li> : null}
            {orphansTruncated ? (
              <li className="rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-xs dark:border-amber-700 dark:bg-amber-950">
                Warning: the Auth directory scan hit its safety bound — this list may be incomplete.
              </li>
            ) : null}
            {!orphanLookup.error && orphans.length === 0 ? <li className="text-muted-foreground">None.</li> : null}
            {orphans.map((orphan) => (
              <li key={orphan.id} className="flex justify-between gap-3">
                <span>{orphan.email ?? orphan.id}</span>
                <span className="text-muted-foreground">since {orphan.created_at.slice(0, 10)}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-xl border border-dashed bg-card/50 p-5 text-sm text-muted-foreground">
          <h2 className="font-semibold text-foreground">Delivery health</h2>
          <p className="mt-2">Message delivery rates, job failures, and webhook errors arrive with the P3 messaging layer.</p>
        </div>
        <div className="rounded-xl border border-dashed bg-card/50 p-5 text-sm text-muted-foreground">
          <h2 className="font-semibold text-foreground">Error summaries</h2>
          <p className="mt-2">Platform errors are captured in Sentry; open the Sentry project dashboard for triage.</p>
        </div>
      </section>
    </>
  );
}
