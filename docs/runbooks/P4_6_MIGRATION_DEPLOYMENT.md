# Runbook — Deploying the P4.6 migrations

**Applies to:** `20260720120000_p46c_entity_search.sql`, `20260720130000_p46a_staff_analytics.sql`, `20260720140000_p46b_assistant_access_paths.sql`, `20260720150000_p46_phase_review_fixes.sql`, `20260720160000_p46_phase_review_cycle2_fixes.sql`
**Owner:** whoever runs the production deploy
**Source:** M4 of `docs/reviews/P4.6_PHASE_REVIEW.md`

## Why this runbook exists

Four statements in the P4.6 migration set take locks on `public.patients` — the highest-traffic table in the product and the only one in the phase that grows without bound. On a pre-launch database this is invisible; on a sizeable tenant it is a hard outage window. The migrations themselves cannot avoid it, so the procedure is documented rather than automated.

Nothing else in P4.6 is operationally risky: the analytics RPCs, the guard function, the `user_ai_permissions` table, and the entity-search functions are all either new objects or `create or replace` on functions, none of which blocks traffic.

## The four blocking statements

| Migration | Statement | Lock | Blocks |
|---|---|---|---|
| `…120000` (C) | `alter table patients add column search_name …, add column search_phone …` (both `STORED` generated) | `ACCESS EXCLUSIVE` | **reads and writes**, for a full table rewrite |
| `…120000` (C) | `create index idx_patients_search_name_trgm` (GIN) | `SHARE` | writes |
| `…120000` (C) | `create index idx_patients_search_phone` (btree) | `SHARE` | writes |
| `…140000` (B) | `create index idx_patients_clinic_created`, `create index idx_patients_search_phone_trgm` | `SHARE` | writes |

> `idx_patients_search_phone` was missing from this table until the review-#2
> fixes. `…120000` builds **two** indexes, not one — its own comment says so —
> and an operator following the concurrent path below literally would have left
> that fourth build blocking. It is listed here and in the `CONCURRENTLY` block.

The generated-column rewrite is the expensive one, and it cannot be made non-blocking — a `STORED` generated column requires rewriting every row. The index builds *can* be made non-blocking with `CREATE INDEX CONCURRENTLY`, but that cannot run inside a transaction block, and the Supabase migration runner wraps each migration in one. So they are plain builds in the migration, and the concurrent forms below are the manual alternative.

## Decide which path to take

Run this first:

```sql
select count(*) as patients, pg_size_pretty(pg_total_relation_size('public.patients')) as size
from public.patients;
```

- **Under ~100k rows** — run the migrations normally. Expect single-digit seconds of blocking. No window needed beyond ordinary deploy care.
- **Over ~100k rows, or any tenant with active clinical hours** — take the maintenance-window path below.

## Maintenance-window path

1. **Schedule outside clinic hours.** During step 3 the app returns errors on any patient read or write; this is not a graceful degradation.
2. **Announce it.** Every clinic on the instance is affected, not only `pro_ai` ones — the lock is on the shared table, and P4.6 gating is irrelevant to DDL.
3. **Apply `…120000` with a lock timeout** so a stuck lock fails fast instead of queueing every subsequent query behind it:

   ```sql
   set lock_timeout = '10s';
   set statement_timeout = '30min';
   ```

   If it fails on `lock_timeout`, an open transaction is holding `patients`. Find it with `pg_stat_activity`, clear it, retry — do **not** raise the timeout to push through a queue.
4. **Apply `…130000`, `…140000`, `…150000`, `…160000`.** Only `…140000`'s two index builds block writes; reads stay available.
5. **Verify** (see below), then reopen.

### Building the indexes concurrently instead

If the write-blocking index builds are unacceptable, comment out **all four** `create index` statements before deploying (two in `…120000`, two in `…140000`), then run these by hand afterwards — each outside a transaction, one at a time:

```sql
create index concurrently if not exists idx_patients_search_name_trgm
  on public.patients using gin (search_name public.gin_trgm_ops)
  where (not is_deleted);

create index concurrently if not exists idx_patients_search_phone
  on public.patients using btree (search_phone)
  where (not is_deleted);

create index concurrently if not exists idx_patients_clinic_created
  on public.patients using btree (clinic_id, created_at)
  where (not is_deleted);

create index concurrently if not exists idx_patients_search_phone_trgm
  on public.patients using gin (search_phone public.gin_trgm_ops)
  where (not is_deleted);
```

A `CONCURRENTLY` build that fails leaves an **invalid** index behind that is not used but still costs writes. Always check afterwards:

```sql
select indexrelid::regclass from pg_index where not indisvalid;
```

Drop and rebuild anything listed.

## Verification

```sql
-- Generated columns are populated, not null-filled.
select count(*) filter (where search_name is not null) as named,
       count(*) filter (where search_phone is not null) as phoned,
       count(*) as total
from public.patients where not is_deleted;

-- All four indexes exist and are valid.
select indexrelid::regclass, indisvalid
from pg_index
where indexrelid::regclass::text in (
  'idx_patients_search_name_trgm', 'idx_patients_search_phone',
  'idx_patients_search_phone_trgm', 'idx_patients_clinic_created'
);

-- Patient search is index-served rather than scanning.
explain (analyze, buffers)
select * from public.search_patients_ranked('mohamed', null, 10);
```

The last one should show a bitmap index scan on `idx_patients_search_name_trgm`, not a sequential scan on `patients`. A sequential scan means the `%`/`<%` prefilter is not being used — check that `pg_trgm.similarity_threshold` and `pg_trgm.word_similarity_threshold` are still set on the function (see `…140000`).

## Rollback

The migrations are additive and forward-only. There is no rollback script, and rolling back is not the right response to a failure mid-deploy:

- **A failed generated-column add** rolls itself back (single statement, single transaction). Re-run once the blocker is cleared.
- **A failed index build** leaves nothing behind for a plain build, or an invalid index for a `CONCURRENTLY` one (drop it, rebuild).
- **`…160000` is non-blocking.** It replaces two functions, adds two small helper functions, and swaps one RLS policy on `user_ai_permissions` (a table with one row per granted user). No lock of consequence, no rewrite. It does tighten authorization — reverting it re-opens review-#2 M1 (any admin, not only the primary one, may write a financial grant over PostgREST) and restores the H1 suppression-labelling defect.
- **`…150000` tightens authorization**, so reverting it re-opens M1/M2. If it must be reverted for an incident, treat the analytics RPCs as exposed until it is reapplied — the application-layer gates still hold, but the direct PostgREST path does not.

Dropping `search_name` / `search_phone` after the fact would take the same ACCESS EXCLUSIVE rewrite as adding them, and would break `search_patients_ranked`.
