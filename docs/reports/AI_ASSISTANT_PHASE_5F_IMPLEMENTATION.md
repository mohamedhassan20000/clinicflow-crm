# AI Assistant — Phase 5f Implementation (review-fix cycle)

**Scope:** the five findings in `docs/reports/AI_ASSISTANT_PHASE_5F_REVIEW.md` (F1–F5) and nothing else. No Phase 6 work, no unrelated changes. Nothing was pushed, deployed, or applied remotely.

**Status: all five findings fixed, with regression coverage for each, and the §15 acceptance scenario now proven in a passing browser E2E.**

Fixing F1 uncovered a sixth, previously invisible defect in the shipped step-up flow (`signOut()` defaulting to a **global** session revoke). It is documented below as F1-b because the E2E cannot pass without it and it is squarely inside the Phase 5f surface.

---

## F1 — HIGH — The Phase 5f E2E could not reach the assistant surface

**Was:** the spec seeded a clinic, a `pro_ai` subscription, profiles and a conversation, but no accepted `ai_commercial_terms` row. Since Phase 0b every `ai.*` / `ai_assistant` key resolves through `effective_ai_feature`, which joins `ai_commercial_terms … accepted_at is not null`. Without that row the umbrella is false, `resolveStaffAssistantPage` returns `access.state === "upgrade"`, `AssistantAccessGate` renders instead of `AssistantChat`, and no composer ever mounts. `tests/e2e/p4b-assistant.spec.ts` had the identical gap.

**Fix**

- `tests/e2e/phase5f-privileged-actions.spec.ts` — `beforeAll` now inserts an accepted terms row for the test clinic (`accepted_at`, `change_reason: "pilot"`, `updated_by: ids.admin`, `overage_mode: "hard_cap"` with `overage_budget_micros: 0` to satisfy `ai_commercial_terms_overage_shape`), and `afterAll` deletes it before the subscription/clinic teardown.
- `tests/e2e/p4b-assistant.spec.ts` — the same seeding in `beforeAll`, cleaned up in the shared `cleanup()`.
- The spec's original assertions are unchanged: confirm button disabled until a password is entered, `profiles.role` flipped to `manager`, an `execute` receipt with `authorization_outcome: allowed` / `outcome: success`, and an `ai_privileged_change` notification for the admin. One assertion was **added** (see F1-b).

**Regression coverage:** `tests/unit/ai/phase5f-review-fixes.test.ts` → *"the assistant E2E specs seed Phase 0b commercial-terms acceptance"* reads both spec files and requires the insert (with `accepted_at` and `change_reason`) and the cleanup delete. This is deliberately a source-level guard: the failure mode is a spec that silently stops exercising the surface, which no runtime assertion in those specs can catch.

**Verification:** `PORT=3100 … playwright test tests/e2e/phase5f-privileged-actions.spec.ts` → **1 passed**. `tests/e2e/p4b-assistant.spec.ts` → **2 passed**.

---

## F1-b — HIGH (found while fixing F1) — Step-up reauthentication signed the admin out of their own session

**Was:** `verifyCurrentPasswordStepUp` (`lib/auth/step-up.ts`) signs in on a throwaway client to verify the password, then called `verifier.auth.signOut()`. supabase-js defaults `signOut()` to `scope: "global"`, which issues `POST /logout?scope=global` and asks GoTrue to revoke **every** session for that user — including the browser session that was mid-confirmation.

**Observed:** the privileged mutation committed correctly (`ai_action_receipts`: one `staff.change_role` execute row, `allowed` / `success`, role flipped to `manager`), but by the time the Server Action returned, the browser had been logged out and redirected to `/login`. The actor never saw the receipt. Only a real browser run could surface this; every mocked test passed throughout.

**Fix:** `lib/auth/step-up.ts` now calls `signOut({ scope: "local" })`, which revokes only the throwaway session the function just created and leaves the caller's session untouched. The reason is documented inline so the default is not restored by a later tidy-up.

**Regression coverage:**

- `tests/unit/lib/phase5f-step-up-session-safety.test.ts` (new, 3 tests) — asserts the sign-out is called with exactly `{ scope: "local" }` and **not** as a bare `signOut()`, `"global"`, or `"others"`; asserts no sign-out at all on a wrong credential; asserts a mismatched verified identity still fails closed.
- The E2E now also asserts `await expect(page).toHaveURL(/\/assistant/)` after the confirmation completes, so a session-destroying step-up fails the browser test directly.

---

## F2 — LOW — Every `staff.change_role` diff carried a phantom "Supervising doctors" row

**Was:** `explicitChanges` (`lib/ai/actions/definitions/privileged.ts`) selected changed fields with `before[field] !== after[field]`. `updateStaffMutation` sets `before.supervising_doctor_ids` and `after.supervising_doctor_ids` to two separately-read arrays, which are never `===`, so the field was always classified as changed and always rendered in the attestation the admin re-authenticates against.

**Fix**

- New `lib/ai/actions/canonical.ts` holds the canonicaliser (`stableValue` / `canonicalActionInput` / `ActionConfirmationError` / `ACTION_INPUT_MAX_BYTES`) that previously lived inside `lib/ai/actions/confirm.ts`, plus a new `sameCanonicalValue(a, b)`. It carries no `server-only` marker so `lib/ai/actions/types.ts` (reachable from client bundles) can use it. `confirm.ts` re-exports all four names, so every existing import path — and every `vi.mock("@/lib/ai/actions/confirm")` — behaves exactly as before, including `instanceof ActionConfirmationError`.
- `explicitChanges` now filters with `!sameCanonicalValue(before[field], after[field])` — the same normalisation the confirm token's before/after digests are built from.
- `assertActionPreviewContract` (`lib/ai/actions/types.ts`) now uses `sameCanonicalValue` instead of `change.before !== change.after` for the privileged "must contain an explicit before-to-after change" rule, so all three places agree on what "changed" means.
- Values the canonicaliser refuses (undefined, class instances, cycles) fall back to reference equality, so an uncomparable field is still reported as changed rather than silently dropped from a security diff.

**Regression coverage:** `tests/unit/ai/phase5f-review-fixes.test.ts` → three tests: an unchanged supervising-doctor list built from two array instances emits **no** `Supervising doctors` row (changes are exactly `["Staff member", "Role"]`); a genuine add still emits the row with distinct before/after; a fully no-op privileged input is still rejected with `ActionPreviewContractError`.

---

## F3 — MEDIUM — The shared cores added primary-admin protections the Settings UI never had

**Was:** `updateStaffMutation`, `setStaffActiveMutation` and `staffLifecycleMutation` had each gained a `primaryAdminMutationBlocked(...)` guard returning `"page-permissions.thePrimaryClinicAdminCannotBeCustomized"`. Because `actions/settings.ts` routes Settings → Staff through those same cores, the earliest-created active admin could no longer be demoted, deactivated, trashed or permanently deleted **from the UI** by anyone — a brand-new restriction, with copy that read "cannot be customized" to a user who clicked Deactivate or Delete.

**Fix — the review's option 1: the rule moves to the Assistant boundary, the UI goes back to byte-identical legacy behaviour.**

- `lib/settings/mutations.ts` — all three guards removed, each replaced by a comment stating why the core must not carry one. The two **pre-existing** primary-admin-target guards in `setPagePermissionMutation` / `setReportPermissionMutation` (which legacy `actions/page-permissions.ts` and `actions/report-permissions.ts` did have) are untouched, as is `assertPrimaryAdminPermissionActor`.
- `lib/ai/actions/definitions/privileged.ts` — new per-action `primaryAdminGuard { blocks, code }`, evaluated in both `preview` and `execute` **before** the core runs, using the real `isPrimaryClinicAdmin`. It throws `ActionBusinessRuleError`, so the attempt is audited as `business_rule_refused` with the specific message key in `error_code`:
  - `staff.change_role` → blocks when the requested role is not `admin` → `settings.thePrimaryClinicAdminRoleCannotBeChanged`
  - `staff.set_active` → blocks when `is_active === false` → `settings.thePrimaryClinicAdminCannotBeDeactivated`
  - `staff.soft_delete`, `staff.permanent_delete` → always → `settings.thePrimaryClinicAdminCannotBeDeleted`
  - `staff.restore` and `staff.reset_password` → no guard (mirrors the `operation !== "restore"` shape the core briefly had, and legacy's absence of any guard on password reset)
- `messages/action-errors/{en,ar}.json` — three new operation-specific keys, EN + AR. None of them use "customize" / "تخصيص".

**Net effect:** Settings → Staff behaves exactly as `actions/settings-legacy.ts` did; the Assistant refuses to touch the founding administrator; the copy names the attempted operation.

**Regression coverage**

- `tests/unit/actions/phase5f-settings-parity.test.ts` (new) — four tests proving `updateStaffMutation` (demotion), `setStaffActiveMutation` (deactivation) and `staffLifecycleMutation` (`soft_delete`, `permanent_delete`) all succeed against a primary-admin target and never even call `getPrimaryClinicAdminId`, plus one asserting no staff core can emit the page-permission "cannot be customized" code.
- `tests/unit/ai/phase5f-review-fixes.test.ts` — the boundary refuses a primary-admin demotion with `settings.thePrimaryClinicAdminRoleCannotBeChanged` **before** the core runs; the guard correctly does not fire when the requested role keeps the target an admin; and both locales carry all three keys with operation-appropriate wording.
- `tests/unit/integration/phase5-domain-write-rls.test.ts` — the assertion that used to pin the core's refusal now pins the opposite against the **real database**: the core allows the primary-admin demotion, and `registeredAction("staff.change_role").previewValidated(...)` for a second admin rejects with `ActionBusinessRuleError` / `settings.thePrimaryClinicAdminRoleCannotBeChanged`, resolved through the live `assert_primary_ai_provider_admin`-aligned lookup.

---

## F4 — MEDIUM — Bulk page/report visibility saves lost role filtering and became non-atomic

**Was:** `saveUserPageVisibilityChanges` / `saveUserReportVisibilityChanges` looped the incoming change list through the **per-item** privileged core. That core *refuses* `dashboard` (`page-permissions.dashboardCannotBeHidden`) and role-invalid entries (`page-permissions.thisPageIsNotAvailableForThatUserSRole`), and the loop returned on the first failure — so `[patients, dashboard, reports]` wrote `patients`, failed on `dashboard`, never wrote `reports`, and reported the whole save as an error. An N-item save was also N round trips, each re-running the actor check, target load and primary-admin lookup.

**Fix**

- `lib/settings/mutations.ts` — two new batch cores, `savePagePermissionsMutation` and `saveReportPermissionsMutation` (with `pagePermissionBatchActionSchema` / `reportPermissionBatchActionSchema`, capped at 200 entries). Each one:
  1. asserts the admin-only role, the primary-admin **actor** requirement, loads the target, blocks a primary-admin **target**, and (pages) applies the manager/admin-target rule — the legacy order, byte for byte;
  2. filters the change list *first* — dropping `dashboard` and slugs outside `getRolePageSlugs(target.role)`, or report ids failing `isReportId` / outside `reportsOpenableByRole(target.role)`;
  3. returns `{ ok: true }` with nothing written when the remainder is empty;
  4. writes the survivors in **one** upsert, with the `user_customizations` fallback preserved for a missing `user_page_permissions` table;
  5. revalidates `/settings/customize`.
- `actions/page-permissions.ts` and `actions/report-permissions.ts` call the batch core instead of looping. The single-item savers (`updateUserPageVisibility`) keep the per-item core and its per-item refusals, which is what they always had. `updateUserReportVisibility` still delegates to the bulk saver, exactly as before.

**Regression coverage:** `tests/unit/actions/phase5f-settings-parity.test.ts` → a change set of `[patients, dashboard, settings, appointments]` for a receptionist writes `[appointments, patients]` in exactly **one** upsert and returns `{ success: true }`; an all-invalid set returns success with **zero** writes; the single-item saver still returns `page-permissions.dashboardCannotBeHidden` and writes nothing; the report twin drops an out-of-role report and a non-report id and writes `[no_shows, revenue]` in one upsert; an all-invalid report set returns success with no write.

---

## F5 — MEDIUM — A committed privileged mutation could be recorded and reported as failed

**Was:** the order in `executeRegisteredAction` was *run core → notify admins → finalize receipt*, and `notifyClinicAdminsOfPrivilegedAction` threw on any failure. That throw landed in the generic catch, which finalized the receipt as `outcome: "error" / errorCode: "execute_failed"` with `beforeDigest`/`afterDigest` nulled and rethrew; `confirmAssistantAction` turned it into `{ ok: false, reason: "internal_error" }`. The role change had already committed, the token was already consumed, and the authoritative ledger said it failed.

**Fix**

- `lib/ai/actions/privileged-notifications.ts` — the notifier no longer throws. It returns a typed `PrivilegedNotificationResult`: `{ delivered: true, recipientCount }` or `{ delivered: false, reason: "recipient_lookup_failed" | "no_active_admin" | "emit_failed" }`.
- `lib/ai/actions/execute.ts` — the authoritative receipt is finalized **first**, with the real audit digests, immediately after the core commits. Only then is the notification attempted, through a new `deliverPrivilegedNotification` helper that never throws.
- On a delivery failure the helper (a) reports to Sentry with `area: assistant-privileged-notification` and the source receipt id and reason, and (b) writes a **separate** receipt row under its own action id `assistant.privileged_notification` (`PRIVILEGED_NOTIFICATION_FAILURE_ACTION_ID`, exported) with `authorization_outcome: allowed`, `outcome: error`, `error_code: privileged_notification_<reason>`, `target_table: notifications`. An incident review can therefore distinguish "the role change failed" from "the role change succeeded and its notification did not". A notifier that throws is caught and treated the same way.
- `ActionExecuteSuccess` gained an optional `notification_delivered: boolean`, set for privileged actions, so the actor is told the change applied while the delivery failure stays visible in the payload.
- `executeRegisteredAction` accepts an injectable `privilegedNotifier` so the post-commit path is testable in isolation.

**Regression coverage:** `tests/unit/ai/phase5f-review-fixes.test.ts` → four tests: a failing notifier still yields `executed: true` with `notification_delivered: false` and a mutation receipt of `allowed` / `success` / `errorCode: null` with 64-hex before **and** after digests; the failure appears as its own receipt row under a *different* action id with `errorCode: privileged_notification_emit_failed`; a notifier that **throws** behaves identically; a succeeding notifier reports `notification_delivered: true`. `tests/unit/ai/phase5f-privileged-actions.test.ts`'s existing success-path notification assertion was updated to the new result contract.

---

## Files changed

| File | Finding |
|---|---|
| `lib/ai/actions/canonical.ts` *(new)* | F2 |
| `lib/ai/actions/confirm.ts` | F2 (canonicaliser extracted + re-exported) |
| `lib/ai/actions/types.ts` | F2, F5 |
| `lib/ai/actions/definitions/privileged.ts` | F2, F3 |
| `lib/ai/actions/execute.ts` | F5 |
| `lib/ai/actions/privileged-notifications.ts` | F5 |
| `lib/settings/mutations.ts` | F3, F4 |
| `actions/page-permissions.ts` | F4 |
| `actions/report-permissions.ts` | F4 |
| `lib/auth/step-up.ts` | F1-b |
| `messages/action-errors/{en,ar}.json` | F3 |
| `tests/e2e/phase5f-privileged-actions.spec.ts` | F1, F1-b |
| `tests/e2e/p4b-assistant.spec.ts` | F1 |
| `tests/unit/ai/phase5f-review-fixes.test.ts` *(new, 12 tests)* | F1, F2, F3, F5 |
| `tests/unit/actions/phase5f-settings-parity.test.ts` *(new, 10 tests)* | F3, F4 |
| `tests/unit/lib/phase5f-step-up-session-safety.test.ts` *(new, 3 tests)* | F1-b |
| `tests/unit/ai/phase5f-privileged-actions.test.ts` | F5 (notifier contract) |
| `tests/unit/integration/phase5-domain-write-rls.test.ts` | F3 |

---

## Verification

| Check | Command | Result |
|---|---|---|
| Phase 5f targeted unit tests | `vitest run tests/unit/ai/phase5f-privileged-actions.test.ts tests/unit/ai/phase5f-review-fixes.test.ts tests/unit/actions/phase5f-step-up-boundary.test.ts tests/unit/actions/phase5f-settings-parity.test.ts tests/unit/lib/phase5f-step-up-session-safety.test.ts` | **PASS** |
| Full unit regression | `vitest run --exclude "tests/unit/integration/**"` | **PASS** — 349 files / 2551 tests (was 346 / 2526) |
| Phase 3 / 5 / 5f integration + RLS | `LOCAL_SUPABASE_* … vitest run tests/unit/integration --no-file-parallelism` | **PASS** — 53 passed, 1 skipped (462 tests, 3 skipped) |
| Corrected Phase 5f E2E | `PORT=3100 … playwright test tests/e2e/phase5f-privileged-actions.spec.ts` | **PASS** — 1 passed |
| Affected assistant E2E | `PORT=3100 … playwright test tests/e2e/p4b-assistant.spec.ts` | **PASS** — 2 passed |
| Whole E2E fleet, serial | `PORT=3100 … playwright test --workers=1` | 35 passed, 1 failed, 19 not run — the single failure is the pre-existing operator-report defect in item 1 below; because `smoke.spec.ts` is `mode: "serial"`, it blocks the rest of that one file. Every assistant, a11y, inbox, signup, login, privacy and localization spec passes. |
| Adversarial suite | `pnpm test:ai-adversarial` | **PASS** — 112 tests |
| Build | `pnpm build` | **PASS** (exit 0) |
| Typecheck | `pnpm typecheck` | **PASS** (exit 0) |
| Lint | `pnpm lint` | **PASS** — 0 errors, 26 pre-existing warnings |
| i18n hardcoded-string gate | `pnpm lint:i18n` | **PASS** — 438 files |
| i18n message parity (EN/AR) | `pnpm i18n:missing` | **PASS** — 3982 base leaf messages |
| i18n unused keys | `pnpm i18n:unused` | **PASS** — no unreferenced keys (confirms the three new F3 keys are wired up) |
| RTL / logical-properties gate | `pnpm lint:rtl` | **PASS** — 670 files |
| Whitespace | `git diff --check` + trailing-whitespace scan of the untracked new files | **PASS** — clean |

Local Supabase migration state at time of verification: `20260814120000` applied.

**The §15 acceptance scenario is now proven in a browser**, in one test: preview card → rendered `receptionist → manager` diff → confirm button disabled until a password is entered → password step-up → `confirmAssistantAction` → `profiles.role = manager` in the database → an `execute` receipt with `authorization_outcome: allowed` / `outcome: success` → an `ai_privileged_change` notification row for the admin → the actor still on `/assistant`, signed in.

---

## Remaining issues

1. **`tests/e2e/smoke.spec.ts` "WS7 operator report filters persist in the URL and exports match active filters" fails deterministically** — reproduced in the parallel fleet, in the serial fleet, and with `smoke.spec.ts` run alone. Strict-mode locator violation at `smoke.spec.ts:885`: `input[type="hidden"][name="createdFrom"]` resolves to two elements on the operator clinics report page (one inside the "Created from" label, one inside the "Clinics" region). Because that file declares `test.describe.configure({ mode: "serial" })`, this single failure also stops the 16 tests after it in the same file.

   **Not caused by this change set.** Every file that renders those filters — `components/operator/report-shell.tsx`, `components/operator/report-filter-combobox.tsx`, `app/(operator)/operator/reports/[reportId]/page.tsx`, `lib/operator-reports/registry.ts` — is committed and unmodified in the working tree (verified with `git status --porcelain`), so this reproduces on the committed baseline `01d2d76`. No file in this change set touches the operator surface. **Left unfixed on purpose:** the task scope is "F1–F5 only, no unrelated changes." The fix is a two-element disambiguation in either the test locator or the report shell markup, and belongs to whoever owns the operator report work.

2. **The E2E fleet is not parallel-safe.** With default workers, `a11y`, `p3c-inbox` and `p4b-assistant` fail; all three pass under `--workers=1` (verified both ways). The shared local Supabase instance and the single mock rate-limit server on port 3011 are the contention. Pre-existing and not a Phase 5f regression, but worth recording: `--workers=1`, or per-spec isolation, is currently the only reliable way to run this fleet.
3. **The Arabic copy for the pre-existing `page-permissions.thePrimaryClinicAdminCannotBeCustomized` key is a generic "could not complete the request" string**, not a translation of the English. Untouched here because it is a pre-Phase-5f key still used by the permission cores, but it is a genuine i18n defect for anyone hitting that refusal in Arabic.
4. **Notes carried forward from the review, unaddressed by design** (they were recorded as "no fix required"): `staff.soft_delete` still previews `Deleted state: None → pending-confirmation`; `staffLifecycleMutation` still requires a target to be trashed before `permanent_delete` (unreachable from the UI, which only offers it from the trash view); neither system prompt mentions the privileged surface or its step-up requirement.
