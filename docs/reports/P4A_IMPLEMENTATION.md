# P4A Implementation Report — AI Foundation, Doctor Tools & Authorization

**Date:** 2026-07-18
**Branch:** `feat/p4a-ai-doctor-tools`
**Plan reference:** `docs/AI_AGENT_PLAN.md` §6 (6.1–6.7), §9.1/§9.3/§9.4, §11, P4A execution split (§8)
**Status:** Complete; ready for review
**Scope:** P4A only — no UI, no streaming route, no patient/write tools

## Outcome

P4A delivers everything security-critical about the doctor assistant with **zero UI**, so tool authorization gets its own undiluted review. Shipped:

- **`lib/ai/` foundation** — model-tier client config (`client.ts`, §11), doctor system prompts ar/en (`prompts/doctor.ts`, §6.5), PHI minimization (`redact.ts`, §9.3), injection/abuse primitives (`guardrails.ts`, §9.4), surface authorization (`authorization.ts`, §9.1/§6.7), usage gating (`usage.ts`, §6.7), and the audit boundary (`audit.ts`, §6.6).
- **Migration `20260718160000_p4a_ai_doctor_tools.sql`** — `agent_conversations` / `agent_messages` (owner-scoped chat state), `clinic_faq` (schema only; content UI + patient FAQ tool are P5), and the `log_agent_tool_call` SECURITY DEFINER audit RPC. All P4 schema lands here.
- **Callable booking core** — `lib/booking/availability.ts` (`computeAvailableSlots`) extracted verbatim from `getAvailableTimeSlots`; the receptionist action and the AI `check_availability` tool now share one implementation (§6.3).
- **Four read-only doctor tools** (§6.3 rows 1–4) — `get_patient_summary`, `search_patient_visits`, `list_doctor_appointments`, `check_availability`, each with a per-tool role re-check, RLS-client-only data access, and per-call audit.
- **Entitlement + usage wiring** — `ai_assistant` feature gate and `ai_messages` usage cap, reusing the P1B entitlements engine and `increment_usage` RPC (both already seed the `pro_ai` plan; no plan-catalog change was needed).

No write tools, no patient-facing anything, no streaming route, no chat page — those are P4B (UI) and P5A (patient/write tools).

## What was added

| Area | Files |
|---|---|
| AI foundation | `lib/ai/{client,errors,redact,guardrails,authorization,usage,audit}.ts`, `lib/ai/prompts/doctor.ts` |
| Doctor tools | `lib/ai/tools/{context,get-patient-summary,search-patient-visits,list-doctor-appointments,check-availability,index}.ts` |
| Booking core | `lib/booking/availability.ts` (+ `actions/time-slots.ts` refactored to reuse it) |
| Service boundary | `lib/supabase/admin.ts` → `logAgentToolCall()` (reviewed service-role wrapper) |
| Schema | `supabase/migrations/20260718160000_p4a_ai_doctor_tools.sql`; `types/database.ts` (additive) |
| Tests | `tests/unit/ai/p4a-{doctor-tools,foundation,authorization}.test.ts`, `tests/unit/integration/p4a-ai-tools-rls.test.ts` |
| Dependency | `ai@^6` (Vercel AI SDK) — provider-agnostic via the AI Gateway model strings |

## Key design decisions (for review)

1. **Authorization is enforced in code at the data layer, never by the model (§9.1).** Identity is resolved server-side (`authorizeDoctorAssistant()` at the surface boundary + a per-tool `assertDoctorRole()` re-check inside every `execute`). Every tool queries through the **RLS-respecting client** (`lib/supabase/server.ts`) — never the service-role client — so the doctor-scoping policies (`20260505220000`) and clinic policies filter at the database. A tool that summarizes an out-of-scope patient simply gets no row back and returns `{ found: false }` with no existence signal.

2. **`patient_id` is model-visible only where it is not PHI-bearing across scope.** `get_patient_summary` / `search_patient_visits` take a `patient_id`, but RLS is the backstop — the model cannot widen access with it. `list_doctor_appointments` takes **no** doctor parameter: the doctor's own id comes from the session (`ctx.user.id`), so the tool can only ever list the caller's schedule. `check_availability` accepts an optional `doctor_id` because availability is not patient PHI, defaulting to the caller when omitted.

3. **PHI minimization before the model boundary (§9.3).** `redact.ts` drops raw DOB (returns a computed age instead), national ids, file numbers, phone and email from tool outputs; note bodies are excerpted and run through `redactText` (emails → `[redacted-email]`, long digit runs → `[redacted-number]`). The audit summary (`toolAuditSummary`) carries only scoping params and counts — never note bodies or identifiers — so the admin-readable audit trail is safe.

4. **Audit is a service-role-only boundary that can never break a tool (§6.6).** `log_agent_tool_call` is SECURITY DEFINER, `SET search_path = ''`, and — beyond its internal `auth.role() = 'service_role'` guard — has EXECUTE **revoked from `authenticated`/`anon`** (stripping Supabase's ambient default-privilege grant), so "service-role only" holds at the privilege layer too. `logAgentTool()` redacts before crossing the boundary and captures failures to Sentry rather than throwing. Entries land in the existing `audit_logs` table as `agent_tool:<name>`, visible to clinic admins via `audit_logs_select_admin_manager`.

5. **Owner-scoped conversation state (§6.2).** `agent_conversations`/`agent_messages` are readable/writable only by their owner (`user_id = auth.uid()`, role in `{admin, doctor}`) within their clinic — a colleague, receptionist/manager, another clinic, and anon all see nothing. These owner policies **are** the persistence boundary for the P4B streaming route (which runs as the authenticated owner through the RLS client); there is no service-role write path for chat state. Composite `(id, clinic_id)` FKs (P3A precedent) anchor tenant integrity.

6. **One booking implementation (§6.3).** `computeAvailableSlots` is the extracted pure core (client + clinicId + doctorId + dateIso + timeZone in, slots out; no authorization of its own). `getAvailableTimeSlots` keeps its `requireRole` + timezone resolution and delegates; `check_availability` does its own auth + timezone resolution and delegates — so the agent can never invent availability.

7. **Provider-agnostic model tiers via the AI Gateway (§6.1/§11).** `client.ts` exposes plain `"anthropic/claude-…"` strings (doctor → Sonnet-tier, patient → Haiku 4.5, reserved for P5), routed through the Vercel AI Gateway for observability/fallback with no provider SDK imported. Defaults are env-overridable (`AI_MODEL_DOCTOR`/`AI_MODEL_PATIENT`) so a model rename is config, not code.

8. **Persona tool set is constructed in code, not by prompt (§9.4).** `buildDoctorTools()` mounts only the four read-only doctor tools; no write or patient tool is reachable. Guardrail primitives (untrusted-content wrapping, injection/emergency detection, ar/en) are defense-in-depth for the P4B route and the P6A adversarial corpus — the real guarantee is code-level tool selection + data-layer authorization.

## Types-file handling (reviewer note)

`types/database.ts` was updated **additively and surgically** (three tables, two enums, one function, in their alphabetical slots) rather than by wholesale `supabase gen types` regeneration: the local generator produces broad ordering/nullability churn that diverges from the committed remote-generated file and breaks unrelated call sites. The additions were extracted from a local regeneration, then hand-merged; the rest of the file is untouched.

## Tests & validation

- **Unit (`tests/unit/ai/`, 22 tests):** each tool's happy path, RLS-scoping assertions (every read filtered by session clinic id), redaction of identifiers in outputs, `list_doctor_appointments` bound to the session doctor id, `check_availability` returning only free slots from the shared core; cross-boundary denials (receptionist/manager roles rejected before any data access); out-of-scope patient leaks nothing; redaction/guardrail/client/prompt unit tests; surface authorization (unauthenticated, role_forbidden, feature_not_entitled, subscription_inactive).
- **Integration RLS (`tests/unit/integration/p4a-ai-tools-rls.test.ts`, 10 tests, live two-clinic fixture):** owner-only conversation/message reads; colleague, receptionist/manager, cross-clinic, and anon denials; owner-insert allowed while forged-owner / cross-clinic inserts are rejected by `WITH CHECK`; `clinic_faq` clinic-read but not authenticated-writable in P4A; `log_agent_tool_call` rejects a clinic user forging an entry, records a service-role call visible to the clinic admin but not to a doctor.
- **Full regression:** `tsc --noEmit` clean; `eslint .` 0 errors; RTL gate clean; `next build` succeeds; full unit suite **828 passed**; P4A unit **22 passed**; P4A integration **10 passed**.

## Out of scope (confirmed not built)

Streaming route `app/api/agent/chat/route.ts`, the `useChat` assistant page, and the patient-profile Sheet launcher (**P4B**); patient tools, write tools, `create_preliminary_booking`, DOB verification, FAQ content UI (**P5**); the adversarial/eval suites (**P6A**). No P4B or unrelated work was introduced.
