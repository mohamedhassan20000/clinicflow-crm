# P4.11B — Action Workflows, Confirmation, and Resume UX

**Date:** 2026-07-26  
**Branch:** `feat/p411a-workflow-foundation`  
**Status:** Implemented; completes P4.11. P5 and later phases remain unstarted.  
**Roadmap:** `docs/AI_AGENT_PLAN.md` §8 — P4.11B.  
**Baseline:** Approved P4.11A (`docs/reports/P4_11A_IMPLEMENTATION.md`, `docs/reviews/P4.11A_REVIEW.md`).

---

## 1. Scope delivered

P4.11B extends the approved P4.11A registry workflow engine with a closed set of action steps:

- exact action dry-run previews before any mutation or send;
- explicit, per-run human confirmation in the Assistant;
- server-side preview recomputation and snapshot-hash verification;
- an atomic, same-owner, non-replayable confirmation claim;
- confirmed execution through the existing messaging and booking cores;
- safe resume of only unfinished action steps after a partial failure;
- accessible English and Arabic confirmation/result UX with RTL-safe layout;
- bounded suggested-workflow prompts;
- a `needs_clarification` terminal state and removal of redundant running-ledger writes identified by the non-blocking P4.11A review.

No arbitrary tool, destructive action, status transition, billing mutation, unattended workflow, scheduled workflow, or auto-send path was added.

## 2. Supported action workflows

### Appointment reminders

`send_appointment_reminders` is available to authorized admins and receptionists. It:

- RLS re-reads the selected pending/confirmed appointments in the current clinic;
- previews the exact patients, appointment times, and eligible channels;
- sends only after confirmation through the existing `dispatchPatientMessage` boundary;
- uses the canonical `appointment_reminder:<appointment_id>` logical key, so the existing per-channel `message_dispatches` idempotency prevents duplicates with retries or the daily reminder path;
- retains the messaging core's channel eligibility, template/settings, usage accounting, entitlement, billing, audit, and rate-limit behavior.

### Overdue-invoice reminders

`send_invoice_reminders` is available only to authorized admins/managers with the financial feature and per-user financial-insights grant. It:

- rechecks Revenue page visibility and financial authorization;
- RLS re-reads completed appointments with an outstanding balance;
- previews the exact recipients, balances, and eligible channels;
- sends only after confirmation through the existing clinic-configured invoice follow-up messaging path;
- uses the canonical `invoice_followup:<appointment_id>:step0` dispatch key for per-channel idempotency.

### Pending booking creation

`create_pending_booking` is available to authorized admins and receptionists. It:

- revalidates the patient, doctor, optional department, clinic timezone, future time, duration, and availability through the existing booking availability core;
- previews the patient, doctor, time, duration, `pending` status, and the fact that no patient notification will be sent;
- creates only a `pending` appointment after confirmation;
- never confirms, reschedules, cancels, overwrites, or notifies;
- uses `(clinic_id, ai_workflow_run_id, ai_workflow_step_id)` provenance for retry-safe idempotency.

### Reports and read composition

P4.11B does not invent a report mutation. Existing authorized report/read registry steps, including `run_clinic_report`, remain composable through the approved P4.11A path. Their normal report authorization, RLS, financial permission, output minimization, and audit boundaries are unchanged.

## 3. Confirmation and safe-resume design

1. The model may propose only tools in the caller's hidden, server-resolved registry mount.
2. Any plan containing an action is forced into preview mode, even if the model requests execution.
3. Preview re-runs all step authorization and read dependencies and invokes action tools in server-encoded `preview` mode. It performs no mutation or send.
4. The durable ledger stores only the content-free plan/step shape and a SHA-256 hash derived from the exact preview. Preview details remain in the current assistant tool result for display and are not persisted.
5. The user selects the explicit confirmation control. The server action authenticates again, rechecks the complete Assistant/workflow entitlement and page-visibility spine, applies a fail-closed confirmation rate limit, and resolves a fresh hidden step mount.
6. The executor revalidates the supplied plan, recomputes the preview under current RLS and authorization, and compares its hash with the stored snapshot.
7. A changed recipient, balance, channel, appointment, permission, availability result, or plan makes the preview stale. Nothing is claimed or executed; the user is asked to preview again.
8. A matching preview is atomically claimed by clinic, owner, run state, hash, and empty confirmation timestamp. Only that claimant can begin execution; a repeated confirmation cannot replay it.
9. On resume, successful action steps are skipped. Read steps are safely rerun only to reconstruct ephemeral inputs; unfinished actions are attempted through their normal idempotency boundary.
10. Independent completed work and failed/skipped work are reported separately. A remaining retryable partial state exposes a Resume control; success removes it.

Action outputs cannot feed later action dependencies. This intentionally avoids persisting PHI-bearing outputs solely to reconstruct a resume and keeps action replay safety explicit.

## 4. Security and trust-boundary decisions

### Closed registry; hidden action mount

The model-visible workflow mount still contains only the orchestrator. Action tools are never peer tools visible to the model or callable from ordinary task classes. The server admits only definitions marked `workflow.kind = "action"` and registered for `staff_workflow`; unknown tools, nested orchestrators, and dependencies on action outputs are rejected before execution.

### Per-step authorization remains authoritative

The workflow envelope grants no permission. Every preview and confirmed step independently rechecks:

- authenticated clinic/user identity;
- role and active subscription;
- `ai.staff_assistant`, `ai.workflows`, and action-specific plan features;
- per-user financial grants where applicable;
- Assistant and relevant product-page visibility;
- tenant-scoped RLS reads;
- existing messaging/booking/report constraints;
- tool-level audit and safe denial behavior.

P4.10 conversational context remains advisory. The client/model cannot convert a context id, preview payload, or prior tool output into authorization.

### PHI and ledger minimization

The browser submits a run id and the strict typed plan it already received in the assistant turn. Clinic id, user id, confirmation actor, execution mode, tool mount, and ledger transitions remain server-derived. The durable run row contains no patient names, identifiers, phone/email values, appointment details, invoice balances, message content, tool outputs, prompts, or completions. Exact preview data is transient UI state; only its one-way hash is durable.

### Messaging, accounting, and abuse boundaries

Confirmed sends reuse the existing dispatch core rather than calling providers directly. Consequently, per-channel idempotency, templates/settings, provider configuration, message audit rows, usage counters, limits, entitlements, and existing send-rate controls remain authoritative. Workflow confirmation adds a separate fail-closed `10/minute` clinic rate limit and does not replace the core's own checks.

### No destructive or unattended behavior

The action registry has no delete, status override, invoice/billing mutation, free-form SQL, arbitrary HTTP/tool, scheduler, cron, or patient-side entry. Booking is pending-only, and a send occurs only as part of the exact run the authenticated user just confirmed.

## 5. Database migration

`20260726170000_p411b_workflow_actions.sql`:

- adds `needs_clarification` to the constrained run-state vocabulary;
- permits a confirmed execute-mode run to retain its dry-run hash and confirmation actor/time;
- preserves the run timing/state consistency constraints;
- adds nullable, content-free `ai_workflow_run_id` and `ai_workflow_step_id` appointment provenance;
- enforces paired provenance, same-clinic composite referential integrity, and one appointment per workflow run/step through a partial unique index.

The migration adds no table write grant or authenticated write policy for `ai_workflow_runs`, no provider credential exposure, no destructive statement, and no P5 hold/expiry/patient-identity schema.

## 6. Files added or modified

### Added

- `actions/assistant-workflows.ts`
- `lib/ai/workflows/actions/send-appointment-reminders.ts`
- `lib/ai/workflows/actions/send-invoice-reminders.ts`
- `lib/ai/workflows/actions/create-pending-booking.ts`
- `lib/booking/pending-workflow.ts`
- `supabase/migrations/20260726170000_p411b_workflow_actions.sql`
- `tests/unit/ai/p411b-workflow-actions.test.ts`
- `tests/unit/components/p411b-workflow-confirmation-ui.test.tsx`
- `tests/unit/db/p411b-workflow-actions-migration.test.ts`
- `docs/reports/P4_11B_IMPLEMENTATION.md`

### Modified

- `components/assistant/assistant-chat.tsx`
- `docs/AI_AGENT_PLAN.md`
- `lib/ai/authorization.ts`
- `lib/ai/capabilities.ts`
- `lib/ai/platform/execution.ts`
- `lib/ai/prompts/staff.ts`
- `lib/ai/tool-presentation.ts`
- `lib/ai/tools/context.ts`
- `lib/ai/tools/index.ts`
- `lib/ai/tools/registry.ts`
- `lib/ai/workflows/executor.ts`
- `lib/ai/workflows/ledger.ts`
- `lib/ai/workflows/plan.ts`
- `lib/ai/workflows/tool.ts`
- `lib/ai/workflows/types.ts`
- `messages/en.json`
- `messages/ar.json`
- `tests/unit/ai/p411a-workflow-mount.test.ts`
- `tests/unit/integration/p411a-workflow-runs-rls.test.ts`
- `types/database.ts`

## 7. UX, accessibility, i18n, and RTL

The Assistant renders action previews as a dedicated confirmation card rather than a generic tool payload. It shows:

- the workflow title and explicit “review before sending/creating” state;
- each step's type, exact recipients/details, channels, and pending/no-notification status;
- a minimum 44px confirmation control;
- progress, success, partial-failure, stale-preview, denied, rate-limited, and safe-resume states;
- a permanent statement that ClinicFlow will not send or create anything before confirmation.

The component uses programmatic labels, `aria-labelledby`, status/alert live semantics, keyboard-native controls, `<bdi>` around bidirectional date content, and logical CSS properties. All new copy and suggested workflows exist in both English and Arabic.

## 8. Test coverage

- **Plan/executor:** forced preview, no unconfirmed commit, snapshot-bound confirmation, stale preview denial, atomic claim, successful action execution, and action-output dependency denial.
- **Mount:** only the orchestrator is model-visible; authorized action definitions exist only in the hidden workflow mount.
- **UX:** exact preview disclosure, explicit confirmation control, no-auto guarantee, and resume/result rendering.
- **Migration:** server-only run writes, tenant-safe composite provenance, idempotency index, clarification state, and absence of destructive SQL.
- **Live RLS:** owner preview read, authenticated confirmation forgery denial, cross-tenant confirmation actor denial, and same-owner server confirmation.
- **Regression:** existing P4.11A read workflows, capability/presentation resolution, full unit suite, and full integration/RLS suite.

## 9. Validation results

| Check | Result |
|---|---|
| Focused P4.11B action/UI/migration tests | Pass — 3 files, 11 tests |
| Focused workflow mount regression | Pass — 1 file, 5 tests |
| Focused live workflow RLS integration | Pass — 1 file, 6 tests |
| Full unit suite (excludes live integration) | Pass — 215 files, 1,570 tests |
| Full integration/RLS suite | Pass — 26 files, 273 tests |
| `pnpm typecheck` | Pass |
| `pnpm lint` | Pass — 0 errors; 25 pre-existing warnings in unrelated files |
| `pnpm lint:i18n` | Pass — 307 files; 14 documented exceptions |
| `pnpm i18n:missing` | Pass — 2,868 base leaf messages; locale variants valid |
| `pnpm i18n:unused` | Pass — no unreferenced keys |
| `pnpm lint:rtl` | Pass — 436 files; 10 documented exceptions |
| Generated database-type parity | Pass — touched `ai_workflow_runs` and `appointments` blocks exactly match fresh local generation (88/88 and 227/227 lines) |
| `pnpm build` | Pass — production build; 67 pages generated |
| `git diff --check` | Pass |

## 10. Explicit later-phase boundary

P4.11B completes P4.11 only. P5 and later phases were not started. In particular, this implementation adds no:

- patient-facing AI or WhatsApp agent;
- patient authentication/DOB verification;
- preliminary-booking hold, expiry, pile-up cap, or auto-confirm behavior;
- inbox webhook automation or suggest/auto mode;
- scheduled/unattended workflow;
- follow-up generation, patient FAQ, rescheduling negotiation, or P5 schema;
- P6 provider migration/evaluation behavior or P7 document engine.
