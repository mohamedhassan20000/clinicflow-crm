# AI Assistant — Phase 0b Implementation Review (re-review after fixes)

**Scope reviewed:** Phase 0b only, against `docs/AI_ASSISTANT_FULL_CAPABILITY_PLAN.md` §15 (Phase 0b), §5 (plan-tier design), §16 (entitlement-decoupling test plan), §17 A7/A7b and §19 Decision 3. This is the second pass, verifying the fixes for P0B-1 … P0B-5 from the first pass.

**Verdict: Phase 0b — PASS**, with one new Low follow-up (P0B-6) that does not block the phase.

All five findings from the first review are genuinely resolved in the real code, migration, operator flow and tests — not merely asserted. Each was re-verified against the live schema after a full `supabase db reset`, and the discriminating power of the new tests was proven by four negative controls that reverted the fixed behaviour and observed the intended tests fail. The one new finding, P0B-6, is a visibility gap in the operator audit timeline introduced by the P0B-4 fix; the underlying audit records are written correctly, no entitlement path is affected, and no Phase 0b acceptance criterion is violated. No production code was modified during this review.

---

## Verification performed

| Check | Result |
| --- | --- |
| `pnpm typecheck` | clean |
| `pnpm lint` | **0 errors**, 25 pre-existing warnings (unchanged; all in untouched P7/validation files) |
| `pnpm test` (unit) | 333 files, **2396 passed** |
| `supabase db reset` from committed migrations | applies cleanly through `20260813130000`; no manual repair needed |
| `pnpm test:integration` (fresh reset, migration applied) | 49 passed / 1 skipped files, **424 passed / 3 skipped** |
| `pnpm i18n:missing` / `i18n:unused` | parity clean (3949 base leaves); no unreferenced keys |
| Live-schema scan after reset: every `public` function whose body contains `pro_ai` | **zero rows** |
| TS scan: `planSlug` / `pro_ai` under `lib/`, `actions/`, `app/`, `components/` | no AI-resolution hit. Remaining `planSlug` uses are catalog assignment and audit display only (`actions/operator.ts:72,85,92,117`, `lib/supabase/admin.ts:1654`, the plan `<select>` at `page.tsx:346`) |
| Live schema: `ai_commercial_terms.accepted_at` | `column_default` empty, `is_nullable = YES` — the default is gone from the installed table, not only from the migration text |
| Historical migrations | `git diff supabase/migrations/` is **empty**; `20260727180000_p5a_patient_tools_booking.sql` and `20260808120000_p7phase6_patient_ai_auto_entitlement.sql` are byte-identical to their committed state |
| Phase 1+ leakage | `lib/ai/resources/**` and `lib/ai/actions/**` do not exist; `lib/ai/tools/**`, `lib/ai/authorization.ts`, `lib/ai/prompts/**`, `lib/ai/staff-agent.ts`, `lib/ai/capabilities.ts`, `lib/ai/workflows/**`, `components/assistant/**` are all clean in `git status`. No RAG work (Decision 8 respected) |
| Unrelated dirty work | The ~60 other dirty files remain the pre-existing P7 document work. `lib/supabase/admin.ts` and `messages/{en,ar}.json` carry both, in disjoint regions: the P7 hunks (`findCompletedClinicDocument`, `taxInvoiceNote` removal) are untouched. The three other AI files in the diff (`lib/ai/conversations.ts` = Phase 0 `sequence`; `lib/ai/patient-reply-mode.ts`, `lib/ai/platform/execution.ts` = comment-only de-coupling wording) contain no behaviour change |
| `types/database.ts` | +6 lines only (`sequence`, `accepted_at`), hand-added surgically — no regen drift |

### Negative controls (installed function replaced, tests re-run, then restored from the migration's own DDL)

| Control | Reverted behaviour | Observed |
| --- | --- | --- |
| **A — strict SQL feature parsing** | `plan.features -> k = 'true'::jsonb` → `(plan.features ->> k)::boolean` | *"fails closed without errors for non-boolean plan feature JSON"* failed (`"true"` string resolved `true`); **nothing else failed** |
| **B — terms predicate** | `terms.accepted_at is not null` → `true` | *"does not accept stale Basic overrides through an unrelated terms insert"* and *"revokes every AI feature without changing the plan or overrides"* both failed |
| **C — Decision-3 credit gate** | the `? 'ai_credits_month'` / `jsonb_typeof … <> 'number'` / `<= 0` block deleted | *"fails closed when an AI-granting plan has no monthly AI credit limit"* failed (`AI_BUDGET_INVALID_COMMERCIAL_LIMITS` instead of `AI_FEATURE_NOT_ENTITLED`); nothing else failed. The `pro` fixture still reaches the credit branch via its `beforeAll` `ai_assistant` override, so the guard remains discriminating |
| **D — slug-gated resolver** | `plan.slug = 'pro_ai'` re-added to `effective_ai_feature` | **6 tests across 3 files failed**, including `p49a-assistant-customization-rls.test.ts` *"keeps today's customization seed while allowing another plan row to carry it"* — the exact acceptance criterion stated for P0B-5 — plus `p46a` Basic-admin analytics and the three `p45c` decoupling tests |

After each control the function was restored from `20260813130000`'s own DDL and the full integration suite re-run green (424 passed / 3 skipped), so the local stack is back to its post-migration state.

---

## Finding-by-finding resolution

### P0B-1 — Stale AI overrides on a non-`pro_ai` plan *(Medium)* — **RESOLVED**

The backfill now takes the guard branch of the stated acceptance criteria rather than the production-query branch, which is the stronger of the two. `20260813130000:16-27` restricts the `accepted_at` backfill of existing rows to `plan.slug = 'pro_ai'`, and `:32-80` restricts the compatibility insert to `plan.is_active and plan.slug = 'pro_ai'` **and** an effective umbrella. A Basic or Pro clinic holding an enabled `ai_assistant` override therefore receives no terms row, and `effective_ai_feature` denies it on every key exactly as before the phase. The `plan.slug = 'pro_ai'` literals are confined to the one-time backfill, are commented as such (`:67-69`), and are outside both resolvers — the live-schema scan for `pro_ai` in function bodies still returns zero rows.

Covered behaviourally, not only by static text: `p45c-ai-commercial-integration.test.ts` *"does not accept stale Basic overrides through an unrelated terms insert"* takes the Basic fixture — which carries enabled `ai_assistant`, `ai.staff_assistant` and `ai.managed` overrides from `beforeAll` — adds an `ai.read_operational` override, inserts a terms row without naming `accepted_at`, and asserts the column is NULL and the clinic still resolves `false`. *"denies unsigned clinics on every AI key regardless of plan or overrides"* asserts the same for a `pro_ai` clinic holding every AI override. Negative control B proves both discriminate.

### P0B-2 — SQL/TS fail-open divergence on non-boolean feature values *(Low)* — **RESOLVED**

Both terms of `effective_ai_feature` (`:120-132`) and the backfill's umbrella term (`:71-75`) now compare `plan.features -> k = 'true'::jsonb` instead of casting `->>` text, matching `normalizeFeatures`' `typeof entry[1] === "boolean"`. Verified on the installed function (two `'true'::jsonb` occurrences, zero `->>` on `features`). `p45c-ai-commercial-integration.test.ts` *"fails closed without errors for non-boolean plan feature JSON"* covers `"true"`, `"yes"` and `"maybe"` in both the umbrella and the specific-key position, asserts the SQL result equals `resolveEffectiveAiFeature`'s and is `false`, **and** asserts `error` is null — so the `22P02` raise on `"maybe"` is gone, not merely coerced. Negative control A confirms it fails on the old expression. The full TS↔SQL cross-product (plan × override × terms × subscription, §16) is separately covered by *"keeps TS and SQL aligned…"*, driven from the shared `resolveEffectiveAiFeature` definition.

### P0B-3 — In-place edits to applied migrations *(Low)* — **RESOLVED**

`git diff supabase/migrations/` is empty: both historical files are back to their committed content. `20260813130000` remains the sole forward change and still supersedes both paths — it redefines `resolve_ai_commercial_limits` in full and re-issues the P7 patient-auto override through `effective_ai_feature` (`:256-272`). The third case in `phase0b-entitlement-decoupling.test.ts` was re-pointed accordingly: it now asserts *"supersedes the historical P5A and P7 paths in the forward migration"* against `20260813130000` only, and a companion case asserts that migration is the **last** one defining `effective_ai_feature`. A full `supabase db reset` from committed migrations applies cleanly and both suites are green afterwards.

### P0B-4 — Implicit, unconditional, irreversible terms acceptance *(Low)* — **RESOLVED**

- The column is created without a default and `alter column accepted_at drop default` (`:4-8`) removes it where a prior run added one; the live table confirms `column_default` is empty.
- `updateAiCommercialTerms` no longer writes `accepted_at` at all (`actions/operator.ts:257-266`), so the budget form is no longer an acceptance action. The PostgREST upsert updates only the named columns, so saving budgets preserves an existing acceptance rather than resetting it.
- New explicit `acceptAiCommercialTerms` / `revokeAiCommercialTerms` server actions (`actions/operator.ts:288-337`) write `accepted_at` and `null` respectively, audit-log distinct `ai_commercial_terms.accepted` / `.revoked` actions, invalidate the entitlement cache and revalidate the operator paths.
- The operator panel (`page.tsx:373-410`) renders acceptance state as its own row with an accept **or** revoke control, the acceptance timestamp, and a distinct hint when no terms row exists yet. The panel no longer branches on the plan slug — it branches on `history.effectiveAiAssistant`, sourced from the new `effective_ai_feature` RPC.
- TS-side, `Entitlements.aiTermsAccepted` is loaded from `ai_commercial_terms.accepted_at` and consumed by `hasFeature` through the same shared `resolveEffectiveAiFeature`, so revocation denies in both layers. (`ai_commercial_terms` is already in `CLINIC_SCOPED_TABLES`, so the added read is inside the reviewed scope allow-list and does not trip `assertKnownTable`.)
- Every integration fixture that previously relied on the default now sets `accepted_at` explicitly; the suites are green from a fresh reset.
- Tests: `phase0b-operator-ai-entitlements.test.ts` asserts the budget upsert has no `accepted_at` property, that acceptance happens only through the explicit action, and that revocation touches `ai_commercial_terms` alone (`from` called exactly once, never `subscriptions` or `clinic_feature_overrides`). `p45c` *"revokes every AI feature without changing the plan or overrides"* proves the end-to-end effect against the real resolver and snapshots the plan and override rows before and after.

### P0B-5 — Rewritten P4.9A test asserted no entitlement invariant *(Low)* — **RESOLVED**

`p49a-assistant-customization-rls.test.ts:565-628` now grants `ai_assistant` + `ai.assistant_customization` on the Basic plan row, subscribes clinic A to it, inserts accepted terms, and asserts `effective_ai_feature(clinic, 'ai.assistant_customization')` is `true` — then deletes the terms row and asserts `false`, restoring the plan in `finally`. Negative control D (slug-gated resolver) fails precisely this test, which was the stated acceptance criterion.

---

## Remaining finding

### P0B-6 — The new acceptance/revocation audit events never reach the operator clinic timeline *(Low, new)*

**Where:** `lib/supabase/admin.ts:1624-1634` (`SAFE_OPERATOR_CLINIC_AUDIT_ACTIONS`), `:1697-1706` (`safeAuditSummary`), `:1830` (`.in("action", [...])`), against `actions/operator.ts:311-317`.

The P0B-4 fix introduces two new operator actions, `ai_commercial_terms.accepted` and `ai_commercial_terms.revoked`. `logOperatorAction` takes a free-form action string, so both rows are written to `platform_audit_logs` correctly — the compliance record is intact. But the operator clinic-history query filters on `SAFE_OPERATOR_CLINIC_AUDIT_ACTIONS`, which was not extended, and `safeAuditSummary` has no `case` for either, so it would return `null` even if the filter passed. The result: the clinic page's audit timeline shows subscription grants and cancellations, feature-override upserts and removals, and `ai_commercial_terms.updated` — but is silent about the one control that now decides whether the clinic has AI at all. An operator investigating "why did this clinic lose the Assistant?" sees an unchanged plan, unchanged overrides, and no event.

This violates no Phase 0b acceptance criterion and no entitlement path depends on it, hence Low and non-blocking.

**Required fix:** add `"ai_commercial_terms.accepted"` and `"ai_commercial_terms.revoked"` to `SAFE_OPERATOR_CLINIC_AUDIT_ACTIONS` and a corresponding `case` in `safeAuditSummary` (title from the action, no payload fields needed — neither action logs a payload).

**Acceptance criteria:** accepting and then revoking AI terms produces two entries in the operator clinic audit timeline, and a test asserts both actions survive `safeAuditSummary`.

---

## Notes (not findings)

- **Deploy note — the one remaining live-behaviour delta.** The backfill can no longer *grant* AI to any clinic. The single remaining change is a tightening, and it is the intended one: a `pro_ai` clinic with `ai_assistant` overridden **off** but a specific `ai.*` key on was entitled by the old SQL resolver (which checked only the requested key) and is denied now. That makes SQL agree with `hasFeature()`, which has always required the umbrella. Worth confirming on production before deploy, but it is a deliberate correction, not a regression.
- **Deploy note — profile-less clinics.** The compatibility insert resolves `updated_by` through a lateral join to the clinic's earliest admin (else earliest profile). `ai_commercial_terms.updated_by` is `not null` with an FK to `auth.users`, so a `pro_ai` clinic with **zero** profiles cannot be backfilled and would need an explicit acceptance afterwards. This is the correct trade-off — the alternative is minting a synthetic auth identity — and such a clinic has no staff and therefore no live AI usage. Worth checking the count on production before deploy.
- `messages/action-errors/{en,ar}.json:231` still carry `aiRequiresProAi`, now referenced by nothing. `pnpm i18n:unused` does not scan that file, so it passes. Dead copy only; safe to delete whenever that directory is next touched.
- `app/(operator)/operator/clinics/[id]/page.tsx:411-505` — the surviving `<dl>`/`<OperatorActionForm>` block is still over-indented by two levels from the removed ternary. Cosmetic; `pnpm lint` is clean and `pnpm format` would settle it.
- `lib/entitlements.ts:21` — `Entitlements.planSlug` still has no consumer outside its own construction. Harmless for display/audit; it is no longer a gate and must not be reintroduced as one.
- `resolve_ai_commercial_limits` still reads `ai_requests_month`, `ai_messages_month` and `ai_concurrent_requests` with `(… ->> …)::integer`, which would raise `22P02` on a non-numeric value. This predates Phase 0b, is not part of the entitlement decision (a raise there surfaces as a budget error, not a silent grant), and Decision 3's own key `ai_credits_month` is now type-checked. Reasonable to fold into whichever later phase next touches that function.
