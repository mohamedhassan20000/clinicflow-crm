# P4.5C Implementation Report

Date: 2026-07-19
Scope: AI commercial catalog integration — stable slugs with final product names, additive namespaced AI entitlement vocabulary, cost-weighted included/add-on/contracted-overage credit terms, database-authoritative commercial limits, reserve-time provider-mode enforcement, clinic and operator aggregate projections, and immutable billing-disposition attribution. No payment processor, GA price, or arbitrary provider/model selection is introduced.

## Outcome

P4.5C completes Phase 4.5 on top of the P4.5A accounting boundary and the P4.5B tenant-credential lifecycle without changing staff/doctor prompts, tools, role authorization, RLS data access, conversation persistence, certified task aliases, the managed Gateway route, or the strict/hybrid provider architecture. AI remains reachable exclusively by the stable `pro_ai` catalog row; a `basic` or `pro` clinic cannot invoke a model by any route, and an operator feature override cannot turn Basic or Professional into an AI plan. The monthly cost pool and concurrency limit are now resolved authoritatively in SQL from the commercial catalog and manual terms, inside the reservation transaction.

## Commercial Integration Architecture

### Catalog, names, and namespaced entitlements

- The stable slugs `basic` / `pro` / `pro_ai` are retained. Final product names are set to **Basic** / **Professional** / **Pro + AI** (English) and their Arabic equivalents, per the 2026-07-19 commercial decision.
- The `pro_ai` feature set is extended additively with the namespaced `ai.*` vocabulary: `ai.staff_assistant`, `ai.patient_suggest`, `ai.patient_auto`, `ai.managed`, `ai.byok`, `ai.hybrid_fallback`, `ai.staff_analytics`, `ai.financial_insights`, `ai.followup_generation`, `ai.scheduling`. `pro_ai` seeds `ai.managed` and `ai.byok` on, `ai.hybrid_fallback` off (hybrid is an explicit operator-approved override by design). All AI keys are seeded `false` on `basic`/`pro`.
- `pro_ai` limits gain `ai_credits_month` (a cost-weighted enforcement seed, not a GA price), `ai_requests_month`, `ai_concurrent_requests` (4), `ai_turn_steps_max`, and `ai_output_tokens_max`. Non-AI plans seed these to `0`.

### Manual, provider-neutral commercial terms

- `ai_commercial_terms` stores operator-managed allowance policy in the same integer micro-unit as the cost ledger: an optional included-budget override, a prepaid add-on budget, an `overage_mode` of `hard_cap` (default) or `contracted`, and a contracted-overage budget. A shape CHECK enforces `hard_cap ⇒ overage_budget = 0` and `contracted ⇒ overage_budget > 0`. The table never stores card/payment data, provider keys, conversation content, or PHI.
- RLS is enabled with a single `is_platform_admin()` all-command policy (the `clinic_feature_overrides` pattern); `anon`/`authenticated` are revoked and only platform admins (and `service_role`) can read or write.

### Database-authoritative limits and entitlement enforcement

- `effective_ai_feature(clinic, key)` resolves an entitlement in-database: it requires an active/trialing subscription on the `pro_ai` slug and applies any clinic feature override, pinning AI to `pro_ai` independently of the application.
- `resolve_ai_commercial_limits(clinic, period_start)` is the single authoritative resolver. It requires both `ai_assistant` and `ai.staff_assistant`, reads the plan limits and the clinic's terms, and returns exact `included_limit_micros`, `addon_limit_micros`, `overage_limit_micros` (0 unless contracted), `total_limit_micros`, `request_limit`, and `concurrency_limit`. It fails closed (`AI_FEATURE_NOT_ENTITLED` / `AI_BUDGET_INVALID_COMMERCIAL_LIMITS`) when the clinic is not entitled or a limit is non-positive.
- The reservation transaction is re-pointed at this resolver: the P4.5A inner reserve (`reserve_ai_budget_p45a_limit_v1`) now derives the pool ceiling, the three commercial buckets, and the concurrency limit from `resolve_ai_commercial_limits` under the per-clinic period `FOR UPDATE` lock, and rejects a stale caller ceiling (`AI_BUDGET_STALE_COMMERCIAL_LIMIT`). The caller-supplied `budgetLimitMicros` is only a hint.
- The public 20-argument reserve wrapper adds provider-mode enforcement: it verifies the requested mode is entitled (`ai.managed` / `ai.byok` / `ai.hybrid_fallback`), matches the persisted clinic policy (`AI_PROVIDER_POLICY_MISMATCH`), and — for non-managed modes — that a healthy active connection exists (`AI_PROVIDER_CONNECTION_NOT_HEALTHY`). The database refuses a BYOK/hybrid reservation even if application state drifted.
- `enforce_ai_provider_mode_entitlement` is a policy-write trigger that blocks unentitled `byok_strict`/`hybrid` policy rows while always allowing the fail-safe reset to `managed`, so credential revocation can always fall back safely.

### Included / add-on / contracted-overage attribution

- The period row carries `included_limit_micros`, `addon_limit_micros`, and `overage_limit_micros`, all resolved from the catalog + terms and monotonically raised on conflict.
- A reservation carries a `managed_billing_disposition` of `managed_included` / `managed_addon` / `managed_overage`. The immutable `ai_usage_events` billing-disposition domain is widened to those three plus `byok_provider_direct` and `nonbillable_failed`, and the disposition trigger derives each attempt's bucket: failed/zero-cost → `nonbillable_failed`; strict BYOK and pre-fallback hybrid → `byok_provider_direct`; managed and post-fallback hybrid successes → the reservation's managed bucket.
- **Attribution is derived from the actual finalized cost at reconciliation (see Review Fixes → P45-R2), not from the reservation-time worst-case estimate.** Per-event/per-reservation buckets are an auditable classification; the exact period aggregate is the sole invoicing source of truth.

### Hard caps and concurrency

- Hard cap: with `overage_mode = 'hard_cap'`, `overage_limit_micros` is 0, so `total_limit_micros = included + addon`. The reserve pool check denies once committed spend would exceed that ceiling (`AI_BUDGET_EXCEEDED`), with no silent overage.
- Concurrency: `ai_concurrent_requests` (seeded 4) is enforced inside the reservation lock by counting unexpired `reserved` leases (`AI_BUDGET_CONCURRENCY_EXCEEDED`), independent of the monthly allowance.

### Concurrency behavior and reconciliation

- Every reserve-path check (stale-lease reclaim, duplicate-request idempotency, concurrency count, pool check, `increment_usage`, reservation insert, reserved-cost bump, disposition stamp) runs under the single per-clinic-period `FOR UPDATE` lock inside one `SECURITY DEFINER` transaction.
- Reconciliation is the 7-argument managed-cost wrapper over the P4.5A immutable-attempt reconciler. It structurally enforces managed == actual (managed), managed == 0 (strict), and re-derives the hybrid managed portion in SQL across all three managed buckets, failing closed on mismatch. Strict/hybrid direct spend is removed from the clinic's managed pool in the same transaction, and the direct-cost subtraction is double-guarded (`v_reconciled AND v_should_adjust`) so idempotent retries cannot double-subtract.

### Tenant isolation

- `ai_commercial_terms` has RLS enabled, no clinic-authenticated read path, and is registered in `CLINIC_SCOPED_TABLES` with the other AI tables so scoped server reads receive an injected clinic filter.
- The immutable ledger remains content-free: no prompt, completion, message body, tool payload, patient identifier, or credential column. `operator_ai_usage_report` returns platform-admin-only aggregates (budget/reserved/managed-spent/provider-cost/request-used/limit), reconciles period spend against the summed immutable ledger, and returns no actor ids or content. `subscriptions.clinic_id` is unique, so its join cannot fan out.

### Operator and clinic surfaces

- Operator: the clinic detail page manages `ai_commercial_terms` (pro_ai only, USD→micros with a safe-integer guard, audited via `logOperatorAction`, entitlement cache invalidated) and reads the `ai-usage` and `ai-provider-health` operator reports (metadata/aggregate only).
- Clinic: `/settings/ai` is primary-admin + entitlement gated at layout, page, action, and database layers. `AiUsageSummary` reads only aggregates via `getClinicAiCommercialUsage` (no events, no actors). The provider-mode panel now receives the clinic's resolved mode entitlements and disables/annotates modes not included in the plan (see Review Fixes → P45-L1).

## Files Added / Changed (P4.5C)

- `supabase/migrations/20260719140000_p45c_ai_commercial_integration.sql`
- `supabase/migrations/20260719150000_p45c_review_fixes.sql` (review fix P45-R2)
- `lib/ai/commercial.ts`, `lib/ai/commercial-policy.ts`
- `lib/entitlements.ts`, `lib/ai/authorization.ts`, `lib/ai/client.ts`, `lib/ai/usage.ts`, `lib/ai/doctor-agent.ts`, `lib/ai/staff-agent.ts`, `lib/primary-admin.ts`
- `actions/operator.ts`, `app/(operator)/operator/clinics/[id]/page.tsx`, `lib/operator-reports/registry.ts`
- `app/(protected)/settings/ai/page.tsx`, `components/settings/ai-provider-settings.tsx`, `components/settings/ai-usage-summary.tsx`, settings nav/header/layout
- `messages/en.json`, `messages/ar.json`, `messages/action-errors/{en,ar}.json`
- Tests: `tests/unit/integration/p45c-ai-commercial-integration.test.ts`, `tests/unit/db/p45c-ai-commercial-integration-migration.test.ts`, `tests/unit/db/p45c-review-fixes-migration.test.ts`, `tests/unit/ai/p45c-commercial.test.ts`, `tests/unit/lib/entitlements.test.ts`, `tests/unit/integration/ws7-operator-reports.test.ts`

## Review Fixes (docs/reviews/P4.5_PHASE_REVIEW.md)

Applied after the independent P4.5 phase review. Architecture, immutability, and all Phase 4 behavior are preserved; every behavioral change ships with test coverage.

### P45-R2 (= P45-M2) — Billing bucket derived from actual finalized cost (fixed)

The managed bucket was stamped on the reservation at reserve time from the worst-case reserved cost, and the disposition trigger copied that estimate onto the immutable attempt. Because actual cost is typically far below the reservation and concurrent reservations reconcile in arbitrary order, an attempt could be permanently recorded in the wrong bucket even though period aggregates stayed exact.

`20260719150000_p45c_review_fixes.sql` re-derives the bucket at reconciliation from the **actual finalized managed cost**, correct-once, **before** the append-only attempt is written:

- The clinic period is locked `FOR UPDATE` so concurrent reconciliations serialize and each reads a consistent cumulative managed spend (`spent_micros` is managed-only — strict/hybrid direct spend is removed in the same transaction).
- The corrected `managed_included` / `managed_addon` / `managed_overage` value is written to the still-mutable reservation row, and the existing BEFORE INSERT disposition trigger copies it onto the immutable event. **No `ai_usage_events` row is ever updated** — ledger immutability, historical auditability, per-clinic period locking, exact period aggregates, and idempotent reconciliation are all preserved. Only the first reconciliation (`v_should_adjust`) re-derives; retries leave the already-written events untouched.
- For hybrid, the managed portion is the caller estimate, which the existing SQL re-derivation validates against the summed managed attempts and rolls the whole transaction back on any mismatch, so deriving the bucket from it is safe.

Invoicing contract (documented in the migration and the function comment, and enforced by construction): the single-enum-per-reservation model still cannot split one reservation whose managed spend straddles a bucket boundary, so **the sole source of truth for add-on/contracted-overage invoicing is the exact period aggregate** — `ai_budget_periods.spent_micros` compared against `included_limit_micros` / `addon_limit_micros` / `overage_limit_micros`. Per-event buckets are an auditable best-effort attribution, never the billed quantity.

- Tests: `tests/unit/integration/p45c-ai-commercial-integration.test.ts` adds a correction scenario — two overlapping 800-micros reservations whose second is stamped `managed_addon` at reserve time are both re-derived to `managed_included` from their real 100-micros cost, and the period aggregate stays inside the included allowance. `tests/unit/integration/p45a-ai-budget-ledger.test.ts` is updated so a genuine provider over-run that crosses the included ceiling is now recorded as `managed_overage`. `tests/unit/db/p45c-review-fixes-migration.test.ts` locks the correct-once, period-locked, event-immutable, aggregate-authoritative contract in the migration source.

### P45-L1 (= P45-P1) — Mode entitlements passed to the settings panel (fixed)

The provider-mode panel disabled strict/hybrid only on connection health, so an un-entitled primary admin discovered the denial only after typing their password. The server page now resolves the clinic's mode entitlements (`hasAiProviderMode` for managed/strict/hybrid) and passes them into the panel, which disables and annotates any mode not included in the plan (`aiModeNotIncluded`, EN + AR) and blocks submission of an un-entitled selection. This is an advisory display gate only — the `setAiProviderMode` server action (`hasAiProviderMode`) and the `enforce_ai_provider_mode_entitlement` database trigger remain the independent, authoritative enforcement, unchanged.

## Verification

Re-run after the review fixes:

- `pnpm typecheck` — passed.
- `pnpm test` (unit, integration excluded) — passed: 170 files, 955 tests.
- `pnpm test:integration` (local Supabase) — passed: 21 files, 178 tests, including the P4.5C commercial suite (stable slugs / namespaced catalog, Basic+Professional AI denial, included/add-on/contracted-overage classification with ceiling enforcement, the new reconcile-time bucket-correction scenario, prepaid add-on hard cap, database concurrency cap, content-free operator aggregate reconciled to the ledger, and clinic/operator access denial).
- `supabase db reset --local` — passed; the full migration chain including `20260719140000` and `20260719150000` applies cleanly from a fresh database, and the full integration suite passes against that clean state.
- `supabase db lint --local --level error` — passed.
- `pnpm lint` — passed: 0 errors, 25 pre-existing unrelated warnings.
- `pnpm lint:rtl` — passed (385 files scanned).
- `pnpm lint:i18n` — passed (296 files scanned).
- `pnpm i18n:missing` — passed: 2,679 base leaf messages; declared locale variants valid.
- `pnpm i18n:unused` — passed: no unreferenced keys.

No live tenant provider request was made. Commercial resolution, entitlement enforcement, concurrency, billing attribution, reconciliation, and tenant isolation are exercised against local Postgres/Supabase; provider usage and cost are normalized mocks.

## Intentional Limitations / Deferred Roadmap Work

- `ai_credits_month` is a versioned cost-weighted enforcement seed, not a GA price; no payment processor, invoice generation, or automated charging is added. Add-on/contracted-overage terms are entered manually by platform operators.
- Per-event billing buckets are an auditable actual-cost classification; invoicing must use the exact period aggregates (see P45-R2). Invoice generation from event bucket fields is prohibited by this contract.
- No arbitrary provider, model, prompt, or tool selection, and no patient-facing AI, were added. Patient task policies remain registry placeholders; formal multilingual model evaluation and fallback promotion remain P6A.
- Pricing is a static certification snapshot and must be reviewed when a certified alias is promoted or provider pricing changes.
