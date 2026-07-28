# P5A — Patient Tools & Booking Hardening — Security & Regression Review

**Status:** ⛔ CHANGES REQUESTED — one confirmed blocking regression to shipped P4.11 functionality.
**Scope reviewed:** Phase P5A only (`feat/p5a-patient-tools-booking`), per `docs/AI_AGENT_PLAN.md` §P5/P5A, §5.4, §6.3, §9.1, §9.4, §12-HP1.
**Review date:** 2026-07-27
**Reviewer:** Claude Code — production-grade review against the plan and `docs/reports/P5A_IMPLEMENTATION.md`, verified against source AND the running local Supabase database (not the report alone).
**Verdict:** **NOT APPROVED.** P5A's server-owned-metadata guard trigger (`protect_ai_booking_metadata`) rejects the exact `INSERT` that the merged P4.11B "create pending booking" workflow action performs, because that insert runs under the `authenticated` role. Every other reviewed dimension — tenant isolation, identity gating, service-role RPC boundary, booking concurrency, TTL/expiry, billing/usage attribution, and content-minimized auditing — is sound and independently verified. The single regression must be fixed before merge.

This file is the authoritative handoff for this review cycle. Re-reviews must read it first, verify each finding by its stable ID, mark resolved items completed, keep unresolved items open, add new findings under new IDs, and append a dated re-review section. Prior findings must never be deleted.

---

## 1. Review method

- Read `docs/AI_AGENT_PLAN.md` (P5/P5A scope, §12-HP1 caps/TTL decision) and `docs/reports/P5A_IMPLEMENTATION.md`.
- Read every added/modified P5A file: the migration `20260727180000_p5a_patient_tools_booking.sql`, `lib/booking/patient.ts`, `lib/booking/expiry.ts`, `lib/ai/patient-authorization.ts`, `lib/ai/patient-tools.ts`, `lib/ai/patient-agent.ts`, `lib/ai/prompts/patient.ts`, all six `lib/ai/tools/*` patient tools, and the diffs to `lib/ai/platform/execution.ts`, `lib/ai/platform/registry.ts`, `lib/supabase/admin.ts`, `app/api/cron/reminders/route.ts`.
- Ran the P5A suites and the modified regression suites against the **live local Supabase** (`supabase status` keys):
  - `tests/unit/db/p5a-patient-tools-booking-migration.test.ts`, `tests/unit/integration/p5a-patient-tools-booking.test.ts`, `tests/unit/ai/p5a-patient-tools.test.ts`, `tests/unit/lib/p5a-booking-expiry.test.ts` → **4 files / 23 tests pass**.
  - `tests/unit/ai/p45a-platform.test.ts`, `tests/unit/api/p3d-cron-routes.test.ts`, `tests/unit/lib/entitlements.test.ts` → **3 files / 30 tests pass**.
  - P4.11 / workflow-booking suites → **3 files / 15 tests pass** (mock-based; see P5A-1).
- `pnpm tsc --noEmit` → **pass**.
- **Empirically reproduced the P5A-1 regression** against the live DB: created a `pro_ai` clinic, real auth users (admin + doctor), and a patient; signed in as `authenticated`; performed a normal staff pending insert (control) and a P4.11-shaped insert carrying `ai_workflow_run_id`/`ai_workflow_step_id`. Control succeeded; the workflow-shaped insert failed with `42501 AI_BOOKING_METADATA_SERVER_ONLY`.
- Verified tenant scoping of `createClinicScopedAdminClient` (auto-injects `.eq("clinic_id", …)` on scoped reads) and that `effective_ai_feature` filters `plan.slug = 'pro_ai'` so `basic`/`pro` resolve every AI key to false.

---

## 2. Findings

### P5A-1 — BLOCKER — `protect_ai_booking_metadata` breaks P4.11B workflow pending-booking creation

**Affected:** `supabase/migrations/20260727180000_p5a_patient_tools_booking.sql:150-184` (`protect_ai_booking_metadata` + `trg_appointments_guard_ai_metadata`), against `lib/booking/pending-workflow.ts:160-174` and `lib/ai/workflows/actions/create-pending-booking.ts:37,67-73`.

**Root cause.** The new `INSERT` guard fires for any role in `('anon','authenticated')` and raises `AI_BOOKING_METADATA_SERVER_ONLY` when `ai_patient_conversation_id`, `ai_workflow_run_id`, or `expires_at` is non-null:

```sql
if tg_op = 'INSERT' then
  if new.ai_patient_conversation_id is not null
     or new.ai_workflow_run_id is not null
     or new.expires_at is not null then
    raise exception 'AI_BOOKING_METADATA_SERVER_ONLY' using errcode = '42501';
  end if;
```

P4.11B's shipped `createPendingWorkflowBooking` (merged in PR #50) inserts the confirmed workflow booking **with `ai_workflow_run_id` and `ai_workflow_step_id` set**, through the request-scoped server client:

```ts
// lib/ai/workflows/actions/create-pending-booking.ts
const supabase = await createClient();          // @/lib/supabase/server → anon key + user JWT → auth.role() = 'authenticated'
…
const created = await createPendingWorkflowBooking({ supabase, user: ctx.user, booking, workflowRunId, workflowStepId });
// lib/booking/pending-workflow.ts:162
.insert({ …, created_by: input.user.id, ai_workflow_run_id: input.workflowRunId, ai_workflow_step_id: input.workflowStepId })
```

Because that client authenticates as `authenticated`, the guard rejects the insert. The patient-tool path is unaffected only because it inserts via the `SECURITY DEFINER` RPC under `service_role`, which the guard's first clause bypasses.

**Empirical proof (live local DB).**
- Control — authenticated staff pending insert, no AI metadata → **OK**.
- P4.11-shaped — same authenticated insert plus `ai_workflow_run_id`/`ai_workflow_step_id` → **`ERROR 42501 AI_BOOKING_METADATA_SERVER_ONLY`**.

**Why the test suite is green anyway.** No live integration test inserts `ai_workflow_run_id` as an `authenticated` user — `grep` over `tests/unit/integration/` for `ai_workflow_run_id`/`ai_workflow_step_id` returns nothing, and the P4.11 tests (`p411a-workflow-mount.test.ts` et al.) mock the Supabase client, so the DB trigger never runs. This is the coverage gap that hid the regression; the P5A implementation report's "full suite pass" therefore does not exercise this path.

**Blast radius.** Every `pro_ai` clinic that confirms an AI workflow "create pending booking" action (a live, merged P4.11B feature) will fail at the database layer after this migration. Read/report workflows are unaffected; only the booking action step breaks.

**Fix direction (do not implement here).** Route the workflow booking insert through a `service_role` path (mirroring the patient `create_patient_preliminary_booking` RPC), or narrow the guard so an `authenticated` insert may set `ai_workflow_run_id`/`ai_workflow_step_id` when `created_by = auth.uid()` and the workflow pair is internally consistent, while still server-owning `ai_patient_conversation_id`/`expires_at`. Add a live integration test that inserts a workflow booking as `authenticated` so the path is covered.

---

### P5A-2 — LOW (design consequence of P5A-1's fix) — workflow bookings will become subject to the AI pending-caps once the insert is unblocked

**Affected:** `…:186-311` (`enforce_ai_pending_booking_policy` + `trg_appointments_ai_pending_policy`).

The pending-policy trigger deliberately treats `ai_workflow_run_id` bookings as "AI" and enforces one-active-AI-pending-per-patient and the per-slot cap across both patient- and workflow-origin rows. This is intended hardening (report §2), but it is a **behavior change to P4.11**: once P5A-1 is fixed, a workflow booking can be rejected with `AI_PENDING_PATIENT_CAP`/`AI_PENDING_SLOT_CAP` where it previously always succeeded. Currently masked by P5A-1 (workflow inserts never reach the count logic). Confirm this is acceptable and cover it with a test when P5A-1 is remediated.

---

### P5A-3 — INFORMATIONAL — `create_patient_preliminary_booking` RPC overlap check is a coarse defense-in-depth layer

**Affected:** `…:576-596`.

The RPC's own conflict check only compares against `confirmed`/`arrived`/`in_session` rows with a fixed 15-minute buffer; it does not re-validate clinic working hours, doctor schedule, or off-grid slots. Authoritative availability is enforced in `lib/booking/patient.ts` (`getPatientAvailableSlots` → `computeAvailableSlots`) before the RPC is called, and the RPC is `service_role`-only, so this is acceptable. Noted so a future direct caller does not mistake the RPC for full slot validation.

---

### P5A-4 — INFORMATIONAL — linked-but-unverified conversations may create a pending booking without DOB

**Affected:** `lib/ai/tools/create-preliminary-booking.ts:27-30` (`requireLinked: true`, `requireScheduling: true`, no `requireVerified`).

By design (report §4, plan §5.4): availability, preliminary booking, and FAQ are logistics-only; DOB gating is required only to **list/cancel** appointment details. Booking identity therefore rests on the phone→patient conversation link. The created row is always `pending`, capped at one active per patient, staff-confirmed, and reveals no existing patient data, so residual risk is low and consistent with the approved scope. Recorded as an accepted design property, not a defect.

---

### P5A-5 — INFORMATIONAL — DOB lockout is "sticky" after the first lock

**Affected:** `…:464-492` (`verify_patient_conversation_dob`).

`identity_verification_failures` saturates at 5, so after the first 15-minute lock expires, any single subsequent DOB mismatch re-locks immediately (`v_failures >= 5`). This is stricter-than-linear, fails safe, and never leaks DOB (audit stores only `method`/`verified`/`locked`). No change required; noted for expected behavior.

---

## 3. What was verified sound

- **Service-role RPC boundary.** All six patient RPCs (`resolve_patient_ai_context`, `verify_patient_conversation_dob`, `create_patient_preliminary_booking`, `list_patient_ai_appointments`, `cancel_patient_ai_appointment`, `search_patient_clinic_faq`) reject non-`service_role` callers, re-check `ai_assistant` + `ai.patient_suggest` (+ `ai.scheduling` for booking), bind every query to the exact `(clinic_id, conversation_id)` pair, derive the patient from the conversation, and are revoked from `public/anon/authenticated`. Cross-tenant conversation access is denied (integration tests + code).
- **No model-visible `patient_id`.** `patient_id` never appears in any tool return; `list`/`cancel` operate on `appointment_id` re-scoped to the conversation's patient inside the RPC.
- **Identity gating & defense-in-depth.** `identity_verified_at`/failure counter/lock are server-owned; `protect_patient_ai_identity_state` blocks authenticated forgery, and `clear_conversation_identity_on_patient_change` resets proof on relink (trigger order verified: clear runs before guard). List/cancel require `identity_verified_at`.
- **Booking concurrency (§12-HP1).** `enforce_ai_pending_booking_policy` takes a clinic-scoped `pg_advisory_xact_lock` before both count checks, so one-active-pending-per-patient and the per-slot cap are race-safe; TTL is server-set and `<= now` rejected. Two same-slot pendings allowed, third rejected (integration tests pass).
- **TTL expiry.** `expire_ai_pending_bookings` is `service_role`-only, claims due rows `FOR UPDATE SKIP LOCKED`, cancels terminally, and writes one content-minimized `AI_PENDING_BOOKING_EXPIRED` audit row atomically. Wired as an isolated `Promise.allSettled` sub-job of the CRON-secret-guarded P3D route; the route only 503s when all three sub-jobs fail.
- **Entitlements / tier isolation.** `effective_ai_feature` filters `plan.slug = 'pro_ai'`, so `basic`/`pro` return false for `ai.patient_suggest`/`ai.scheduling`/`ai_assistant`. `prepareAiExecution` now fails closed on any surface/persona/task mismatch and requires `ai.patient_suggest` (+ `ai.scheduling` for `patient_booking`).
- **Billing/usage.** Patient turns use the conversation UUID as a content-free actor key; `ai_budget_reservations.actor_id`/usage `actor_id` carry no FK to `profiles`, and `log_ai_provider_fallback` nulls `audit_logs.actor_id` for `surface = 'patient_messaging'`. The `resolve_ai_commercial_limits` broadening keeps its original `revoke … from service_role` posture (called only by internal `SECURITY DEFINER` functions), so it is not a grant regression.
- **Tool mount & prompt.** `buildPatientTools` mounts exactly the six allow-listed tools (FAQ-only for `patient_faq`); no staff/report/finance/clinical/workflow/navigation tool can enter. Outputs pass `sanitizeUntrustedDeep` + `withProvenance`. ar/en prompts enforce pending-only language, DOB gating, no-medical-advice, no-id-disclosure, and untrusted-text handling.
- **Tenant scoping of the availability path.** `createClinicScopedAdminClient` auto-injects `clinic_id` equality on scoped reads; availability cannot leak cross-clinic doctors/services.

---

## 4. Validation performed (this review)

| Check | Result |
|---|---|
| P5A migration + integration + tools + expiry suites (live local DB) | Pass — 4 files / 23 tests |
| Modified regression suites (`p45a-platform`, `p3d-cron-routes`, `entitlements`) | Pass — 3 files / 30 tests |
| P4.11 / workflow-booking suites | Pass — 3 files / 15 tests (mock-based; do not exercise the live insert — see P5A-1) |
| `pnpm tsc --noEmit` | Pass |
| Empirical live-DB probe: authenticated staff insert with `ai_workflow_run_id` | **FAIL — `42501 AI_BOOKING_METADATA_SERVER_ONLY`** (control insert without AI metadata: OK) → confirms P5A-1 |
| `createClinicScopedAdminClient` clinic scoping | Verified (auto `.eq("clinic_id", …)`) |
| `effective_ai_feature` tier isolation (`pro_ai`-only) | Verified |

---

## 5. Verdict

**CHANGES REQUESTED.** Resolve **P5A-1** (the migration's `authenticated`-role metadata guard rejects P4.11B's shipped workflow-booking insert) and add live coverage for that path; review **P5A-2** as a consequence of the fix. P5A-3/4/5 are informational. The patient-tool security model itself — service-only RPCs, tenant binding, identity gating, no model-visible patient id, race-safe caps/TTL, content-minimized audit, and fail-closed entitlement/surface gating — is well constructed and independently verified.

**Review report path:** `docs/reviews/P5A_REVIEW.md`
