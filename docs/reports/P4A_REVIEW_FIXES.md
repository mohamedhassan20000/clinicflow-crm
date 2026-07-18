# P4A Review Fixes

**Date:** 2026-07-18  
**Scope:** P4A findings only (`P4A-R1` through `P4A-R9`) from `docs/reviews/P4A_REVIEW.md`  
**Final status:** All documented P4A findings resolved

## Finding resolution matrix

### P4A-R1 — Live tool-to-RLS cross-department acceptance coverage

- **What changed:** Extended the local-Supabase integration fixture with two doctors in different departments of the same clinic, department-scoped patients, appointments, and clinical notes. The suite now builds the exported doctor tool set and executes `get_patient_summary` and `search_patient_visits` with real signed-in Supabase clients. It proves doctor A receives no existence or clinical-data signal for doctor B's department patient, proves cross-clinic denial, proves receptionist/manager rejection at the tool boundary, and includes a positive control proving the matching-department doctor receives the seeded summary.
- **Affected files:** `tests/unit/integration/p4a-ai-tools-rls.test.ts`
- **Validation performed:** Focused live-RLS suite passed: 15/15 tests. The same suite also passed inside the complete integration run.
- **Final status:** Resolved

### P4A-R2 — Entitlement and usage-cap enforcement coverage

- **What changed:** Added a per-tool defense-in-depth check for role, active subscription, and the `ai_assistant` entitlement before any clinical RLS client is created. Usage remains enforced once per model turn, rather than once per tool invocation, because a single turn may invoke multiple tools. Added direct tests proving a tool rejects a missing entitlement before data access, the monthly cap throws `usage_limit_reached`, and post-turn counter failures are captured without failing an already-completed turn.
- **Affected files:** `lib/ai/authorization.ts`; `lib/ai/tools/get-patient-summary.ts`; `lib/ai/tools/search-patient-visits.ts`; `lib/ai/tools/list-doctor-appointments.ts`; `lib/ai/tools/check-availability.ts`; `tests/unit/ai/p4a-authorization.test.ts`; `tests/unit/ai/p4a-doctor-tools.test.ts`
- **Validation performed:** Focused P4A unit suite passed: 28/28 tests; full unit suite passed; typecheck and lint passed.
- **Final status:** Resolved

### P4A-R3 — Usage lookup failures misclassified as exhausted limits

- **What changed:** Added the distinct `lookup_failed` authorization reason. `assertAiTurnAllowed` now reports a temporary-unavailability error and records an error-level Sentry event instead of presenting an upgrade/cap message. Fail-closed behavior is unchanged.
- **Affected files:** `lib/ai/errors.ts`; `lib/ai/usage.ts`; `tests/unit/ai/p4a-authorization.test.ts`
- **Validation performed:** Unit coverage verifies the reason, safe message, and Sentry classification; focused and full unit suites passed.
- **Final status:** Resolved

### P4A-R4 — Seven- and eight-digit clinic file-number redaction

- **What changed:** Expanded numeric redaction to cover contiguous digit runs from seven digits upward while preserving the existing broader long/separated-number handling.
- **Affected files:** `lib/ai/redact.ts`; `tests/unit/ai/p4a-foundation.test.ts`
- **Validation performed:** Unit coverage now includes 7-, 8-, 10-, and 12-digit examples plus email redaction; focused and full unit suites passed.
- **Final status:** Resolved

### P4A-R5 — Clinic-timezone date boundaries

- **What changed:** Added shared clinic-timezone resolution and inclusive clinic-day-to-UTC conversion helpers. Appointment listing and patient-visit search now query with boundaries derived from the clinic timezone instead of hardcoded UTC midnight.
- **Affected files:** `lib/ai/tools/context.ts`; `lib/ai/tools/list-doctor-appointments.ts`; `lib/ai/tools/search-patient-visits.ts`; `tests/unit/ai/p4a-doctor-tools.test.ts`
- **Validation performed:** Unit assertions verify `Asia/Kuwait` day bounds for both tools; focused/full unit suites, typecheck, and build passed.
- **Final status:** Resolved

### P4A-R6 — Elapsed availability slots returned for today

- **What changed:** `check_availability` now compares the requested clinic-local date/time with the current instant and removes elapsed slots. Past dates return no available slots; future dates retain all otherwise-free slots. The shared receptionist booking core remains behavior-compatible.
- **Affected files:** `lib/ai/tools/context.ts`; `lib/ai/tools/check-availability.ts`; `tests/unit/ai/p4a-doctor-tools.test.ts`
- **Validation performed:** A deterministic clinic-time test proves that at 09:22 in `Asia/Kuwait`, only 09:30 and later slots are returned; focused/full unit suites passed.
- **Final status:** Resolved

### P4A-R7 — Redundant conversation foreign keys

- **What changed:** Removed the redundant single-column `user_id` and `patient_id` foreign keys from the uncommitted P4A migration and retained the composite tenant-integrity foreign keys. Generated database relationship metadata was aligned with the resulting schema.
- **Affected files:** `supabase/migrations/20260718160000_p4a_ai_doctor_tools.sql`; `types/database.ts`
- **Validation performed:** Typecheck, complete live integration suite, and production build passed.
- **Final status:** Resolved

### P4A-R8 — Missing AI environment documentation

- **What changed:** Documented optional doctor/patient model overrides and Vercel AI Gateway authentication. OIDC is identified as the Vercel/local-development default, with `AI_GATEWAY_API_KEY` documented only as the static-key fallback. No P4B model-call wiring was introduced.
- **Affected files:** `.env.example`
- **Validation performed:** Environment names match `lib/ai/client.ts`; production build passed with the repository's current environment.
- **Final status:** Resolved

### P4A-R9 — `ilike` wildcard passthrough

- **What changed:** Escaped backslash, `%`, and `_` before constructing the note-search `ilike` pattern, preserving literal search semantics while retaining parameterized PostgREST queries and RLS scoping.
- **Affected files:** `lib/ai/tools/search-patient-visits.ts`; `tests/unit/ai/p4a-doctor-tools.test.ts`
- **Validation performed:** Unit coverage verifies the exact escaped pattern together with clinic-local date bounds; focused/full unit suites passed.
- **Final status:** Resolved

## Final validation

- `pnpm exec vitest run tests/unit/ai --reporter=dot` — passed, 28/28 tests.
- `node --env-file=.env.local node_modules/vitest/vitest.mjs run tests/unit/integration/p4a-ai-tools-rls.test.ts --no-file-parallelism --reporter=verbose` — passed, 15/15 tests against local Supabase and real RLS.
- `pnpm test` — passed (all non-integration unit tests).
- Complete `tests/unit/integration` run with `.env.local` and `--no-file-parallelism` — passed against local Supabase.
- `pnpm typecheck` — passed.
- `pnpm lint` — passed with 0 errors; 26 pre-existing warnings outside the P4A change set.
- `pnpm lint:rtl` — passed; 360 files scanned and 10 documented exceptions.
- `pnpm build` — passed; Next.js 16.2.6 production build completed, including TypeScript and all 62 static pages.

## Scope confirmation

- No P4B route, UI, streaming, agent loop, patient tool, write tool, or later-phase functionality was added.
- Server-derived identity and RLS-respecting clinical reads remain unchanged.
- `docs/reviews/P4A_REVIEW.md` was not modified.
