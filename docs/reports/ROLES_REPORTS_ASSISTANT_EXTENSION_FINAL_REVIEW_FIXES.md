# Roles / Reports / Assistant Extension — Final Review Fixes

**Date:** 2026-07-27  
**Scope:** Final-review findings RRAE-R1, RRAE-R2, RRAE-R3, and RRAE-R3a  
**Source review:** [`docs/reviews/ROLES_REPORTS_ASSISTANT_EXTENSION_FINAL_REVIEW.md`](../reviews/ROLES_REPORTS_ASSISTANT_EXTENSION_FINAL_REVIEW.md)  
**Status:** All findings remediated and validated; awaiting independent re-review

## Executive summary

Every finding in the final review has been addressed. The Customize crash and
Assistant supervision page/edit crashes were caused by Phase 1 tables missing
from the fail-closed scoped-admin classification. The Phase 8 activity table was
also unclassified. All three Phase 1–8 clinic-owned tables are now classified,
with the narrowest correct write boundary preserved.

The Assistant-placement loader no longer embeds the newly introduced
`assistant` enum literal in its profiles filter. This removes the rollout-order
failure that returned PostgreSQL `22P02` before the role migration was present.
The full 19-migration Phase 1–8 chain has also been applied to the exact linked
Supabase project used by `.env.local`.

## Finding resolution

| Finding | Resolution | Verification |
| --- | --- | --- |
| RRAE-R1 — Customize crash and report save/reset failure | Added `user_report_permissions` to the writable clinic-scoped table set. Reads, upserts, deletes, and automatic `clinic_id` scoping now work through `createClinicScopedAdminClient`. | Scoped-client contract tests; report action paths included in the source-usage audit; full unit/build validation. |
| RRAE-R2 — Staff page and Assistant edit prefill crash | Added `assistant_doctor_assignments` to the read-only clinic-scoped set. Staff list and edit-prefill reads work, while writes remain restricted to `replace_assistant_doctor_assignments()`. | Scoped-client contract tests; both source call sites discovered by the usage scanner; full live integration suite. |
| RRAE-R3 — target database not migrated | Applied migrations `20260727120000` through `20260727170000` to linked project `ayzetxywrqouqpurbjuv`, which matches `NEXT_PUBLIC_SUPABASE_URL`. | Remote migration ledger has no omissions; live PostgREST checks pass for the Assistant enum, `assistant_doctor_assignments`, `user_report_permissions`, and `activity_events`. |
| RRAE-R3a — placement loader rollout brittleness | Removed the redundant role `.in(...)` filter from the active-staff directory query. The database enum remains the role integrity boundary; the loader no longer sends a not-yet-deployed enum literal during rollout. | Unit test loads an Assistant row and asserts that no role filter is sent; placement loader/page tests pass. |

## Scoped-admin allow-list audit

The audit used the TypeScript compiler API to locate literal `.from("…")` calls
whose receiver is a `createClinicScopedAdminClient(...)` instance across
`actions/`, `app/`, and `lib/`. It found 35 distinct tables. Every one is
classified by exactly one reviewed scope mode; no current scoped-admin call can
reach the synchronous unclassified-table exception.

The new contract test repeats this source scan on every unit run and instantiates
the real scoped wrapper for each discovered table. A newly introduced
unclassified literal table therefore fails tests before runtime.

All clinic-owned tables introduced by Phases 1–8 were audited explicitly:

| Table | Phase | Classification | Write boundary |
| --- | --- | --- | --- |
| `assistant_doctor_assignments` | 1 | Read-only clinic-scoped | Atomic authenticated RPC only |
| `user_report_permissions` | 1 | Writable clinic-scoped | Primary-admin action plus database policy |
| `activity_events` | 8D | Read-only clinic-scoped | Trigger-generated, append-only |

Phase 6 adds columns and enum values to `appointments` rather than a new table;
`appointments` was already classified. Phases 3–5, 7, 8A, 8B, and 8C add
policies/RPCs or modify existing tables and introduce no additional clinic-owned
tables.

## Application fixes

### Customize

- `listStaffReportPermissions()` can read stored report overrides.
- `saveUserReportVisibilityChanges()` can upsert changes with the scoped
  `clinic_id`.
- `resetUserReportVisibilityToRoleDefaults()` can delete stored overrides.
- The Customize Server Component no longer encounters a synchronous allow-list
  exception inside its `Promise.all`.

### Staff and Assistant supervision

- Settings → Staff can load assignment rows when any Assistant exists.
- `getAssistantSupervisingDoctorIds()` can populate the edit form.
- Service-role writes to the assignments table are rejected by the wrapper;
  assignment replacement continues through the validated transactional RPC.

### Assistant placement

- Active/deleted filtering and clinic scoping are unchanged.
- The profiles query relies on the database role type rather than duplicating
  the complete role enum in a PostgREST filter.
- Assistant rows are accepted by the read model after migration, while the page
  also avoids the original rollout-order `22P02` failure.

## Migration and target verification

1. Confirmed `.env.local` targets `ayzetxywrqouqpurbjuv.supabase.co`.
2. Confirmed the Supabase CLI link points to the same project ref.
3. Ran a remote dry run; it listed exactly 19 pending Phase 1–8 migrations.
4. Applied all 19 migrations in order with `supabase db push --linked`.
5. Re-ran `supabase migration list`; local and remote columns match through
   `20260727170000`.
6. Queried the configured remote API with the service client using read-only
   `head` requests. The three tables resolve and filtering `profiles.role` by
   `assistant` succeeds.
7. Reset the local database and replayed the complete repository migration
   history successfully.

## Regression coverage added

- `tests/unit/lib/admin-client-scope.test.ts`
  - source-wide scoped-admin usage contract;
  - explicit Phase 1–8 table classification contract;
  - automatic clinic filter assertions;
  - read-only write-boundary assertions for assignments and activity events.
- `tests/unit/ai/p49b-launcher-customization-data.test.ts`
  - Assistant staff-row loading;
  - enum-literal filter regression assertion.

Focused regression result: 3 files, 23 tests passed.

## Full validation

| Validation | Result |
| --- | --- |
| TypeScript | `pnpm typecheck` passed |
| Production build | `pnpm build` passed; 69 pages generated |
| ESLint | Passed with 0 errors and 24 existing warnings |
| RTL gate | Passed; 448 files, 10 documented exceptions |
| Hardcoded-string i18n gate | Passed; 317 files, 14 documented exceptions |
| Message parity | Passed; 2,975 base leaf messages |
| Unused messages | Passed; none |
| Non-integration unit suite | 228 files; 1,659 tests passed |
| Live local integration suite | 32 files; 340 tests passed |
| Clean local migration replay | Passed through `20260727170000` |
| Remote migration ledger | Passed through `20260727170000` |
| Remote live schema check | Assistant enum and all three new tables passed |
| Database lint | Completed; only the four previously documented warning sites remain |

Interactive browser control was unavailable in this environment. The affected
page loaders were instead exercised by focused page/read-model tests, the full
production build, the complete live integration suite, and read-only checks
against the application’s configured remote database. No browser result is
claimed.

## Files changed for remediation

- `lib/supabase/admin.ts`
- `lib/ai/launcher-customization.ts`
- `tests/unit/lib/admin-client-scope.test.ts`
- `tests/unit/ai/p49b-launcher-customization-data.test.ts`
- `docs/ROLES_REPORTS_ASSISTANT_EXTENSION_PLAN.md`
- `docs/reports/ROLES_REPORTS_ASSISTANT_EXTENSION_FINAL_IMPLEMENTATION.md`
- `docs/reports/ROLES_REPORTS_ASSISTANT_EXTENSION_FINAL_REVIEW_FIXES.md`

No Git operation was performed.
