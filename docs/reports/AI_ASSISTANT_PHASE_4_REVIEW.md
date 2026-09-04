# AI Assistant — Phase 4 Re-Review (Agent Loop & Orchestration)

**Verdict: Phase 4: CHANGES REQUIRED** — 1 medium, 1 low. **F1–F11 are all genuinely resolved** and are protected by meaningful tests with real negative controls; the §3 local-RLS gap from the previous review is closed. Two new concrete defects were found while verifying the fixes: one behavioural (a confirmed action keeps claiming it is awaiting confirmation for up to 10 minutes), one in the delivered test suite itself (a new test depends on an undeclared external binary and is red on a clean checkout). Neither is architectural; both are contained.

**Reviewed against:** `docs/plans/AI_ASSISTANT_FULL_CAPABILITY_PLAN.md` §9, §11, §12, §14.6, §15 Phase 4, §16, §18, §19, and `docs/reports/AI_ASSISTANT_PHASE_4_IMPLEMENTATION.md`.

**Scope:** working-tree diff on `feat/p7-manual-qa-polish`, Phase 4 portions only. No production code was modified by this review.

---

## 1. Verification actually executed

| Check | Result |
|---|---|
| `npx tsc --noEmit` | ✅ clean, no diagnostics |
| `npx vitest run tests/unit/{ai,api,actions,db,components,security,lib}` | ⚠️ **1 failed / 2 426 passed** (326 files) — see N1 |
| `pnpm test:ai-adversarial` | ✅ 2 files / 109 tests |
| `pnpm test:integration` (local stack, keys from `supabase status -o env`) | ✅ **52 files passed / 1 skipped, 451 tests passed / 3 skipped** — the skip is the documented `RUN_LINKED_UNDO_REGRESSION=1` linked-only file |
| Targeted RLS: `p5a-p411-workflow-booking`, `p411a-workflow-runs-rls`, `phase3-action-confirmation-rls`, `p4a-ai-tools-rls` | ✅ 4 files / 46 tests |
| Live DB introspection against the local stack (migration actually applied) | ✅ see §2 |

The previous review's §3 gap ("no `tests/unit/integration/**` was ever executed") is **closed**. The suite was run, and the specific regression the previous review predicted (F3) is now covered by an executing test that asserts the exact `42501` / `AI_BOOKING_METADATA_SERVER_ONLY` outcome.

### Live database state (not just SQL text matching)

Verified by introspecting the local Postgres instance the migration was applied to:

- `protect_ai_booking_metadata()` body references `ai_workflow_step_id` **3×** (INSERT check + UPDATE `is distinct from` + column list).
- `trg_appointments_guard_ai_metadata` fires on exactly: `ai_workflow_run_id, ai_workflow_step_id, ai_patient_conversation_id, expires_at, ai_action_receipt_id`.
- `ai_workflow_runs` grants: `authenticated: SELECT`; `service_role: SELECT, TRUNCATE, REFERENCES, TRIGGER` — **no INSERT/UPDATE/DELETE for either**.
- `plans`: `pro_ai` → `ai_assistant=true`, `ai_turn_steps_max=25`; `basic`/`pro` → `ai_assistant=false`, `ai_turn_steps_max=0`.
- `agent_messages` carries both `parts` and `sequence`.

---

## 2. F1–F11 — all resolved

| # | Finding | Status | Evidence |
|---|---|---|---|
| **F1** | Overdue-invoice patient-facing identity | ✅ **Resolved** | `invoiceReminderDrafts` now returns `clinicName: settings.data!.name` ([legacy-actions.ts:117](../../lib/ai/actions/definitions/legacy-actions.ts#L117)) and `execute` sends `clinic_name: draft.clinicName, doctor_name: draft.clinicName` — byte-identical to the retired `send-invoice-reminders.ts:156-157`. Covered by a test asserting both fields equal the clinic settings name **plus a real negative control**: `expect(Object.values(sent.templateValues)).not.toContain(USER.fullName)`, with the fixture actor deliberately named `"Private Actor Name"`. |
| **F2** | Stale retired-tool references | ✅ **Resolved** | `FINANCIAL_TOOL_NAMES` is now 3 live tools. A repo-wide search for `send_invoice_reminders`, `send_appointment_reminders`, `create_pending_booking`, `execute_read_only_workflow`, `assertWorkflow*`, `createPendingWorkflowBooking`, `lib/ai/workflows` across all `.ts/.tsx/.sql/.json` returns **exactly one hit** — the regression test asserting their absence. Injection cases are re-targeted at `execute_action` with `targetAction` action ids, and `p6a-injection-suite.test.ts:88` is a *discriminating* test: it requires a case per re-homed bulk action whose text names the action id and matches both a no-preview and a no-confirmation phrase. Both suites green. |
| **F3** | `ai_workflow_step_id` / action provenance under real RLS | ✅ **Resolved** | Restored in the guard body (INSERT + UPDATE) and the trigger's `update of` list — confirmed in the **live database**, not only the SQL text. `p5a-p411-workflow-booking.test.ts` executes and asserts an authenticated `update … ai_workflow_step_id = 'forged_step'` → `42501` + `AI_BOOKING_METADATA_SERVER_ONLY`, and the same for a forged `ai_action_receipt_id`. The migration-text test now slices the guard body and the trigger separately so it cannot pass on an incidental match. |
| **F4** | `staff_administrative` / composite step budgets | ✅ **Resolved** | `staff_administrative` 8→**20** (`version: phase4-staff-administrative-policy-v2`), `staff_operational_query` **20** (`-v2`), `staff_composite` **25** (`-v2`), `staff_clinical_summary` correctly left at **8**, `staff_help` at 4. The full matrix is asserted, along with `isCompositeIntent` and `staffTaskForRole` routing. |
| **F5** | Multi-step input capacity and `input_limit_reached` | ✅ **Resolved** | `maxInputTokensPerStep` raised to **192 000** for exactly the three 20/25-step classes. The test drives a **real `ToolLoopAgent`** through 12 tool calls + a final response with 50-row payloads and asserts `maxInputBytes > 48_000` (the old ceiling) **and** `< policy.maxInputTokensPerStep` — so it is a genuine regression control for the old boundary, not a tautology. Over-ceiling now has its own `input_limit_reached` classification with EN + AR copy (`messages/{en,ar}.json` `errorInputLimitReached`), and [route.ts:257-278](../../app/api/agent/chat/route.ts#L257) persists the user's message before returning it. Route-level negative control at `p4b-chat-route.test.ts:431`. |
| **F6** | Preview-only confirmation persistence across refresh | ✅ **Resolved** | Logic moved to the tested `lib/ai/conversation-parts.ts`. `persistedAssistantState` **bounds first, then derives** pending confirmations from the persisted parts, so the ghost-metadata direction is structurally impossible. `persistDoctorTurn` writes the assistant row when text is empty but a confirmation exists ([conversations.ts:311](../../lib/ai/conversations.ts#L311)). Tests cover preview-only reload, oversized-card drop with **no** pending metadata, continuation preservation, and a visually-similar `phase: "execute"` negative control. *(But see N2 — the post-confirm direction is still unhandled.)* |
| **F7** | Removal-gate and equivalence coverage | ✅ **Resolved** | The §14.6 gate is met. `phase4-legacy-action-equivalence.test.ts` (238 lines) asserts dedupe keys (`appointment_reminder:<id>`, `invoice_followup:<id>:step0`), settings-derived subject/body, channel selection, recipient shape, `relatedType`/`relatedId`, partial-vs-total failure discrimination, receipt provenance and no-notification for pending bookings, and 25-accept/26-reject for **both** bulk actions. Role, page-visibility and `ai.financial_insights` denials are separate controls in `phase3-action-foundation.test.ts:429`. Mount equivalence is asserted across **all five roles** × every non-help class, not just admin. The token-never-replayed property is now testable and tested: `modelSafeHistory` is exported, and the test asserts the serialized history contains neither `server-only-confirm-token` nor `tool-execute_action`. |
| **F8** | Dead workflow code / inert metadata | ✅ **Resolved** | `assertWorkflowAccess`, `assertWorkflowActionAccess` and every `workflow` reference are gone from `lib/ai/authorization.ts`; `workflow: { kind, costUnits }` is gone from the tool registry; `createPendingWorkflowBooking` is deleted — `lib/booking/pending-workflow.ts` now exports only `previewPendingBooking` and `createPendingActionBooking`. A source-level test guards the regression. |
| **F9** | Historical `ai_workflow_runs` read-only | ✅ **Resolved** | Explicitly retired with a table comment plus `revoke insert, update, delete … from service_role`. **Confirmed live**: `service_role` holds no write privilege. `p411a-workflow-runs-rls.test.ts` executes and asserts authenticated writes *and* service-role writes are rejected, and that reads stay owner/clinic-scoped. |
| **F10** | Runtime enforcement of `ai_turn_steps_max` | ✅ **Resolved** | `clampTaskPolicySteps` is applied in `prepareAiExecution` **before** `calculateWorstCaseCostMicros`, so the loop (`stopWhen: stepCountIs(taskPolicy.maxSteps)`) and the reservation share one effective count. `p45a-platform.test.ts:290` proves a plan value of 7 clamps *both*. The migration seeds AI-enabled plans to 25. The `< 1` guard correctly makes the `ai_turn_steps_max: 0` on non-AI plans a no-op rather than a zero-step lockout. |
| **F11** | Composite cost control | ✅ **Resolved (documented decision)** | `staff_composite` stays budget-only per the plan, and its 25-step ceiling is now genuinely tierable via the live F10 entitlement. The decision is recorded in the implementation report. |
| **F12** | `on delete restrict` vs. Phase 6 purge | ➖ **Open by design** | Explicitly out of scope; carry into Phase 6 retention design. Unchanged. |

### Also re-confirmed

- **Per-step metering** — `prepareStep` → `beginStep`, `onStepFinish` → `observeStep` unchanged; a 12-step turn produces 12 reconciled attempts, and the attempt payload is asserted content-free (`not.toMatch(/prompt|completion|message|patient|tool|body/i)`).
- **Tool-part persistence + token redaction** — `parts` is server-written and sanitized; `toUiMessages` falls back to text for pre-Phase-4 rows; the column round-trips through the **caller's RLS client** in `p4a-ai-tools-rls.test.ts:606-627`. Closes §3 item 3.
- **`staff_help` containment** — help mounts only `search_help` / `get_navigation_target`; `query_resource`, `get_record` and `execute_action` are all asserted absent.
- **No Phase 5+ leakage** — none of the six `lib/**/mutations.ts` cores exist; no step-up reauth; no privileged or document action definitions; `AI_ACTION_REGISTRY` is exactly 4 (reference + the three re-homed).
- **Unrelated dirty work untouched** — every file modified during the fix session (19:52–20:35) is AI/Phase-4 code, its tests, the migration, or the two locale files. No P7 document-platform, operator, or messaging file was touched. Nothing reset or reverted.

---

## 3. Remaining findings

### N1 — MEDIUM — A new Phase 4 test depends on an undeclared external binary and is red on a clean checkout

- **Where:** [tests/unit/db/phase4-orchestration-migration.test.ts:54](../../tests/unit/db/phase4-orchestration-migration.test.ts#L54) — `execFileSync("rg", ["-l", "ai_workflow_runs", "lib", "app", "actions"], …)`.
- **Observed:** on this machine the full unit run is **1 failed / 2 426 passed**, failing with `Error: spawnSync rg ENOENT`. Verified there is no `rg` binary on `PATH` (`/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin` all absent; a clean-env `command -v rg` returns nothing). Ripgrep is not in `package.json`, is not installed by `.github/workflows/ci.yml`, and no other test in the repo spawns it — the three siblings that use `execFileSync` spawn `node` and `git`, which are guaranteed present.
- **Why it matters:** this is the same class of defect F2 was raised for — a red suite plus an implementation report claiming green. The report's "Full unit regression (`pnpm test`) — 339 files / 2 475 tests passed" holds only on a machine that happens to have ripgrep; any contributor without it gets a failing suite on checkout. GitHub's `ubuntu-latest` image ships ripgrep, so CI will likely stay green and mask it, which makes it more durable, not less.
- **Second defect in the same line:** `rg` exits `1` when it matches nothing, and `execFileSync` throws on a non-zero exit. Only one file currently matches (`lib/supabase/admin.ts`, the allow-list entry). The moment that last reference is cleaned up — the desired end state — this test starts throwing. It is written to fail when the codebase gets *better*.
- **Required fix:** replace the subprocess with in-process traversal (Node `fs` over `lib`, `app`, `actions`, as `p71-document-bundle-size.test.ts` already does for its file walk), and treat "no file references the table" as a **pass**, not an error.
- **Acceptance:** `npx vitest run tests/unit/db/phase4-orchestration-migration.test.ts` passes on a machine with no ripgrep installed, and still passes when `lib/supabase/admin.ts`'s `ai_workflow_runs` entry is removed.

### N2 — LOW-MEDIUM — A confirmed action keeps claiming it is awaiting confirmation for up to 10 minutes

- **Where:** [actions/assistant-actions.ts:51-60](../../actions/assistant-actions.ts#L51) — `confirmAssistantAction` executes the action and returns, never touching `active_context`. `withPendingActionConfirmations` has exactly one caller ([conversations.ts:295](../../lib/ai/conversations.ts#L295)), and the F6 fix changed that caller from *overwrite* to *merge* ([conversations.ts:285-303](../../lib/ai/conversations.ts#L285)), so nothing can now remove an entry before its TTL.
- **Failure scenario:** the user asks for invoice reminders → the preview card persists and `active_context.pending_confirmations` gains the entry → the user clicks **Confirm** and the reminders are dispatched → on the next turn `buildActiveContextPrompt` still injects *"1 action preview(s) await the user's on-screen confirmation. Do not execute them, request a token, or **claim they completed**."* ([conversation-context.ts:329](../../lib/ai/conversation-context.ts#L329)). If the user then asks "did the reminders go out?", the system prompt directs the model to deny a bulk patient-facing send that already happened. The stale claim persists for the full `ACTION_CONFIRMATION_TTL_MS` of 10 minutes ([confirm.ts:19](../../lib/ai/actions/confirm.ts#L19)).
- **Why it matters:** it is the mirror image of the ghost-card case F6 fixed, and it was introduced by that fix — before the merge change, the next persisted turn overwrote the slot and cleared it. The whole mechanism is new in Phase 4 (`pendingActionConfirmations` did not exist on `HEAD`), so this is a Phase 4 defect, not inherited. It is bounded by the TTL and the confirm token is single-use, so nothing double-executes — the damage is the assistant misreporting a commercially-binding send. F6's acceptance criterion was that context and transcript stay *"consistent in both directions"*; this is the direction still open.
- **Required fix:** clear the confirmed entry on success — have `confirmAssistantAction` (or `executeRegisteredAction`'s success path) remove the matching `{action_id, expires_at}` from the conversation's `active_context.pending_confirmations`, using the same RLS-scoped client and tolerating a conversation that has since moved on.
- **Acceptance:** a test asserts that after a successful `confirmAssistantAction`, `pendingActionConfirmations(activeContext)` no longer contains that action, and that a subsequent `persistDoctorTurn` merge does not resurrect it; a negative control asserts a *denied* or *expired* confirm leaves an unrelated pending entry intact.

---

## 4. Re-review checklist

1. N1: `phase4-orchestration-migration.test.ts` passes with no ripgrep on `PATH`, and passes when the last `ai_workflow_runs` reference is removed.
2. N2: a successful confirm clears its `active_context` entry; both the positive and the denied/expired negative control are asserted.
3. Re-run `pnpm test`, `pnpm test:integration`, `pnpm test:ai-adversarial` and confirm all three are green **on a clean environment**.
4. F1–F11 need no further work. F12 remains carried into Phase 6.
