# Phase 4 — Comprehensive Review (P4A + P4B + integration)

**Scope:** The entire Phase 4 doctor AI assistant — P4A (AI foundation, doctor tools, per-tool authorization, audit; no UI) and P4B (streaming route, assistant page, patient-profile launcher) — reviewed as a whole, including their integration.
**Reviewer:** Claude Code (independent comprehensive review)
**Date:** 2026-07-18
**Plan reference:** `docs/AI_AGENT_PLAN.md` §6, §9, §10, §11, and the P4A/P4B execution split in §8
**Inputs read:** full `AI_AGENT_PLAN.md`; `docs/reports/P4A_IMPLEMENTATION.md`, `docs/reports/P4B_IMPLEMENTATION.md`; `docs/reviews/P4A_REVIEW.md` (incl. cycle-2 sign-off), `docs/reviews/P4B_REVIEW.md`, `docs/reviews/P4B_POST_FIX_REVIEW.md`; all P4 source and both P4 migrations.
**Method:** Every P4 source file and both migrations were read directly (not accepted on the reports' word). Validation gates were re-executed independently this pass.

> Note on referenced filenames: the prompt named `docs/reviews/P4A_POST_FIX_REVIEW.md`. That file does not exist under that name; the P4A sign-off lives as the **Cycle 2** section inside `docs/reviews/P4A_REVIEW.md`, which is what was reviewed. No content gap resulted.

---

## Final Verdict: **APPROVED**

Phase 4 is production-ready **as a whole, for its intended read-only scope**, and can be closed. Both sub-phase reviews (P4A PASS, cycle 2; P4B APPROVED, post-fix) are accurate — every claim I spot-checked against source held. No Critical, High, or Medium findings remain open. The remaining items are Low/informational and are either already documented as accepted or are operational go-live prerequisites (not code defects).

**Can Phase 4 be closed? Yes.** The v1 cut-line requirement ("P0–P4 with the manual WhatsApp inbox") is met on the AI-assistant side: a secure, tenant-isolated, entitlement-gated, audited, read-only doctor assistant with a bilingual streaming UI. No Phase 5 functionality has been introduced.

---

## Executive Summary

P4 upholds the plan's single most important security property — **the model is never trusted to self-restrict; authorization lives in code at the data layer (§9.1)** — at every layer I inspected:

- **Identity is always server-derived.** `authorizeDoctorAssistant()` resolves the user from the session; tools close over `ctx.user` captured at the surface boundary; `list_doctor_appointments` hard-binds `doctor_id = ctx.user.id` (never a model parameter); the browser submits only the latest user message plus a client conversation UUID.
- **Every tool reads exclusively through the RLS client** (`lib/supabase/server.ts`) — no service-role client on any read path. The only service-role calls are the audited billing RPCs (`increment_usage`/`release_usage`) and the audit RPC (`log_agent_tool_call`), each service-role-only at the privilege layer (EXECUTE revoked from `authenticated`/`anon`), `SECURITY DEFINER`, `SET search_path = ''`.
- **Defense-in-depth authorization** is re-asserted inside every tool via `assertDoctorToolAccess` (role + active subscription + `ai_assistant` entitlement) **before** an RLS client is created, and independently at the route (`authorizeDoctorAssistant` + reservation) — so a future surface cannot bypass the commercial/role gate.
- **Tenant + doctor-scope isolation** rests on the verified-strong `20260505220000`/`20260519006000` RLS policies; the tool-level patient-existence gate short-circuits to `{ found: false }` with no existence signal for out-of-scope patients, and patient-context conversations are additionally doctor-scope-validated (L1 fix).
- **PHI minimization** (`redact.ts`) drops raw DOB (→ age), national IDs / file numbers (≥7-digit runs), emails, and contact details before both the model boundary and the admin-readable audit summary.
- **AI usage accounting is a hard cap** under concurrency: `reserveAiTurn` claims a unit atomically via the compare-and-increment `increment_usage` before any model spend; failed/aborted/empty turns compensate via the atomic, non-underflowing, service-role-only `release_usage`; first turns stay virtual so a failed first turn orphans nothing.
- **Streaming lifecycle** is disciplined: `toUIMessageStreamResponse` with `originalMessages`, `abortSignal`, `consumeStream`, bounded by `MAX_AGENT_STEPS = 8` / `maxOutputTokens = 1500` / `temperature = 0.2`; errors convert to localized, content-free messages captured in Sentry with only `clinicId`/`conversationId` in `extra`.
- **Conversation persistence** is owner-scoped through the RLS client, conflict-safe (`onConflict:"id", ignoreDuplicates`), history-truncation-aware (40-message window with a UI notice), and never surfaces stack traces.
- **Scope discipline is clean.** Verified by search: no patient tools, no write/booking tools (`create_preliminary_booking`, `cancel_my_appointment`, `answer_clinic_faq`), no `agent-loop`, no patient prompt (`lib/ai/prompts/` holds only `doctor.ts`), no `suggest`/`auto` modes, no `clinic_faq` content UI, and no `insert/update/delete/upsert` in any tool. `clinic_faq` is schema-only with read-only RLS.

The gap between P4 and later phases is respected precisely, and the two prior review cycles closed all substantive findings (P4A-R1…R9; P4B M1, M2, L1–L6) in code, not merely on paper.

---

## Independent Validation (re-executed this pass)

| Gate | Command | Result |
|---|---|---|
| TypeScript | `pnpm typecheck` (`tsc --noEmit`) | ✅ Clean |
| P4 unit + component + migration suites | `vitest run tests/unit/ai tests/unit/api/p4b-chat-route… …p4b-assistant-chat… …p4b-ai-usage-reservation-migration…` | ✅ **56/56** passed (8 files) |
| ESLint (P4 change set) | `eslint lib/ai app/api/agent components/assistant lib/booking` | ✅ 0 errors |
| Scope discipline | grep for P5 markers / write ops / model calls in tools | ✅ None present |
| Integration wiring | `/assistant` middleware + page-permissions (admin/doctor only) + page `requireRole` guard | ✅ Correct |

The live-DB integration suites (`tests/unit/integration/p4a-ai-tools-rls.test.ts`, `p1b-billing-entitlements.test.ts`) were read and their assertions verified statically; they require a running local Supabase and were executed in the prior cycles (P4A: 15/15; P4B billing: 9/9) — not re-run here. Their static content matches the cited behavior.

---

## Aspect-by-aspect assessment

- **Correctness** — Tool cores are faithful (booking core extracted verbatim; `check_availability` shares `computeAvailableSlots`). Date-range filters convert clinic-local day bounds to UTC via `fromZonedTime` (P4A-R5 fix); elapsed same-day slots are dropped (P4A-R6 fix). ✅
- **Architecture** — Clean layering: route (transport/guards) → `doctor-agent` (assembly) → `tools` (data layer) → `conversations`/`usage`/`surface`/`entitlements`. Server owns identity and history; client is a thin `useChat` transport. ✅
- **Security / AuthN / AuthZ** — Layered and correct; identity never taken from model or body; denial matrix unit-tested (401/403/403/403/429/503). ✅
- **Tenant isolation & RLS** — All reads clinic-scoped through the RLS client; owner-scoped conversation policies with composite `(id, clinic_id)` FKs; doctor-scope enforced at both the data layer and patient-context validation. ✅
- **AI usage accounting** — Atomic reserve/compensate; hard cap under concurrency; no double counting; `recordAiTurn` fully removed (grep-confirmed absent). ✅
- **Streaming lifecycle** — Abort/error/empty all release the reservation and persist nothing; success persists exactly the user+assistant turn. ✅
- **Conversation persistence** — Owner-scoped, conflict-safe, truncation-aware; virtual first turn prevents orphan rows. ✅
- **Database migrations** — Two P4 migrations only; both hardened (service-role-only, `search_path=''`, fully-qualified, non-underflowing `release_usage`). Additive `types/database.ts`. ✅
- **Localization & RTL** — Server-resolved locale; bilingual prompts/errors/copy; logical-property CSS; mirrored send icon; `lint:rtl`/`lint:i18n`/parity reported green in both sub-phase cycles. ✅
- **Accessibility** — Scoped `sr-only role="status"` live region (L4 fix), `aria-label`s, min touch targets. ✅
- **Regressions** — Additive nav/permissions/i18n; booking-core extraction preserves the receptionist path; full suites green in prior cycles + 56 P4 tests green here. ✅
- **Test coverage** — Denial matrix, malformed/rate-limit/happy-path persistence+accounting, failed-turn accounting, patient-context mismatch, surface states, component rendering, navigation gating, Playwright happy path with mocked model, live tool→RLS cross-department denial. ✅ (LLM mocked throughout, per §10.)
- **Plan compliance (§6/§9/§11)** — Tool contracts rows 1–4, audit via `log_agent_tool_call`, entitlement + usage gating, model tiers through the AI Gateway, redaction, human-in-the-loop (read-only) all present and matching. ✅

---

## Findings

No Critical / High / Medium findings.

### Low / Informational (all pre-existing, accepted, or operational — none block closure)

- **INFO-1 (carried, accepted) — Reservation leak on abrupt process termination.** If the server dies after `reserveAiTurn` but before release, or `release_usage` is unavailable, one unit stays consumed. **Fail-closed** (reduces only the clinic's own allowance; can never overshoot the cap). Closing it needs a durable reservation ledger — correctly out of P4 scope and honestly documented in `P4B_FIXES.md`.
- **INFO-2 (carried) — Latent default-period timezone mismatch in `increment_usage`/`release_usage`.** The `date_trunc('month', current_date)` default uses the DB session TZ, but the route always passes an explicit UTC `periodStart` for both reserve and release, so the default is never exercised and the two always agree. No P4 defect; a one-line note for any future caller that relies on the default.
- **LOW-A (new, non-blocking) — Entitlement cache staleness window.** `getEntitlements` is cached (`unstable_cache`, 300s, tag-invalidated). If a clinic's `ai_assistant` entitlement or subscription is revoked out-of-band without a tag invalidation, the assistant surface/tools can remain reachable for up to ~5 minutes. This is the established P1B caching pattern (invalidated on subscription/override mutations), not introduced by P4; the hard usage cap and per-turn reservation are unaffected. Acceptable; noted only for the operator-action audit trail.
- **LOW-B (new, non-blocking) — Default model ids should be re-verified at go-live.** `client.ts` defaults to `anthropic/claude-sonnet-4.5` (doctor) / `anthropic/claude-haiku-4.5` (patient, reserved for P5). Both are env-overridable (`AI_MODEL_DOCTOR`/`AI_MODEL_PATIENT`), so this is configuration, not code — but the founder should confirm the current AI Gateway model catalog when enabling real traffic. Folds into the existing go-live checklist.
- **Cross-turn tool-result continuity (by design).** `toUiMessages` persists/replays only `user`/`assistant` text rows; prior tool calls are not re-sent to the model on later turns. Acceptable for a read-only summarizer (each turn re-runs tools as needed); noted so it is a conscious choice, not a surprise.

---

## Production-readiness caveats (operational, not code defects)

These are correctly disclosed in the implementation reports and remain **launch-gating operational prerequisites** before real clinical data flows through the model — they do not block closing Phase 4 as an engineering deliverable:

1. **AI Gateway credentials/configuration** must be provisioned (`AI_GATEWAY_API_KEY` / OIDC).
2. **DPA + zero-data-retention posture** with the model provider (§9.3) must be executed before real PHI is enabled. All automated tests mock the model; no patient/clinic content was sent externally during validation.
3. **Data-residency decision** for the Saudi market remains an open §13 question (pre-existing, not a P4 obligation).

---

## Scope compliance — no Phase 5 introduced (re-confirmed)

Verified by direct search across `lib/`, `app/`, `components/`:

- No patient tools, no write/booking tools, no `create_preliminary_booking` / `cancel_my_appointment` / `answer_clinic_faq`.
- No `agent-loop`, no webhook AI wiring, no `suggest`/`auto` modes, no `clinic_faq` content UI.
- `lib/ai/prompts/` contains only `doctor.ts`; no patient persona prompt.
- No `insert/update/delete/upsert` in any `lib/ai/tools/` file — read-only confirmed.
- `agent_persona`/`agent_message_role` enums reserve `patient`/`tool` values for P5 but no patient policy or tool exists.

---

## Phase 4 closure statement

**Phase 4 (P4A + P4B) is APPROVED and ready to be closed.** Tenant isolation, doctor-scope authorization, audit, redaction, entitlement/subscription gating, and the atomic usage cap are all enforced in code at the data layer and are proven by unit + live-RLS + integration tests. Streaming, persistence, localization/RTL, and accessibility meet the plan. Two P4 migrations, both hardened. No regressions, no scope creep, no Phase 5 code. The only outstanding items are the honestly-documented operational go-live prerequisites (Gateway credentials + DPA/ZDR) and Low/informational notes above, none of which block phase closure.

**Verdict: APPROVED — close Phase 4 and proceed to Phase 5 (P5A) per the roadmap.**
