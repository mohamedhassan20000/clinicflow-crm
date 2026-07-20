-- P4.6C: Intelligent entity search & name resolution (patients first).
--
-- Adds deterministic, database-native normalized/fuzzy search infrastructure:
-- an immutable Arabic/English text normalizer, a digit-only phone normalizer,
-- generated search columns on patients, trigram indexes over the normalized
-- text, and a ranked SECURITY INVOKER search RPC. Ranking and confidence are
-- computed here — never guessed by the language model. RLS is preserved: the
-- RPC runs as the caller, so clinic isolation, doctor assignment/department
-- scoping, and the soft-delete filter all come from patients_select_role_scoped.

-- ---------------------------------------------------------------------------
-- Normalization functions (immutable — safe for generated columns and indexes)
-- ---------------------------------------------------------------------------

-- Folds Arabic and Latin text into a comparable search form:
--   * lowercase
--   * Arabic diacritics (U+064B–U+0652) and tatweel (U+0640) removed
--   * alef variants (أ إ آ ٱ) → ا, ة → ه, ى → ي, ؤ → و, ئ → ي
--   * Arabic-Indic (٠–٩) and Extended (۰–۹) digits → Latin digits
--   * punctuation → space, whitespace collapsed and trimmed
create or replace function public.normalize_search_text(p_value text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select nullif(
    btrim(
      regexp_replace(
        regexp_replace(
          translate(
            regexp_replace(lower(coalesce(p_value, '')), '[ًٌٍَُِّْـ]', '', 'g'),
            'أإآٱةىؤئ٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹',
            'ااااهيوي01234567890123456789'
          ),
          '[^[:alnum:]؀-ۿ]+', ' ', 'g'
        ),
        '\s+', ' ', 'g'
      )
    ),
    ''
  );
$$;

-- Digits-only phone form; Arabic-Indic digits mapped to Latin.
create or replace function public.normalize_phone(p_value text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select nullif(
    regexp_replace(
      translate(coalesce(p_value, ''), '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789'),
      '[^0-9]+', '', 'g'
    ),
    ''
  );
$$;

grant execute on function public.normalize_search_text(text) to authenticated, service_role;
grant execute on function public.normalize_phone(text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Generated search columns + indexes on patients
-- ---------------------------------------------------------------------------
--
-- ⚠ OPERATIONAL NOTE — THIS SECTION TAKES A WRITE-BLOCKING LOCK ON `patients`.
--
-- Adding two STORED generated columns forces a **full table rewrite** while
-- holding ACCESS EXCLUSIVE: every read and every write to `patients` blocks for
-- the duration. The two `create index` statements below then hold SHARE, which
-- blocks writes (not reads). `patients` is the highest-traffic table in the
-- product and the only one in this phase that grows without bound.
--
-- On a pre-launch or small database this is invisible. On the first sizeable
-- production tenant it is an outage window, and it must be planned rather than
-- discovered. `CREATE INDEX CONCURRENTLY` cannot run inside a transaction
-- block, so the Supabase migration runner cannot express the non-blocking form
-- — the index builds have to be split out and run manually if the rewrite is
-- staged separately. The generated columns cannot avoid the rewrite at all.
--
-- See docs/runbooks/P4_6_MIGRATION_DEPLOYMENT.md for the maintenance-window
-- procedure, the row-count thresholds, and the manual CONCURRENTLY variants.
--
-- `if not exists` guards throughout: every other migration in this phase uses
-- them, and without them this was the one non-rerunnable file in P4.6.

alter table public.patients
  add column if not exists search_name text generated always as (public.normalize_search_text(full_name)) stored,
  add column if not exists search_phone text generated always as (public.normalize_phone(phone)) stored;

create index if not exists idx_patients_search_name_trgm
  on public.patients using gin (search_name public.gin_trgm_ops)
  where (not is_deleted);

create index if not exists idx_patients_search_phone
  on public.patients using btree (search_phone)
  where (not is_deleted);

-- ---------------------------------------------------------------------------
-- Ranked patient search
-- ---------------------------------------------------------------------------

-- SECURITY INVOKER on purpose: every row the caller can see (and none they
-- cannot) is decided by the existing patients RLS policy. p_query_alt carries
-- an optional deterministic transliteration variant (e.g. the Arabic-script
-- form of a Latin query) produced by the application layer.
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
as $$
declare
  v_query text := public.normalize_search_text(p_query);
  v_query_alt text := public.normalize_search_text(p_query_alt);
  v_digits text := public.normalize_phone(p_query);
  v_limit integer := least(greatest(coalesce(p_limit, 10), 1), 20);
begin
  if v_query is null and v_digits is null then
    return;
  end if;

  return query
  with scored as (
    select
      p.id,
      p.full_name,
      p.file_number,
      p.phone,
      p.email,
      greatest(
        case when v_query is null then 0
             else greatest(
               public.similarity(p.search_name, v_query),
               public.word_similarity(v_query, p.search_name)
             )
        end,
        case when v_query_alt is null then 0
             else greatest(
               public.similarity(p.search_name, v_query_alt),
               public.word_similarity(v_query_alt, p.search_name)
             )
        end
      )::real as name_score,
      (v_query is not null and p.search_name in (v_query, v_query_alt)) as exact_name,
      (v_query is not null and (
        p.search_name like v_query || '%'
        or (v_query_alt is not null and p.search_name like v_query_alt || '%')
      )) as prefix_name,
      (p.file_number = p_query) as exact_file,
      (v_digits is not null and length(v_digits) >= 7
        and p.search_phone like '%' || right(v_digits, 8)) as phone_match
    from public.patients p
    where not p.is_deleted
  )
  select
    s.id,
    s.full_name,
    s.file_number,
    s.phone,
    s.email,
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

grant execute on function public.search_patients_ranked(text, text, integer) to authenticated;
