# P4.5B Implementation Report

Date: 2026-07-19  
Scope: encrypted tenant provider connections, primary-admin credential lifecycle, strict BYOK, explicitly consented hybrid fallback, safe metadata, audit, and key-rotation operations.

## Outcome

P4.5B is implemented on top of the P4.5A execution and accounting boundary without changing staff-agent prompts, tools, role authorization, RLS data access, conversation persistence, certified task aliases, or the managed Gateway route. Anthropic is the only tenant provider in this phase, and clinics cannot choose arbitrary providers or models.

Tenant keys are validated once, encrypted with a dedicated versioned AES-256-GCM key ring, bound by authenticated context to clinic/provider/credential identity, and stored in service-only tables. The raw key is never returned by an action or metadata query. Primary-admin create, test, rotate, mode-change, and revoke paths are rate-limited and audited; rotation and revocation that change credential state require current-password verification.

## Provider and Routing Architecture

- Managed mode continues to use the certified Vercel AI Gateway adapter.
- Strict BYOK uses the direct Anthropic AI SDK adapter with the request-scoped decrypted tenant credential. It never constructs a managed provider and database reconciliation rejects any non-zero managed cost for a strict reservation.
- Hybrid mode starts with the tenant credential. A pre-stream provider failure may switch the execution to the existing certified managed route only after the persisted disclosure is revalidated and a metadata-only fallback audit succeeds. The execution remains on managed routing for later model steps and cannot repeatedly oscillate between credentials.
- Direct and managed attempts retain the P4.5A content-free ledger shape. Database-derived billing disposition distinguishes `byok_provider_direct`, `managed_included`, and `nonbillable_failed`.
- Total provider cost remains attributable in immutable events, while a separate managed-cost value ensures strict/direct BYOK spend is removed from ClinicFlow's included-credit aggregate in the same reconciliation transaction.

Vercel Gateway's request-scoped BYOK behavior permits system-credential fallback, so the strict route uses a direct provider adapter. This preserves the roadmap's no-silent-fallback contract while keeping Gateway as the managed route.

## Credential Storage and Lifecycle

The P4.5B migration adds:

- `ai_provider_connections`: encrypted credential envelope, encryption key version, SHA-256 masked fingerprint, typed health, and active/retired/revoked lifecycle metadata.
- `ai_clinic_provider_policies`: `managed`, `byok_strict`, or `hybrid`, including the exact persisted hybrid disclosure version and acceptance metadata.
- Service-role lifecycle RPCs that re-resolve the clinic's oldest active admin as primary, serialize first connection creation/rotation, destroy old ciphertext, and write metadata-only clinic audit entries.
- A fallback-audit RPC that requires the active persisted hybrid policy and the exact active hybrid reservation before managed execution is permitted.
- Ledger constraints, database-derived billing disposition, credential-mode reservation, and managed-cost reconciliation.

Both credential tables have RLS enabled, no authenticated policy, and explicit `anon`/`authenticated` privilege revocation. The existing clinic-scoped service client now classifies both tables so every server read receives an injected clinic filter. The settings page receives only the safe metadata projection; platform operators receive no credential surface.

Provider tests return only `valid`, `invalid`, `insufficient_scope`, `quota`, or `provider_unavailable`. Provider payloads are discarded. The global Sentry scrubber now filters Anthropic/provider key shapes in addition to credential-bearing object keys and encrypted bytea envelopes.

## Primary-Admin Settings Experience

- Added an entitlement-aware, primary-admin-only **Settings → AI provider** page.
- Added accessible managed/strict/hybrid controls, explicit hybrid billing/data-route disclosure, current-password reauthentication, one-way credential entry, typed health, fingerprint/timestamps, test action, and destructive revoke confirmation.
- Added complete English and Arabic strings, logical RTL styling, localized server-action errors, settings navigation, breadcrumbs, and page metadata.
- Direct URL access fails closed for managers, secondary admins, and clinics without the existing AI entitlement. Database lifecycle RPCs independently enforce the primary-admin boundary.

## Operational Documentation

`docs/runbooks/P4_5B_AI_CREDENTIAL_ROTATION.md` documents normal provider-key rotation, emergency revocation, versioned ClinicFlow encryption-key rotation, encryption-key compromise response, safe metadata verification, and the conditions for removing an old key version.

## Files Added

- `actions/ai-provider.ts`
- `app/(protected)/settings/ai/page.tsx`
- `components/settings/ai-provider-settings.tsx`
- `lib/ai/platform/credential-crypto.ts`
- `lib/ai/platform/provider-connections.ts`
- `lib/ai/platform/tenant-provider.ts`
- `supabase/migrations/20260719130000_p45b_ai_provider_connections.sql`
- `tests/unit/actions/p45b-ai-provider-actions.test.ts`
- `tests/unit/ai/p45b-credential-crypto.test.ts`
- `tests/unit/ai/p45b-provider-routing.test.ts`
- `tests/unit/db/p45b-ai-provider-connections-migration.test.ts`
- `tests/unit/integration/p45b-ai-provider-connections.test.ts`
- `docs/runbooks/P4_5B_AI_CREDENTIAL_ROTATION.md`
- `docs/reports/P4_5B_IMPLEMENTATION.md`

## Verification

- `pnpm typecheck` — passed.
- `pnpm test` — passed: 165 files, 936 tests.
- Complete local-Supabase integration suite — passed: 20 files, 169 tests.
- P4.5B local-Supabase integration suite — passed: 1 file, 4 end-to-end lifecycle scenarios covering authenticated/cross-clinic/non-primary denial, atomic rotation, strict zero-managed-spend reconciliation including idempotent retry, persisted hybrid consent/fallback audit, and destructive revocation.
- Full migration-chain rebuild with `supabase db reset --local` — passed; P4.5B applied cleanly from a fresh database.
- `pnpm lint` — passed with 0 errors and 25 pre-existing unrelated warnings.
- `supabase db lint --local --level error` — passed.
- `pnpm lint:rtl` — passed.
- `pnpm lint:i18n` — passed.
- `pnpm i18n:missing` — passed: 2,637 matching base leaf messages.
- `pnpm i18n:unused` — passed.
- `pnpm build` — passed with the `/settings/ai` route included in the Next.js 16.2.6 production build.
- `git diff --check` — passed.

The cryptographic suite covers randomized envelope output, round-trip decryption, missing/invalid keys, old-version decryption during rotation, ciphertext tampering, and clinic/credential AAD mismatch. Provider routing tests prove strict mode never constructs managed routing, hybrid audits before managed execution, audit failure prevents managed spend, fallback becomes sticky for later model steps, and unclassified request failures do not trigger fallback. Action tests cover the primary-admin boundary, entitlement/rate-limit gates, one-way action responses, hybrid consent, and reauthentication for rotation/revocation.

No live tenant provider request was made. The health probe and direct-provider behavior are covered by typed mocks; database security and accounting behavior run against local Postgres/Supabase.

## Review Fixes (docs/reviews/P4.5B_REVIEW.md)

Applied after the independent P4.5B review. Architecture and P4.5B behavior are preserved; every fix ships with test coverage.

### L1 — Primary-admin app/DB parity (fixed)

`lib/primary-admin.ts::getPrimaryClinicAdminId` now mirrors the database authority `assert_primary_ai_provider_admin` byte-for-byte: it adds the missing `is_deleted = false` predicate and the deterministic secondary tiebreak `order by created_at asc, id asc`. On exact `created_at` ties or an inconsistent `is_deleted`/`deleted_at` state the application and the database now resolve the same primary admin.

- Test: `tests/unit/lib/p45b-primary-admin.test.ts` asserts the full predicate (role, is_active, is_deleted, deleted_at) and the exact ordered tiebreak, plus null/error fail-closed paths.

### L2 — Hybrid managed split re-derived in SQL (fixed)

The 7-arg `reconcile_ai_budget` wrapper no longer trusts the application-supplied managed/direct split for `hybrid`. After the inner reconcile inserts the immutable, trigger-classified attempts, the wrapper re-derives the managed portion in SQL as `sum(final_cost_micros) where billing_disposition = 'managed_included'` for the reservation, and requires the caller-supplied value to equal it (fail-closed `AI_BUDGET_INVALID_MANAGED_COST` on mismatch — the whole `SECURITY DEFINER` transaction rolls back). `managed` (managed == actual) and `byok_strict` (managed == 0) remain structurally enforced as before. `lib/ai/platform/execution.ts` was aligned so its hybrid `managedCostMicros` mirrors the DB trigger exactly (only a successful post-fallback attempt is `managed_included`; pre-fallback and failed attempts are direct/nonbillable), so the supplied split always matches the DB-derived sum.

- Tests: `tests/unit/db/p45b-ai-provider-connections-migration.test.ts` asserts the SQL re-derivation; `tests/unit/ai/p45b-hybrid-accounting.test.ts` proves the app-side computation excludes pre-fallback and failed attempts; the integration test below locks the end-to-end seam and the tamper rejection.

### L3 — Wrapper service-role symmetry (fixed)

The 20-arg `reserve_ai_budget` and 7-arg `reconcile_ai_budget` wrappers now carry their own leading `auth.role() = 'service_role'` check (`AI_BUDGET_NOT_AUTHORIZED`, `42501`) before any validation or `SELECT … FOR UPDATE`, matching the other P4.5B RPCs and the inner P4.5A functions. EXECUTE remains service-role only; this is defense-in-depth if a future grant widens.

- Test: `tests/unit/db/p45b-ai-provider-connections-migration.test.ts` asserts at least four leading service-role guards across the P4.5B RPCs.

### L4 — BYOK request cap: documented product decision (implemented per roadmap)

The review flagged that strict/hybrid reservations still consume one `ai_messages` legacy unit and asked for a deliberate decision. Per the roadmap (`docs/AI_AGENT_PLAN.md` §8): `ai_messages` is retained as a ClinicFlow **request / fair-use cap**, not a managed-token cost meter — "P4.5 retains `ai_messages` as a backward-compatible request/UX cap"; "keep `usage_counters.ai_messages` for compatibility and simple quota UX"; and decisively, "**BYOK clinics remain subject to ClinicFlow authorization, safety, fair-use, request/concurrency limits, and platform fees even when provider token cost is billed directly to them.**" The correct product decision is therefore to **retain** the request unit for every credential mode; decoupling it from BYOK is explicitly not the roadmap position. This is now documented at the point of enforcement in `lib/ai/platform/execution.ts` (a BYOK clinic still consumes one request unit per successful turn; only its provider token spend is removed from the included-credit pool). No code path was changed to decouple it.

- Test: the strict-BYOK integration scenario asserts a strict reservation still consumes an `ai_messages` request unit (`legacy_used >= 1` and `usage_counters.ai_messages.used >= 1`).

### L5 — Hybrid mixed-cost reconciliation integration test (added)

`tests/unit/integration/p45b-ai-provider-connections.test.ts` gains an end-to-end hybrid scenario with a real fallback (`managed_cost > 0`): a pre-fallback direct success (`byok_provider_direct`), a fallback marker (`nonbillable_failed`), and a post-fallback managed success (`managed_included`). It asserts `spent_micros` increases by exactly the managed portion (100 of 140 micros — the 40-micros direct BYOK spend is removed in the same transaction), the three per-attempt billing dispositions, and that a tampered managed split (60 ≠ DB-derived 100) is rejected with `AI_BUDGET_INVALID_MANAGED_COST` while leaving the reservation `reserved` (transaction rolled back). This locks the `execution.ts` → wrapper hand-off for the hybrid path.

### Review-fix validation

- `pnpm typecheck` — passed.
- `pnpm test` (unit, integration excluded) — passed: 167 files, 942 tests.
- `pnpm test:integration` (local Supabase) — passed: 20 files, 170 tests (P4.5B suite: 5 scenarios incl. the new hybrid mixed-cost reconciliation).
- `supabase db reset --local` — passed; the full migration chain including the edited P4.5B migration applies cleanly from a fresh database.
- `supabase db lint --local --level error` — passed.
- ESLint (changed files) — passed, 0 warnings.
- `git diff --check` — passed (clean).

## Intentional Scope Boundary

- No arbitrary provider, model, prompt, or tool selection was added.
- No P5 patient tools or patient automation was added.
- No P4.5C catalog rename, namespaced entitlement migration, add-on billing, operator usage UI, or commercial plan mutation was added.
- No managed fallback is configured outside the explicit hybrid policy.
- No live tenant provider credential is used by the automated suite; provider behavior is tested with AI SDK models and local database integration fixtures.
