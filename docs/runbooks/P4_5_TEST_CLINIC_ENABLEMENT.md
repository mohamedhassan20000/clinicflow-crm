# Runbook — Enable & reset a test clinic for Pro + AI (P4.5)

**Purpose.** Bring one specific clinic into a clean, canonical `pro_ai` state with
managed AI, strict BYOK, and BYOK-with-managed-fallback (hybrid) selectable, a
non-zero managed allowance, and a reset current-period usage/budget state.

**Scope guardrails.**
- Operator/DBA runbook, run manually with the service role. **Not** application
  logic — no clinic id is hardcoded anywhere in the app.
- Idempotent. Safe to re-run. Touches only the named clinic's rows.
- Does **not** create, read, or expose any provider credential. BYOK keys are
  connected by the clinic's primary admin through Settings → AI (validated once,
  encrypted at rest, never redisplayed). `ANTHROPIC_API_KEY` in the server
  environment remains the platform-managed credential and is untouched.

**Prerequisite.** Apply migrations through
`20260719160000_p45c_pro_ai_catalog_reassert.sql` first, so the `pro_ai` plan
row carries the P4.5C AI feature/limit vocabulary. Verify:

```sql
select slug,
       features -> 'ai.managed'      as managed,
       features -> 'ai.byok'         as byok,
       limits  ->> 'ai_credits_month' as credits_month
from public.plans
where slug = 'pro_ai';
-- expect: managed = true, byok = true, credits_month = 1620000000
```

---

## 1. Set the target clinic id

Replace the value below with the real clinic id (find it by name):

```sql
-- \set clinic_id '00000000-0000-0000-0000-000000000000'
select id, name from public.clinics where name ilike '%test%' order by created_at;
```

All statements use `:'clinic_id'`. In one psql session run:

```sql
\set clinic_id '<REAL-CLINIC-UUID>'
```

## 2. Activate the Pro + AI subscription (idempotent)

```sql
update public.subscriptions s
set plan_id = (select id from public.plans where slug = 'pro_ai'),
    status = 'active',
    current_period_start = coalesce(s.current_period_start, date_trunc('month', now())),
    current_period_end = greatest(
      coalesce(s.current_period_end, now()),
      date_trunc('month', now()) + interval '1 month'
    ),
    updated_at = now()
where s.clinic_id = :'clinic_id';
-- If the clinic somehow has no subscription row, insert one:
insert into public.subscriptions (clinic_id, plan_id, provider, status,
       current_period_start, current_period_end)
select :'clinic_id', p.id, 'manual', 'active',
       date_trunc('month', now()), date_trunc('month', now()) + interval '1 month'
from public.plans p
where p.slug = 'pro_ai'
  and not exists (select 1 from public.subscriptions where clinic_id = :'clinic_id');
```

## 3. Enable the managed-fallback (hybrid) mode for this clinic only

`ai.managed` and `ai.byok` come from the plan. The plan seeds
`ai.hybrid_fallback = false`, so enable it per-clinic via the canonical feature
override (this is the intended mechanism; it does not change any other clinic):

```sql
insert into public.clinic_feature_overrides (clinic_id, feature_key, enabled)
values (:'clinic_id', 'ai.hybrid_fallback', true)
on conflict (clinic_id, feature_key) do update set enabled = true, updated_at = now();
```

> Selecting strict BYOK or hybrid still requires the clinic's primary admin to
> connect a healthy Anthropic credential in Settings → AI. The DB triggers and
> the server action remain the authoritative enforcement; this override only
> makes the option selectable in an entitled plan.

## 4. Ensure a provider policy row exists (defaults to managed)

```sql
insert into public.ai_clinic_provider_policies (clinic_id, credential_mode, provider, updated_by)
values (:'clinic_id', 'managed', null, null)
on conflict (clinic_id) do nothing;
```

## 5. Reset ONLY this clinic's stale current-period AI budget/usage

Run this only if the current period shows an invalid/false-exhausted state
(e.g. `spent_micros`/`reserved_micros` inflated with no matching healthy usage).
It expires abandoned reservations and zeroes the period aggregates for the
current month. The immutable `ai_usage_events` ledger is intentionally **not**
mutated.

```sql
-- 5a. Expire any still-'reserved' leases so reserved_micros can be trusted.
update public.ai_budget_reservations
set status = 'expired', outcome = 'expired', error_class = 'operator_reset',
    actual_cost_micros = 0, finalized_at = clock_timestamp()
where clinic_id = :'clinic_id'
  and period_start = date_trunc('month', now())::date
  and status = 'reserved';

-- 5b. Zero the cost pool for the current period (limits are re-derived on the
--     next reservation from the authoritative plan/commercial resolution).
update public.ai_budget_periods
set reserved_micros = 0, spent_micros = 0, updated_at = clock_timestamp()
where clinic_id = :'clinic_id'
  and period_start = date_trunc('month', now())::date;

-- 5c. (Optional) Reset the request fair-use counter for the current period.
update public.usage_counters
set used = 0, updated_at = now()
where clinic_id = :'clinic_id'
  and period_start = date_trunc('month', now())::date
  and metric = 'ai_messages';
```

## 6. (Optional) Operator commercial terms

The plan already grants a non-zero managed allowance (`ai_credits_month`), so no
override is required. Add prepaid add-on or contracted-overage headroom only if a
test explicitly needs it (`updated_by` must be a real platform-admin user id):

```sql
insert into public.ai_commercial_terms (clinic_id, addon_budget_micros, change_reason, updated_by)
values (:'clinic_id', 200000000, 'prepaid_addon', '<PLATFORM-ADMIN-USER-UUID>')
on conflict (clinic_id) do update
set addon_budget_micros = excluded.addon_budget_micros,
    change_reason = excluded.change_reason,
    updated_by = excluded.updated_by,
    updated_at = now();
```

## 7. Verify

```sql
select p.slug, s.status, s.current_period_end > now() as active,
       p.limits ->> 'ai_credits_month' as credits_month,
       (select enabled from public.clinic_feature_overrides
         where clinic_id = :'clinic_id' and feature_key = 'ai.hybrid_fallback') as hybrid_override,
       (select spent_micros from public.ai_budget_periods
         where clinic_id = :'clinic_id'
           and period_start = date_trunc('month', now())::date) as spent_micros
from public.subscriptions s
join public.plans p on p.id = s.plan_id
where s.clinic_id = :'clinic_id';
```

Expected: `slug = pro_ai`, `status = active`, `active = true`,
`credits_month = 1620000000`, `hybrid_override = true`, and a reset
`spent_micros` (null until the next request, or 0). The AI settings page should
now show all three provider modes as selectable and the managed allowance well
below 100%.
