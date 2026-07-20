-- P4.6B — assistant access paths
--
-- Two carry-forward items from the P4.6A implementation report §10, both of
-- which come due precisely now: P4.6B is the sub-phase that puts the P4.6A
-- tools and the P4.6C patient search on a user-facing hot path, and neither
-- item is worth doing before something actually calls it repeatedly.
--
-- Nothing here changes authorization, visibility, or any result set. Both
-- changes are access-path only, and the second is verified below to return
-- exactly the rows the previous definition returned.

-- ---------------------------------------------------------------------------
-- 1. New-patient counts by clinic and registration date
-- ---------------------------------------------------------------------------
--
-- `count_new_patients` and the `patients_new_in_range` term of
-- `ai_get_clinic_summary` both filter `clinic_id` + `created_at`. The baseline
-- offers `idx_patients_clinic (clinic_id) where not is_deleted`, which serves
-- the tenant predicate and then discards on the date — fine for a page that
-- runs on demand, wasteful for a tool the assistant may call several times in
-- one conversation.
--
-- The P4.6A review asked for this composite to be confirmed before the tools
-- went on a hot path (§8). It did not exist. The appointment side of the same
-- question already did: `idx_appointments_clinic_date (clinic_id,
-- scheduled_at)` is in the baseline, so only the patients half was missing.
--
-- Partial on `not is_deleted` to match the existing predicate and every caller.
--
-- ⚠ OPERATIONAL NOTE: plain `create index` holds SHARE on `patients`, which
-- blocks writes for the duration of the build. Same table and same caveat as
-- the P4.6C generated columns — see
-- docs/runbooks/P4_6_MIGRATION_DEPLOYMENT.md for the maintenance window and the
-- manual CONCURRENTLY variant. Both index builds in this file are affected.
create index if not exists idx_patients_clinic_created
  on public.patients using btree (clinic_id, created_at)
  where (not is_deleted);

-- ---------------------------------------------------------------------------
-- 2. Make search_patients_ranked index-usable
-- ---------------------------------------------------------------------------
--
-- P4.6A finding M5 dropped three trigram indexes on `profiles`, `departments`,
-- and `services` because those functions compute `similarity()` as a scalar and
-- filter on the score, which is not sargable — so the index was write
-- amplification with no read benefit. That reasoning was explicitly recorded as
-- *not* transferring to `patients.search_name`, whose table grows without
-- bound, and re-checking this function was left to P4.6B.
--
-- The re-check confirms the concern. `search_patients_ranked` has the same
-- shape: `where not p.is_deleted` scans every patient the caller's RLS admits,
-- scores each one, and only then filters. `idx_patients_search_name_trgm` is
-- never used. On a clinic with a hundred patients that is invisible; on one
-- with a hundred thousand it is a full scan per keystroke-level lookup.
--
-- M5 also rejected the obvious fix — adding a `search_name % v_query` conjunct
-- — because `%` applies pg_trgm's default 0.3 threshold, well above the 0.18
-- recall floor this function deliberately uses, so it would silently drop the
-- fuzzy matches the feature exists for. That objection is about the *default*,
-- not about the operator. Setting both thresholds to 0.18 on the function
-- itself makes `%` and `<%` mean exactly what the score filter already means,
-- so the prefilter is an equivalence rather than a narrowing:
--
--   exact_file   -> p.file_number = p_query      (patients_clinic_file_number_unique)
--   phone_match  -> p.search_phone like '%...'   (gin_trgm, see below)
--   exact_name   -> p.search_name in (...)       (also covered by %)
--   prefix_name  -> p.search_name like '...%'    (gin_trgm)
--   name_score   -> similarity >= 0.18           (%), word_similarity >= 0.18 (<%)
--
-- Every branch is now index-backed, so the planner can answer the whole OR
-- with a BitmapOr instead of a sequential scan.
--
-- The phone index changes from btree to GIN trigram for the same reason: the
-- suffix predicate is `like '%' || right(digits, 8)`, a leading-wildcard match
-- that a btree cannot serve at all. gin_trgm_ops does support arbitrary
-- LIKE patterns, so this is the first definition under which that branch has
-- ever used an index.
drop index if exists public.idx_patients_search_phone;

-- ⚠ Write-blocking build on `patients` — see the runbook note above.
create index if not exists idx_patients_search_phone_trgm
  on public.patients using gin (search_phone public.gin_trgm_ops)
  where (not is_deleted);

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
-- The recall floor, declared where the operators can see it. Without these the
-- `%` / `<%` prefilter would enforce pg_trgm's 0.3 default and drop matches
-- the score filter below accepts.
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
    -- Sargable prefilter. Provably equivalent to the score filter below: see
    -- the branch-by-branch mapping in this migration's header.
    select p.id, p.full_name, p.file_number, p.phone, p.email,
           p.search_name, p.search_phone
    from public.patients p
    where not p.is_deleted
      and (
        -- Operators are schema-qualified because this function runs with an
        -- empty search_path, exactly like the public.similarity() calls below.
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
      (v_query is not null and c.search_name in (v_query, v_query_alt)) as exact_name,
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
    -- But the score itself claims a certainty it does not have, and a future
    -- consumer reading `score` without going through `classifyConfidence`
    -- would be misled. Read `score` as "how strong is this match kind", not as
    -- "how sure are we this is the person".
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
