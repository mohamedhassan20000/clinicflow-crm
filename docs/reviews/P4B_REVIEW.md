# P4B Review — Staff Assistant UI

**Sub-phase:** P4B — Staff assistant chat UI (streaming route, assistant page, patient-profile launcher)
**Branch scope reviewed:** uncommitted P4B working tree on `main`
**Reviewer:** Claude (production-grade review)
**Date:** 2026-07-18
**Plan reference:** `docs/AI_AGENT_PLAN.md` §6, §8 "P4 execution split → P4B"
**Implementation report:** `docs/reports/P4B_IMPLEMENTATION.md`

---

## 1. Executive Summary

P4B delivers the staff-facing surface for the read-only doctor assistant on top of the P4A foundation. It adds:

- an authenticated streaming route handler `app/api/agent/chat/route.ts` (AI SDK v6 `ToolLoopAgent` + `toUIMessageStreamResponse`),
- a bilingual `useChat` workspace at `app/(protected)/assistant/`,
- a patient-scoped `Sheet` launcher on the patient profile page,
- server-side surface access resolution (`lib/ai/surface.ts`), owner-scoped conversation persistence (`lib/ai/conversations.ts`), and the doctor agent assembly (`lib/ai/doctor-agent.ts`),
- navigation/permissions/i18n plumbing, and a focused unit + e2e test set.

The implementation is disciplined and matches the plan's intent closely. The security-critical decisions are correct: **the browser submits only the current user message**; conversation history is reloaded server-side through the RLS client; identity (clinic, actor) is server-derived and never model- or client-chosen; the route independently re-checks role → entitlement → subscription → rate limit → usage cap before invoking the model; and the four read-only P4A tools are the only tools mounted. No write tools, no patient-facing surface, and no authorization-policy changes were introduced — consistent with the P4B scope boundary.

Failure handling is safe: model/tool/stream/persistence errors are converted to localized, content-free messages and captured in Sentry without message text, tool payloads, or PHI. Degradation states (upgrade / cap-reached / inactive subscription / temporarily-unavailable) fail closed.

No Critical or High findings were identified. The findings below are correctness/robustness refinements (usage-accounting on failed turns, a check-then-increment race, and a handful of Low UX/a11y items). None block merge on their own.

### Verdict: **PASS WITH FIXES**

The Medium findings (M1 in particular) should be confirmed and addressed before real clinical traffic is enabled, but they do not represent tenant-isolation or authorization defects.

---

## 2. Scope & Plan Conformance

| Plan requirement (§6.2 / §8 P4B) | Status | Evidence |
|---|---|---|
| Streaming route `app/api/agent/chat/route.ts` | ✅ | route handler present, `maxDuration = 60`, AI SDK stream response |
| `useChat` UI at `app/(protected)/assistant/` (new gated `PageSlug`) | ✅ | `assistant/page.tsx`, `components/assistant/assistant-chat.tsx`, `lib/page-permissions.ts` slug `assistant` |
| Patient-profile `Sheet` launcher | ✅ | `patient-assistant-launcher.tsx`, integrated in `patients/[id]/page.tsx` |
| Gated by `hasFeature("ai_assistant")` + role | ✅ | `getDoctorAssistantSurfaceAccess`, `authorizeDoctorAssistant`, page `requireRole(["admin","doctor"])` |
| Graceful model/tool-error fallback + Sentry (no stack trace / no PHI) | ✅ | `onError`/catch blocks return localized strings; Sentry `extra` limited to `clinicId`/`conversationId` |
| Upgrade-gate + cap-degradation UX | ✅ | `assistant-access-gate.tsx` (upgrade / cap_reached / subscription_inactive / temporarily_unavailable) |
| No new tools / no authorization changes | ✅ | `buildDoctorTools` unchanged; only the four read-only P4A tools mounted |
| No migrations | ✅ | report + working tree confirm no P4B migration; reuses P4A `agent_conversations`/`agent_messages` |
| Route rejects non-entitled / role-blocked users | ✅ | `p4b-chat-route.test.ts` denial matrix (401/403/403/403/429/503) |
| Playwright staff-chat happy path w/ mocked model | ✅ | `tests/e2e/p4b-assistant.spec.ts` |

**Premature-scope check (P4C/P5+):** none found. No patient tools, no write/booking tools, no webhook/agent-loop wiring, no FAQ content UI, no `suggest`/`auto` modes. `check_availability` is mounted read-only as a P4A doctor tool (§6.3 permits it for staff) — not premature.

**Regression check:** the added `assistant` page slug, `/assistant` middleware entry, sidebar icon, and i18n keys are additive. Manager/receptionist do not receive the page (`lib/page-permissions.ts` role defaults). AI SDK bump (`ai ^6`, `@ai-sdk/react ^3`) is localized to the assistant surface. No behavior change to existing actions/routes was observed.

---

## 3. Findings by Severity

### Critical
None.

### High
None.

---

### Medium

#### M1 — A failed model/tool turn may still be counted against usage and persist the user message
**Files:** `app/api/agent/chat/route.ts:140-164`
The `onFinish` callback guards only `isAborted`. Model/tool failures surface through `onError` (which returns a localized error string), but in AI SDK v6 `onFinish` can still fire for a completed-with-error stream with `isAborted === false`. In that path the route will:
- call `persistDoctorTurn(...)`, inserting the **user** message (assistant text is empty, so no assistant row), and
- call `recordAiTurn(...)`, incrementing `usage_counters.ai_messages`.

Effect: a clinic can be charged a usage unit for a turn that produced no answer, and the stored history accumulates orphaned user messages with no assistant reply. This is a usage/billing-integrity and history-cleanliness concern (§6.7 counts turns that "the model call" completes; a failed generation arguably should not count).
**Recommended fix:** gate persistence/accounting on both `!isAborted` **and** a non-error finish (e.g. check `finishReason`/an error flag, or only persist when `assistantText` is non-empty *and* the stream did not error). Confirm the exact `onFinish` semantics for the installed `ai` version before choosing the guard.
**Verdict:** PLAUSIBLE (depends on AI SDK `onFinish`-on-error semantics — verify against `ai@^6.0.230`).

#### M2 — Usage cap is check-then-increment, not atomic
**Files:** `app/api/agent/chat/route.ts:80`, `lib/ai/usage.ts:20-60`
`assertAiTurnAllowed` reads the counter before the model call; `recordAiTurn` increments only at `onFinish`. Between the check and the increment, other concurrent turns for the same clinic pass the same pre-check. With the per-clinic rate limit at 30/min (`route.ts:69`), a clinic can overshoot its `ai_messages` cap by up to the in-flight concurrency. The cap is therefore soft.
**Recommended fix:** acceptable for a soft cost cap, but document it explicitly, or move to an atomic "reserve-on-start / reconcile-on-finish" pattern if the cap must be hard. At minimum, lower the practical overshoot by keeping the rate-limit window tight (already 30/min).
**Verdict:** CONFIRMED (design trade-off; low real-world impact given low doctor-tier volume).

---

### Low

#### L1 — Patient-context validation is clinic-scoped, not doctor-scoped
**Files:** `lib/ai/conversations.ts:124-135`, `app/api/agent/chat/route.ts:97-104`
`patientId` is client-submitted in the request body. `ensureDoctorConversation` validates it belongs to the clinic (and is not soft-deleted) but does not apply the doctor assignment/department scoping that `patients/[id]/page.tsx:161` enforces. A doctor could therefore open a conversation "about" a patient outside their scope. **No data is exposed** — the patient id is advisory prompt context, and `get_patient_summary` still enforces RLS doctor-scoping at the data layer, returning no rows for an unauthorized patient. This is a defense-in-depth gap, not a leak.
**Recommended fix (optional):** for cleanliness, reject a patient-context that the current doctor cannot access, mirroring the page's `doctorCanAccessPatient` check, so an empty-result "about this patient" conversation cannot be created.

#### L2 — Mismatched existing-conversation patient context returns 503 instead of a clear client error
**Files:** `lib/ai/conversations.ts:113-116`, `app/api/agent/chat/route.ts:168-174`
When an existing conversation's `patient_id` differs from the requested one, `ensureDoctorConversation` throws `conversation_unavailable`, which the route maps to `temporarily_unavailable` (503). This is a client/state inconsistency (a 4xx would be more accurate) and could pollute Sentry/observability as a transient server error.
**Recommended fix:** distinguish this reason and return a 400-class code (e.g. `invalid_request`).

#### L3 — Conversation history is silently truncated at 40 messages
**Files:** `lib/ai/conversations.ts:8,45-60`
`HISTORY_LIMIT = 40` loads only the most recent 40 messages (≈20 turns). For a long conversation, older context — including notes/dates the assistant previously cited — is dropped without any UI indication, which can make later citations appear unsupported. Acceptable for cost bounding; worth a note.
**Recommended fix (optional):** surface a "history trimmed" affordance or start-a-new-chat nudge when near the limit.

#### L4 — `aria-live="polite"` wraps the entire scrolling message list
**Files:** `components/assistant/assistant-chat.tsx:250-256`
The whole message container is a live region. During streaming (throttled at 40 ms) screen readers may announce partial/growing text repeatedly, and on initial load the full history may be announced. Consider scoping the live region to the in-progress assistant message / status line only.

#### L5 — Client-side `remaining` counter is cosmetic and can drift
**Files:** `components/assistant/assistant-chat.tsx:350-365`
`onTurnFinished` decrements a local `remaining` count; it is not reconciled with the server and can diverge (e.g. multiple tabs, failed turns under M1). The server usage cap is authoritative, so this is display-only, but the number shown to the user may be inaccurate.

#### L6 — Concurrent first-message on the same conversation id conflicts to 503
**Files:** `lib/ai/conversations.ts:137-152`
The client supplies the conversation UUID; two near-simultaneous first messages (e.g. duplicate submit / two tabs) both take the insert path and one fails the PK constraint, returning `conversation_unavailable` → 503. Edge case; an upsert/`ON CONFLICT DO NOTHING` + re-select would be more robust.

---

## 4. Aspect-by-Aspect Assessment

**Architecture** — Clean separation: route (transport/guards) → `doctor-agent` (agent assembly) → `tools` (P4A data layer) → `conversations`/`usage`/`surface` (persistence & gating). Server owns history and identity; the client is a thin `useChat` transport that sends only the latest message (`assistant-chat.tsx:160-167`). Good.

**Security / AuthN / AuthZ** — Layered and correct. `authorizeDoctorAssistant` (session + role + subscription + entitlement) at the route boundary; independent `assertAiTurnAllowed`; per-tool `assertDoctorToolAccess` inside each P4A tool; RLS client for all reads. Identity is never taken from the model or body. The denial matrix is unit-tested. No service-role/admin client is used on the read path (usage increment uses the P4A `incrementClinicUsage` RPC path). Strong.

**AI streaming** — Uses `toUIMessageStreamResponse` with `originalMessages`, `abortSignal: request.signal`, and `void result.consumeStream()` to decouple client backpressure from server-side persistence while still honoring explicit cancellation. `MAX_AGENT_STEPS = 8` and `maxOutputTokens: 1500`, `temperature: 0.2` bound cost and drift. See M1 for the error-path accounting caveat.

**Conversation persistence** — Owner-scoped (`clinic_id` + `user_id` + `persona` + `status`) reads/writes through the RLS client; created rows carry server-derived ids; title backfilled from first user message. Persistence failures are captured, never surfaced as stack traces. See L3 (truncation), L6 (insert race).

**Prompt safety** — `prompts/doctor.ts` explicitly instructs treating tool results / user content as untrusted data, refuses diagnosis/treatment/dosing, refuses out-of-scope patients, and refuses to reveal the system prompt/tools. Correctly framed as defense-in-depth; the real guarantee is tool-layer RLS. Patient-context injected into instructions with a "never display the internal id" directive (`doctor-agent.ts:27-29`).

**Context isolation between clinics** — Every conversation and tool read is `clinic_id`-scoped through the RLS client, and `ctx.user.clinicId` is server-derived. No cross-tenant path observed. Patient-context is clinic-validated (L1 notes the doctor-scope nuance, no leak).

**Rate limiting** — Per-clinic sliding window (30/60s) with `failureMode: "open"` and a `Retry-After` header. Fail-open is acceptable for an authenticated staff endpoint since the usage cap (fail-closed on lookup error) remains enforced.

**Usage accounting / subscription enforcement** — `checkUsageLimit`/`increment_usage` reused from P1B; `subscription_inactive` and `lookup_failed` fail closed at both surface and route. See M1 (failed-turn counting) and M2 (soft cap race).

**Error handling** — Comprehensive typed-error mapping (`AiToolAuthorizationError`, `AiConversationError`) to HTTP codes; localized user-facing copy; Sentry `extra` limited to ids. No PHI/message content in logs. Good.

**Arabic / RTL** — Locale resolved server-side (`getLocale()`), bilingual prompts and error strings, logical-property CSS (`ms-*`, `rounded-ee/es`, `text-start`, `-end-*`), send icon mirrored (`rtl:-scale-x-100`). `lint:rtl`/`lint:i18n`/i18n parity reported passing.

**Accessibility** — `aria-label`s on message roles, textarea, and icon buttons; skeleton `aria-busy`; suggestion buttons have min touch target (`min-h-11`). See L4 (live-region scope).

**Performance** — `experimental_throttle: 40`, streaming scroll uses `auto` while streaming and `smooth` otherwise, parallel page loads via `Promise.all`, agent step/token caps. Reasonable.

**React / Next.js** — Server Components resolve access before rendering; client component keyed by `session.id` to reset `useChat` on new chat; `useMemo` transport keyed by `patient?.id`; serializable server→client props. No obvious hook-dependency or boundary issues.

**Database interactions** — Reuses P4A schema; no new migration. All P4B queries filter by `clinic_id` (+ `user_id` for conversations) and order deterministically. No raw SQL, no admin client on reads.

**Tests** — Route denial matrix + malformed + rate-limit + happy-path persistence/accounting; surface access states; component prompt/gate rendering; navigation role gating; Playwright happy path with mocked model + real local Supabase. Coverage is appropriate for the surface. **Gap:** no test asserts the failed-model-turn accounting behavior (M1) or the patient-context-mismatch path (L2) — recommend adding once M1 is resolved.

**Edge cases** — Input hardening is good (`message.id` ≤200, ≤8 parts, `userText` ≤4000, strict zod). Remaining edge gaps are the Low items above.

**Maintainability** — Small, well-documented modules with clear ownership and section references to the plan. Typed UI message contract via `InferAgentUIMessage`. Good.

---

## 5. Production Readiness

**Overall: Ready to merge as PASS WITH FIXES.** The surface is secure, tenant-isolated, and read-only, and it does not overreach into later phases. Before enabling **real clinical traffic** (already flagged in the report's Known Limitations as requiring AI Gateway credentials + DPA/zero-retention posture), address:

1. **M1** — confirm and fix failed-turn usage accounting/persistence (highest-value fix; billing + history integrity).
2. **M2** — accept-and-document or harden the usage-cap race.
3. **L1/L2** — optional robustness/observability polish.

None of these are tenant-isolation or authorization defects, and none block the merge of the P4B surface itself.

---

## 6. File Reference Index

- `app/api/agent/chat/route.ts` — streaming route, guards, persistence/accounting (M1, M2, L2)
- `lib/ai/conversations.ts` — owner-scoped history/persistence (L1, L2, L3, L6)
- `lib/ai/doctor-agent.ts` — agent assembly, patient-context prompt injection
- `lib/ai/surface.ts` — surface access resolver (fail-closed)
- `lib/ai/authorization.ts` / `lib/ai/usage.ts` / `lib/ai/errors.ts` — P4A guards reused by P4B
- `lib/ai/client.ts` — model tiers, generation/step caps
- `lib/ai/prompts/doctor.ts` — bilingual, injection-aware system prompt
- `components/assistant/assistant-chat.tsx` — `useChat` client (L4, L5)
- `components/assistant/patient-assistant-launcher.tsx` / `assistant-access-gate.tsx` — Sheet + gates
- `app/(protected)/assistant/page.tsx` / `loading.tsx` — assistant page
- `app/(protected)/patients/[id]/page.tsx` — launcher integration (L1 context)
- `lib/page-permissions.ts` / `lib/supabase/middleware.ts` / `components/layout/sidebar.tsx` — nav/permissions
- `tests/unit/api/p4b-chat-route.test.ts`, `tests/unit/ai/p4b-surface-access.test.ts`, `tests/unit/components/p4b-assistant-chat.test.tsx`, `tests/e2e/p4b-assistant.spec.ts` — coverage
