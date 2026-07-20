-- P4.6A: Staff analytics, reporting & operational query tools — data layer.
--
-- Three additive concerns, none of which touches an existing policy or column:
--
--   1. Per-user AI permission storage (`user_ai_permissions`), the admin-managed
--      grant that gates financial AI tools on top of the `ai.financial_insights`
--      entitlement. It follows `user_page_permissions` (read own, admins manage
--      their clinic) because RLS on patient_deposits/outstanding_settlements
--      already permits manager reads — the manager restriction therefore has to be
--      an application/tool-layer decision, and this table is its storage. It
--      deliberately diverges from that table by binding `clinic_id` to the target
--      user's real clinic; see the note above the table.
--
--   2. Purpose-built SECURITY DEFINER, clinic-scoped aggregate RPCs. They return
--      aggregates only — never raw rows — and re-resolve auth_clinic_id() /
--      auth_role() themselves, so a caller can never widen the tenant or the role
--      through arguments. Patient-attribute distributions pass through a
--      small-cell suppression floor so a bucket can never be reversed into an
--      individual.
--
--   3. Staff / department / service normalized search columns and ranked
--      SECURITY INVOKER RPCs, reusing the P4.6C normalization functions verbatim.
--      P4.6C deferred these to P4.6A; the operational tools use them to resolve a
--      doctor or department the user named in words into an id, under the same
--      "never guess, ask when ambiguous" contract as patient search.

-- ---------------------------------------------------------------------------
-- 1. Per-user AI permission storage
-- ---------------------------------------------------------------------------

-- `clinic_id` is denormalized onto the permission row so the RLS policies can
-- scope on it without a join. That denormalization needs an invariant, or the
-- column is merely an assertion by whoever wrote the row. Without one, an admin
-- of clinic B can insert (user_id = <a clinic-A user>, key, clinic_id = B): the
-- `with check` passes because the row claims clinic B, and the row then squats
-- the primary key so clinic A's own admin can never upsert the real grant.
--
-- Two constraints close that, and both are needed:
--   * the composite FK binds `clinic_id` to the target user's *actual* clinic,
--     so the squatting row is rejected at write time; and
--   * `clinic_id` leads the primary key, so the key is tenant-scoped rather
--     than global and a cross-tenant collision is not expressible.
--
-- (`public.user_page_permissions` carries the original, unconstrained shape.
-- The P4.6A report's claim that this table "mirrors it exactly" is corrected
-- there: this is a deliberate divergence, and the same hardening is a
-- recommended follow-up for that pre-existing table.)

-- `id` is already the primary key, so this adds no new uniqueness — it exists
-- purely to give the composite foreign key below a referencable target.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'profiles_id_clinic_id_key'
  ) then
    alter table public.profiles
      add constraint profiles_id_clinic_id_key unique (id, clinic_id);
  end if;
end;
$$;

create table if not exists public.user_ai_permissions (
  user_id uuid not null,
  permission_key text not null,
  granted boolean not null default false,
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (clinic_id, user_id, permission_key),
  constraint user_ai_permissions_user_clinic_fk
    foreign key (user_id, clinic_id)
    references public.profiles (id, clinic_id)
    on delete cascade,
  constraint user_ai_permissions_key_check
    check (permission_key in ('ai.financial_insights'))
);

-- The lookup in lib/ai/permissions.ts filters (user_id, clinic_id, key); the
-- clinic-leading primary key does not serve that, so keep a user-leading index.
--
-- Which mechanism is load-bearing, since three now overlap:
--   * **The composite FK is the real control.** It is what makes a cross-tenant
--     row impossible to write, and it would still hold if both indexes below
--     were dropped.
--   * The clinic-leading PK makes the key *tenant-scoped*, which is a modelling
--     correction (a grant belongs to a user within a clinic) rather than an
--     independent defense.
--   * This unique index enforces one grant row per user **globally**, which
--     also happens to make the squat unexpressible — but that is a side effect
--     of a lookup index, not a designed constraint, and it is the one of the
--     three that a future multi-clinic user model would have to drop.
-- Defense in depth is fine; mistaking the incidental one for the designed one
-- is not, which is why this says so out loud.
create unique index if not exists user_ai_permissions_user_key_idx
  on public.user_ai_permissions (user_id, permission_key);

create index if not exists user_ai_permissions_clinic_id_idx
  on public.user_ai_permissions (clinic_id);

create or replace function public.touch_user_ai_permissions_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists touch_user_ai_permissions_updated_at on public.user_ai_permissions;
create trigger touch_user_ai_permissions_updated_at
before update on public.user_ai_permissions
for each row
execute function public.touch_user_ai_permissions_updated_at();

alter table public.user_ai_permissions enable row level security;

drop policy if exists "Users can read own ai permissions" on public.user_ai_permissions;
create policy "Users can read own ai permissions"
  on public.user_ai_permissions
  for select
  using (user_id = auth.uid());

drop policy if exists "Admins can manage clinic ai permissions" on public.user_ai_permissions;
create policy "Admins can manage clinic ai permissions"
  on public.user_ai_permissions
  for all
  using (
    exists (
      select 1
      from public.profiles p
      where p.id = auth.uid()
        and p.clinic_id = user_ai_permissions.clinic_id
        and p.role = 'admin'
    )
  )
  with check (
    exists (
      select 1
      from public.profiles p
      where p.id = auth.uid()
        and p.clinic_id = user_ai_permissions.clinic_id
        and p.role = 'admin'
    )
  );

-- ---------------------------------------------------------------------------
-- 2. Aggregate analytics RPCs (SECURITY DEFINER, clinic-scoped, aggregates only)
-- ---------------------------------------------------------------------------

-- The original per-cell `ai_suppress_small_cell` helper is deliberately absent.
-- Suppression is a decision about the bucket *set* (see ai_get_patient_stats):
-- a function that can only see one count cannot know whether hiding it leaves a
-- solvable residual, so keeping it would invite exactly the reversible
-- construction it appeared to prevent.
drop function if exists public.ai_suppress_small_cell(bigint, integer);

-- Shared guard for every analytics RPC. Returns the caller's clinic; raises when
-- unauthenticated or when the role is outside the matrix *for the scope asked
-- for*.
--
-- The scope parameter exists because the three scopes have genuinely different
-- role sets, and collapsing them left this guard weaker than the registry it is
-- supposed to back up: a receptionist was refused only financial reads, so for
-- the clinic-wide aggregates the registry's `roles` array was the *only* thing
-- denying them. Defense in depth means each layer denies independently.
--
--   operational      — admin / manager / receptionist. Bounded lists and counts
--                      these roles already work with in the normal UI.
--   clinic_analytics — admin / manager. Clinic-wide aggregate distributions,
--                      including patient attributes.
--   financial        — admin / manager. The per-user grant and the
--                      ai.financial_insights entitlement are additionally
--                      enforced in the application layer, which is the only
--                      place they exist.
--
-- Doctors are refused every scope: they keep their own self-scoped P4 tools and
-- clinic-wide analytics are out of scope for them entirely (P4.6 role matrix).
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

  if v_role = 'doctor'::public.user_role then
    raise exception 'Not authorized for clinic analytics' using errcode = '42501';
  end if;

  if p_scope = 'clinic_analytics' and v_role = 'receptionist'::public.user_role then
    raise exception 'Not authorized for clinic analytics' using errcode = '42501';
  end if;

  if p_scope = 'financial' and v_role = 'receptionist'::public.user_role then
    raise exception 'Not authorized for financial analytics' using errcode = '42501';
  end if;

  return v_clinic_id;
end;
$$;

-- The boolean-scoped predecessor never shipped; drop it so no caller can reach
-- the weaker guard by passing the old argument type.
drop function if exists public.ai_assert_analytics_caller(boolean);

revoke all on function public.ai_assert_analytics_caller(text) from public;
grant execute on function public.ai_assert_analytics_caller(text) to authenticated;

-- get_clinic_summary: operational aggregates plus a previous-period trend.
-- No PHI: counts, department/staff totals, and appointment status splits only.
create or replace function public.ai_get_clinic_summary(
  p_start timestamptz,
  p_end timestamptz
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_clinic_id uuid := public.ai_assert_analytics_caller('clinic_analytics');
  v_span interval := p_end - p_start;
  v_prev_start timestamptz := p_start - v_span;
  v_result jsonb;
begin
  select jsonb_build_object(
    'range', jsonb_build_object('start', p_start, 'end', p_end),
    'departments_active', (
      select count(*) from public.departments d
      where d.clinic_id = v_clinic_id and d.is_active and d.deleted_at is null
    ),
    'staff_by_role', coalesce((
      select jsonb_object_agg(t.role, t.total)
      from (
        select p.role::text as role, count(*) as total
        from public.profiles p
        where p.clinic_id = v_clinic_id
          and p.is_active and not p.is_deleted and p.deleted_at is null
        group by p.role
      ) t
    ), '{}'::jsonb),
    'patients_total', (
      select count(*) from public.patients pt
      where pt.clinic_id = v_clinic_id and not pt.is_deleted
    ),
    'patients_new_in_range', (
      select count(*) from public.patients pt
      where pt.clinic_id = v_clinic_id and not pt.is_deleted
        and pt.created_at >= p_start and pt.created_at <= p_end
    ),
    'patients_new_previous_period', (
      select count(*) from public.patients pt
      where pt.clinic_id = v_clinic_id and not pt.is_deleted
        and pt.created_at >= v_prev_start and pt.created_at < p_start
    ),
    'appointments_in_range', (
      select count(*) from public.appointments a
      where a.clinic_id = v_clinic_id and a.deleted_at is null
        and a.scheduled_at >= p_start and a.scheduled_at <= p_end
    ),
    'appointments_previous_period', (
      select count(*) from public.appointments a
      where a.clinic_id = v_clinic_id and a.deleted_at is null
        and a.scheduled_at >= v_prev_start and a.scheduled_at < p_start
    ),
    'appointments_by_status', coalesce((
      select jsonb_object_agg(t.status, t.total)
      from (
        select a.status::text as status, count(*) as total
        from public.appointments a
        where a.clinic_id = v_clinic_id and a.deleted_at is null
          and a.scheduled_at >= p_start and a.scheduled_at <= p_end
        group by a.status
      ) t
    ), '{}'::jsonb),
    'followups_in_range', (
      select count(*) from public.follow_ups f
      where f.clinic_id = v_clinic_id
        and f.recorded_at >= p_start and f.recorded_at <= p_end
    ),
    -- Directory of ids the operational tools can filter on. Names and ids of
    -- departments and active doctors are already visible to these roles in the
    -- normal UI and contain no patient data.
    'departments', coalesce((
      select jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name) order by d.name)
      from public.departments d
      where d.clinic_id = v_clinic_id and d.is_active and d.deleted_at is null
    ), '[]'::jsonb),
    'doctors', coalesce((
      select jsonb_agg(
        jsonb_build_object('id', p.id, 'name', p.full_name, 'department_id', p.department_id)
        order by p.full_name
      )
      from public.profiles p
      where p.clinic_id = v_clinic_id and p.role = 'doctor'::public.user_role
        and p.is_active and not p.is_deleted and p.deleted_at is null
    ), '[]'::jsonb)
  )
  into v_result;

  return v_result;
end;
$$;

revoke all on function public.ai_get_clinic_summary(timestamptz, timestamptz) from public;
grant execute on function public.ai_get_clinic_summary(timestamptz, timestamptz) to authenticated;

-- get_patient_stats: patient-attribute distributions with small-cell suppression.
--
-- Primary suppression alone (hide any bucket below the floor) is *not* a privacy
-- control here, because the buckets partition the population exactly: every
-- patient falls into exactly one bucket, so a lone suppressed cell is recovered
-- by `total − Σ(visible)`. Two properties are therefore enforced together, and
-- neither is sufficient on its own:
--
--   1. Complementary suppression. If anything is suppressed, keep suppressing
--      the smallest still-visible bucket until at least two buckets are
--      suppressed AND their counts sum to at least the floor. The residual a
--      subtraction can recover is then a band of >= floor spread over >= 2
--      cells, which identifies no one.
--   2. The co-published total is no longer exact whenever suppression is
--      active. It is reported as a floor-rounded approximation, so even the
--      combined residual cannot be pinned down.
--
-- `suppressed_bucket_count` is returned so the assistant can still answer
-- honestly ("2 groups were too small to report") instead of guessing.
--
-- Deliberate asymmetry, recorded rather than left implicit: `ai_get_appointment_stats`
-- applies no suppression. Its buckets are operational counts per status /
-- doctor / department — not patient attributes — and admin/manager already read
-- exactly these figures on the reports page. Suppressing them would degrade an
-- operational tool to protect nothing.
create or replace function public.ai_get_patient_stats(
  p_start timestamptz,
  p_end timestamptz,
  p_group_by text default 'department'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_clinic_id uuid := public.ai_assert_analytics_caller('clinic_analytics');
  v_floor constant integer := 5;
  v_rows jsonb[];
  v_buckets jsonb := '[]'::jsonb;
  v_total bigint;
  v_new bigint;
  v_count integer;
  v_suppressed integer := 0;
  v_suppressed_sum bigint := 0;
  v_index integer;
  v_bucket_total bigint;
begin
  if p_group_by not in ('department', 'blood_type', 'assigned_doctor') then
    raise exception 'Unsupported grouping' using errcode = '22023';
  end if;

  select count(*) into v_total
  from public.patients pt
  where pt.clinic_id = v_clinic_id and not pt.is_deleted;

  select count(*) into v_new
  from public.patients pt
  where pt.clinic_id = v_clinic_id and not pt.is_deleted
    and pt.created_at >= p_start and pt.created_at <= p_end;

  -- Ascending by size, so "suppress the smallest still-visible bucket" is
  -- simply "extend the suppressed prefix by one".
  with grouped as (
    select
      case p_group_by
        when 'department' then coalesce(d.name, 'Unassigned')
        when 'blood_type' then coalesce(pt.blood_type::text, 'Unknown')
        else coalesce(doc.full_name, 'Unassigned')
      end as bucket,
      count(*) as total
    from public.patients pt
    left join public.departments d on d.id = pt.department_id
    left join public.profiles doc on doc.id = pt.assigned_doctor_id
    where pt.clinic_id = v_clinic_id and not pt.is_deleted
    group by 1
  )
  select coalesce(
    array_agg(
      jsonb_build_object('bucket', g.bucket, 'total', g.total)
      order by g.total asc, g.bucket asc
    ),
    array[]::jsonb[]
  )
  into v_rows
  from grouped g;

  v_count := coalesce(array_length(v_rows, 1), 0);

  -- 1. Primary suppression: every bucket strictly below the floor.
  while v_suppressed < v_count
    and (v_rows[v_suppressed + 1] ->> 'total')::bigint < v_floor
  loop
    v_suppressed := v_suppressed + 1;
    v_suppressed_sum := v_suppressed_sum + (v_rows[v_suppressed] ->> 'total')::bigint;
  end loop;

  -- 2. Complementary suppression: never leave a solvable single cell, and never
  --    leave a suppressed group whose total is itself below the floor.
  while v_suppressed > 0
    and v_suppressed < v_count
    and (v_suppressed < 2 or v_suppressed_sum < v_floor)
  loop
    v_suppressed := v_suppressed + 1;
    v_suppressed_sum := v_suppressed_sum + (v_rows[v_suppressed] ->> 'total')::bigint;
  end loop;

  -- Emit largest-first for readability; suppressed cells carry no exact count.
  for v_index in reverse v_count..1 loop
    v_bucket_total := (v_rows[v_index] ->> 'total')::bigint;
    v_buckets := v_buckets || jsonb_build_array(
      jsonb_build_object('bucket', v_rows[v_index] ->> 'bucket') ||
      case
        when v_index <= v_suppressed
          then jsonb_build_object('count', null, 'display', '<' || v_floor, 'suppressed', true)
        else jsonb_build_object(
          'count', v_bucket_total, 'display', v_bucket_total::text, 'suppressed', false)
      end
    );
  end loop;

  return jsonb_build_object(
    'range', jsonb_build_object('start', p_start, 'end', p_end),
    'group_by', p_group_by,
    -- All-time, like the buckets it partitions. Exact only when nothing is
    -- suppressed; otherwise a floor-rounded approximation, so the suppressed
    -- residual cannot be recovered by subtraction.
    'patients_total', case when v_suppressed = 0 then v_total else null end,
    'patients_total_approx',
      case when v_suppressed = 0 then v_total
           else (round(v_total::numeric / v_floor) * v_floor)::bigint end,
    'patients_total_exact', v_suppressed = 0,
    'patients_new_in_range', v_new,
    'suppression_floor', v_floor,
    'suppressed_bucket_count', v_suppressed,
    -- Named for what it is: the distribution is over the whole patient
    -- population, not the requested range. Only `patients_new_in_range`
    -- respects p_start/p_end, and the model must not describe these buckets as
    -- belonging to the range.
    'bucket_scope', 'all_time',
    'buckets_all_time', v_buckets
  );
end;
$$;

revoke all on function public.ai_get_patient_stats(timestamptz, timestamptz, text) from public;
grant execute on function public.ai_get_patient_stats(timestamptz, timestamptz, text) to authenticated;

-- get_appointment_stats: status counts plus no-show / cancellation rates.
create or replace function public.ai_get_appointment_stats(
  p_start timestamptz,
  p_end timestamptz,
  p_group_by text default 'status'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_clinic_id uuid := public.ai_assert_analytics_caller('clinic_analytics');
  v_total bigint;
  v_cancelled bigint;
  v_no_show bigint;
  v_completed bigint;
  v_buckets jsonb;
begin
  if p_group_by not in ('status', 'doctor', 'department') then
    raise exception 'Unsupported grouping' using errcode = '22023';
  end if;

  select
    count(*),
    count(*) filter (where a.status = 'cancelled'::public.appointment_status),
    count(*) filter (where a.status = 'no_show'::public.appointment_status),
    count(*) filter (where a.status = 'completed'::public.appointment_status)
  into v_total, v_cancelled, v_no_show, v_completed
  from public.appointments a
  where a.clinic_id = v_clinic_id and a.deleted_at is null
    and a.scheduled_at >= p_start and a.scheduled_at <= p_end;

  with grouped as (
    select
      case p_group_by
        when 'status' then a.status::text
        when 'doctor' then coalesce(doc.full_name, 'Unassigned')
        else coalesce(d.name, 'Unassigned')
      end as bucket,
      count(*) as total,
      count(*) filter (where a.status = 'cancelled'::public.appointment_status) as cancelled,
      count(*) filter (where a.status = 'no_show'::public.appointment_status) as no_show,
      count(*) filter (where a.status = 'completed'::public.appointment_status) as completed
    from public.appointments a
    left join public.profiles doc on doc.id = a.doctor_id
    left join public.departments d on d.id = a.department_id
    where a.clinic_id = v_clinic_id and a.deleted_at is null
      and a.scheduled_at >= p_start and a.scheduled_at <= p_end
    group by 1
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'bucket', g.bucket,
        'total', g.total,
        'cancelled', g.cancelled,
        'no_show', g.no_show,
        'completed', g.completed
      )
      order by g.total desc, g.bucket asc
    ),
    '[]'::jsonb
  )
  into v_buckets
  from grouped g;

  return jsonb_build_object(
    'range', jsonb_build_object('start', p_start, 'end', p_end),
    'group_by', p_group_by,
    'total', v_total,
    'completed', v_completed,
    'cancelled', v_cancelled,
    'no_show', v_no_show,
    'cancellation_rate', case when v_total = 0 then 0
      else round((v_cancelled::numeric / v_total) * 100, 2) end,
    'no_show_rate', case when v_total = 0 then 0
      else round((v_no_show::numeric / v_total) * 100, 2) end,
    'buckets', v_buckets
  );
end;
$$;

revoke all on function public.ai_get_appointment_stats(timestamptz, timestamptz, text) from public;
grant execute on function public.ai_get_appointment_stats(timestamptz, timestamptz, text) to authenticated;

-- get_revenue_summary: financial aggregates. The arithmetic deliberately mirrors
-- public.get_revenue_summary (the reports page core) so the assistant's numbers
-- reconcile exactly with the report a user can open themselves.
create or replace function public.ai_get_revenue_summary(
  p_start timestamptz,
  p_end timestamptz
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_clinic_id uuid := public.ai_assert_analytics_caller('financial');
  v_result jsonb;
begin
  with appointment_scope as (
    select
      a.total_amount, a.paid_amount, a.insurance_amount, a.secondary_amount,
      a.deposit_amount, a.outstanding_amount, a.payment_method, a.secondary_payment_method
    from public.appointments a
    where a.clinic_id = v_clinic_id
      and a.deleted_at is null
      and a.status = 'completed'::public.appointment_status
      and a.paid_at >= p_start
      and a.paid_at <= p_end
  ),
  settlement_scope as (
    select s.amount, s.payment_method
    from public.outstanding_settlements s
    where s.clinic_id = v_clinic_id
      and s.settled_at >= p_start
      and s.settled_at <= p_end
  ),
  deposit_scope as (
    select d.amount
    from public.patient_deposits d
    where d.clinic_id = v_clinic_id
      and d.created_at >= p_start
      and d.created_at <= p_end
  ),
  appointment_totals as (
    select
      coalesce(sum(total_amount), 0)::numeric as total_amount,
      coalesce(sum(paid_amount), 0)::numeric as primary_amount,
      coalesce(sum(secondary_amount), 0)::numeric as secondary_amount,
      coalesce(sum(insurance_amount), 0)::numeric as insurance_amount,
      coalesce(sum(deposit_amount), 0)::numeric as deposit_amount,
      coalesce(sum(outstanding_amount), 0)::numeric as outstanding_amount,
      count(*)::integer as transaction_count
    from appointment_scope
  ),
  settlement_totals as (
    select
      coalesce(sum(amount), 0)::numeric as settlements_amount,
      count(*)::integer as settlement_count
    from settlement_scope
  ),
  method_rows as (
    select payment_method::text as method, coalesce(sum(paid_amount), 0)::numeric as amount
    from appointment_scope
    where payment_method is not null and paid_amount is not null
    group by payment_method
    union all
    select secondary_payment_method::text, coalesce(sum(secondary_amount), 0)::numeric
    from appointment_scope
    where secondary_payment_method is not null and secondary_amount is not null
    group by secondary_payment_method
    union all
    select payment_method::text, coalesce(sum(amount), 0)::numeric
    from settlement_scope
    where payment_method is not null and amount is not null
    group by payment_method
  ),
  method_totals as (
    select method, coalesce(sum(amount), 0)::numeric as amount
    from method_rows group by method
  )
  select jsonb_build_object(
    'range', jsonb_build_object('start', p_start, 'end', p_end),
    'total_amount', at.total_amount,
    'primary_total', at.primary_amount,
    'secondary_total', at.secondary_amount,
    'insurance_total', at.insurance_amount,
    'deposit_total', at.deposit_amount,
    'outstanding_total', at.outstanding_amount,
    'settlements_total', st.settlements_amount,
    'gross_total',
      at.primary_amount + at.secondary_amount + at.insurance_amount +
      at.deposit_amount + st.settlements_amount,
    'transaction_count', at.transaction_count,
    'settlement_count', st.settlement_count,
    'new_deposits_total', (select coalesce(sum(amount), 0)::numeric from deposit_scope),
    'method_breakdown', coalesce((
      select jsonb_agg(jsonb_build_object('method', mt.method, 'amount', mt.amount) order by mt.amount desc)
      from method_totals mt
    ), '[]'::jsonb)
  )
  into v_result
  from appointment_totals at
  cross join settlement_totals st;

  return v_result;
end;
$$;

revoke all on function public.ai_get_revenue_summary(timestamptz, timestamptz) from public;
grant execute on function public.ai_get_revenue_summary(timestamptz, timestamptz) to authenticated;

-- compare_revenue_periods: two real aggregate reads plus their deltas, so the
-- model narrates measured numbers instead of inventing an explanation.
create or replace function public.ai_compare_revenue_periods(
  p_a_start timestamptz,
  p_a_end timestamptz,
  p_b_start timestamptz,
  p_b_end timestamptz
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_a jsonb;
  v_b jsonb;
  v_gross_a numeric;
  v_gross_b numeric;
begin
  -- Both reads go through the financial-gated summary, which re-asserts the
  -- caller itself; no separate guard is needed or wanted here.
  v_a := public.ai_get_revenue_summary(p_a_start, p_a_end);
  v_b := public.ai_get_revenue_summary(p_b_start, p_b_end);
  v_gross_a := (v_a ->> 'gross_total')::numeric;
  v_gross_b := (v_b ->> 'gross_total')::numeric;

  return jsonb_build_object(
    'period_a', v_a,
    'period_b', v_b,
    'gross_delta', v_gross_b - v_gross_a,
    'gross_delta_percent', case when v_gross_a = 0 then null
      else round(((v_gross_b - v_gross_a) / v_gross_a) * 100, 2) end,
    'transaction_delta',
      (v_b ->> 'transaction_count')::integer - (v_a ->> 'transaction_count')::integer,
    'outstanding_delta',
      (v_b ->> 'outstanding_total')::numeric - (v_a ->> 'outstanding_total')::numeric
  );
end;
$$;

revoke all on function public.ai_compare_revenue_periods(timestamptz, timestamptz, timestamptz, timestamptz) from public;
grant execute on function public.ai_compare_revenue_periods(timestamptz, timestamptz, timestamptz, timestamptz) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Staff / department / service ranked search (deferred to P4.6A by P4.6C)
-- ---------------------------------------------------------------------------

alter table public.profiles
  add column if not exists search_name text
  generated always as (public.normalize_search_text(full_name)) stored;

alter table public.departments
  add column if not exists search_name text
  generated always as (public.normalize_search_text(name)) stored;

alter table public.services
  add column if not exists search_name text
  generated always as (public.normalize_search_text(name)) stored;

-- No trigram indexes are created for these three columns, deliberately.
--
-- A GIN trgm index accelerates the trigram *operators* (`%`, `<%`, `<->`). The
-- ranked functions below compute `similarity()` / `word_similarity()` as scalar
-- expressions and then filter on the resulting score, which is not sargable —
-- the planner scans and scores either way, so such an index would be pure write
-- amplification, and on `profiles` that cost lands on a table every
-- authenticated request touches. Adding a `search_name % v_query` conjunct to
-- make them usable was rejected: `%` applies pg_trgm's own threshold (0.3 by
-- default), well above the 0.18 recall floor these functions intentionally use,
-- so it would silently drop the fuzzy matches the feature exists for.
--
-- These are per-clinic tables of at most a few hundred rows. Scan-and-rank is
-- the honest and correct plan for them. This reasoning does *not* transfer to
-- `patients.search_name` (P4.6C), whose table grows without bound; that index
-- is left in place and its access path is a P4.6B follow-up.

-- All three are SECURITY INVOKER, exactly like search_patients_ranked: the rows
-- a caller may see are decided by the existing table RLS, not by this function.
create or replace function public.search_staff_ranked(
  p_query text,
  p_query_alt text default null,
  p_role public.user_role default null,
  p_limit integer default 10
)
returns table (
  id uuid,
  full_name text,
  role text,
  department_id uuid,
  score real,
  match_kind text
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_query text := public.normalize_search_text(p_query);
  v_query_alt text := public.normalize_search_text(p_query_alt);
  v_limit integer := least(greatest(coalesce(p_limit, 10), 1), 20);
begin
  if v_query is null then
    return;
  end if;

  return query
  with scored as (
    select
      p.id, p.full_name, p.role::text as role, p.department_id,
      greatest(
        greatest(public.similarity(p.search_name, v_query), public.word_similarity(v_query, p.search_name)),
        case when v_query_alt is null then 0
             else greatest(public.similarity(p.search_name, v_query_alt), public.word_similarity(v_query_alt, p.search_name))
        end
      )::real as name_score,
      (p.search_name in (v_query, v_query_alt)) as exact_name,
      (p.search_name like v_query || '%'
        or (v_query_alt is not null and p.search_name like v_query_alt || '%')) as prefix_name
    from public.profiles p
    where not p.is_deleted and p.deleted_at is null and p.is_active
      and (p_role is null or p.role = p_role)
  )
  select
    s.id, s.full_name, s.role, s.department_id,
    (case
      when s.exact_name then 1.0
      when s.prefix_name then greatest(s.name_score, 0.75)
      else s.name_score
    end)::real as score,
    (case
      when s.exact_name then 'exact_name'
      when s.prefix_name then 'name_prefix'
      else 'name_fuzzy'
    end) as match_kind
  from scored s
  where s.exact_name or s.prefix_name or s.name_score >= 0.18
  order by 5 desc, s.full_name asc
  limit v_limit;
end;
$$;

revoke all on function public.search_staff_ranked(text, text, public.user_role, integer) from public;
grant execute on function public.search_staff_ranked(text, text, public.user_role, integer) to authenticated;

create or replace function public.search_departments_ranked(
  p_query text,
  p_query_alt text default null,
  p_limit integer default 10
)
returns table (id uuid, name text, score real, match_kind text)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_query text := public.normalize_search_text(p_query);
  v_query_alt text := public.normalize_search_text(p_query_alt);
  v_limit integer := least(greatest(coalesce(p_limit, 10), 1), 20);
begin
  if v_query is null then
    return;
  end if;

  return query
  with scored as (
    select
      d.id, d.name,
      greatest(
        greatest(public.similarity(d.search_name, v_query), public.word_similarity(v_query, d.search_name)),
        case when v_query_alt is null then 0
             else greatest(public.similarity(d.search_name, v_query_alt), public.word_similarity(v_query_alt, d.search_name))
        end
      )::real as name_score,
      (d.search_name in (v_query, v_query_alt)) as exact_name,
      (d.search_name like v_query || '%'
        or (v_query_alt is not null and d.search_name like v_query_alt || '%')) as prefix_name
    from public.departments d
    where d.deleted_at is null and d.is_active
  )
  select
    s.id, s.name,
    (case
      when s.exact_name then 1.0
      when s.prefix_name then greatest(s.name_score, 0.75)
      else s.name_score
    end)::real as score,
    (case
      when s.exact_name then 'exact_name'
      when s.prefix_name then 'name_prefix'
      else 'name_fuzzy'
    end) as match_kind
  from scored s
  where s.exact_name or s.prefix_name or s.name_score >= 0.18
  order by 3 desc, s.name asc
  limit v_limit;
end;
$$;

revoke all on function public.search_departments_ranked(text, text, integer) from public;
grant execute on function public.search_departments_ranked(text, text, integer) to authenticated;

create or replace function public.search_services_ranked(
  p_query text,
  p_query_alt text default null,
  p_limit integer default 10
)
returns table (id uuid, name text, department_id uuid, price numeric, score real, match_kind text)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_query text := public.normalize_search_text(p_query);
  v_query_alt text := public.normalize_search_text(p_query_alt);
  v_limit integer := least(greatest(coalesce(p_limit, 10), 1), 20);
begin
  if v_query is null then
    return;
  end if;

  return query
  with scored as (
    select
      sv.id, sv.name, sv.department_id, sv.price,
      greatest(
        greatest(public.similarity(sv.search_name, v_query), public.word_similarity(v_query, sv.search_name)),
        case when v_query_alt is null then 0
             else greatest(public.similarity(sv.search_name, v_query_alt), public.word_similarity(v_query_alt, sv.search_name))
        end
      )::real as name_score,
      (sv.search_name in (v_query, v_query_alt)) as exact_name,
      (sv.search_name like v_query || '%'
        or (v_query_alt is not null and sv.search_name like v_query_alt || '%')) as prefix_name
    from public.services sv
    where sv.deleted_at is null and sv.is_active
  )
  select
    s.id, s.name, s.department_id, s.price,
    (case
      when s.exact_name then 1.0
      when s.prefix_name then greatest(s.name_score, 0.75)
      else s.name_score
    end)::real as score,
    (case
      when s.exact_name then 'exact_name'
      when s.prefix_name then 'name_prefix'
      else 'name_fuzzy'
    end) as match_kind
  from scored s
  where s.exact_name or s.prefix_name or s.name_score >= 0.18
  order by 5 desc, s.name asc
  limit v_limit;
end;
$$;

revoke all on function public.search_services_ranked(text, text, integer) from public;
grant execute on function public.search_services_ranked(text, text, integer) to authenticated;
