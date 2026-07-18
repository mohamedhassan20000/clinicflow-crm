# P4B Post-Fix Review — Staff Assistant UI

**Sub-phase:** P4B — Staff assistant chat UI (streaming route, assistant page, patient-profile launcher)
**Branch scope reviewed:** uncommitted P4B working tree on `main` (post-fix pass)
**Reviewer:** Claude (fresh, independent post-fix review)
**Date:** 2026-07-18
**Plan reference:** `docs/AI_AGENT_PLAN.md` §6, §8 "P4 execution split → P4B"
**Inputs read:** `docs/AI_AGENT_PLAN.md` (full), `docs/reports/P4B_IMPLEMENTATION.md`, `docs/reviews/P4B_REVIEW.md`, `docs/reports/P4B_FIXES.md`
**New migration under review:** `supabase/migrations/20260718170000_p4b_ai_usage_reservation.sql`

---

## Final Verdict: **APPROVED**

Every finding from the initial P4B review (M1, M2, L1–L6) has been correctly and completely resolved. The new `release_usage` compensation migration is service-role-only, tenant-scoped, atomic, non-underflowing, and has no client-accessible path — verified both statically and against the live local database. No new Critical, High, or Medium findings. P4B is ready for the comprehensive Phase 4 review.

---

## 1. Executive Summary

P4B remains a disciplined, read-only staff surface layered on the reviewed P4A authorization/tooling foundation. The post-fix pass reworked usage accounting from a "check-then-count-on-finish" model into an **atomic reserve-before-generation / compensate-on-failure** model, and closed all six Low findings without expanding scope, adding tools, or changing authorization/RLS policy.

The two Medium findings are the substantive ones and both are now correct:

- **M1 (failed/empty/aborted turns consuming usage or orphaning messages)** — the route now reserves exactly one unit before model work and **releases** it on abort, stream error, `finishReason === "error"`, or empty assistant text, persisting **neither** the user nor an assistant message on those paths. A first turn is kept **virtual** (no conversation row) until a successful completion, so a failed first turn leaves no orphaned row. The old `recordAiTurn` finish-time increment is fully removed (no double counting).
- **M2 (non-atomic cap)** — the database-backed `increment_usage` RPC is now the authoritative compare-and-increment reservation boundary; a concurrent loser receives `usage_limit_reached` (429) and never invokes the model. The new service-role-only `release_usage` RPC compensates failed/aborted reservations atomically and cannot underflow.

Verification independently reproduced: focused P4B unit suites, typecheck, live-DB billing/reservation integration, P4A tool-RLS regression, RTL/i18n/parity gates, and direct SQL probing of the migration's authorization and guards.

---

## 2. Verification of Every Original Finding

| ID | Original issue | Status | Evidence (verified this pass) |
|---|---|---|---|
| **M1** | Failed/empty/aborted turn still counts usage + persists orphaned user message | ✅ Resolved | `route.ts:144-171` gates persistence/accounting on `!isAborted && !streamFailed && finishReason !== "error" && assistantText`; `onError` sets `streamFailed=true` (so the streamed error string cannot be mistaken for a valid answer); first turn virtual (`conversations.ts:157-159`); `recordAiTurn` removed repo-wide (grep: 0 refs). Tests assert release+no-persist for abort/model-error/tool-error and keep+persist for success (`p4b-chat-route.test.ts:183-260`). |
| **M2** | Usage cap check-then-increment (soft) | ✅ Resolved | `usage.ts:62-104` reserves via atomic `increment_usage` (`20260710130000...sql:211-227`, conditional `ON CONFLICT ... WHERE used+amt <= limit`); loser → `usage_limit_reached`. Live integration "prevents concurrent callers from overshooting the hard cap" passed (`p1b-billing-entitlements.test.ts:290`). |
| **L1** | Patient context clinic-scoped, not doctor-scoped | ✅ Resolved | `conversations.ts:148-154` enforces assigned-doctor-or-department scope; page also `notFound()`s a doctor outside scope (`patients/[id]/page.tsx:157-161`). Defense-in-depth at both layers. |
| **L2** | Patient-context mismatch returned 503 | ✅ Resolved | `conversations.ts:126-127` throws `invalid_patient_context`; `route.ts:177-183` maps it to **400 `invalid_request`**; infra/persistence stay 503. Test at `p4b-chat-route.test.ts:141-148`. |
| **L3** | History silently truncated at 40 | ✅ Resolved | `conversations.ts:56-69` fetches `HISTORY_LIMIT+1` sentinel and returns `truncated`; UI shows localized `historyTrimmed` notice (`assistant-chat.tsx:294-298`). |
| **L4** | `aria-live` wrapped entire scrolling list | ✅ Resolved | Live region removed from the message list; a single `sr-only role="status" aria-live="polite" aria-atomic` node announces thinking/ready only (`assistant-chat.tsx:239-241`). |
| **L5** | Client `remaining` drifts | ✅ Resolved | Local decrement removed; `onFinish` calls `router.refresh()` to pull the server-derived count (`assistant-chat.tsx:197-204`). Cross-tab staleness intentionally accepted (documented). |
| **L6** | Concurrent first-message → PK conflict → 503 | ✅ Resolved | `persistDoctorTurn` upserts with `onConflict:"id", ignoreDuplicates:true` then re-selects through owner/clinic/persona/status scope (`conversations.ts:171-199`). |

All eight are genuinely fixed in code, not merely documented. No finding was deferred.

---

## 3. New Findings

**None at Critical, High, or Medium severity.**

Two informational/Low observations, neither blocking:

- **INFO-1 — Reservation leak on abrupt termination (already disclosed).** If the server process dies after reserving but before release, or `release_usage` is unavailable, one unit stays consumed. This is **fail-closed** (reduces the clinic's own allowance; can never overshoot the cap) and is explicitly documented in `P4B_FIXES.md`. Closing it needs a durable reservation ledger — correctly out of P4B scope. Accepted.
- **INFO-2 — Latent default-period timezone mismatch (not triggered).** `release_usage`/`increment_usage` default `p_period_start := date_trunc('month', current_date)` uses the DB session timezone, whereas the app computes the UTC month (`YYYY-MM-01`). The route **always passes an explicit UTC `periodStart`** for both reserve and release, so the default is never exercised and reserve/release always agree. Pre-existing P1B pattern; no P4B defect. Worth a one-line note only if a future caller ever relies on the default.

---

## 4. Security & Tenant-Isolation Assessment

**Strong. No authorization or tenant-isolation defects.**

- **Identity is server-derived throughout.** `authorizeDoctorAssistant()` yields `clinicId`/`user.id`/`role`; the browser submits only the latest user message plus a client conversation UUID. `patientId` is advisory prompt context only and is independently validated (clinic + soft-delete + doctor scope), and `get_patient_summary` still enforces RLS doctor-scoping at the data layer.
- **Layered gate order** (route): auth/role/entitlement/subscription → rate limit → validation → **reserve** → history load → model. Cheap denials precede the reservation; the reservation precedes any model spend.
- **Fail-closed degradation:** `subscription_inactive`/`lookup_failed` deny at both the surface resolver and the route; rate-limit fail-open is acceptable because the usage cap (fail-closed on lookup error) remains the hard economic gate.
- **No service-role/admin client on the read path.** Conversation and tool reads use the RLS client; the only service-role calls are the audited `increment_usage`/`release_usage` billing RPCs.
- **P4A tool-RLS regression intact:** `p4a-ai-tools-rls.test.ts` + `p4a-authorization.test.ts` (25 tests) pass unchanged.

---

## 5. Database Migration Assessment — `release_usage`

Verified statically and by live probing (`docker exec ... psql`) against the running local DB.

| Requirement | Result | Evidence |
|---|---|---|
| Service-role-only access | ✅ | Grant is `service_role` only; `authenticated` and `anon` receive grant-level **"permission denied for function release_usage"** (live-tested). In-body `auth.role() = 'service_role'` check is additional defense-in-depth. |
| Correct tenant isolation | ✅ | `UPDATE ... WHERE clinic_id = p_clinic_id AND period_start = ... AND metric = ...`; only server code passes the authenticated user's `clinicId`. |
| Safe concurrent behavior | ✅ | Single atomic `UPDATE ... set used = greatest(used - p_amount, 0)`; no read-then-write. Live integration exercised reserve/compensate under contention. |
| No privilege escalation | ✅ | `SECURITY DEFINER`, `SET search_path = ''`, fully-qualified identifiers, owned by `postgres`. |
| No client-accessible compensation path | ✅ | Not callable by `authenticated`/`anon` (verified). `admin.ts:releaseClinicUsage` is the sole caller, behind the reviewed service-role boundary. |
| Correct rollback/release on failure & abort | ✅ | Route's `releaseReservation` closure is idempotent (`reservationActive` flag), invoked on abort/error/empty and in the outer catch; carries the original `periodStart` so a month-boundary turn compensates the correct month. |
| No underflow | ✅ | `greatest(used - p_amount, 0)`; `p_amount <= 0` rejected ("Usage release must be positive" — live-tested). |
| Database types accurate | ✅ | `types/database.ts:2914-2922` declares `release_usage` with matching `Args`/`Returns`; `pnpm typecheck` clean. |

The reservation authority itself (`increment_usage`) is a genuine atomic compare-and-increment (`ON CONFLICT ... DO UPDATE ... WHERE used+amount <= limit`, null-return → `USAGE_LIMIT_EXCEEDED`), which is what makes M2 a hard cap under concurrency.

---

## 6. Test & Validation Assessment

Independently re-run this pass (local Supabase running):

- Focused P4B unit (`route`, `conversations`, `surface`, `component`, `migration`): **5 files / 26 tests passed**.
- `pnpm typecheck` (`tsc --noEmit`): **passed**.
- Live-DB billing/reservation integration (`p1b-billing-entitlements.test.ts`): **9 passed** — includes atomic-reservation overshoot prevention and service-role/non-underflow `release_usage` coverage.
- P4A tool-RLS + authorization regression (`p4a-ai-tools-rls`, `p4a-authorization`): **25 passed**.
- Direct SQL probes: authenticated/anon denied at grant level; `service_role` amount=0 rejected; `SECURITY DEFINER` + service-role grant confirmed.
- Gates: `lint:rtl` (369 files, 10 exceptions), `lint:i18n` (292 files, 14 exceptions), i18n parity (2,570 messages) — **all pass**.

Coverage now includes the previously-missing failed-turn accounting path (abort/model-error/tool-error) and the patient-context-mismatch path. Adequate for the surface.

---

## 7. Scope-Compliance Assessment

**Compliant. No P4C/P5 or unrelated functionality introduced.**

- API surface is exactly `app/api/agent/chat/route.ts`. Only two P4 migrations exist (`p4a_ai_doctor_tools`, `p4b_ai_usage_reservation`).
- Tools mounted are the four read-only P4A doctor tools only (`check-availability`, `get-patient-summary`, `list-doctor-appointments`, `search-patient-visits`). No write/booking tools, no patient tools (`create_preliminary_booking`, `cancel_my_appointment`, `answer_clinic_faq`), no `suggest`/`auto` modes, no webhook/`agent-loop`, no `clinic_faq` content UI (grep: 0 refs).
- Assistant remains strictly read-only and staff-only (Admin/Doctor); Manager/Receptionist do not receive the page slug.
- Additive nav/permissions/i18n plumbing only; no behavior change to existing actions or routes.

---

## 8. Readiness Statement

**P4B is APPROVED and ready for the comprehensive Phase 4 review.** All original findings are resolved, the new compensation migration is secure and correct, tenant isolation and read-only guarantees hold, and no scope creep was introduced. The one remaining operational limitation (INFO-1) is fail-closed, honestly documented, and correctly deferred to a future durable-ledger effort — it does not block Phase 4.

---

## 9. File Reference Index

- `app/api/agent/chat/route.ts` — reserve/stream/compensate lifecycle (M1, M2, L2)
- `lib/ai/usage.ts` — `reserveAiTurn` / `releaseAiTurn` (M1, M2)
- `lib/ai/conversations.ts` — virtual first turn, doctor-scope validation, conflict-safe persistence (L1, L3, L6; M1)
- `lib/supabase/admin.ts:120-151` — `incrementClinicUsage` / `releaseClinicUsage` service-role boundary
- `supabase/migrations/20260718170000_p4b_ai_usage_reservation.sql` — `release_usage` RPC (§5)
- `supabase/migrations/20260710130000_p1b_atomic_billing_operations.sql:155-234` — `increment_usage` reservation authority (M2)
- `components/assistant/assistant-chat.tsx` — scoped live region, truncation notice, `router.refresh()` (L3, L4, L5)
- `types/database.ts:2914-2922` — `release_usage` type
- `tests/unit/api/p4b-chat-route.test.ts`, `tests/unit/ai/p4b-conversations.test.ts`, `tests/unit/db/p4b-ai-usage-reservation-migration.test.ts`, `tests/unit/integration/p1b-billing-entitlements.test.ts` — coverage
