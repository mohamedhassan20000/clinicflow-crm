# ClinicFlow Phase 8B Checkpoint

Date: 2026-07-27
Scope: Phase 8B only — "My Performance" (doctor's own operational performance)
Status: Complete; awaiting product approval

## Executive summary

Phase 8B is complete. It delivers **My Performance**, a doctor-oriented
operational report that is strictly distinct from the administrative clinic-wide
Doctor Performance report, exactly as specified in
`docs/ROLES_REPORTS_ASSISTANT_EXTENSION_PLAN.md` §8B.

A doctor sees only **their own sessions** — the appointments they are the
treating doctor for. This is a database-enforced property: the report is backed
by a dedicated `SECURITY INVOKER` RPC that reads the RLS-scoped
`appointments`/`follow_ups`, applies an explicit `doctor_id = auth.uid()`
predicate, and hard-denies every role except `doctor`. All KPIs are factual
system data (appointment lifecycle counts, follow-up completion, unique patients,
average patients per active day, and a completed-appointment trend); there are no
subjective or manually entered ratings. The report defaults **OFF for every
role** and is opt-in only, enabled per doctor by the primary admin through
Settings → Customize.

Phase 8C was **not** started. No Git operations were performed.

## What was implemented

### Database — `20260727160000_p8b_my_performance_rpc.sql`

- **`get_my_performance_summary(p_start timestamptz, p_end timestamptz)`** —
  `SECURITY INVOKER`, `search_path = public, pg_temp`. Computes the caller's own
  operational KPIs over `appointments` scheduled in range, joined to
  `follow_ups` for completion.
- **Scope = the caller's OWN sessions.** Unlike My Revenue (plain RLS scope),
  this RPC filters `doctor_id = auth.uid()` explicitly. A doctor's appointment
  RLS also admits appointments of their assigned/departmental patients that were
  booked under a *different* treating doctor; those are not "my performance", so
  the explicit predicate excludes them. No `p_doctor_id` parameter.
- **Role guard.** Every role except `doctor` is hard-denied with errcode
  `42501`. Admin/manager use the clinic-wide `get_doctor_performance_report`;
  assistants have no personal performance surface (their operational activity is
  measured under 8C).
- **KPIs.** `appointmentCount` (non-replaced), `completedCount`,
  `cancelledCount` + `cancellationRate`, `noShowCount` + `noShowRate`,
  `replacedCount` + `replacementRate` (the Phase 6 reschedule event, kept out of
  the cancellation/no-show denominators), `uniquePatients`, `activeDays`,
  `averagePatientsPerDay` (completed ÷ active days), `followupsEligible`,
  `followupsCompleted`, `followupCompletionRate`, `overdueFollowups`
  (completed appointments still awaiting a follow-up), `previousCompletedCount`,
  and `completedTrendPct` (completed vs the immediately preceding equal-length
  period — **null** when there is no prior baseline).
- **No financial data.** The RPC reads no payment columns and no
  settlement/deposit tables — it is operational only.
- Execute is revoked from `public` and granted only to `authenticated,
  service_role`.

### Types

- Hand-added the `get_my_performance_summary` function signature to
  `types/database.ts` per the minimal hand-addition policy (no wholesale local
  regeneration). No new tables/columns.
- `types/reports.ts` — `MyPerformanceSummaryReportResponse` (`completedTrendPct`
  is nullable to preserve "no prior baseline").

### Catalog and vocabulary

- `lib/ai/clinic-reports.ts` — new `my_performance` id in `CLINIC_REPORT_IDS`
  (ordered right after `my_revenue`), `CLINIC_REPORT_LABELS`, and
  `CLINIC_REPORTS` (`roles: ["doctor"]`, `financial: false`,
  `acceptsDoctor: false`, `href: "/reports/my-performance"`,
  `auditTable: "appointments"`).
- `lib/reports/catalog.ts` — new `REPORT_CATALOG.my_performance` entry:
  `pageRoles: ["doctor"]`, `financial: false`, `administrative: false`,
  `defaultVisibilityByRole` **OFF for every role**.

### Data and UI

- `lib/reports/data.ts` — `EMPTY_MY_PERFORMANCE`,
  `normalizeMyPerformanceSummary` (preserves a null trend), and
  `getMyPerformanceSummaryData(range)` (no doctor filter).
- `components/reports/my-performance-summary-report.tsx` — localized summary
  with lifecycle metric tiles (appointments, completed, cancellations + rate,
  no-shows + rate, replaced + rate) and two tables: operational (unique patients,
  active days, avg patients/day, completed vs previous period) and follow-ups
  (due, completed, completion rate, overdue). The trend renders "—" when there
  is no baseline.
- `components/reports/print-all-button.tsx` — added the `my-performance` print
  section so the report prints independently.
- `app/(protected)/reports/my-performance/page.tsx` — guarded by
  `requireReportAccess("my_performance")`, which enforces **both** gates: the
  doctor page-role guard + Reports-page-visible + report-visible. A hidden
  report is a `notFound()` (404) on direct URL. No cross-doctor filter is shown
  (scope-locked to self).

### Enforcement across every surface

- **Report index + discovery** — catalog-driven; the card and
  `getVisibleReportIds` pick up `my_performance` automatically, gated by per-user
  visibility. Icon added to `components/reports/reports-index.tsx`.
- **Settings → Customize / Report Permissions** — catalog-driven via
  `reportsOpenableByRole`; the primary admin can toggle My Performance per
  doctor. Default OFF.
- **AI navigation** — new `reports_my_performance` navigation target
  (`roles: ["doctor"]`, `reportId: "my_performance"`), so AI "take me to…"
  resolution honors both role and per-user visibility.
- **AI reporting tool** — a defensive `my_performance` definition is registered
  in `run_clinic_report`. That tool mounts only for administrative roles
  (admin/manager/receptionist) and its role gate is `["doctor"]`, so the report
  is never advertised-then-refused and is never runnable by a non-doctor. The
  doctor-facing surface is the report page + navigation.

### English/Arabic copy

- `reports.myPerformanceReport`, `reports.myPerformanceSummary`,
  `reports.yourOwnOperationalPerformance`, plus the metric labels
  `cancellations`, `uniquePatients`, `activeDays`, `averagePatientsPerDay`,
  `completedVsPreviousPeriod`, `followUps`, `followUpsDue`, `followUpsCompleted`,
  `followUpCompletionRate`, `overdueFollowUps`; `protected.myPerformanceReport`,
  `protected.metadataMyPerformanceReport`,
  `protected.yourOwnOperationalPerformance`.

## Product decisions

1. **Doctor-only.** My Performance is strictly `doctor` in both `pageRoles` and
   the RPC role guard. Admins/managers use the clinic-wide Doctor Performance
   report; assistants are excluded (their activity belongs to 8C). The plan left
   the assistant inclusion "to be decided; default doctor-only" — the default was
   taken.
2. **Own sessions, not RLS scope.** The RPC filters `doctor_id = auth.uid()`,
   giving a stricter guarantee than My Revenue's plain RLS scope, because a
   doctor's RLS admits appointments of their patients booked under other doctors.
3. **Default OFF for everyone.** Opt-in; the primary admin enables it per doctor.
4. **Factual KPIs only.** No composite/subjective score. `replaced` stays a
   distinct reschedule KPI, never folded into cancellations or no-shows.

## Validation results

| Validation | Result |
| --- | --- |
| `pnpm typecheck` | Passed |
| Production build | Passed; 69 static pages, `/reports/my-performance` route present |
| ESLint | Passed; 0 errors, 24 pre-existing warnings (none in new files) |
| `pnpm lint:rtl` | Passed; 447 files, 10 exceptions |
| `pnpm lint:i18n` | Passed; 316 files, 14 exceptions |
| `pnpm i18n:missing` | Passed; 2,964 base leaf messages |
| `pnpm i18n:unused` | Passed; no unused messages |
| Database lint | No new findings; the same four pre-existing warning sites remain (`get_my_performance_summary` adds none) |
| Clean local migration replay | Passed from an empty local database through `20260727160000` |
| `git diff --check` | Passed |

## Test results

| Test run | Result |
| --- | --- |
| Complete non-integration unit suite | 227 files; 1,648 tests passed |
| Complete live integration catalog | 31 files; 331 tests passed |
| New Phase 8B static migration contract | 8 tests passed |
| New Phase 8B live RLS suite | 9 tests passed |
| Report-catalog unit suite (updated for `my_performance`) | Passed |

The live Phase 8B suite proves: a doctor's own sessions yield the expected
lifecycle counts (4 appointments, 2 completed, 1 cancelled/25%, 1 no-show/25%);
an appointment the caller's RLS admits but that another doctor treated is
excluded; follow-up completion is derived from own completed appointments (1
completed, 1 overdue, 50% rate); average patients per active day is deterministic
(2 completed on one day → 2.0); the second doctor sees only their own two
completed sessions; a period with no prior baseline reports a null trend; clinic
B's data never appears in a clinic A scope; and admin, receptionist, assistant,
and anonymous callers are denied (`42501` for authenticated non-doctor roles).

## Files added

- `supabase/migrations/20260727160000_p8b_my_performance_rpc.sql`
- `app/(protected)/reports/my-performance/page.tsx`
- `components/reports/my-performance-summary-report.tsx`
- `tests/unit/db/p8b-my-performance-migration.test.ts`
- `tests/unit/integration/p8b-my-performance-rls.test.ts`
- `docs/reports/PHASE_8B_CHECKPOINT.md`

## Files modified

- `types/database.ts` — added `get_my_performance_summary` signature.
- `types/reports.ts` — added `MyPerformanceSummaryReportResponse`.
- `lib/reports/data.ts` — `EMPTY_MY_PERFORMANCE`, normalizer, fetch helper,
  `toNullableNumber`.
- `lib/reports/catalog.ts` — `my_performance` catalog entry + role constant.
- `lib/ai/clinic-reports.ts` — `my_performance` id/label/policy.
- `lib/ai/tools/run-clinic-report.ts` — defensive `my_performance` definition.
- `lib/ai/help/navigation.ts` — `reports_my_performance` navigation target.
- `components/reports/reports-index.tsx` — My Performance card icon.
- `components/reports/print-all-button.tsx` — `my-performance` print section.
- `messages/en.json`, `messages/ar.json` — My Performance copy + metric labels.
- `tests/unit/lib/report-catalog.test.ts` — coverage for the opt-in,
  doctor-only operational report.
- `docs/ROLES_REPORTS_ASSISTANT_EXTENSION_PLAN.md` — marked 8B checkpointed.

## How this relates to the remaining sub-phase

- **8C (My Assistant Performance)** remains deferred and was not started. It will
  draw actor-level operational KPIs from the Phase 8D activity trail, scoped to
  the assistants assigned to the viewing doctor. My Performance is independent of
  8C and needs only existing appointment/follow-up data.

## Known limitations

- KPIs are computed from present-state entity tables (appointments/follow-ups),
  which is authoritative for these operational totals. Actor-level attribution
  (who performed each action) is the 8D activity trail's domain and is out of
  8B scope.
- `activeDays` / `averagePatientsPerDay` bucket completed appointments by their
  UTC calendar day; clinic-timezone bucketing is deferred (the existing reports
  also anchor on `scheduled_at` without timezone normalization).
- The four pre-existing database-lint warning sites remain (unchanged by 8B).
- Local migration verified locally; production migration/deployment is out of
  this session's scope.

## Intentionally deferred

- Phase 8C (My Assistant Performance) was not started.
- No Git commit, push, merge, rebase, reset, or branch operation was performed.
