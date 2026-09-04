-- P13b — the DEFAULT included managed AI allowance becomes $10.00 USD per
-- clinic per billing period.
--
-- WHY HERE. `plans.limits.ai_credits_month` is the single commercial source of
-- truth for the included managed allowance: the reservation transaction
-- (`resolve_ai_budget`), the owner console RPC
-- (`operator_ai_allowance_report`) and the TypeScript recompute fallback in
-- `lib/ai/operator-allowance.ts` all read that one key. Changing the catalog
-- here changes the default everywhere at once, and no UI component has to
-- carry the number.
--
-- The earlier seeds (`20260719140000_p45c_ai_commercial_integration.sql` and
-- the `20260719160000_p45c_pro_ai_catalog_reassert.sql` convergence fix) set a
-- bootstrap pool of 1,620,000,000 micros. Those migrations run before this one
-- and are one-time, so this file is the last word on the catalog default.
--
-- WHAT IS DELIBERATELY NOT TOUCHED.
--   * `ai_commercial_terms.included_budget_override_micros` — the per-clinic
--     owner override. It is a separate row that continues to win over the plan
--     default, so every clinic that has an explicit override keeps exactly the
--     allowance it was given. This migration does not read or write that table.
--   * `ai_budget_periods`, `usage_counters`, reservations, credentials — no
--     spend, reservation or period is rewritten; only the catalog denominator
--     for clinics that are on the plan default changes.
--   * Plans without the AI assistant, which stay at 0.
--   * Request/concurrency/step ceilings, which are platform-protection limits
--     and not part of the monetary allowance.
--
-- Amounts are ClinicFlow's internal cost-weighted allowance in USD micros
-- (10,000,000 micros = $10.00), not a customer price. Idempotent: re-running it
-- is a no-op once the catalog already carries the default.

update public.plans
set limits = limits || jsonb_build_object('ai_credits_month', 10000000),
    updated_at = clock_timestamp()
where coalesce((features ->> 'ai_assistant')::boolean, false) is true
  and coalesce((limits ->> 'ai_credits_month')::bigint, -1) is distinct from 10000000;
