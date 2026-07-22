# P4.8 — Comprehensive Review Fixes

**Date:** 2026-07-22  
**Branch:** `feat/p48a-ai-actions`  
**Source review:** `docs/reviews/P4.8_COMPREHENSIVE_REVIEW.md`  
**Approval follow-up:** `docs/reviews/P4.8_APPROVAL.md` — P48-L4  
**Status:** All three Medium and four Low findings remediated.  
**Scope:** P4.8 only. P4.9 and every later phase remain unstarted.

---

## 1. Outcome

All findings from the P4.8 comprehensive review are closed without changing the approved launcher architecture or introducing a new data-access path.

| Finding | Result | Remediation |
|---|---|---|
| P48-M1 — report-specific suggestion authorization | Fixed | Page context and the report tool now share one `ClinicReportId` vocabulary and policy. Capability hydration returns structured `allowedReportIds` from the same tool-mount permission resolution. Current-report prompts render only for an exact allowed id; otherwise the launcher states that the current report cannot be analyzed. |
| P48-M2 — filtered revenue accuracy | Fixed | The minimal honest P4.8 contract was selected. Revenue context now carries only the visible date range. Department/doctor page filters are rejected by the strict schema, are not serialized, and are explicitly described as unavailable to the assistant. Revenue and outstanding prompts state their clinic-wide date-range scope. |
| P48-M3 — launcher-session rate limiting | Fixed | The authenticated hydration route applies a dedicated 30-per-minute per-user-and-clinic limiter before parsing, returns `429` with `Retry-After`, and enforces a 2 KiB streaming body ceiling before materialization/resolution. Oversized requests return `413`. |
| P48-L1 — doctor-schedule context | Fixed | The context now identifies only the recurring weekday working-hours editor. It contains no doctor id or fabricated date range and exposes only the schedule-help suggestion. |
| P48-L2 — missing-schema behavior | Fixed | A short-lived cached readiness probe selects at most one id from each RLS-protected Assistant persistence table. Missing or unavailable schema silently omits launchers without loading history or capabilities. |
| P48-L3 — accessibility | Fixed | Deferred failure uses an assertive atomic alert and focuses the retry action. The capability panel's scroll region is now keyboard-focusable and named. Nested Sheet focus restoration and RTL placement are covered in a real browser. |
| P48-L4 — tests and documentation | Fixed | Added direct authorization, accuracy, abuse-control, missing-schema, accessibility, host-mapping, and browser scenarios. Corrected the stale live revenue fixture to the strict date-only request, made every valid non-patient row fail on a null parse, and now persist/reload each row as a general conversation with `patient_id = null`. Corrected the roadmap, architecture proposal, and implementation reports. |

## 2. Report authorization and shared vocabulary

`lib/ai/clinic-reports.ts` is the shared, client-safe policy module for:

- the six exact report ids, including `doctor_performance` and `receptionist_performance`;
- per-report roles, the financial marker, doctor-filter support, route, and audit table;
- `allowedClinicReports(role, { financialGranted })`.

`run_clinic_report` continues to own server-only execution and independently re-runs analytics or financial authorization on every invocation. `resolveToolMount` now returns the already-resolved permission set alongside its definitions. `resolveAssistantCapabilities` uses that same resolution to emit `allowedReportIds`; it does not create a second authorization decision.

The UI requires both `run_clinic_report` in `toolNames` and the exact page report in `allowedReportIds` before offering current-report prompts. The matrix covers:

- manager without the financial grant on `revenue`;
- manager on `followups`;
- receptionist on both performance reports;
- allowed receptionist `no_shows` behavior;
- both performance route-to-tool id mappings.

The general Reports launcher can remain visible for other allowed reports. When the current report is excluded, the UI explains the exact limitation and offers no current-report prompt.

## 3. Honest revenue and doctor-schedule contexts

The revenue context uses the review's minimal correction rather than extending P4.6 tools or RPCs. It carries `{ type: "revenue", dateRange }` only. The strict union rejects former `filters` input, the `/revenue` page does not serialize its department/doctor filters, and bilingual prompt/Sheet copy says that answers are clinic-wide within the shared date range.

The doctor-schedule context is `{ type: "doctor-schedule" }`. Its bilingual prompt describes the recurring working-hours editor, states that no doctor identity or appointment range is shared, and prevents selected-doctor implications. Suggestion generation returns only schedule help when `search_help` is mounted.

## 4. Hydration abuse controls and missing persistence

`POST /api/agent/launcher-session` preserves authentication as the first operation. After authentication and before JSON parsing or session resolution, it:

1. checks `assistant-launcher-session:{clinicId}:{userId}` with a 30-request, 60-second policy;
2. returns private no-store `429` responses with `Retry-After` when throttled;
3. rejects a declared or streamed body above 2,048 bytes with private no-store `413`;
4. parses the strict context only after both controls pass.

The limiter uses the same fail-soft backend policy as the existing staff chat limiter. Backend-unavailable behavior is explicit and tested; the launcher remains available, while a working backend enforces the dedicated key.

Page-time launcher resolution now also checks cached persistence readiness. This is a content-free schema signal, not conversation hydration: no conversation id, message, capability, patient label, or PHI is loaded or serialized. The first-open and chat boundaries still repeat their independent authorization and persistence checks.

## 5. Preserved platform guarantees

- Server-side authentication, source-page visibility, role, entitlement, subscription, usage, and personal-permission checks remain deny-by-default.
- Patient context is still independently re-authorized through clinic/doctor/RLS scope before history is read and again at chat/tool boundaries.
- Non-patient context still never enters tool-mount inputs or becomes persisted patient scope.
- Supabase RLS, clinic-scoped RPCs, tenant isolation, audit wrappers, and per-tool authorization remain authoritative.
- No service-role data path, schema migration, RLS policy, mutable tool, generic query surface, or PHI-bearing launcher payload was added.
- Opening a launcher still does not reserve a turn or bill model usage. The chat boundary retains atomic preparation, usage/budget limits, provider accounting, and success/failure/abort reconciliation.
- P4.9 customization schema, entitlement, settings UI, and per-user launcher overrides were not started.

## 6. Test coverage added or strengthened

- Exact role × report × financial-grant capability matrix and route/id mappings.
- Authorized current-report suggestions and explicit denied-current-report state.
- Strict rejection of unsupported revenue filters and fabricated schedule ranges.
- Date-only clinic-wide revenue prompt contract in English and Arabic.
- Recurring-hours-only doctor-schedule suggestions.
- Allowed hydration bursts, throttling, `Retry-After`, limiter-backend degradation, streaming/body-size rejection, and resolver non-invocation.
- Cached persistence readiness and missing-table failure behavior.
- Silent launcher omission when persistence is unavailable.
- Live parsing of the final `{ type: "revenue", dateRange }` clinic-wide context with an explicit assertion that no `filters` property survives or is supplied.
- Live persistence and exact-id reload of every valid non-patient context as a general conversation with `patient_id = null` and its persisted user turn intact.
- Asynchronous alert semantics and retry focus.
- Focusable capability-panel scroll region.
- English top-level launcher and Arabic/RTL nested launcher in Chromium, including focus restoration, logical inline-end placement, and Axe critical/serious checks.

## 7. P48-L4 live revenue-context correction

The live matrix in `tests/unit/integration/p4a-ai-tools-rls.test.ts` previously supplied the removed revenue `filters` property. The strict parser correctly returned `null`, but the test converted that null to a null patient binding and passed without inserting a conversation. It therefore did not exercise the final revenue request or the persistence behavior claimed by the implementation report.

The matrix now:

1. supplies the final date-only `{ type: "revenue", dateRange }` request and no removed or legacy field;
2. asserts the parsed value equals the submitted valid context, throws immediately if parsing returns `null`, and explicitly verifies the revenue result has no `filters` property;
3. derives the non-patient binding only after that non-null assertion;
4. calls `persistDoctorTurn` for a real user turn; and
5. reloads the same conversation id through `ensureDoctorConversation`, asserting the exact id, `patientId: null`, and persisted message content.

The same parse/persist/reload invariant now applies to every valid non-patient matrix row. The appointments row was also made independently valid by omitting an optional doctor id that had been captured before live user setup. Any future parser rejection, missing insert, wrong patient binding, or reload mismatch now fails the live test. No production behavior changed.

## 8. P48-L4 follow-up validation

| Check | Result |
|---|---|
| Focused live revenue-context integration test | Pass — 1 file, 28 tests |
| Full unit suite (`pnpm test`) | Pass — 193 files, 1,420 tests |
| Integration/RLS suite (`pnpm test:integration`) | Pass — 23 files, 245 tests against local Supabase |
| Typecheck (`pnpm typecheck`) | Pass |
| Lint (`pnpm lint`) | Pass — 0 errors, 25 pre-existing warnings |
| i18n hardcoded-string gate (`pnpm lint:i18n`) | Pass — 302 files, 14 documented exceptions |
| Message parity (`pnpm i18n:missing`) | Pass — 2,785 base leaf messages |
| Unused messages (`pnpm i18n:unused`) | Pass |
| RTL validation (`pnpm lint:rtl`) | Pass — 420 files, 10 documented exceptions |
| Production build (`pnpm build`) | Pass — Next.js 16.2.6, 66 static pages generated |
| Whitespace (`git diff --check`) | Pass |

The first focused integration invocation collected no tests because local Supabase keys were not exported. The focused file and complete suite were rerun with CLI-derived local-stack variables supplied only to those processes; no credentials were printed or stored, and both passed.

The production build emits only the repository's existing middleware-to-proxy deprecation notice.

## 9. Final status

P48-M1 through P48-M3 and P48-L1 through P48-L4 are remediated. P4.8 remains read-only, advisory, tenant-isolated, billing-safe, and within the approved architecture. Review documents were not modified. P4.9 has not started.
