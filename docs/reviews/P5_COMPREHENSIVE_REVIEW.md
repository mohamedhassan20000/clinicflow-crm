# P5 — Patient WhatsApp AI + Preliminary Booking — Comprehensive End-to-End Review

**Status:** ✅ **APPROVED — no merge-blocking findings.** Six non-blocking findings (1 medium operational, 3 low, plus carried-forward informationals) are recorded for P6/pre-GA hardening.
**Scope reviewed:** Full Phase P5 (P5A + P5A review fixes + P5B) on `feat/p5a-patient-tools-booking`, per `docs/AI_AGENT_PLAN.md` §P5/§P5A/§P5B, §5.4, §6.2, §6.3, §6.5, §6.6, §6.7, §9.1, §9.4, §12-HP1.
**Review date:** 2026-07-28
**Reviewer:** Claude Code — production-grade review verified against source **and the running local Supabase database and test suites**, not the implementation reports alone.
**Prior handoff:** `docs/reviews/P5A_REVIEW.md` (cycle 1, P5A-only) → remediated in `docs/reports/P5A_FIXES.md`. This file supersedes it as the whole-phase P5 handoff. Prior P5A findings are re-verified below under their original IDs.

This file is the authoritative Claude→Codex handoff for this cycle. Re-reviews must read it first, verify each finding by its stable ID, mark resolved items complete, keep unresolved items open, add new findings under new IDs, bump the cycle, and append a dated re-review section. Prior findings are never deleted.

---

## 1. Verdict

The P5 patient-AI layer is **soundly constructed and safe to merge.** The single blocking regression from the P5A review (`P5A-1`: the server-owned-metadata guard rejected P4.11B's authenticated workflow-booking insert) is **properly remediated and independently re-verified** — the workflow insert now runs through the clinic-scoped service boundary, and the guard was correctly widened to also server-own `ai_workflow_step_id`. Every core security property holds under independent live-DB verification:

- service-role-only patient RPC boundary (grants checked directly in Postgres),
- conversation-bound identity with **no model-visible `patient_id`**, DOB gating for detail disclosure, and server-owned verification state,
- race-safe pending caps + server-owned TTL + terminal cron expiry,
- fail-closed surface/persona/task/entitlement gating, with `ai.patient_auto` **off** on the shipped `pro_ai` catalog so automatic replies stay inert until an operator enables them,
- a single `sendMessage` send boundary for every outbound path (agent, auto, approved suggestion, escalation),
- `ai_suggested_replies` read-only to inbox roles under RLS with no authenticated write policy,
- strictly best-effort webhook wiring that never fails the webhook and always leaves the staff `inbox_message` notification as the fallback.

No new blocking regression to P3/P4/P4.5/P4.11 was found. The findings below are hardening and tuning items appropriate for P6A (adversarial/eval) and pre-GA operability; none blocks the P5 merge.

---

## 2. Review method

- Read `docs/AI_AGENT_PLAN.md` (P5/P5A/P5B scope, §12-HP1), `docs/reports/P5A_IMPLEMENTATION.md`, `docs/reviews/P5A_REVIEW.md`, `docs/reports/P5A_FIXES.md`, `docs/reports/P5B_IMPLEMENTATION.md`.
- Read every added/modified P5 file: the three migrations (`20260727180000`, `20260727200000`, `20260728120000`); `lib/ai/patient-reply.ts`, `patient-reply-mode.ts`, `patient-escalation.ts`, `patient-agent.ts`, `patient-authorization.ts`, `patient-tools.ts`, `patient-faq-settings.ts`, `prompts/patient.ts`; all six `lib/ai/tools/*` patient tools; `lib/booking/patient.ts`, `lib/booking/expiry.ts`; `lib/messaging/webhooks.ts`, `inbox.ts`, `patient-copy.ts`; `actions/messaging.ts`, `actions/patient-ai.ts`; `lib/supabase/admin.ts` (scoped-client guard + new helpers); `lib/ai/platform/execution.ts`; `lib/notifications/emit.ts`; `app/(protected)/settings/patient-ai/page.tsx`; `app/api/webhooks/whatsapp/route.ts`; `app/api/cron/reminders/route.ts`.
- **Ran validation independently against live local Supabase** (keys from `supabase status`):
  - P5 suites — `p5a-patient-tools`, `p5b-patient-escalation`, `p5b-patient-reply`, `p5b-inbox-suggestion`, `p5a-…-migration`, `p5b-inbox-ai-migration`, `p5a-p411-workflow-booking`, `p5a-patient-tools-booking` (integration), `p5b-inbox-ai-reply` (integration) → **9 files / 62 tests pass.**
  - Regression suites — `p45a-platform`, `p3d-cron-routes`, `entitlements`, `p3c-inbox-shell` → **4 files / 32 tests pass.**
  - `pnpm typecheck` → **pass.**
  - `pnpm i18n:missing` → **pass** (3,041 base leaf messages, parity valid).
  - `supabase migration list --local` → all three P5 migrations applied.
  - **Direct Postgres introspection** (via the `supabase_db` container): function EXECUTE grants, RLS policies, plan features, and appointment constraints.
- Empirical DB probes: verified grants and RLS directly; the authenticated-role metadata-guard probe was pre-empted by a pre-existing same-clinic validation trigger (needs a real auth JWT), so the authoritative proof is the `p5a-p411-workflow-booking` integration test, which signs in real auth users and asserts the `42501 AI_BOOKING_METADATA_SERVER_ONLY` rejection — it passed in this run.

---

## 3. Independently verified sound

| Property | How verified | Result |
|---|---|---|
| Patient RPCs are service-role-only | `has_function_privilege` for `service_role`/`authenticated`/`anon` on all six RPCs + `expire_ai_pending_bookings` | `t / f / f` for all seven |
| Trigger fns & commercial-limit resolver fully revoked | same introspection | `protect_ai_booking_metadata`, `enforce_ai_pending_booking_policy`, `resolve_ai_commercial_limits` → `f / f / f` (SECURITY DEFINER internal only) |
| `ai_suggested_replies` tenant isolation | `pg_class.relrowsecurity` + `pg_policies` | RLS on; single **SELECT-only** policy for `authenticated` inbox roles; **no** INSERT/UPDATE/DELETE policy → all writes are service-role |
| `ai.patient_auto` stays off | `plans.features` for `pro_ai` | `patient_suggest=true`, `patient_auto=false`, `scheduling=true` |
| Appointment provenance constraints | `pg_constraint` on `appointments` | origin-exclusive, patient/workflow same-clinic FKs, pending-expiry, workflow-pair checks all present |
| P5A-1 metadata guard fix | `p5a-p411-workflow-booking` integration test (real auth users) | authenticated workflow insert **and** `ai_workflow_step_id`-only update both rejected `42501`; server path succeeds; caps enforced |
| No model-visible `patient_id` | source read of all six tools + RPC return shapes | `patient_id` never a tool param or a returned field; identity derived from `(clinic_id, conversation_id)` |
| DOB gating | `list`/`cancel` RPCs require `identity_verified_at`; `requireVerified` in tools; prompt enforces it | list/cancel gated; availability/booking/FAQ are logistics-only by design (§5.4) |
| Fail-closed surface/persona/task gating | `prepareAiExecution` read | patient surface requires `patient` persona + `patient_*` task + `ai.patient_suggest` (+`ai.scheduling` for booking); mixed combos throw |
| Reply-mode safety gate | `resolveEffectiveAiReplyMode` + `setPatientAiReplyMode` | `auto` without `ai.patient_auto` → downgraded to `suggest`; enforced at runtime **and** in the settings action |
| Single send boundary | agent, auto, approved suggestion, escalation all call `sendMessage` | window rules, usage caps, `outbound_messages` recording preserved on every path |
| Escalation is pre-model & deterministic | `detectPatientEscalation` runs on raw inbound before any model call | emergency > human > medical > complaint priority; canned safety copy carries local emergency number by clinic country |
| Idempotency / no reply loop | webhook fires agent only on `inserted` (not replay); agent output → `outbound_messages` only | no self-trigger; replays skip the agent |
| Approve/dismiss claim | `approveAiSuggestion` claims `pending→sent` conditionally, releases on send failure | two staff cannot double-send; single-pending index enforced |

Carried-forward P5A informationals **re-confirmed** as accepted design: `P5A-3` (RPC overlap check is coarse defense-in-depth; authoritative availability is `lib/booking/patient.ts`), `P5A-4` (linked-but-unverified conversation may create a `pending` booking by design — logistics-only, capped, staff-confirmed, reveals no data), `P5A-5` (sticky DOB lockout fails safe).

---

## 4. Findings

### P5-1 — MEDIUM (operational, non-blocking) — the patient agent's LLM call runs synchronously on the webhook ACK path

**Affected:** `lib/messaging/webhooks.ts:82-93` (`await runPatientInboundAiReply` inside `persistInboundMessage`) ← `processMessagingWebhookEvents` (sequential `for` loop, awaited) ← `app/api/webhooks/whatsapp/route.ts:86-92` (awaits `processMessagingWebhookEvents` before returning `200`).

The full agent turn — `prepareAiExecution` (budget reservation RPC) + `agent.generate()` (a real provider round-trip, up to the task's `maxSteps`) + reconcile — executes **before** the webhook returns its `200` to 360dialog. Consequences:

- A slow or hung provider call delays the provider ACK. 360dialog/Meta retry unacknowledged webhooks, and repeated slow ACKs degrade endpoint-health scoring.
- Events are processed sequentially, so one slow inbound turn head-of-line-blocks every other event in the same batch (statuses, other inbound).
- No overall per-turn wall-clock timeout / circuit breaker is visible on the model call itself (token/step caps bound cost, not latency). §12-HP6 lists a circuit breaker on repeated model errors as intended platform work; it is not present on this path.

**Not a correctness/security bug:** inbound dedup (`persistWhatsAppInbound` → `inserted=false` on replay) means a retried webhook **skips** the agent, so there is no double-send; and every failure already degrades to a human with the staff notification intact. This is an availability/throughput and provider-reputation concern.

**Fix direction (P6, do not implement here):** move the agent invocation off the ACK path — enqueue (Vercel Queues / a background task / `waitUntil`) after persisting the inbound, or add a hard timeout that abandons the turn to the human fallback. Track alongside the §12-HP6 circuit breaker.

---

### P5-2 — LOW — `savePatientFaq` / `deletePatientFaq` gate on role only, not on the patient-AI entitlement

**Affected:** `actions/patient-ai.ts:68-137` (`savePatientFaq`, `deletePatientFaq` call only `requireMutationRole("admin")`).

`setPatientAiReplyMode` (same file) correctly rechecks `ai_assistant` + `ai.patient_suggest` before mutating, but the FAQ CRUD actions do not. The `/settings/patient-ai` page is entitlement- and primary-admin-gated for *visibility*, but the server actions are independently invocable by any clinic admin, including a `basic`/`pro` (non-AI) clinic. Impact is low — `clinic_faq` is benign clinic content, is written clinic-scoped through the reviewed service-role client, and is inert without the patient agent — but the gating is inconsistent with the sibling action and with §9.4's "entitlement checked at the action, next to `requireRole`."

**Fix direction:** add the same `ai_assistant` + `ai.patient_suggest` entitlement check to both FAQ actions.

---

### P5-3 — LOW — broad `urgent` emergency keyword auto-sends life-safety copy on a common false positive

**Affected:** `lib/ai/patient-escalation.ts:33-34` (`EMERGENCY_PATTERNS` includes `\b(emergency|ambulance|urgent(ly)?|life[-\s]?threatening)\b`), consumed at `lib/ai/patient-reply.ts:321-359` where `detection.emergency` forces `sendNow = true` **regardless of mode**.

Because an emergency match sends the canned "call {emergency number} right away" message immediately even in `suggest` mode (the deliberate §6.5 safety carve-out — the one intended exception to "no automatic send without `ai.patient_auto`"), a bare `"urgent"` is broad enough to misfire on ordinary logistics: *"I urgently need to reschedule"* / *"can I get an urgent appointment"* → the patient receives an alarming emergency-services message and the thread is locked to a human. The Arabic set is tighter (no generic "urgent"); the risk is concentrated in English.

**Not unsafe** (over-escalation fails safe toward a human), but patient-facing false alarms and needless AI lockouts are a real UX cost. Tuning this belongs to the P6A eval/adversarial suite, but flagged now because the carve-out makes the false positive *send*, not merely draft.

**Fix direction:** narrow `urgent` (e.g. require an accompanying life-safety noun, or drop it from the auto-send emergency set and let it escalate as a plain handoff draft). Add fixtures to the P6A set.

---

### P5-4 — LOW — supersede-then-insert of a suggestion is not atomic; a concurrent turn can silently drop a draft

**Affected:** `lib/ai/patient-reply.ts:124-160` (`recordSuggestion`: `UPDATE …status=pending → superseded` then `INSERT …status=pending`, two separate PostgREST calls) against the partial unique index `ai_suggested_replies_one_pending_idx (clinic_id, conversation_id) WHERE status='pending'`.

Two inbound turns on the same conversation processed concurrently can both pass the supersede step and race the insert; one insert violates the unique index, the error is swallowed by `.maybeSingle()` (returns `data:null`), and that turn's drafted reply is **silently lost after its model cost was already spent and reconciled**. Rare (requires two near-simultaneous agent runs for one patient) and non-corrupting, but the loss is invisible.

**Fix direction:** perform the supersede+insert in one transaction/RPC, or upsert, or at minimum surface the dropped-insert in telemetry.

---

### P5-5 — INFORMATIONAL — `clearConversationEscalation` does not dismiss a still-pending handoff suggestion

**Affected:** `actions/messaging.ts:519-537`.

"Return to AI" clears `ai_escalated_at`/`ai_escalation_reason` but leaves any `pending` canned-handoff `ai_suggested_replies` row (created when a `suggest`-mode handoff was drafted) in place. It is harmless — the next inbound turn supersedes it — but staff may briefly see a stale suggestion card after re-enabling the AI. Consider dismissing the conversation's pending suggestion in the same action.

---

### P5-6 — INFORMATIONAL — multi-turn context uses redacted `body_preview` for the agent's own prior replies

**Affected:** `lib/ai/patient-reply.ts:198-238` (`loadHistory` maps `outbound_messages.body_preview` to assistant turns).

The agent sees truncated/redacted previews of its own earlier replies, which can mildly reduce multi-turn coherence. Acceptable (minimal-PHI history, bounded cost); noted for awareness.

---

## 5. Validation performed (this review)

| Check | Result |
|---|---|
| P5 suites (unit + live integration), live local DB | **Pass — 9 files / 62 tests** |
| Regression suites (`p45a-platform`, `p3d-cron-routes`, `entitlements`, `p3c-inbox-shell`) | **Pass — 4 files / 32 tests** |
| `pnpm typecheck` | **Pass** |
| `pnpm i18n:missing` (parity) | **Pass — 3,041 base leaf messages** |
| `supabase migration list --local` | All three P5 migrations applied |
| Postgres grant introspection (6 RPCs + expire) | service_role-only; trigger fns & commercial-limits fully revoked |
| `ai_suggested_replies` RLS/policies | RLS on; SELECT-only for inbox roles; no write policy |
| `pro_ai` plan features | `patient_suggest=true`, `patient_auto=false`, `scheduling=true` |
| Appointment provenance constraints | present (origin-exclusive, same-clinic FKs, expiry, workflow-pair) |
| P5A-1 remediation (authenticated metadata-guard rejection) | Verified via passing `p5a-p411-workflow-booking` integration test |

Not independently re-run this cycle (last run green per `docs/reports/P5B_IMPLEMENTATION.md`): full 270-file suite, `pnpm lint`, `lint:rtl`, `lint:i18n`, `pnpm build`. Nothing reviewed here contradicts those results; re-run before final merge if the branch has moved.

---

## 6. Checklist (stable IDs)

- [ ] **P5-1** (medium) — move the patient-agent LLM call off the webhook ACK path; add a per-turn timeout/circuit breaker (P6/§12-HP6).
- [ ] **P5-2** (low) — add `ai_assistant` + `ai.patient_suggest` entitlement checks to `savePatientFaq`/`deletePatientFaq`.
- [ ] **P5-3** (low) — narrow the `urgent` emergency keyword so common reschedule phrasing doesn't auto-send emergency copy; add P6A fixtures.
- [ ] **P5-4** (low) — make suggestion supersede+insert atomic (or surface dropped inserts) to avoid silent draft loss under concurrency.
- [ ] **P5-5** (info) — optionally dismiss the pending handoff suggestion when clearing an escalation.
- [ ] **P5-6** (info) — awareness: agent history uses redacted `body_preview` for its own prior turns.
- [x] **P5A-1** (was blocker) — RESOLVED & re-verified: workflow booking routed through the service boundary; guard server-owns the full provenance pair (`20260727200000_p5a_review_fixes.sql`).
- [x] **P5A-2** — CONFIRMED & covered: workflow bookings participate in the AI pending caps (approved §12-HP1 behavior).
- [x] **P5A-3 / P5A-4 / P5A-5** — re-confirmed accepted design properties.

None of P5-1…P5-6 blocks merge. Codex may start the (optional) fix cycle on the open items above.

**Review report path:** `docs/reviews/P5_COMPREHENSIVE_REVIEW.md`
