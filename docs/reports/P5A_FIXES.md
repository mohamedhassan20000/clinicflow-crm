# P5A Review Fixes

**Date:** 2026-07-27  
**Source review:** `docs/reviews/P5A_REVIEW.md`  
**Scope:** P5A review remediation only. P5B was not started.

## 1. Findings fixed

### P5A-1 — fixed

The confirmed P4.11 booking path no longer attempts to persist workflow
provenance through the authenticated PostgREST role that P5A correctly blocks
from writing AI metadata.

`createPendingWorkflowBooking` now:

- retains the signed-in request client for the existing RLS-scoped patient,
  doctor, clinic, schedule, availability, and formatting reads;
- verifies that the request client's authenticated user is the same
  `AuthedUser` actor;
- uses `createClinicScopedAdminClient` only for the idempotent workflow booking
  lookup and insert;
- re-checks the content-free workflow ledger before the privileged write:
  same clinic, same requesting/confirming user, confirmed execute mode, an
  allowed confirmed/resume state, and the exact step registered as
  `create_pending_booking`;
- permits a succeeded run only for an already-created idempotent replay, never
  for a new insert;
- continues to insert only `pending`, preserves `created_by`, sends no patient
  notification, and omits `expires_at` so P5A's database trigger assigns the
  clinic-owned TTL.

This preserves the shipped P4.11 confirmation and idempotency behavior without
allowing a browser or ordinary authenticated database client to forge AI
provenance.

### P5A-2 — confirmed and covered

P4.11 workflow bookings intentionally participate in the P5A AI pending
policy. The behavior is now explicit:

- a live P4.11 workflow booking counts toward the one-active-AI-pending limit
  for that patient;
- patient-conversation and P4.11 workflow bookings share the clinic's
  `ai_pending_slot_cap`;
- a workflow attempt rejected by these policies returns a distinct
  `patient_pending_cap` or `slot_pending_cap` result;
- the workflow tool gives staff cap-specific clarification guidance instead of
  incorrectly describing every rejection as a stale time slot.

This is the approved §12 HP1 behavior: origin does not provide a way around
the AI pending caps.

### Complete workflow provenance ownership — hardened

The review focused on `ai_workflow_run_id`, but the paired
`ai_workflow_step_id` also belongs to server-owned provenance. The additive
review-fix migration replaces the metadata guard so authenticated/anonymous
clients cannot insert or update any of:

- `ai_patient_conversation_id`;
- `ai_workflow_run_id`;
- `ai_workflow_step_id`;
- `expires_at`.

Staff retain normal appointment lifecycle updates such as confirmation and
cancellation; only the AI origin/TTL metadata remains protected.

### Informational findings

P5A-3, P5A-4, and P5A-5 were explicitly informational/accepted design
properties in the review. No behavior was changed for them.

## 2. Live integration/regression coverage

Added `tests/unit/integration/p5a-p411-workflow-booking.test.ts`, using:

- real local Supabase auth users and a signed-in admin client;
- a real Pro + AI clinic, doctor, patients, conversations, subscription, and
  confirmed workflow ledger rows;
- the production `createPendingWorkflowBooking` helper;
- the final local migration stack.

The suite proves:

1. the authenticated P4.11 validation path creates the pending appointment via
   the narrow server persistence boundary;
2. workflow run/step provenance, `created_by`, pending status, and trigger-owned
   future expiry are stored correctly;
3. replay of the same workflow run/step returns the same appointment;
4. a direct authenticated workflow-metadata insert is rejected with
   `42501 AI_BOOKING_METADATA_SERVER_ONLY`;
5. an authenticated update of only `ai_workflow_step_id` is also rejected;
6. an unconfirmed preview cannot use the privileged write boundary;
7. an existing workflow booking blocks a patient-origin booking for the same
   patient with `AI_PENDING_PATIENT_CAP`;
8. one workflow-origin and one patient-origin booking fill a slot cap of two,
   and the third workflow-origin booking is rejected with
   `AI_PENDING_SLOT_CAP`.

## 3. Files changed for this remediation

- `lib/booking/pending-workflow.ts`
- `lib/ai/workflows/actions/create-pending-booking.ts`
- `supabase/migrations/20260727200000_p5a_review_fixes.sql`
- `tests/unit/db/p5a-patient-tools-booking-migration.test.ts`
- `tests/unit/integration/p5a-p411-workflow-booking.test.ts`
- `docs/reports/P5A_FIXES.md`

## 4. Validation results

| Validation | Result |
|---|---|
| Apply additive review-fix migration to local DB | Pass |
| Live P5A/P4.11 DB regressions (`p5a-p411-workflow-booking`, existing P5A booking integration, P4.11 workflow-ledger RLS) | Pass — 3 files, 17 tests |
| Focused P5A/P4.11/platform/cron/entitlement unit regressions | Pass — 9 files, 66 tests |
| Final focused migration/workflow unit rerun | Pass — 3 files, 21 tests |
| `pnpm typecheck` | Pass |
| Focused ESLint on changed TypeScript/test files | Pass |
| `git diff --check` | Pass |

No re-review, commit, push, merge, or P5B work was performed.
