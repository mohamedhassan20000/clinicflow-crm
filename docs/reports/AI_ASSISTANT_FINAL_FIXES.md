# AI Assistant — Final Review Fixes (B-1, B-2, Health Care Pro entitlement)

**Author:** Claude
**Date:** 2026-08-15
**Branch:** `feat/p7-manual-qa-polish`
**Baseline:** `01d2d76` (HEAD) + the existing uncommitted working tree
**Fixes:** [docs/reports/AI_ASSISTANT_FINAL_COMPREHENSIVE_REVIEW.md](AI_ASSISTANT_FINAL_COMPREHENSIVE_REVIEW.md) — blocking findings **B-1** and **B-2** only, plus the local development clinic entitlement correction.
**Plan:** [docs/plans/AI_ASSISTANT_FULL_CAPABILITY_PLAN.md](../plans/AI_ASSISTANT_FULL_CAPABILITY_PLAN.md)

**Scope discipline.** No new product scope. No unrelated dirty work touched. Nothing pushed, deployed, or applied remotely.

---

## Summary

| Item | Status |
|---|---|
| **B-1** — `pnpm i18n:unused` red, 21 `documents.catalog` keys reported unused | ✅ **Fixed** — gate green, gate still bites |
| **B-2** — `execute_action` / `describe_action` unmounted for `doctor` and `assistant` | ✅ **Fixed** — mount derived from `AI_ACTION_REGISTRY` |
| **B-2 second-order** — export hatch advertised an unmountable action | ✅ **Fixed** — advisory now follows the mount |
| **Health Care Pro** — local dev clinic not resolving Pro + AI entitlements | ✅ **Fixed** — provisioned as a legitimate `pro_ai` subscriber via a local-only seed |
| Regression coverage for all three | ✅ **Added** — 3 new suites (48 tests), 7 existing suites corrected |
| All required gates | ✅ **Green** (see §5) |

---

## 1 · B-1 — `pnpm i18n:unused` CI gate

### What was wrong

P6-09 needed the document label in an explicitly chosen locale, so `documentTypeLabels()` bound its translator through a ternary:

```ts
const t = locale
  ? await getTranslations({ locale, namespace: "documents.catalog" })
  : await getTranslations("documents.catalog");
```

`scripts/check-messages.mjs` binds a translator variable to a namespace with regexes anchored on a **literal** `getTranslations` initializer ([scripts/check-messages.mjs:222-227](../../scripts/check-messages.mjs#L222-L227)). A ternary initializer matches neither form, so `t` was bound to no namespace, all 21 literal-key lookups became invisible to the scan, and every leaf under `documents.catalog` fell into the unused list. Exit 1 on a required CI job — a pure static-analysis break, with rendered EN/AR output correct throughout.

### How it was fixed

[lib/documents/module-labels.ts](../../lib/documents/module-labels.ts) — the locale is now resolved **before** the translator is bound, so the binding is a single literal object-form call:

```ts
const resolvedLocale = locale ?? (await getLocale());
const t = await getTranslations({
  locale: resolvedLocale,
  namespace: "documents.catalog",
});
```

This is the review's **preferred** option 1: the checker stays honest and nothing was weakened. Specifically **not** done — no key deleted, no key softened, and `documents.catalog` was **not** added to `dynamicNamespaces` (which would have exempted the whole subtree and permanently disabled the gate for exactly the namespace it protects).

**Behavior is preserved.** Omitting the argument to `getTranslations` resolves the *request* locale, which is precisely what `getLocale()` returns, so the no-argument call path is unchanged; the explicit-locale path is byte-identical to before. Both `getDocumentTypeLabels()` and `getDocumentTypeLabel(code, locale)` keep their signatures and their callers are untouched.

### A second defect this fix surfaced

The first draft of the explanatory comment contained an illustrative `t("…")` call. `scripts/check-messages.mjs` scans lexically and **does not skip comments**, so it recorded a reference to a key that does not exist and turned the *other* half of the same gate — `pnpm i18n:missing` — red:

```
Missing catalog keys (1):
en/ar: documents.catalog.… (referenced in source, absent from catalogs)
```

Caught by running the gate, fixed by rewording, and now pinned by a dedicated test plus an in-file note for future editors. Reported here rather than quietly dropped because it is a real trap in this file.

### Verification

```
$ pnpm i18n:unused    → ✓ unused messages: no unreferenced keys.       (exit 0)
$ pnpm i18n:missing   → ✓ message parity: 3988 base leaf messages.     (exit 0)
$ pnpm lint:i18n      → ✓ 439 files scanned · 43 documented exceptions (exit 0)
```

**The gate still bites** (the review's acceptance criterion). Probed by deleting one lookup:

```
$ perl -pi -e 's/REVENUE_REPORT: t\("revenueReport"\),/REVENUE_REPORT: "x",/' lib/documents/module-labels.ts
$ pnpm i18n:unused
Unused catalog keys (1):
documents.catalog.revenueReport                                        (exit 1)
```

### Regression coverage — `tests/unit/lib/final-b1-document-label-i18n.test.ts` (5 tests)

1. The translator binding matches one of the two shapes the checker recognises, and resolves to `documents.catalog`.
2. Every `documents.catalog` leaf key in `messages/en.json` is referenced by string literal in the module (≥ 21).
3. The real `check-messages.mjs unused` run — the CI job itself, not a re-implementation — exits 0 and names no `documents.catalog` key.
4. The real `check-messages.mjs missing` run exits 0 — the trap above, pinned.
5. **The gate bites**: the test writes a patched tree with one lookup removed, drives the real checker, requires exit 1 naming that exact key, and restores the file in a `finally` (then asserts byte-identical restoration).

Driving the real script rather than re-implementing its regexes is deliberate: a second copy of the binding logic is exactly the thing that drifted here in the first place.

---

## 2 · B-2 — the write surface was unreachable for `doctor` and `assistant`

### What was wrong

`execute_action` and `describe_action` declared a hand-written role list:

```ts
const ADMINISTRATIVE: readonly UserRole[] = ["admin", "manager", "receptionist"];
```

Correct in Phase 3, when no registered action authorized a doctor or an assistant. Never widened when Phases 5c and 6 landed **21 doctor-authorized** and **22 assistant-authorized** actions. Since `resolveToolMount` filters on `definition.roles.includes(ctx.user.role)`, the only tool able to invoke *any* registered write did not exist in those two roles' worlds — the entire clinical-authoring surface (prescriptions, lab requests, sick leaves, medical notes, appointments, documents) was unreachable for the roles that own it. Plan §5's "gates 5 and 6 are the only two gates that may exist above app authorization" and §15 Phase 5's acceptance criterion were both unmet, and the mount contradicted [`documents.ts`](../../lib/ai/actions/definitions/documents.ts)'s own in-code rationale one layer down.

### How it was fixed

The review's **strongly preferred** direction (widen), implemented as the task required: **derived, not re-listed, and not a new hard-coded AI role list.**

[lib/ai/tools/registry.ts](../../lib/ai/tools/registry.ts):

```ts
export const ACTION_CAPABLE_ROLES: readonly UserRole[] = ALL_STAFF.filter(
  (role) => AI_ACTION_REGISTRY.some((action) => action.roles.includes(role)),
);

export function roleMountsActionTools(role: UserRole): boolean {
  return ACTION_CAPABLE_ROLES.includes(role);
}
```

Both generic action tools now carry `roles: ACTION_CAPABLE_ROLES`. A role mounts the action tools **iff at least one registered action authorizes that role**. This makes the defect's whole class structurally impossible: the tool-level list can no longer drift from the registry, because it *is* the registry. Registering the first action for a role mounts the tool by construction; removing the last one unmounts it.

The derivation source is the real application authorization model — every action's `roles` array is copied from the domain core it binds (`CLINICAL_MUTATION_ROLES`, `MEDICAL_NOTE_WRITE_ROLES`, `APPOINTMENT_*_ROLES`, `FOLLOWUP_*_ROLES`, `SETTINGS_*_ROLES`, `PRIVILEGED_*_ROLES`), and Phase 5's equivalence tests already assert that correspondence for all 89 actions × 5 roles.

### What was explicitly preserved

Mounting the tool grants **nothing**. Every gate re-asserts independently inside `assertActionAccess` ([lib/ai/actions/execute.ts:106-147](../../lib/ai/actions/execute.ts#L106-L147)), at preview **and** again at execute after the confirm token is burned:

| Gate | Status |
|---|---|
| Per-action `roles` | ✅ unchanged — the authority |
| Plan entitlements (`requiredFeatures` → `hasFeature` → `resolveEffectiveAiFeature`) | ✅ unchanged |
| Per-user AI permission (`requiredUserPermission`) | ✅ unchanged |
| Page visibility (`pageSlug` → `getPageVisibilityState`) | ✅ unchanged |
| RLS / tenant predicate | ✅ unchanged — no code path touched |
| Confirmation (preview → on-screen confirm → single-use token) | ✅ unchanged |
| Re-authorization at execute | ✅ unchanged |
| Step-up reauth, privileged binding, 2-min TTL, rate limits | ✅ unchanged |
| Receipts on allow **and** deny, both phases | ✅ unchanged |
| **`staff_help` containment** | ✅ **preserved** — the action tools declare `SHARED_TASKS`, which excludes `staff_help`, so a help turn still mounts only the three data-free guidance tools |

**Doctor and assistant reach only what their own definitions authorize.** Verified: a doctor gets `prescriptions.*`, `lab_requests.*`, `sick_leaves.*`, `medical_notes.*`, `appointments.{replace,undo_status,start_session}`, `documents.{issue,reprint}`; an assistant gets the clinical drafts plus `appointments.{create,replace,update_status,arrive,confirm_and_displace}`, `followups.{record,update}`, `billing.complete_appointment`, `documents.{issue,reprint}`. Neither reaches `staff.change_role`, `staff.permanent_delete`, `assistant.reference_check`, `appointments.send_reminders`, or `invoices.send_reminders`. **No over-grant was introduced** — the registry's role lists are untouched.

### Second-order defect — the export hatch

[lib/ai/resources/export-hatch.ts](../../lib/ai/resources/export-hatch.ts) promised the suggestion "can never advertise a capability that would then be denied", but checked only catalog role, plan feature and report visibility — never whether the caller could mount `execute_action` at all. Fixed with an explicit check:

```ts
if (!roleMountsActionTools(user.role)) return null;
```

With B-2 fixed this is currently always true for the roles that reach the hatch, so the check is redundant *today* — which is the point. It makes the module's stated invariant hold **structurally** rather than incidentally, so a future narrowing of the action mount cannot silently reintroduce guidance naming `documents.issue` to a role that cannot invoke it. Verified in both directions by unit test.

### Doctor system prompt

[lib/ai/prompts/doctor.ts](../../lib/ai/prompts/doctor.ts) described a strictly read-only persona ("Your role is strictly clinical information retrieval and summarization"). Left as-is it would have re-imposed in prose the AI-local restriction the mount fix removed. Rewritten in **both** EN and AR to describe the authorized write surface, deliberately capability-*neutral* — it names no action, directs the model to `describe_action` for the caller's real authorized set, and repeats that every change is a preview requiring on-screen confirmation. The existing action-safety clause in [`staff.ts`](../../lib/ai/prompts/staff.ts) (which both personas already receive) is unchanged.

### Adversarial corpus — a containment claim that was resting on the defect

Three `privilege_escalation` cases (`inj-en-escalate-02`, `-03`, `-escalate-privileged-01`) proved containment by asserting `execute_action` was **not mounted** for a doctor. That was true only *because of* the defect, never because it was the intended control — and it would have gone green forever while the doctor's whole write surface stayed broken.

[lib/ai/eval/injection-corpus.ts](../../lib/ai/eval/injection-corpus.ts) gains a `forbiddenAction` field, and those three cases now assert containment where the authority actually lives: **the targeted action is not authorized for the session's own role**, and `assertActionAccess` refuses it. This is strictly stronger than what it replaces, because it survives the tool being mounted. Both a structural assertion (in the injection suite, against the live registry, additionally asserting `execute_action` *is* reachable so the denial is genuine) and a behavioural one (in the B-2 suite, driving the real `previewRegisteredAction` and requiring `unauthorized_role` with no token minted) are driven off the corpus, so the two cannot drift.

### Regression coverage — `tests/unit/ai/final-b2-action-reachability.test.ts` (21 tests)

**Agreement (the review's acceptance criterion).** Parametrized over all 5 roles × all registered actions: an action is reachable through the mounted tool set **iff** `assertActionAccess` allows it, plus `mounted.has("execute_action") === (authorized.size > 0)` in both directions. Also asserts both tool definitions carry `ACTION_CAPABLE_ROLES` *by reference*, so re-hard-coding either one fails here.

**The probe the review demanded.** Reverting the mount to `ADMINISTRATIVE` fails this suite:

```
× mounts the action tools for exactly the roles the registry authorizes an action for
× doctor: an action is reachable through the mount iff assertActionAccess allows it
× assistant: an action is reachable through the mount iff assertActionAccess allows it
Tests  3 failed | 15 passed
```

**End-to-end.** A doctor completes `prescriptions.create_draft` through preview → confirm (asserting the domain core is invoked in `"preview"` mode first and `"execute"` mode after) with `allowed` receipts finalized for **both** phases; an assistant completes `appointments.create` the same way.

**Negative cases.** Parametrized denials — doctor × {`appointments.send_reminders`, `staff.change_role`, `assistant.reference_check`}, assistant × {`invoices.send_reminders`, `staff.change_role`, `medical_notes.create`} — each returning `unauthorized_role` with a `denied` receipt; the three corpus `forbiddenAction` cases driven through the same pipeline; and a token-holding cross-role execute attempt refused.

**Export hatch.** Returns `null` for a caller that cannot mount the action tools; returns the suggestion for a doctor now that the mount exists.

### Existing tests corrected (they locked the defect in)

| File | Change |
|---|---|
| `tests/unit/ai/phase4-orchestration.test.ts` | The hard-coded `role === "admin" \|\| "manager" \|\| "receptionist"` expectation is now **derived from `AI_ACTION_REGISTRY`**, so it can no longer be satisfied by a stale list; `describe_action` asserted alongside |
| `tests/unit/ai/phase7-capability-surface.test.ts` | "offers no action to a role the executor never authorizes" → asserts the doctor's/assistant's real surface equals `describeAuthorizedActions`, **plus a new negative test** that every advertised action names that role in its own `roles` list and that admin-only actions stay admin-only |
| `tests/unit/ai/p46a-staff-analytics-tools.test.ts` | Doctor/assistant exhaustive mount lists gain the two action tools; analytics/financial exclusions unchanged |
| `tests/unit/ai/p4a-doctor-tools.test.ts` | Same, for the five-role mount comparison |
| `tests/unit/ai/p6a-injection-suite.test.ts` | Corpus-integrity assertions moved to `forbiddenAction`; new action-level containment block; new "references only real action ids" check |
| `tests/unit/components/phase7-capability-panel.test.tsx` | Comment only — the empty-actions render contract still holds (for an unentitled clinic), but it is no longer the doctor case |
| `tests/e2e/p4b-assistant.spec.ts` | The doctor panel now asserts an actions section **is** present; the distinguishing claim between the doctor and admin accounts became the *privileged* badge, asserted absent for the doctor and present for the admin, in both locales, with the same Axe budget |

One deliberate note on counts: `pnpm test:ai-adversarial` moved **138 → 136** tests. Fully accounted for: three cases left the two `forbiddenTool` `it.each` blocks (−6) and entered the new action-containment block (+3), plus one new corpus-integrity test (+1). Their behavioural coverage was **not** lost — it moved to the B-2 suite, driven off the same corpus entries, and is stronger there (real pipeline denial rather than absence-from-mount).

---

## 3 · Health Care Pro — local development clinic entitlement

### What was actually wrong

**No clinic named Health Care Pro existed in the local Supabase database.** Queried directly:

```
$ docker exec supabase_db_clinic-crm psql -U postgres \
    -c "select id, name from clinics where name ilike '%health%' or name ilike '%care%';"
(0 rows)
```

All 421 clinics in the local database are ephemeral test fixtures with generated suffixes (`P4A Clinic A p4a-1786810379138-…`). There is no `supabase/seed.sql` and no dev-clinic seed script — the only seed in the repo is `scripts/seed-marketing-demo.ts`, which creates a different, Basic-plan clinic. So Health Care Pro was created by hand through the app and did not survive a database reset.

That is also the root cause of the Assistant's message. A clinic re-created through signup lands on the **Basic** 14-day trial with **no `ai_commercial_terms` row**. Phase 0b makes AI entitlement the conjunction of *(allowed subscription ∧ accepted terms ∧ the `ai_assistant` umbrella ∧ the individual key)* — `resolveEffectiveAiFeature`, mirrored in SQL by `effective_ai_feature`. On that shape every `ai.*` key resolves `false`, so `assistant.upgradeDescription` ("AI is available only on Pro + AI") renders. **The message was accurate; the fixture was wrong.** Nothing was masked.

### How it was fixed

New local-only seed: **[scripts/seed-dev-clinic.ts](../../scripts/seed-dev-clinic.ts)**, wired as `pnpm dev:seed-clinic`. It provisions Health Care Pro as an ordinary Pro + AI subscriber using exactly the rows an operator grant would create:

- `clinics` — the workspace (fixed id `93000000-0000-4000-8000-000000000001`)
- `subscriptions` — `plan_id` → the **`pro_ai`** plan row, `status: "active"`, `current_period_end` ~1 year out, `trial_ends_at: null` (so `resolveSubscriptionAccess` allows)
- `ai_commercial_terms` — `accepted_at` set (the acceptance the entitlement model requires **in addition to** the plan)
- `profiles` — one active user per staff role (admin, manager, receptionist, doctor, assistant), so the whole role matrix including the B-2 write surface is manually reachable
- `assistant_doctor_assignments` — the assistant is assigned to the doctor, otherwise its entire scope is empty and it is indistinguishable from a broken account

It is idempotent (upserts throughout), and it **refuses any Supabase host that is not `127.0.0.1`/`localhost`**, mirroring the existing marketing-demo guard.

**What it deliberately does not do**, per the constraints:

- ❌ No clinic-name special case anywhere — the name appears only in this fixture, never in entitlement logic. `grep -rn "Health Care Pro" lib actions app` → zero hits.
- ❌ No `clinic_feature_overrides` rows. The clinic earns its capabilities from the **plan row's own feature map**, exactly like a paying subscriber. An override would grant the same capabilities while masking whether plan resolution actually works — asserted at zero by the regression test.
- ❌ No bypass of `effective_ai_feature`, commercial terms, subscriptions, feature flags, or any other check. No entitlement code was modified at all.
- ❌ No change to lower plans. `basic` and `pro` plan rows are untouched; both still carry `ai_assistant: false`.

The only slug lookup is in the fixture itself, where a plan is *chosen* — the runtime resolvers remain slug-free (review D-6 holds; `grep -rn "pro_ai" lib/` still returns zero hits).

### Verification against the local Supabase database

**SQL side — the canonical `effective_ai_feature` resolver, on the real rows:**

```
      name       |  slug  | status |     current_period_end     | terms_accepted
-----------------+--------+--------+----------------------------+----------------
 Health Care Pro | pro_ai | active | 2027-08-08 19:19:41.423+00 | t

       feature_key       | effective
-------------------------+-----------
 ai_assistant            | t          ai.write_administration | t
 ai.staff_assistant      | t          ai.write_privileged     | t
 ai.read_operational     | t          ai.documents            | t
 ai.read_clinical        | t          ai.bulk_export          | t
 ai.write_records        | t          ai.staff_analytics      | t
 ai.write_scheduling     | t          ai.financial_insights   | t
                                      ai.managed              | t
```

**TypeScript side — the canonical `getEntitlements` → `hasFeature` path, reading the live local database:**

```
planSlug=pro_ai subscriptionAllowed=true aiTermsAccepted=true aiRequestLimit=1000
PASS ai_assistant             PASS ai.assistant_customization   PASS ai.write_scheduling
PASS ai.staff_assistant       PASS ai.workflows                 PASS ai.write_records
PASS ai.patient_suggest       PASS ai.scheduling                PASS ai.write_administration
PASS ai.managed               PASS ai.read_operational          PASS ai.write_privileged
PASS ai.byok                  PASS ai.read_clinical             PASS ai.documents
PASS ai.staff_analytics       PASS ai.read_financial            PASS ai.bulk_export
PASS ai.financial_insights
FAIL ai.patient_auto          FAIL ai.hybrid_fallback           FAIL ai.followup_generation
```

The three `FAIL`s are the three keys the `pro_ai` plan row itself sets `false` — correct Pro + AI behaviour, not a gap. Both resolvers agree, and the request/step/concurrency allowances (`ai_requests_month: 1000`, `ai_turn_steps_max: 25`, `ai_concurrent_requests: 4`) are the Pro + AI ones.

### Regression coverage — `tests/unit/integration/dev-clinic-pro-ai-entitlement.test.ts` (22 tests)

Runs against local Supabase, seeds the fixture itself so it is self-sufficient on a fresh database.

- Health Care Pro exists **exactly once**, on `pro_ai`, `active`, subscription allowed, terms accepted.
- **Zero** `clinic_feature_overrides` rows — it is entitled, not exempted — and every expected key is `true` on the *plan row*.
- All 15 expected Pro + AI keys resolve `true` through **both** canonical resolvers (SQL `effective_ai_feature` and TS `resolveEffectiveAiFeature`), parametrized one test per key.
- The same answer through `resolveEntitlements` → `hasFeature`, with the unentitled set asserted to be **exactly** `{ai.patient_auto, ai.hybrid_fallback, ai.followup_generation}` — so a plan row that drifts below Pro + AI fails here rather than at manual QA.
- Pro + AI limits present and non-zero; full five-role staff matrix active; assistant→doctor assignment present.
- **Negative controls that prove nothing is bypassed:** withdrawing `accepted_at` turns `ai.staff_assistant` and `ai.write_records` off in both resolvers; cancelling the subscription does the same. Both restore and re-assert `true` in a `finally`.

---

## 4 · Files changed

**Production code (4 files)**

| File | Finding |
|---|---|
| [lib/documents/module-labels.ts](../../lib/documents/module-labels.ts) | B-1 — literal translator binding via `getLocale()` |
| [lib/ai/tools/registry.ts](../../lib/ai/tools/registry.ts) | B-2 — `ACTION_CAPABLE_ROLES` derived from `AI_ACTION_REGISTRY`; `roleMountsActionTools`; both action tools |
| [lib/ai/resources/export-hatch.ts](../../lib/ai/resources/export-hatch.ts) | B-2 second-order — advisory follows the mount |
| [lib/ai/prompts/doctor.ts](../../lib/ai/prompts/doctor.ts) | B-2 — EN + AR persona describes the authorized write surface |

**Eval data (1 file)** — [lib/ai/eval/injection-corpus.ts](../../lib/ai/eval/injection-corpus.ts): `forbiddenAction` field, three cases re-based onto it, `referencedForbiddenActions()`.

**Fixture / tooling (2 files)** — `scripts/seed-dev-clinic.ts` (new), `package.json` (`dev:seed-clinic` script).

**Tests — new (3 files, 48 tests)**

- `tests/unit/lib/final-b1-document-label-i18n.test.ts` (5)
- `tests/unit/ai/final-b2-action-reachability.test.ts` (21)
- `tests/unit/integration/dev-clinic-pro-ai-entitlement.test.ts` (22)

**Tests — corrected (7 files)** — listed in §2.

---

## 5 · Verification results

All run against this working tree on 2026-08-15, local Supabase healthy, keys from `supabase status -o env` per project convention.

| Gate | Command | Result |
|---|---|---|
| **i18n unused gate** | `pnpm i18n:unused` | ✅ **PASS** — exit 0, "no unreferenced keys" (**was FAIL / B-1**) |
| i18n parity | `pnpm i18n:missing` | ✅ PASS — 3 988 base leaf messages |
| i18n source gate | `pnpm lint:i18n` | ✅ PASS — 439 files, 43 documented exceptions |
| RTL gate | `pnpm lint:rtl` | ✅ PASS — 680 files, 17 documented exceptions |
| Full unit suite | `pnpm test` | ✅ PASS — **363 files, 2 847 tests, 0 failures** (was 361 / 2 822) |
| Integration / RLS | `pnpm test:integration` | ✅ PASS — **55 passed, 1 skipped; 488 tests passed, 3 skipped** (was 54 / 466) |
| Adversarial / eval | `pnpm test:ai-adversarial` | ✅ PASS — 2 files, **136 tests** (138 → 136, accounted for in §2) |
| Ops suite | `pnpm test:ops` | ✅ PASS — 3 files, 20 tests |
| Production build | `pnpm build` | ✅ PASS — exit 0, **83/83 static pages** |
| Typecheck | `pnpm typecheck` | ✅ PASS — exit 0, no diagnostics |
| Lint | `pnpm lint` | ✅ PASS — exit 0, **0 errors, 28 warnings** (identical to baseline) |
| Assistant E2E | `PORT=3100 playwright test p4b-assistant phase5f-privileged-actions --workers=1` | ✅ PASS — **4/4** (56.1 s) |
| Whitespace | `git diff --check`, `git diff HEAD --check` | ✅ PASS — exit 0 both |
| Health Care Pro entitlement | `effective_ai_feature` (SQL) + `getEntitlements`/`hasFeature` (TS), live local DB | ✅ PASS — §3 |

Both fixes were additionally probed by reverting them and confirming the new tests fail (B-1: exit 1 naming the deleted key; B-2: 3 failures). Neither suite passes vacuously.

---

## 6 · Remaining issues

**Not fixed — deliberately out of scope.** The brief was B-1, B-2, and the Health Care Pro correction only. The review's five non-blocking findings are untouched and remain open exactly as written:

- **NB-1** (Medium) — `taskClasses` is inert on non-help turns and an out-of-range class would mount **zero** tools rather than raise a typed denial. Still latent (only `staffTaskForRole` feeds it, and it never returns an unsupported class), but it is the one item here worth scheduling next: it is a silent whole-surface failure mode, and B-2 has just made the surface it would silence larger.
- **NB-2** (Low) — residual `ai_workflow_runs` surface after retirement.
- **NB-3** (Low) — `getEntitlements`' 5-minute `unstable_cache` window vs. plan §13's "request-scoped only" claim. Relevant to §3: after changing a subscription or terms row, the app can take up to 5 minutes to reflect it unless `entitlements:<clinicId>` is revalidated. Worth knowing during manual QA of the seeded clinic; the SQL and TS verifications in §3 read through uncached paths and are unaffected.
- **NB-4** (Low) — 28 eslint warnings, 0 errors. Unchanged in number and location.
- **NB-5** (Low) — Assistant E2E is not parallel-safe locally. Still true; the runs above used `--workers=1`, which the review established is the correct local invocation. CI is unaffected (`workers: 1`, and CI does not run E2E).

**One thing the operator should know about the Health Care Pro fix.** `.env.local` sets `NEXT_PUBLIC_SUPABASE_URL` to the **remote** dev project (`ayzetxywrqouqpurbjuv.supabase.co`), so `pnpm dev` talks to that project, not to local Supabase. The Health Care Pro clinic the app shows in day-to-day manual QA therefore lives **there**. Per the instruction not to apply anything remotely, I made no remote change and verified nothing against it. The fix delivered is the local one that was asked for — the fixture, the canonical-resolver verification, and the regression that keeps it valid. If the same clinic needs correcting in the remote dev project, the equivalent change is an operator grant of the `pro_ai` plan plus an AI commercial-terms acceptance through the existing operator UI: the same two rows this seed writes, through the product's own path, and no code change of any kind.

**One defect I introduced and fixed within this work**, reported for completeness: the first draft of a B-1 explanatory comment contained a literal translator call with a placeholder key, which the (comment-blind) checker read as a reference and which turned `pnpm i18n:missing` red. Caught by running the gate, fixed by rewording, and now covered by test 4 of the B-1 suite plus an in-file warning.
