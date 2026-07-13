# Pre-P2 WS7 Review — Operator Report Filters, URL State, Pagination, Sorting, and Exports

**Status:** IMPLEMENTED — awaiting comprehensive review
**Workstream:** WS7 (`docs/PRE_P2_POLISH.md` §7-WS7)
**Date:** 2026-07-13
**Implementer:** Codex

---

## 1. Current-state audit and evidence

Before implementation, the current branch, complete working-tree status, and full diff were
inspected. The dirty tree contained the preserved, uncommitted WS0–WS6 implementation and
review material. No existing change was discarded, overwritten, staged, or rewritten.

The existing operator Reports module had seven registered reports, but each registry query
returned a fixed in-memory result (normally through a `limit(1000)` path), the report shell
had no per-report filters or sortable/paginated table state, and the CSV route called the
same unfiltered query regardless of its URL. There was no shared parser for malformed report
query parameters, no filtered-empty distinction, and no report loading skeleton.

The approved matrix and constraints were taken directly from
`docs/PRE_P2_POLISH.md:195-207`, with the shared table and return-URL patterns from WS2 and
WS6 preserved. Local PostgREST was also probed for inline aggregates; it returned `PGRST123`
(`Use of aggregate functions is not allowed`). That evidence ruled out relying on an
environment-specific aggregate query and, because WS7 did not approve a new report RPC or
view, no schema object was introduced.

## 2. Problems identified

- Report URLs did not own filter, sort, page, or page-size state, so report views were not
  refresh-stable or shareable.
- The fixed 1,000-row materialization could not provide correct global pagination, sorting,
  or exports above its cap.
- Exports ignored active URL filters and pagination semantics.
- Invalid dates, enums, sort keys, directions, and page values had no single fail-safe
  boundary before reaching query code.
- The old shell did not distinguish a platform with no report data from filters with no
  matches and had no loading route.
- Users and Growth require aggregates, but the deployed-compatible PostgREST configuration
  rejects aggregate functions; unbounded client or server materialization was unacceptable.
- Filter sets needed to be report-specific. Usage-metric and entitlement filters would have
  been meaningless because no current approved operator report exposes those dimensions.

## 3. Implementation completed

- `lib/operator-reports/types.ts:97` now provides the shared Zod parsing boundary. Missing
  values use documented rolling defaults, explicit empty range values remain a shareable
  all-time state, and malformed values fall back safely. URL serialization and real
  clear-filter state are at `lib/operator-reports/types.ts:160` and `:178`.
- `lib/operator-reports/registry.ts:605-768` declares only the approved filters, defaults,
  and sorts for all seven reports. Direct reports use filtered exact counts and database
  ranges through `fetchDirectReport` (`:144`); derived aggregate reports use bounded source
  inputs and global post-aggregate pagination through `paginateDerived` (`:197`).
- `lib/supabase/admin.ts:162` adds the metadata-only Clinics report boundary. The Users and
  Growth aggregate sources are chunked and capped at 10,000 rows at `:187`, `:225`, and
  `:261`; they return a truncation signal rather than silently presenting a bounded sample
  as complete.
- `components/operator/report-shell.tsx:32-246` implements URL-preserving filter forms,
  accessible sortable headers, 25/50/100 page sizes, page links constrained by active
  filters, filtered-empty and no-data states, cap warnings, and filtered export links. URL
  value keys force uncontrolled inputs to synchronize after client-side Clear/Back state.
- `components/operator/report-filter-combobox.tsx:18` reuses the cmdk/popover combobox
  interaction while remaining compatible with a GET form through a hidden input.
- `components/shared/data-table.tsx:65` adds optional declarative `aria-sort` support to the
  WS2 table primitive; it is emitted on the column header at `:109`.
- `app/(operator)/operator/reports/[reportId]/page.tsx:24-30` parses the URL once, loads rows
  and bounded filter options in parallel, clamps out-of-range pages, and retains the WS6
  report-hub return URL.
- `app/(operator)/operator/reports/[reportId]/loading.tsx:4` adds a report-shaped loading
  state. `app/(operator)/operator/reports/[reportId]/export/route.ts:10-30` parses the same
  URL state as the page, emits a private/no-store CSV response, chunks the bounded payload,
  and exposes limit/truncation response headers.
- CSV cells retain formula-injection hardening in `lib/operator-reports/types.ts:198`.
- No WS8 work, migration, schema change, tenant report change, billing/subscription semantic
  change, localization work, or new index was introduced.

## 4. Report-by-report filter matrix

| Report | Supported filters | Default state | Sorts | Query shape |
|---|---|---|---|---|
| Clinics | country; onboarding state; created-from/to | all countries, all onboarding, last 90 days | created desc; clinic; country | DB filters + exact count + range |
| Users | clinic; latest-signup-from/to | all clinics, all time | user count desc; latest signup; clinic | bounded metadata-only aggregation |
| Invitations | status; accepted clinic; created-from/to; email-sent yes/no | pending, all clinics, last 30 days, any email state | created desc/asc | DB filters + exact count + range |
| Revenue | plan; subscription status; renewal-from/to | all plans, active + trialing, any renewal date | period end asc/desc | DB filters + exact count + range; canonical USD plan value |
| Subscriptions | status; provider; plan; trial-ending-from/to | all | period end or trial end | DB filters + exact count + range; any trial window forces `trialing` |
| Activity | exact action; exact target type; created-from/to | all actions/targets, last 7 days | time desc/asc | DB filters + exact count + range |
| Growth | month-from/to | last 12 months | month asc/desc; new-clinic count | date-filtered bounded month aggregation |

No report received a usage-metric or feature-entitlement filter because those dimensions do
not exist in the approved aggregate report shapes. There is no universal filter set.

## 5. URL-state, sorting, and pagination behavior

- Every filter key, sort key, direction, page size, and page is serialized into the report
  URL. Explicit empty date/month values are retained so Clear filters does not silently
  restore a rolling default on refresh.
- Missing parameters use report defaults; invalid enum/date/month/sort/direction/page values
  safely use defaults. Inverted ranges reset to the report's safe documented range and page
  1. A trial-ending window normalizes subscription status to `trialing`.
- Applying or clearing filters resets page to 1. Sorting resets page to 1 while retaining all
  active filters and page size. Page-size changes reset page to 1. Previous/Next links retain
  filters and sorting, and a requested page above the filtered result is clamped to the last
  valid page.
- The default page size is 25; supported choices are 25, 50, and 100. Sorting is global to
  the filtered result, not per-page.
- The report page retains the WS6 validated return path to the Reports hub. There are no
  separate operator report-detail routes, so detail-to-list restoration is not applicable.

## 6. Export behavior

All seven approved CSV exports parse and execute the same filter and sort state as the page.
Pagination and page size are intentionally omitted from the export link, so the export
contains all matching rows in global sort order up to the 10,000-row safety cap. The route
returns `cache-control: private, no-store`, `x-report-export-limit: 10000`, and an explicit
`x-report-export-truncated` flag. CSV columns exactly match visible approved columns; row
identifiers used internally for React keys are not exported. Formula-like cell values are
apostrophe-prefixed before CSV escaping.

The integration suite compares page and export fixtures for Clinics, Users, Invitations,
Revenue, Subscriptions, Activity, and Growth (`tests/unit/integration/ws7-operator-reports.test.ts:105-265`).

## 7. Security, authorization, and no-PHI verification

- Every report query starts with `requirePlatformAdmin()` at
  `lib/operator-reports/registry.ts:231`, `:320`, `:367`, `:421`, `:468`, `:519`, and `:564`.
  Dynamic filter-option loading separately re-guards at `:772`; the export route reaches the
  same guarded query boundary.
- Service-role helpers remain in `lib/supabase/admin.ts`, are server-only, and are called only
  after the platform-admin guard. Existing RLS and tenant RBAC were not changed.
- Clinics exposes clinic metadata only. Users exposes clinic id/name, count, and latest
  signup timestamp; profile names, emails, phones, auth data, and roles are never selected.
  Invitations excludes owner name, email, phone, token, and token hash. Activity excludes
  actor identity and JSON details. Revenue/Subscriptions expose subscription metadata and
  canonical plan values only. Growth is month/count only.
- `tests/unit/integration/ws7-operator-reports.test.ts:130` asserts the aggregate Users shape
  has no profile PII; `:228` asserts Activity excludes details; `:267` rejects every report
  and filter-option path when the platform-admin guard fails before a server query is made.
- The browser CSV assertion at `tests/e2e/smoke.spec.ts:572` rejects patient, national-id,
  medical-note, phone, and email column/content markers.
- Full integration coverage retained all existing platform authorization, RLS, export, and
  analytics security suites: 11 files and 77 tests passed.

## 8. Performance considerations

- Clinics, Invitations, Revenue, Subscriptions, and Activity apply filters and ordering in
  Postgres, request an exact filtered count, and fetch only the active page. CSV export reads
  filtered rows in 1,000-row chunks and stops at 10,000.
- Growth applies its month range before fetching timestamps. Users applies the clinic
  predicate before fetching. Because PostgREST aggregates are disabled (`PGRST123`), those
  two reports aggregate only reviewed metadata inside a hard 10,000-row source ceiling and
  show a visible incompleteness warning if reached.
- Clinic/country combobox source loading is bounded to 500 sorted clinic metadata rows;
  plans come from the small platform plan catalog. No patient or clinical dataset is sent to
  a client filter control.
- Existing relevant indexes were confirmed in migrations: invitation status/created,
  subscription plan/status and trial-ending, profile clinic, and audit created indexes. No
  new index was justified: the production-server Playwright gate measured authenticated,
  filtered Clinics page-render p95 at **73.8 ms** over 20 requests, below the 1-second gate.
- No `EXPLAIN`-driven evidence justified an additive index, so no optional migration was
  created.

## 9. Regression tests

- `tests/unit/lib/ws7-operator-report-params.test.ts:16-140` — exact filter matrix, rolling
  defaults, invalid fallback, inverted ranges, trial normalization, explicit empty/all-time
  state, URL round-trip, sorting/pagination state, and real clear-filter URLs.
- `tests/unit/components/operator-report-shell.test.tsx:21-79` — URL-owned controls,
  accessible sort state, filtered export URL, pagination, result counts, and both empty-state
  variants.
- `tests/unit/integration/ws7-operator-reports.test.ts:105-291` — DB filtering before
  pagination, global sorting, every report's page/export agreement, canonical Revenue values,
  trial semantics, no-PII/no-details assertions, and authorization rejection for all seven
  query paths plus dynamic options.
- `tests/e2e/smoke.spec.ts:572` — authenticated operator filter selection, explicit all-time
  dates, URL persistence across refresh, sort state, page reset, filtered/no-PHI CSV, Clear
  filter UI synchronization, and production-server p95.

## 10. Validation commands and exact results

| Command | Exact result |
|---|---|
| `pnpm exec vitest run tests/unit/lib/ws7-operator-report-params.test.ts tests/unit/components/operator-report-shell.test.tsx tests/unit/lib/p15b-report-registry.test.ts` | **PASS** — 3 files, 12 tests; final targeted run 1.17s |
| `node --env-file=.env.local node_modules/vitest/vitest.mjs run tests/unit/integration/ws7-operator-reports.test.ts --no-file-parallelism` | **PASS** — 1 file, 8 tests; 1.23s |
| `pnpm test` | **PASS** — 91 files, 487 tests; final run 21.92s |
| `node --env-file=.env.local node_modules/vitest/vitest.mjs run tests/unit/integration --no-file-parallelism` | **PASS** — 11 files, 77 tests; final run 10.39s |
| `pnpm typecheck` | **PASS** — exit 0, no diagnostics |
| `pnpm lint` | **PASS WITH WARNINGS** — exit 0, 0 errors, 4 pre-existing warnings (`dashboard/page.tsx`, `record-dialog.tsx`, `patient-form.tsx`, `department-form.tsx`) |
| `pnpm build` | **PASS** — Next.js 16.2.6 production build; compiled in 5.0s, TypeScript in 7.3s, 48/48 static pages generated; known middleware-to-proxy deprecation warning |
| `PORT=3103 node --env-file=.env.local node_modules/@playwright/test/cli.js test --workers=1 --grep "WS7 operator report"` | **PASS** — production build/start and Chromium 1/1; 24.0s total, test 5.3s; filtered page p95 73.8ms |
| physical-direction class grep over the three new/rewritten WS7 UI files | **PASS** — no physical-direction utility introduced (`border-ring` was verified as a false-positive substring in an earlier broad grep) |
| `git diff --check` | **PASS** — no whitespace errors |

Iterative diagnostics are retained for audit accuracy: the first integration invocation
without `.env.local` did not start because `LOCAL_SUPABASE_SECRET_KEY` was absent; the first
env-backed sandbox run could not reach local Supabase (`TypeError: fetch failed`) and passed
when rerun with approved local-service access. The first browser attempt did not start in
the filesystem sandbox because `tsx` IPC returned `EPERM`; the first approved run then found
an ambiguous date-input test selector, and the next run exposed a too-short 5-second sort
navigation poll. Selectors were narrowed and the navigation assertion was extended to 15
seconds after independently asserting the generated sort URL. The final production runs
pass, including the Clear-state synchronization and performance gate.

## 11. Acceptance criteria checklist

- [x] Every existing operator report was audited and received only the approved useful filters.
- [x] Documented defaults match the WS7 matrix.
- [x] Filter, sorting, page-size, and pagination state survives refresh and is shareable by URL.
- [x] Invalid parameters and inverted ranges fall back safely.
- [x] Sorting and pagination remain constrained by active filters.
- [x] Clear filters produces persistent all-time/all-value state.
- [x] Report-hub return state remains preserved; report detail routes are N/A.
- [x] Loading, no-data, and filtered-empty states are present.
- [x] All exports use active filters/global sort and ignore page boundaries.
- [x] Platform-admin authorization is enforced on every query and option path.
- [x] Reports remain aggregate/metadata-only and expose no patient PHI.
- [x] Direct reports use database filtering/counting/ranges; aggregate sources are bounded.
- [x] The old fixed 1,000-row report load is removed from WS7 query paths.
- [x] Existing RLS, tenancy, RBAC, middleware, billing, subscriptions, entitlements, audit,
      and canonical financial values are preserved.
- [x] No unapproved schema/index, WS8, WS9, P2, Arabic, RTL, or `next-intl` work was added.
- [x] Targeted, URL-state, pagination/sorting, export-consistency, authorization/no-PHI,
      Playwright, typecheck, lint, full unit, integration, production build, performance,
      physical-direction, and diff validation pass.

## 12. Files changed

WS7 product code:

- `app/(operator)/operator/reports/[reportId]/page.tsx`
- `app/(operator)/operator/reports/[reportId]/export/route.ts`
- `app/(operator)/operator/reports/[reportId]/loading.tsx` (new)
- `components/operator/report-shell.tsx`
- `components/operator/report-filter-combobox.tsx` (new)
- `components/shared/data-table.tsx` (adds WS7 `aria-sort` support to the existing WS2 primitive)
- `lib/operator-reports/types.ts`
- `lib/operator-reports/registry.ts`
- `lib/supabase/admin.ts`

WS7 tests/documentation:

- `tests/unit/lib/ws7-operator-report-params.test.ts` (new)
- `tests/unit/components/operator-report-shell.test.tsx` (new)
- `tests/unit/integration/ws7-operator-reports.test.ts` (new)
- `tests/e2e/smoke.spec.ts`
- `docs/reviews/PRE_P2_WS7_REVIEW.md` (this file)

## 13. Known limitations or unresolved required work

- CSV and aggregate-source safety ceilings are 10,000 rows. A cap is never silent: exports
  include a truncation response header and aggregate pages show a warning. Raising or
  removing a ceiling requires a reviewed database aggregate/export design, not an unbounded
  client load.
- Clinic/country filter-option discovery is intentionally limited to the first 500 clinics
  sorted by name. Direct URL values remain safely parsed, but a platform above that bound
  may need a future server-searched combobox. That scale extension is non-blocking for the
  current dataset and outside the approved no-unbounded-client requirement.
- Production telemetry was not available; the required p95 gate was measured against the
  local production build and authenticated local data fixture (73.8ms).
- PostgREST aggregate functions remain disabled. Users and Growth therefore use bounded
  metadata aggregation with explicit truncation disclosure rather than an unapproved RPC.
- No required WS7 work remains. This record is an implementation/audit record only and does
  not constitute independent approval or approval for merge.

## 14. Git status

- Current branch: `main`, tracking `origin/main`.
- Staging area is empty. No branch, commit, push, merge, stage, reset, restore, stash, clean,
  or destructive command was used.
- The dirty tree intentionally preserves WS0–WS6 alongside WS7. Complete `git status --short --branch`:

```text
## main...origin/main
 M actions/doctor-dashboard.ts
 M app/(operator)/operator/clinics/[id]/page.tsx
 M app/(operator)/operator/clinics/page.tsx
 M app/(operator)/operator/coupons/page.tsx
 M app/(operator)/operator/invitations/page.tsx
 M app/(operator)/operator/reports/[reportId]/export/route.ts
 M app/(operator)/operator/reports/[reportId]/page.tsx
 M app/(operator)/operator/reports/page.tsx
 M app/(protected)/appointments/new/page.tsx
 M app/(protected)/appointments/page.tsx
 M app/(protected)/dashboard/page.tsx
 M app/(protected)/error.tsx
 M app/(protected)/layout.tsx
 M app/(protected)/patients/[id]/appointments-report/page.tsx
 M app/(protected)/patients/[id]/edit/page.tsx
 M app/(protected)/patients/[id]/followups-report/page.tsx
 M app/(protected)/patients/[id]/medical-notes-report/page.tsx
 M app/(protected)/patients/[id]/page.tsx
 M app/(protected)/patients/archive/page.tsx
 M app/(protected)/patients/new/page.tsx
 M app/(protected)/patients/trash/page.tsx
 M app/(protected)/revenue/page.tsx
 M app/(protected)/settings/departments/page.tsx
 M app/(protected)/settings/insurance/page.tsx
 M app/(protected)/settings/layout.tsx
 M app/(protected)/settings/packages/page.tsx
 M app/(protected)/settings/services/page.tsx
 M app/globals.css
 M components/appointments/appointment-form.tsx
 M components/appointments/appointments-recycle-bin.tsx
 M components/appointments/day-calendar.tsx
 M components/appointments/displaced-appointments.tsx
 M components/appointments/month-calendar.tsx
 M components/appointments/new-appointment-layout.tsx
 M components/appointments/status-badge.tsx
 M components/appointments/week-calendar.tsx
 M components/followups/followups-view.tsx
 D components/layout/currency-selector.tsx
 M components/layout/dashboard-shell.tsx
 M components/layout/sidebar.tsx
 M components/operator/report-shell.tsx
 M components/patients/appointments-report-list.tsx
 M components/patients/archive-table.tsx
 M components/patients/patient-form.tsx
 M components/patients/patient-table.tsx
 M components/patients/trash-table.tsx
 M components/reports/cancellation-report.tsx
 M components/reports/doctor-performance-report.tsx
 M components/reports/followups-report.tsx
 M components/reports/no-show-report.tsx
 M components/reports/receptionist-performance-report.tsx
 M components/reports/report-page-header.tsx
 M components/reports/revenue-summary-report.tsx
 M components/revenue/revenue-report.tsx
 M components/settings/settings-trash-section.tsx
 M components/settings/staff-table.tsx
 M components/shared/international-phone-input.tsx
 M contexts/clinic-settings-context.tsx
 M lib/currency/conversion.ts
 M lib/currency/open-exchange-rates.ts
 M lib/currency/registry.ts
 M lib/currency/server.ts
 M lib/operator-reports/registry.ts
 M lib/operator-reports/types.ts
 M lib/phone/registry.ts
 M lib/supabase/admin.ts
 M tests/e2e/smoke.spec.ts
 M tests/unit/components/__snapshots__/dashboard-shell.test.tsx.snap
 M tests/unit/lib/p15d-currency.test.ts
 M tests/unit/lib/p15d-phone.test.ts
?? app/(operator)/operator/reports/[reportId]/loading.tsx
?? app/(protected)/preferences/
?? components/appointments/calendar-visuals.tsx
?? components/operator/report-filter-combobox.tsx
?? components/patients/patient-report-header.tsx
?? components/settings/currency-combobox.tsx
?? components/settings/settings-page-header.tsx
?? components/shared/data-table.tsx
?? components/shared/page-header.tsx
?? components/ui/table.tsx
?? docs/PRE_P2_POLISH.md
?? docs/reports/PRE_P2_WS5_IMPLEMENTATION.md
?? docs/reports/PRE_P2_WS6_IMPLEMENTATION.md
?? docs/reviews/PRE_P2_WS0_REVIEW.md
?? docs/reviews/PRE_P2_WS1_REVIEW.md
?? docs/reviews/PRE_P2_WS2_REVIEW.md
?? docs/reviews/PRE_P2_WS3_REVIEW.md
?? docs/reviews/PRE_P2_WS4_REVIEW.md
?? docs/reviews/PRE_P2_WS5_REVIEW.md
?? docs/reviews/PRE_P2_WS6_REVIEW.md
?? docs/reviews/PRE_P2_WS7_REVIEW.md
?? docs/reviews/assets/
?? lib/currency/format.ts
?? lib/navigation/
?? tests/unit/components/appointment-calendar-readability.test.tsx
?? tests/unit/components/data-table.test.tsx
?? tests/unit/components/operator-report-shell.test.tsx
?? tests/unit/components/page-header.test.tsx
?? tests/unit/components/patient-return-navigation.test.tsx
?? tests/unit/components/settings-page-header.test.tsx
?? tests/unit/integration/ws7-operator-reports.test.ts
?? tests/unit/lib/return-url.test.ts
?? tests/unit/lib/ws7-operator-report-params.test.ts
```

Stop after WS7. WS8 was not started.
