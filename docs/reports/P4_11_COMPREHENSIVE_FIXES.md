# P4.11 — Comprehensive Review Fixes

**Date:** 2026-07-26

**Branch:** `feat/p411a-workflow-foundation`

**Source review:** `docs/reviews/P4.11_COMPREHENSIVE_REVIEW.md`

**Status:** M1 and L1–L3 remediated.

**Scope:** P4.11 only. P5 and later phases remain unstarted.

---

## 1. Outcome

All findings from the P4.11 comprehensive review are closed without widening the approved tool registry, authorization model, tenant boundary, write authority, or persisted-data envelope.

| Finding | Result | Remediation |
|---|---|---|
| M1 — resume was not bound to the confirmed preview | Fixed | The atomic first-confirmation claim now rotates the existing one-way ledger hash from the full preview snapshot to a hash of the exact server-resolved action inputs. Before any resume, authorized read steps reconstruct those inputs without invoking action tools; any literal swap or read-result target drift returns `preview_stale` before an unfinished action can execute. |
| L1 — raw ISO timestamps in the confirmation card | Fixed | Appointment-reminder and pending-booking previews now include clinic-timezone, clinic-locale, digit-aware labels produced through the existing messaging formatter. The UI renders those labels and uses the signed-in locale formatter only as a compatibility fallback. |
| L2 — infrastructure failures appeared as denials | Fixed | The confirmation action now returns `denied` only for `AiToolAuthorizationError`, maps plan/expiry outcomes explicitly, reports unexpected failures to Sentry without attaching workflow data, and returns `internal_error` with distinct bilingual UI copy. |
| L3 — previewed runs had no expiry | Fixed | An unconfirmed preview expires after 15 minutes. The server checks age both before and after preview recomputation; expired runs cannot be claimed and the UI requires a fresh preview. Confirmed partial runs do not expire and remain protected by action-input rebinding plus existing idempotency. |

## 2. Resume confirmation integrity

The durable `ai_workflow_runs` row remains content-free. No plan values, resolved ids, recipients, balances, channels, tool outputs, prompts, completions, or PHI are persisted.

The first confirmation still recomputes the complete action preview and compares it with the original preview hash. In the same atomic claim that records the confirming user and changes the run to `running`, the server replaces that hash with a SHA-256 digest of:

- each action step id;
- its closed-registry tool name; and
- its exact server-resolved input after all read-step references are applied.

On resume, the executor:

1. revalidates the submitted strict plan against the caller's fresh hidden workflow mount;
2. re-runs only the authorized read steps needed to resolve inputs;
3. does not invoke any action tool during the integrity check;
4. compares the fresh resolved-action-input hash with the confirmed binding; and
5. returns `preview_stale` before execution when they differ.

The check includes every action input, including literal values and values derived from read outputs. It intentionally excludes mutable step statuses. This allows a completed pending-booking action to remain terminal even though creating it changed availability, while preventing an unfinished reminder action from gaining a new recipient that was absent from the confirmed target set.

The subsequent action execution still performs its own role, entitlement, page-visibility, permission, RLS, availability, recipient, balance, channel, billing, usage, rate-limit, audit, and idempotency checks. The workflow hash is confirmation integrity, not authorization.

## 3. Expiry and failure semantics

`WORKFLOW_PREVIEW_TTL_MS` is 15 minutes. Only unconfirmed `previewed` runs are age-gated. A missing or invalid preview completion timestamp fails closed as expired. Age is checked before the potentially expensive preview recomputation and again immediately before the atomic claim.

Confirmation failures now preserve actionable categories:

- `preview_stale` — data or resolved targets changed;
- `preview_expired` — the unconfirmed preview is older than 15 minutes;
- `denied` — the authenticated authorization spine refused access;
- `invalid_request` / `not_confirmable` / `rate_limited` — existing bounded request states;
- `internal_error` — an unexpected infrastructure failure, captured to Sentry without plan or patient data.

English and Arabic UI copy distinguishes expiry and temporary infrastructure failure from authorization denial.

## 4. Date presentation

Appointment reminder drafts reuse the date and time already produced by `formatScheduledAt` from the clinic's timezone, formatting locale, digit system, and 12/24-hour preference. Pending-booking validation reads the same clinic formatting metadata through the authenticated clinic-scoped client and produces the same kind of label.

The raw ISO value remains in the transient action object because it is part of the exact confirmation snapshot and execution contract, but the confirmation UI no longer displays it. `<bdi>` remains around the formatted value for mixed-direction safety.

## 5. Preserved guarantees

- The model-visible workflow mount still exposes only the orchestrator.
- The action registry remains limited to appointment reminders, overdue-invoice reminders, and pending booking creation.
- Every nested tool continues through its own hardened authorization, RLS, PHI-minimization, audit, entitlement, billing, usage, and rate-limit boundary.
- Messaging still uses the existing per-channel dispatch/idempotency core.
- Booking still uses the availability core, creates only `pending`, and sends no patient notification.
- Completed action steps remain terminal on resume; unfinished sends/bookings retain their existing idempotency protection.
- The run ledger remains owner-readable and server-write-only with composite tenant/actor integrity.
- No destructive, unattended, scheduled, auto-send, billing-mutation, arbitrary-query/tool, patient-facing, P5, P6, or P7 behavior was added.
- No schema, RLS policy, database grant, entitlement, or generated database type changed.

## 6. Files changed

- `actions/assistant-workflows.ts`
- `components/assistant/assistant-chat.tsx`
- `docs/AI_AGENT_PLAN.md`
- `docs/reports/P4_11_COMPREHENSIVE_FIXES.md`
- `lib/ai/workflows/actions/send-appointment-reminders.ts`
- `lib/ai/workflows/executor.ts`
- `lib/ai/workflows/ledger.ts`
- `lib/ai/workflows/plan.ts`
- `lib/ai/workflows/types.ts`
- `lib/booking/pending-workflow.ts`
- `messages/en.json`
- `messages/ar.json`
- `supabase/migrations/20260726170000_p411b_workflow_actions.sql` (column-comment clarification only)
- `tests/unit/actions/p411-comprehensive-workflow-confirmation.test.ts`
- `tests/unit/ai/p411b-workflow-actions.test.ts`
- `tests/unit/components/p411b-workflow-confirmation-ui.test.tsx`
- `tests/unit/db/p411b-workflow-actions-migration.test.ts`

## 7. Test coverage

- Same-shaped literal target replacement on a confirmed partial run returns `preview_stale` and does not make a second action attempt.
- A referenced read result growing from patient A to patients A+D returns `preview_stale`; the resume integrity pass never invokes the action preview.
- An unchanged confirmed partial run resumes successfully and claims confirmation only once.
- An unconfirmed preview older than 15 minutes returns `preview_expired` and never claims or commits.
- Authorization denial and unexpected infrastructure failure map to distinct result codes; only the latter is reported to Sentry.
- Confirmation UI renders clinic-formatted dates rather than raw ISO values.
- Confirmation UI renders specific expired-preview and temporary-system-problem states.
- Migration contract continues to forbid authenticated writes and documents the one-way content-free hash lifecycle without adding an action-input column.

## 8. Validation

| Check | Result |
|---|---|
| Focused P4.11 engine/mount/action/server-action/UI/migration set | Pass — 7 files, 37 tests |
| Full unit suite (`pnpm test`) | Pass — 216 files, 1,577 tests |
| Full integration/RLS suite (env-loaded local Supabase) | Pass — 26 files, 273 tests |
| `pnpm typecheck` | Pass |
| `pnpm lint` | Pass — 0 errors; 25 pre-existing warnings in unrelated files |
| `pnpm lint:i18n` | Pass — 307 files; 14 documented exceptions |
| `pnpm i18n:missing` | Pass — 2,870 base leaf messages; locale variants valid |
| `pnpm i18n:unused` | Pass — no unreferenced keys |
| `pnpm lint:rtl` | Pass — 436 files; 10 documented exceptions |
| `pnpm build` | Pass — production build; 67 pages generated |
| `git diff --check` | Pass |

The first integration invocation did not load `.env.local`; the env-loaded sandbox run was then blocked from connecting to `127.0.0.1:54321`. The identical env-loaded suite was rerun with approved local-service access and passed in full. No credential value was printed.

The production build emits only the repository's existing Next.js middleware-to-proxy deprecation notice.

## 9. Final status

P4.11 M1 and L1–L3 are remediated. The phase remains bounded, explicitly confirmed, tenant-isolated, PHI-minimized, billing-safe, and within the approved architecture. The source review was not modified, no commit was created, and P5 was not started.
