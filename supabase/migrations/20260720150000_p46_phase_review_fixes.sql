-- P4.6 phase-review fixes — database-boundary authorization for the analytics RPCs
--
-- Closes M1 and M2 of docs/reviews/P4.6_PHASE_REVIEW.md.
--
-- Context. Supabase exposes every function in `public` over PostgREST, and the
-- P4.6A aggregate RPCs are `grant execute … to authenticated`. This is not a
-- theoretical reachability argument: the P4.6A integration suite already calls
-- `ai_get_clinic_summary` and `ai_get_patient_stats` straight over PostgREST
-- with an ordinary signed-in user's token and gets data back. So any
-- authenticated clinic user could reach them directly, bypassing the
-- application entirely — and `ai_assert_analytics_caller` checked *role only*.
--
-- Two things the application knew and the database did not:
--
--   M1 — the per-user financial grant. A manager whose `user_ai_permissions`
--        row is off was refused by `assertFinancialInsightsAccess` in the tool
--        layer, and by nothing at all in `POST /rest/v1/rpc/ai_get_revenue_
--        summary`.
--   M2 — the `ai.staff_analytics` / `ai.financial_insights` entitlements. The
--        phase is specified as `pro_ai`-only, but a `basic` or `pro` clinic's
--        admin could call every analytics RPC and receive clinic-wide aggregate
--        distributions — including the blood-type distribution, the one payload
--        here with a privacy class of its own.
--
-- Neither was a data *leak*: RLS on the underlying tables already admits these
-- same roles to the same rows, so the figures were computable from raw rows by
-- the same user. That is why the review rated them Medium. But the argument
-- "the permission is application-layer because RLS cannot express it" justifies
-- not putting it in RLS; it does not justify leaving a brand-new SECURITY
-- DEFINER aggregation endpoint reachable without it, when the guard function is
-- already the natural place to consult a grant table that now exists. Both gaps
-- are one RLS change away from mattering.
--
-- The guard is the single place all five RPCs pass through, so both checks land
-- there and no call site can forget them.

-- ---------------------------------------------------------------------------
-- 1. Entitlement + grant enforcement in the shared analytics guard
-- ---------------------------------------------------------------------------

create or replace function public.ai_assert_analytics_caller(
  p_scope text default 'operational'
)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_clinic_id uuid := public.auth_clinic_id();
  v_role public.user_role := public.auth_role();
begin
  if p_scope not in ('operational', 'clinic_analytics', 'financial') then
    raise exception 'Unsupported analytics scope' using errcode = '22023';
  end if;

  if auth.uid() is null or v_clinic_id is null or v_role is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  -- Role matrix (unchanged). Doctors keep their own self-scoped P4 tools and
  -- are refused every scope; receptionists may run the bounded operational
  -- lists but not the clinic-wide distributions or anything financial.
  if v_role = 'doctor'::public.user_role then
    raise exception 'Not authorized for clinic analytics' using errcode = '42501';
  end if;

  if p_scope = 'clinic_analytics' and v_role = 'receptionist'::public.user_role then
    raise exception 'Not authorized for clinic analytics' using errcode = '42501';
  end if;

  if p_scope = 'financial' and v_role = 'receptionist'::public.user_role then
    raise exception 'Not authorized for financial analytics' using errcode = '42501';
  end if;

  -- M2 — plan entitlement. `effective_ai_feature` is the same authoritative
  -- resolution the application reads (plan features, then clinic overrides,
  -- then subscription/trial state), so the two layers cannot disagree about
  -- what a clinic is entitled to. It is internal-only (revoked from every
  -- role), which is exactly why it must be called from a DEFINER function.
  if not coalesce(
    public.effective_ai_feature(v_clinic_id, 'ai.staff_analytics'), false
  ) then
    raise exception 'AI analytics not entitled for this clinic' using errcode = '42501';
  end if;

  if p_scope = 'financial' then
    if not coalesce(
      public.effective_ai_feature(v_clinic_id, 'ai.financial_insights'), false
    ) then
      raise exception 'Financial AI not entitled for this clinic' using errcode = '42501';
    end if;

    -- M1 — the per-user grant. Admins hold it implicitly (they administer
    -- billing and every financial page already, so requiring an explicit row
    -- would be a control that means nothing); managers must have an explicit
    -- granted row scoped to this clinic. This mirrors
    -- `IMPLICIT_PERMISSION_ROLES` and `hasAiUserPermission` in
    -- lib/ai/permissions.ts, including its fail-closed behavior: no row means
    -- no grant.
    if v_role <> 'admin'::public.user_role
       and not exists (
         select 1
         from public.user_ai_permissions as grant_row
         where grant_row.user_id = auth.uid()
           and grant_row.clinic_id = v_clinic_id
           and grant_row.permission_key = 'ai.financial_insights'
           and grant_row.granted
       )
    then
      raise exception 'Financial AI permission not granted for this user'
        using errcode = '42501';
    end if;
  end if;

  return v_clinic_id;
end;
$$;

revoke all on function public.ai_assert_analytics_caller(text) from public;
grant execute on function public.ai_assert_analytics_caller(text) to authenticated;

comment on function public.ai_assert_analytics_caller(text) is
  'Shared guard for every P4.6 analytics RPC. Enforces the role matrix per '
  'scope, the pro_ai AI entitlements, and (for the financial scope) the '
  'per-user ai.financial_insights grant. Re-resolves the caller''s clinic from '
  'auth_clinic_id() and never accepts a clinic id from the caller.';

-- ---------------------------------------------------------------------------
-- 2. Grant hardening on the ranked entity-search functions (phase review L9)
-- ---------------------------------------------------------------------------
--
-- These are SECURITY INVOKER, so RLS is fully authoritative and `anon` sees
-- nothing regardless. But every analytics RPC in the phase does
-- `revoke all … from public` before granting to `authenticated`, and these four
-- did not — an inconsistency inside one feature is the kind that gets copied
-- into the next function by someone reading the file for a pattern.
do $$
begin
  execute 'revoke all on function public.search_patients_ranked(text, text, integer) from public';
  execute 'grant execute on function public.search_patients_ranked(text, text, integer) to authenticated';
exception when undefined_function then
  null;
end;
$$;

do $$
begin
  execute 'revoke all on function public.search_staff_ranked(text, text, public.user_role, integer) from public';
  execute 'grant execute on function public.search_staff_ranked(text, text, public.user_role, integer) to authenticated';
exception when undefined_function then
  null;
end;
$$;

do $$
begin
  execute 'revoke all on function public.search_departments_ranked(text, text, integer) from public';
  execute 'grant execute on function public.search_departments_ranked(text, text, integer) to authenticated';
exception when undefined_function then
  null;
end;
$$;

do $$
begin
  execute 'revoke all on function public.search_services_ranked(text, text, integer) from public';
  execute 'grant execute on function public.search_services_ranked(text, text, integer) to authenticated';
exception when undefined_function then
  null;
end;
$$;
