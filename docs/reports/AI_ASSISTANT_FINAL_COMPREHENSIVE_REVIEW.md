# AI Assistant — Final Comprehensive Review (Phases 0 → 7)

**Reviewer:** Claude (final integrated review)
**Date:** 2026-08-15
**Branch:** `feat/p7-manual-qa-polish`
**Baseline:** `01d2d76` (HEAD) + uncommitted working tree (172 modified files, 107 new files, +7 438 / −11 867)
**Plan under review:** [docs/plans/AI_ASSISTANT_FULL_CAPABILITY_PLAN.md](../plans/AI_ASSISTANT_FULL_CAPABILITY_PLAN.md)
**Scope:** Phases 0, 0b, 1, 2, 3, 4, 5a–5e, 5f, 6, 7 — reviewed as one integrated system, not phase-by-phase. No production code was modified by this review.

---

## FINAL VERDICT: CHANGES REQUIRED

Two blocking findings. Neither is a security defect — tenancy, RLS, confirm-token integrity, step-up reauthentication and the anti-escalation invariants all verify clean. Both are **capability/gate defects**: one turns a required CI gate red, and one leaves the entire clinical-authoring write surface unreachable for the two roles that own it, contradicting §5, §15 Phase 5's acceptance criterion, and the implementation's own in-code rationale.

Everything else in the plan verifies as delivered. The architecture is genuinely well built: the compiler, the action pipeline, the receipt ledger and the superseded-tool manifest are all stronger than the plan asked for.

---

## 1. Verification pass — what was actually run

All commands run against this working tree on 2026-08-15. Local Supabase stack running (`supabase status` → healthy; keys taken from `supabase status -o env` per project convention).

| Gate | Command | Result |
|---|---|---|
| Production build | `pnpm build` | ✅ **PASS** — exit 0, 83/83 static pages generated (Next 16.2.6 / Turbopack) |
| Typecheck | `pnpm typecheck` | ✅ **PASS** — exit 0, no diagnostics |
| Full unit suite | `pnpm test` | ✅ **PASS** — **361 files, 2 822 tests, 0 failures** (104 s) |
| Integration / RLS | `pnpm test:integration` (local Supabase) | ✅ **PASS** — **54 files passed, 1 skipped; 466 tests passed, 3 skipped** |
| Adversarial / eval | `pnpm test:ai-adversarial` | ✅ **PASS** — 2 files, **138 tests** |
| Ops suite | `pnpm test:ops` | ✅ **PASS** — 3 files, 20 tests |
| Lint | `pnpm lint` | ✅ **PASS** — exit 0, **0 errors**, 28 warnings (see §5) |
| RTL gate | `pnpm lint:rtl` | ✅ **PASS** — 680 files, 17 documented exceptions |
| i18n source gate | `pnpm lint:i18n` | ✅ **PASS** — 439 files, 43 documented exceptions |
| i18n parity | `pnpm i18n:missing` | ✅ **PASS** — 3 988 base leaf messages, variants valid |
| **i18n unused gate** | `pnpm i18n:unused` | ❌ **FAIL** — exit 1, 21 keys reported unused — **BLOCKING, see B-1** |
| Whitespace | `git diff --check`, `git diff HEAD --check` | ✅ **PASS** — exit 0 both |
| Assistant E2E | `PORT=3100 playwright test p4b-assistant phase5f-privileged-actions --workers=1` | ✅ **PASS** — **4/4 passed** (50.6 s) |

### E2E note — a flake that is not a defect

Run with Playwright's default worker count the same two specs fail **4/4** at the login redirect. Run individually, or together with `--workers=1`, they pass 4/4. `tests/e2e/rate-limit-server.ts:14` always returns `[1, 1, …]`, so the app's own login limiter is not the cause, and the failure survives a >6-minute cooldown, so GoTrue's `sign_in_sign_ups = 30` window ([supabase/config.toml:202](../../supabase/config.toml#L202)) is not it either. It is contention between parallel workers and a single local `next start` overrunning the spec's 10 s `toHaveURL` budget. `playwright.config.ts:19` sets `workers: process.env.CI ? 1 : undefined`, so CI would run serially — and CI does not run E2E at all. Recorded under §5 (NB-5), not as a defect.

### Negative controls and probes executed

Beyond re-running the suites, the following independent probes were written, executed and removed (no production code touched):

1. **Tenant-predicate universality.** `compileResourceQueryPlan` was driven over **every** resource in `RESOURCE_REGISTRY` × every role that resource admits; every plan carries `tenantPredicate` bound to `user.clinicId`. ✅
2. **Compiler rejection surface.** Unknown resource (`pg_shadow`), unknown filter (`clinic_id`), unknown field (`password`), unregistered sort (`clinic_id`), disallowed operator (`gt` on `full_name`) — all rejected with `AiResourceInputError`. ✅
3. **`national_id` policy (§19 decision 2).** For all five roles, the default `patients` projection contains neither the field nor the column, and an explicit request yields `sensitiveListLimit === 25`. ✅
4. **ilike wildcard smuggling.** `{operator:"ilike", value:"*"}` rejected at compile time; `applyFilter` escapes `\ % _`. ✅
5. **Pagination bounds.** `page_size: 5000` and `page: 10000` both rejected. ✅
6. **Action-registry role census.** `AI_ACTION_REGISTRY` enumerated per role — this is what surfaced **B-2** (21 doctor-authorized and 22 assistant-authorized actions, all unreachable).
7. **Export-hatch reachability.** `getAccessibleDocumentTypeCodes` enumerated per role — doctors and assistants can reach 4 of the 5 export document types, which is what makes B-2's advisory contradiction concrete.
8. **i18n baseline differential.** `git stash` → `node scripts/check-messages.mjs unused` on clean HEAD → **exit 0, "no unreferenced keys"**; restored → **exit 1**. This is what proves B-1 is a regression introduced by this work rather than a pre-existing gate failure.
9. **E2E baseline differential.** `git stash` → `p4b-assistant.spec.ts` on clean HEAD → 2 passed. Restored, run alone → 3 passed. Together with `--workers=1` → 4 passed.

Prior PASS reports were **not** taken on trust; every claim reported below was re-derived from the current tree.

---

## 2. BLOCKING FINDINGS

### B-1 · `pnpm i18n:unused` CI gate is red — 21 document-catalog keys report as unreferenced

**Severity:** Blocking (required CI job fails)
**Introduced by:** Phase 6 (P6-09 localized document label)
**Affected files:**
- [lib/documents/module-labels.ts:12-17](../../lib/documents/module-labels.ts#L12-L17)
- gate: [.github/workflows/ci.yml:49-50](../../.github/workflows/ci.yml#L49) — job step *"i18n unused-key gate"*
- checker binding logic: [scripts/check-messages.mjs:222-227](../../scripts/check-messages.mjs#L222-L227)

**Evidence.**

```
$ pnpm i18n:unused
Unused catalog keys (21):
documents.catalog.revenueReport
documents.catalog.followUpPageReport
… 19 more …
[ELIFECYCLE] Command failed with exit code 1.
```

Differential against clean HEAD (stash/restore, both verified):

```
HEAD           → exit 0  "✓ unused messages: no unreferenced keys."
working tree   → exit 1  21 unused keys
```

**Root cause.** P6-09 needed the document label in an explicitly chosen locale, so `getDocumentTypeLabels()` was refactored into a private `documentTypeLabels(locale?)` whose translator binding became a ternary:

```ts
const t = locale
  ? await getTranslations({ locale, namespace: "documents.catalog" })
  : await getTranslations("documents.catalog");
```

`scripts/check-messages.mjs` binds a translator variable to a namespace with regexes anchored on `const <name> = [await] getTranslations("<ns>")` or `const <name> = [await] getTranslations({ … namespace: "<ns>" … })` (lines 222–227). Neither matches a ternary initializer, so `t` is bound to no namespace, every `t("revenueReport")` call is invisible, and all 21 leaf keys under `documents.catalog` fall through to the unused list.

The keys are genuinely referenced and the UI renders correctly — this is a static-analysis break, not a missing-translation bug. The file's own comment at [module-labels.ts:6-11](../../lib/documents/module-labels.ts#L6-L11) states the literal keys exist *"so the i18n gate can prove each is referenced"*, which the refactor silently invalidated.

**Required fix (either is acceptable; the first is preferred as it keeps the checker honest):**
1. Restore a directly-bound translator, e.g. resolve the namespace-scoped translator into a plain `const t = …` in each branch of a small helper, or split into two functions each with a literal `const t = await getTranslations(...)` binding; **or**
2. Extend the checker to also bind a translator declared with a conditional initializer, recognising any `getTranslations` call in the initializer expression.

Do **not** resolve this by adding `documents.catalog` to `dynamicNamespaces` — that would exempt the whole subtree and permanently disable the gate for exactly the namespace it is protecting.

**Acceptance criteria:**
- `pnpm i18n:unused` exits 0 on this tree.
- A probe confirms the gate still bites: deleting one `t("…")` call from `module-labels.ts` makes `pnpm i18n:unused` report that specific key.
- `pnpm i18n:missing` and `pnpm lint:i18n` still pass.

---

### B-2 · The entire write surface is unreachable for `doctor` and `assistant` — `execute_action` is mounted for administrative roles only

**Severity:** Blocking (plan §5 gate rule and §15 Phase 5 acceptance criterion both unmet; contradicts the implementation's own stated rationale)
**Introduced by:** Phase 3 (initial `execute_action` role list), never widened when Phases 5c and 6 landed doctor/assistant-authorized actions
**Affected files:**
- [lib/ai/tools/registry.ts:109](../../lib/ai/tools/registry.ts#L109) — `const ADMINISTRATIVE = ["admin","manager","receptionist"]`
- [lib/ai/tools/registry.ts:214-232](../../lib/ai/tools/registry.ts#L214-L232) — `execute_action` and `describe_action` both declare `roles: ADMINISTRATIVE`
- [lib/ai/resources/export-hatch.ts:22-26, 60-67](../../lib/ai/resources/export-hatch.ts#L22-L26) — advisory contradiction, below
- Contradicted rationale: [lib/ai/actions/definitions/documents.ts:45-56](../../lib/ai/actions/definitions/documents.ts#L45-L56)
- Tests that currently *lock the defect in*: [tests/unit/ai/phase4-orchestration.test.ts:139-141](../../tests/unit/ai/phase4-orchestration.test.ts#L139-L141), [tests/unit/ai/phase7-capability-surface.test.ts:136-143](../../tests/unit/ai/phase7-capability-surface.test.ts#L136-L143), [tests/unit/components/phase7-capability-panel.test.tsx:177](../../tests/unit/components/phase7-capability-panel.test.tsx#L177)

**Evidence.** A census of `AI_ACTION_REGISTRY` (89 actions total) shows the action layer explicitly authorizes these roles:

```
doctor    — 21/89:
  appointments.replace, appointments.undo_status, appointments.start_session,
  medical_notes.create, medical_notes.update, medical_notes.delete, medical_notes.restore,
  prescriptions.{create_draft,update_draft,finalize,void},
  lab_requests.{create_draft,update_draft,finalize,void},
  sick_leaves.{create_draft,update_draft,finalize,void},
  documents.issue, documents.reprint

assistant — 22/89:
  appointments.{create,replace,update_status,arrive,confirm_and_displace},
  followups.{record,update},
  prescriptions.{create_draft,update_draft,finalize,void},
  lab_requests.{create_draft,update_draft,finalize,void},
  sick_leaves.{create_draft,update_draft,finalize,void},
  billing.complete_appointment, documents.issue, documents.reprint
```

Those role lists are correct — they are copied verbatim from the shared domain cores ([lib/clinical/mutations.ts:25-31](../../lib/clinical/mutations.ts#L25-L31) `CLINICAL_MUTATION_ROLES` = all five roles; [lib/patients/mutations.ts:22](../../lib/patients/mutations.ts#L22) `MEDICAL_NOTE_WRITE_ROLES` = `["admin","doctor"]`; [lib/appointments/mutations.ts:29-42](../../lib/appointments/mutations.ts#L29-L42)), and `tests/unit/integration/assistant-scope-rls.test.ts:501-612` proves at the database boundary that an `assistant` really can create and update appointments and follow-ups within their supervised-doctor scope.

But **the only tool that can invoke any of them is not mounted for those roles.** `resolveToolMount` filters `AI_TOOL_REGISTRY` on `definition.roles.includes(ctx.user.role)` ([lib/ai/tools/index.ts:77](../../lib/ai/tools/index.ts#L77)), and `execute_action`/`describe_action` declare `ADMINISTRATIVE`. So all 21 doctor-authorized and 22 assistant-authorized actions are unreachable through the Assistant. Confirmed by the existing tests themselves, which assert the exclusion:

```ts
// tests/unit/ai/phase4-orchestration.test.ts:139-141
expect(baseline.includes("execute_action"), role)
  .toBe(role === "admin" || role === "manager" || role === "receptionist");
```

**Why this is blocking, not a product choice.** No decision record supports it. Searched: the plan (§5, §8.2, §11, §15 Phase 5, §17), `docs/reports/AI_ASSISTANT_PHASE_{3,4,5,5F,6,7}_*.md`, and every code comment on the two registry entries — none states or justifies a doctor/assistant write exclusion. Three things contradict it directly:

1. **Plan §5** — *"gates 5 and 6 [plan entitlement, AI user permission] are the only two gates that may exist above app authorization. Every other AI-local restriction is removed."* A role list on the tool that carries all writes is exactly such a restriction, and it is the same class of defect as RC-2/RC-4 that this whole plan was written to eliminate.
2. **Plan §15 Phase 5 acceptance** — *"every non-privileged write the UI offers a role is available to the Assistant for that role."* Unmet for the two roles the clinical-authoring surface exists for.
3. **The implementation's own reasoning.** [documents.ts:45-50](../../lib/ai/actions/definitions/documents.ts#L45-L50) declares `DOCUMENT_ACTION_ROLES` as all five roles and states: *"Declaring a narrower role list here would be an AI-local restriction the app does not have."* The mount does precisely that, one layer up.

**Second-order defect — the export hatch advertises a capability it knows is unreachable.** [lib/ai/resources/export-hatch.ts:22-26](../../lib/ai/resources/export-hatch.ts#L22-L26) promises: *"It is emitted only when the caller could genuinely issue that type … so it can never advertise a capability that would then be denied."* `resourceExportSuggestion` checks catalog role, plan feature and report visibility — but **not** the `execute_action` mount. Probed: doctors and assistants can reach `PATIENT_LIST_REPORT`, `FOLLOW_UP_PAGE_REPORT`, `APPOINTMENT_HISTORY_REPORT` and `PACKAGE_HISTORY_REPORT`. So a doctor whose `query_resource` page over `patients` truncates receives model-facing guidance to *"offer the user a PATIENT_LIST_REPORT … issued with the documents.issue action"* — an action that does not exist in their tool set. This is the prompt/capability drift failure mode §18 names.

**Mitigating facts (why this is a capability gap, not a security or honesty hole):**
- The capability panel is honest: [lib/ai/capabilities.ts:233-235](../../lib/ai/capabilities.ts#L233-L235) gates the action list on `mounted.has("execute_action")`, so a doctor is shown `actions: []` rather than something unreachable.
- The doctor system prompt is internally consistent: [lib/ai/prompts/doctor.ts:23](../../lib/ai/prompts/doctor.ts#L23) describes a read-only role.
- Nothing is *over*-permissioned. The failure is strictly under-capability.

**Required fix.** Decide and then make one layer authoritative:

- *If doctor/assistant writes are in scope (the plan's position):* widen `execute_action` and `describe_action` to `ALL_STAFF`. Per-action `roles`, `requiredFeatures`, `requiredUserPermission`, `pageSlug` and the domain core all re-assert independently inside `assertActionAccess` ([lib/ai/actions/execute.ts:108-147](../../lib/ai/actions/execute.ts#L108-L147)), so the tool-level list is redundant defense, not the control. Update the doctor prompt to describe the authorized write surface, and update the three tests above to assert the widened mount.
- *If they are deliberately out of scope:* remove `doctor`/`assistant` from every affected action's `roles`, record the decision and its rationale in the plan's §19 decision list, and add the mount check to `resourceExportSuggestion` so the advisory cannot fire for a role that cannot act on it.

The first is strongly preferred: the second silently narrows 21 clinical-authoring capabilities away from the role that owns them, and diverges the action registry from the domain cores it was built to mirror.

**Acceptance criteria:**
- A parametrized test asserts, for all 5 roles × all 89 actions, that *the action is reachable through the mounted tool set iff `assertActionAccess` allows it* — i.e. the tool mount and the action registry cannot disagree. A probe that removes one role from `execute_action` must fail this test.
- `resourceExportSuggestion` returns `null` (or the guidance omits `documents.issue`) for any caller who cannot mount `execute_action`; probed by a doctor-role unit test.
- A doctor completes `prescriptions.create_draft` end-to-end through preview → confirm, with an `ai_action_receipts` row for both phases; an assistant completes `appointments.create` for an assigned doctor and is refused for an unassigned one.
- The capability panel lists the doctor's write surface, and the doctor prompt no longer describes the assistant as read-only.
- Full unit, adversarial and integration suites stay green.

---

## 3. NON-BLOCKING FINDINGS

| ID | Severity | Finding | Location |
|---|---|---|---|
| NB-1 | Medium | **`taskClasses` is documented as enforced but is inert on every non-help turn, and its failure mode is silent total capability loss.** `resolveToolMount` evaluates `ctx.taskClass === "staff_help" ? definition.taskClasses.includes("staff_help") : activeTaskClasses.length > 0` — for any non-help class the per-definition `taskClasses` array is never consulted. The type comment says *"Enforced by `resolveToolMount`, not decorative"*, and `staff_composite` appears in no definition's `taskClasses` at all yet everything mounts in a composite turn. Worse, if a router ever returned a class outside `STAFF_TASK_CLASSES_BY_ROLE[role]`, `activeTaskClasses` is `[]` and **zero** tools mount — a silent whole-surface loss rather than a typed denial. Today unreachable, because `staffTaskForRole` only ever returns a class the role supports; it is a latent trap, not a live bug. **Fix:** either restore the per-definition check for all classes (adding `staff_composite` where intended), or delete the field's enforcement claim and reduce it to the `staff_help` allow-list it actually is; and make the empty-`activeTaskClasses` branch throw rather than mount nothing. | [lib/ai/tools/index.ts:82-91](../../lib/ai/tools/index.ts#L82-L91), [lib/ai/tools/registry.ts:94-97, 137-158](../../lib/ai/tools/registry.ts#L94-L97) |
| NB-2 | Low | **Residual `ai_workflow_runs` surface after retirement.** Phase 4 correctly retired the table read-only (`revoke insert, update, delete … from service_role`, [20260813160000:124-129](../../supabase/migrations/20260813160000_ai_assistant_phase4_orchestration.sql#L124-L129)), and `lib/ai/workflows/` is gone. But the table is still listed in `CLINIC_SCOPED_TABLES` and `tests/unit/integration/p411a-workflow-runs-rls.test.ts` still exercises a superseded surface. Harmless (writes revoked at the DB), but it is dead surface area the §14 cutover intended to close. | [lib/supabase/admin.ts:2094](../../lib/supabase/admin.ts#L2094), `tests/unit/integration/p411a-workflow-runs-rls.test.ts` |
| NB-3 | Low | **Entitlement caching window vs. plan §13.** §13 asserts *"caching is request-scoped React `cache()` only"* for the gates. `getEntitlements` wraps `loadEntitlements` in `unstable_cache` with `revalidate: 300` and tag `entitlements:<clinicId>`. Pre-existing, and correct for a commercial gate — but Phase 0b promoted feature entitlement to the primary AI gate, so a revoked `ai.*` key or a withdrawn terms acceptance can take up to 5 minutes to take effect unless the tag is revalidated on every write path that changes it. Worth an explicit audit of the `revalidateTag("entitlements:…")` call sites, or a note in §13 reconciling the two statements. Note this is *entitlement* staleness only — role and permission gates read live via `auth_profile()`, and preview→confirm re-asserts from scratch. | [lib/entitlements.ts:133-139](../../lib/entitlements.ts#L133-L139) |
| NB-4 | Low | **28 eslint warnings, 0 errors.** One is in an AI path (`lib/ai/conversation-context.ts`); the rest are unrelated (see §4). Not gating — `pnpm lint` exits 0. | `pnpm lint` output |
| NB-5 | Low | **Assistant E2E is not parallel-safe locally.** `p4b-assistant.spec.ts` + `phase5f-privileged-actions.spec.ts` fail 4/4 at the login redirect under default workers, pass 4/4 with `--workers=1`. Cause is worker contention against a single local `next start` overrunning the spec's 10 s `toHaveURL` budget — not the app limiter (mock always returns count 1) and not GoTrue (survives a >6 min cooldown). CI is unaffected (`workers: 1`, and CI does not run E2E). Suggest raising the login-step timeout in the two specs or documenting `--workers=1` for local assistant E2E. | [playwright.config.ts:19](../../playwright.config.ts#L19), `tests/e2e/p4b-assistant.spec.ts:51`, `tests/e2e/phase5f-privileged-actions.spec.ts:56` |

---

## 4. PRE-EXISTING UNRELATED DEFECTS

Present on HEAD, untouched and unaffected by this work. Recorded for completeness; none block.

- **eslint warnings outside the AI subsystem (27 of 28).** `@typescript-eslint/no-unused-vars` in `components/patients/*` (7), `components/settings/*` (7), `lib/validations/{package-template,patient-package}.ts`, `actions/{clinical,generic}-documents.ts`, `app/(protected)/dashboard/page.tsx`, `components/documents/module/documents-table.tsx`, `components/followups/record-dialog.tsx`, `components/profile/profile-page.tsx`.
- **Turbopack NFT tracing warning** on `next.config.ts` via `lib/documents/pdf/fonts.ts` (*"Encountered unexpected file in NFT list"*). Build succeeds; a P7 document-platform artifact, not introduced here.
- **`middleware` file-convention deprecation warning** (Next 16 → `proxy`). Build succeeds.
- **Local dev environment only:** `supabase status` reports `supabase_imgproxy` and `supabase_pooler` stopped; Vercel CLI is 51.2.1 vs 59.1.3.

---

## 5. ACCEPTED PRODUCT DECISIONS / DEVIATIONS

Verified as deliberate, documented in-tree, and consistent with the approved plan. **No action required.**

| # | Decision | Verification |
|---|---|---|
| D-1 | **`national_id` is explicit-request-only, never in `defaultFields`, refused above 25 rows.** §19 decision 2. | Probed for all 5 roles: absent from default projection and from the `select` string; explicit request yields `sensitiveListLimit === 25` enforced by a pre-count in `executeCompiledResourceQuery`. [patients.ts:26-31, 138-139](../../lib/ai/resources/definitions/patients.ts#L26-L31), [compile.ts:542-554](../../lib/ai/resources/compile.ts#L542-L554) |
| D-2 | **`aggregate_resource` applies no k-anonymity.** §7.4 — filtered single-cell counts are exact and RLS-scoped; DB-side suppression is retained only for grouped patient-attribute distributions via `ai_get_patient_stats`. | `get_patient_stats` retained in `RETAINED_PURPOSE_BUILT_TOOLS` with that exact reason. |
| D-3 | **`MAX_RANGE_DAYS` (400) clamp and its `clamped` notice are not reproduced** by the generic filter path. | Explicitly recorded as `RANGE_CLAMP_DEVIATION` in `lib/ai/tools/superseded.ts` and asserted by `phase7-superset-coverage.test.ts`, with row exposure bounded instead by `rowCap` 200 + the `ai.bulk_export` gate on `page > 1`. |
| D-4 | **`medical_notes` coverage narrowed to `admin`/`receptionist`/`doctor`.** Not an AI restriction: `medical_notes_select_role_scoped` admits only those roles, so the removed tool returned an empty array to manager and assistant too. | Declared as `narrowing` on the superseded record and asserted against the application role constant. |
| D-5 | **Feature-key shifts across the migration** (e.g. appointment reads move from `ai.staff_analytics` to `ai.read_operational`). Commercial, not security — both keys seed on the same plan row, and §5 makes moving either a one-row data change. | Recorded per-tool as `featureShift` in the superseded manifest. |
| D-6 | **`plan.slug = 'pro_ai'` still appears twice in the Phase 0b migration** ([20260813130000:27, 70](../../supabase/migrations/20260813130000_ai_entitlement_plan_decoupling.sql#L27)). Both are inside the **one-time compatibility backfill**, explicitly commented *"not a runtime entitlement gate."* The runtime resolvers are slug-free. | `grep -rn "pro_ai" lib/` → **zero hits**; operator UI branches on `effective_ai_feature`, not slug. |
| D-7 | **Plan/billing/subscription and platform-operator mutations are absent** from the action registry. §11 — outside the clinic tenant boundary, so exclusion is parity, not restriction. | Registry census: 89 actions, none touching plans/subscriptions/`platform_admins`. |
| D-8 | **Retention windows are fixed constants, not clinic-configurable.** §19 decision 6. | `AI_MESSAGE_RETENTION_DAYS = 180`, `AI_ACTION_RECEIPT_RETENTION_DAYS = 400`, `AI_ACTION_CONFIRMATION_RETENTION_DAYS = 30`, each a single named constant passed as an argument to the purge RPC so per-clinic windows are later a lookup in one module. [lib/ai/retention.ts](../../lib/ai/retention.ts) |
| D-9 | **No self-mutation for privileged actions, even for admins.** §11.1 control 4 — the single deliberate narrowing versus the UI. | `privilegedTarget` throws `unauthorized_scope` when `target === user.id` ([execute.ts:159-161](../../lib/ai/actions/execute.ts#L159-L161)). |

---

## 6. Verification against the plan's required checks

Each item the review brief called out, with what was checked and the result.

### ✅ Assistant capability matches the authenticated user's real ClinicFlow authorization
Reads: yes. `compileResourceQueryPlan` gates on `definition.roles` (mirrored from the app's own constants), `assertResourceAccess` adds features + user permission, and every read runs on `createClient()` (the RLS session client) with `.eq(clinic_id, user.clinicId)` as belt-and-braces. RC-2/RC-4 are gone: `assertClinicalToolAccess`'s `{doctor, assistant}` restriction no longer exists, and clinical resources are admitted on the same predicate the database uses.
Writes: **no — see B-2.** The action *registry* matches app authorization exactly; the *tool mount* above it does not.

### ✅ Plan entitlements remain separate and configurable across Basic / Pro / Pro + AI
Phase 0b is fully delivered on both sides. `hasFeature` ([entitlements.ts:141-149](../../lib/entitlements.ts#L141-L149)) resolves through `resolveEffectiveAiFeature(subscription ∧ terms ∧ umbrella ∧ key)` with no slug. `grep -rn "pro_ai" lib/` returns **zero hits**. `effective_ai_feature()` was rewritten identically in SQL. The only surviving slug references are the documented one-time backfill (D-6). The AI-terms-acceptance predicate is present and is strictly stricter than the slug check it replaced.

### ✅ RLS and tenant isolation remain authoritative
- No service-role client anywhere in the AI read/write path. `tests/unit/security/admin-client-static-guard.test.ts` walks `actions`, `app`, `components`, `hooks`, **`lib`** recursively — so `lib/ai/resources/` and `lib/ai/actions/` are covered by construction, satisfying §13's requirement to extend the scan. Only `lib/supabase/admin.ts` is allow-listed.
- The service-role imports in `lib/ai/actions/{execute,confirm}.ts` are the §12 receipt ledger and confirmation store — `security definer` RPCs, exactly as the plan specifies, never a data path.
- Tenant predicate verified present on **every** resource × every admitted role (probe 1).
- `unauthorized_scope` is returned byte-identically for not-yours and not-found (`scopeError()`, [compile.ts:526-531](../../lib/ai/resources/compile.ts#L526-L531)).
- `tests/unit/integration/assistant-scope-rls.test.ts` (31 cases) covers doctor self-scope, assistant supervised-doctor union, immediate re-scoping on unassignment, anti-spoof writes, and cross-clinic leakage — all green against local Supabase.

### ⚠️ No AI-specific restriction incorrectly blocks an authorized user
**B-2 is exactly this failure**, for `doctor` and `assistant` on the write surface. Reads are clean.

### ✅ No Assistant capability exceeds the corresponding UI/application authorization
Verified in both directions. Every resource role list mirrors an application constant; every action role list was cross-checked against the domain core it binds (`CLINICAL_MUTATION_ROLES`, `MEDICAL_NOTE_WRITE_ROLES`, `APPOINTMENT_*_ROLES`, `FOLLOWUP_*_ROLES`, `SETTINGS_*_ROLES`, `PRIVILEGED_*_ROLES`). `assertActionAccess` additionally applies the page-visibility gate. No over-grant found anywhere.

### ✅ Reads, clinical access, actions, privileged actions, documents, exports, retention compose correctly
Each composes through the same three gates in the same order, with per-layer re-assertion. `previewRegisteredAction` maps an action's *internal* authorization throw onto the same denial taxonomy rather than crashing ([execute.ts:519-546](../../lib/ai/actions/execute.ts#L519-L546)) — a composition detail that is easy to get wrong and is right here.

### ✅ All write paths use the intended shared domain cores
`lib/{patients,appointments,followups,clinical,settings,billing,documents}/mutations.ts` exist as session-free `(user, input)` cores; `actions/*.ts` are thin adapters (all 20+ modified accordingly). Phase 5's equivalence tests assert the server action and the action definition agree for identical input, and `AI_ACTION_REGISTRY`'s role arrays are asserted against the `DomainMutationAuthorizationError` the real core raises for all 89 actions × 5 roles.

### ✅ Confirmation, reauthentication, replay protection, idempotency, receipts, notifications, pending confirmations
- **Token:** HMAC-SHA256 over `{v, actionId, inputDigest, userId, clinicId, conversationId, nonce, exp}` **plus** the canonical input, compared with `timingSafeEqual` after a strict 32-byte length check. Payload is fully type-validated before use. Model cannot mint one — `execute-action.ts` previews only; execution runs through the authenticated `confirmAssistantAction` server action.
- **Replay:** single-use claim in `ai_action_confirmations` under a unique constraint, returning a typed `claimed|invalid|expired|replayed`.
- **TTL:** 10 min normal, **2 min privileged** — matches §11.1 control 2.
- **Re-authorization at execute:** the token is claimed *first*, then `assertActionAccess` runs from scratch, so a role revoked between phases burns the token and denies. §17 A15 satisfied.
- **Privileged binding:** token additionally carries `{targetUserId, beforeDigest, afterDigest}`; at execute the preview is recomputed and `samePrivilegedBinding` must hold, so mutating either the target or the value invalidates it.
- **Step-up:** `actions/assistant-actions.ts:75-102` requires `currentPassword`, applies an independent 5-per-15-min limiter, verifies the password, then mints a single-use reauth nonce hashed into the claim. Injected model text cannot supply a password.
- **Idempotency:** `ai-action:<tokenHash>` derived from the burned token.
- **Receipts:** written for **every** attempt, allowed and denied, at both phases — including the `!definition` (`not_supported`) case, because `beginReceipt` runs before the lookup is validated. Digests only, no payloads; `safeActionId` and `safeInputDigest` keep a malformed id or unserializable input from corrupting the ledger.
- **Notification:** delivered *after* the authoritative receipt is finalized, so a notification failure can never relabel a committed privileged change as `error`; failures get their own distinctly-identified receipt row (`PRIVILEGED_NOTIFICATION_FAILURE_ACTION_ID`) plus Sentry. This is a genuinely careful piece of work.
- **Pending confirmations** survive refresh via `active_context`; `clearPendingActionConfirmation` runs on success.

### ✅ No cross-tenant or stale-authorization path
Cross-tenant: RLS primary + compiler-injected tenant predicate secondary + no model-supplied `clinic_id` anywhere. Stale authorization: role/permission gates read live through `auth_profile()`; preview→confirm re-asserts. The one caveat is entitlement caching (NB-3), which is commercial rather than security.

### ⚠️ Tool/task routing no longer removes legitimate capabilities
Behaviourally correct today and asserted by `phase4-orchestration.test.ts` ("does not let a non-help intent classification remove an authorized data tool"; "keeps each role's authorized mount identical across all non-help intent classes"). `staff_help` remains the sole containment route. But the mechanism is fragile — see NB-1.

### ✅ Superseded tools removed only after real parity; no capability silently lost
`lib/ai/tools/superseded.ts` is better than the plan asked for. Rather than a changelog, the migration *claim* is kept as data — per removed tool: replacement resource, fields, filters, relations **with the projected fields**, clinic-local date semantics, roles covered, documented narrowings and deviations — and `phase7-superset-coverage.test.ts` re-derives it against the live registries every run. A future edit that drops `medical_notes.note`, narrows a role list, or removes `file_number` from the appointments `patient` relation fails a test naming the capability it took away. The coverage test also asserts that superseded + retained + generic accounts for the registry **exactly**, so no tool can be added without classifying it.

### ⚠️ Capability discovery/panel accurately reflects the real surface
Accurate as built: `lib/ai/capabilities.ts:233-235` gates the action list on the `execute_action` mount, so a doctor sees `actions: []` rather than something unreachable, and the E2E asserts both directions in both locales with an Axe sweep. The panel is therefore *honest about a surface that should not be that shape* — it reports B-2 rather than causing it. The one live inconsistency is the export hatch (B-2, second-order).

### ✅ Document generation and slot filling work end-to-end
`describe_documents` → `preview_document` → `documents.issue` (preview → confirm → `issueDocumentFoundation`/`issueInvoiceDocument`), with `documents.reprint`, catalog-driven slot projection via `documentSetupFields()`, validation-errors-as-questions, and idempotency. An unauthorized type is invisible (empty page) rather than 403. Labels resolve through `getDocumentTypeLabel` in the conversation's locale so a confirmation card never renders a raw catalog key — which is also, ironically, the change that caused B-1.

### ✅ Bulk/export cannot bypass field policy or RLS
Page size default 50, max 200, hard cap 500, `page > 1` gated on `ai.bulk_export`, `page ≤ 100`. Exports are advisory only: `resourceExportSuggestion` returns metadata, and issuance re-runs the full `documents.issue` pipeline against the caller's own RLS client through the same resolvers the UI uses. Sensitive fields carry `maxListRows` enforced by an exact pre-count before any row is fetched. Truncation notices are computed from `cap + 1` fetches plus `{count:"exact"}`, so `total` and `truncated` are honest.

### ✅ Retention does not corrupt conversation/audit behaviour
Windows are fixed named constants, batch-limited to 10 000 per run with a `purgeBatchSaturated` signal. Conversation *rows* are never deleted — only the transcript, with `title` and `active_context` scrubbed once expired — so receipts and confirmations that cascade from the conversation stay intact. Receipts (400 d) deliberately outlive transcripts (180 d). A claimable confirmation is never purged regardless of age.

### ✅ Stored prompt injection and confirm-token forgery protections remain effective
`pnpm test:ai-adversarial` green (138 tests). `harden()` applies `sanitizeUntrustedDeep` + `withProvenance` at the **mount boundary**, so every current and future tool is covered by construction, and truncation is now surfaced via `text_truncated_fields` instead of silently clipping. The corpus was extended to the newly-exposed fields (`medical_notes.note`, document titles, department/service names) and to `execute_action` confirm-bypass attempts naming real action ids, including `documents.issue` and `staff.change_role`. The containment test asserts a mocked-tool agent never invokes an unmounted capability.

### ✅ Privileged role/permission changes remain strongly protected
All nine §11.1 controls verified present: step-up reauth, 2-minute single-use token bound to target *and* before→after value, explicit rendered diff (`identifiesRecord`), no self-mutation, inherited primary-admin protection via the shared core, full cascade side-effects, mandatory receipts on allow *and* deny, per-conversation/per-day rate limiting at **both** phases, and independent tierability behind `ai.write_privileged`. E2E `phase5f-privileged-actions.spec.ts` passes end-to-end.

### ✅ Normal ClinicFlow UI behaviour was not unintentionally changed by the shared-core refactors
2 822 unit tests and 466 integration tests green, production build clean, typecheck clean, RTL and i18n-source gates clean. The shared-core extraction turned `actions/*.ts` into adapters over cores that carry the same zod schemas and business rules; Phase 5's equivalence tests are the direct evidence. The one *observable* regression from the refactors is B-1, and it is confined to a static-analysis gate, not to rendered output.

### Carried findings from earlier reviews
Phase 0's H1 (`agent_messages` RLS missing `auth_role()` + patient-liveness terms), H2 (nondeterministic replay ordering) and M1 (`user_ai_permissions` self-read missing `clinic_id`) are all resolved in `20260813120000_ai_assistant_phase0_foundations.sql`, including the `sequence` identity column, backfill, unique index and ordering index. Audit M2 (clinical text retention in `agent_messages`) is resolved by Phase 6 retention. M5 (tool parts dropped on persist) is resolved by `lib/ai/conversation-parts.ts` with password redaction. Phase 5's F-1 (destructive-preview identity not extended beyond appointments) and F-2 (registry-wide acceptance test unwritten) remain open as previously accepted low-severity items and are **still acceptable** — the privileged path, which is where identity legibility matters most, now enforces `identifiesRecord` explicitly.

---

## 7. Summary

| Category | Count | Items |
|---|---|---|
| **Blocking** | **2** | B-1 (i18n unused CI gate red), B-2 (doctor/assistant write surface unreachable) |
| Non-blocking | 5 | NB-1 … NB-5 |
| Pre-existing unrelated | 4 | eslint warnings outside AI, NFT tracing warning, middleware deprecation, local env |
| Accepted decisions | 9 | D-1 … D-9 |

The security architecture holds up under adversarial reading: the query compiler, the confirm-token pipeline, the receipt ledger, the privileged safeguard stack and the superseded-tool manifest are all implemented to a higher standard than the plan required, and the static service-role guard makes the central invariant unforgeable. The plan's headline goals are met — Case A and Case B both work, entitlement is genuinely slug-free on both sides, RLS remains the authority, and the 22-tool static list is gone without silent capability loss on the read side.

What remains is one CI gate broken by a localization refactor, and one stale role list on the tool that carries every write — the last surviving instance of exactly the AI-local restriction this plan was written to eliminate.

**FINAL VERDICT: CHANGES REQUIRED**
