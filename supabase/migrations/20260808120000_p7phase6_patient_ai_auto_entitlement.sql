-- P7 Manual QA polish Phase 6: enable automatic patient replies for the
-- designated Pro + AI testing clinic.
--
-- Entitlement resolution and runtime enforcement already fail closed and are
-- intentionally unchanged: AI features still require an active `pro_ai`
-- subscription, the `ai_assistant` umbrella, and the individual feature flag.
-- Keep the canonical plan default disabled and use the existing clinic-scoped
-- operator override so no other Pro + AI clinic is changed by this QA fixture.

update public.plans
set features = coalesce(features, '{}'::jsonb) || jsonb_build_object(
      'ai.patient_auto', false
    ),
    updated_at = clock_timestamp()
where slug = 'pro_ai'
  and coalesce((features ->> 'ai.patient_auto')::boolean, false) is distinct from false;

insert into public.clinic_feature_overrides (
  clinic_id,
  feature_key,
  enabled,
  updated_at
)
select
  subscription.clinic_id,
  'ai.patient_auto',
  true,
  clock_timestamp()
from public.subscriptions as subscription
join public.plans as plan on plan.id = subscription.plan_id
where subscription.clinic_id = 'caf2711f-97cb-4474-a103-f9505f467087'::uuid
  and plan.slug = 'pro_ai'
  and subscription.status in ('active', 'trialing')
on conflict (clinic_id, feature_key) do update
set enabled = excluded.enabled,
    updated_at = excluded.updated_at;
