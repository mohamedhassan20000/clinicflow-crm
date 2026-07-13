# Pre-P2 Product Polish Sprint — Plan & Audit

**Status:** APPROVED — all §21 decisions resolved 2026-07-13; ready for implementation
**Date:** 2026-07-13 (updated 2026-07-13 with approved decisions)
**Single source of truth:** this file is the only planning document for the sprint. No additional implementation-order document (e.g. `PRE_P2_IMPLEMENTATION_ORDER.md`) may be created; §8 *is* the implementation order.
**Scope of this document:** Planning and auditing only. No code changes accompany it.
**Position in roadmap:** Between the merged P1.5 phase (`docs/reviews/P1.5_PHASE_REVIEW.md`, APPROVED FOR COMMIT AND MERGE) and P2 (Arabic-first i18n & RTL) in `docs/AI_AGENT_PLAN.md`. Everything here is UX/product polish plus one functional bug; nothing changes the security model, the RLS-first architecture, or phase numbering.
**Review contract:** every sub-workstream follows the established review-file workflow — implementation → `docs/reviews/<WORKSTREAM>_REVIEW.md` with stable finding IDs → fix cycle → merge.

---

## 1. Executive summary

P1.5 delivered the mechanics of a premium product — collapsible shell, operator analytics, marketing site, display currency, E.164 phones — but a hands-on pass over the running product shows the *finish* is not there yet: the landing page reads as a competent template rather than a trustworthy healthcare brand; an admin in an existing test clinic hits the generic `app/(protected)/error.tsx` boundary on the dashboard; the sidebar collapse control renders half-hidden; the currency preference sits in the wrong place with a 12-currency ceiling; the phone/country selector covers 9 countries with no search; tables have no shared primitive and headers that melt into rows; the appointment calendar is too faint to scan; drill-down pages strand the user with no way back; operator reports have no filters; and the operator clinic page shows a fraction of the clinic's commercial story.

This sprint fixes all of that in **10 focused workstreams (WS0–WS9)** across **9 branches**, ordered so the one true bug lands first and the largest visual rebuild (marketing) lands independently of everything else. Two workstreams require small **additive** schema/infra changes and are called out explicitly (§12, §13): expanding the currency registry (larger `fx_rates` coverage, no monetary column changes) and clinic operational notes/history (one new operator-only table, optional). No canonical financial record is rewritten anywhere in this sprint. Estimated effort: **14–20 dev-days**.

---

## 2. Current problems observed (audit findings)

Audited on `main` at `cf240b3` (P1.5D merged). File references are to the current tree.

### 2.1 Marketing site (`app/page.tsx` → `components/marketing/marketing-page.tsx`, copy in `lib/marketing-copy.ts`)
- The entire page is a single 68-line component with one-line JSX sections — hero, one dark "product" strip, three feature cards, one trust band, a pricing stub, the early-access CTA, FAQ, footer. There is **no product-preview imagery beyond a hand-built mock card**, no workflow storytelling, no security/compliance section with substance, no social proof, and the visual system (teal-950 on `#f7faf9`, amber accent band) is generic SaaS rather than healthcare.
- **The real ClinicFlow logo (`/brand/clinicflow-mark.png`, used on the login page and the dashboard sidebar `components/layout/sidebar.tsx:69`) does not appear on the marketing site** — the header renders a `Sparkles` lucide icon in a teal box (`marketing-page.tsx:26`). Brand inconsistency on the most public surface.
- Known carried polish from P1.5C (stable IDs in `docs/reviews/P1.5C_REVIEW.md`): P15C-P2 (no canonical/OG/robots/sitemap), P15C-P3 (dark-theme session sees mixed light/dark on `/`), P15C-P4 (`/` fully dynamic per request).
- The performance gate `docs/P15C_PERFORMANCE_GATE.md` (3× mobile Lighthouse ≥90 perf / ≥90 a11y on the production build) currently passes at 96/90/92 after the P15-R1 dynamic-import fix — a redesign must re-clear it, not inherit it.

### 2.2 Dashboard error (bug)
- An admin in an existing test clinic sees "Something went wrong" — the generic boundary at `app/(protected)/error.tsx`, which only logs to the browser console and shows the digest. Server-side detail goes to Sentry/`console.error` only.
- `app/(protected)/dashboard/page.tsx` (admin branch) fires **20 parallel Supabase queries** plus `getCachedStaff`/`getCachedDepartments` (admin-client, `lib/cache/reference-data.ts`) and destructures results **without checking any `error` field** — a single failed query yields `data: null` (handled by `?? []`), but a *thrown* rejection from the cached-reference `.then()` chains, `fetchReceptionInSessionBoard`, or `fetchDoctorDashboardStats` crashes the whole page. The page also still uses Istanbul-pinned date helpers (`DEFAULT_TIME_ZONE`) locally.
- The protected layout (`app/(protected)/layout.tsx`) additionally loads `profiles.display_currency` + `fx_rates` per request — a second candidate failure point for clinics created before the P1.5D migrations or environments with an incomplete migration chain.
- §7 WS0 defines the investigation protocol. This is a **blocking bug**, not a cosmetic-fallback candidate.

### 2.3 Sidebar collapse control (`components/layout/sidebar.tsx:71-81`)
- The toggle button is positioned `absolute inset-e-0 top-1/2 translate-x-1/2` — deliberately overhanging the sidebar's edge by half its width into the sibling content column. Nothing clips inside the `aside`, but the content column's **sticky header (`dashboard-shell.tsx:70`, `z-30`, opaque `bg-card/95`) paints over the overhanging half** (the button has no z-index), and `main`'s `overflow-x-hidden` can clip it during layout shifts. Result: a visually "cut" control.
- The hit target is `size-7` (28 px) — below the 44 px minimum both WCAG 2.5.8 and our own shell conventions (`min-h-11` nav items) target. Keyboard focus works (`focus-visible:outline-2`) but the focus ring is also painted over.

### 2.4 Currency preference (`components/layout/currency-selector.tsx`, mounted at `dashboard-shell.tsx:74`)
- A per-user display preference (persisted via `updateDisplayCurrency`, `actions/profile.ts:101` → `profiles.display_currency`) is presented as a **global header control**, visually adjacent to the theme toggle — it reads as "the clinic's currency," which it is not. The clinic's canonical operating currency lives on `clinics.currency` and is not editable anywhere in the UI.
- The registry (`lib/currency/registry.ts`) is a hardcoded list of **12 currencies**; `isSupportedCurrency` gates the server action, and the FX provider (`lib/currency/open-exchange-rates.ts`) requests exactly those symbols. A plain `Select` with 12 items; no search.
- Conversion behavior itself is sound (`lib/currency/conversion.ts`: pure, canonical-preserving, `≈` marking, 48h stale / 72h suppress) and must be preserved.

### 2.5 Country & phone selector (`lib/phone/registry.ts`, `components/shared/international-phone-input.tsx`)
- `PHONE_COUNTRIES` is **9 countries** (GCC + Egypt + Türkiye + US). A user with a UK, German, French, Indian, Pakistani, Filipino… number cannot enter it: `normalizePhone` returns `null` for any country outside the list, and server-side validation inherits the same gate. Known carried finding P15D-P4: legacy GB/DE/FR E.164 values *degrade in the editor* today.
- The selector is a plain `Select` — no search box, no type-ahead, no first-letter jump.
- Phone-entry surfaces confirmed by grep: `components/auth/early-access-form.tsx`, `components/auth/clinic-signup-form.tsx`, `app/(operator)/operator/invitations/page.tsx` (InternationalPhoneField), `components/patients/patient-phone-input.tsx` (create + edit), `components/settings/clinic-form.tsx`, `components/settings/staff-form.tsx`, `components/profile/profile-page.tsx`. All must move together.

### 2.6 Tables
- **There is no `components/ui/table.tsx`** — the shadcn Table primitive was never added. ~20 files render raw `<table>` markup with per-file styling (grep list in §11): patients tables, staff tables, all five tenant reports, revenue, follow-ups, settings CRUD pages, operator coupons/invitations/clinics, and `components/operator/report-shell.tsx` (thead: `bg-muted/50`, `font-medium text-muted-foreground` — headers barely distinct from rows).
- No shared treatment for sticky headers, hover/selected rows, dark-mode header contrast, responsive overflow, or empty/loading states; each page reinvents or omits them.

### 2.7 Calendar readability (`components/appointments/week-calendar.tsx`, `day-calendar.tsx`, `month-calendar.tsx`)
- Measured from the week view: grid lines at `border-border/20` and `/30` (20–30 % opacity), hour labels at `text-[9px] text-muted-foreground/50` (9 px at 50 % opacity — far below WCAG 1.4.3 contrast for text), day headers `bg-muted/30 text-muted-foreground`, break rows `bg-muted/40` with 9 px labels. No current-time indicator. Working vs. non-working hours are distinguished only by the faint break band. Same opacity idioms in the day view.

### 2.8 Back navigation
- Grep confirms back affordances exist **only** on the three patient sub-report pages (`app/(protected)/patients/[id]/*-report/page.tsx`) and breadcrumb-ish links on patients archive/trash/[id]. **`app/(operator)/operator/clinics/[id]/page.tsx` has no back link, no breadcrumb** — the operator must use browser history. `app/(operator)/operator/reports/[reportId]/page.tsx` likewise. Filters/query params on list pages are lost on return.

### 2.9 Operator reports (`lib/operator-reports/registry.ts`, `components/operator/report-shell.tsx`)
- Seven registry reports (clinics, users, invitations, revenue, subscriptions, activity, growth) with **no filters, no sorting, no pagination, no URL state, and a hard 1000-row `.limit()`** (carried P15B-R13). Export CSV exists per report. Empty state is a bare "No records."

### 2.10 Operator clinic detail (`app/(operator)/operator/clinics/[id]/page.tsx`)
- Shows: name/country/timezone/created/onboarding line, **current** subscription (single `subscriptions` row — the schema keeps one row per clinic, so there is *no subscription history table*), feature overrides, last 12 usage counters, manual grant/cancel forms. Missing: invitation lineage, coupon redemptions, trial history, grant/extension timeline (derivable from `platform_audit_logs`), plan-change history (only partially derivable), notes, payments/contracts (which **do not exist in the schema** — see §6 and §9-WS9 for honest placeholder rules).

---

## 3. Confirmed bugs

| ID | Severity | Description | Where |
|---|---|---|---|
| **BUG-1** | **Blocking** | Admin dashboard in an existing test clinic renders the generic error boundary. Root cause not yet identified — WS0 is the investigation. | `app/(protected)/dashboard/page.tsx`, `app/(protected)/layout.tsx`, `app/(protected)/error.tsx` |
| **BUG-2** | Required | Sidebar collapse toggle is painted over by the sticky header (appears clipped/broken); hit target 28 px | `components/layout/sidebar.tsx:71-81`, `components/layout/dashboard-shell.tsx:70` |
| **BUG-3** | Required | Legacy non-registry E.164 phone values (GB/DE/FR…) degrade when opened in the phone editor (carried P15D-P4) — fixed structurally by the global registry (WS3) | `lib/phone/registry.ts`, `components/shared/international-phone-input.tsx` |

Everything else in this sprint is polish/product work, not a bug.

---

## 4. UX and product improvements (summary)

1. **Marketing site redesigned from the ground up** to the professionalism/trust bar of clinicmind.com (structure and quality reference only — no copied branding, text, assets, or layout) — §9 WS9.
2. **Currency preference relocated** to a new user-accessible **Settings → Preferences** section (all staff roles) with an explicit canonical-vs-display distinction and a searchable currency selector limited to live-FX-supported currencies — §9 WS4.
3. **Global country/phone selector** with search, type-ahead, and all libphonenumber-supported countries across all 7 entry surfaces — §9 WS3.
4. **Shared table system** (shadcn Table primitive + a `DataTable` treatment) replacing ~20 bespoke tables — §9 WS2.
5. **Calendar readability pass** in both themes without visual heaviness — §9 WS5.
6. **Reusable back-navigation/breadcrumb pattern** with preserved query state — §9 WS6.
7. **Per-report filters, URL state, pagination, sorting** for the operator Reports module — §9 WS7.
8. **Complete (honest) clinic history** on the operator clinic page — §9 WS8.

---

## 5. Scope boundaries

**In scope:** UI/UX polish, one bug investigation/fix, additive registry expansions, derived history views over existing tables, filter/pagination plumbing on operator reports, marketing rebuild including placeholder Privacy/Terms pages and a seeded-demo screenshot pipeline.

**Out of scope (hard):**
- Rewriting or converting any **canonical monetary value** (`paid_amount`, deposits, settlements…). Display conversion only, exactly as P1.5D shipped it.
- Any payment-gateway, contract, or invoicing feature. The schema has no payments/contracts; WS8 must not pretend otherwise.
- i18n/RTL work (P2). New components must, however, keep the P1.5 convention: **logical properties only** (`ms-/me-/ps-/pe-/text-start`), no new physical-direction classes — this is a hard acceptance criterion on every workstream so P2B's inventory doesn't grow.
- Changing RLS policies, middleware gate order, signup/billing semantics, or anything in `supabase/migrations` except the explicitly listed additive items (§12, §13).
- Changing the appointment domain model, status machine, or slot logic.

---

## 6. Items explicitly deferred to P2 or later

| Item | Why deferred | Target |
|---|---|---|
| Translated marketing site / Arabic landing page | Depends on next-intl infrastructure | P2A/P2C |
| Localized currency & country names (beyond `Intl.DisplayNames` English) | P2 locale plumbing | P2C |
| Real testimonials, case studies, customer logos | No customers yet — placeholders only, clearly non-fabricated (§9 WS9) | Post-launch |
| Published pricing table with real numbers | Plans not finalized (per approved P1 copy) | Pre-GA |
| Payment history, invoices, contracts on the operator clinic page | **Requires billing-provider integration — no schema support today.** Rendered as an explicitly labeled "available after billing integration" section, never fake data | P-billing (post-P2 decision) |
| `subscription_events` append-only history table | True plan-change history needs a new table + write hooks in `grantManualSubscription`/`cancelManualSubscription`; the audit log already captures operator actions, which is enough for now | Optional WS8 extension or P-billing |
| **`clinic_notes` operator notes table** | **Deferred by decision (2026-07-13, resolves former Q3).** Not part of this sprint: no schema, no UI, no placeholder behavior. Recorded as future Operator CRM functionality | Future Operator CRM phase |
| Settings → Preferences "Language" entry | The Preferences section (WS4) ships with Display Currency + Theme; the Language preference joins it with next-intl | P2A |
| Hijri calendar display, Arabic-Indic digit polish on the calendar | P2 per plan §4.4 | P2C |
| Report scheduling/emailing | New product scope | P3+ |
| Collapse-state cookie (P15A-P2), theme cookie hardening (P15A-P6/P7) | Carried P1.5A polish; only picked up here if trivially adjacent in WS1 | opportunistic |

---

## 7. Proposed workstreams

### WS0 — Dashboard error investigation & fix (BLOCKING BUG)
**Goal:** identify and fix the real cause; improve error/empty-state handling so a partially configured clinic never sees a blank generic failure.

Investigation protocol (in order, evidence before action):
1. **Reproduce** against the affected test clinic locally (`supabase status` for local keys; e2e server on `PORT=3100` — see validation-suite memory). Capture the **server** error (terminal / Sentry event by digest), not just the boundary UI.
2. **Bisect by role branch:** the page renders 4 distinct dashboards. Confirm which branch throws (admin per report).
3. **Suspect list, checked in order:**
   - `getCachedStaff` / `getCachedDepartments` (`lib/cache/reference-data.ts`) — admin-client calls whose rejection is not caught in the `Promise.all` `.then()` chains at `dashboard/page.tsx:321,334,340`.
   - `fetchReceptionInSessionBoard` / `fetchDoctorDashboardStats` — server actions invoked as data fetchers; any `throw` inside crashes the RSC.
   - `app/(protected)/layout.tsx:33-36` — `profiles.display_currency` / `fx_rates` load on a clinic/user predating P1.5D columns (stale migration state on the test environment).
   - Subscription/trial gate interplay: a clinic with a **missing subscriptions row** (created before P1's `create_clinic_with_owner`) fails P1B's fail-closed gates — verify whether the middleware redirects or the page throws.
   - Empty/partially configured clinic: zero departments, zero doctors, null `department_id` — verify each aggregate helper tolerates empties (they appear to, via `?? []`, but confirm against the real digest).
   - Local-timezone date math (`toIstanbul`, `monthBounds`) producing invalid ranges on the host machine.
4. **Fix the root cause** — not the symptom. Then harden: check `error` on the destructured query results that feed required UI, add graceful empty states for empty clinics (zero-data dashboard must render meaningfully), and enrich `app/(protected)/error.tsx` copy (what to do next; digest retained). **A cosmetic fallback that hides the failure is explicitly forbidden.**
5. **Regression test:** integration or e2e fixture for "fresh empty clinic renders every role dashboard" + a unit test for whichever helper actually failed.

### WS1 — Sidebar collapse control fix
- Keep the overhang design (it's a good pattern) but make it render: add `z-40` (above the `z-30` header) or move the button into the shell so it layers correctly; verify no ancestor `overflow` clips it in expanded, collapsed, and mid-transition states.
- Enlarge the effective hit area to ≥44 px (visual size may stay smaller via an inset icon; use padding or a pseudo-target).
- Verify: keyboard (Tab reachable, Enter/Space toggles, visible focus ring not overpainted), `aria-expanded` already correct, desktop + tablet breakpoints (`md:` boundary where the sheet takes over), light + dark themes, RTL (`rtl:-translate-x-1/2` already present — keep).
- Existing e2e (`tests/e2e/smoke.spec.ts` dashboard-shell test) extended with a collapsed-state assertion and a visual-position sanity check (bounding box fully visible).

### WS2 — Reusable table system
- Add the shadcn **Table** primitive (`components/ui/table.tsx`) via the CLI, then a thin shared treatment (either styled primitives or a light `DataTable` wrapper in `components/shared/`) that encodes, once:
  - **Header:** distinct background (`bg-muted` at full opacity, not `/50`), `font-semibold`, `text-foreground` (not muted), a stronger bottom border (`border-b-2` or `border-border` full-opacity) vs. `border-border/50` row dividers — a real border hierarchy.
  - Cell spacing/alignment conventions (numeric right/`text-end`, `tabular-nums`), row hover (`hover:bg-muted/50`), selected state, optional sticky header (`sticky top-0` inside the scroll container) for long lists (patients, operator reports).
  - Dark-mode verified header contrast; responsive `overflow-x-auto` wrapper as part of the component, never per page.
  - Shared **empty state** (icon + one-line explanation + primary action where applicable) and **loading skeleton** slots.
- Migrate consumers mechanically, starting with the operator panel (`report-shell.tsx`, coupons, invitations, clinics) and the highest-traffic tenant tables (patients, staff, reports). Full grep inventory in §11. No page-specific table styling may remain in migrated files.

### WS3 — Global country & phone selector
- **Registry:** derive `PHONE_COUNTRIES` from `libphonenumber-js` `getCountries()` (already a dependency — no new metadata payload beyond what ships today; verify bundle deltas, see §16). Per country: ISO code, English name via `Intl.DisplayNames("en", { type: "region" })`, dialing prefix via `getCountryCallingCode`, flag emoji computed from the ISO code (regional-indicator arithmetic — no asset downloads). Keep a small **priority group** (KW, SA, AE, QA, BH, OM, EG, TR) pinned at the top of the list for the target market.
- **Component:** replace the `Select` in `international-phone-input.tsx` with a **Command-based combobox** (`components/ui/command.tsx` + `popover.tsx` already exist): search input filters on name / ISO code / dial code; type-ahead jumps/filters on first letters; full keyboard navigation (arrows, Enter, Escape) comes with cmdk. Trigger stays compact (flag + dial code).
- **Server-side:** widen `isPhoneCountry`/`normalizePhone` to all supported countries and sweep `lib/validations/` so server enforcement matches the UI exactly. **E.164 storage, validation, and the backfill's preserve-unparseable guarantees are unchanged.** This structurally fixes P15D-P4 (legacy GB/DE/FR values now round-trip).
- **Surfaces:** all 7 (§2.5). `defaultCountry` still flows from clinic country where known (signup fallback at `actions/auth.ts:399` preserved). Address carried P15D-P7 (signup clinic-country vs. phone-country selects are independent) by defaulting phone country to the chosen clinic country until the user overrides.
- Localized search (Arabic country names) is **P2** — the component API takes a locale but ships English-only now.

### WS4 — Currency preference placement (Settings → Preferences) & expanded currency registry
**Approved placement decision (2026-07-13, resolves former Q2):** the personal display-currency preference lives in a **new user-accessible Settings → Preferences section** — *not* in the dashboard header, *not* inside admin-only Clinic Settings, and *not* on the Profile page.

- **Remove** `CurrencySelector` from the shell header (`dashboard-shell.tsx:74`).
- **New route `app/(protected)/settings/preferences/page.tsx`** ("Settings → Preferences"), containing personal, per-user preferences:
  1. **Display currency** — the per-user preference (`profiles.display_currency`), clearly labeled: "affects how amounts are shown **to you**, as approximate conversions (≈); clinic records are never changed." Uses the existing server action (`updateDisplayCurrency`), same persistence, same permission (`requireMutationUser` — any authenticated clinic user). A short read-only note states the clinic's canonical operating currency (`clinics.currency`) so the canonical-vs-personal distinction is taught exactly where the preference is edited.
  2. **Theme** — surface the existing light/dark preference here as well (same persistence as the header toggle; the header `ThemeToggle` may remain as a shortcut — no behavior change).
  3. **Language** — *placeholder position only*; the actual control arrives with P2A next-intl (§6). No i18n code in this sprint.
- **Access:** the page is available to **all authenticated staff roles** (admin, manager, doctor, receptionist). Because the Settings area's nav visibility is permission-gated, WS4 must verify doctors/receptionists can reach Preferences **without** gaining access to admin-only Clinic Settings sub-pages — either via a role-independent Settings entry that shows only Preferences, or a direct "Preferences" link in the header user menu (`dashboard-shell.tsx` dropdown). Page-permission changes are limited to exposing this one page; no admin surface is widened.
- **Canonical currency:** stays read-only everywhere. Changing `clinics.currency` is *not* offered (it would misstate historical records — out of scope). Optionally, Settings → Clinic may display the canonical currency as read-only clinic metadata; it hosts no personal preference.
- **Registry (approved coverage decision, resolves former Q5):** the selector exposes **only currencies supported by the configured live FX provider AND the app's tested formatting/conversion path** — the offerable list is the **intersection of the registry and provider coverage**, derived or validated safely (build-time generation from ISO 4217 minor-unit data + a provider-coverage check; the provider's all-or-nothing snapshot rule in `open-exchange-rates.ts:16` adjusted deliberately for the wider symbol set). **Unsupported ISO currencies that cannot convert reliably are not exposed.** The registry stays extensible: adding a currency means adding/validating one entry, never touching the conversion path. Currency names via `Intl.DisplayNames(..., { type: "currency" })`, symbols from `Intl.NumberFormat` parts; the current 12 entries stay hand-verified. Selector becomes a searchable Command combobox (shared pattern with WS3).
- **Unavailable/expired FX behavior is already correct and stays:** original canonical values preserved, `≈` approximate marking, `· stale rate` >48h, suppression >72h (`lib/currency/conversion.ts`). Canonical financial data is never rewritten.
- `updateDisplayCurrency` keeps validating against the (expanded, provider-intersected) registry server-side. `fx_rates` table shape is unchanged; only row count grows (cron route `app/api/cron/fx-rates` untouched semantically).

### WS5 — Calendar readability (approved 2026-07-13 as specified)
Approved scope: stronger but balanced grid-line contrast; clearer hour labels (size, weight, opacity); readable time slots in both themes; visible current-time indicator; today-column distinction; working vs. non-working hour hierarchy; appointment and selected-slot contrast; WCAG-conscious contrast — all without making the calendar visually heavy or cluttered.

Audit + retune all three views (`week-calendar.tsx`, `day-calendar.tsx`, `month-calendar.tsx`) against a defined token set rather than per-file opacities:
- **Grid lines:** two-level hierarchy — hour lines at ~`border-border/60`, day/column separators at full `border-border`; drop the current /20–/30 range.
- **Hour labels:** ≥11 px, `text-muted-foreground` at full opacity, `font-medium tabular-nums` — must pass WCAG 1.4.3 (4.5:1) in both themes.
- **Day headers:** solid `bg-muted` + `text-foreground font-semibold`; today's column header keeps the primary treatment and today's *column body* gets a subtle tint (`bg-primary/5`).
- **Current-time indicator:** add a line across today's column (primary color, 2 px, small dot on the time axis) — none exists today.
- **Working vs. non-working hours:** working hours stay on the card background; non-working/break bands get a clearer fill (`bg-muted/70` + diagonal-stripe or label at readable size) so free working slots are identifiable at a glance.
- **Events:** verify appointment-card text contrast per status color in dark mode; hover state (`hover:` elevation/border) and a selected-slot state for the create flow.
- Deliverable includes a **before/after screenshot pair per view per theme** in the review file. Objective: readable, not heavy — no added shadows/chrome, contrast comes from line weight, opacity, and typography only.

### WS6 — Back navigation & breadcrumbs
- New shared `components/shared/page-header.tsx` (or extend the existing `report-page-header.tsx` pattern): title block + **Back link** rendered as a real `<a>`/`Link` to a **stable parent route** (never `history.back()` alone), + optional breadcrumb trail (`nav aria-label="Breadcrumb"` + `ol`, current page `aria-current="page"`).
- **Query preservation:** list pages already keep state in the URL (e.g. `/appointments?week=`); detail links pass the source list's current query string through (`?from=` param or serialize the list URL), and the Back link restores it. Where no `from` is present, fall back to the canonical parent route.
- Surfaces to retrofit (audit list): operator clinics/[id] ("← Clinics"), operator reports/[reportId] ("← Reports"), patients/[id] (+ its three sub-reports — normalize the existing ad-hoc back links onto the shared component), patients new/edit, appointments/new, staff (dialog-based today — breadcrumb N/A), settings sub-pages (breadcrumb "Settings / Clinic" etc.), invitations (single-page — N/A unless WS8 adds detail views).
- Keyboard/AT: back control precedes the h1 in DOM order, is focusable, and has an accessible name including the destination ("Back to clinics").

### WS7 — Operator report filters
Extend `lib/operator-reports/types.ts` with a declarative `filters` array per report definition; `ReportShell` renders them generically; state lives **in the URL** (shareable, restorable — dovetails with WS6 query preservation). Per-report matrix (only filters that are meaningful — no universal filter bar):

| Report | Filters | Default | Sort | Notes |
|---|---|---|---|---|
| Clinics | country, onboarding state, created date-range | all, last 90d | created desc | |
| Users | clinic, latest-signup date-range | all | user_count desc | count-only; stays PHI-free |
| Invitations | status, clinic, created date-range, email-sent yes/no | pending first, last 30d | created desc | |
| Revenue | plan, subscription status, renewal (period-end) date-range | active+trialing | period_end asc | canonical USD only |
| Subscriptions | status, provider, plan, trial-ending date-range | all | period_end asc | trial-status filter = status `trialing` + `trial_ends_at` window |
| Activity | action, target type, date-range | last 7d | time desc | |
| Growth | date-range (month granularity) | last 12 months | month asc | |
| (all) | — | — | — | usage-metric and feature-entitlement filters are deferred until a usage report exists; do not bolt them onto unrelated reports |

- **Pagination:** server-side `range()` pagination (25/50/100) replaces the flat 1000-row cap — closes carried P15B-R13. **Export** honors the active filters but not pagination (bounded by a documented export cap, e.g. 10 000 rows, streamed).
- **Permissions:** every query path already re-guards with `requirePlatformAdmin()`; filters are added inside those functions, never as raw client-supplied SQL fragments (validated enums/dates via zod).
- **Empty states:** distinguish "no data at all" from "no rows match these filters" (with one-click clear-filters).
- **Performance:** confirm indexes for the new predicates (`clinic_invitations(status, created_at)`, `subscriptions(status, current_period_end)`, `platform_audit_logs(created_at)`); add additive index migrations only if `EXPLAIN` shows sequential scans at realistic volumes.

### WS8 — Complete clinic history (operator clinic detail)
Restructure `app/(operator)/operator/clinics/[id]/page.tsx` into sections, with an explicit data-honesty legend. Classification per user requirement:

**Already available in the schema (render directly):**
- Clinic profile: name, country, timezone, locale, currency, created_at, onboarding_completed_at (+ working-hours summary — metadata only, no PHI).
- Current subscription: plan, status, trial_ends_at, period start/end, provider (all shown today; keep).
- Invitations: the `clinic_invitations` row(s) tied to this clinic — request date, status transitions, email_sent_at, accepted_at.
- Coupons: `coupon_redemptions` joined to `coupons` for this clinic.
- Feature overrides: as today.
- Usage history: `usage_counters` (extend from 12 rows to a filterable/paginated list via the WS2 table).

**Derivable safely (render as a computed timeline, labeled "derived from audit log"):**
- Manual grants/extensions/cancellations, override changes, invitation resends — from `platform_audit_logs` filtered by target clinic. This *is* the subscription/renewal/trial history to the extent the platform has one, since `subscriptions` is a single mutable row per clinic.
- Trial history: creation event + trial_ends_at changes from the same log.
- **Audit timeline section** = the merged, time-ordered view of all of the above.

**Deferred by decision (2026-07-13, resolves former Q3 — not in this sprint):**
- **Operational notes (`clinic_notes` table):** deferred as future Operator CRM functionality (§6). WS8 ships **read-only** — no notes schema, no notes UI, no notes placeholder behavior.
- True immutable `subscription_events` history: **deferred** (§6) — the audit-log-derived timeline is the honest v1.

**Requires future billing-provider integration (placeholder only, explicitly labeled):**
- Historical payments, invoices, renewals-as-transactions, contracts/contract references. Render a quiet "Payments & contracts — available after billing integration" placeholder. **Never synthesized, never mocked as real data.**

**Hard rule:** no patient PHI on any operator surface — new queries limited to platform tables + clinic metadata + count-only aggregates; extend the existing no-PHI integration test to the new queries.

### WS9 — Marketing-site redesign
Reference standard: **clinicmind.com for level of professionalism, trust, information architecture, and conversion structure only.** No copied branding, copy, assets, illustrations, code, or verbatim layout. All existing security boundaries (RPC-only early-access submission, rate limiting, middleware exemption at `lib/supabase/middleware.ts:115`) are untouched — this is a presentation rebuild on the same wiring.

**Design direction (per the frontend-design pass — final tokens decided at implementation, not defaulted):**
- Identity anchored on the **real ClinicFlow logo** (`/brand/clinicflow-mark.png`) in header and footer, matching login and dashboard — one brand everywhere. Derive the marketing palette from the mark + the product's teal family so screenshots of the actual product don't clash with the page.
- The signature element is the **product itself**, shown through real screenshots (approved decision, resolves former Q1 — see the screenshot pipeline below). Generic illustrations or invented/fake product UI must **not** be the primary product preview.

**Product-screenshot pipeline (approved 2026-07-13):**
- **Seeded demo clinic:** a dedicated, repeatably seeded demo clinic with realistic but entirely fictional data — believable patient names, appointments across statuses, revenue figures, follow-ups. **No real patient PHI, ever** — the seed script is the only data source, and the demo clinic never receives real records.
- **Capture standards:** consistent browser viewport(s) (one desktop, one mobile crop size, documented), consistent theme per composition, clean state (no toasts, no dev overlays), captured against a production build.
- **Framing & delivery:** polished, consistent framing (browser/device chrome or clean card frame — one treatment across the page); assets stored under `public/marketing/`; served via `next/image` with explicit dimensions and `sizes` for responsive selection; AVIF/WebP with sane budgets (§16); descriptive, non-decorative `alt` text on every screenshot describing what the UI shows.
- **Refresh process (repeatable):** a documented, scripted flow — reset/seed the demo clinic, run a Playwright screenshot script (or documented manual capture recipe with the same viewport/theme constants), re-optimize, replace assets — recorded in the review file so screenshots can be re-captured whenever the product UI changes. Stale screenshots that misrepresent the current UI are treated as a content bug.
- Typography: keep `font-display`/DM Sans stack coherence with the app but set a deliberate scale; avoid the current template-y oversized-hero-only hierarchy.

**Page structure (top to bottom):**
1. **Navigation:** logo + wordmark, Product, Features, Security, Pricing, FAQ, Log in, primary CTA ("Request early access"). Sticky, translucent, mobile sheet (exists — restyle).
2. **Hero:** positioning headline for private-clinic operations (healthcare SaaS voice: calm, trustworthy, specific), subline, primary CTA → early-access modal, secondary → product tour anchor; product-preview composition as the visual; trust assurances line (role-based access, no card, guided onboarding — carried from current copy, rewritten).
3. **Social proof strip:** placeholder-honest — early-access cohort framing ("Onboarding a limited cohort of clinics each week", live progress from `get_public_registration_status()` — already wired) instead of fabricated logos/testimonials. Real testimonials slot in post-launch (§6).
4. **Product-preview / workflow storytelling:** 3–4 alternating sections walking a clinic day — scheduling (calendar shot), front desk (patient record/timeline), billing & packages, reports — each with a concrete screenshot and 2–3 benefit bullets. This replaces the single abstract "product" strip.
5. **Feature grid:** 6 cards max (appointments, patient records, billing, follow-ups, reports, team & roles), copy grounded in what the product actually does.
6. **Trust & security section (substantive):** multi-tenant isolation, row-level security, role-based access, audit trail, data export — the real architecture, stated plainly; this is the section healthcare buyers read. No compliance claims we don't hold (no "HIPAA certified" etc.).
7. **Pricing placeholder:** honest "plans being finalized with early clinics" section, structured to become a 3-tier table later without layout change.
8. **Early-access conversion band:** existing modal flow (`EarlyAccessForm`, dynamic-imported — keep the P15-R1 fix), weekly-progress meter, restyled.
9. **FAQ:** accordion (upgrade `details` styling or shadcn accordion), 6–8 questions.
10. **Footer:** logo, tagline, contact email, Log in, and links to the Privacy Policy and Terms of Service pages (below).
11. **Legal placeholder pages (approved decision, resolves former Q4):** professional placeholder pages for **Privacy Policy** and **Terms of Service** (e.g. `app/(public)/privacy/page.tsx`, `app/(public)/terms/page.tsx`), linked from the footer. Each page: clean typographic layout consistent with the marketing design, an honest structure (sections for data handling, access, contact), and a **clearly visible notice that final legal text is pending legal review**. Hard rule: **no invented definitive legal commitments, compliance claims (HIPAA/PDPL certification etc.), retention policies, or contractual terms** — placeholder language describes intent, never binds.

**Language (approved decision, resolves former Q6):** the redesigned site is **English-only** in this sprint. No `next-intl`, no Arabic copy, no RTL implementation, no other P2 scope. Copy stays centralized in `lib/marketing-copy.ts` so P2 translation is mechanical.

**Motion principles:** one orchestrated hero entrance + restrained scroll-reveals on section entry; hover micro-interactions on cards/CTAs; everything behind `prefers-reduced-motion` (the existing reduced-motion e2e must keep passing); no scroll-jacking; CSS-first (no animation library unless justified against the performance gate).

**Mobile behavior:** every section defined mobile-first; product screenshots get mobile crops (not shrunken desktop images); nav sheet; CTA reachable within first viewport; tap targets ≥44 px.

**Accessibility:** maintain Lighthouse a11y 100 — semantic landmarks, one h1, heading order, contrast ≥4.5:1 on all new palette pairs, focus-visible on all interactive elements, accessible names on icon buttons, dialog focus trap (shadcn provides), `alt` on all product imagery.

**Performance constraints (`docs/P15C_PERFORMANCE_GATE.md` is the contract):** 3× mobile Lighthouse ≥90 performance and ≥90 accessibility on the production build, re-recorded in the gate doc with date/commit. Practical budgets: hero image as optimized `next/image` (AVIF/WebP, priority, explicit dimensions), LCP ≤ 2.5 s target, no new client-side JS beyond the existing dialog/sheet islands (page stays an RSC shell; screenshots are static assets, not iframes), initial script transfer ≤ current ~259 KB, fonts already self-hosted. Also close carried P15C-P2 (canonical/OG image/robots/sitemap metadata) and P15C-P3 (force a coherent light theme on `/` for dark-theme sessions, or ship a true dark variant) here; evaluate P15C-P4 (static/ISR rendering of `/` with the registration status fetched client-side or short-revalidate) as part of the performance work.

---

## 8. Recommended implementation order

1. **WS0** — dashboard bug (blocking; everything else waits only on this being *started*, not finished)
2. **WS1** — sidebar fix (tiny, high-visibility)
3. **WS2** — table system (foundation for WS7 and WS8 UIs)
4. **WS3** — global phone/country (shared combobox pattern built here…)
5. **WS4** — currency placement + world registry (…reused here; also removes a header control, so do after WS1's shell pass)
6. **WS5** — calendar readability (independent; can run parallel to WS3/WS4)
7. **WS6** — back navigation (independent; before WS7 so report URLs restore cleanly)
8. **WS7** — operator report filters (needs WS2 table + WS6 URL conventions)
9. **WS8** — clinic history (needs WS2 + WS6; last of the operator work)
10. **WS9** — marketing redesign (fully independent; may run in parallel with WS2–WS8 at any point; largest single item)

## 9.1 Work classification

- **Blocking bugs:** WS0 (BUG-1).
- **Required pre-P2 polish:** WS1 (BUG-2), WS2, WS3 (incl. BUG-3), WS4, WS5, WS6, WS7, WS9.
- **Optional polish:** sticky headers beyond patients/operator lists; P15A-P2 collapse cookie; P15C-P4 static rendering; P15-P1 shared money-composer extraction (natural to fold into WS4); P15-P2 hidden-input cleanup (fold into WS3); P15-P3 double fetch (fold into WS4).
- **Deferred product features:** everything in §6.

## 9.2 Suggested branch and PR boundaries

Focused branches, one review file each — no oversized branch:

| Branch | Workstreams | Est. days |
|---|---|---|
| `fix/pre-p2-dashboard-error` | WS0 | 1–2 |
| `fix/pre-p2-sidebar-toggle` | WS1 | 0.5 |
| `feat/pre-p2-table-system` | WS2 | 2–3 |
| `feat/pre-p2-global-phone` | WS3 | 1.5–2 |
| `feat/pre-p2-currency-settings` | WS4 (+P15-P1/P3 folds) | 1.5–2 |
| `feat/pre-p2-calendar-readability` | WS5 | 1–1.5 |
| `feat/pre-p2-back-navigation` | WS6 | 1–1.5 |
| `feat/pre-p2-operator-report-filters` | WS7 | 2–3 |
| `feat/pre-p2-clinic-history` | WS8 | 1.5–2 |
| `feat/pre-p2-marketing-redesign` | WS9 | 3–5 |

(WS1 may be folded into the WS0 PR if both are trivial and touch disjoint files; otherwise keep separate.)

## 10. Dependencies between workstreams

- WS7 → WS2 (table), WS6 (URL-state conventions).
- WS8 → WS2 (tables), WS6 (back link), and reads WS7's filter primitives for the usage list (soft).
- WS4 → WS3 (shared searchable-combobox pattern) and WS1 (header layout change lands once).
- WS9 → none (independent; only shares the early-access form, which it must not functionally change).
- WS0 → none, but its findings may adjust WS4's layout-level currency loading (P15-P3 fold).

## 11. Files and components likely affected (per workstream)

- **WS0:** `app/(protected)/dashboard/page.tsx`, `app/(protected)/layout.tsx`, `app/(protected)/error.tsx`, `lib/cache/reference-data.ts`, `actions/doctor-dashboard.ts`, `actions/receptionist-dashboard.ts`, possibly a migration-state fix on the test environment only.
- **WS1:** `components/layout/sidebar.tsx`, `components/layout/dashboard-shell.tsx`, `tests/e2e/smoke.spec.ts`.
- **WS2:** new `components/ui/table.tsx`, new `components/shared/data-table.tsx` (+ empty/skeleton subcomponents); migrations of: `components/operator/report-shell.tsx`, `app/(operator)/operator/{coupons,invitations,clinics}/page.tsx`, `components/patients/{patient-table,archive-table,trash-table,appointments-report-list}.tsx`, `components/settings/{staff-table,staff-by-department,settings-trash-section}.tsx`, `components/reports/*-report.tsx` (5), `components/revenue/revenue-report.tsx`, `components/followups/followups-view.tsx`, `components/appointments/appointments-recycle-bin.tsx`, `app/(protected)/settings/{departments,packages,insurance,services}/page.tsx`, `app/(protected)/patients/[id]/*-report/page.tsx`.
- **WS3:** `lib/phone/registry.ts`, `components/shared/international-phone-input.tsx`, `lib/patient-phone.ts`, `lib/validations/*` (phone schemas), the 7 consumer surfaces (§2.5), related unit + e2e tests.
- **WS4:** new `app/(protected)/settings/preferences/page.tsx` + preferences components (`components/settings/preferences-*.tsx`), `lib/currency/registry.ts`, `lib/currency/open-exchange-rates.ts` (provider-coverage intersection), `components/layout/{currency-selector,dashboard-shell}.tsx` (header removal; user-menu Preferences link), `lib/page-permissions.ts` / settings nav (expose Preferences to all roles without widening admin pages), `actions/profile.ts` (validation only), `contexts/clinic-settings-context.tsx` + `lib/currency/server.ts` (P15-P1 shared composer), `app/(protected)/layout.tsx` (P15-P3 cache()).
- **WS5:** `components/appointments/{week,day,month}-calendar.tsx`, possibly shared tokens in `app/globals.css`.
- **WS6:** new `components/shared/page-header.tsx`; edits to `app/(operator)/operator/clinics/[id]/page.tsx`, `app/(operator)/operator/reports/[reportId]/page.tsx`, `app/(protected)/patients/[id]/**`, `app/(protected)/appointments/new/page.tsx`, `app/(protected)/patients/{new,archive,trash}/page.tsx`, settings sub-pages, `components/reports/report-page-header.tsx` (consolidate).
- **WS7:** `lib/operator-reports/{types,registry}.ts`, `components/operator/report-shell.tsx`, `app/(operator)/operator/reports/**`, export route, optional additive index migration.
- **WS8:** `app/(operator)/operator/clinics/[id]/page.tsx`, `lib/supabase/admin.ts` (new platform queries), no-PHI integration tests. Read-only — no new migrations, no notes code (`clinic_notes` deferred, §6).
- **WS9:** `components/marketing/marketing-page.tsx` (rebuilt, likely split into `components/marketing/*` sections), `lib/marketing-copy.ts` (rewritten), `app/page.tsx` (metadata), new `app/(public)/privacy/page.tsx` + `app/(public)/terms/page.tsx` (legal placeholders), demo-clinic seed script + screenshot capture script (`scripts/` or `tests/e2e/marketing-screenshots`), new static assets under `public/marketing/`, `public/brand/` reuse, `app/robots.ts`/`app/sitemap.ts` (P15C-P2), `docs/P15C_PERFORMANCE_GATE.md` (re-recorded), marketing e2e specs.

## 12. Reusable component & architecture decisions

1. **One table system** (`ui/table` + `shared/data-table`) — no page-local table CSS after WS2.
2. **One searchable-combobox pattern** (cmdk-based) shared by the country picker (WS3) and currency picker (WS4) — build once in WS3.
3. **One page-header/back/breadcrumb component** (WS6) replacing the three ad-hoc back links and `report-page-header.tsx`.
4. **One money-composition helper**: extract the duplicated `≈ converted (canonical)` string builder from `contexts/clinic-settings-context.tsx:72-77` and `lib/currency/server.ts:20-24` into `lib/currency/format.ts` (closes P15-P1; pre-positions P2C translation keys).
5. **Registries stay single-source:** phone registry derives from libphonenumber, currency registry from ISO/Intl data — no second hand-maintained list may appear.
6. **Declarative report definitions:** filters/sort/pagination live in `OperatorReportDefinition`, rendered generically — adding a report never means new UI code.
7. **Logical CSS properties only** in all new/edited components (P2B protection).
8. **Marketing sections as server components**, interactivity confined to the existing dialog/sheet islands; copy stays centralized in `lib/marketing-copy.ts` (i18n-ready for P2).

## 13. Security & multi-tenancy guardrails

- **No RLS policy, middleware, or gate-order changes.** Any workstream that finds itself touching `middleware.ts`, `lib/supabase/middleware.ts`, or a policy must stop and escalate (matches the P1.5 review contract).
- New schema is limited to: optional additive indexes (WS7) only — `clinic_notes` is deferred out of the sprint (§6). Any index migration goes through normal review; nothing touches tenant tables' policies or monetary columns.
- Operator surfaces (WS7, WS8): every new query path guards with `requirePlatformAdmin()`; **no patient PHI** — platform tables, clinic metadata, and count-only aggregates exclusively; extend the existing no-PHI integration suite over each new query.
- Public surface (WS9): early-access submission stays on the reviewed RPC boundary with per-IP fail-closed rate limiting; `/` exposes only `get_public_registration_status()`'s three approved fields; no new anon-readable data.
- Phone/currency server actions keep server-side validation as the source of truth (`normalizePhone` on the server, `isSupportedCurrency` against the expanded registry); client widening never outruns server enforcement.
- Admin-client usage stays behind the scoped wrapper/lint ban established in P0; WS8's new platform queries live in `lib/supabase/admin.ts` alongside the existing operator queries.
- Secrets posture unchanged: FX keys/CRON_SECRET stay in `server-only` modules; no `NEXT_PUBLIC_` additions.

## 14. Accessibility requirements (all workstreams)

- WCAG 2.1 AA as the floor: text contrast ≥4.5:1 (calendar hour labels and table headers are the current violators), UI-component contrast ≥3:1, focus visible everywhere, no keyboard traps.
- Hit targets ≥44 px for primary controls (sidebar toggle, calendar slot targets, mobile nav).
- Combobox components: proper `role="combobox"`/listbox semantics (cmdk provides), label via `aria-label`, announced result counts where feasible.
- Breadcrumbs: `nav[aria-label="Breadcrumb"]` + ordered list + `aria-current="page"`.
- Tables: real `<th scope="col">`, caption or labelled region per table, sortable headers as buttons with `aria-sort`.
- Marketing: retain Lighthouse accessibility 100 (gate), reduced-motion respected (existing e2e), heading hierarchy, landmark structure.
- Light **and** dark theme verification is part of acceptance for WS1, WS2, WS5 (and WS9's theme decision per P15C-P3).

## 15. Responsive-design requirements

- Breakpoint contract: mobile (<md) uses the sheet nav; tablet (md–lg) keeps the collapsible sidebar — WS1 must verify the toggle at both.
- Tables: horizontal scroll containers built into the shared component; no page-level `overflow` hacks; sticky first column considered only where testing shows need (patients).
- Calendar: preserve the current `min-width` + scroll approach but verify hour-label column stays legible at 320 px width.
- Marketing: mobile-first sections, responsive imagery via `next/image` `sizes`, no horizontal body scroll at any width, CTA above the fold on 360×640.
- Settings currency card and phone comboboxes usable at mobile widths (popover sizing, on-screen keyboard interplay with `inputMode`).

## 16. Performance budgets

- **Marketing (`/`):** the documented gate — 3× mobile Lighthouse ≥90 perf / ≥90 a11y on production build; LCP ≤2.5 s target; initial script transfer ≤ ~260 KB (current baseline); hero image optimized and prioritized; gate doc re-recorded (date/commit/scores).
- **Phone registry (WS3):** measure first-load JS delta on each consumer surface; the country *list* derivation must not pull additional libphonenumber metadata beyond today's; if the full-country name map adds >10 KB, lazy-load it with the combobox (mirroring the P15-R1 pattern).
- **Currency (WS4):** `fx_rates` grows to ~170 rows — trivially small, but the layout-level fetch duplication (P15-P3) should be closed here so converted pages don't add queries; registry data generated at build time, not shipped as a runtime dataset beyond a few KB.
- **Operator reports (WS7):** server-side pagination replaces 1000-row loads; p95 report page render with filters < 1 s on realistic data; `EXPLAIN` checks before adding indexes.
- **Dashboard (WS0):** no new queries; if investigation reveals the 20-query fan-out as fragile, consolidation is allowed but not required in this sprint.

## 17. Testing requirements

- **Unit (Vitest):** phone registry (all-country normalize/round-trip incl. GB/DE/FR legacy values), currency registry/minor-units/formatter, conversion edge cases unchanged (existing suite must pass untouched), report filter → query-parameter mapping, data-table empty/loading states, back-link URL restoration helper.
- **Integration (fresh local DB):** WS0 empty-clinic dashboard fixture per role; WS7 filtered queries under `requirePlatformAdmin`; WS8 no-PHI assertions on every new operator query; WS4 Preferences page reachable for doctor/receptionist fixtures while admin-only settings pages stay denied.
- **E2E (Playwright, serial, `PORT=3100`, production build — per the validation-suite workflow):** existing 13-test suite green throughout; additions: sidebar toggle visible+operable collapsed/expanded; currency change from Settings → Preferences reflected on patient money surfaces (adapt the existing display-currency test to the new location), including as a receptionist fixture; phone entry with a non-registry country (e.g. 🇬🇧 +44) end-to-end on patient create and operator invitation; operator report filter → URL → export honoring filter; back navigation from operator clinic detail restoring list filters; marketing render + reduced-motion + mobile nav keyboard (existing) against the new page.
- **Migration check:** clean-slate `supabase db reset` across the full chain for any branch adding a migration.
- **Per-branch gate:** `pnpm typecheck && pnpm lint && pnpm test` + targeted integration/e2e before each PR; full serial e2e on the final integration state.

## 18. Manual-testing checklist

- [ ] WS0: affected test clinic dashboard loads for admin; brand-new empty clinic loads all four role dashboards; error boundary shows helpful copy when a failure is forced.
- [ ] WS1: toggle fully visible expanded + collapsed, light + dark, desktop + tablet; Tab → Enter toggles; focus ring visible; no clipping during the width transition.
- [ ] WS2: header vs. row distinction obvious at a glance in both themes on patients, staff, one tenant report, and all operator tables; sticky header on long patient list; empty + loading states render.
- [ ] WS3: type "u" in country search → United Arab Emirates/United Kingdom/United States…; arrow keys + Enter select; 🇬🇧 number saves and re-opens intact on every one of the 7 surfaces; invalid local number rejected server-side.
- [ ] WS4: header selector gone; Settings → Preferences shows the personal display currency (editable, searchable) with the clinic's canonical currency noted read-only; changing display currency shows `≈` values everywhere and never edits stored amounts (verify a patient invoice value in DB); currency without a fresh rate shows canonical with no fake conversion; doctor and receptionist accounts can reach Preferences and change their display currency without gaining access to admin-only Clinic Settings; only FX-provider-covered currencies are offered.
- [ ] WS5: at arm's length, both themes: grid lines visible, hour labels readable, current-time line on today, free vs. break vs. booked distinguishable in <2 s.
- [ ] WS6: operator clinics → filter by country → open clinic → Back returns with filter intact; breadcrumbs read correctly on settings sub-pages; back links work with keyboard and screen reader.
- [ ] WS7: each report's filters behave per the §7 matrix; URL copy/paste reproduces the view; export matches filtered rows; empty-filter state offers clear-filters.
- [ ] WS8: clinic page shows all §7-WS8 sections; audit timeline matches known operator actions; payments/contracts section clearly labeled as future; no notes UI anywhere (deferred); no patient data anywhere.
- [ ] WS9: logo consistent with login; all sections at 360/768/1440 px; product previews are real screenshots from the seeded demo clinic (no PHI, consistent viewport/theme, descriptive alt text); Privacy and Terms placeholder pages linked from the footer and carrying the pending-legal-review notice; dialog flow submits a real early-access request; reduced-motion honored; dark-theme session sees a coherent page; screenshot-refresh process documented and re-runnable; Lighthouse 3× run recorded.

## 19. Acceptance criteria (per workstream)

- **WS0:** root cause identified and documented in the review file with the failing query/component named; fix merged; empty-clinic fixture green; no cosmetic fallback masking errors; error boundary copy improved.
- **WS1:** toggle unclipped in all states/themes/breakpoints; ≥44 px hit target; keyboard + `aria-expanded` verified; e2e assertion added.
- **WS2:** shared primitive exists; **zero raw per-page `<table>` styling remains in migrated files**; header/row/border hierarchy per §7-WS2; dark mode verified; empty/loading slots used by every migrated consumer.
- **WS3:** all libphonenumber countries selectable with search/type-ahead/keyboard on all 7 surfaces; server validation matches; E.164 storage unchanged; legacy values round-trip (P15D-P4 closed); bundle delta within §16 budget.
- **WS4:** header control removed; **Settings → Preferences page exists, reachable by every authenticated staff role without widening admin-only settings**, hosting Display Currency (+ Theme; Language slot reserved for P2); canonical vs. personal distinction stated in copy; selector searchable and limited to FX-provider-covered, tested currencies; unavailable-FX behavior preserved (canonical shown, no invented rates); no monetary column touched; P15-P1/P15-P3 closed.
- **WS5:** contrast measurements recorded (before/after) meeting WCAG for labels; current-time indicator; working-hours emphasis; both themes; screenshots in review file; calendar e2e/unit suites green.
- **WS6:** every §7-WS6 surface has a stable-parent Back control; filters/query restored on return; semantic breadcrumbs where depth ≥2; no `history.back()`-only behavior.
- **WS7:** filter matrix implemented exactly (no meaningless universal filters); URL-state; server pagination replacing the 1000-row cap; filtered export; permission guards intact; documented defaults.
- **WS8:** all available + derived sections live; honest placeholders for payments/contracts; no-PHI tests green; strictly read-only (no `clinic_notes` schema/UI/placeholder — deferred per §6).
- **WS9:** redesigned page ships all §7-WS9 sections; real logo throughout; product previews are real seeded-demo screenshots meeting the pipeline standards (no PHI, consistent viewport/theme, `next/image` responsive delivery, alt text, documented refresh process); Privacy Policy and Terms of Service placeholder pages live, footer-linked, with the pending-legal-review notice and no invented legal/compliance claims; English-only (no next-intl/Arabic/RTL); no content copied from the reference site; performance gate re-cleared and re-recorded; accessibility 100; early-access flow functionally identical; P15C-P2/P3 closed.

## 20. Risks and rollback strategy

| Risk | Mitigation / rollback |
|---|---|
| WS0 root cause is environmental (stale migrations on the test env) rather than code | Investigation protocol distinguishes env vs. code before any fix; document either way; env fix = reset/repair runbook note, no code churn |
| Table migration (WS2) subtly changes report print layouts | Migrate print-facing reports last; verify `print-all-button` output; per-file commits allow surgical revert |
| Widening phone countries breaks a zod schema or e2e fixture expecting the 9-country gate | Server + client widen in the same PR; run full unit + e2e; the backfill function is untouched (it's migration-history) |
| Currency registry expansion breaks the FX cron's all-or-nothing snapshot check | Provider intersection logic + unit tests for partial provider coverage; cron failure leaves last good rows (existing behavior) |
| Marketing redesign fails the Lighthouse gate late | Budget checks at section milestones, not only at the end; heaviest asset (hero imagery) prototyped first; rollback = previous `marketing-page.tsx` is one revert away since WS9 is an isolated branch |
| Report filters introduce slow queries at scale | Enum/date-validated filters only; `EXPLAIN` before merge; additive indexes prepared |
| Header currency removal confuses existing testers | Release note + pointer ("Display currency moved to Settings → Preferences") for one release, optional |
| Marketing screenshots drift out of date as the product UI evolves | Scripted seed + capture refresh process (WS9 pipeline); stale screenshots treated as a content bug |
| Each branch is independently revertable | Enforced by the §9.2 boundaries — no branch may depend on an unmerged sibling except as ordered in §8/§10 |

## 21. Decisions — resolved 2026-07-13

All six open questions were decided by the user on 2026-07-13 and are incorporated into the workstreams above. **No open decisions remain; the sprint is unblocked.**

1. **Q1 — Marketing visual assets → RESOLVED:** real screenshots from a properly seeded demo clinic (fictional data, no PHI); generic illustrations/fake UI must not be the primary product preview. Full pipeline requirements in §7-WS9.
2. **Q2 — Display-currency location & access → RESOLVED:** a new user-accessible **Settings → Preferences** section (Display Currency + Theme now; Language in P2) — not the header, not admin-only Clinic Settings, not the Profile page. Per-user preference on the profile, editable by all staff roles without granting Clinic Settings access. Canonical clinic currency stays distinct and untouched. Details in §7-WS4.
3. **Q3 — `clinic_notes` table → RESOLVED: deferred.** Not in this sprint — no schema, UI, or placeholder behavior. Recorded as future Operator CRM functionality (§6). WS8 ships read-only.
4. **Q4 — Legal pages → RESOLVED:** professional Privacy Policy and Terms of Service placeholder pages, footer-linked, clearly marked pending legal review; no invented legal commitments, compliance claims, retention policies, or contractual terms. Details in §7-WS9.
5. **Q5 — Currency picker breadth → RESOLVED:** expose only currencies supported by the configured live FX provider and the tested formatting/conversion path; registry stays extensible and derives/validates provider coverage safely. Details in §7-WS4.
6. **Q6 — Marketing language → RESOLVED:** English-only this sprint; Arabic, next-intl, and RTL remain P2 scope and must not be introduced.

Additionally decided: **no additional planning document** may be created — this file remains the single source of truth (header note).

## 22. Final definition of done

The sprint is done when: all nine branches are merged to `main` with individual review files APPROVED under the standard workflow; BUG-1's root cause is documented and fixed with a regression test; every §19 acceptance criterion is checked; the full validation suite passes on the integrated tree (`supabase db reset` clean, `pnpm typecheck`, `pnpm lint`, full unit + integration suites, serial production-build Playwright 100 %); the Lighthouse gate doc carries fresh passing numbers for the redesigned `/`; no new physical-direction CSS classes were introduced (grep-verified); no RLS/middleware/monetary-column changes occurred (the only permitted schema additions being WS7's optional indexes); the §21 decisions are implemented as recorded (Preferences section live for all roles, seeded-screenshot pipeline documented, legal placeholders live, provider-intersected currency list, no `clinic_notes`, English-only marketing); and the carried polish items absorbed by this sprint (P15-P1, P15-P2, P15-P3, P15B-R13, P15C-P2, P15C-P3, P15D-P4, P15D-P7) are marked closed in their sub-phase review files.

---

## Appendix A — Sprint summary (one paragraph)

Fix the admin-dashboard crash first, then land seven focused polish branches — sidebar toggle, a shared table system, a worldwide searchable phone/country selector, display-currency relocation to a new all-roles Settings → Preferences section with an FX-provider-backed currency registry, a calendar contrast pass, a reusable back-navigation pattern, per-report operator filters with URL state and pagination, and an honest read-only full-history operator clinic page — and, independently, rebuild the marketing site (English-only) to a healthcare-SaaS trust standard with the real ClinicFlow brand, real seeded-demo screenshots, and placeholder Privacy/Terms pages, re-clearing the documented Lighthouse gate. Nine branches, ~14–20 dev-days, no security-model or canonical-data changes, everything reviewed under the established review-file contract before P2 begins.
