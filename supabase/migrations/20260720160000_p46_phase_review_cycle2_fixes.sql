-- P4.6 phase review #2 fixes — truthful suppression output, primary-admin RLS,
-- grant-row role integrity, and two consistency corrections.
--
-- Closes H1, M1, L2, L3 and L4 of docs/reviews/P4.6_PHASE_REVIEW_CYCLE2.md.
--
-- Nothing here loosens an authorization rule. Two of the four changes tighten
-- the database boundary; the other two make an existing payload stop stating
-- something false and make an existing predicate say what it meant.

-- ---------------------------------------------------------------------------
-- L2 — normalize_search_text / normalize_phone were granted without revoking
--      from PUBLIC
-- ---------------------------------------------------------------------------
--
-- `…120000` used a bare `grant execute … to authenticated, service_role`, which
-- leaves the default `PUBLIC` execute privilege in place — `pg_proc.proacl`
-- shows `=X/postgres`, i.e. `anon` may call them. There is no exposure: both
-- are `immutable`, pure, and read no data. This is the consistency argument L9
-- of review #1 made for the four `search_*_ranked` functions, applied to the
-- two functions one section above them in the same file, so a reader taking a
-- pattern from this file takes the hardened one.
revoke all on function public.normalize_search_text(text) from public;
revoke all on function public.normalize_phone(text) from public;
grant execute on function public.normalize_search_text(text) to authenticated, service_role;
grant execute on function public.normalize_phone(text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- M1 — the primary-admin rule is enforced in the application only
-- ---------------------------------------------------------------------------
--
-- `actions/ai-permissions.ts` requires the *primary* clinic admin for both the
-- read and the write, matching the page that hosts them. RLS required only
-- `role = 'admin'`, so the strict rule was reachable only through the
-- application: a non-primary admin holding their own session token could
-- `POST /rest/v1/user_ai_permissions` directly and write a grant the product
-- says only the primary admin may write — and the `…150000` guard then honors
-- that row on every financial RPC. Reproduced end-to-end in review #2.
--
-- This is the authority the P4.5B migration already established for AI provider
-- connections (`assert_primary_ai_provider_admin`), reused verbatim as a
-- predicate: same filters (`is_active`, `is_deleted`, `deleted_at`) and the same
-- deterministic tiebreak (`created_at asc, id asc`). `lib/primary-admin.ts` is
-- documented as staying byte-for-byte aligned with that definition, so all three
-- now resolve the same person by construction.
--
-- SECURITY DEFINER because it reads `public.profiles` from inside an RLS policy
-- on another table: as INVOKER it would re-enter profiles' own policies, and the
-- policy must be able to see an admin row the caller may not otherwise select.
-- It discloses nothing a caller cannot already determine — it answers only
-- "is this specific user the primary admin of this specific clinic", for
-- arguments the caller supplies.
create or replace function public.is_primary_clinic_admin(
  p_clinic_id uuid,
  p_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_user_id is not null
     and p_user_id = (
       select profile.id
       from public.profiles as profile
       where profile.clinic_id = p_clinic_id
         and profile.role = 'admin'::public.user_role
         and profile.is_active = true
         and profile.is_deleted = false
         and profile.deleted_at is null
       order by profile.created_at asc, profile.id asc
       limit 1
     );
$$;

revoke all on function public.is_primary_clinic_admin(uuid, uuid) from public;
grant execute on function public.is_primary_clinic_admin(uuid, uuid)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- L3 — grant rows could be written for roles that can never use them
-- ---------------------------------------------------------------------------
--
-- Confirmed live in review #2: an admin could insert an `ai.financial_insights`
-- grant for a *doctor*. The row is inert — the registry, the tool gate, and
-- `ai_assert_analytics_caller`'s role matrix each refuse that role — so this is
-- not an access path. It is a data-integrity gap: `GRANTABLE_ROLES` in
-- `actions/ai-permissions.ts` was the only thing keeping the table meaningful,
-- and a stale row surviving a demotion silently re-activates on re-promotion.
--
-- Mirrors GRANTABLE_ROLES exactly. Admin is deliberately absent: admins hold the
-- permission implicitly (`IMPLICIT_PERMISSION_ROLES` / `hasAiUserPermission`),
-- so an admin row is meaningless rather than merely unnecessary.
create or replace function public.ai_permission_is_grantable(
  p_permission_key text,
  p_role public.user_role
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case p_permission_key
    when 'ai.financial_insights' then p_role = 'manager'::public.user_role
    else false
  end;
$$;

revoke all on function public.ai_permission_is_grantable(text, public.user_role) from public;
grant execute on function public.ai_permission_is_grantable(text, public.user_role)
  to authenticated, service_role;

-- The replacement policy. `service_role` bypasses RLS entirely, so the
-- application's legitimate workflow (`createClinicScopedAdminClient`, after the
-- action has itself checked `isPrimaryClinicAdmin`) is unaffected — this closes
-- the *direct PostgREST* path with a user token, which is the only path the
-- previous policy left open.
--
-- `using` and `with check` carry the same three conditions so a non-primary
-- admin can neither read, write, update, nor delete a grant row, and so an
-- `update` cannot move a row to a target whose role is not grantable.
drop policy if exists "Admins can manage clinic ai permissions" on public.user_ai_permissions;
create policy "Primary admin can manage clinic ai permissions"
  on public.user_ai_permissions
  for all
  using (
    public.is_primary_clinic_admin(user_ai_permissions.clinic_id, auth.uid())
  )
  with check (
    public.is_primary_clinic_admin(user_ai_permissions.clinic_id, auth.uid())
    and exists (
      select 1
      from public.profiles target
      where target.id = user_ai_permissions.user_id
        and target.clinic_id = user_ai_permissions.clinic_id
        and target.is_deleted = false
        and target.deleted_at is null
        and public.ai_permission_is_grantable(
          user_ai_permissions.permission_key, target.role)
    )
  );

-- The self-read policy is unchanged and still applies: a user may read their own
-- grant row regardless of who wrote it. Restated here so the two policies are
-- visible together after this migration rather than only in `…130000`.
drop policy if exists "Users can read own ai permissions" on public.user_ai_permissions;
create policy "Users can read own ai permissions"
  on public.user_ai_permissions
  for select
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- L4 — `exact_name` evaluated to NULL rather than false without an alt query
-- ---------------------------------------------------------------------------
--
-- `c.search_name in (v_query, v_query_alt)` is three-valued: with
-- `v_query_alt IS NULL` and no match on `v_query` it yields NULL, not false.
-- Every consumer happens to tolerate it (NULL falls through the score CASE, and
-- `false OR NULL` excludes the row from the final WHERE just as the score filter
-- would), so there is no behavior change here — but the correctness rested on
-- two expressions coincidentally absorbing a NULL the author did not intend,
-- while the neighbouring `prefix_name` guards the identical case explicitly.
--
-- Recreated in full because `create or replace function` cannot patch a body.
-- Everything except the `exact_name` expression is byte-identical to `…140000`.
create or replace function public.search_patients_ranked(
  p_query text,
  p_query_alt text default null,
  p_limit integer default 10
)
returns table (
  id uuid,
  full_name text,
  file_number text,
  phone text,
  email text,
  score real,
  match_kind text
)
language plpgsql
stable
security invoker
set search_path = ''
set pg_trgm.similarity_threshold = '0.18'
set pg_trgm.word_similarity_threshold = '0.18'
as $$
declare
  v_query text := public.normalize_search_text(p_query);
  v_query_alt text := public.normalize_search_text(p_query_alt);
  v_digits text := public.normalize_phone(p_query);
  v_limit integer := least(greatest(coalesce(p_limit, 10), 1), 20);
  v_phone_suffix text := case
    when v_digits is not null and length(v_digits) >= 7
      then '%' || right(v_digits, 8)
  end;
begin
  if v_query is null and v_digits is null then
    return;
  end if;

  return query
  with candidates as (
    select p.id, p.full_name, p.file_number, p.phone, p.email,
           p.search_name, p.search_phone
    from public.patients p
    where not p.is_deleted
      and (
        (v_query is not null and p.search_name operator(public.%) v_query)
        or (v_query is not null and v_query operator(public.<%) p.search_name)
        or (v_query_alt is not null and p.search_name operator(public.%) v_query_alt)
        or (v_query_alt is not null and v_query_alt operator(public.<%) p.search_name)
        or (v_query is not null and p.search_name like v_query || '%')
        or (v_query_alt is not null and p.search_name like v_query_alt || '%')
        or (p_query is not null and p.file_number = p_query)
        or (v_phone_suffix is not null and p.search_phone like v_phone_suffix)
      )
  ),
  scored as (
    select
      c.id,
      c.full_name,
      c.file_number,
      c.phone,
      c.email,
      greatest(
        case when v_query is null then 0
             else greatest(
               public.similarity(c.search_name, v_query),
               public.word_similarity(v_query, c.search_name)
             )
        end,
        case when v_query_alt is null then 0
             else greatest(
               public.similarity(c.search_name, v_query_alt),
               public.word_similarity(v_query_alt, c.search_name)
             )
        end
      )::real as name_score,
      -- L4: two-valued, mirroring `prefix_name` on the next line.
      (v_query is not null and (
        c.search_name = v_query
        or (v_query_alt is not null and c.search_name = v_query_alt)
      )) as exact_name,
      (v_query is not null and (
        c.search_name like v_query || '%'
        or (v_query_alt is not null and c.search_name like v_query_alt || '%')
      )) as prefix_name,
      (c.file_number = p_query) as exact_file,
      (v_phone_suffix is not null and c.search_phone like v_phone_suffix) as phone_match
    from candidates c
  )
  select
    s.id,
    s.full_name,
    s.file_number,
    s.phone,
    s.email,
    -- Note on `phone_match` scoring 1.0: the suffix match is 8 digits, so two
    -- patients holding the same national number under different country codes
    -- both score 1.0. The *outcome* is safe — `classifyConfidence` requires a
    -- clear lead over the runner-up as well as a strong score, so a tie
    -- resolves to `medium` and forces a clarification rather than picking one.
    -- Read `score` as "how strong is this match kind", not as "how sure are we
    -- this is the person".
    (case
      when s.exact_file or s.phone_match or s.exact_name then 1.0
      when s.prefix_name then greatest(s.name_score, 0.75)
      else s.name_score
    end)::real as score,
    (case
      when s.exact_file then 'file_number'
      when s.phone_match then 'phone'
      when s.exact_name then 'exact_name'
      when s.prefix_name then 'name_prefix'
      else 'name_fuzzy'
    end) as match_kind
  from scored s
  where s.exact_file or s.phone_match or s.exact_name or s.prefix_name
     or s.name_score >= 0.18
  order by 6 desc, s.full_name asc
  limit v_limit;
end;
$$;

revoke all on function public.search_patients_ranked(text, text, integer) from public;
grant execute on function public.search_patients_ranked(text, text, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- H1 — complementary suppression labelled above-floor buckets "<5"
-- ---------------------------------------------------------------------------
--
-- The suppression *construction* introduced by review #1's H1 fix is correct and
-- is preserved unchanged: primary suppression hides every bucket below the
-- floor, then complementary suppression keeps extending the suppressed prefix
-- until at least two buckets are hidden and their sum reaches the floor, which
-- is what closes the subtraction attack at the source.
--
-- The defect was the *rendering*. The emit loop treated "inside the suppressed
-- prefix" as equivalent to "below the floor" and stamped every hidden bucket
-- `display: '<5'`. A bucket suppressed complementarily is not below the floor —
-- it was hidden to protect a different bucket. Reproduced live in review #2: a
-- clinic with 3 A+ and 200 O+ patients reported *both* groups as `<5`, and the
-- staff prompt instructs the model to state returned values exactly, so the
-- assistant relayed "fewer than five O+ patients" for a 200-patient group.
--
-- Two corrections, and they are separate concerns:
--
--   1. Every bucket now carries `suppression_reason`, one of `below_floor`,
--      `complementary`, or null. A `below_floor` bucket keeps the truthful
--      `'<5'` display; a `complementary` one gets a non-numeric `'hidden'`
--      display, because no numeric statement about it is true. The counts stay
--      null in both cases, so the privacy property is untouched — this changes
--      only what we *claim*, never what we reveal.
--
--   2. When suppression covers *every* bucket, the distribution is withheld
--      rather than emitted as a list of nameless nulls. Review #2 asked
--      explicitly whether that terminal case should be answered or declined.
--      Declining is the honest answer: a fully suppressed distribution carries
--      no information, and emitting the bucket *labels* alongside a rounded
--      total was the shape that made the payload look like data while being
--      none. `distribution_withheld` plus `distribution_withheld_reason` let the
--      model and the UI say "this grouping cannot be reported for this clinic
--      without identifying individuals" instead of reciting falsehoods.
--
-- Note that with a small number of buckets and one rare category — the common
-- case for `blood_type` — full suppression is the *expected* outcome, not an
-- edge case. That is a real limit of the grouping, and saying so plainly is
-- better than the previous behavior, which stated a specific false number.
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
  -- Split out from v_suppressed: the prefix below this index is below the
  -- floor, the prefix above it is hidden only to protect those. Conflating the
  -- two is what produced the false "<5" label.
  v_below_floor integer := 0;
  v_suppressed_sum bigint := 0;
  v_index integer;
  v_bucket_total bigint;
  v_withheld boolean;
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

  v_below_floor := v_suppressed;

  -- 2. Complementary suppression: never leave a solvable single cell, and never
  --    leave a suppressed group whose total is itself below the floor.
  while v_suppressed > 0
    and v_suppressed < v_count
    and (v_suppressed < 2 or v_suppressed_sum < v_floor)
  loop
    v_suppressed := v_suppressed + 1;
    v_suppressed_sum := v_suppressed_sum + (v_rows[v_suppressed] ->> 'total')::bigint;
  end loop;

  -- H1.2: a distribution in which nothing survives is declined, not emitted.
  v_withheld := v_count > 0 and v_suppressed = v_count;

  if not v_withheld then
    -- Emit largest-first for readability; suppressed cells carry no exact count.
    for v_index in reverse v_count..1 loop
      v_bucket_total := (v_rows[v_index] ->> 'total')::bigint;
      v_buckets := v_buckets || jsonb_build_array(
        jsonb_build_object('bucket', v_rows[v_index] ->> 'bucket') ||
        case
          -- Below the floor: "<5" is a true statement about this bucket.
          when v_index <= v_below_floor
            then jsonb_build_object(
              'count', null, 'display', '<' || v_floor,
              'suppressed', true, 'suppression_reason', 'below_floor')
          -- Hidden to protect the buckets below it. Its size is unknown to the
          -- reader and may be arbitrarily large, so no numeric display is
          -- truthful here.
          when v_index <= v_suppressed
            then jsonb_build_object(
              'count', null, 'display', 'hidden',
              'suppressed', true, 'suppression_reason', 'complementary')
          else jsonb_build_object(
            'count', v_bucket_total, 'display', v_bucket_total::text,
            'suppressed', false, 'suppression_reason', null)
        end
      );
    end loop;
  end if;

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
    -- L8: the rounding is to *nearest*, deliberately — a floor would publish a
    -- true lower bound on the suppressed residual. So the approximation may be
    -- higher than the real total (203 publishes as 205), and the payload now
    -- says which direction it can err in rather than leaving the user to
    -- reconcile it against a patients page showing a different number.
    'patients_total_approx_direction',
      case when v_suppressed = 0 then null else 'nearest' end,
    'patients_new_in_range', v_new,
    'suppression_floor', v_floor,
    'suppressed_bucket_count', v_suppressed,
    'suppressed_below_floor_count', v_below_floor,
    'suppressed_complementary_count', v_suppressed - v_below_floor,
    -- Named for what it is: the distribution is over the whole patient
    -- population, not the requested range. Only `patients_new_in_range`
    -- respects p_start/p_end, and the model must not describe these buckets as
    -- belonging to the range.
    'bucket_scope', 'all_time',
    'distribution_withheld', v_withheld,
    'distribution_withheld_reason',
      case when v_withheld then 'all_buckets_suppressed' else null end,
    'buckets_all_time', v_buckets
  );
end;
$$;
