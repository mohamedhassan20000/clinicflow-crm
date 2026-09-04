-- Pro + AI is the superset AI plan.
--
-- Phase 0b decoupled AI entitlement from the plan slug and moved every decision
-- into `public.effective_ai_feature`. That was right, but the catalog it read
-- from had drifted: the Pro + AI row still withheld `ai.patient_auto`,
-- `ai.hybrid_fallback` and `ai.followup_generation`, and any AI capability key
-- introduced after the row was last edited resolved false for the highest plan
-- in the product. The visible result was a paid Pro + AI clinic failing
-- AI_FEATURE_NOT_ENTITLED / AI_PROVIDER_MODE_NOT_ENTITLED on capabilities it had
-- bought, and role, financial-grant and validation errors becoming unreachable
-- because entitlement failed ahead of them.
--
-- The rule this migration installs: a plan may declare itself an AI superset
-- (`features -> 'ai.superset'`), and on such a plan every supported AI feature
-- key is entitled. The resolver stays plan-slug free — the marker lives in the
-- catalog, the logic lives in the one resolver — and every other gate is
-- untouched: an inactive subscription, an unaccepted AI terms row, or an
-- explicit per-clinic `ai_assistant`/feature override still revokes, and role,
-- financial permission, tenant isolation, consent and budget checks continue to
-- run downstream on their own.

-- ---------------------------------------------------------------------------
-- 1. Catalog: mark the umbrella-granting plan as the superset and spell out
--    every AI capability it sells, so callers that read plan features directly
--    (the TypeScript resolver among them) agree with SQL without inference.
-- ---------------------------------------------------------------------------

update public.plans
set features = coalesce(features, '{}'::jsonb)
      || jsonb_build_object('ai.superset', true)
      || (
        select jsonb_object_agg(feature_key, true)
        from unnest(array[
          'ai.staff_assistant',
          'ai.patient_suggest',
          'ai.patient_auto',
          'ai.managed',
          'ai.byok',
          'ai.hybrid_fallback',
          'ai.staff_analytics',
          'ai.financial_insights',
          'ai.assistant_customization',
          'ai.workflows',
          'ai.followup_generation',
          'ai.scheduling',
          'ai.read_operational',
          'ai.read_clinical',
          'ai.read_financial',
          'ai.write_scheduling',
          'ai.write_records',
          'ai.write_administration',
          'ai.write_privileged',
          'ai.documents',
          'ai.bulk_export'
        ]) as feature_key
      ),
    updated_at = clock_timestamp()
where slug = 'pro_ai';

comment on column public.plans.features is
  'Per-plan feature flags. `ai_assistant` is the AI umbrella; `ai.superset` '
  'marks a plan that sells every supported AI capability, which '
  'public.effective_ai_feature honours for AI keys the row does not list.';

-- ---------------------------------------------------------------------------
-- 2. The canonical resolver. Same four inputs as Phase 0b — subscription
--    access, terms acceptance, umbrella, per-feature grant — with the superset
--    marker resolved inside the per-feature step and nowhere else.
--
--    Precedence for the per-feature step, unchanged in spirit and mirrored
--    verbatim by lib/ai/commercial-policy.ts:
--      1. an explicit clinic override wins in both directions;
--      2. otherwise the plan's own value for the key wins when it is true;
--      3. otherwise a superset plan grants the key, unless the effective value
--         is explicitly false.
-- ---------------------------------------------------------------------------

create or replace function public.effective_ai_feature(
  p_clinic_id uuid,
  p_feature_key text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.subscriptions as subscription
    join public.plans as plan on plan.id = subscription.plan_id
    join public.ai_commercial_terms as terms
      on terms.clinic_id = subscription.clinic_id
     and terms.accepted_at is not null
    left join public.clinic_feature_overrides as umbrella_override
      on umbrella_override.clinic_id = subscription.clinic_id
     and umbrella_override.feature_key = 'ai_assistant'
    left join public.clinic_feature_overrides as feature_override
      on feature_override.clinic_id = subscription.clinic_id
     and feature_override.feature_key = p_feature_key
    where subscription.clinic_id = p_clinic_id
      and plan.is_active
      and (
        (
          subscription.status = 'trialing'
          and subscription.trial_ends_at > clock_timestamp()
        )
        or (
          subscription.status = 'active'
          and (
            subscription.current_period_end is null
            or subscription.current_period_end > clock_timestamp()
          )
        )
      )
      and coalesce(
        umbrella_override.enabled,
        plan.features -> 'ai_assistant' = 'true'::jsonb,
        false
      )
      and (
        p_feature_key = 'ai_assistant'
        or coalesce(
             pg_catalog.to_jsonb(feature_override.enabled),
             plan.features -> p_feature_key
           ) = 'true'::jsonb
        or (
          plan.features -> 'ai.superset' = 'true'::jsonb
          and coalesce(
                pg_catalog.to_jsonb(feature_override.enabled),
                plan.features -> p_feature_key
              ) is distinct from 'false'::jsonb
        )
      )
  );
$$;

comment on function public.effective_ai_feature(uuid, text) is
  'Canonical AI entitlement resolver: active subscription + accepted AI terms + '
  'the ai_assistant umbrella + a per-feature grant, where a plan carrying '
  'ai.superset grants every supported AI capability. Plan/user separation is '
  'deliberate: this answers only "did the clinic buy it", never "may this user '
  'do it".';

revoke all on function public.effective_ai_feature(uuid, text)
  from public, anon, authenticated;
grant execute on function public.effective_ai_feature(uuid, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- 3. The retired workflow-run ledger keeps its server-authority writes.
--
--    Phase 4 revoked INSERT/UPDATE/DELETE from service_role to stop new rows
--    being produced. Removing the grant does not remove a producer — the
--    producer had already been deleted — it removes the tenant's own server
--    from its audit ledger: backfills, retention scrubs and the RLS regression
--    suite all fail with "permission denied for table ai_workflow_runs".
--
--    The security boundary that matters here is RLS and the `authenticated`
--    grant, and both stay exactly as P4.11A wrote them: authenticated callers
--    hold SELECT only, and `ai_workflow_runs_owner_read` keeps every row scoped
--    to its own clinic and its own user. service_role is the trusted server
--    boundary and holds write access on every other tenant table.
-- ---------------------------------------------------------------------------

grant insert, update, delete on table public.ai_workflow_runs to service_role;

comment on table public.ai_workflow_runs is
  'Retired after Phase 4: no runtime producer creates new rows — ai_action_receipts '
  'carries every action attempt. Retained as a content-free, owner-scoped audit '
  'ledger with appointment provenance; server-role writes remain available for '
  'retention and backfill work.';
