# AI Assistant — Phase 5f Review (Privileged actions only) — re-review after fixes

**Scope reviewed:** `docs/plans/AI_ASSISTANT_FULL_CAPABILITY_PLAN.md` §11.1 and §15 "Phase 5f — Privileged actions (roles & permissions)", against the working-tree implementation on `feat/p7-manual-qa-polish`, after the fix cycle documented in `docs/reports/AI_ASSISTANT_PHASE_5F_IMPLEMENTATION.md`.

**Verdict: Phase 5f: PASS.**

All five findings from the previous review (F1–F5) and the additional F1-b defect surfaced by the corrected E2E are resolved in the real implementation, each with regression coverage that would fail if the defect returned. The §15 acceptance scenario is now proven in a passing browser test, reproduced independently in this review. No new findings.

---

## Verification actually performed in this re-review

Every command below was run by the reviewer, not taken from the implementation report.

| Check | Command | Result |
|---|---|---|
| Typecheck | `npx tsc --noEmit` | **PASS** (exit 0) |
| Phase 5f targeted units | `vitest run tests/unit/ai/phase5f-privileged-actions.test.ts tests/unit/ai/phase5f-review-fixes.test.ts tests/unit/actions/phase5f-step-up-boundary.test.ts tests/unit/actions/phase5f-settings-parity.test.ts tests/unit/lib/phase5f-step-up-session-safety.test.ts` | **PASS** — 5 files / 38 tests |
| Full unit regression | `npx vitest run --exclude "tests/unit/integration/**"` | **PASS** — 349 files / 2551 tests |
| Local Supabase migration state | `supabase migration list --local` | `20260814120000` applied |
| Integration + RLS (Phase 1/2/3/5/5f, tenant isolation, control plane) | `LOCAL_SUPABASE_* … vitest run tests/unit/integration --no-file-parallelism` | **PASS** — 53 passed / 1 skipped (462 tests, 3 skipped) |
| **Phase 5f browser E2E** | `PORT=3100 LOCAL_SUPABASE_* … playwright test tests/e2e/phase5f-privileged-actions.spec.ts` | **PASS** — 1 passed |
| Affected assistant E2E | `… playwright test tests/e2e/p4b-assistant.spec.ts` | **PASS** — 2 passed |
| Adversarial / injection suite | `pnpm test:ai-adversarial` | **PASS** — 112 tests |

The previous review's single blocking failure — the Phase 5f E2E timing out on the composer — no longer reproduces. The full run (`3 passed (46.9s)`, one worker, clean `pnpm build && pnpm start` on port 3100) exercises preview card → rendered `receptionist → manager` diff → confirm disabled until password → step-up → committed role change → `allowed`/`success` execute receipt → `ai_privileged_change` notification → actor still on `/assistant`.

---

## Finding-by-finding resolution

### F1 — HIGH — E2E could not reach the assistant surface → **RESOLVED**

`tests/e2e/phase5f-privileged-actions.spec.ts:236-246` now inserts an accepted `ai_commercial_terms` row (`accepted_at`, `change_reason: "pilot"`, `updated_by: ids.admin`, `overage_mode: "hard_cap"` + `overage_budget_micros: 0` to satisfy `ai_commercial_terms_overage_shape`), deleted at `:271` in `afterAll` before the subscription/clinic teardown. `tests/e2e/p4b-assistant.spec.ts:145-153` carries the same seeding, cleaned up in the shared `cleanup()` at `:35`.

Verified by running both specs, not by reading them: the composer mounts, the privileged card renders, and every original assertion holds. The `change_reason` NOT NULL constraint noted in the previous review is satisfied.

**Coverage:** `tests/unit/ai/phase5f-review-fixes.test.ts:445-461` is a source-level guard requiring both specs to contain the insert (with `accepted_at` and `change_reason`) and the cleanup delete. Source-level is the correct shape here — the failure mode is a spec that silently stops exercising the surface, which no runtime assertion inside those specs can detect.

### F1-b — HIGH (new, found by the corrected E2E) — step-up revoked the actor's global session → **RESOLVED**

`lib/auth/step-up.ts:37` calls `verifier.auth.signOut({ scope: "local" })`, with an inline comment (`:31-36`) recording why the supabase-js default is unsafe here. The throwaway client is created with `persistSession: false` / `autoRefreshToken: false` / `detectSessionInUrl: false`, so the local revoke touches only the session the function just minted; the browser session is untouched. Sign-out is skipped entirely on a failed credential, and the identity check (`result.data.user?.id === user.id`) still fails closed.

**Coverage, two independent layers:**
- `tests/unit/lib/phase5f-step-up-session-safety.test.ts` — asserts the call is exactly `{ scope: "local" }` and explicitly *not* a bare `signOut()`, `{ scope: "global" }`, or `{ scope: "others" }`; asserts no sign-out on a wrong credential; asserts a mismatched verified identity returns `false`.
- `tests/e2e/phase5f-privileged-actions.spec.ts:317` — `await expect(page).toHaveURL(/\/assistant/)` after the confirmation completes, so a session-destroying step-up fails the browser test directly. This is the layer that caught the bug originally and is the one that keeps catching it.

The only call site is `actions/assistant-actions.ts:82`, inside the privileged branch of `confirmAssistantAction`, behind its own 5/15-min rate limit — unchanged.

### F2 — LOW — phantom unchanged "Supervising doctors" row → **RESOLVED**

`lib/ai/actions/canonical.ts` (new) holds `stableValue` / `canonicalActionInput` / `ActionConfirmationError` / `ACTION_INPUT_MAX_BYTES` plus the new `sameCanonicalValue`. It carries no `server-only` marker, which is what lets `lib/ai/actions/types.ts` (client-reachable) use the identical canonicaliser. `lib/ai/actions/confirm.ts:29-35` re-exports all four names, so every existing import path and every `vi.mock("@/lib/ai/actions/confirm")` behaves as before, `instanceof ActionConfirmationError` included — confirmed by the full unit suite passing unchanged.

Three call sites now agree on what "changed" means:
- `lib/ai/actions/definitions/privileged.ts:101` — `!sameCanonicalValue(before[field], after[field])` in `explicitChanges`.
- `lib/ai/actions/types.ts:182` — `assertActionPreviewContract`'s privileged "must contain an explicit before→after change" rule.
- `lib/ai/actions/confirm.ts` `actionDigest` — the same normalisation the token's before/after digests are built from.

`sameCanonicalValue` falls back to reference equality when the canonicaliser refuses a value (undefined, class instance, cycle, depth/size overflow), so an uncomparable field is reported as changed rather than silently dropped from a security diff — the safe direction for an attestation.

**Coverage:** `phase5f-review-fixes.test.ts:250-298` — three tests, using a `coreResult` fixture that deliberately mirrors the real `updateStaffMutation` shape (two *distinct* array instances on before and after). An unchanged list yields changes exactly `["Staff member", "Role"]`; a genuine addition still emits the row with distinct values; a fully no-op privileged input is still rejected by `ActionPreviewContractError`.

### F3 — MEDIUM — new primary-admin restrictions narrowed Settings UI → **RESOLVED (review option 1)**

The rule moved to the Assistant boundary and the UI went back to legacy behaviour.

- `lib/settings/mutations.ts` — `updateStaffMutation`, `setStaffActiveMutation` and `staffLifecycleMutation` no longer call `primaryAdminMutationBlocked`. Grep confirms the only remaining call sites are `setPagePermissionMutation:1718`, `setReportPermissionMutation:1838`, `savePagePermissionsMutation:1933` and `saveReportPermissionsMutation:2025` — all **pre-existing** primary-admin-*target* blocks that `actions/page-permissions.ts` and `actions/report-permissions.ts` already had, alongside the untouched `assertPrimaryAdminPermissionActor`. Settings → Staff behaves as `actions/settings-legacy.ts` did.
- `lib/ai/actions/definitions/privileged.ts:125-142` — per-action `primaryAdminBoundaryGuard { blocks, code }`, evaluated in **both** `preview` and `execute` **before** the core runs (`:171-176`, `:188-193`), resolving through the real `isPrimaryClinicAdmin`. It throws `ActionBusinessRuleError`, so the attempt is audited as `business_rule_refused` with the specific key in `error_code` — not swallowed.
- Guard placement matches intent: `staff.change_role` blocks only a change *away* from admin; `staff.set_active` only a deactivation; `staff.soft_delete` / `staff.permanent_delete` always; `staff.restore` and `staff.reset_password` carry none, mirroring legacy's absence of a guard there.
- `messages/action-errors/{en,ar}.json` — three new operation-specific keys under `settings.*`, EN and AR, each naming the attempted operation and pointing to Settings → Staff. None uses "customize"/"تخصيص".

**Coverage, at three levels:**
- `tests/unit/actions/phase5f-settings-parity.test.ts:139-213` — `updateStaffMutation` (demotion), `setStaffActiveMutation` (deactivation), `staffLifecycleMutation` (`soft_delete`, `permanent_delete`) all succeed against a primary-admin target and never even call `getPrimaryClinicAdminId`; plus an assertion that no staff core emits the page-permission "cannot be customized" code.
- `phase5f-review-fixes.test.ts:300-341` — the boundary refuses a primary-admin demotion with `settings.thePrimaryClinicAdminRoleCannotBeChanged` **before** the core runs (`expect(mocks.changeRole).not.toHaveBeenCalled()`), does *not* fire when the requested role keeps the target an admin, and both locales carry all three keys with operation-appropriate wording.
- `tests/unit/integration/phase5-domain-write-rls.test.ts:355-388` — against the **real database**: the core allows the primary-admin demotion, and `registeredAction("staff.change_role").previewValidated(...)` for a second admin rejects with `ActionBusinessRuleError` / `settings.thePrimaryClinicAdminRoleCannotBeChanged`. This is the assertion that would catch the guard drifting back into the core.

### F4 — MEDIUM — bulk permission saves lost role filtering and atomicity → **RESOLVED**

Two new batch cores, `savePagePermissionsMutation` (`lib/settings/mutations.ts:1914-2003`) and `saveReportPermissionsMutation` (`:2006-2073`), each: assert the admin-only role → assert the primary-admin **actor** requirement → load the target → block a primary-admin **target** → (pages) apply `managerCanManageStaffTarget` → **filter the change list** → return success with zero writes if nothing remains → write survivors in **one** upsert → revalidate `/settings/customize`. The page core preserves the `user_customizations` fallback for a missing `user_page_permissions` table.

Filter parity checked against the pre-change implementations line by line: pages drop `dashboard` and anything outside `getRolePageSlugs(target.role)`; reports drop non-`isReportId` values and anything outside `reportsOpenableByRole(target.role)` — and legacy's `configurableReportsForRole` (`actions/report-permissions.ts:65-69`) is a thin alias of `reportsOpenableByRole`, so the sets are identical. The reordering of "primary-admin target" to after the target load is behaviourally inert (the primary admin always resolves as an existing profile). Both actions are reached only through `requireMutationRole("admin")`, so legacy's `user.role === "admin"` / `user.role === "manager"` sub-branches were already unreachable.

`actions/page-permissions.ts` and `actions/report-permissions.ts` call the batch core once instead of looping; `updateUserPageVisibility` keeps the per-item core and its per-item refusals, and `updateUserReportVisibility` still delegates to the bulk saver — both exactly as before.

**Coverage:** `phase5f-settings-parity.test.ts:215-298` — `[patients, dashboard, settings, appointments]` for a receptionist writes `[appointments, patients]` in **exactly one** upsert and returns `{ success: true }`; an all-invalid set returns success with **zero** writes; the single-item saver still returns `page-permissions.dashboardCannotBeHidden` and writes nothing; the report twin drops an out-of-role report and a non-report id, writes `[no_shows, revenue]` in one upsert; an all-invalid report set returns success with no write. The `toHaveLength(1)` upsert assertions are what pin atomicity, and the partial-write-then-error scenario from the original finding is structurally unreachable now.

### F5 — MEDIUM — a committed mutation could be recorded and reported as failed → **RESOLVED**

The ordering is inverted and the notifier no longer throws.

- `lib/ai/actions/privileged-notifications.ts` returns a typed `PrivilegedNotificationResult` — `{ delivered: true, recipientCount }` or `{ delivered: false, reason: "recipient_lookup_failed" | "no_active_admin" | "emit_failed" }`. No throw path remains.
- `lib/ai/actions/execute.ts:648-664` finalizes the authoritative receipt with the real audit digests **immediately after the core commits**, before anything optional runs. Only then (`:665-679`) is delivery attempted, via `deliverPrivilegedNotification` (`:278-353`), which is fully wrapped: a throwing notifier is caught and treated as `notifier_threw`, and even the follow-up-receipt write is inside its own try/catch. It cannot throw, so the generic catch at `:693-742` can never relabel a committed mutation.
- Delivery failure is surfaced on two separate, auditable paths: Sentry (`area: assistant-privileged-notification`, with source receipt id and reason) and a **distinct receipt row** under `PRIVILEGED_NOTIFICATION_FAILURE_ACTION_ID = "assistant.privileged_notification"` with `authorization_outcome: allowed`, `outcome: error`, `error_code: privileged_notification_<reason>`, `target_table: notifications`. I checked that row against the real DDL (`supabase/migrations/20260813150000_…:57-85`): the action id satisfies `^[a-z][a-z0-9_.]{0,99}$`, `target_record_ids` is a valid `uuid[]`, and the error code is within the 100-char bound — so this is a row the database will actually accept, not just one the mocks accept.
- `ActionExecuteSuccess` gained optional `notification_delivered`, set only for privileged actions with a resolved target.

**Coverage:** `phase5f-review-fixes.test.ts:343-443` — four tests. A failing notifier yields `executed: true` / `notification_delivered: false` with a mutation receipt of `allowed` / `success` / `errorCode: null` and 64-hex before **and** after digests; the failure appears as its own receipt under a *different* action id with `errorCode: privileged_notification_emit_failed` and `targetTable: notifications`; a notifier that **throws** behaves identically; a succeeding notifier reports `notification_delivered: true`. The `privilegedNotifier` injection point makes this testable without mocking the Supabase layer.

---

## Safeguard stack re-verified (unchanged by the fix cycle, re-checked here)

- **Self-mutation impossible.** `privilegedTarget` (`execute.ts:141-155`) rejects `target === user.id` with `unauthorized_scope` at both preview and execute; `issue_ai_action_confirmation` independently raises `42501` when `p_target_user_id = p_actor_id`. Confirmed still present after the execute.ts edits.
- **Step-up cannot be bypassed.** The model-facing tool only previews and the token is stripped from model output. The only execute path is `confirmAssistantAction`, which for `risk === "privileged"` demands `currentPassword`, rate-limits 5/15 min *before* verification, verifies on the throwaway client, then mints a server-side nonce. `executeRegisteredAction` fails closed on a missing nonce (`step_up_required`), and `claim_ai_action_confirmation` refuses any privileged row whose `reauth_nonce_hash` mismatches or whose `step_up_verified_at` is outside a 2-minute window of the claim (migration `:204-209`).
- **Token binding.** 2-minute TTL enforced a second time in SQL (`p_expires_at > clock_timestamp() + interval '2 minutes 5 seconds'` rejected, `:110-111`); HMAC covers action id, input digest, actor, clinic, conversation, nonce, expiry and the privileged binding; the DB row independently stores `target_user_id` / `before_digest` / `after_digest`. Single use via `consumed_at`. The 7-argument Phase 3 `claim` overload remains structurally incapable of consuming a privileged row (`:348`, `:362`).
- **Stale state detected.** Execute re-runs the core in `preview` mode after claiming and compares the fresh binding to the token's (`execute.ts:614-632`); a drifted `before` burns the token and denies. Mutated input fails signature/digest verification before the claim.
- **Rate limits.** `consume_ai_privileged_action_rate_limit` takes `pg_advisory_xact_lock` (migration `:271`) before read/write; the table is RLS-enabled with all grants revoked (`:67-68`); all five privileged RPCs have `revoke all on function` (`:370-382`). Exercised against the live DB by the integration suite.
- **`ai.write_privileged` gates the surface.** Every privileged definition declares exactly that feature; `describeAuthorizedActions` filters through the same `assertActionAccess`, so an unentitled clinic never sees the actions described.
- **Authorization mirrors the UI.** `staff.change_role`, `page_permissions.set_visibility`, `report_permissions.set_visibility`, `ai_permissions.set` are admin-only; the five staff-lifecycle actions are `["admin", "manager"]`; each core re-asserts `managerCanManageStaffTarget` and the admin-only role rule. Managers still cannot change roles, pinned both in unit tests and by the DB-side guard in the integration suite.
- **Role-change side effects and rollback.** `replaceAssistantAssignments` and `seedDefaultPagePermissions` still run the same cascade as the legacy UI path, with the profile + assignment rollback preserved.
- **Phase 3–5 guarantees intact.** Non-privileged confirmation, tenant isolation and cross-tenant scope denial all re-verified by the passing integration suite (462 tests) against the live local database.
- **No Phase 6+ leakage.** `lib/ai/actions/definitions/` contains no documents/export/retention module and no such action id appears in the registry.
- **Unrelated dirty work untouched.** The uncommitted P7 document-platform work is intact; the full 2551-test unit suite covering it passes.
- **Injection containment.** `pnpm test:ai-adversarial` green (112 tests), including `inj-en-escalate-privileged-01`. Containment remains structural: the model's tool cannot execute, and the confirm token never enters model context.

---

## Notes (no fix required, carried forward for the phase log)

1. `notification_delivered: false` reaches the client in the action payload but is not rendered anywhere in `components/assistant/assistant-chat.tsx`. This satisfies the F5 acceptance criterion — the actor is told the change applied, and the delivery failure is surfaced on a separate testable path (follow-up receipt + Sentry) — but a small "admins were not notified" line in the receipt card would close the loop for the operator. Optional.
2. `tests/e2e/smoke.spec.ts` "WS7 operator report filters persist in the URL and exports match active filters" fails on a strict-mode locator violation at `smoke.spec.ts:885`. Confirmed **not** caused by this change set — every file rendering those filters is committed and unmodified, and no Phase 5f file touches the operator surface. It belongs to the operator report work.
3. The E2E fleet is not parallel-safe (`a11y`, `p3c-inbox`, `p4b-assistant` contend on the shared local Supabase and the single mock rate-limit server on port 3011). Pre-existing; `--workers=1` is currently the reliable way to run it. The Phase 5f and p4b specs pass cleanly under one worker, verified here.
4. The pre-existing `page-permissions.thePrimaryClinicAdminCannotBeCustomized` Arabic string is a generic "could not complete the request" rather than a translation. Still used by the permission cores, still a genuine i18n defect, and correctly left out of a fix cycle scoped to F1–F5.
5. Unchanged by design from the previous review: `staff.soft_delete` previews `Deleted state: None → pending-confirmation`; `staffLifecycleMutation` requires a trashed target before `permanent_delete` (unreachable from the UI, which only offers it from the trash view); neither system prompt mentions the privileged surface or its step-up requirement.
6. §11.1(8)'s "returns `confirmation_required` with a direction to Settings" is implemented as a dedicated `privileged_rate_limited` reason with its own EN + AR copy that does direct the user to Settings — a deliberate improvement over the plan text.
