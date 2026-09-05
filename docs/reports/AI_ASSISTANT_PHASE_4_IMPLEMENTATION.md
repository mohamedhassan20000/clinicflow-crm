# AI Assistant — Phase 4 Implementation

## Status

Phase 4 review findings F1–F11 are resolved. Phase 5 and later work was not started. The Phase 4 migration was applied and re-applied idempotently to the local Supabase stack only; nothing was pushed, deployed, linked, or run remotely.

## Review findings F1–F11

### F1 — Overdue-invoice patient identity

`invoices.send_reminders` now carries the clinic settings name through `invoiceReminderDrafts` and sends that value as both `clinic_name` and `doctor_name`, matching the retired implementation. It no longer exposes the acting admin/manager's personal name. The equivalence test asserts the clinic identity and includes a negative control proving the actor name is absent from all template values.

### F2 — Stale removed-tool references

Removed `send_invoice_reminders` from the financial capability tool list. Retargeted reminder confirmation-bypass/injection cases to the live `execute_action` surface with the registered `appointments.send_reminders` and `invoices.send_reminders` action ids. Removed other Phase 4 stale workflow/tool references from the assistant confirmation UI and obsolete authorization/test mocks. The adversarial corpus now requires a discriminating confirm-bypass case for each migrated bulk action.

### F3 — AI provenance tamper guard

Restored `ai_workflow_step_id` to both INSERT/UPDATE comparisons in `protect_ai_booking_metadata()` and to the trigger's `UPDATE OF` column list, alongside `ai_action_receipt_id`. Migration-text coverage asserts both locations. Local RLS coverage proves authenticated clients cannot modify either the legacy workflow-step provenance or the new action-receipt provenance; the direct-write negative controls receive `42501`.

### F4 — Administrative step budget

Raised `staff_administrative` from 8 to 20 steps and bumped its certified policy version. `staff_operational_query` remains 20, `staff_composite` remains 25, and the clinical summary budget remains 8. Policy tests assert the full matrix.

### F5 — Per-step/input-budget behavior

Raised the accumulated per-step input ceiling for the 20/25-step staff policies from 48,000 to 192,000 bytes. A real AI SDK loop test completes 12 tool calls plus the final response with realistic 50-row resource payloads and proves the accumulated history exceeds the former 48 KB boundary.

Over-ceiling input now has a dedicated `input_limit_reached` error classification and localized English/Arabic message. The route persists the user's message before returning that bounded error, instead of reporting `temporarily_unavailable` and discarding the turn. A negative-control route test forces the limit and asserts persistence and classification.

### F6 — Refresh-safe pending confirmations

Moved UI-part bounding, model-history redaction, and pending-confirmation extraction into a tested conversation-parts module. Preview-only assistant turns are persisted even with no text. Pending confirmations are derived only from the exact bounded parts that are persisted, so oversized fallback parts cannot create a ghost confirmation. Unexpired confirmations are merged across continuation turns instead of being cleared by an unrelated assistant response.

Tests cover preview-only reload state, continued-turn preservation, oversized-card consistency in both directions, and a non-pending execute-action negative control.

### F7 — Phase 4 removal-gate and equivalence coverage

Added the missing Phase 4 coverage:

- a real 12-tool-call/13-step completion with realistic resource results;
- per-step budget observation, reservation, reconciliation, and plan-limit clamping;
- all-role non-help misclassification mount equivalence;
- persisted-part bounding and confirmation-token/tool-part removal before model replay;
- preview-only and oversized confirmation persistence behavior;
- appointment-reminder equivalence for settings-derived copy, channels, dedupe, and partial failure;
- invoice-reminder equivalence for clinic identity, copy, channels, dedupe, partial failure, and the actor-name negative control;
- pending-booking equivalence for receipt provenance and no notification;
- role, feature, financial-permission, page-visibility, 25-recipient, and 26-recipient denial controls.

This replaces the behavior assertions removed with the legacy workflow engine and satisfies the Phase 4 equivalence gate.

### F8 — Dead workflow code and inert metadata

Deleted `assertWorkflowAccess` and `assertWorkflowActionAccess`, removed the stale workflow authorization export/mocks, removed inert `workflow.kind` / `workflow.costUnits` metadata from tool definitions, and deleted the final `createPendingWorkflowBooking` production helper. New pending bookings now have only the action-receipt implementation path. A source-level regression test asserts the dead authorization and workflow metadata do not return.

### F9 — Legacy workflow ledger disposition

Explicitly retired `ai_workflow_runs` in the Phase 4 migration. Historical rows and appointment foreign keys remain readable for audit, but INSERT/UPDATE/DELETE are revoked from `service_role` as well as authenticated clients. Production contains no workflow-ledger writer. The local integration test now verifies historical owner-scoped reads and rejects authenticated and service-role write attempts.

### F10 — `ai_turn_steps_max`

Made `ai_turn_steps_max` a live runtime control. `prepareAiExecution` clamps the certified task policy before reservation and agent construction, so metering and execution share the same effective step count. The Phase 4 migration updates AI-enabled plan limits to 25, matching the largest certified Phase 4 policy. Tests prove a plan value of 7 clamps both the loop and worst-case reservation to 7.

### F11 — Composite cost control

Kept the plan-approved budget-only `staff_composite` classification: it does not narrow or expand capabilities and does not introduce a Phase 5 feature gate. Its 25-step maximum is now controlled by the live `ai_turn_steps_max` entitlement from F10, so a clinic/tier can lower the composite cost ceiling without code changes. Tests cover composite routing, the 25-step certified policy, and entitlement clamping.

## Main implementation areas

- Orchestration and limits: `lib/ai/platform/registry.ts`, `lib/ai/platform/execution.ts`, `lib/ai/staff-agent.ts`.
- Actions and parity: `lib/ai/actions/**`, `lib/booking/pending-workflow.ts`, `lib/ai/capabilities.ts`.
- Persistence and replay safety: `app/api/agent/chat/route.ts`, `lib/ai/conversation-parts.ts`, `lib/ai/conversations.ts`, `components/assistant/assistant-chat.tsx`.
- Adversarial coverage: `lib/ai/eval/injection-corpus.ts` and `tests/unit/ai/p6a-injection-suite.test.ts`.
- Database/RLS: `supabase/migrations/20260813160000_ai_assistant_phase4_orchestration.sql` and the Phase 3/4 provenance integration tests.

## Verification

- Targeted Phase 4 suite — **9 files / 124 tests passed**.
- Full AI/API/actions regression — **95 files / 1,123 tests passed**.
- Full unit regression (`pnpm test`) — **339 files / 2,475 tests passed** after the final stale-test update.
- Full local integration/RLS suite (`pnpm test:integration`) — **52 files / 451 tests passed**; one linked-only file containing three tests remained intentionally skipped behind `RUN_LINKED_UNDO_REGRESSION=1` because remote/linked execution was out of scope.
- Targeted retired-ledger/action-booking RLS — **2 files / 9 tests passed**.
- Adversarial suite (`pnpm test:ai-adversarial`) — **2 files / 109 tests passed**.
- Typecheck (`pnpm typecheck`) — passed with no diagnostics.
- Lint (`pnpm lint`) — passed with zero errors; 26 pre-existing warnings remain in unrelated files.
- RTL gate (`pnpm lint:rtl`) — passed; 652 files scanned, 17 documented exceptions.
- i18n string gate (`pnpm lint:i18n`) — passed; 431 files scanned, 43 documented exceptions.
- Locale parity (`pnpm i18n:missing`) — passed; 3,966 base leaf messages.
- Unused-message gate (`pnpm i18n:unused`) — passed with no unreferenced keys.
- `git diff --check` — clean.

The local keys were obtained from `supabase status -o env`, held only in the test process, and not written to the repository. Migration `20260813160000_ai_assistant_phase4_orchestration.sql` applied locally and re-applied cleanly after its final retirement grant change.

## Remaining issues

No unresolved Phase 4 F1–F11 issue remains. The only reported verification residue is the repository's 26 unrelated lint warnings and the three explicitly linked-only integration tests noted above; neither was changed or run remotely. Review finding F12 remains outside this task by explicit scope and was not modified.

## Scope and safety confirmation

- Phase 5 and later phases were not started.
- Unrelated dirty work was preserved; nothing was reset, reverted, cleaned, or overwritten.
- No remote Supabase command, push, deployment, or external write was performed.
