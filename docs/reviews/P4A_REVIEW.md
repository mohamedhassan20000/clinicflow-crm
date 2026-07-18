# P4A Review — AI Foundation, Doctor Tools & Authorization

**Status:** PASS — signed off (cycle 2)
**Sub-phase:** P4A (`feat/p4a-ai-doctor-tools`)
**Review cycle:** 2
**Review date:** 2026-07-18
**Reviewer:** Claude Code (production-grade review against `docs/AI_AGENT_PLAN.md` §6, §9.1/§9.3/§9.4, §11, and the P4A execution split in §8)
**Verdict:** **PASS WITH FIXES** — no Critical/High findings; one Medium (a missing flagship test) and several Low findings to resolve before the phase is closed. Nothing blocks the *code* from merging, but the P4A acceptance criteria are not fully met until P4A-R1 is addressed.

This file is the authoritative handoff from Claude Code to Codex for the P4A review cycle. Re-reviews must read this file first, verify every checklist item, mark resolved items completed, keep unresolved items open, add new findings under new stable IDs, bump the review-cycle number, and append a dated re-review section. Prior findings must never be deleted.

---

## 1. Review scope

Reviewed the uncommitted working-tree implementation of **P4A only** — the security-critical, UI-free foundation of the doctor AI assistant — against the implementation plan, repository architecture, the existing P0–P3 tenant-isolation guarantees, and production SaaS quality. Findings were verified against `tsc --noEmit` (clean), `eslint` on the change set (clean), and the P4A unit suite (`vitest run tests/unit/ai/` — 22 passed). The live-DB integration suite (`tests/unit/integration/p4a-ai-tools-rls.test.ts`) was read but not executed here (requires a running local Supabase with `LOCAL_SUPABASE_*` keys); its assertions were reviewed statically.

**Files in the P4A change set:**

| File | Change |
|---|---|
| `lib/ai/client.ts` | New — model-tier config (doctor→Sonnet, patient→Haiku), env overrides, generation caps |
| `lib/ai/errors.ts` | New — typed `AiToolAuthorizationError` / `AiToolInputError` |
| `lib/ai/authorization.ts` | New — `authorizeDoctorAssistant()` surface guard + `assertDoctorRole()` per-tool re-check |
| `lib/ai/redact.ts` | New — PHI minimization (age-from-DOB, text redaction, audit-summary shaping) |
| `lib/ai/guardrails.ts` | New — untrusted-content wrapping, injection/emergency detectors |
| `lib/ai/usage.ts` | New — `assertAiTurnAllowed` / `recordAiTurn` usage-cap wiring |
| `lib/ai/audit.ts` | New — `logAgentTool()` redact-then-log boundary |
| `lib/ai/prompts/doctor.ts` | New — ar/en doctor system prompts |
| `lib/ai/tools/{context,get-patient-summary,search-patient-visits,list-doctor-appointments,check-availability,index}.ts` | New — the four read-only doctor tools + persona tool-set builder |
| `lib/booking/availability.ts` | New — `computeAvailableSlots` core extracted from `getAvailableTimeSlots` |
| `actions/time-slots.ts` | Refactored to delegate to the shared core (verbatim behavior) |
| `lib/supabase/admin.ts` | Added `logAgentToolCall()` reviewed service-role wrapper |
| `supabase/migrations/20260718160000_p4a_ai_doctor_tools.sql` | New — `agent_conversations`, `agent_messages`, `clinic_faq`, `log_agent_tool_call` RPC |
| `types/database.ts` | Additive — three tables, two enums, one function |
| `package.json` / `pnpm-lock.yaml` | Added `ai@^6` |
| `tests/unit/ai/*.test.ts`, `tests/unit/integration/p4a-ai-tools-rls.test.ts` | New — 22 unit + 10 integration tests |
| `docs/reports/P4A_IMPLEMENTATION.md` | New — implementation report |

---

## 2. Executive summary

P4A is a careful, security-first implementation. The single most important property the plan demands — **the model is never trusted to self-restrict; authorization lives in code at the data layer** (§9.1) — is genuinely upheld: every tool resolves identity from the server-side session (never from a model parameter), re-checks role, and reads exclusively through the RLS-respecting client (`lib/supabase/server.ts`). No tool touches the service-role client for data. I independently verified that the RLS backstop the tools lean on is real and strong: the doctor-scoping policies (`20260505220000`, `20260519006000`) restrict `patients`, `appointments`, and `medical_notes` to a doctor's own assigned/department patients within their clinic, so even a buggy tool cannot cross a clinic or doctor-scope boundary.

The booking-core extraction was verified line-by-line against `git show HEAD:actions/time-slots.ts` — `computeAvailableSlots` is a faithful, behavior-preserving lift, so the AI `check_availability` tool and the receptionist action now share exactly one implementation, as §6.3 requires. The audit RPC is service-role-only both at runtime (`auth.role() = 'service_role'` guard) and at the privilege layer (EXECUTE revoked from `authenticated`/`anon`), `SECURITY DEFINER` with `SET search_path = ''`. Conversation state is owner-scoped with composite tenant-integrity FKs. Redaction runs before both the model boundary and the audit boundary. No premature P4B/P5 work is present (verified: no streaming route, no assistant page, no patient/write tools, no `agent-loop`, no patient prompt).

The gap between "very good implementation" and "phase complete" is **testing depth**, not code. The plan names one flagship suite — *"doctor A cannot summarize doctor B's-department patient, asserting the `20260505220000` RLS scoping **through the tool**"* — and that specific end-to-end assertion is not present: the unit tests mock Supabase (so RLS is simulated, not exercised) and the live integration suite exercises table RLS directly but never drives the tools nor seeds cross-department clinical data. The underlying RLS is verified strong, so real-world risk is contained, but the acceptance criterion as written is not yet satisfied (P4A-R1).

---

## 3. Overall verdict

**PASS WITH FIXES.**

- **Blocks merge:** nothing. The code is correct, isolated, type-clean, lint-clean, and its unit tests pass.
- **Blocks phase closure:** **P4A-R1** (the flagship tool→RLS authorization test the plan explicitly calls "§10's most important suite"). It should be added before P4A is signed off as meeting its own acceptance criteria.

---

## 4. Findings

Severity legend: **Critical** (data leak / auth bypass / corruption, must fix now) · **High** (serious defect, fix before merge) · **Medium** (should fix before phase closure) · **Low** (polish / defense-in-depth / follow-up).

### P4A-R1 — MEDIUM — The plan's flagship tool-authorization test (cross-department denial *through the tool*) is not implemented

- **Affected:** `tests/unit/ai/p4a-doctor-tools.test.ts`, `tests/unit/integration/p4a-ai-tools-rls.test.ts`
- **Explanation:** The P4A execution split names the required suite unambiguously: *"the tool-authorization suite (§10's most important suite): doctor A cannot summarize doctor B's-department patient (asserting `20260505220000` scoping **through the tool**); every tool × persona × cross-boundary attempt."* What exists instead:
  - `p4a-doctor-tools.test.ts` drives each tool's `execute()` against a **mocked** Supabase client (`createServerActionMocks`). It asserts the tool *adds* a `.eq("clinic_id", …)` filter and that a `null` row yields `{ found: false }` — but the mock returns whatever the test injects, so the actual `20260505220000` doctor-department policy is never exercised. "RLS returns no row for an out-of-scope patient" is asserted by *assumption*, not by the database.
  - `p4a-ai-tools-rls.test.ts` exercises real RLS but only on the **new** tables (`agent_conversations`/`agent_messages`/`clinic_faq`/`log_agent_tool_call`). It never invokes `getPatientSummaryTool`/`searchPatientVisitsTool`, and it seeds no `patients`/`medical_notes`/`appointments` with two doctors in different departments — so the specific "doctor A cannot summarize doctor B's-department patient through `get_patient_summary`" path has no live-DB coverage.
- **Why it matters:** This is the exact seam where a future regression (a tool that forgets a filter, or a `createClient()` swapped for the admin client) would leak PHI cross-scope, and it is the one test the plan singled out as most important. The RLS policies are strong today (verified in §5), so the risk is latent, not active — hence Medium, not High — but the acceptance criterion is not met.
- **Recommended fix:** Add a live-DB case to the integration suite that seeds clinic A with two doctors in different departments and a patient assigned to doctor B's department, signs in as doctor A, builds the doctor tools with doctor A's authed context, invokes `get_patient_summary`/`search_patient_visits` for that patient, and asserts `{ found: false }` with no clinical rows — and a positive case where the department-matching doctor does get the summary. Repeat the cross-boundary matrix (receptionist/manager rejected pre-data-access; cross-clinic) through the tools, not only against the tables.

### P4A-R2 — LOW — Usage-cap and entitlement enforcement are provided but never exercised in P4A, and are not defense-in-depth at the tool layer

- **Affected:** `lib/ai/authorization.ts`, `lib/ai/usage.ts`, all four tools in `lib/ai/tools/`
- **Explanation:** `authorizeDoctorAssistant()` (entitlement + subscription gate) and `assertAiTurnAllowed()`/`recordAiTurn()` (usage cap + counter) are implemented but **called by nothing in P4A** — they are wired only in the P4B route that does not exist yet. The tools themselves re-check *role* (`assertDoctorRole`) but not the `ai_assistant` entitlement or the `ai_messages` usage cap. So the commercial gate and the cost cap (§6.7, a "Top-5 risk" in the plan — unit economics) rest entirely on the P4B surface remembering to call the surface authorizer; a tool invoked without that wrapper would still execute for any admin/doctor regardless of plan or usage. No P4A test proves the cap decrements or blocks in an integrated path.
- **Why it matters:** Defensible as a P4A/P4B split (P4A is "no route"), but it means P4A ships the *mechanism* with zero *enforced* call path, and there is no tool-level backstop for the entitlement the way there is for role. A single omission in P4B silently disables monetization gating and the cost ceiling.
- **Recommended fix:** (a) In the P4A test suite, add a direct unit test that `assertAiTurnAllowed` throws `usage_limit_reached` at the cap and that `recordAiTurn` swallows counter failures. (b) Consider a lightweight entitlement re-assert inside `buildDoctorTools`/each tool (or document explicitly that P4B MUST call `authorizeDoctorAssistant` + `assertAiTurnAllowed` before every model turn, and add a P4B review checklist item so it is not forgotten).

### P4A-R3 — LOW — A transient usage-lookup failure is reported to the user as "usage limit reached"

- **Affected:** `lib/ai/usage.ts:20-31` (`assertAiTurnAllowed`), `lib/entitlements.ts:166-183` (`checkUsageLimit` → `reason: "lookup_failed"`)
- **Explanation:** `checkUsageLimit` returns `reason: "lookup_failed"` (with `allowed:false`) when the `usage_counters` read errors or throws. `assertAiTurnAllowed` maps every non-`subscription_inactive` denial to `"usage_limit_reached"`. So a transient DB error surfaces to the doctor as "you've hit your AI limit — upgrade," and to telemetry as a cap event rather than an infrastructure error.
- **Why it matters:** Behavior is correctly **fail-closed** (safe), but the misclassification produces misleading UX and pollutes cost/usage signals with false cap hits. Low impact.
- **Recommended fix:** Add a distinct `lookup_failed` denial reason to `AiToolDenialReason` and surface it as a generic "temporarily unavailable, try again" rather than an upgrade prompt; capture it to Sentry as an error, not a cap.

### P4A-R4 — LOW — PHI redaction misses shorter clinic file numbers (7–8 digits)

- **Affected:** `lib/ai/redact.ts:16` (`LONG_DIGIT_RE = /\b\d[\d\s-]{7,}\d\b/g`)
- **Explanation:** The pattern requires at least 9 digits (leading digit + ≥7 + trailing digit). National IDs (10+ digits) are caught, but a 7- or 8-digit clinic **file number** — which the plan explicitly lists as a redaction target (§9.3) — passes through into both the model context and (via `redactText` in `toolAuditSummary`) potentially the audit summary of free-text params.
- **Why it matters:** This is defense-in-depth layered on top of a zero-data-retention provider agreement and RLS (the doctor is already authorized to see the note), so exposure is limited — Low. But it is a stated redaction goal not fully met.
- **Recommended fix:** Lower the digit-run threshold (e.g. `{4,}`) or add clinic-file-number-shaped handling, accepting that over-redaction of a summary is safe per the module's own comment.

### P4A-R5 — LOW — Tool date-range filters use hardcoded UTC day boundaries, not the clinic timezone

- **Affected:** `lib/ai/tools/list-doctor-appointments.ts:34-35`, `lib/ai/tools/search-patient-visits.ts:74-75,85-86`
- **Explanation:** These tools build day bounds as `${from}T00:00:00.000Z` … `${to}T23:59:59.999Z` — literal UTC. `computeAvailableSlots` (correctly) uses `fromZonedTime` with the clinic timezone, but the tool-level appointment/note filters do not. For a clinic in `Asia/Kuwait` (UTC+3) or `Africa/Cairo`, "2026-07-18" as the doctor means it, and the UTC window, differ by the offset, so appointments/notes near midnight can be wrongly included or excluded. This is the same class of server-vs-clinic-TZ inconsistency P0 set out to eliminate.
- **Why it matters:** Read-only, and scoped to the doctor's own data, so no cross-boundary risk — Low. But it can produce a subtly wrong "your appointments on X" answer.
- **Recommended fix:** Resolve the clinic timezone (as `check_availability` already does) and convert the inclusive `from`/`to` day bounds with `fromZonedTime` before querying.

### P4A-R6 — LOW — `check_availability` reports already-passed times as "available" for today

- **Affected:** `lib/ai/tools/check-availability.ts:60`, `lib/booking/availability.ts` (no past-time filtering)
- **Explanation:** The tool returns every slot where `!disabled`. `computeAvailableSlots` marks slots blocked only by appointments/breaks/windows — never by "already in the past." So for `date = today`, the assistant will list this morning's already-elapsed times as free. This matches the original `getAvailableTimeSlots` behavior (the receptionist UI presumably greys past slots itself), so it is not a regression — but an assistant answering in prose has no such UI and will state a falsehood.
- **Why it matters:** Low; P4A is read-only advice, and booking is P5. Worth fixing before the slot data feeds `create_preliminary_booking`.
- **Recommended fix:** In the tool (or an optional core flag), drop slots earlier than "now" in clinic time when the requested date is today.

### P4A-R7 — LOW / NIT — Redundant dual foreign keys on `agent_conversations.patient_id` and `.user_id`

- **Affected:** `supabase/migrations/20260718160000_p4a_ai_doctor_tools.sql:34-53`
- **Explanation:** `patient_id` carries both an inline single-column FK (`references public.patients(id) on delete set null`) and the composite tenant-integrity FK (`(patient_id, clinic_id) → patients(id, clinic_id) on delete set null (patient_id)`); likewise `user_id` has both a single-column and a composite FK to `profiles`. Both fire compatibly on delete, so this is harmless redundancy (and `types/database.ts` reflects all four relationships), but it is two constraints where one composite constraint expresses the full intent.
- **Why it matters:** Cosmetic — no correctness impact. Noted for schema cleanliness.
- **Recommended fix:** Optional — drop the redundant single-column FKs and keep the composite ones (the P3A tables can be checked for the same pattern for consistency). Not worth a migration on its own.

### P4A-R8 — LOW — New AI configuration is undocumented in `.env.example`

- **Affected:** `.env.example`
- **Explanation:** `client.ts` reads `AI_MODEL_DOCTOR` / `AI_MODEL_PATIENT`, and the AI Gateway model strings will need a gateway/provider credential at P4B when the first model call lands. None of these are documented. P4A makes no model call, so nothing is broken today.
- **Recommended fix:** Add `AI_MODEL_DOCTOR`, `AI_MODEL_PATIENT`, and the intended AI Gateway credential var(s) to `.env.example` with comments, so P4B has a documented surface. (Defer the actual key wiring to P4B.)

### P4A-R9 — LOW — `ilike` wildcard passthrough in `search_patient_visits`

- **Affected:** `lib/ai/tools/search-patient-visits.ts:71` (`.ilike("note", \`%${query}%\`)`)
- **Explanation:** The model/user-supplied `query` is interpolated into a `LIKE` pattern. Supabase parametrizes the value (no SQL injection), but `%` and `_` inside `query` act as wildcards, so a `query` of `%` matches all of that patient's notes. Access stays scoped to the already-authorized patient by RLS, so this is not a boundary issue — only a mild relevance/quality quirk.
- **Recommended fix:** Optional — escape `%` and `_` in `query` before building the pattern.

---

## 5. Positive observations (verified, not asserted)

- **Authorization at the data layer is real (§9.1).** Every tool: (1) takes identity from `ctx.user` captured server-side at the surface, never from a model parameter; (2) calls `assertDoctorRole` before any read; (3) queries only through `createClient()` (RLS). `list_doctor_appointments` hard-binds `doctor_id = ctx.user.id` (not a parameter). `patient_id` is model-visible only where RLS is the backstop, and the tools short-circuit to `{ found: false }` on an out-of-scope patient with no existence signal.
- **The RLS backstop the tools rely on is genuinely strong.** Independently confirmed `patients`, `appointments`, and `medical_notes` doctor-scoping (`20260505220000`, `20260519006000`): a doctor sees only assigned/own-department patients within their clinic, and the `get_patient_summary` patient-existence gate runs *before* the clinical `Promise.all`, so notes/follow-ups/packages are never queried for an invisible patient.
- **Booking core is a faithful extraction.** `computeAvailableSlots` verified line-by-line against `git show HEAD:actions/time-slots.ts` — behavior-preserving; the action now delegates. One booking implementation, as §6.3 requires.
- **Audit boundary is defense-in-depth done right (§6.6).** `log_agent_tool_call` is `SECURITY DEFINER`, `SET search_path = ''`, fully-qualified, guarded by `auth.role() = 'service_role'`, **and** has EXECUTE revoked from `public`/`authenticated`/`anon` — privilege-layer enforcement, not just a runtime check. The integration test proves a clinic user cannot forge an entry and that a real entry is admin-readable but doctor-invisible.
- **Redaction runs on both boundaries.** Raw DOB → computed age; emails/long digit runs stripped from note excerpts before the model sees them; `toolAuditSummary` keeps only scalar scoping params (objects/arrays dropped, strings truncated) so the admin-readable audit trail carries no note bodies or identifiers.
- **Owner-scoped conversation state with tenant integrity.** `agent_conversations`/`agent_messages` are readable/writable only by their owner (`user_id = auth.uid()` + admin/doctor role) within their clinic; composite `(id, clinic_id)` FKs anchor tenancy; no service-role write path exists. Integration tests prove colleague/receptionist/cross-clinic/anon denial and `WITH CHECK` rejection of forged-owner/cross-clinic inserts.
- **Persona tool set is built in code, not by prompt (§9.4).** `buildDoctorTools` mounts exactly the four read-only tools; no write/patient tool is reachable. The system prompt correctly frames itself as defense-in-depth ("prompts are data").
- **Clean engineering hygiene.** `tsc --noEmit` clean; `eslint` on the change set clean; 22 unit tests pass; `types/database.ts` updated additively (no churn); typed error taxonomy; `"server-only"` guards on server modules; provider-agnostic model strings with env overrides.
- **Scope discipline.** No P4B (route/UI/Sheet launcher) and no P5 (patient tools, write tools, `create_preliminary_booking`, DOB verification, FAQ content UI, `agent-loop`, patient prompts) work is present — confirmed by targeted search. `clinic_faq` is schema-only with read-only RLS, exactly as specified.

---

## 6. Roadmap-compliance check

| P4A requirement (§8 execution split) | Status |
|---|---|
| `lib/ai/` foundation (client/model tiers, doctor prompts ar/en, `redact.ts`, `guardrails.ts`) | ✅ Present |
| `agent_conversations`/`agent_messages` + `clinic_faq` (schema-only) migrations with RLS | ✅ Present, RLS verified |
| Callable booking core extracted into `lib/booking/`, shared with the action | ✅ Verified verbatim |
| Four doctor tools (§6.3 rows 1–4) with per-tool `requireRole` + RLS-client-only access | ✅ Present |
| `log_agent_tool_call` audit RPC (§6.6) | ✅ Present, hardened |
| Entitlement (`ai_assistant`) + usage-cap wiring (§6.7) | ⚠️ Provided but unexercised in P4A (P4A-R2) |
| Tool-authorization suite — cross-department denial **through the tool** | ❌ Not implemented as specified (P4A-R1) |
| Redaction unit tests | ✅ Present |
| Every tool call writes `audit_logs` | ✅ Present + tested |
| Deterministic mocked-LLM fixtures only | ✅ (LLM never invoked) |
| **Out of scope:** no UI/route, no patient/write tools | ✅ Confirmed absent |

**No premature P4B, P5, or later-phase work detected.**

---

## 7. Final release recommendation

**Merge-eligible with follow-ups.** The P4A code is production-quality for its scope: tenant isolation and doctor-scope authorization are enforced at the database through the RLS client, the audit and secret boundaries are hardened, redaction is in place, and there is zero scope bleed into P4B/P5. I recommend **merging the code** while tracking the findings above, with **P4A-R1 required before the P4A phase is signed off** as meeting its own acceptance criteria (it is the plan's designated most-important test and the only material gap). P4A-R2 through P4A-R9 are Low and can be scheduled as fast-follows or folded into P4B, except that **P4B's review must include an explicit checklist item** verifying the P4B route calls `authorizeDoctorAssistant` + `assertAiTurnAllowed` before every model turn and `recordAiTurn` after — since P4A ships that enforcement mechanism with no live call path.

**Verdict: PASS WITH FIXES.**

---

## Re-review — Cycle 2 (validation & sign-off)

**Review date:** 2026-07-18
**Reviewer:** Claude Code (validation pass against `docs/reviews/P4A_REVIEW.md` cycle 1 + `docs/reports/P4A_REVIEW_FIXES.md`, the P4A execution split in `docs/AI_AGENT_PLAN.md` §8, and §6/§9/§10/§11)
**Verdict:** **PASS — P4A is production-ready and signed off.**

This cycle re-read cycle-1 findings and the fixes report, re-inspected every changed source file, and independently executed the full validation matrix. No code was modified (no blocker found).

### Verdict

**PASS.** All nine cycle-1 findings (P4A-R1 → P4A-R9) are resolved in code and covered by tests. The plan's flagship acceptance criterion — cross-department denial **through the live tool execution path** — is now met. No regressions. No premature P4B/P5 work. P4A meets its own acceptance criteria and the production-security requirements of §9.

### Finding verification (P4A-R1 → P4A-R9)

| ID | Sev | Cycle-1 gap | Cycle-2 verification | Status |
|---|---|---|---|---|
| **P4A-R1** | Medium | Flagship tool→RLS cross-department test absent | `tests/unit/integration/p4a-ai-tools-rls.test.ts` now builds the **real** `buildDoctorTools` set and drives `get_patient_summary`/`search_patient_visits` through **live signed-in Supabase clients** (RLS decides). Verified live: doctor A gets `{ found: false }` + no clinical rows for doctor B's department patient; matching-department doctor gets the real summary (positive control incl. the seeded note excerpt + appointment); cross-clinic patient denied through both tools; receptionist/manager rejected at the tool boundary with `reason: "role_forbidden"`. **15/15 passed against local Supabase.** | ✅ Resolved |
| **P4A-R2** | Low | Entitlement/usage mechanism unexercised, no tool-level backstop | Every tool now calls `assertDoctorToolAccess` (role + active subscription + `ai_assistant` entitlement) **before** creating the RLS client (`get-patient-summary.ts:27`, `search-patient-visits.ts:50`, `list-doctor-appointments.ts:30`, `check-availability.ts:41`). Unit tests prove a missing entitlement rejects with `feature_not_entitled` before any query (`queryLog` empty, audit not called). Usage remains a per-turn concern (documented) — correct, since one turn may call several tools. | ✅ Resolved |
| **P4A-R3** | Low | Transient lookup failure shown as "limit reached" | `lookup_failed` added to `AiToolDenialReason`; `assertAiTurnAllowed` maps it to a temporary-unavailability message and an **error-level** Sentry event, not an upgrade/cap prompt. `checkUsageLimit` returns `lookup_failed` fail-closed on read error/throw. Unit-tested. | ✅ Resolved |
| **P4A-R4** | Low | 7–8-digit file numbers not redacted | `LONG_DIGIT_RE = /\b(?:\d{7,}|\d[\d\s-]{7,}\d)\b/g` now catches contiguous runs ≥7 digits. Foundation tests cover 7/8/10/12-digit + email cases. | ✅ Resolved |
| **P4A-R5** | Low | UTC day bounds instead of clinic TZ | `clinicDateRangeToUtc` + `resolveClinicTimeZone` (`context.ts`) convert inclusive day bounds via `fromZonedTime`; both `list_doctor_appointments` and `search_patient_visits` use them. Unit-verified `Asia/Kuwait` bounds (`2026-07-17T21:00:00.000Z` … `2026-07-18T20:59:59.999Z`). | ✅ Resolved |
| **P4A-R6** | Low | Elapsed slots returned for today | `omitElapsedClinicSlots` drops past clinic-local slots for today, returns `[]` for past dates, keeps all for future dates. Deterministic fake-timer test (09:22 `Asia/Kuwait` → only 09:30/09:45). | ✅ Resolved |
| **P4A-R7** | Low/Nit | Redundant dual FKs | Migration retains only the composite tenant-integrity FKs on `agent_conversations.user_id`/`.patient_id`; `types/database.ts` aligned. | ✅ Resolved |
| **P4A-R8** | Low | AI env undocumented | `.env.example` documents `AI_MODEL_DOCTOR`, `AI_MODEL_PATIENT`, and `AI_GATEWAY_API_KEY` (static-key fallback; OIDC default noted). Names match `lib/ai/client.ts`. No P4B model-call wiring introduced. | ✅ Resolved |
| **P4A-R9** | Low | `ilike` wildcard passthrough | `escapeIlikePattern` escapes `\`, `%`, `_` before building the pattern. Unit-verified exact escaped pattern `%100\%\_match\\literal%`. | ✅ Resolved |

### Validation results (independently executed this cycle)

| Gate | Command | Result |
|---|---|---|
| P4A unit suite | `vitest run tests/unit/ai` | ✅ **28/28** passed |
| Full unit suite | `pnpm test` (excludes integration) | ✅ **840/840** passed (151 files) |
| Live-RLS integration | `node --env-file=.env.local … p4a-ai-tools-rls.test.ts --no-file-parallelism` | ✅ **15/15** passed against local Supabase (migration confirmed applied) |
| TypeScript | `pnpm typecheck` (`tsc --noEmit`) | ✅ Clean |
| ESLint | `pnpm lint` | ✅ **0 errors**, 26 pre-existing warnings (all outside the P4A change set) |
| RTL gate | `pnpm lint:rtl` | ✅ Pass — 360 files scanned, 10 documented exceptions |
| Production build | `pnpm build` | ✅ Compiled in 7.6s; 62/62 static pages generated |

### Regression assessment

No regressions. The booking-core extraction still shares one implementation (`actions/time-slots.ts` delegates to `computeAvailableSlots`); the R5/R6 changes live in the AI tool/context layer and do not alter the receptionist path. The full 840-test suite and production build are green. Entitlement/role re-checks are additive guards that fail closed.

### Scope discipline (re-confirmed)

No P4B or P5 work present: no `app/api/agent/` route, no `app/(protected)/assistant/` page, no `lib/ai/agent-loop.ts`, no patient prompt (`lib/ai/prompts/` holds only `doctor.ts`), no patient/write tools, and **no model invocation** (`generateText`/`streamText`/`generateObject` absent from `lib/ai/`). `clinic_faq` remains schema-only with read-only RLS.

**Note (out of P4A scope, not a finding):** the working tree also carries unrelated P1.5B-era changes (`actions/operator.ts`, `app/(operator)/operator/invitations/page.tsx`, `components/operator/invitation-status-badge.tsx`, `messages/*.json`, `tests/unit/actions/p15b-invitation-email.test.ts`). None reference `lib/ai` or the agent surface; they were not part of this P4A validation and should be committed/reviewed on their own track.

### Final production-readiness assessment & phase sign-off

**P4A is production-ready and fully signed off.** Tenant isolation and doctor-scope authorization are enforced at the database through the RLS client and now proven end-to-end through the tools; the audit and secret boundaries are hardened; redaction covers the stated identifier classes; entitlement/role are re-asserted at every tool. The only carried-forward item is the **P4B review checklist obligation** (from cycle-1 §7): the P4B streaming route MUST call `authorizeDoctorAssistant` + `assertAiTurnAllowed` before every model turn and `recordAiTurn` after — this is a P4B gate, not a P4A defect.

**Verdict: PASS — sign off P4A and proceed to P4B.**
