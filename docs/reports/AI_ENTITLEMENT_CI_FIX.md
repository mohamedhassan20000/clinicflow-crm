# AI entitlement & CI failure fix — Pro + AI as the superset plan

**Date:** 2026-08-17
**Branch:** `feat/p7-manual-qa-polish`
**Failing run analysed:** GitHub Actions run `31994176624`, job “Lint · Typecheck · Unit tests”
(8 integration files failed, 46 failed tests + 1 failed suite).

---

## 1. Root causes

Four distinct causes produced the whole failure list. Everything else in the CI log was
a cascade of one of them.

### 1.1 The Pro + AI catalog row was not a superset (primary cause)

Phase 0b (`20260813130000_ai_entitlement_plan_decoupling.sql`) correctly moved AI
entitlement off the plan slug and into `public.effective_ai_feature`, which resolves four
inputs: active subscription → accepted AI terms → the `ai_assistant` umbrella → a
per-feature grant. The resolver was right; the catalog it reads had drifted.

The `pro_ai` plan row still stored `ai.patient_auto: false`, `ai.hybrid_fallback: false`
and `ai.followup_generation: false`, and any AI capability key introduced after the row
was last edited was simply absent, which also resolves false. The highest paid plan was
therefore failing entitlement on capabilities it sells:

- `AI_PROVIDER_MODE_NOT_ENTITLED` — `reserve_ai_budget` and the
  `ai_clinic_provider_policies` entitlement trigger both require
  `effective_ai_feature(clinic, 'ai.hybrid_fallback')` for hybrid mode. A Pro + AI clinic
  could hold BYOK and still not be allowed to declare the hybrid policy it had paid for.
- `AI_FEATURE_NOT_ENTITLED` — raised by `resolve_ai_commercial_limits` for the same
  reason on clinics whose fixtures never became entitled at all (see 1.2).

### 1.2 Integration fixtures never accepted AI terms

Phase 0b made `ai_commercial_terms.accepted_at` mandatory for every AI feature — correctly,
since it is the clinic's explicit AI agreement. Fixtures written before Phase 0b create a
clinic on the `pro_ai` plan and stop there, so `effective_ai_feature` returned false for
every key regardless of catalog contents. This is what produced the bulk of the log:

- **“AI analytics not entitled for this clinic”** from `ai_assert_analytics_caller` on
  every `p46a` case, including the ones whose subject is role or grouping validation.
- **Wrong error ordering.** `ai_assert_analytics_caller` checks role → analytics
  entitlement → financial entitlement → per-user financial grant. Tests asserting
  `Financial AI permission not granted` or `Unsupported grouping` got the entitlement
  error instead, because entitlement failed ahead of the assertion's subject. The ordering
  in the guard was never wrong; the fixture never reached the later gates.
- `TypeError: Cannot read properties of null (reading 'buckets_all_time')` etc. — the RPC
  raised, so the test read fields off a null payload.

### 1.3 `ai_workflow_runs` lost its server-authority grants

Phase 4 (`20260813160000_ai_assistant_phase4_orchestration.sql`) retired the workflow-run
ledger in favour of `ai_action_receipts` and, to stop new rows appearing, ran
`revoke insert, update, delete on public.ai_workflow_runs from service_role`.

Removing the grant does not remove a producer — the producer had already been deleted. It
removes the tenant's own server from its retained audit ledger, so retention/backfill work
and the RLS regression suite fail at `beforeAll` with
`permission denied for table ai_workflow_runs` (the one failed *suite* in the log).

### 1.4 Empty-string UUIDs in a fixture masked the real failure

`p45a-ai-budget-ledger` initialised `winningReservationId`/`winningLeaseToken`/
`winningRequestId` to `""`. When the reservation race failed (cause 1.2), those stayed
`""` and were passed to `uuid` RPC parameters, so eight downstream cases reported
`invalid input syntax for type uuid: ""` instead of naming the step that had not run.

---

## 2. Entitlement model after the fix

```
effective_ai_feature(clinic, key) =
      subscription is active or in-trial
  AND ai_commercial_terms.accepted_at IS NOT NULL
  AND umbrella:  clinic override of 'ai_assistant'  ELSE  plan.features->'ai_assistant'
  AND per-feature:
        key = 'ai_assistant'                                    → true
        clinic override of key, else plan.features->key = true  → true
        plan.features->'ai.superset' = true
            AND that effective value is not explicitly false    → true
        otherwise                                               → false
```

- **`pro_ai` is the superset.** The catalog row now carries `ai.superset: true` plus an
  explicit `true` for all 21 supported AI capability keys. Any clinic on `pro_ai` with an
  active subscription and accepted terms clears entitlement for the assistant, patient AI
  (suggest *and* auto), analytics, financial insights, workflows, booking/scheduling,
  documents, bulk export, customization, follow-up generation, managed, BYOK and hybrid.
- **The resolver still never reads a plan slug.** The superset is a catalog value the
  resolver interprets, not a plan name it branches on, so Phase 0b's decoupling holds and
  a future plan can be marked a superset without touching code. This is asserted by
  `tests/unit/ai/phase0b-entitlement-decoupling.test.ts`.
- **One resolver on each side of the boundary.** SQL `public.effective_ai_feature` and
  TypeScript `resolveEffectiveAiFeature` implement the identical rule, including the
  superset step; no RPC carries its own special case. Every downstream guard
  (`resolve_ai_commercial_limits`, `reserve_ai_budget`,
  `enforce_ai_provider_mode_entitlement`, `ai_assert_analytics_caller`, `hasFeature`,
  `hasAiProviderMode`) was left untouched and simply calls the resolver.
- **Overrides stay authoritative in both directions.** An operator's explicit
  `clinic_feature_overrides` row wins over the superset, so a capability can still be
  withheld from, or granted to, a single clinic.
- **A superset plan is not exempt from anything else.** An unaccepted/withdrawn terms row,
  an inactive or expired subscription, or an `ai_assistant: false` override still revokes
  every AI key on a `pro_ai` clinic.

---

## 3. Security behaviour preserved

Plan entitlement answers only *“did the clinic buy this?”*. Every other gate is unchanged
and still enforced, and each has a passing test:

| Invariant | Where enforced | Still verified by |
| --- | --- | --- |
| Role matrix (receptionist ≠ clinic analytics; manager ≠ financial) | `ai_assert_analytics_caller` | `p46a-analytics-rpc-isolation` |
| Per-user financial grant (`user_ai_permissions`), primary-admin-only writes | RLS + guard | `p46-ai-permissions-rls`, `p46a` |
| Tenant isolation on every AI table and aggregate RPC | RLS, `auth_clinic_id()` | `p46a`, `p4a-ai-tools-rls`, `p411a` |
| Patient consent before hybrid fallback / auto replies | reservation + reply path | `p45b-ai-provider-connections`, `p5b-inbox-ai-reply` |
| Budget ceiling, single-claimant reservation, immutable ledger | `reserve_ai_budget`, triggers | `p45a`, `p45c` |
| Provider-policy mismatch and connection health | `reserve_ai_budget` | `p45b` |
| Small-cell suppression / non-reversible aggregates | analytics RPCs | `p46a` |
| Prompt-injection cannot reach an unauthorised tool | authorization oracle | `test:ai-adversarial` |

Specifically on the `ai_workflow_runs` grant: only `service_role` regained
INSERT/UPDATE/DELETE — the trusted server boundary that already holds these on every other
tenant table. `authenticated` still holds `SELECT` only, and the
`ai_workflow_runs_owner_read` policy is unchanged:
`clinic_id = auth_clinic_id() AND user_id = auth.uid()`. Verified in the live database
after a fresh reset. The restored P4.11A suite proves authenticated inserts/updates/deletes
are still denied, cross-tenant reads return nothing, composite tenant integrity holds, and
run confirmation remains server-only and bound to the run owner.

No test was weakened to go green. One was restored: the working tree had rewritten
`p411a-workflow-runs-rls.test.ts` to insert no rows and assert empty results, which made
the permission error disappear at the cost of no longer testing tenant isolation. That file
is back to its committed assertions and passes against the restored grant.

---

## 4. Files changed

**Schema**

- `supabase/migrations/20260817170000_pro_ai_superset_entitlement.sql` *(new)* — marks
  `pro_ai` with `ai.superset` and spells out its 21 AI capability keys; redefines
  `public.effective_ai_feature` with the superset step and override precedence; restores
  `grant insert, update, delete on public.ai_workflow_runs to service_role`; refreshes the
  `plans.features` and `ai_workflow_runs` comments.

**Application**

- `lib/ai/commercial-policy.ts` — exports `AI_SUPERSET_FEATURE`; `resolveEffectiveAiFeature`
  now mirrors the SQL rule exactly (explicit `false` still denies).

**Tests updated because the old assumption conflicts with the unified model**

- `tests/unit/lib/entitlements.test.ts` — the `PRO_AI_FEATURES` catalog mirror now matches
  the shipped row; adds coverage for an unlisted capability on a superset plan, an operator
  override withholding a capability from a superset plan, and the superset never outranking
  terms / umbrella / subscription.
- `tests/unit/ai/phase0b-entitlement-decoupling.test.ts` — the authoritative resolver
  migration is now the superset one; adds assertions that the superset comes from the
  catalog marker and that overrides still win. All slug-free assertions retained.
- `tests/unit/integration/p45c-ai-commercial-integration.test.ts` — Pro + AI now asserts
  `ai.hybrid_fallback: true` and `ai.superset: true`, and that the marker does **not**
  appear on `basic`/`pro`.
- `tests/unit/integration/dev-clinic-pro-ai-entitlement.test.ts` — the expected capability
  list is the full set; the “withheld” list must now be empty.

**Test fixtures corrected (no assertion weakened)**

- `p45a-ai-budget-ledger`, `p45b-ai-provider-connections`, `p46-ai-permissions-rls`,
  `p46a-analytics-rpc-isolation`, `p5a-patient-tools-booking`, `p5b-inbox-ai-reply` — seed
  an accepted `ai_commercial_terms` row and clean it up.
- `p45a-ai-budget-ledger` — the three captured ids are `string | null` initialised to
  `null` and read through a `captured()` guard that names the missing step, instead of `""`
  reaching a `uuid` parameter.

**Test restored**

- `tests/unit/integration/p411a-workflow-runs-rls.test.ts` — reverted to its committed
  assertions.

---

## 5. Tests run and final results

Run in CI order, against a **freshly reset** local Supabase (migrations only, no seed), so
the database matches what `supabase start` produces in CI.

| Gate | Command | Result |
| --- | --- | --- |
| Lint | `pnpm lint` | ✅ 0 errors (28 pre-existing warnings) |
| RTL gate | `pnpm lint:rtl` | ✅ 694 files, 17 documented exceptions |
| i18n source gate | `pnpm lint:i18n` | ✅ 447 files, 41 documented exceptions |
| i18n parity | `pnpm i18n:missing` | ✅ 4107 base leaf messages |
| i18n unused | `pnpm i18n:unused` | ✅ no unreferenced keys |
| Typecheck | `pnpm typecheck` | ✅ clean |
| CI unit set | `pnpm vitest run tests/unit/{actions,components,db,lib,pages,security} tests/unit/sanity.test.ts` | ✅ 297 files, 1836 tests |
| Full unit suite (incl. `test:ai-adversarial`) | `pnpm test` | ✅ 381 files, 3087 tests |
| Integration | `pnpm test:integration` | ✅ 56 files, 509 passed, 3 skipped, 1 file skipped |
| Build smoke | `pnpm build` | ✅ compiled |

Before the fix, on the same fresh database: **8 integration files failed — 46 failed tests
and 1 failed suite.** After: **0 failures across every gate.**

---

## 6. Remaining risks

1. **Hybrid fallback is now entitled by default on Pro + AI.** Entitlement is not
   activation: `ai_clinic_provider_policies.credential_mode` must still be set to `hybrid`,
   persisted hybrid consent must exist, and a healthy BYOK connection is required before
   any fallback happens. The change means an operator no longer has to add a per-clinic
   override first. If hybrid should stay commercially opt-in, express that as an explicit
   `ai.hybrid_fallback: false` override per clinic — the resolver honours it.
2. **`ai.patient_auto` is entitled by default on Pro + AI.** Automatic patient replies
   still require the patient-AI settings toggle and per-patient consent; the P7 QA override
   for clinic `caf2711f-…` is now redundant but harmless. Worth a conscious product
   confirmation that “entitled” is the intended default for auto-reply.
3. **A future AI capability is entitled on Pro + AI the moment it exists.** That is the
   point of the superset, but it means a capability must be gated by role, consent or a
   dedicated permission — not by withholding it from the top plan.
4. **`service_role` can write `ai_workflow_runs` again.** No runtime producer exists; if
   one is ever reintroduced it must go through `ai_action_receipts` instead. The
   `authenticated` boundary and RLS are unchanged, so this is a server-authority grant
   only.
5. **Local/CI drift found on the way.** The local database had migration
   `20260817160000_p7e_activate_whatsapp_provider_enum_cast` applied from an untracked
   file; it is present in the working tree but not yet committed. It must be committed with
   this work or CI will keep running a different schema than local.
6. **Not re-verified here:** Playwright e2e (`pnpm test:e2e`, needs `PORT=3100`) is outside
   the CI job and was not run.
