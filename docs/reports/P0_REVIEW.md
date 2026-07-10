# P0 Review — Independent Verification

> **Superseded verdict:** see [Re-Review (2026-07-10)](#re-review--2026-07-10) at the end of this document for the current, final verdict.

**Reviewer role:** Principal Security Engineer / Staff Software Architect
**Date:** 2026-07-09
**Scope reviewed:** All working-tree changes on `docs/fix-readme-current-implementation` claimed as P0 in `docs/reports/P0_IMPLEMENTATION.md`, verified against `docs/AI_AGENT_PLAN.md` §3.1, §3.5, §8-P0.
**Method:** Every new migration read in full; every wrapper call site inspected; wrapper proxy behavior exercised against the real `@supabase/supabase-js` request builder; `pnpm lint`, `pnpm typecheck`, `pnpm test` re-run independently; baseline policies cross-checked against the new migration; CI workflow inspected.

---

## 1. Executive Summary

The **tenant-hardening half of P0 is substantially real**: the two cross-tenant `clinics` policies are correctly dropped, no existing migration was modified, all ~40 raw `createAdminClient()` data call sites were migrated to `createClinicScopedAdminClient(clinicId)`, the existing explicit `.eq("clinic_id", ...)` filters were kept (defense-in-depth preserved rather than replaced), and the `auth.admin.*` operations that remain unscoped by design are all preceded by RLS-verified same-clinic checks.

The **per-clinic localization half of P0 is largely simulated, not implemented**. Outside of `createAppointment`, nothing reads `clinics.timezone` — the hardcoded `CLINIC_TZ = "Europe/Istanbul"` constant was renamed to `DEFAULT_TIME_ZONE = "Asia/Kuwait"` (and in several components the literal string `"Asia/Kuwait"` was in-lined). The new `clinics.currency / locale / week_start / digits` columns are dead: no code reads them. The plan's acceptance criterion "no `CLINIC_TZ` constant remains" is satisfied in letter and violated in spirit.

The **central P0 acceptance gate — the two-clinic RLS denial suite passing in CI — is not satisfied**: the new integration assertions are well-written but have never been executed (locally or in CI; CI does not run `test:integration` and carries placeholder Supabase env), and the "migration tests" are string-matching on the SQL file, not executed SQL.

Additionally, the wrapper **fails open** for tables it doesn't recognize, does not guard `update()` payloads against `clinic_id` reassignment, and the ESLint restriction covers only `actions/**` and is trivially bypassed by a relative-path import.

**Verdict: APPROVED WITH FIXES.** The security-critical migration and call-site work should merge, but P0 must not be declared complete — and P1 must not start — until the Required Fixes below land.

---

## 2. Security Review

### 2.1 Verified sound

- **`20260709090000_fix_clinics_cross_tenant_policies.sql`** drops exactly `clinics_select_admin_all` and `clinics_insert_admin` (baseline lines 586–587) and recreates `clinics_select_own` byte-equivalent to the baseline definition (`FOR SELECT TO authenticated USING (id = auth_clinic_id())`). `clinics_update_admin` (already clinic-scoped) is untouched. No access is widened; no authenticated insert path remains. Correct per plan §3.1(1).
- **Call-site migration is complete.** `grep` confirms `createAdminClient()` appears only in `lib/supabase/admin.ts`; all 40+ former sites in `actions/patients.ts`, `actions/appointments.ts`, `actions/settings.ts`, `actions/page-permissions.ts`, `actions/package-templates.ts`, `lib/primary-admin.ts`, `lib/cache/reference-data.ts`, `app/(protected)/patients/[id]/page.tsx`, `app/(protected)/settings/staff/page.tsx` now use the scoped wrapper, **and every site retained its explicit `.eq("clinic_id", ...)` filter** — the wrapper is additive, not a replacement. Good.
- **`clinicId` provenance is trustworthy at every call site**: always `user.clinicId` from `requireRole()`/`requireUser()` (session-derived), never a request parameter.
- **`auth.admin.*` exemption is used safely today.** `deleteStaff` ([actions/settings.ts:262](../../actions/settings.ts#L262)) and `resetStaffPassword` ([actions/settings.ts:302](../../actions/settings.ts#L302)) both verify the target profile belongs to `user.clinicId` via the RLS client *before* calling `auth.admin.deleteUser` / `updateUserById`.
- **Wrapper mismatched-write rejection works**: injecting `clinic_id: otherClinic` into an `insert`/`upsert` payload throws (verified by unit test and by reading `withClinicId`).

### 2.2 Findings

**F1 (HIGH, design) — The wrapper fails open for unrecognized tables.**
`CLINIC_SCOPED_TABLES` is an allow-list; any table not in it passes through with **full unscoped service-role access and no error**. Today that includes:
- `medical_notes` and `feedback` (no `clinic_id` column — join-scoped tables), which are queried through the scoped client in `actions/patients.ts` and `actions/appointments.ts`. The call sites compensate with patient-clinic verification queries, so no active leak was found — but the wrapper contributes nothing there while *appearing* to.
- **`clinic_working_hours`, which HAS a `clinic_id` column but is missing from the set** — a query against it through the wrapper today would be silently unscoped.
- Every future tenant table (P1's `subscriptions`, P3's `conversations`/`inbound_messages` — all PHI-adjacent) unless someone remembers to add it.

The plan's requirement was that "the wrapper cannot be bypassed accidentally." Forgetting a table *is* the accidental bypass, and it is silent. The wrapper must fail closed: throw on `from(table)` for any table not on an explicit allow-list (with a documented join-scoped exception list).

**F2 (HIGH, process) — The two-clinic denial suite has never run, and CI cannot run it.**
Plan §3.1(4) and the P0 acceptance criteria require the cross-tenant denial suite to "pass in CI." Reality:
- `pnpm test` explicitly excludes `tests/unit/integration/**` ([package.json:11](../../package.json#L11)).
- `.github/workflows/ci.yml` never invokes `test:integration` and uses a placeholder Supabase URL — it cannot run it.
- The implementation report itself admits the suite was not executed locally either.
- The new migration "tests" (`tests/unit/db/p0-tenant-hardening-migrations.test.ts`) assert substrings of the SQL file. They prove the file says what it says, not that the policies behave as intended.

The single most important P0 security claim is therefore **unverified by any executed test**. The new assertions in `rls-security.test.ts` (clinic-root scoping, insert denial, cross-tenant patient/appointment/note/storage denial) are correctly written — they just need to actually run, in CI, against a real local Supabase.

**F3 (MEDIUM) — `update()` payloads can reassign `clinic_id` across tenants.**
The wrapper scopes the WHERE clause of `update` (via the appended `.eq("clinic_id", ...)`) but never inspects the SET payload. `scopedClient.from("patients").update({ clinic_id: "clinic-b", ... }).eq("id", x)` would re-home clinic A's patient row into clinic B — a cross-tenant *write* the wrapper was built to prevent. `withClinicId`'s mismatch check must also apply to `update` payloads (strip or reject `clinic_id` in SET).

**F4 (MEDIUM, pre-existing but in-scope) — cross-tenant destructive write via `permanentDeleteAppointment`.**
[actions/appointments.ts:749](../../actions/appointments.ts#L749) calls `deleteAppointmentDependents(id, user.clinicId)` **before** verifying the appointment belongs to the caller's clinic. Inside, the `feedback` delete ([actions/appointments.ts:578](../../actions/appointments.ts#L578)) filters only by `appointment_id` — `feedback` has no `clinic_id`, so the wrapper no-ops and the service role executes it unscoped. A clinic-A admin who obtains/guesses a clinic-B appointment UUID deletes clinic B's feedback rows; the subsequent appointment delete then fails harmlessly under RLS, masking the damage. (`softDeleteAppointment` verifies ownership first; `emptyAppointmentsTrash` derives ids from an RLS-scoped select — both fine.) This predates P0, but P0's remit was exactly this class of defect and the wrapper cannot see it. Fix: verify appointment ownership before cascading, and/or scope the feedback delete through an appointment-clinic join.

**F5 (MEDIUM) — ESLint restriction is far narrower than the plan and trivially avoidable.**
Plan §3.1(3): ban direct `createAdminClient()` "outside `lib/supabase/admin.ts` and an explicit allow-list file," enforced repo-wide by CI. Implemented: `no-restricted-imports` on **`actions/**` only**. Consequences:
- Any file in `app/`, `components/`, `lib/`, `hooks/` may import raw `createAdminClient` with zero lint feedback — including the two `app/(protected)/**` RSC pages that were just migrated.
- Even inside `actions/**`, `import { createAdminClient } from "../lib/supabase/admin"` (relative specifier) bypasses `paths.name` matching, as does a re-export shim or `await import(...)`.
- The compensating vitest static guard (`tests/unit/security/admin-client-static-guard.test.ts`) greps file contents (so it catches relative imports) — but it, too, scans only `actions/`.

Use `no-restricted-syntax`/`no-restricted-imports` with `patterns` at the repo level (excluding `lib/supabase/admin.ts` and a named allow-list), and widen the static-guard walk to `app/`, `components/`, `lib/`, `hooks/`.

**F6 (LOW) — `auth.admin.listUsers({ perPage: 1000 })` on the "scoped" client reads every tenant's auth users.**
[app/(protected)/settings/staff/page.tsx:24](<../../app/(protected)/settings/staff/page.tsx#L24>). Only same-clinic profiles are rendered, so no leak today, but the call pulls all tenants' emails/last-sign-ins into server memory, breaks past 1000 platform users, and the wrapper's name falsely implies it is clinic-scoped. Acceptable for P0; must be replaced (e.g., per-id `getUserById`) before multi-tenant launch.

**F7 (LOW) — the wrapper appends `?clinic_id=eq.<id>` to INSERT/UPSERT requests.**
Verified against the real supabase-js builder: `insert().eq()` produces `POST /rest/v1/patients?clinic_id=eq.a`. PostgREST ignores filters on POST, so this is dead weight rather than protection — but it is exactly the kind of provider-behavior assumption that has never been exercised against a real database (see F2). The write branch should not call `scopeQueryResult` at all (payload injection already covers writes).

**F8 (LOW) — `rpc()`, `schema()`, and `storage` pass through the proxy unscoped.**
No current call site uses them on the scoped client (verified by grep), so this is a latent, not active, hole — but a future `scopedClient.rpc(...)` or `scopedClient.storage...` would read as scoped while being service-role-unbounded. Either proxy-block them with a clear error or document the exemption in the wrapper's JSDoc.

---

## 3. Architecture Review

**A1 (HIGH) — Per-clinic localization was renamed, not threaded.**
Plan §3.5 required formatters parameterized by a `ClinicLocale` fetched per clinic (server: `getClinicLocale()`; client: extended `clinic-settings-context`), and a sweep of ~50 call sites *to those helpers*. What exists:
- `ClinicLocale` type and optional `locale?: Partial<ClinicLocale>` parameters were added to `lib/datetime.ts` / `report-formatters.ts` — but **no production caller ever passes them**. Every call resolves to `DEFAULT_CLINIC_LOCALE` (hardcoded Kuwait/ar/KWD).
- `getClinicLocale()` does not exist. `contexts/clinic-settings-context.tsx` was not extended. `clinics.locale`, `clinics.currency`, `clinics.week_start`, `clinics.digits` are **written by migration and read by nothing**.
- The sweep replaced `CLINIC_TZ` with `DEFAULT_TIME_ZONE` — and in `components/appointments/week-calendar.tsx`, `components/revenue/revenue-report.tsx` and others, with the **inline string literal `"Asia/Kuwait"`**, which is *worse* than the constant it replaced.
- The only genuine per-clinic threading is `getClinicTimeZone()` in `createAppointment` — which is correct and well done (RLS client, sane fallback).

**A2 (HIGH) — The Istanbul-vs-slots timezone inconsistency the plan called out was preserved, not fixed.**
`createAppointment` now validates closed-days/day-bounds in the *clinic's* DB timezone, but `getAvailableTimeSlots` ([actions/time-slots.ts](../../actions/time-slots.ts)) still uses the hardcoded default — including a hardcoded `+03:00` offset in `getIstanbulDayOfWeek` (the function even kept its name). For any clinic whose timezone ≠ UTC+3, slot *generation* and appointment *validation* disagree — precisely the divergence plan §2.4/§3.5 said P0 must eliminate. It is masked today only because Istanbul and Kuwait are both permanently +03.

**A3 (MEDIUM) — Backward-compatibility break for the existing deployment.**
`formatCurrency`'s default silently flipped from `en-GB`/`TRY` (`TRY 1,234.50`) to `ar`/`KWD` (`‏1,234.500 د.ك.‏` — verified with Node's ICU, including embedded RTL bidi marks in an otherwise LTR English UI). Every revenue/report surface calls it with no locale argument, so the existing (Istanbul/TRY) clinic's financial displays change currency, decimal places, and text direction on deploy, and the migration stamps that clinic `timezone='Asia/Kuwait', currency='KWD'`. If the existing tenant matters, the migration needs a backfill (`UPDATE clinics SET timezone='Europe/Istanbul', currency='TRY', locale='en' WHERE ...`) or the defaults must be threaded from the DB before this ships.

**A4 (LOW) — dead/renamed API surface.** `toIstanbul` and `startOfWeekTR` survive as misleadingly-named aliases (`startOfWeekTR` now defaults to Saturday-start — a behavior change, though it currently has zero callers). `formatNumber` ignores the locale parameter pattern its siblings adopted. Minor, but this is the API P2's i18n work will build on.

**Scope discipline: good.** No P1+ features (no signup, billing, entitlements, messaging, AI) were found. The report's file list omits `actions/doctor-dashboard.ts`, `actions/manager-dashboard.ts`, `actions/time-slots.ts`, `lib/reports/data.ts` and ~15 components (covered only by a vague catch-all line), but their diffs are all constant-rename churn within P0 scope.

---

## 4. Database Review

- **No existing migration was modified** — verified via `git status` (both migrations are untracked new files; nothing under `supabase/migrations/` is modified).
- **`20260709090000`**: correct, idempotent (`drop policy if exists`), and minimal. Recreating `clinics_select_own` identically is harmless belt-and-braces.
- **`20260709091000`**: columns match plan §3.5 (`timezone`, `currency char(3)`, `locale`, `country char(2)`, `week_start smallint`, `digits`), all `NOT NULL DEFAULT`, with CHECK constraints (`week_start BETWEEN 0 AND 6`, `digits IN ('latin','arabic')`, regex checks on currency/country). Idempotent via `if not exists` / `drop constraint if exists`. Two nits:
  - `timezone` has no validity check (any text accepted); an invalid IANA name later written by a settings form would make `date-fns-tz`/`Intl` throw at runtime inside `createAppointment`. Consider a CHECK using `now() AT TIME ZONE timezone` in a future migration, and validate in the (future) settings action.
  - The default `'Asia/Kuwait'` retroactively mislabels the existing Istanbul clinic (see A3).
- **RLS posture otherwise unchanged** — no new tables, no `SECURITY DEFINER` functions added (none were needed for P0), no grants touched.

---

## 5. Test Quality Review

- **`admin-client-scope.test.ts` — adequate but shallow.** Tests filter-append, insert injection, and mismatch rejection against a **hand-rolled fake builder**, so it verifies the proxy's dispatch, not real supabase-js semantics (it would not have caught F7). Missing negative cases: unknown-table pass-through (F1), `update` payload reassignment (F3), `rpc`/`storage` exemption (F8), upsert with array payloads.
- **`p0-tenant-hardening-migrations.test.ts` — superficial by construction.** String containment on SQL files. It pins the file contents (some regression value) but proves nothing about policy behavior. Should not be counted toward the acceptance criterion.
- **`admin-client-static-guard.test.ts` — good idea, wrong radius.** Content-grep over `actions/` catches what the lint rule misses there (relative imports), but leaves `app/`, `lib/`, `components/`, `hooks/` unguarded — same gap as F5.
- **`rls-security.test.ts` extensions — the best tests in the change** (clinic-root read scoping, authenticated insert denial, four-boundary cross-tenant denial including storage download), correctly seeded with a second clinic's appointment. **But they have never executed** (F2). Until they run green against a real database, they are documentation.
- **Regression coverage gap:** the plan required "booking conflict tests still green with clinic TZ ≠ server TZ." No test sets a clinic timezone different from the default and exercises `createAppointment` vs `getAvailableTimeSlots` — the exact scenario where A2 bites.
- Independently re-ran: `pnpm lint` (0 errors / 4 pre-existing warnings), `pnpm typecheck` (clean), `pnpm test` (49 files / 276 tests, all pass). The report's claims about these commands are accurate.

---

## 6. Risks

| # | Risk | Severity | Likelihood |
|---|---|---|---|
| R1 | New tenant table added in P1/P3 without updating `CLINIC_SCOPED_TABLES` → silent unscoped service-role access to PHI-adjacent data (F1) | Critical impact | High — it already happened once (`clinic_working_hours`) |
| R2 | RLS behavior regressions ship undetected because the denial suite never runs in CI (F2) | High | Certain until CI is fixed |
| R3 | Clinic in a non-UTC+3 timezone onboards in P1 → bookable slots and validation disagree; appointments land on wrong local days (A1/A2) | High | Certain for any such tenant |
| R4 | Existing clinic's financial reports flip to KWD/Arabic formatting on deploy (A3) | Medium | Certain on deploy |
| R5 | Developer adds raw `createAdminClient` in `app/` or `lib/` — no lint, no test catches it (F5) | High | Medium |
| R6 | `update`-payload clinic reassignment or the `feedback` cascade is triggered by a future bug or malicious staff account (F3/F4) | High | Low today |

---

## 7. Required Fixes

Blocking (must land before P0 is called complete / P1 begins):

1. **Make the wrapper fail closed** (F1): `from(table)` throws for any table not on an explicit allow-list; add `clinic_working_hours` to the scoped set; document `medical_notes`/`feedback` as join-scoped exceptions requiring caller-side clinic verification.
2. **Execute the denial suite and wire it into CI** (F2): run `pnpm test:integration` against local Supabase (`supabase start`) at least once now, and add a CI job (services or `supabase start` in the workflow) so the two-clinic suite gates every merge — this is the plan's explicit acceptance criterion.
3. **Guard `update()` payloads** against `clinic_id` reassignment in the wrapper (F3).
4. **Fix `permanentDeleteAppointment`** to verify appointment ownership before `deleteAppointmentDependents`, and clinic-scope the `feedback` cascade (F4).
5. **Widen the lint ban and static guard repo-wide** with an explicit allow-list file; add a `patterns` entry so relative-path imports are caught (F5).
6. **Complete — or honestly re-scope — the localization threading** (A1/A2/A3): at minimum, make `getAvailableTimeSlots` use the same `clinics.timezone` as `createAppointment` (removing the `+03:00` literal), remove the inline `"Asia/Kuwait"` string literals in components, and backfill the existing clinic's `timezone/currency/locale` so behavior doesn't change on deploy. If full formatter threading is deferred, the P0 report must say so explicitly rather than claiming the sweep was done.

Non-blocking (before multi-tenant launch):

7. Drop the useless `.eq()` on insert/upsert in the wrapper (F7); block or document `rpc`/`schema`/`storage` pass-through (F8).
8. Replace `auth.admin.listUsers(1000)` on the staff page with per-id lookups (F6).
9. Add a TZ-mismatch regression test (clinic TZ ≠ server TZ ≠ default) for `createAppointment` + `getAvailableTimeSlots`.
10. Validate `clinics.timezone` as a real IANA zone at write time.

---

## 8. Verdict (2026-07-09 — superseded by the Re-Review below)

**APPROVED WITH FIXES.**

The blocking tenant-isolation work (policies migration, wrapper adoption with retained explicit filters, auth-admin pre-checks, no touched migrations, no scope creep) is genuine and merge-worthy. But P0's own acceptance criteria are not yet met: the cross-tenant denial suite has never executed anywhere, the wrapper fails open for unlisted tables, the lint ban covers a fraction of the intended surface, and the "per-clinic timezone/currency/locale" deliverable is at present a hardcoded-default rename with dead database columns. Items 1–6 in §7 are mandatory before P0 can be declared done or any SaaS customer is onboarded; shipping P1 on top of the current state would rebuild the same single-point-of-failure the plan set out to eliminate.

---

# Re-Review — 2026-07-10

**Method:** Every fix re-verified directly in code, not from the implementation report. Wrapper re-read line by line; ESLint rule probed with live `eslint --stdin` runs (alias import in `app/`, relative-path import in `components/` — both rejected); `pnpm lint` (0 errors), `pnpm typecheck` (clean), and `pnpm test` (50 files, 283 tests, all green) re-run independently; CI workflow, all three migrations, and the new/updated tests read in full.

## Verification of previous findings

| Finding | Status | Evidence |
|---|---|---|
| **F1** — wrapper fails open for unknown tables | **FIXED** | `assertKnownTable()` throws on any table outside the clinic-scoped or join-scoped allow-lists ([lib/supabase/admin.ts:57](../../lib/supabase/admin.ts#L57)); `clinic_working_hours` added to the scoped set; `feedback`/`medical_notes` documented as join-scoped caller-verified exceptions. Fail-closed behavior covered by unit tests (unknown table throws; join-scoped table gets no fake `clinic_id` filter). |
| **F2** — denial suite not run, not in CI | **PARTIALLY FIXED** | CI now installs the Supabase CLI, runs `supabase start` (which applies all migrations), exports local keys, and runs `pnpm test:integration` as a required step before build. The wiring is correct. **But the suite has still never executed anywhere** — Docker is unavailable locally (reproduced by this reviewer: daemon down), and these changes are uncommitted, so no CI run exists yet. See Remaining Issues. |
| **F3** — `update()` payload could reassign `clinic_id` | **FIXED** | The `update` branch calls `assertNoMismatchedClinicId(payload)` for clinic-scoped tables ([lib/supabase/admin.ts:167](../../lib/supabase/admin.ts#L167)); regression test rejects `update({ clinic_id: "clinic-b" })`. |
| **F4** — cross-tenant cascade in `permanentDeleteAppointment` | **FIXED** | The action now verifies via the RLS client that the appointment exists in the caller's clinic **and is trashed** (`.not("deleted_at","is",null)`) before `deleteAppointmentDependents` runs. Regression test asserts no `feedback`/`appointment_services` deletes are attempted when the lookup returns nothing. |
| **F5** — lint ban / static guard too narrow | **FIXED** | ESLint rule now covers `actions/`, `app/`, `components/`, `hooks/`, `lib/` with `lib/supabase/admin.ts` as the only exception, and adds `patterns` (`**/lib/supabase/admin`, `**/supabase/admin`) that catch relative-path imports — verified live with `eslint --stdin` probes in both `app/` and `components/`. The vitest static guard now content-greps the same five roots with the same single-file allow-list, catching re-export shims and dynamic imports too. |
| **F6** — `auth.admin.listUsers(1000)` on staff page | **DEFERRED (acceptable)** | Unchanged, as the original review permitted for P0; correctly documented as a pre-multi-tenant-launch requirement. |
| **F7** — dead `.eq()` on insert/upsert | **FIXED** | Insert/upsert rely solely on payload injection; no filter appended (verified in wrapper code and by test assertion). |
| **F8** — `rpc`/`schema`/`storage` pass-through | **FIXED** | All three throw on property access with a clear redirect message; covered by test. |
| **A1** — localization not threaded | **HONESTLY RE-SCOPED** | No false completeness claim remains: the implementation report now states display-surface threading is incomplete. Correctness-critical booking paths are genuinely per-clinic (see A2). Display formatters still fall back to defaults; `clinics.locale/currency/week_start/digits` remain unread by UI code. Tracked as a remaining (non-security) P0 gap. |
| **A2** — slot generation vs validation TZ mismatch | **FIXED** | `getAvailableTimeSlots` now fetches `clinics.timezone` via the RLS client with the same fallback as `createAppointment`'s `getClinicTimeZone()`; the hardcoded `+03:00` literal and `getIstanbulDayOfWeek` are gone — weekday, day bounds, and blocked-range conversion all use the clinic zone. New regression test exercises a non-UTC+3 zone (`America/New_York`). Both halves of the booking path now read the same DB value. |
| **A3** — existing deployment currency/TZ flip | **FIXED** | New migration `20260710090000_backfill_legacy_clinic_localization.sql` backfills pre-2026-07-10 clinic rows to Istanbul/TRY/en/TR/Monday, and `DEFAULT_CLINIC_LOCALE` was restored to the legacy Istanbul/TRY/en values, so no display behavior changes on deploy. New clinics still get the Arab-market DB defaults. Verified `formatCurrency`'s effective default is again `en`/`TRY`. |
| **A4** — misleading alias names | **DEFERRED (acceptable)** | `toIstanbul`/`startOfWeekTR` remain as thin aliases; `startOfWeekTR` has zero callers; cosmetic only. |
| **DB nit** — no IANA validity check on `clinics.timezone` | **DEFERRED (acceptable)** | No user-facing write path for `timezone` exists in P0; must be added with the future settings UI. |

Also re-confirmed: the three P0 migrations are new untracked files and **no existing migration was modified**; `createAdminClient` appears nowhere outside `lib/supabase/admin.ts`; no `Asia/Kuwait`/`CLINIC_TZ` literals remain in app code; no P1+ scope crept in during the fix pass.

## Remaining Issues

1. **The two-clinic RLS denial suite has still never produced a green run.** The CI wiring is correct and complete (Supabase CLI setup, `supabase start`, key export, `pnpm test:integration` as a required step), but it could not be executed locally (Docker daemon unavailable — reproduced by this reviewer) and no CI run of this branch exists yet. The plan's acceptance criterion is that the denial suite **passes** in CI, not that it is wired into CI. P0 sign-off is conditional on observing the first green `test:integration` run (CI or local `supabase start`) — no code changes expected if it passes.
2. **Per-clinic locale threading of display surfaces remains incomplete relative to plan §3.5.** `clinics.currency`, `locale`, `week_start`, and `digits` are written by migration but read by no production code; report/date formatters accept a `ClinicLocale` but no caller passes one. This is now honestly documented rather than claimed done, and it has no tenant-isolation impact — but it is in-plan P0 scope: either finish the threading in a focused follow-up pass or formally re-scope it in the plan before P0 is declared closed.

Carried-forward pre-launch items (unchanged, correctly documented, not P0-blocking): replace `auth.admin.listUsers({perPage:1000})` on the staff page; validate `clinics.timezone` as a real IANA zone when a settings write path is added.

## Final Verdict

**APPROVED WITH FIXES**

All eight security findings (F1–F8) are resolved or acceptably deferred exactly as required; the timezone-consistency defect (A2) and the backward-compatibility break (A3) are genuinely fixed; the guardrails (fail-closed wrapper, repo-wide lint ban, widened static guard, deletion-ownership check, update-payload guard) were verified working by direct probing and test execution, not by trusting the report. The two Remaining Issues above are what stands between this and APPROVED: one green execution of the integration denial suite, and closure (or formal re-scoping) of the display-locale threading. Neither requires new security work.
