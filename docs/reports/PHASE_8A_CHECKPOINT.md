# ClinicFlow Phase 8A Checkpoint

Date: 2026-07-27
Scope: Phase 8A only — "My Revenue" (doctor-oriented revenue report)
Status: Complete; awaiting product approval

## Executive summary

Phase 8A is complete. It delivers **My Revenue**, a doctor-oriented revenue
report that is strictly distinct from the administrative clinic-wide Revenue
report, exactly as specified in
`docs/ROLES_REPORTS_ASSISTANT_EXTENSION_PLAN.md` §8A.

A doctor sees only their own collected revenue; an assistant sees only the union
of their assigned doctors' revenue. This is a database-enforced property: the
report is backed by a dedicated `SECURITY INVOKER` RPC that reads only the
RLS-scoped `appointments` payment columns and hard-denies every role except
`doctor`/`assistant`. It never touches the clinic-wide settlement table that
doctors and assistants cannot see. The report defaults **OFF for every role** and
is opt-in only, enabled per employee by the primary admin through Settings →
Customize.

Phases 8B and 8C were **not** started. No Git operations were performed.

## What was implemented

### Database — `20260727150000_p8a_my_revenue_rpc.sql`

- **`get_my_revenue_summary(p_start timestamptz, p_end timestamptz)`** —
  `SECURITY INVOKER`, `search_path = public, pg_temp`. Aggregates completed,
  non-deleted, paid-in-range `appointments` payment columns
  (`paid_amount`, `secondary_amount`, `insurance_amount`, `deposit_amount`,
  `outstanding_amount`, `total_amount`) plus a payment-method breakdown.
- **Scope by construction.** RLS on `appointments` already scopes the caller —
  a doctor to their own appointments, an assistant to their supervised-doctor
  union (`auth_supervised_doctor_ids()`). The RPC therefore applies **no**
  `doctor_id` predicate and exposes **no** `p_doctor_id` parameter, so the
  assistant aggregate is exactly the union.
- **Role guard.** Every role except `doctor`/`assistant` is hard-denied with
  errcode `42501`. Admin/manager/receptionist keep the existing clinic-wide
  `get_revenue_summary`; letting them into this RPC would return clinic-wide
  figures under their broader RLS and defeat the "My Revenue" guarantee.
- **No clinic-wide financial tables.** The RPC never reads
  `outstanding_settlements` (nor any settlement/deposit table doctors cannot
  see). `grossTotal` is `primary + secondary + insurance + deposit` — collected
  appointment revenue only, with settlements deliberately excluded.
- Execute is revoked from `public` and granted only to `authenticated,
  service_role`.

### Types

- Hand-added the `get_my_revenue_summary` function signature to
  `types/database.ts` per the minimal hand-addition policy (no wholesale local
  regeneration). No new tables/columns.

### Catalog and vocabulary

- `lib/ai/clinic-reports.ts` — new `my_revenue` id in `CLINIC_REPORT_IDS`
  (ordered right after `revenue`), `CLINIC_REPORT_LABELS`, and `CLINIC_REPORTS`
  (`roles: ["doctor","assistant"]`, `financial: true`, `acceptsDoctor: false`,
  `href: "/reports/my-revenue"`, `auditTable: "appointments"`).
- `lib/reports/catalog.ts` — new `REPORT_CATALOG.my_revenue` entry:
  `pageRoles: ["doctor","assistant"]`, `financial: true`,
  `administrative: false`, `defaultVisibilityByRole` **OFF for every role**.

### Data and UI

- `types/reports.ts` — `MyRevenueSummaryReportResponse` (settlement fields
  intentionally omitted).
- `lib/reports/data.ts` — `EMPTY_MY_REVENUE`, `normalizeMyRevenueSummary`, and
  `getMyRevenueSummaryData(range)` (no doctor filter).
- `components/reports/my-revenue-summary-report.tsx` — localized summary with
  gross/service/primary/secondary/insurance/deposits/outstanding metrics, a
  collected-revenue table, and a payment-method breakdown. Settlement rows are
  omitted (the report has no settlement data).
- `app/(protected)/reports/my-revenue/page.tsx` — guarded by
  `requireReportAccess("my_revenue")`, which enforces **both** gates: the
  doctor/assistant page-role guard + Reports-page-visible + report-visible. A
  hidden report is a `notFound()` (404) on direct URL. No cross-doctor filter is
  shown (scope-locked to self/union).

### Enforcement across every surface

- **Report index + discovery** — catalog-driven; the card and
  `getVisibleReportIds` pick up `my_revenue` automatically, gated by per-user
  visibility. Icon added to `components/reports/reports-index.tsx`.
- **Settings → Customize / Report Permissions** — catalog-driven via
  `reportsOpenableByRole`; the primary admin can toggle My Revenue per doctor/
  assistant. Default OFF.
- **AI reporting tool** — `run_clinic_report` gains a `my_revenue` definition;
  `execute()` re-checks the per-report role list, per-user report visibility,
  and (because `financial: true`) the full financial-insights gate against the
  database on every invocation.
- **AI navigation** — new `reports_my_revenue` navigation target
  (`roles: ["doctor","assistant"]`, `reportId: "my_revenue"`), so AI "take me
  to…" resolution honors both role and per-user visibility.

### English/Arabic copy

- `reports.myRevenueReport`, `reports.myRevenueSummary`,
  `reports.yourCollectedRevenueFromCompletedAppointments`;
  `protected.myRevenueReport`, `protected.metadataMyRevenueReport`,
  `protected.yourCollectedRevenueFromCompletedAppointments`.

## Product decisions

1. **Default OFF for everyone.** My Revenue is opt-in; the primary admin enables
   it per employee. No role gets it by default.
2. **Doctor/assistant only.** Admins and managers use the existing clinic-wide
   Revenue report; My Revenue's `pageRoles` and RPC role guard both exclude
   them, so it can never surface clinic-wide figures.
3. **No settlements.** Because the scoped RPC must not read the clinic-wide
   settlement table, My Revenue reports collected appointment revenue only;
   `grossTotal` excludes settlement income. This is an intentional, documented
   difference from the administrative Revenue report.
4. **Union, not per-doctor.** Assistants see the aggregate of their assigned
   doctors' revenue; the report is scope-locked with no cross-doctor filter,
   matching the other self-scoped operational reports.

## Validation results

| Validation | Result |
| --- | --- |
| `pnpm typecheck` | Passed |
| Production build | Passed; 68 static pages, `/reports/my-revenue` route present |
| ESLint (changed files) | Passed; 0 errors |
| `pnpm lint:rtl` | Passed; 445 files, 10 exceptions |
| `pnpm lint:i18n` | Passed; 314 files, 14 exceptions |
| `pnpm i18n:missing` | Passed; 2,948 base leaf messages |
| `pnpm i18n:unused` | Passed; no unused messages |
| Database lint | No new findings; the same four pre-existing warning sites remain (`get_my_revenue_summary` adds none) |
| Clean local migration replay | Passed from an empty local database through `20260727150000` |
| `git diff --check` | Passed |

## Test results

| Test run | Result |
| --- | --- |
| Complete non-integration unit suite | 226 files; 1,639 tests passed |
| Complete live integration catalog | 30 files; 322 tests passed |
| New Phase 8A static migration contract | 7 tests passed |
| New Phase 8A live RLS suite | 8 tests passed |
| Report-catalog unit suite (updated for `my_revenue`) | Passed |

The live Phase 8A suite proves: a doctor sees only their own collected revenue
(100 gross, 20 outstanding, 1 transaction) and never the other doctor's; a
second doctor sees only their own (250); an assistant assigned to one doctor
sees that doctor only (100), unions both once a second doctor is assigned (350,
2 transactions), and re-scopes immediately on unassignment; clinic B's revenue
(999) never appears in any clinic A scope; and admin, receptionist, and
anonymous callers are denied (`42501` for authenticated non-doctor/assistant
roles).

## Files added

- `supabase/migrations/20260727150000_p8a_my_revenue_rpc.sql`
- `app/(protected)/reports/my-revenue/page.tsx`
- `components/reports/my-revenue-summary-report.tsx`
- `tests/unit/db/p8a-my-revenue-migration.test.ts`
- `tests/unit/integration/p8a-my-revenue-rls.test.ts`
- `docs/reports/PHASE_8A_CHECKPOINT.md`

## Files modified

- `types/database.ts` — added `get_my_revenue_summary` signature.
- `types/reports.ts` — added `MyRevenueSummaryReportResponse`.
- `lib/reports/data.ts` — `EMPTY_MY_REVENUE`, normalizer, fetch helper.
- `lib/reports/catalog.ts` — `my_revenue` catalog entry + role constant.
- `lib/ai/clinic-reports.ts` — `my_revenue` id/label/policy.
- `lib/ai/tools/run-clinic-report.ts` — `my_revenue` report definition.
- `lib/ai/help/navigation.ts` — `reports_my_revenue` navigation target.
- `components/reports/reports-index.tsx` — My Revenue card icon.
- `messages/en.json`, `messages/ar.json` — My Revenue copy.
- `tests/unit/lib/report-catalog.test.ts` — coverage for the opt-in,
  doctor/assistant-only financial report.
- `docs/ROLES_REPORTS_ASSISTANT_EXTENSION_PLAN.md` — marked 8A checkpointed.

## How this relates to the deferred sub-phases

- **8B (My Performance)** and **8C (My Assistant Performance)** remain deferred
  and were not started. They will draw operational KPIs from the Phase 8D
  activity trail; My Revenue is independent of them and needs only existing
  appointment payment data.

## Known limitations

- My Revenue reports collected appointment revenue only; settlement income is
  intentionally excluded because the scoped RPC cannot read the clinic-wide
  settlement table (documented product decision).
- The four pre-existing database-lint warning sites remain (unchanged by 8A).
- Local migration verified locally; production migration/deployment is out of
  this session's scope.

## Intentionally deferred

- Phases 8B (My Performance) and 8C (My Assistant Performance) were not started.
- No Git commit, push, merge, rebase, reset, or branch operation was performed.
