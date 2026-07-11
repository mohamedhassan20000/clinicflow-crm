import { notFound } from "next/navigation";
import {
  cancelManualSubscription,
  grantManualSubscription,
  removeFeatureOverride,
  upsertFeatureOverride,
} from "@/actions/operator";
import { OperatorActionForm } from "@/components/operator/operator-action-form";
import { resolveSubscriptionAccess } from "@/lib/billing/access";
import { getOperatorClinic } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export default async function OperatorClinicPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const [clinicLookup, subscription, overrides, usage, plans] = await Promise.all([
    getOperatorClinic(id),
    supabase
      .from("subscriptions")
      .select("status, trial_ends_at, current_period_start, current_period_end, provider, plans(slug)")
      .eq("clinic_id", id)
      .maybeSingle(),
    supabase.from("clinic_feature_overrides").select("feature_key, enabled").eq("clinic_id", id).order("feature_key"),
    supabase.from("usage_counters").select("period_start, metric, used, limit_snapshot").eq("clinic_id", id).order("period_start", { ascending: false }).limit(12),
    supabase.from("plans").select("slug, name_en").eq("is_active", true).order("slug"),
  ]);

  const clinic = clinicLookup.data;
  if (!clinic) notFound();
  const access = resolveSubscriptionAccess(subscription.data ?? null);

  return (
    <>
      <header>
        <h1 className="text-3xl font-bold tracking-tight">{clinic.name}</h1>
        <p className="mt-1 text-muted-foreground">
          {clinic.country} · {clinic.timezone} · created {clinic.created_at.slice(0, 10)} · onboarding{" "}
          {clinic.onboarding_completed_at ? "complete" : "incomplete"}
        </p>
      </header>

      <section className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-xl border bg-card p-5">
          <h2 className="font-semibold">Subscription</h2>
          <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
            <dt className="text-muted-foreground">Plan</dt>
            <dd>{subscription.data?.plans?.slug ?? "—"}</dd>
            <dt className="text-muted-foreground">Status</dt>
            <dd>{subscription.data?.status ?? "missing"} ({access.reason.replaceAll("_", " ")})</dd>
            <dt className="text-muted-foreground">Trial ends</dt>
            <dd>{subscription.data?.trial_ends_at?.slice(0, 10) ?? "—"}</dd>
            <dt className="text-muted-foreground">Period end</dt>
            <dd>
              {subscription.data?.current_period_end?.slice(0, 10) ??
                (subscription.data?.status === "active" ? "unbounded" : "—")}
            </dd>
          </dl>

          <div className="mt-5 border-t pt-4">
            <h3 className="mb-3 text-sm font-medium">Manual grant (extends a live period)</h3>
            <OperatorActionForm action={grantManualSubscription} submitLabel="Grant subscription">
              <input type="hidden" name="clinicId" value={id} />
              <div className="flex flex-wrap gap-3">
                <label className="text-sm">
                  Plan{" "}
                  <select name="planSlug" className="rounded-md border bg-background px-2 py-1" defaultValue="basic">
                    {(plans.data ?? []).map((plan) => (
                      <option key={plan.slug} value={plan.slug}>{plan.slug}</option>
                    ))}
                  </select>
                </label>
                <label className="text-sm">
                  Duration{" "}
                  <select name="months" className="rounded-md border bg-background px-2 py-1" defaultValue="1">
                    {[1, 3, 6, 12, 24].map((months) => (
                      <option key={months} value={months}>{months} months</option>
                    ))}
                    <option value="unbounded">unbounded</option>
                  </select>
                </label>
              </div>
            </OperatorActionForm>
            <div className="mt-4">
              <OperatorActionForm action={cancelManualSubscription} submitLabel="Cancel subscription now" submitVariant="destructive">
                <input type="hidden" name="clinicId" value={id} />
              </OperatorActionForm>
            </div>
          </div>
        </div>

        <div className="rounded-xl border bg-card p-5">
          <h2 className="font-semibold">Feature overrides</h2>
          <ul className="mt-3 space-y-2 text-sm">
            {(overrides.data ?? []).length === 0 ? <li className="text-muted-foreground">No overrides — plan defaults apply.</li> : null}
            {(overrides.data ?? []).map((override) => (
              <li key={override.feature_key} className="flex items-center justify-between gap-3">
                <span>
                  <code>{override.feature_key}</code> → {override.enabled ? "enabled" : "disabled"}
                </span>
                <OperatorActionForm action={removeFeatureOverride} submitLabel="Remove" submitVariant="outline" className="space-y-1">
                  <input type="hidden" name="clinicId" value={id} />
                  <input type="hidden" name="featureKey" value={override.feature_key} />
                </OperatorActionForm>
              </li>
            ))}
          </ul>
          <div className="mt-5 border-t pt-4">
            <h3 className="mb-3 text-sm font-medium">Set override</h3>
            <OperatorActionForm action={upsertFeatureOverride} submitLabel="Save override">
              <input type="hidden" name="clinicId" value={id} />
              <div className="flex flex-wrap gap-3">
                <input
                  name="featureKey"
                  placeholder="ai_assistant"
                  className="rounded-md border bg-background px-2 py-1 text-sm"
                  required
                />
                <select name="enabled" className="rounded-md border bg-background px-2 py-1 text-sm" defaultValue="true">
                  <option value="true">enabled</option>
                  <option value="false">disabled</option>
                </select>
              </div>
            </OperatorActionForm>
          </div>
        </div>
      </section>

      <section className="rounded-xl border bg-card p-5">
        <h2 className="font-semibold">Usage counters</h2>
        <ul className="mt-3 space-y-2 text-sm">
          {(usage.data ?? []).length === 0 ? <li className="text-muted-foreground">No usage recorded.</li> : null}
          {(usage.data ?? []).map((row) => (
            <li key={`${row.period_start}-${row.metric}`} className="flex justify-between gap-3">
              <span>{row.period_start} · {row.metric}</span>
              <span className="tabular-nums text-muted-foreground">{row.used} / {row.limit_snapshot}</span>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
