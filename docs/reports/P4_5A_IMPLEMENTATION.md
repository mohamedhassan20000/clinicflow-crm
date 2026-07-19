# P4.5A Implementation Report

Date: 2026-07-19  
Scope: AI policy/provider abstraction, certified model registry, immutable AI usage/cost ledger, and atomic budget reservations only.

## Outcome

P4.5A is implemented without changing P4's staff roles, role-specific tools, prompts, conversation ownership, RLS reads, streaming response shape, or successful-turn persistence behavior. Model execution is now reachable only through a server-only ClinicFlow policy boundary. The direct Anthropic provider dependency and arbitrary raw-model construction path have been removed.

The implementation intentionally does not include tenant credentials, BYOK/hybrid routing, commercial catalog changes, plan renaming, namespaced entitlements, operator/clinic usage UI, patient messaging behavior, P4.6, or any later phase.

## Implemented Architecture

### Policy and provider boundary

- `lib/ai/client.ts` is now the public server-only execution entry point; callers provide an authenticated user, certified task, persona, surface, and content-free request ID rather than a raw provider/model.
- `lib/ai/platform/registry.ts` owns the task/persona matrix, stable model aliases, privacy requirements, pricing snapshot, certification metadata, and empty-until-certified fallback sets.
- The established P4 tiers are preserved:
  - staff: `staff-sonnet-bootstrap-v1` → `anthropic/claude-sonnet-4.5`
  - patient policy reservation only: `patient-haiku-bootstrap-v1` → `anthropic/claude-haiku-4.5`
- Legacy model environment overrides remain accepted only when they resolve to a certified registry entry. Unknown raw provider/model IDs fail closed.
- `lib/ai/platform/managed-gateway.ts` routes through Vercel AI Gateway, pins the allowed serving provider, requests zero data retention, emits content-free policy tags, and sends no clinic/user identity unless an optional HMAC key is configured. When configured, only a one-way pseudonym is sent.
- No fallback model is enabled in P4.5A because no alternate has completed the roadmap's scored evaluation. The schema and event format capture fallback aliases, attempt sequence, and parent-attempt metadata for future certified routes.

### P4 agent compatibility

- Both staff and doctor agent constructors consume an execution handle and cannot select a model directly.
- Existing temperature, output-token limit, and eight-step loop behavior are policy-owned and unchanged.
- Each step is guarded before provider spend with a conservative UTF-8 conversation-input ceiling. As a second, database-enforced safeguard, a provider-reported overrun can no longer fail reconciliation: the complete observed cost remains in immutable attempt events and `spent_micros`, while the reservation's bounded `actual_cost_micros` field is capped at its reserved ceiling.
- Attempt latency starts when each SDK provider step is prepared, so the first event no longer includes reservation, history-loading, or message-conversion time.
- Existing authorization, page visibility, subscription/feature checks, per-tool authorization, RLS clients, prompt guardrails, rate limiting, conversation ownership, and successful message persistence remain in place.
- Successful streams reconcile cost and retain one legacy `ai_messages` unit. Failed, empty, or aborted streams reconcile a content-free terminal event and atomically release that unit.

### Atomic reservations and immutable ledger

The migrations add:

- `ai_budget_periods`: monthly clinic cost pool with reserved and spent micro-units.
- `ai_budget_reservations`: durable request/lease records with policy, route, certification, privacy, expected provider/model, fallback aliases, reserved cost, actual cost, status, and outcome.
- `ai_usage_events`: append-only provider-attempt ledger containing identifiers, routing metadata, token counts, latency, safe error class, estimated/final cost, and billing disposition. It has no prompt, completion, message body, tool payload, patient ID, or credential column.
- `reserve_ai_budget`: service-role-only transaction that locks the clinic period, expires abandoned leases, derives the pool ceiling from the same grandfathered plan/counter snapshot used by `increment_usage`, checks the clinic pool, claims the legacy unit, inserts the durable reservation, and increases reserved cost together. The existing caller-supplied ceiling argument remains accepted for backward compatibility but is not authoritative.
- `reconcile_ai_budget`: service-role-only transaction that validates an exact JSON field allowlist, inserts immutable attempts, moves reserved cost to provider-reported spent cost, finalizes the lease, and compensates failed/aborted legacy usage. Provider over-runs are recorded rather than rejected, so a successfully billed turn cannot remain leased and later be refunded as expired.

The cost pool uses worst-case certified task cost, including the highest possible normal/cache input rate. The current pool ceiling is derived transactionally from the existing `ai_messages` entitlement so P4 commercial behavior remains unchanged; P4.5C is the roadmap owner for commercial catalog snapshots. A rare provider over-run may push actual spend above the pre-authorized ceiling, but the ledger and enforcement pool retain that real spend and deny subsequent requests rather than silently dropping it.

Request IDs are transport-idempotency keys, not regenerate keys. A retry of the same logical send reuses its client message ID and reservation; every new send/regenerate action must issue a fresh message ID because finalized/released/expired request IDs intentionally remain non-reusable.

All new tables have RLS enabled and no authenticated policies. `anon` and `authenticated` have no table or RPC privileges. Usage events reject direct update/delete even for service role, while a whole-tenant hard delete may still cascade for data-erasure obligations.

## Files Added

- `lib/ai/platform/types.ts`
- `lib/ai/platform/registry.ts`
- `lib/ai/platform/cost.ts`
- `lib/ai/platform/managed-gateway.ts`
- `lib/ai/platform/execution.ts`
- `supabase/migrations/20260719120000_p45a_ai_platform_foundation.sql`
- `supabase/migrations/20260719121000_p45a_ai_budget_local_conflict_policy.sql`
- `supabase/migrations/20260719122000_p45a_ai_reservation_actual_ceiling.sql`
- `supabase/migrations/20260719123000_p45a_review_fixes.sql`
- `tests/unit/ai/p45a-platform.test.ts`
- `tests/unit/ai/p45a-agent-wiring.test.ts`
- `tests/unit/db/p45a-ai-platform-foundation-migration.test.ts`
- `tests/unit/integration/p45a-ai-budget-ledger.test.ts`

The first two small follow-up migrations are forward-compatible no-ops on a fresh database. The final review-fix migration safely upgrades a local database that had already applied those migrations, preserving the public RPC signature while adding the overrun safeguard and authoritative limit wrapper. Fresh databases also contain the corrected behavior directly in the foundation migration.

## Verification

- `pnpm typecheck` — passed.
- `pnpm test` — passed: 161 files, 918 tests.
- P4.5A local-Supabase integration suite — passed: 1 file, 8 tests.
  - exactly one winner under concurrent requests for one clinic cost pool
  - atomic legacy usage reservation
  - content-free successful and failed reconciliation
  - actual-cost-over-reservation reconciliation without dropped spend
  - database-authoritative pool ceiling despite a stale caller hint
  - finalized request-id idempotency
  - immutable update/direct-delete rejection
  - own-clinic and cross-clinic authenticated denial
  - whole-tenant cascade deletion
- `pnpm lint` — passed with 0 errors and 25 pre-existing unrelated warnings.
- `pnpm exec supabase db lint --local --level error` — passed.
- `pnpm lint:rtl` — passed.
- `pnpm lint:i18n` — passed.
- `pnpm i18n:missing` — passed.
- `pnpm i18n:unused` — passed.
- `git diff --check` — passed.
- `pnpm build` — passed (Next.js 16.2.6 production build).

No live provider request was made; provider usage and cost reconciliation are tested with normalized mocked usage. A real two-step `ToolLoopAgent` runs against AI SDK's `MockLanguageModelV3` to verify `prepareStep`/`onStepFinish`, attempt ordering, usage mapping, and content-free reconciliation. Concurrency, RLS, RPC authorization, immutability, and transaction behavior are tested against local Postgres/Supabase.

## Intentional Limitations / Deferred Roadmap Work

- Managed AI Gateway mode only. Tenant credentials, BYOK, hybrid mode, credential encryption, health state, and owner controls remain P4.5B.
- No commercial plan/catalog or entitlement namespace changes and no usage UI; these remain P4.5C.
- No alternate fallback is active until a model is eval-certified. Formal multilingual model evaluation and routing promotion remain P6A.
- Patient task policies are registry placeholders only; no patient-facing AI behavior was added.
- Pricing is a versioned static certification snapshot and must be reviewed when a certified alias is promoted or provider pricing changes.
- An abrupt process failure is recovered when the next reservation reclaims the expired durable lease; P4.5A does not add a separate scheduled lease-reaper job.
