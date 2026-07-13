# Pre-P2 WS6 Implementation Report — Back Navigation and Breadcrumbs

**Workstream:** WS6 — Back navigation and breadcrumbs  
**Implementation date:** 2026-07-13  
**Branch:** `main`  
**Scope boundary:** WS6 only; WS7 and later workstreams were not started.

## Scope implemented

- Added one shared page-header pattern for stable parent links, semantic breadcrumbs,
  page titles/descriptions, leading visuals, and page actions.
- Added a local return-URL utility that composes list state into detail URLs and validates
  the destination against a route-specific parent allowlist.
- Preserved operator Clinics search and country state through list → detail → list.
- Preserved patient search, page, department, and other URL filters through list → detail,
  plus nested edit, report, and new-appointment flows.
- Preserved appointment view, date/week/month, status, doctor, department, and patient
  filters through calendar → new appointment → calendar.
- Consolidated the six tenant report headers and three patient-report headers.
- Replaced browser-history-only Cancel controls on patient and appointment forms with
  stable, visible links supplied by their route.
- Added settings breadcrumbs and a stable Dashboard return link without widening settings
  roles or changing the existing tab navigation.
- Normalized the protected revenue drill-down onto the shared header.

## Audited pages

| Surface | Route(s) | WS6 result |
|---|---|---|
| Operator Clinics | `/operator/clinics`, `/operator/clinics/[id]` | Search/country state carried in validated `returnTo`; shared detail header |
| Operator reports | `/operator/reports`, `/operator/reports/[reportId]` | Stable Reports return and three-level breadcrumb |
| Patient directory | `/patients`, `/patients/new`, `/patients/archive`, `/patients/trash` | Stateful detail/new links; shared nested headers |
| Patient detail | `/patients/[id]`, `/patients/[id]/edit` | Role-appropriate parent allowlist; nested list state retained |
| Patient reports | appointments, follow-ups, and medical-notes report routes below `/patients/[id]` | Shared report header; patient/list state survives date-filter changes |
| Appointments | `/appointments`, `/appointments/new` | Calendar/view/filter state carried to new form; stable Cancel/Back |
| Tenant reports | all six `/reports/*` report pages | Existing report header consolidated onto shared header |
| Settings | staff, departments, services, packages, insurance, clinic, customize | `Dashboard / Settings / Current page` breadcrumb and stable return |
| Revenue drill-down | `/revenue` | Shared Dashboard return and breadcrumb |
| Staff details | dialog/sheet within Settings | No detail route; existing close/focus behavior retained, so route breadcrumb is N/A |
| Invitations | operator single-page list/create surface | No detail route; N/A |
| Subscription/billing details | sections within `/operator/clinics/[id]` | Covered by the clinic-detail header; no separate parent route exists |
| Other protected/operator pages | dashboards, follow-ups, profile, preferences, coupons, operator invitations/settings, onboarding | Audited as top-level or flow pages; no conflicting detail breadcrumb added |

## Architecture decisions

1. `PageHeader` always renders the stable Back link before the `h1` in DOM order. It
   optionally renders a semantic breadcrumb and composes existing leading/actions content.
2. URL state uses `returnTo`, not browser history and not `from`, because patient reports
   already use `from`/`to` date parameters.
3. `resolveReturnTo` accepts only local URLs whose exact pathname is in the destination
   route's allowlist. External, protocol-relative, overly long, malformed, and unrelated
   routes fall back to the known parent.
4. Nested returns are encoded recursively: a patient report returns to the patient detail,
   and that patient detail still returns to the filtered patient list.
5. Parent permissions stay route-owned. The helper only renders an allowed Link and never
   redirects, queries data, or replaces middleware/RBAC checks.
6. Existing list state remains URL-owned. No new client store, cookie, database column,
   schema, or dependency was introduced.

## Reusable components introduced

- `components/shared/page-header.tsx`
  - stable labelled Back link
  - `nav[aria-label="Breadcrumb"]` and ordered list
  - `aria-current="page"` current crumb
  - optional leading content and actions
  - logical spacing, 44px minimum Back target, light/dark tokens, visible focus styles
- `components/patients/patient-report-header.tsx`
  - shared patient identity/count/print composition over `PageHeader`
- `components/settings/settings-page-header.tsx`
  - pathname-to-label mapping for all authorized settings sub-pages
- `lib/navigation/return-url.ts`
  - `pathWithSearch`, `withReturnTo`, and allowlisted `resolveReturnTo`

## Files changed

### Product code

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

### Tests and documentation

- `tests/unit/lib/return-url.test.ts` (new)
- `tests/unit/components/page-header.test.tsx` (new)
- `tests/unit/components/patient-return-navigation.test.tsx` (new)
- `tests/unit/components/settings-page-header.test.tsx` (new)
- `tests/e2e/smoke.spec.ts`
- `docs/reports/PRE_P2_WS6_IMPLEMENTATION.md` (new)
- `docs/reviews/PRE_P2_WS6_REVIEW.md` (new)

## Query-state preservation behavior

- Operator clinic source URL retains `q` and validated two-letter `country`.
- Patient source URL retains all live parameters exposed by the directory, including
  name/general search, file/national ID/phone, page, department, and doctor.
- Appointment source URL retains view, day/week/month anchor, status, doctor, department,
  and patient search fields.
- Patient report date filters clone the current query string before changing `from`/`to`,
  so their nested `returnTo` remains intact.
- Invalid or unauthorized return paths fall back to the known route parent. Query state is
  retained only for an allowlisted pathname.
- Scroll position and non-URL ephemeral component state are not explicitly restored.

## Accessibility behavior

- Back is a semantic anchor with a visible `Back to …` label and matching accessible name.
- Breadcrumbs use `nav`, `aria-label="Breadcrumb"`, an ordered list, and
  `aria-current="page"`.
- Back precedes the page `h1` in source order and has a minimum 44px target.
- Native link keyboard behavior is retained; focused Back links were exercised with Enter.
- `focus-visible` outlines are explicit and remain theme-token based.
- Layout uses wrapping, minimum-width protection, and logical `pe-*` spacing; Playwright
  verified no body overflow at 390px in light and dark themes.

## Security and permission preservation

- No migration, schema, RLS, middleware, entitlement, billing action, subscription action,
  audit behavior, signup behavior, or page-permission configuration changed.
- Operator clinic filtering stays in the existing reviewed metadata-only admin helper and
  does not read clinical tables.
- Patient archive/trash parents are allowlisted only for admin/receptionist roles. Doctors
  and managers can receive only the ordinary Patients parent.
- Settings keeps `requireRole(["admin", "manager"])`; Customize retains its existing
  primary-admin checks.
- Every destination route still performs its existing RBAC, tenant, and record-access checks.
- Return URLs cannot become open redirects and cannot name a non-allowlisted parent route.

## Tests executed and exact results

| Command | Exact result |
|---|---|
| `pnpm exec vitest run tests/unit/lib/return-url.test.ts tests/unit/components/page-header.test.tsx tests/unit/components/patient-return-navigation.test.tsx tests/unit/components/settings-page-header.test.tsx` | PASS — 4 files, 12 tests |
| `pnpm test` | PASS — 89 files, 478 tests |
| `pnpm typecheck` | PASS — exit 0, no diagnostics |
| `pnpm lint` | PASS with warnings — 0 errors, 4 pre-existing warnings |
| `PORT=3102 node --env-file=.env.local node_modules/@playwright/test/cli.js test --workers=1 --grep "WS6"` (sandbox attempt) | INFRASTRUCTURE FAIL — local `tsx` IPC listen returned `EPERM`; no browser test ran |
| Same Playwright command with approved local-server/browser permission | PASS — production `next build` + `next start`; Chromium 2/2 passed in 25.7s |
| `git diff --check` | PASS — no whitespace errors; final post-document run recorded in the review |

The Playwright flows verify operator clinic filters, list/detail/back query state, semantic
breadcrumbs, keyboard Enter behavior, default light theme, switched dark theme, 390px body
containment, patient list/detail/report nesting, and report date-filter retention.

## Known limitations

- Stable links preserve URL-owned state but do not explicitly restore scroll position or
  transient open/closed component state.
- Operator Clinics remains bounded by the pre-existing 500-row safety limit. WS6 adds
  search/country filtering but intentionally does not add WS7 pagination/report filtering.
- Staff and invitation details have no routes in the current product, so their existing
  dialog/single-page close behavior is unchanged.
- The production E2E log contains the pre-existing `last_login_update_failed` (`42501`)
  warning already documented in earlier reviews; both WS6 flows passed.

## Git status

- Current branch: `main`, tracking `origin/main`.
- Working tree: intentionally dirty with preserved WS0–WS5 work plus the WS6 files above.
- Staging area: empty; `git diff --cached --name-only` returns no paths.
- The pre-existing WS4 deletion of `components/layout/currency-selector.tsx` remains intact.
- No commit, push, merge, branch creation, staging, reset, restore, stash, clean, or overwrite
  operation was performed.
