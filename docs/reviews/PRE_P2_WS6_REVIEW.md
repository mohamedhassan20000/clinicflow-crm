# Pre-P2 WS6 Review — Back Navigation and Breadcrumbs

**Status:** REVIEWED  
**Workstream:** WS6 (`docs/PRE_P2_POLISH.md` §7-WS6)  
**Review cycle:** 1  
**Review date:** 2026-07-13  
**Final verdict:** **APPROVED FOR MERGE**

This is the authoritative WS6 review record. Later reviews must preserve Review Cycle 1,
retain stable finding IDs, and append history rather than replace it.

## Review Cycle 1

### 1. Implementation scope

Reviewed the shared page header, local/allowlisted return-URL helper, operator Clinics and
Reports navigation, patient directory/detail/edit/report flows, appointment-create return,
tenant reports, settings breadcrumbs, and protected revenue return against the approved
WS6 scope. Staff details and invitations were confirmed to have no current detail route;
subscription/billing detail remains inside operator clinic detail.

WS7 report filtering, WS8 clinic history, P2 localization, business logic, schema, RLS,
authorization, subscription, entitlement, audit, and unrelated redesign work are absent.

### 2. Exact files changed

Product code:

- `app/(operator)/operator/clinics/page.tsx`
- `app/(operator)/operator/clinics/[id]/page.tsx`
- `app/(operator)/operator/reports/page.tsx`
- `app/(operator)/operator/reports/[reportId]/page.tsx`
- `app/(protected)/appointments/page.tsx`
- `app/(protected)/appointments/new/page.tsx`
- `app/(protected)/patients/[id]/page.tsx`
- `app/(protected)/patients/[id]/edit/page.tsx`
- `app/(protected)/patients/[id]/appointments-report/page.tsx`
- `app/(protected)/patients/[id]/followups-report/page.tsx`
- `app/(protected)/patients/[id]/medical-notes-report/page.tsx`
- `app/(protected)/patients/new/page.tsx`
- `app/(protected)/patients/archive/page.tsx`
- `app/(protected)/patients/trash/page.tsx`
- `app/(protected)/revenue/page.tsx`
- `app/(protected)/settings/layout.tsx`
- `components/appointments/appointment-form.tsx`
- `components/appointments/day-calendar.tsx`
- `components/appointments/displaced-appointments.tsx`
- `components/appointments/month-calendar.tsx`
- `components/appointments/new-appointment-layout.tsx`
- `components/appointments/week-calendar.tsx`
- `components/patients/archive-table.tsx`
- `components/patients/patient-form.tsx`
- `components/patients/patient-report-header.tsx` (new)
- `components/patients/patient-table.tsx`
- `components/patients/trash-table.tsx`
- `components/reports/report-page-header.tsx`
- `components/settings/settings-page-header.tsx` (new)
- `components/shared/page-header.tsx` (new)
- `lib/navigation/return-url.ts` (new)
- `lib/supabase/admin.ts`

Tests/documentation:

- `tests/unit/lib/return-url.test.ts` (new)
- `tests/unit/components/page-header.test.tsx` (new)
- `tests/unit/components/patient-return-navigation.test.tsx` (new)
- `tests/unit/components/settings-page-header.test.tsx` (new)
- `tests/e2e/smoke.spec.ts`
- `docs/reports/PRE_P2_WS6_IMPLEMENTATION.md` (new)
- `docs/reviews/PRE_P2_WS6_REVIEW.md` (new)

### 3. Acceptance-criteria checklist

- [x] Every audited detail/drill-down route has a known stable parent or documented N/A
- [x] No page relies only on browser history for Back/Cancel navigation
- [x] Operator Clinics search/country state survives list → detail → list
- [x] Patient filters/pagination survive list → detail → nested report/edit navigation
- [x] Appointment view/filter/date state survives calendar → new appointment → calendar
- [x] Return URLs are local and validated against exact allowed parent pathnames
- [x] Unauthorized archive/trash parents are not exposed to doctor/manager roles
- [x] Shared, non-conflicting header and patient-report patterns replace page-specific copies
- [x] Tenant report header infrastructure is safely reused and consolidated
- [x] Settings breadcrumbs identify the current nested page
- [x] Breadcrumb depth is at least two on nested pages and current page is announced
- [x] Back control precedes `h1`, has a visible label, and uses a semantic anchor
- [x] Keyboard focus/Enter and visible focus styling verified
- [x] 390px mobile containment and desktop layout verified
- [x] Light and dark themes verified
- [x] Existing RLS, tenancy, RBAC, platform-admin authorization, permissions, middleware,
      signup, billing, subscription, entitlement, and audit behavior preserved
- [x] No WS7, WS8, P2, Arabic, RTL, `next-intl`, schema, or unrelated refactor introduced
- [x] Targeted tests, full unit suite, typecheck, lint, production Playwright, build, and
      `git diff --check` pass

### 4. Validation commands and exact results

| Command | Result |
|---|---|
| `pnpm exec vitest run tests/unit/lib/return-url.test.ts tests/unit/components/page-header.test.tsx tests/unit/components/patient-return-navigation.test.tsx tests/unit/components/settings-page-header.test.tsx` | **PASS** — 4 files, 12 tests |
| `pnpm test` | **PASS** — 89 files, 478 tests (final run: 16.59s) |
| `pnpm typecheck` | **PASS** — exit 0; no diagnostics |
| `pnpm lint` | **PASS WITH WARNINGS** — 0 errors; 4 pre-existing warnings |
| `PORT=3102 node --env-file=.env.local node_modules/@playwright/test/cli.js test --workers=1 --grep "WS6"` in filesystem sandbox | **INFRASTRUCTURE FAIL** — `tsx` IPC listen returned `EPERM`; tests did not start |
| Same Playwright command with approved local-server/browser permission | **PASS** — clean production build/start; Chromium 2/2 in 25.7s |
| `git diff --check` | **PASS** — no whitespace errors (final run below) |

Browser assertions covered keyboard operation, query restoration, breadcrumbs, patient
date-filter retention, 390px containment, and both themes. The production server emitted
the known pre-existing last-login `42501` warning; it did not affect either passing flow.

### 5. Security and permission review

- Return input is rejected unless it is a local path with an exact route-specific allowed
  pathname; external and protocol-relative URLs fall back to the stable parent.
- The return path is rendered as a Link, never used as a server redirect or data-query key.
- Patient archive/trash parent links are limited to existing admin/receptionist access.
- Platform-admin clinic filtering remains metadata-only through the reviewed helper.
- Detail routes retain their existing `requireUser`, `requireRole`, platform-admin layout,
  tenant predicates, doctor assignment/department checks, and `notFound` behavior.
- No authorization, RLS, middleware, schema, billing, subscription, or audit file changed.

### 6. Required findings

All required findings discovered during implementation are resolved:

- **PREP2-WS6-R1 — RESOLVED:** detail pages used inconsistent ad-hoc back/header markup;
  consolidated onto `PageHeader` and two scoped wrappers.
- **PREP2-WS6-R2 — RESOLVED:** operator clinic and patient detail links lost list query
  state; source URLs are now encoded and restored through validated `returnTo`.
- **PREP2-WS6-R3 — RESOLVED:** patient and appointment Cancel buttons relied on
  `window.history.back()`; they now use stable semantic links.
- **PREP2-WS6-R4 — RESOLVED:** an initial broad patient-parent allowlist could have shown
  archive/trash parents to a manager; the final allowlist restricts them to admin and
  receptionist roles.

### 7. Optional polish findings

- **PREP2-WS6-P1 — OPEN (NON-BLOCKING):** URL-owned state is restored, but explicit scroll
  position and transient component open/closed state are not. This is outside the approved
  WS6 requirement and does not affect filters, pagination, sorting, or date ranges.

### 8. Known limitations

- Operator Clinics remains under its existing 500-row bound; pagination is not added.
- Staff and invitation detail routes do not exist, so there is no breadcrumb target to add.
- Browser history still functions normally, but scroll restoration is browser/framework
  dependent because stable parent links intentionally do not invoke history-only Back.

### 9. Git state

- Current branch: `main`, tracking `origin/main`.
- The dirty working tree intentionally contains preserved WS0–WS5 work and WS6 changes.
- Staging area is empty; no commit, push, merge, new branch, reset, restore, stash, clean,
  overwrite, or staging action occurred.

### 10. Final verdict

**APPROVED FOR MERGE**

All required WS6 criteria and validation pass. The sole open item is optional scroll-state
polish and does not block approval. Stop here; WS7 was not started.

## Re-review history

- **Review Cycle 1 — 2026-07-13:** initial WS6 implementation review. Four required
  findings resolved; one non-blocking optional polish finding remains open.
