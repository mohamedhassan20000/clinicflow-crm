# P0 Implementation Report

## 1. What Changed

- Added a P0 RLS migration that removes the broad `clinics_select_admin_all` and `clinics_insert_admin` policies and recreates `clinics_select_own` as `id = public.auth_clinic_id()`.
- Added per-clinic localization columns to `clinics`: `timezone`, `currency`, `locale`, `country`, `week_start`, and `digits`.
- Added `createClinicScopedAdminClient(clinicId)` in `lib/supabase/admin.ts`.
  - Tenant tables get automatic `clinic_id` filters for `select`, `update`, and `delete`.
  - Tenant-table `insert` and `upsert` payloads get `clinic_id` injected and reject mismatched clinic IDs.
  - `auth.admin` remains available for staff provisioning and auth-admin operations.
- Replaced raw service-role data access in Server Actions and related RSC/helper call sites with the scoped wrapper.
- Added an ESLint `no-restricted-imports` guard banning raw `createAdminClient` imports in `actions/**`.
- Removed the old `CLINIC_TZ` constant and changed shared date/report helpers to default to P0 clinic locale settings.
- Updated `createAppointment` so clinic closed-day and same-day conflict checks use the clinic timezone instead of server-local `Date` math.
- Updated tests and mocks for the scoped admin wrapper and P0 migrations.

## 2. Files Modified

- `supabase/migrations/20260709090000_fix_clinics_cross_tenant_policies.sql`
- `supabase/migrations/20260709091000_clinic_localization_columns.sql`
- `lib/supabase/admin.ts`
- `eslint.config.mjs`
- `actions/appointments.ts`
- `actions/settings.ts`
- `actions/patients.ts`
- `actions/page-permissions.ts`
- `actions/package-templates.ts`
- `lib/cache/reference-data.ts`
- `lib/primary-admin.ts`
- `lib/datetime.ts`
- `lib/date-range.ts`
- `lib/format-time.ts`
- Date/time display defaults in existing app/component files that still referenced Istanbul directly.
- `components/reports/report-formatters.ts`
- `types/database.ts`
- `vitest.config.ts`
- Tests under `tests/unit/**`, including new P0 guard/migration/wrapper tests and extended RLS integration coverage.

## 3. New Migration Names

- `20260709090000_fix_clinics_cross_tenant_policies.sql`
- `20260709091000_clinic_localization_columns.sql`

## 4. Security Reasoning

The previous `clinics` policies allowed any clinic admin to read every clinic row and insert arbitrary clinic rows. The new migration removes those broad policies and leaves clinic reads scoped to `id = auth_clinic_id()`. Authenticated clinic inserts are not allowed; future onboarding must use a dedicated RPC.

Service-role access remains dangerous because it bypasses RLS. The scoped wrapper reduces the chance of accidental PHI leaks by making `clinic_id` filtering automatic for tenant tables and by rejecting mismatched write payloads. The ESLint guard prevents Server Actions from importing raw `createAdminClient` directly.

## 5. Tests Added/Updated

- Added `tests/unit/lib/admin-client-scope.test.ts` for wrapper filtering, write injection, and mismatched clinic rejection.
- Added `tests/unit/db/p0-tenant-hardening-migrations.test.ts` for the two P0 migrations.
- Added `tests/unit/security/admin-client-static-guard.test.ts` for raw Server Action admin-client usage.
- Extended `tests/unit/integration/rls-security.test.ts` with two-clinic clinic-root and cross-tenant patient/appointment/note/storage denial assertions.
- Updated existing Server Action/RSC mocks for `createClinicScopedAdminClient`.

## 6. Commands Run and Results

- `pnpm lint` passed with 4 existing warnings, 0 errors.
- `pnpm typecheck` passed.
- `pnpm test` passed: 49 files, 276 tests.
- `pnpm test:integration` did not run because `LOCAL_SUPABASE_PUBLISHABLE_KEY` and related local Supabase env vars are not set in this environment.
- `rg -n "createAdminClient\\(\\)" actions lib app` returns only `lib/supabase/admin.ts`.
- `rg -n "CLINIC_TZ" actions lib app components tests/unit` returns no matches.

## 7. Risks, Assumptions, Follow-Up

- Live RLS integration assertions were added but could not be executed without the local Supabase integration env.
- The P0 localization groundwork is present, and `createAppointment` now uses clinic timezone for critical scheduling checks. Some UI display paths still default through shared settings rather than fully threading a fetched per-clinic locale object into every component; that broader sweep should stay as P0 follow-up if strict per-view localization is required before launch.
- `createClinicScopedAdminClient` intentionally keeps `auth.admin` available because staff provisioning still needs Supabase Auth admin APIs.
- No existing migrations were edited.

## 8. P1+ Scope Confirmation

No P1 or later scope was implemented. There is no signup flow, billing, entitlements, operator panel, messaging, WhatsApp, AI assistant, or SaaS onboarding work in this change set.

## Review Fixes

### F1 — Wrapper Fails Open for Unrecognized Tables

- **Reviewer finding:** `createClinicScopedAdminClient()` silently allowed tables missing from the scoped table list.
- **Was it valid?** Yes.
- **What was changed:** The wrapper now throws on any unclassified table. `clinic_working_hours` was added to the clinic-scoped allow-list. `feedback` and `medical_notes` are explicitly join-scoped exceptions, documented as requiring caller-side clinic verification.
- **Files modified:** `lib/supabase/admin.ts`, `tests/unit/lib/admin-client-scope.test.ts`.
- **Tests added or updated:** Added unknown-table fail-closed and join-scoped exception tests.
- **Verification performed:** `pnpm test tests/unit/lib/admin-client-scope.test.ts`.

### F2 — Two-Clinic Denial Suite Was Not Executed or Wired to CI

- **Reviewer finding:** The integration RLS suite existed but was not run by `pnpm test` or CI.
- **Was it valid?** Yes.
- **What was changed:** CI now installs the Supabase CLI, starts local Supabase, exports local test keys, and runs `pnpm test:integration`.
- **Files modified:** `.github/workflows/ci.yml`.
- **Tests added or updated:** Existing integration tests are now wired into CI.
- **Verification performed:** Local `pnpm test:integration` was attempted but could not run because Docker is not running locally. `supabase status -o env` failed with Docker daemon unavailable.

### F3 — Update Payloads Could Reassign `clinic_id`

- **Reviewer finding:** The wrapper filtered update queries but did not inspect update payloads.
- **Was it valid?** Yes.
- **What was changed:** `update()` now rejects payloads containing a mismatched `clinic_id`.
- **Files modified:** `lib/supabase/admin.ts`, `tests/unit/lib/admin-client-scope.test.ts`.
- **Tests added or updated:** Added a mismatched update payload rejection test.
- **Verification performed:** Targeted wrapper tests and full `pnpm test`.

### F4 — Cross-Tenant Dependent Delete Before Appointment Ownership Check

- **Reviewer finding:** `permanentDeleteAppointment()` cascaded dependent deletes before verifying the appointment belonged to the caller's clinic.
- **Was it valid?** Yes.
- **What was changed:** `permanentDeleteAppointment()` now verifies the appointment exists in the caller's clinic and is trashed before deleting dependents.
- **Files modified:** `actions/appointments.ts`, `tests/unit/actions/appointment-deletion-safety.test.ts`.
- **Tests added or updated:** Added a regression proving dependent deletes are not attempted when the appointment is outside the clinic.
- **Verification performed:** Targeted appointment deletion tests and full `pnpm test`.

### F5 — Static Guard Coverage Too Narrow

- **Reviewer finding:** Raw `createAdminClient` import prevention covered only `actions/**`.
- **Was it valid?** Yes.
- **What was changed:** ESLint guard now covers `actions`, `app`, `components`, `hooks`, and `lib`, with `lib/supabase/admin.ts` as the only allow-listed app file. The static guard test now scans the same app-code surface.
- **Files modified:** `eslint.config.mjs`, `tests/unit/security/admin-client-static-guard.test.ts`, `.github/workflows/ci.yml`.
- **Tests added or updated:** Static guard widened and included in CI's unit-test command.
- **Verification performed:** `pnpm lint`, targeted static guard test, full `pnpm test`.

### F6 — `auth.admin.listUsers()` Reads All Auth Users

- **Reviewer finding:** The staff page still loads all Supabase auth users into server memory.
- **Was it valid?** Yes, but no tenant data is rendered because the page maps last-login metadata only onto already clinic-scoped staff rows.
- **What was changed:** No code change in this pass. The review marked this as acceptable for P0 and required before multi-tenant launch, not as a blocking P0 fix.
- **Files modified:** None.
- **Tests added or updated:** None.
- **Verification performed:** Re-inspected `app/(protected)/settings/staff/page.tsx`; no user list is sent directly to the client.

### F7 — Insert/Upsert Appended Dead `clinic_id` Filters

- **Reviewer finding:** The wrapper appended `.eq("clinic_id", ...)` after `insert()`/`upsert()`, which PostgREST ignores for writes.
- **Was it valid?** Yes.
- **What was changed:** Insert/upsert now rely on payload injection and no longer append query filters.
- **Files modified:** `lib/supabase/admin.ts`, `tests/unit/lib/admin-client-scope.test.ts`.
- **Tests added or updated:** Added an assertion that insert does not append a `clinic_id` filter.
- **Verification performed:** Targeted wrapper tests and full `pnpm test`.

### F8 — `rpc()`, `schema()`, and `storage` Passed Through Unscoped

- **Reviewer finding:** Future use of those methods on the scoped admin client would look scoped but remain service-role unbounded.
- **Was it valid?** Yes.
- **What was changed:** The scoped wrapper now throws if `rpc`, `schema`, or `storage` are accessed.
- **Files modified:** `lib/supabase/admin.ts`, `tests/unit/lib/admin-client-scope.test.ts`.
- **Tests added or updated:** Added a test that blocks unscoped RPC and storage access.
- **Verification performed:** Targeted wrapper tests and full `pnpm test`.

### A1 — Per-Clinic Localization Was Not Fully Threaded

- **Reviewer finding:** Most production callers still do not pass a fetched `ClinicLocale`.
- **Was it valid?** Yes.
- **What was changed:** No broad UI threading was attempted in this review-fix pass. The report now treats this as a remaining limitation instead of claiming it is complete.
- **Files modified:** `docs/reports/P0_IMPLEMENTATION.md`.
- **Tests added or updated:** None.
- **Verification performed:** Re-inspected formatter call sites.

### A2 — `getAvailableTimeSlots()` Still Used a Hardcoded UTC+3 Day

- **Reviewer finding:** Slot generation still used a default timezone and `+03:00` literals while appointment creation used `clinics.timezone`.
- **Was it valid?** Yes.
- **What was changed:** `getAvailableTimeSlots()` now reads `clinics.timezone` and uses it for weekday calculation, day bounds, and active appointment local-time conversion.
- **Files modified:** `actions/time-slots.ts`, `tests/unit/actions/time-slots.test.ts`.
- **Tests added or updated:** Added a non-UTC+3 timezone regression for appointment query bounds.
- **Verification performed:** Targeted time-slot test and full `pnpm test`.

### A3 — Existing Deployment Currency/Locale Could Flip

- **Reviewer finding:** Code fallbacks and migration defaults could change the existing single-clinic deployment from Istanbul/TRY/en to Kuwait/KWD/ar.
- **Was it valid?** Yes.
- **What was changed:** Added a follow-up migration that backfills existing clinic rows to Istanbul/TRY/en/TR. Code fallback locale was restored to the legacy Istanbul/TRY/en behavior until full per-clinic UI locale threading is completed. New clinic rows still receive the P0 DB defaults from `20260709091000`.
- **Files modified:** `supabase/migrations/20260710090000_backfill_legacy_clinic_localization.sql`, `lib/datetime.ts`, `tests/unit/sanity.test.ts`, `tests/unit/db/p0-tenant-hardening-migrations.test.ts`.
- **Tests added or updated:** Added migration string coverage and updated datetime fallback test.
- **Verification performed:** Targeted migration/datetime tests and full `pnpm test`.

### A4 — Misleading Legacy Helper Names

- **Reviewer finding:** `toIstanbul` and `startOfWeekTR` remain as compatibility aliases with old names.
- **Was it valid?** Yes.
- **What was changed:** No code change. They remain for compatibility and currently route through the shared clinic-time helpers. Removing them would be a refactor outside the review-fix scope.
- **Files modified:** None.
- **Tests added or updated:** None.
- **Verification performed:** Re-inspected `lib/datetime.ts`.

### Database Nit — Timezone Validity Check

- **Reviewer finding:** `clinics.timezone` accepts arbitrary text.
- **Was it valid?** Yes.
- **What was changed:** No database change in this pass. There is no P0 settings write path for arbitrary timezone input yet; validation should be added when that settings action/UI is introduced.
- **Files modified:** None.
- **Tests added or updated:** None.
- **Verification performed:** Re-inspected migrations and confirmed no current user-facing timezone write path exists.

### Test Quality Gaps

- **Reviewer finding:** Wrapper tests were shallow, migration tests were string-based, static guard radius was too narrow, and there was no timezone mismatch regression.
- **Was it valid?** Yes.
- **What was changed:** Added wrapper negative tests, widened the static guard, added the time-slot timezone regression, and wired integration tests into CI.
- **Files modified:** `tests/unit/lib/admin-client-scope.test.ts`, `tests/unit/security/admin-client-static-guard.test.ts`, `tests/unit/actions/time-slots.test.ts`, `.github/workflows/ci.yml`.
- **Tests added or updated:** See above.
- **Verification performed:** `pnpm test`; local integration attempt blocked by Docker daemon unavailable.

### Commands Run After Review Fixes

- `pnpm lint` passed with 4 existing warnings, 0 errors.
- `pnpm typecheck` passed.
- `pnpm test` passed: 50 files, 283 tests.
- `pnpm test:integration` attempted and failed before running tests because local Supabase env/Docker is unavailable.
- `supabase status -o env` attempted with escalation and failed because Docker daemon is not running.
- `rg -n "createAdminClient\\(\\)" actions app components lib` returns only `lib/supabase/admin.ts`.
- `rg -n "Asia/Kuwait|CLINIC_TZ" actions app components lib tests/unit --glob '!tests/unit/db/p0-tenant-hardening-migrations.test.ts'` returns no app-code matches.

### Remaining Known Limitations

- The live integration suite is now wired into CI but was not executable in this local environment because Docker is not running.
- `auth.admin.listUsers({ perPage: 1000 })` remains on the staff settings page. It does not render cross-tenant users, but should be replaced before multi-tenant launch.
- `clinics.timezone` should be validated as an IANA timezone when a user-facing settings write path exists.

### No P1+ Confirmation

No P1 or later scope was implemented during review fixes. There is still no signup flow, billing, entitlements, operator panel, messaging, WhatsApp, AI assistant, or SaaS onboarding work in this change set.

## Final Locale Threading Fix

- **Reviewer finding:** Display-locale threading from plan §3.5 remained incomplete because production code did not read `clinics.currency`, `locale`, `week_start`, and `digits`.
- **Was it valid?** Yes.
- **What was changed:** The protected layout now reads the full clinic locale row and provides it through `ClinicSettingsProvider`. Shared formatters now apply clinic currency, locale, and digit settings with legacy Istanbul/TRY/en/Monday defaults. Money display paths in reports, dashboards, billing dialogs, patient package/payment views, and settings price tables now use the clinic-aware formatter. Appointment week/month calendar range and headers now use the configured `week_start`.
- **Files modified:** `lib/datetime.ts`, `lib/format-time.ts`, `contexts/clinic-settings-context.tsx`, `app/(protected)/layout.tsx`, `app/(protected)/appointments/page.tsx`, `app/(protected)/patients/[id]/page.tsx`, `app/(protected)/settings/services/page.tsx`, `app/(protected)/settings/packages/page.tsx`, appointment/dashboard/patient/report display components.
- **Tests added or updated:** Added `tests/unit/components/clinic-settings-context.test.tsx` and `tests/unit/lib/clinic-locale.test.ts`; updated billing dialog tests for neutral amount labels.
- **Verification performed:** Targeted locale tests passed locally. `pnpm lint` passed with 4 existing warnings and 0 errors. `pnpm typecheck` passed. `pnpm test` passed: 52 files, 286 tests.
- **Remaining known limitations:** Local Supabase/Docker integration execution remains environment-dependent; CI is expected to run the integration suite. IANA timezone validation is still deferred until a user-facing timezone write path exists.
- **No P1+ confirmation:** No P1 or later work was implemented in this final fix.

## CI Integration Env Fix

- **Failure:** GitHub Actions ran `pnpm test:integration` with mismatched local Supabase JWT/API keys, producing `JWT cryptographic operation failed`.
- **What was changed:** The CI workflow now starts local Supabase, reads `supabase status -o env`, shell-sources the generated env file so quoted values are unquoted correctly, validates `API_URL`, `ANON_KEY`, and `SERVICE_ROLE_KEY`, and exports those exact values as `LOCAL_SUPABASE_URL`, `LOCAL_SUPABASE_PUBLISHABLE_KEY`, and `LOCAL_SUPABASE_SECRET_KEY` for `pnpm test:integration`.
- **Files modified:** `.github/workflows/ci.yml`, `docs/reports/P0_IMPLEMENTATION.md`.
- **Tests added or updated:** None; this is CI/local integration environment wiring only.
- **Verification performed:** `pnpm lint` passed with 4 existing warnings and 0 errors. `pnpm typecheck` passed. `pnpm test` passed: 52 files, 286 tests. Local integration execution still depends on Docker/local Supabase availability; CI now sources the keys produced by its local Supabase instance.
- **No P1+ confirmation:** No application behavior, migrations, RLS logic, billing, onboarding, messaging, AI, WhatsApp, or entitlements work was implemented.

## Integration Fixture Reliability Fix

- **Failure:** CI integration tests ran with real local Supabase and exposed fixture issues: previous-outstanding billing tests could carry completed appointment state between cases, and the RLS suite's other-clinic appointment fixture could fail seeding because it referenced same-clinic staff.
- **What was changed:** The previous-outstanding fixture no longer deletes or resets completed appointments. It creates a suite-level clinic/staff context and gives each test unique patient IDs, appointment IDs, and appointment times, allowing completed audit rows to remain until the local CI database is destroyed. The RLS fixture now creates a real other-clinic doctor profile for other-clinic patient, appointment, document, and note rows, and critical cleanup/seed operations fail fast instead of silently continuing with missing rows.
- **Files modified:** `tests/unit/integration/previous-outstanding-billing-rpc.test.ts`, `tests/unit/integration/rls-security.test.ts`, `docs/reports/P0_IMPLEMENTATION.md`.
- **Tests added or updated:** Updated integration fixtures only; no tests were skipped, deleted, or weakened.
- **Verification performed:** `pnpm lint` passed with 4 existing warnings and 0 errors. `pnpm typecheck` passed. `pnpm test` passed: 52 files, 286 tests. The target integration file `tests/unit/integration/previous-outstanding-billing-rpc.test.ts` passed locally with local Supabase status keys: 7 tests. A full local `pnpm test:integration` run is still affected by unrelated stale local RLS fixture data and should be verified in CI's fresh database.
- **No P1+ confirmation:** No application behavior, migrations, RLS logic, billing, onboarding, messaging, AI, WhatsApp, or entitlements work was implemented.
