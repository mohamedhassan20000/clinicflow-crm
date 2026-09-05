# AI Assistant — Final Re-Review (B-1, B-2, Health Care Pro, Phases 0 → 7)

**Reviewer:** Claude (final re-review)
**Date:** 2026-08-15
**Branch:** `feat/p7-manual-qa-polish`
**Baseline:** `01d2d76` (HEAD) + the uncommitted working tree (286 changed paths)
**Plan:** [docs/plans/AI_ASSISTANT_FULL_CAPABILITY_PLAN.md](../plans/AI_ASSISTANT_FULL_CAPABILITY_PLAN.md)
**Prior review:** [AI_ASSISTANT_FINAL_COMPREHENSIVE_REVIEW.md](AI_ASSISTANT_FINAL_COMPREHENSIVE_REVIEW.md) — B-1, B-2, NB-1…NB-5
**Implementation report under audit:** [AI_ASSISTANT_FINAL_FIXES.md](AI_ASSISTANT_FINAL_FIXES.md)

**Method.** Every claim below was re-derived from the working tree. The implementation report was read for orientation and then set aside; no assertion in it was accepted on trust. No production code was modified by this review: two files were temporarily patched for negative controls and restored byte-identically (`cmp`/`diff -q` verified), one throwaway probe test was written and deleted, and the working tree ends at the same 286 changed paths it started at. **No remote change of any kind was made** — every database probe ran against local Supabase (`127.0.0.1:54321`), and the two mutating probes ran inside `begin … rollback`.

---

## FINAL VERDICT: PASS

Both blocking findings are genuinely fixed, verified independently and by negative control. B-1 is fixed the honest way — the checker is untouched, no key was deleted or exempted, and the gate still bites. B-2 is fixed structurally rather than by re-listing: the action-tool mount is now *derived* from `AI_ACTION_REGISTRY`, so the class of drift that caused it cannot recur. No over-grant was introduced: the per-action role lists are unchanged, doctor and assistant reach exactly their own 21 and 22 actions and no privileged action, and `staff_help` containment is intact. The Health Care Pro development setup is a legitimate `pro_ai` subscriber with zero feature overrides and no name-based special case, and it fails closed on both terms withdrawal and subscription loss.

All required gates pass. No non-blocking finding was promoted; NB-1 was examined specifically against the widened surface and remains latent and non-blocking.

---

## 1 · Verification pass — what was actually run

All commands run on this working tree, 2026-08-15, local Supabase healthy (`supabase status` → running; keys from `supabase status -o env`).

| Gate | Command | Result |
|---|---|---|
| Production build | `pnpm build` | ✅ **PASS** — exit 0, full route manifest generated (Next 16.2.6 / Turbopack) |
| Typecheck | `pnpm typecheck` | ✅ **PASS** — exit 0, no diagnostics |
| Full unit suite | `pnpm test` | ✅ **PASS** — **363 files, 2 847 tests, 0 failures** (122.7 s) |
| Integration / RLS | `pnpm test:integration` (local Supabase) | ✅ **PASS** — **55 passed, 1 skipped; 488 tests passed, 3 skipped** (83.8 s) |
| Adversarial / eval | `pnpm test:ai-adversarial` | ✅ **PASS** — 2 files, **136 tests** |
| Ops suite | `pnpm test:ops` | ✅ **PASS** — 3 files, 20 tests |
| **i18n unused gate** | `pnpm i18n:unused` | ✅ **PASS** — exit 0, *"no unreferenced keys"* (**was FAIL / B-1**) |
| i18n parity | `pnpm i18n:missing` | ✅ **PASS** — 3 988 base leaf messages, variants valid |
| i18n source gate | `pnpm lint:i18n` | ✅ **PASS** — 439 files, 43 documented exceptions |
| RTL gate | `pnpm lint:rtl` | ✅ **PASS** — 680 files, 17 documented exceptions |
| Lint | `pnpm lint` | ✅ **PASS** — exit 0, **0 errors, 28 warnings** (identical to baseline) |
| Assistant E2E | `PORT=3100 playwright test p4b-assistant phase5f-privileged-actions --workers=1` | ✅ **PASS** — **4/4** (1.5 min) |
| Whitespace | `git diff --check`, `git diff HEAD --check` | ✅ **PASS** — exit 0 both |

Unit, integration and adversarial counts reproduce the implementation report's figures exactly (363/2 847, 55/488, 136).

### Negative controls and independent probes executed

1. **B-1 — the gate still bites.** Patched `PACKAGE_HISTORY_REPORT: t("packageHistoryReport")` → a literal, re-ran the real checker: **exit 1, `Unused catalog keys (1): documents.catalog.packageHistoryReport`**. Restored; `diff -q` byte-identical; gate back to exit 0.
2. **B-1 — the checker was not weakened.** `git diff HEAD -- scripts/` is **empty**. `scripts/check-messages.mjs` is unmodified, and `dynamicNamespaces` still contains only `{language, validation, marketing, legal, actionErrors}` — `documents.catalog` was **not** added.
3. **B-1 — no key was deleted.** `messages/en.json` and `messages/ar.json` each carry all **21** `documents.catalog` leaves, and each of the 21 is referenced by string literal in `module-labels.ts`. Every key removed anywhere in `messages/*` by this work was audited: each is either genuinely unreferenced (superseded-tool labels, `taxInvoiceNote`, `aiCommercialTermsRequireProAi`) or **moved rather than deleted** (`staffSheetDescription`, `saveAiCommercialTerms`, `aiCommercialTermsAuditNote`, `type_ai_escalation_body` all still resolve in both locales). None of these deletions is part of the B-1 fix.
4. **B-2 — action-registry census, re-derived.** `AI_ACTION_REGISTRY` = **89** actions. Authorized per role: admin **88**, manager **60**, receptionist **41**, doctor **21**, assistant **22** — matching the prior review's census exactly, i.e. the role lists were **not** touched by the fix.
5. **B-2 — mount/registry agreement.** `ACTION_CAPABLE_ROLES` resolves to all five roles; `roleMountsActionTools(role) === (authorizedActionCount(role) > 0)` holds for every role. Both `execute_action` and `describe_action` hold `ACTION_CAPABLE_ROLES` **by object identity** (`def.roles === ACTION_CAPABLE_ROLES` → `true`), so re-hard-coding either is caught.
6. **B-2 — the regression suite is not vacuous.** Reverted both tool entries to `roles: ADMINISTRATIVE` and re-ran `final-b2-action-reachability.test.ts`: **3 failed | 18 passed** — the mount/registry agreement test and both per-role reachability tests fail. Restored byte-identically.
7. **B-2 — no over-grant.** Doctor and assistant authorize **zero** `risk: "privileged"` actions. `staff.change_role`, `staff.permanent_delete`, `staff.reset_password`, `assistant.reference_check`, `appointments.send_reminders`, `invoices.send_reminders` are all absent from both roles' sets.
8. **`staff_help` containment.** Tools declaring `staff_help`: `describe_capabilities`, `search_help`, `get_navigation_target`, `list_my_capabilities` — **only** those four. `execute_action`/`describe_action` declare `SHARED_TASKS` (`staff_clinical_summary`, `staff_administrative`, `staff_operational_query`), and `resolveToolMount`'s help branch *does* consult the per-definition list, so a help turn still mounts no action tool.
9. **Task-class reachability (NB-1 re-check).** `staffTaskForRole` can return only `staff_help`, `staff_composite`, `staff_clinical_summary` (clinical roles) or `staff_help`, `staff_composite`, `staff_operational_query`, `staff_administrative` (administrative roles) — every one of which is present in that role's `STAFF_TASK_CLASSES_BY_ROLE` entry. `activeTaskClasses` is therefore never empty on any reachable path.
10. **Health Care Pro — direct SQL against local Postgres.** Exactly one row, `pro_ai`, `status = active`, `current_period_end = 2027-08-08`, `trial_ends_at` null, terms accepted, **`clinic_feature_overrides` count = 0**. All 13 expected `ai.*` keys resolve `true` through the canonical SQL `effective_ai_feature`; `ai.patient_auto`, `ai.hybrid_fallback`, `ai.followup_generation` resolve `false` — the three the `pro_ai` plan row itself sets false.
11. **Health Care Pro — fail-closed negative controls (transaction-scoped, rolled back).** Withdrawing `accepted_at` → `ai_assistant`, `ai.staff_assistant`, `ai.write_records` all `false`. Setting `status = 'cancelled'` → all `false`. Expiring `current_period_end` → `false`. Post-rollback re-read → all `true`.
12. **No clinic-name special case.** `grep -rn "Health Care Pro"` over `lib actions app components supabase types` → **zero hits**; the name exists only in `scripts/seed-dev-clinic.ts`. `grep -rn "pro_ai" lib/` → **zero hits** (review D-6 still holds).

---

## 2 · B-1 — `pnpm i18n:unused` — verified fixed

**Fix as implemented.** [lib/documents/module-labels.ts:29-33](../../lib/documents/module-labels.ts#L29-L33) resolves the locale *before* binding the translator, so the binding is a single literal object-form call:

```ts
const resolvedLocale = locale ?? (await getLocale());
const t = await getTranslations({ locale: resolvedLocale, namespace: "documents.catalog" });
```

This is the review's preferred option 1.

**Independently confirmed against every constraint the brief set:**

| Constraint | Verdict | Evidence |
|---|---|---|
| Gate genuinely green | ✅ | `pnpm i18n:unused` exit 0 |
| No valid translation key deleted | ✅ | 21/21 `documents.catalog` leaves present in EN **and** AR; every other removal audited (probe 3) |
| Checker not weakened | ✅ | `git diff HEAD -- scripts/` empty; regexes at `check-messages.mjs:222-227` untouched |
| No exemption added | ✅ | `dynamicNamespaces` unchanged; `documents.catalog` absent from it |
| EN/AR behavior unchanged | ✅ | The no-argument `getTranslations` form resolves the request locale, which is precisely `getLocale()`; the explicit-locale path is unchanged. `getDocumentTypeLabels()` / `getDocumentTypeLabel(code, locale)` keep their signatures; `pnpm i18n:missing` and `pnpm lint:i18n` both pass; the P7 capability-panel E2E renders both locales |
| Gate still bites | ✅ | Negative control (probe 1): one deleted lookup → exit 1 naming that exact key |

The self-reported second defect (a comment containing a literal translator call turning `i18n:missing` red — the checker's scan is lexical and does not skip comments) is real, is fixed, is pinned by test 4 of the B-1 suite, and carries an in-file warning at [module-labels.ts:21-24](../../lib/documents/module-labels.ts#L21-L24). Disclosing it rather than dropping it is the right call.

**B-1 is closed.**

---

## 3 · B-2 — action reachability — verified fixed

**Fix as implemented.** [lib/ai/tools/registry.ts:137-144](../../lib/ai/tools/registry.ts#L137-L144):

```ts
export const ACTION_CAPABLE_ROLES: readonly UserRole[] = ALL_STAFF.filter(
  (role) => AI_ACTION_REGISTRY.some((action) => action.roles.includes(role)),
);
export function roleMountsActionTools(role: UserRole): boolean {
  return ACTION_CAPABLE_ROLES.includes(role);
}
```

Both `execute_action` and `describe_action` carry `roles: ACTION_CAPABLE_ROLES`.

**This is a derivation, not a hand-maintained AI role list.** The only literal is `ALL_STAFF`, which is the complete `UserRole` set — the candidate universe, not an AI policy. Which of those roles actually mount is decided entirely by the action registry, whose role arrays are themselves copied from the domain cores (`CLINICAL_MUTATION_ROLES`, `MEDICAL_NOTE_WRITE_ROLES`, `APPOINTMENT_*_ROLES`, `FOLLOWUP_*_ROLES`, `SETTINGS_*_ROLES`, `PRIVILEGED_*_ROLES`). Registering the first action for a role mounts the tools by construction; removing the last one unmounts them.

**Every reachable role mounts iff it has ≥ 1 authorized action** — verified for all five (probe 5), and pinned by a test that fails under reversion (probe 6).

**Discovery and execution stay bounded by the per-action gates.** `assertActionAccess` ([lib/ai/actions/execute.ts:108-146](../../lib/ai/actions/execute.ts#L108-L146)) is unchanged and remains the authority, running at preview *and* again at execute after the confirm token is burned:

| Gate | State |
|---|---|
| Per-action `roles` | ✅ unchanged — first check, throws `unauthorized_role` |
| `assertStaffToolAccess` (subscription / usage / auth) | ✅ unchanged |
| Plan entitlements → `hasFeature` → `resolveEffectiveAiFeature` | ✅ unchanged |
| Per-user AI permission (`requiredUserPermission`) | ✅ unchanged |
| Page visibility (`pageSlug` → `getPageVisibilityState`) | ✅ unchanged, incl. `lookup_failed` → `transient_failure` |
| RLS / tenant predicate | ✅ untouched — no data path was modified |
| Confirmation, single-use token, replay claim, TTL (10 min / 2 min privileged) | ✅ unchanged |
| Re-authorization after token burn | ✅ unchanged |
| Step-up reauth, privileged target/before→after binding, no self-mutation | ✅ unchanged ([execute.ts:148-175](../../lib/ai/actions/execute.ts#L148-L175)) |
| Receipts on allow **and** deny, both phases | ✅ unchanged |
| Rate limits (per-conversation / per-day, both phases) | ✅ unchanged |

**Doctor and assistant reach only what is authorized for them** (probes 4, 7): doctor → `appointments.{replace,undo_status,start_session}`, `medical_notes.*`, `prescriptions.*`, `lab_requests.*`, `sick_leaves.*`, `documents.{issue,reprint}` (21). Assistant → `appointments.{create,replace,update_status,arrive,confirm_and_displace}`, `followups.{record,update}`, the clinical drafts, `billing.complete_appointment`, `documents.{issue,reprint}` (22). Zero privileged actions for either. `tests/unit/ai/phase7-capability-surface.test.ts` adds the negative half — every advertised action must name that role in its own `roles` list, and admin-only actions must stay admin-only.

**`staff_help` containment is intact** (probe 8). The help branch of `resolveToolMount` is the one place the per-definition `taskClasses` list *is* consulted, and neither action tool declares `staff_help`. `phase4-orchestration.test.ts` still asserts `execute_action` absent from an admin help mount.

**Doctor prompt.** [lib/ai/prompts/doctor.ts:31, 36](../../lib/ai/prompts/doctor.ts#L31) (EN) and [:47, 52](../../lib/ai/prompts/doctor.ts#L47) (AR) both now describe the authorized write surface. The read-only framing is gone from **both** locales. The clause is capability-neutral — it names no action, directs the model to `describe_action` for the caller's real set, and repeats that every change is a preview requiring on-screen confirmation. It does not re-impose an AI-local restriction, and it does not over-promise.

**Export hatch.** [lib/ai/resources/export-hatch.ts:58](../../lib/ai/resources/export-hatch.ts#L58) adds `if (!roleMountsActionTools(user.role)) return null;` ahead of the catalog-role, plan-feature and report-visibility checks, so the module's stated invariant now holds structurally. Verified in both directions by unit test (mount-false → `null`; doctor → suggestion). See O-1 for a residual hardening note — it does not affect correctness today.

**Adversarial corpus.** The three `privilege_escalation` cases (`inj-en-escalate-02`, `-03`, `-escalate-privileged-01`) moved from `forbiddenTool: "execute_action"` to `forbiddenAction: {appointments.send_reminders, invoices.send_reminders, staff.change_role}`. This is **strictly stronger, not weaker**: the old assertion ("a doctor cannot mount `execute_action`") was an artefact of the defect and would have stayed green forever while the doctor's whole write surface was broken. The new one asserts the targeted action is absent from the session role's own `roles` list *and* that `execute_action` **is** reachable, so the denial is a real action-level refusal rather than an absence. It is driven from two independent directions — structurally in `p6a-injection-suite.test.ts` against the live registry, and behaviourally in the B-2 suite through the real `previewRegisteredAction` (expecting `unauthorized_role`, a `denied` receipt, and no token minted) — plus a new corpus-integrity test that every `forbiddenAction` names a real registered action id. I confirmed all three ids are genuinely absent from the doctor's authorized 21. The 138 → 136 count change is fully accounted for (−6 from two `it.each` blocks, +3 action-containment, +1 corpus integrity) and represents no coverage loss.

**Corrected tests were strengthened, not loosened.** `phase4-orchestration.test.ts` now derives its expectation from `AI_ACTION_REGISTRY` instead of hard-coding three roles — it can no longer be satisfied by a stale list. `phase7-capability-surface.test.ts` replaced a pinned `actions: []` with an equality against `describeAuthorizedActions` plus a new anti-widening test. `p4b-assistant.spec.ts` now asserts the doctor panel *does* render an actions section and distinguishes doctor from admin on the **privileged** badge, in both locales, with the same Axe budget.

**B-2 and its second-order defect are closed.**

---

## 4 · Health Care Pro development setup — verified

| Requirement | Verdict | Evidence |
|---|---|---|
| No production special-case on clinic name | ✅ | `grep -rn "Health Care Pro" lib actions app components supabase types` → zero hits; the name lives only in `scripts/seed-dev-clinic.ts` |
| Behaves as a normal `pro_ai` subscriber through the canonical entitlement system | ✅ | One `clinics` row + one `subscriptions` row (`plan_id` → `pro_ai`, `status: active`, `trial_ends_at: null`) + one `ai_commercial_terms` row. Capabilities resolve through `effective_ai_feature` (SQL) and `resolveEffectiveAiFeature` → `hasFeature` (TS), both slug-free |
| Active subscription + accepted AI terms are what grant capabilities | ✅ | `resolveEffectiveAiFeature` short-circuits `false` on `!subscriptionAllowed \|\| !termsAccepted` before any feature lookup ([commercial-policy.ts:58](../../lib/ai/commercial-policy.ts#L58)); `hasFeature` re-checks `subscriptionAllowed` first ([entitlements.ts:141-149](../../lib/entitlements.ts#L141-L149)) |
| No feature override / entitlement bypass | ✅ | `clinic_feature_overrides` count for this clinic = **0**, confirmed by direct SQL. No entitlement code differs in behaviour for this clinic; the 13 true keys come from the `pro_ai` plan row's own feature map |
| Revoking terms fails closed | ✅ | `accepted_at → null` (rolled back): `ai_assistant`, `ai.staff_assistant`, `ai.write_records` → **false** |
| Revoking subscription fails closed | ✅ | `status → 'cancelled'` → **false**; `current_period_end` in the past → **false**. Both restored on rollback |
| Seeding is safely local-only | ✅ | `requireLocalService()` rejects any hostname other than `127.0.0.1`/`localhost` ([seed-dev-clinic.ts:72-77](../../scripts/seed-dev-clinic.ts#L72-L77)), reads `LOCAL_SUPABASE_URL` (which `.env.local` sets to `http://127.0.0.1:54321`) rather than `NEXT_PUBLIC_SUPABASE_URL`, and is idempotent (upserts throughout). See O-3 for a low-severity hardening note |
| No remote modification | ✅ | Nothing in this review or in the seed path can reach the remote project; the seed throws on a non-local host, and every probe I ran targeted `127.0.0.1:54322` with mutations inside `begin … rollback` |

The implementation report's diagnosis is correct and I reproduced it: the clinic did not exist as a durable fixture, a signup-created clinic lands on Basic with no terms row, and on that shape every `ai.*` key correctly resolves false. **The Assistant's "Pro + AI only" message was accurate; the fixture was wrong.** Nothing was masked.

The report's own caveat is also correct and worth repeating: `.env.local` points `NEXT_PUBLIC_SUPABASE_URL` at the **remote dev project**, so the clinic seen during `pnpm dev` lives there, not in local Supabase. The delivered fix is the local one that was asked for. Correcting the remote dev project, if wanted, is an operator grant of `pro_ai` plus an AI commercial-terms acceptance through the existing operator UI — the same two rows, through the product's own path, with no code change. **That was correctly not done here.**

---

## 5 · Carried findings NB-1 … NB-5 — re-judged against the integrated implementation

None is promoted. Each was re-examined against the final tree, not carried forward by default.

### NB-1 (Medium, **stays non-blocking**) — `taskClasses` is inert on non-help turns

Re-checked specifically because B-2 enlarged the surface it could silence.

`resolveToolMount` ([lib/ai/tools/index.ts:88-90](../../lib/ai/tools/index.ts#L88-L90)) still evaluates `ctx.taskClass === "staff_help" ? definition.taskClasses.includes("staff_help") : activeTaskClasses.length > 0`, so for any non-help class the per-definition array is never consulted; `staff_composite` still appears in no definition's `taskClasses`; and an out-of-range class would still mount **zero** tools rather than raise a typed denial. Unchanged by the fixes.

**It did not become blocking, in either direction:**

- *Over-permission:* impossible. The one containment class — `staff_help` — is the one branch that *does* consult the per-definition list, and neither action tool declares it. A help turn cannot reach `execute_action`.
- *Under-permission (whole-surface loss):* still unreachable. `staffTaskForRole` returns only classes present in that role's `STAFF_TASK_CLASSES_BY_ROLE` entry (probe 9), so `activeTaskClasses` is never empty on any reachable path.
- *Interaction with B-2:* the action tools declare `SHARED_TASKS`, which includes `staff_clinical_summary` — the class clinical roles route to. So even if the per-definition check were restored for all classes tomorrow, doctors and assistants would keep the action tools. The one class that would break under such a restoration is `staff_composite`, which no tool declares — and that is a property of the *proposed fix*, not of the current behaviour.

It remains a latent trap and the right next item to schedule, exactly as both prior documents say. It is not a defect in the shipped behaviour.

### NB-2 (Low, unchanged) — residual `ai_workflow_runs` surface
Still listed in `CLINIC_SCOPED_TABLES` ([lib/supabase/admin.ts:2094](../../lib/supabase/admin.ts#L2094)) and still exercised by `tests/unit/integration/p411a-workflow-runs-rls.test.ts`. Harmless — writes are revoked at the database. Dead surface area, not a defect.

### NB-3 (Low, **narrowed** by this review) — entitlement cache window vs. plan §13
`getEntitlements` still wraps `loadEntitlements` in `unstable_cache` with `revalidate: 300`, tagged `entitlements:<clinicId>` ([lib/entitlements.ts:133-139](../../lib/entitlements.ts#L133-L139)). The prior review asked for an audit of the `revalidateTag` call sites; I performed it. **All seven entitlement-mutating write paths invalidate the tag**: `grantManualSubscription`, `cancelManualSubscription`, `upsertFeatureOverride`, `removeFeatureOverride`, and `updateAiCommercialTerms` (twice), plus `lib/billing/coupons.ts:124`. The residual is therefore narrower than stated: only a *time-based* transition with no accompanying write — a `current_period_end` lapsing mid-window — can lag by up to 5 minutes. Commercial, not security; role and permission gates read live via `auth_profile()`, and preview→confirm re-asserts from scratch. Reconciling §13's "request-scoped only" wording with this deliberate commercial cache is still worth a sentence in the plan.

### NB-4 (Low, unchanged) — 28 eslint warnings, 0 errors
Re-run confirms **exactly** 28 warnings, 0 errors, in the same files as baseline. Not gating.

### NB-5 (Low, unchanged) — Assistant E2E not parallel-safe locally
Still true. The run above used `--workers=1` and passed 4/4. CI is unaffected (`workers: 1`, and CI does not run E2E).

---

## 6 · Remaining non-blocking observations (new, from this review)

None blocks; none requires action before merge.

| ID | Severity | Observation |
|---|---|---|
| **O-1** | Low | **The export-hatch mount check is coarser than the capability it advertises.** [export-hatch.ts:58](../../lib/ai/resources/export-hatch.ts#L58) asks `roleMountsActionTools(user.role)` — "does this role have *any* authorized action?" — but the guidance names `documents.issue` specifically. These coincide today because `DOCUMENT_ACTION_ROLES` is all five roles, so there is no live gap. If `documents.issue` were ever narrowed while the role kept other actions, the advisory would again name an action the caller cannot invoke — the exact shape of the defect just fixed. Checking the `documents.issue` definition's own `roles` (or simply calling `describeAuthorizedActions`) would make the invariant hold under that change too. |
| **O-2** | Low | **`ALL_STAFF` carries no exhaustiveness constraint.** [registry.ts:103-109](../../lib/ai/tools/registry.ts#L103-L109) is a hand-written five-element array with no `satisfies` check against `UserRole`. A sixth role added to `UserRole` would silently be excluded from the `ACTION_CAPABLE_ROLES` derivation. `STAFF_TASK_CLASSES_BY_ROLE` does carry `satisfies Record<UserRole, …>` and would fail to compile, which limits the blast radius, but the derivation's own universe would benefit from the same guard. |
| **O-3** | Low | **`scripts/seed-dev-clinic.ts` falls back to `SUPABASE_SERVICE_ROLE_KEY`.** [seed-dev-clinic.ts:46-47](../../scripts/seed-dev-clinic.ts#L46-L47) uses `LOCAL_SUPABASE_SECRET_KEY ?? SUPABASE_SERVICE_ROLE_KEY`, and `pnpm dev:seed-clinic` loads `.env.local`, where that variable is the **remote** project's key. No remote write is possible — the hostname guard runs first and `LOCAL_SUPABASE_URL` defaults to `127.0.0.1` — so the guard is doing its job. But it means a remote secret can be paired with a local URL, and the host check is the single thing standing between the two. Requiring `LOCAL_SUPABASE_SECRET_KEY` outright would remove the coupling entirely. |

---

## 7 · Regression check across Phases 0 → 7

No regression found.

- **Suites.** 2 847 unit tests (up 25 from the reviewed tree, all additions), 488 integration tests (up 22), 136 adversarial, 20 ops, 4/4 E2E — all green. Build and typecheck clean. Lint identical to baseline (0 errors, 28 warnings, same files).
- **i18n / RTL.** All four gates green, including the one that was red. Message parity holds at 3 988 base leaves; the only EN/AR leaf asymmetry (`marketing.faq.items.8`) is **pre-existing on HEAD** (9 EN items vs 8 AR) and unrelated to this work.
- **Blast radius.** The fixes touched four production files (`module-labels.ts`, `tools/registry.ts`, `resources/export-hatch.ts`, `prompts/doctor.ts`), one eval-data file, one new script and one `package.json` script. None is on a data path; none alters an authorization decision beyond making the action-tool mount agree with the registry.
- **Prior accepted decisions D-1 … D-9 still hold.** Spot-verified D-6 (`grep -rn "pro_ai" lib/` → zero hits), D-7 (no plan/subscription/platform-operator mutation in the 89-action registry), and D-9 (`privilegedTarget` still throws `unauthorized_scope` when `target === user.id`).
- **Pre-existing unrelated defects** are unchanged and still do not block: 27 non-AI eslint warnings, the Turbopack NFT tracing warning via `lib/documents/pdf/fonts.ts` (observed again in the E2E web-server log), the Next 16 `middleware` → `proxy` deprecation warning, and the local-only `supabase_imgproxy`/`supabase_pooler` stopped services plus the outdated Supabase and Vercel CLIs.

---

## 8 · Summary

| Category | Count | Items |
|---|---|---|
| **Blocking** | **0** | — |
| Fixed and verified this round | 3 | B-1, B-2 (incl. second-order export hatch), Health Care Pro dev entitlement |
| Carried non-blocking, re-judged, none promoted | 5 | NB-1 (Medium, latent) … NB-5 (Low) |
| New non-blocking observations | 3 | O-1, O-2, O-3 |
| Pre-existing unrelated | 4 | non-AI eslint warnings, NFT tracing warning, middleware deprecation, local env/CLI versions |
| Accepted decisions unchanged | 9 | D-1 … D-9 |

B-1 was fixed by making the code match what the checker can prove, rather than by making the checker stop asking — the distinction the acceptance criterion was written to force, and the probe confirms the gate still fails on a real omission. B-2 was fixed by deleting an authorization fact rather than duplicating it: the tool mount is now a projection of the action registry, which is itself a projection of the domain cores, so the three cannot disagree. The security posture is unchanged in every direction I could probe — mounting grants nothing, the per-action gates still decide, privileged actions remain out of reach for the clinical roles, `staff_help` still contains, and the adversarial corpus now tests the boundary that actually holds the line instead of one that happened to hold because of a bug.

**FINAL VERDICT: PASS**
