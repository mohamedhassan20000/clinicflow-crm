# Post-Pre-P2 Manual-Polish Sprint — Plan & Audit

**Status:** APPROVED SCOPE — ready for implementation
**Date:** 2026-07-14
**Scope of this document:** Planning and auditing only. No application code accompanies it.
**Position in roadmap:** Immediately after the merged Pre-P2 Product Polish sprint (`docs/PRE_P2_POLISH.md`, integrated review `docs/reviews/PRE_P2_PHASE_REVIEW.md` — APPROVED FOR MANUAL TESTING AND COMMIT, merged as `cf139cb`) and **before P2** (Arabic-first i18n & RTL) in `docs/AI_AGENT_PLAN.md`.
**Single source of truth:** this file is the only planning document for this sprint. §10 *is* the implementation order; no separate implementation-order document may be created.
**Review contract:** every workstream follows the established review-file workflow — implementation → `docs/reviews/<WORKSTREAM>_REVIEW.md` with stable finding IDs → fix cycle → merge.
**Base of audit:** `main` at `cf139cb` (clean tree). Every file reference below was read at that commit.
**Quick-polish addendum (2026-07-14):** implemented after MP0–MP7 without changing their scope: centered Preferences content, a four-column currency picker, lighter sidebar labels, restored shell alignment, refreshed marketing captures/window chrome/fictional portraits, a public-only Light/Dark control, a hero-only subtle hexagon texture, increased Early Access spacing, and Manrope as the single English font family. See §24.

---

## 1. Executive summary

The Pre-P2 sprint shipped a real product: a rebuilt marketing site, a shared table system, a
worldwide phone registry, a preferences page, a readable calendar, back navigation, operator
report filters, and an honest operator clinic-history page. Manual testing by the user on the
running product then surfaced **two high-priority functional bugs and nine finish-level defects**
that the automated gates could not see, because they are either environment-dependent (the two
blank pages) or matters of taste, brand, and theme coherence (everything else).

The two bugs are the priority: **opening a clinic from the operator Clinics table and opening the
operator Invitations report both render a black/blank page.** Both surfaces are the only two
operator paths that read `clinic_invitations.email_sent_at`, both *throw* rather than degrade when
their query fails, and the `(operator)` route group has **no error boundary at all** — so the throw
escapes to Next.js's default error page, which on a dark-theme session reads as a black screen.
That is a concrete, testable hypothesis chain (§3), not a guess, and the sprint requires it to be
*proved* with a captured server error before any fix is written.

The rest of the sprint is finish work with one architectural spine: **theme scoping.** Today a
single `theme` cookie puts `dark` on `<html>` for *every* route, so a dark dashboard session drags
the public marketing site and the login page into dark variants. The product decision is now
explicit — **marketing is always Light, login is always Dark, the dashboard follows each user's own
choice** — and that requires a small, reusable CSS-scope primitive rather than nine one-off
overrides. Everything else (premium marketing typography, the un-badged logo, the sidebar
logo-as-collapse control, the header/sidebar divider baseline, the calling-code column alignment,
the header utility slot) hangs off that spine or is independent of it.

**This sprint is documentation and UI work only — it introduces no migration.** The approved
long-term persistence model for per-user UI preferences (theme, and in P2 locale) is an
auth-user-keyed **`user_ui_preferences`** table; that architecture is **approved and recorded** (§6.D),
but its **implementation — migration, RLS, profile-migration strategy, and data backfill — belongs to
P2**, not here. Until then the theme keeps its current device-cookie persistence, documented honestly
rather than half-corrected (§9-MP1).

One piece of terminology is load-bearing and was corrected before implementation: **"Owner" means the
Platform Owner / SaaS Operator**, not the owner of a clinic. That fixes the header architecture
(§9-MP6): the **operator** header loses its Preferences entry — which was in fact a *broken* link,
since `/preferences` is a clinic-user route and a Platform Admin has no `profiles` row — and that
position becomes the **permanently reserved slot for the Operator Language Switcher**, a P2 control
that will change **only** the operator dashboard's language and can never affect a clinic. **Every
clinic user — Clinic Owner, Clinic Admin, Doctor, Receptionist, Accountant, future roles — keeps
Preferences exactly as designed**, and that is where each of them will set their own language and
theme. **There is no clinic language and no clinic theme:** a Doctor on Arabic, a Receptionist on
English, and the Clinic Owner on Arabic can use the same clinic at the same time, each seeing their
own UI.

Nothing in this sprint touches RLS, middleware, the schema, the signup/billing/entitlement semantics,
canonical monetary values, or the appointment domain. **No P2 implementation is included** — the
language switchers, Arabic copy, the Thmanyah font, RTL, and the `user_ui_preferences` persistence
model are recorded as P2 deferrals (§6) and written into `docs/AI_AGENT_PLAN.md`, not built here.

**Estimated effort: 6–9 dev-days across 7 branches.**

---

## 2. User-reported issues

Reported after hands-on testing of the merged Pre-P2 product. Restated as observed behavior, with
the ground truth found in the code at `cf139cb`.

| # | User report | Ground truth in the tree | Classification |
|---|---|---|---|
| 1 | Marketing English typography does not feel formal/premium enough | Body/UI = **DM Sans**; display headlines = **Instrument Serif**; mono = Geist Mono — all via `next/font/google` in [app/layout.tsx:3-27](app/layout.tsx#L3-L27), exposed as `--font-dm-sans` / `--font-instrument` / `--font-geist-mono` and mapped to `--font-sans` / `--font-heading` / `--font-display` / `--font-mono` in [app/globals.css:7-13](app/globals.css#L7-L13). The marketing page sets headlines at `font-display` with `clamp(3.25rem,7.2vw,7.4rem)` and `tracking-[-.06em]` ([marketing-page.tsx:158](components/marketing/marketing-page.tsx#L158)) | Design change (MP2) |
| 2 | Marketing motion is thin / template-like | Three keyframes only (`marketing-hero-in`, `marketing-float`, `marketing-section-in`) plus card hover-lift, all in [app/globals.css:345-391](app/globals.css#L345-L391); scroll-reveal is a scroll-timeline animation gated on `@supports`; `prefers-reduced-motion` disables all of it | Design change (MP2) |
| 3 | The real ClinicFlow logo appears inside a decorative colored square on the marketing site | [components/marketing/marketing-logo.tsx:23](components/marketing/marketing-logo.tsx#L23) wraps the transparent mark in `<span class="grid size-9 … rounded-xl bg-[#13c7d8] shadow-[inset_…]">` — an artificial cyan badge. The sidebar and login render the same asset **without** any container | Confirmed defect (MP3) |
| 4 | A dark dashboard session makes the marketing site dark / mixed | True by design today: the `theme` cookie is applied to `<html>` in [app/layout.tsx:44](app/layout.tsx#L44) for *all* routes, and Pre-P2 closed carried finding P15C-P3 by shipping a **true dark variant** of the marketing palette (`.dark .marketing-page` token block, [app/globals.css:299-309](app/globals.css#L299-L309)) rather than forcing light | Product decision reversal (MP1) |
| 5 | Login switches theme with the dashboard | True: the auth left panel is hard-coded dark, but the right panel and the auth card use theme tokens (`bg-card/70`, `text-foreground`, `text-muted-foreground`) in [app/(auth)/layout.tsx](<app/(auth)/layout.tsx>), so a light session renders a light form panel | Product decision (MP1) |
| 6 | Clicking the ClinicFlow logo on login does not go to the marketing site | True: both the desktop lockup and the mobile lockup in [app/(auth)/layout.tsx](<app/(auth)/layout.tsx>) link to **`/login`**, not `/` | Confirmed defect (MP4) |
| 7 | Dashboard theme must be personal and must not affect other users | **Honest status: theme is device-scoped, not user-scoped.** `setTheme` ([actions/theme.ts](actions/theme.ts)) writes a single non-user-namespaced `theme` cookie (`path=/`, 1 year). It is read in the root layout, the protected layout, and the operator layout. It is **never** written to `profiles` and **never** to `clinics` — so it cannot leak between users on different devices and there is no clinic-wide theme. But two different users signing in on the *same browser* inherit each other's theme, and one user's theme does not follow them to a second device. **The approved model is per-authenticated-user storage (`user_ui_preferences`), and it is approved architecture — but its implementation is a P2 deliverable** (§6.D). This sprint documents the current scope honestly and ships no migration | Documented now; **corrected in P2** |
| 8 | Country calling codes in the phone dropdown are unevenly aligned | The list row is a plain flex line — `flag` + `name` (`truncate`) + `dial code` (`ms-auto`) — with **no ISO code column and no fixed-width numeric column** ([international-phone-input.tsx:64-72](components/shared/international-phone-input.tsx#L64-L72)), rendered inside the shared `CommandItem` flex row ([searchable-combobox.tsx](components/shared/searchable-combobox.tsx)). Emoji flags vary in advance width per platform and the dial codes are only edge-flushed, never columnised | Confirmed defect (MP5) |
| 9 | Opening a clinic from the operator Clinics table → black/blank page | **BUG-4 — see §3** | **Blocking bug** |
| 10 | Opening the operator Invitations report → black/blank page | **BUG-5 — see §3** | **Blocking bug** |
| 11 | The **Platform Admin (SaaS Owner)** header must not show Preferences; that position is permanently reserved for the Operator Language Switcher | **Ground truth: `DashboardShell` is shared by both the clinic layout and the operator layout** ([app/(protected)/layout.tsx](<app/(protected)/layout.tsx>), [app/(operator)/layout.tsx](<app/(operator)/layout.tsx>)), and it unconditionally renders a **"Preferences" item in the user menu** ([dashboard-shell.tsx:84](components/layout/dashboard-shell.tsx#L84)) pointing at `/preferences`. `/preferences` is a **clinic-user route** — it calls `requireUser()` and reads `clinics`/`profiles`. A platform admin has **no `profiles` row and no `clinic_id`**, so that menu item is not merely misplaced on the operator header: **it is a broken link for the account it is shown to.** See MP6 | **Confirmed defect** (MP6) |
| 12 | Sidebar arrow toggle should be replaced by clicking the logo/brand area | The dedicated chevron button exists at [sidebar.tsx:71-81](components/layout/sidebar.tsx#L71-L81) (`absolute inset-e-0 … size-7`, `z-40`, 48 px effective hit target via `before:-inset-2.5`). The brand area itself is **not** interactive today — the sidebar logo is a plain `<Image>`, not a link and not a button | Interaction redesign (MP7) |
| 13 | The divider under the sidebar brand does not line up with the header's bottom border | True and measurable: the sidebar brand block is `h-18` = **72 px** ([sidebar.tsx:66](components/layout/sidebar.tsx#L66)); the content header is `h-16` = **64 px** ([dashboard-shell.tsx:70](components/layout/dashboard-shell.tsx#L70)). The two bottom borders are **8 px apart** — a visible break in the horizontal baseline across the whole shell | Confirmed defect (MP7) |

---

## 3. Confirmed bugs requiring reproduction

| ID | Severity | Symptom | Surfaces |
|---|---|---|---|
| **BUG-4** | **High — blocking** | Operator → Clinics table → open a clinic renders a black/blank page in the affected environment | [app/(operator)/operator/clinics/[id]/page.tsx](<app/(operator)/operator/clinics/[id]/page.tsx>) → `getOperatorClinicHistory()` ([lib/supabase/admin.ts:444](lib/supabase/admin.ts#L444)) |
| **BUG-5** | **High — blocking** | Operator → Reports → **Invitations** renders the same black/blank page | [app/(operator)/operator/reports/[reportId]/page.tsx](<app/(operator)/operator/reports/[reportId]/page.tsx>) → `invitationsQuery()` ([lib/operator-reports/registry.ts:367](lib/operator-reports/registry.ts#L367)) |

### 3.1 Why they present as a *black* page (established, not hypothesised)

`find app -name "error.tsx"` returns exactly three boundaries: `app/(auth)/error.tsx`,
`app/(protected)/error.tsx`, `app/(protected)/not-found.tsx`. **The `(operator)` route group has no
`error.tsx`, no `not-found.tsx`, and there is no root `global-error.tsx`.** Both failing pages throw
on purpose:

- `clinics/[id]/page.tsx:127` — `throw new Error("Operator clinic history could not be loaded.")` whenever `getOperatorClinicHistory` returns an error.
- the report page awaits `report.query(parsed)` with no local error handling.

With no boundary in the segment, the throw reaches Next.js's built-in error page. The document is
still rendered inside `<body class="… bg-background text-foreground">` with `dark` on `<html>`
(§2 item 4), so a dark-theme operator sees a **dark/near-black page with no chrome**. That fully
explains the reported symptom and is *independent* of which query failed.

### 3.2 Leading root-cause hypothesis (must be proved before any fix)

**H1 — schema drift on the affected environment: `clinic_invitations.email_sent_at` does not exist.**

The evidence is unusually tight:

1. `email_sent_at` is added by migration `supabase/migrations/20260712090000_p15b_invitation_email.sql`.
2. `docs/reviews/PRE_P2_WS0_REVIEW.md` §2 and `docs/reviews/PRE_P2_PHASE_REVIEW.md` §7 both record, as a known **environment** issue, that the **remote Supabase project is missing two migrations** — `20260712090000_p15b_invitation_email` and `20260712150000_p15d_intl_ux_foundations` — and that this is an unresolved `supabase db push` action for the user, not a code defect.
3. The **only** two operator read paths that select `email_sent_at` are precisely the two that fail:
   - `lib/supabase/admin.ts:511` — `clinic_invitations … select("id, status, created_at, expires_at, email_sent_at, accepted_at, revoked_at, updated_at")` (BUG-4's query)
   - `lib/operator-reports/registry.ts:379` — `clinic_invitations … select("id, accepted_clinic_id, clinic_name, status, created_at, email_sent_at")`, plus the `emailSent` filter predicates at `:384-385` (BUG-5's query)
4. A missing column makes PostgREST return `42703 undefined column`, both call sites propagate the error, and both pages throw (§3.1).

**Discriminating test (run this first, it costs 30 seconds and settles the question):** open
**`/operator/invitations`** (the list page). It selects `email_sent_at` too
([app/(operator)/operator/invitations/page.tsx:18](<app/(operator)/operator/invitations/page.tsx#L18>)).

- List page **also** blank/errors → H1 is confirmed; the cause is environmental schema drift.
- List page **renders fine** → H1 is falsified; the cause is code-level and the suspect list below applies.

### 3.3 Investigation protocol (evidence before action — mandatory order)

1. **Reproduce with the affected operator account and the affected clinic**, in the environment where the user saw it (state explicitly in the review file whether that is production `clinicflow.fit`, a preview deployment, or local). Local repro: `supabase status` for keys, app on `PORT=3100` (never 3000 — the user's own server occupies it).
2. **Capture the real error, not the boundary.** Server terminal output / Vercel runtime logs / Sentry event by digest for the RSC throw; browser console + network for any client-side crash. Paste the exact PostgreSQL code and message (`42703`, `22P02`, `PGRST200`, …) into the review file. A fix written without a captured error is rejected by this plan.
3. **Run the §3.2 discriminating test** and record the result.
4. **Confirm schema state on the affected database:** `select column_name from information_schema.columns where table_name = 'clinic_invitations'` and `supabase migration list` (local vs. linked). If migrations are missing, that is the root cause: push them, then re-verify both pages. Record the environment fix in the review file; it is **not** a code change.
5. **If H1 is falsified, work the code-level suspect list in order** (each is a real failure mode in the current queries):
   - **Embedded-relation resolution:** `subscriptions … plans(slug, name_en)` and `coupon_redemptions … coupons(code, kind, months, percent, expires_at, is_active)` (`admin.ts:501,517`) — a missing FK/relationship yields `PGRST200`, which the `firstError` check at `admin.ts:531` turns into the throw.
   - **Service-role client:** `getOperatorClinicHistory` builds `createAdminClient()` after `requirePlatformAdmin()`; a missing/invalid `SUPABASE_SERVICE_ROLE_KEY` in that environment throws at client construction.
   - **Legacy/missing data:** clinics with no `subscriptions` row (`maybeSingle` → `null`), no invitations, no usage counters, `null` `onboarding_completed_at`, or `null` working hours — verify each renderer tolerates the empty case rather than dereferencing.
   - **Enum / URL-param parsing on the report:** `parseReportParams` defaults and the status/clinic/emailSent/date filters (`registry.ts:382-390`); an out-of-enum `status` value or an unparseable date range must fall back safely, never reach the query as-is. Reproduce with the **exact query string the user had**, including any filter or sort params.
   - **Serialization:** anything non-plain crossing the RSC boundary into `DataTable`/`ReportShell` (Date objects, `undefined` in a column definition, `bigint` counts).
   - **Audit-log allowlist:** `safeAuditSummary()` (`admin.ts:379-437`) and `SAFE_OPERATOR_CLINIC_AUDIT_ACTIONS` — an unknown action must return `null` and be skipped, never throw.
6. **Fix the root cause.** A generic fallback that renders an empty section instead of surfacing the failure is **explicitly forbidden**.
7. **Then, and only then, harden the segment:** add `app/(operator)/error.tsx` (and `not-found.tsx`) matching the tone of `app/(protected)/error.tsx` — retains the digest, offers a way back to `/operator`, and is *in addition to*, never instead of, the root-cause fix. This is why a *future* operator failure is a legible error card instead of a black rectangle.
8. **Regression coverage** — §18.

### 3.4 Guardrails that survive the fix

`requirePlatformAdmin()` stays on every query path (`admin.ts:448`, `registry.ts:368`); the operator
surface stays **read-only** for history; no patient PHI may enter any new query, log line, or error
message; `safeAuditSummary()`'s allowlist stays allowlist-shaped (`default: null`).

---

## 4. Required immediate UX changes

1. **Marketing typography & motion** — replace the marketing Latin type system with a formal, premium, professional stack; enrich motion while staying restrained and reduced-motion-safe. (MP2)
2. **Marketing logo** — the transparent mark, unbadged, in header and footer. (MP3)
3. **Marketing theme** — always Light, independent of the dashboard theme; a deliberate multi-tone light system. (MP1)
4. **Login theme & navigation** — always Dark; the logo + wordmark is a link to `/`. (MP1 + MP4)
5. **Dashboard theme independence** — verified: no clinic-wide theme, no cross-user contamination across devices. The current persistence scope (device cookie) is **documented honestly**; the approved per-authenticated-user store (`user_ui_preferences`) is **P2 work**, not this sprint. (MP1 + §6.D)
6. **Country calling-code column alignment** — flag / name / ISO / dial code, tabular numerals, one clean column. (MP5)
7. **Operator black pages** — root-caused and fixed. (MP0)
8. **Platform Admin header** — remove the Preferences shortcut from the **operator** header (it is a broken clinic-user link there) and **permanently reserve** that position for the Operator Language Switcher arriving in P2. **Clinic users keep Preferences exactly as designed.** **No placeholder button now.** (MP6)
9. **Sidebar brand-as-collapse-control** — remove the arrow toggle; the brand area toggles. (MP7)
10. **Sidebar/header divider baseline** — one continuous 1-px line. (MP7)

---

## 5. Exact scope boundaries

**This sprint is documentation and UI work only.**

**In scope:** presentation, theme scoping (pure CSS), brand treatment, typography, motion, one
interaction redesign (sidebar collapse), one alignment fix (dial codes), the Platform-Admin header
correction, two high-priority bug fixes with regression coverage, one new error boundary in the
`(operator)` segment, and documentation.

**Out of scope (hard):**

- **Any migration at all — zero schema change.** In particular the approved `user_ui_preferences` table is **P2 work** (§6.D): its migration, RLS policies, profile-migration strategy, and data backfill all land in P2A. Nothing in this sprint creates, alters, or drops a table, column, policy, or function.
- **All P2 work.** No `next-intl`, no locale routing, no Arabic copy, no RTL implementation, no Thmanyah font files, **no language-switcher UI, and no placeholder language button.** (§6)
- **Billing.** No seat counting, no pricing UI, no change to subscription behavior. The per-seat pricing decision is *recorded* (§7), not built.
- **Legal-acceptance storage.** No `legal_acceptances` table, no acceptance UI, no fabricated agreement history on the operator clinic page. (§8)
- RLS policies, `middleware.ts` / `lib/supabase/middleware.ts`, the middleware gate order, signup/invitation/coupon/entitlement semantics, `requirePlatformAdmin()`, canonical monetary columns, the appointment domain model.
- **Theme persistence.** `actions/theme.ts` and its cookie stay **exactly as they are**. Changing where the theme is stored is a P2 deliverable, not a polish task.
- **The Preferences page itself.** Its existence, route (`/preferences`), contents, and clinic-user access model are **unchanged** — Pre-P2 WS4 shipped it deliberately outside the admin-gated `/settings`, reachable by **every clinic role** (Clinic Owner, Clinic Admin, Doctor, Receptionist, Accountant, and any future staff role). MP6 removes it **only from the Platform Admin's operator header**, where it never belonged.
- New physical-direction CSS classes anywhere (`ml-/mr-/pl-/pr-/left-/right-/text-left/text-right/border-l|r/rounded-l|r`). Logical properties only — this is a hard acceptance criterion on every workstream so P2B's inventory does not grow.
- Copy rewrites on the marketing site, except minor adjustments needed for layout quality under the new type scale (§ MP2). The information architecture stays as shipped.

---

## 6. Explicit P2 deferrals

Recorded here and written into `docs/AI_AGENT_PLAN.md` (§ "Main-plan updates" below). **None of it
is implemented in this sprint.**

### 6.A Language switcher (P2A/P2C) — **three surfaces, three independent scopes**

**Terminology, fixed:** "**Owner**" in this architecture means the **Platform Owner / SaaS Operator**
(the `platform_admins` account behind `requirePlatformAdmin()`). The owner of a *clinic* is the
**Clinic Owner**, who is an ordinary authenticated clinic user like any other staff role.

**There is no clinic language.** Dashboard language is **always a per-user preference**. The only
dashboard whose language is set from a *header* control is the **Platform Admin's**, and that control
governs **only** the operator dashboard.

| Surface | Who | Control location | Scope of the setting | Persistence |
|---|---|---|---|---|
| **Marketing site** (`/`, `/privacy`, `/terms`, public funnel) | Anonymous visitors | Switcher in the **marketing header** | The public pages only | **Locale cookie**, independent of any account. English by default |
| **Clinic dashboard** | **Every clinic role** — Clinic Owner, Clinic Admin, Doctor, Receptionist, Accountant, and future staff roles | **Preferences** (`/preferences`) — exactly as originally designed | **That user only** | Per authenticated user. English by default |
| **Operator dashboard** | **Platform Admin (SaaS Owner)** | **Language Switcher in the operator header** — the permanently reserved slot | **The operator dashboard only** | Per authenticated platform-admin user. English by default |

- **The Platform Admin's language has absolutely no effect on clinics or clinic users**, and no clinic user's language has any effect on the operator dashboard. The two are completely independent.
- **Concurrency requirement (must be tested):** a Doctor on Arabic, a Receptionist on English, and the Clinic Owner on Arabic may all use **the same clinic simultaneously**, each seeing their own language and their own theme. **No clinic-wide language setting may be introduced, ever.**
- **English is the default language** everywhere — marketing, login, new clinic users, new platform admins.
- Switching applies through the approved P2 runtime i18n architecture (`next-intl`, no sign-out, no full reload beyond the RSC refresh).
- **Do not show a non-functional placeholder button before P2.** The operator header slot is *reserved* — reserved means **left empty**, not stubbed. The **clinic** dashboard header gets **no** language control at all: clinic users switch language in Preferences.
- The `/preferences` page already carries a read-only "Language — English (US)" card ([app/(protected)/preferences/page.tsx](<app/(protected)/preferences/page.tsx>)). It is honest today and stays untouched; **it becomes the real per-user language control for clinic users in P2A.**

### 6.B Arabic font — **Thmanyah** (licensed, purchased by the user)

- **Thmanyah** becomes the **primary Arabic UI font**, replacing IBM Plex Sans Arabic as the primary in the P2 typography plan (IBM Plex Sans Arabic is retained as the fallback / unlicensed-environment face).
- Integrated with **`next/font/local`** (self-hosted, no external request — consistent with the current strategy).
- **The user must add the licensed font files before P2 implementation begins.** They do not exist in the repository today (`public/` contains only `brand/` and `marketing/`; there is no `fonts/` directory and no local font file anywhere in the tree).
- **Font files must never be redistributed as standalone downloadable assets** — they are served only as font resources of the application, never linked, listed, or exposed as a download.
- The P2 work must document the **required weights/styles** actually used (expected: Regular 400, Medium 500, SemiBold 600, Bold 700; italics only if the licence and the family provide them) and the **fallback stack**.
- RTL QA must test **line-height, weight mapping, forms, tables, calendars, and dense dashboards** with Thmanyah — Arabic ascender/descender metrics differ from the Latin face and will change row heights in the shared `DataTable` and all three calendar views.
- **No font file is included, generated, or fabricated by this documentation task.**

**P2 implementation reminder (recorded verbatim in `docs/AI_AGENT_PLAN.md` §4.3):**

> Before starting P2 code changes, request the licensed Thmanyah font files from the user and confirm the permitted web-app usage.

### 6.C P2 default-language & theme behavior (final approved model)

**Dashboard language model — state this verbatim in any downstream document:**

> **There is no clinic language.** Dashboard language is always a **per-user preference**. The only
> exception is the **Platform Admin dashboard**, whose language is controlled from the dedicated
> **Language Switcher in the Operator header** — and that setting affects the operator dashboard
> alone, never a clinic and never a clinic user.

- Marketing default = **English**.
- Login default = **English**.
- Clinic-user locale = **per-user preference**, set in Preferences. Independent of every other user in the same clinic.
- Platform-Admin locale = **per-user preference**, set from the operator header switcher. Independent of every clinic.
- Arabic and RTL arrive **only** through P2.

**Theme model — final approved model:**

- **Theme is stored per authenticated user** — not per device, not per clinic. It follows the user across devices and never bleeds between accounts on a shared browser. *(Approved architecture; **implemented in P2** via `user_ui_preferences` — §6.D. This sprint changes no persistence.)*
- **Landing page is always Light.** *(This sprint — MP1.)*
- **All authentication pages are always Dark** (login, forgot-password, reset-password, change-password). *(This sprint — MP1.)*
- **Dashboard theme is independent for every authenticated account — including the Platform Admin.** There is no clinic-wide theme and no operator-imposed theme.
- Theme is **independent of locale**: choosing Arabic never implies a theme, and choosing dark never implies a language.

**Consequence for the schema (`clinics.locale`):** because dashboard language is per user and there
is no clinic language, **`clinics.locale` must not resolve any user's dashboard language.** Locale
resolution in P2 becomes **user → `en`**, with no clinic tier. Whether the column is retained purely
as clinic *formatting* metadata (alongside `timezone`/`currency`/`digits`, where it does have a
legitimate non-language use) or retired outright is a P2A decision — recorded as Q6 (§22) and
`AI_AGENT_PLAN.md` §13-Q11. What is **not** open: it may never be a language source.

### 6.D Per-user UI-preference persistence — `user_ui_preferences` (**architecture approved; implementation is P2**)

**The architecture decision is approved and final. Only the timing moved: it is a P2 implementation
deliverable, not part of this manual-polish sprint.** This sprint therefore ships **no migration**.

**Approved model:**

```
user_ui_preferences (user_id uuid PK → auth.users, theme text check (theme in ('light','dark')),
                     locale text, created_at, updated_at)
```

- **Keyed on the auth user id, not on `profiles`.** This is the load-bearing detail: **a Platform Admin has no `profiles` row** (`platform_admins.user_id` → `auth.users`; `profiles` is a clinic-scoped table carrying a `clinic_id`). A `profiles.theme`/`profiles.locale` column is therefore structurally incapable of storing the SaaS Owner's theme or the Operator dashboard's language — while the approved model requires both to be independent for **every** authenticated account, including the Platform Admin. One auth-user-keyed store serves clinic users and platform admins with one mechanism.
- **RLS is self-only** (`user_id = auth.uid()` for select **and** write). No account — including a platform admin — can read or write another account's UI preference. No clinic scope, no role check, no operator exception.
- **The cookie remains the pre-render hint** so there is no theme flash: the write action updates the row *and* refreshes the cookie; layouts read the row for the signed-in user and fall back to the cookie, then to `light`. Sign-out clears the hint.
- **It carries both preferences.** Theme and locale are the same kind of thing — a personal UI preference belonging to an authenticated account — and they share one store rather than two mechanisms.

**Belongs to P2 (P2A specifically), not to this sprint:**

- the **migration** creating the table;
- its **RLS policies** and their two-user/cross-audience denial tests;
- the **profile-migration strategy** — how existing users' preferences are represented once the store exists;
- the **data backfill** — what happens to the theme currently living only in browser cookies (recommended, to be confirmed in P2A: **no backfill is possible or needed** — a cookie is not readable server-side outside a request, so the honest approach is to seed each user's row lazily on their first post-P2 theme write, defaulting to `light` until then, and to state that plainly rather than inventing history);
- rewiring `actions/theme.ts`, `ThemeToggle`, and the two dashboard layouts onto the store;
- the P2 language switchers, which read/write `locale` in the same table (§6.A).

**Until P2 lands it:** the theme stays in the device cookie exactly as it is today, and this sprint
documents that scope honestly instead of half-correcting it (§9-MP1). The properties the product
already guarantees — **no clinic-wide theme**, and **no contamination between users on different
devices** — hold today and are tested by this sprint. The gap that remains open until P2 — a shared
browser, where the next user inherits the previous user's theme, and a user's choice not following
them to a second device — is stated openly in §9-MP1 and in the MP1 review file. It is a known,
accepted, time-boxed limitation, not a hidden one.

---

## 7. Future billing decision (recorded, not implemented)

**Approved product pricing decision (2026-07-14).** Recorded here and in `docs/AI_AGENT_PLAN.md`
§3.3 / §13-Q1. **Nothing in this sprint implements it and no current subscription behavior changes.**

- **Pricing model: per active staff user (per seat).**
- The **clinic owner / primary admin seat is free**.
- Each **additional active staff user** is initially **USD 9 per month**.
- **Pending invitations do not count** toward billable seats.
- **Disabled / inactive users do not count** toward billable seats.
- The **USD 9 amount is provisional** and may change before GA.
- Billing must count seats **deterministically and auditably** — a seat count must be reproducible from the data at a point in time and every count change must be attributable (candidate source of truth: `profiles` joined against the existing `audit_logs` / `platform_audit_logs` trail; the exact definition of "active" is a billing-phase decision, not a guess made here).
- Do **not** implement billing in this sprint. Do **not** change current subscription behavior now.

**This is not the display-currency feature.** They are unrelated and must never be conflated:

| | Display currency (shipped, P1.5D + Pre-P2 WS4) | Per-seat pricing (future, billing phase) |
|---|---|---|
| What it is | A **per-user presentation preference** for how *clinic* money is *shown* | The **platform's commercial model** for what a clinic *pays ClinicFlow* |
| Where it lives | `profiles.display_currency`, `fx_rates`, `lib/currency/*`, `/preferences` | `plans` / `subscriptions` / seat counting — none of it built |
| What it changes | Nothing. Canonical amounts are never rewritten; conversions are marked `≈` | The clinic's subscription price |
| Currency | Converts the clinic's operating currency for display | Denominated in **USD** (the `plans.monthly_price_usd` column already exists) |

---

## 8. Future legal-acceptance requirement (recorded, not implemented)

The user wants the operator clinic-history page to eventually show signed agreements, accepted
policies, privacy terms, and related acceptance evidence.

**Stated plainly, and this must never be softened in the product:**

- **This data does not exist today.** There is no `legal_acceptances` table, no acceptance capture in the signup or onboarding flow, and no versioned legal document store. The `/privacy` and `/terms` pages shipped in Pre-P2 WS9 are **placeholders carrying a pending-legal-review notice** and bind nothing.
- **Historical agreements cannot be reconstructed if they were never stored.** Any clinic onboarded before the feature exists will legitimately have *no* acceptance history, and the operator page must say exactly that.
- **The current operator clinic history must show only real available data** — the existing "Payments & contracts — available after billing integration" honest placeholder ([clinics/[id]/page.tsx:467-469](<app/(operator)/operator/clinics/[id]/page.tsx#L467-L469>)) is the correct pattern and may be extended with a similar, clearly-labeled legal-acceptance placeholder — never with synthesized, inferred, or backfilled acceptance rows.
- **Implementation belongs to a later legal/compliance or billing/onboarding phase**, not to this manual-polish sprint.

**Prospective data model to record (for that later phase):** an append-only, immutable acceptance
record capturing, per acceptance —

| Field | Purpose |
|---|---|
| legal document type | terms of service / privacy policy / DPA / BAA-equivalent / clinic agreement |
| document version | the version accepted (semantic or dated) |
| immutable document snapshot **or** content hash | so the exact text accepted can be proved later |
| accepted timestamp | when |
| accepting user | who (`profiles.id` / auth user id) |
| clinic | which tenant |
| acceptance mechanism | checkbox at signup, onboarding step, re-consent prompt, operator-recorded countersignature, … |
| source IP | **where legally and operationally appropriate** (jurisdiction-dependent; PDPL/GDPR minimization applies) |
| user agent / other evidence | **where appropriate**, same caveat |
| revocation / supersession state | superseded-by pointer, withdrawn-at, replacement version |
| audit trail | append-only; corrections are new rows, never edits |

Guardrails for that future phase: acceptance records are **platform-admin-readable, clinic-readable
for their own rows, never patient data**; the document snapshot store is versioned and immutable;
the operator surface stays read-only.

---

## 9. Proposed workstreams

### MP0 — Operator black pages (BUG-4, BUG-5) — **BLOCKING**

**Goal:** both operator surfaces load correctly, from a proved root cause, with regression coverage
and a real error boundary for the segment.

- Follow the §3.3 investigation protocol **in order**. The review file must contain: the exact reproduction steps and account/clinic used, the captured server error verbatim, the §3.2 discriminating-test result, the named failing component/query/data assumption, and the fix rationale.
- Verify **every** section of the clinic-history page against a clinic with missing/legacy data: subscription (missing row), invitation lineage (none), coupon redemptions (none), feature overrides (none), usage counters (none / >1 page), audit timeline (unknown action → skipped, not thrown), working hours (none).
- Verify the Invitations report against: default params, every filter value including `emailSent=yes|no`, both sort directions, page 2+, and the CSV export route (which reaches the same `report.query`).
- Add `app/(operator)/error.tsx` + `app/(operator)/not-found.tsx` **after** the root-cause fix, mirroring `app/(protected)/error.tsx` (digest retained, route back to `/operator`, no swallowing).
- Preserve `requirePlatformAdmin()`, the no-PHI rules, and the read-only nature of clinic history.

### MP1 — Theme scoping: marketing Light, login Dark, dashboard per user

**Goal:** one reusable scope primitive, three coherent surfaces, zero middleware changes.

**Current mechanism (audited):** `theme` cookie → `dark` class on `<html>` ([app/layout.tsx:38-46](app/layout.tsx#L38-L46)) → Tailwind's `@custom-variant dark (&:is(.dark *))` ([app/globals.css:5](app/globals.css#L5)) → token overrides in the `.dark { … }` block. `ThemeToggle` mutates `document.documentElement.classList` for instant feedback, then persists via the `setTheme` server action and `router.refresh()`.

**Approved architecture — scope classes, not a layout rewrite:**

1. **Introduce a forced-light scope.** Redefine the dark variant so it does not apply inside an explicitly-light subtree, and add a `.light` token block that re-declares the `:root` (light) values:
   ```css
   @custom-variant dark (&:is(.dark *):not(:is(.light *)));

   .light { /* re-declare the :root light token values; color-scheme: light; */ }
   ```
   This is the minimal, production-safe change: it needs no root-layout restructuring, no multiple root layouts, no client theme provider, and it cannot regress the dashboard (nothing in `(protected)`/`(operator)` carries `.light`).
2. **Marketing + legal = forced light.** Put `light` on the root element of `components/marketing/marketing-page.tsx` and `components/marketing/legal-page.tsx` (alongside the existing `marketing-page` class). **Delete the `.dark .marketing-page` token block** ([globals.css:299-309](app/globals.css#L299-L309)) and every `dark:` utility in the marketing/legal components (e.g. the `dark:border-…`/`dark:bg-…` pairs in `legal-page.tsx`). The shadcn islands used on the page (dialog, button, sheet) then resolve light tokens even in a dark session, because the `.light` block re-declares them for that subtree.
3. **Login/auth = forced dark.** Put `dark` on the root element of `app/(auth)/layout.tsx`. This works in both directions with no variant surgery: the `.dark` token block already exists, and `&:is(.dark *)` matches descendants of the wrapper. The left brand panel is already dark; the right panel and the auth card then follow. Verify contrast on the form, errors, focus rings, and the Sonner toaster (which mounts at the body root — check whether it needs the dark scope explicitly).
4. **Dashboard = per-user choice, unchanged mechanism.** Keep the cookie and the toggle exactly as they are.

**Theme persistence — unchanged in this sprint; corrected in P2.**

The approved end-state is **per authenticated user**, stored in `user_ui_preferences` — and that
architecture is **approved** (§6.D). **Its implementation is a P2 deliverable.** This workstream
therefore ships **no migration and no change to `actions/theme.ts` or the theme cookie.** MP1 is
pure CSS scoping plus documentation.

What MP1 **does** deliver on the theme requirement:

- **Verify and test what already holds.** There is **no clinic-wide theme** anywhere in the schema, and a user on one device cannot change another user's theme on another device. Those are the two guarantees the requirement actually asks for, they hold today, and MP1 adds the tests that prove them (§18).
- **Document the true persistence scope honestly** in the MP1 review file: the theme is a **device cookie**, so on a **shared browser** the next user inherits the previous user's theme, and a user's choice does not follow them to a second device. This is a **known, accepted, time-boxed limitation** that P2 closes (§6.D). It is stated plainly, not papered over, and no partial workaround (cookie-namespacing, client-side hacks) is introduced in the meantime — a half-correction now would be thrown away by P2 and would muddy the migration story.
- The root `<html>` `dark` class mechanism is untouched — no FOUC regression, and P2 inherits exactly the mechanism it expects to rewire.

**Marketing light-tone system (leave adjustable):** define the section tone map as **one exported
constant**, not as ad-hoc per-section classes, so the distribution can be retuned in one edit when
the user supplies the next visual reference:

- Tokens: `--m-paper` (base light), `--m-panel` (bright white), plus **new** `--m-warm` (a darker warm/neutral light tone) and `--m-soft` (existing) — a 3–4 step light scale, all ≥ WCAG 4.5:1 against `--m-ink`.
- Today's sections already alternate `paper` / `panel`, with three deliberate **deep-teal inverse bands** (security `#073846`, early-access `#0a4653`, footer `#073846`). Those inverse bands are a *design* choice, not a theme; keep at most two of them as brand anchors unless the user's reference says otherwise, and route every other section through the light scale.
- Constraint: rhythm, not noise — no more than 4 distinct background tones on the page.

### MP2 — Marketing typography & motion

**Font audit (done — this is the input, not the deliverable):**

- The repo ships **no local/self-hosted font files at all** (no `public/fonts`, no `.woff2` anywhere). Every face comes from `next/font/google` in `app/layout.tsx`.
- `next/font/google` **downloads and self-hosts the files at build time** — there is no runtime request to Google, no external DNS, no CSP entry needed, and the CSS variables are already the app's font contract (`--font-sans`, `--font-heading`, `--font-display`, `--font-mono` in `globals.css`). **The current loading strategy is already the production-safe one.** The correct move is therefore to *change the families*, not the mechanism.
- `next/font/local` remains the mechanism for **licensed** faces — which is exactly what P2's Thmanyah needs (§6.B), and what a paid Latin display face would need if the user later buys one.
- Constraint: each weight/style is a separate file. Adding families or weights is the only way this change can cost performance, and the Lighthouse margin is thin (`PREP2-P2`: performance floor hit exactly 90 on one run).

**Recommendation (formal, premium, healthcare-credible, zero licence cost, self-hosted):**

| Role | Today | Recommended | Why |
|---|---|---|---|
| UI / body | DM Sans | **IBM Plex Sans** (400/500/600/700, `latin`) | Institutional, engineered, unmistakably serious — the register healthcare buyers read as credible. Not a "startup geometric". Crucially it is the **Latin companion of IBM Plex Sans Arabic**, which `AI_AGENT_PLAN.md` §4.3 keeps as the Arabic fallback — one coherent bilingual system in P2 instead of two unrelated voices. |
| Display / headlines | Instrument Serif | **Source Serif 4** (400/600, `latin`) — *alternate:* **IBM Plex Serif** | Source Serif 4 is an editorial/academic serif with real weight range and low stroke contrast at large sizes: formal and warm without the fashion-magazine tone Instrument Serif carries at `7.4rem`. IBM Plex Serif is the maximum-coherence alternative (single superfamily) if the user prefers one type voice. |
| Numerals / eyebrows | Geist Mono | **IBM Plex Mono** (400/500) *or keep Geist Mono* | Only worth changing for family coherence; keeping Geist Mono costs nothing and saves a file. |

**Fallback stack (documented in `globals.css`):**
`--font-sans: var(--font-plex-sans), "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif`
`--font-display: var(--font-source-serif), Georgia, "Times New Roman", serif`
(and, in P2, Arabic prepends `var(--font-thmanyah), var(--font-plex-arabic)`.)

**Do not choose the final font blindly:** the implementation must render the hero, one workflow
section, the feature grid, the security band, and the FAQ in **both** the recommended stack and at
least one alternate, capture screenshots at 360 / 768 / 1440 px, record the measured font payload
delta and the three-run Lighthouse result for each, and put that comparison in the review file
before committing to a family. The recommendation above is the starting hypothesis, not the verdict.

**Typographic scale:** the current hero (`clamp(3.25rem, 7.2vw, 7.4rem)` at `tracking-[-.06em]`) is
tuned for Instrument Serif's proportions and will look wrong on a sturdier serif. Retune the display
scale, tracking, and leading as part of this workstream; **preserve the copy and the information
architecture** — only minor copy adjustments are permitted where a line breaks badly under the new
scale, and each one must be listed in the review file.

**Motion — richer, restrained, never generic:**

- Keep the three existing primitives and *deepen* them rather than adding a library: staged hero entrance (eyebrow → headline lines → subline → CTA → product frame, ~60–90 ms stagger), section reveals that also translate/scale by a small amount rather than fade-only, an underline/edge draw on section labels, a subtle parallax offset on the product frames tied to the existing scroll-timeline (`@supports (animation-timeline: view())`), and refined hover physics on cards/CTAs (transform + shadow, one easing curve reused everywhere).
- **Hard rules:** CSS-first (no animation dependency unless it demonstrably beats CSS *and* passes the perf gate); nothing animates `width`/`height`/`top`/`left` (transform/opacity only); no scroll-jacking; no infinite looping motion outside the one existing gentle float; **`prefers-reduced-motion` disables all of it** (the existing reduced-motion e2e and unit test must keep passing unmodified); motion must never affect LCP (the hero product image stays `priority` and un-animated on first paint).
- The page must remain conversion-focused and accessible: the primary CTA stays in the first viewport at 360×640, focus-visible on everything, no motion-only affordances.

### MP3 — Marketing logo treatment

- Remove the `bg-[#13c7d8]` badge `<span>` from [marketing-logo.tsx:23](components/marketing/marketing-logo.tsx#L23) and render `/brand/clinicflow-mark.png` **directly**, transparent, exactly as the sidebar and login already do.
- Keep the mark + "ClinicFlow" wordmark lockup, the `min-h-11` hit target, the accessible name ("ClinicFlow home"), the focus ring, and the `Link href="/"`.
- Contrast: the mark must read on **both** the light header (`--m-paper`) and the dark footer (`#073846`). Verify the asset's own edges/anti-aliasing on both; if the dark footer needs it, use the same mark with a brightness/inverse treatment on the *image* — **never** a background container.
- Same treatment in header and footer. Sizing/spacing responsive; no layout shift (`width`/`height` stay explicit).

### MP4 — Login navigation

- The desktop lockup and the mobile lockup in [app/(auth)/layout.tsx](<app/(auth)/layout.tsx>) currently link to `/login`; both become **`Link href="/"`** with an accessible name of "ClinicFlow home".
- The lockup is the mark **plus** the "ClinicFlow" wordmark, as one semantic link (one focusable element, not two).
- Preserve every auth semantic: login, forgot-password, reset-password, change-password, the magic-link/recovery handoff (`app/auth/confirm`, and the hash-fragment redirect script in `app/page.tsx`), invited signup (`/signup/[token]`), open signup, and the early-access flow. **None of their routes, actions, validation, or rate limiting changes.**
- Note the marketing landing page also owns the recovery handoff (`app/page.tsx` redirects `code`/`token_hash`/`type`/`error` params to `/auth/confirm`) — sending a logged-out user from login to `/` is therefore safe, but the e2e recovery test must still pass.

### MP5 — Country calling-code column alignment

Replace the free-flowing flex row in `CountryCombobox`'s `renderItem`
([international-phone-input.tsx:64-72](components/shared/international-phone-input.tsx#L64-L72)) with
an explicit grid so every row shares one column rhythm:

- `grid grid-cols-[1.5rem_1fr_2.75rem_5rem] items-center gap-2` (widths to be confirmed against the longest rendered country name at the popover width) →
  1. **flag** — fixed cell, centred, `aria-hidden` (emoji advance widths differ per platform; the fixed cell absorbs that entirely — this is the actual cause of the ragged look);
  2. **country name** — `truncate min-w-0`;
  3. **ISO code** — new; `text-xs font-mono uppercase text-muted-foreground` (a genuine addition the user asked for);
  4. **dial code** — `text-end tabular-nums` in a **fixed-width** cell, so `+1`, `+20`, `+965`, `+1 787` all sit in one column with aligned digits.
- The **trigger** keeps `flag + dialCode` and gains `tabular-nums` (already present) plus a fixed width so the trigger does not resize as the selection changes.
- `CommandItem` must not fight the grid — pass the grid classes on the rendered child, or extend `SearchableCombobox`'s item slot; whichever is cleaner, it must not regress the currency and operator-report consumers of the shared combobox.
- **Preserve exactly:** worldwide coverage (all `libphonenumber-js` countries, priority group pinned — `lib/phone/registry.ts`), the cmdk search across `name|code|dialCode`, type-ahead, full keyboard navigation, the selected-country state and the auto-follow behavior on signup (`phoneCountryAutoFollows`), E.164 emission, the hidden `name`/`nameCountry` FormData contract, and server-side `normalizePhone` enforcement.
- **Verify:** the longest country names (e.g. "United States Minor Outlying Islands", "South Georgia & the South Sandwich Islands"), multi-digit and 4-digit calling codes, the popover width on mobile (`w-[280px]` today — must not overflow at 320 px), and both themes.

### MP6 — Platform-Admin header: remove Preferences, reserve the Language-Switcher slot

**"Owner" = Platform Owner / SaaS Operator.** This workstream is about the **operator** header only.
Clinic users — including the **Clinic Owner** — are untouched.

**Ground truth (§2 item 11):** `DashboardShell` is shared by both layouts, and it renders the
user-menu "Preferences" item **unconditionally** ([dashboard-shell.tsx:84](components/layout/dashboard-shell.tsx#L84)).
`/preferences` calls `requireUser()` and reads `clinics`/`profiles`; a **Platform Admin has no
`profiles` row and no `clinic_id`** (`platform_admins.user_id` → `auth.users`). So on the operator
header that item is a **broken link shown to an account that cannot use the page** — a real defect,
not just a layout preference.

**Approved end state:**

| | Clinic dashboard header | **Operator (Platform Admin) header** |
|---|---|---|
| Preferences shortcut | **Kept, exactly as designed** — user-menu item → `/preferences` | **Removed.** No Preferences entry, no Preferences page |
| Theme toggle | Kept | Kept (the Platform Admin's theme is their own, per-user — §6.C) |
| Reserved slot | none — clinic users get their language control **inside Preferences** in P2 | **Permanently reserved for the Operator Language Switcher** (P2). Reserved = **left empty now**, not stubbed |

**Implementation:**

- Make the user-menu Preferences entry **conditional on the shell's audience**. `DashboardShell` already takes a `brandLabel` and a `user` object; add an explicit audience/variant prop (e.g. `surface: "clinic" | "operator"`) rather than sniffing the role string — the operator layout passes `"operator"`, the protected layout passes `"clinic"`. The same prop marks the reserved header slot.
- **Do not add a fake language button.** The reserved position renders **nothing** in this sprint. Mark it with a comment in `dashboard-shell.tsx` naming the reservation and pointing at `AI_AGENT_PLAN.md` §4.1, so P2 mounts the real switcher in exactly that slot.
- **Clinic-side behavior is explicitly unchanged.** `/preferences` keeps its route, its contents, and its access model: reachable by **every** clinic role — Clinic Owner, Clinic Admin, Doctor, Receptionist, Accountant, and future staff roles — via the user menu, which (because `/preferences` deliberately sits outside the admin-gated `/settings`, per Pre-P2 `PREP2-P1`) is their path there. **Removing it from the clinic header is not in scope and would strand the non-admin roles.**
- **Scope of the future Operator switcher, recorded now so P2 cannot drift:** it changes **only the operator dashboard's language, for that platform-admin user**. It has **no effect on any clinic or clinic user**, and it is **not** a platform-wide or clinic-wide setting. See §6.A.
- The Platform Admin's **theme** stays a per-user preference on the same footing as any clinic user's (§6.C, MP1) — the operator header keeps its theme toggle.

### MP7 — Sidebar brand-as-collapse-control & divider baseline

**7a — Brand area becomes the collapse control.**

- **Remove** the dedicated chevron button ([sidebar.tsx:71-81](components/layout/sidebar.tsx#L71-L81)).
- The brand block (mark + "ClinicFlow" wordmark) becomes a single **`<button type="button">`** spanning the brand row, with:
  - `aria-expanded={!isCollapsed}` and an accessible name that states the *action and the state*: `"Collapse navigation"` / `"Expand navigation"` (the brand text remains visible inside it, so the accessible name must be set explicitly via `aria-label` and must not be just "ClinicFlow");
  - `aria-controls` pointing at the `<nav>` id;
  - native `<button>` semantics → **Enter and Space both activate for free**; do not hand-roll key handlers;
  - a visible `focus-visible` ring that is **not** clipped (the sidebar `aside` is already `z-40` and no ancestor clips it once the overhanging chevron is gone — verify with the ring at both widths);
  - the full brand row as the hit target (≥44 px tall — the row is 64 px after 7b), and no nested interactive element inside it.
- **Disambiguation — the UX contract that stops "collapse" reading as "go home" (this is the whole point of the requirement):**
  - There is **no Home/brand navigation action in the sidebar today** — the sidebar logo is a plain `<Image>`, not a link. So there is **no conflict to resolve and no navigation being removed.** Record this explicitly in the review file; it is why this change is safe.
  - "Dashboard" (tenant) and "Mission Control" (operator) are already the first nav item and remain the *only* home affordance. The brand area must never navigate.
  - Affordance: a chevron/panel icon appears **inside the brand row** on hover/focus (inline-end when expanded, replacing nothing; centred under/next to the mark when collapsed), plus a `title`/tooltip reading "Collapse navigation" / "Expand navigation". The user learns the action from the affordance, not from a guess about the logo.
  - The **marketing and login** logos *do* navigate (to `/`), and that is fine — they live on surfaces with no sidebar. The rule is: **inside the dashboard shell, the brand toggles; outside it, the brand navigates.** State that rule in the review file.
- **Mobile sheet:** in `mode="sheet"` the sidebar is never collapsible (`collapsed={false}` is hard-passed by `DashboardShell`). The brand row in the sheet must therefore render as a **non-interactive** brand block (no button, no `aria-expanded`) — the sheet's own close affordance stays authoritative. No hit-target or focus regression in the sheet.
- Keep the mobile header's own brand lockup as-is.

**7b — Divider baseline alignment.**

- Root cause: sidebar brand row `h-18` (**72 px**) vs. content header `h-16` (**64 px**) — the two bottom borders are 8 px apart.
- Fix: **one shared height token** for the shell's top band (e.g. a `--shell-header-h` CSS variable, or a shared constant used by both components) so the sidebar brand row and the content header are provably the same height and their `border-b` lines form **one continuous 1-px baseline**. Do not fix this by nudging one value and hoping.
- Verify: expanded **and** collapsed (the collapsed rail centres the mark — the row height must not change); light and dark; desktop and tablet (`md:` boundary); during the 200 ms `transition-[width]` animation the borders must not overlap, double, or jump; and at every zoom level the two borders must not disagree by a subpixel-rounded 1 px (test at 100 %, 110 %, 125 %).

---

## 10. Recommended implementation order

1. **MP0** — operator black pages (blocking; nothing else should merge before the root cause is *known*).
2. **MP1** — theme scoping (the spine: marketing Light, login Dark, dashboard per-user).
3. **MP4** — login logo → `/` (trivial; lands with or right after MP1's auth-layout edit).
4. **MP3** — marketing logo (trivial; independent).
5. **MP2** — marketing typography & motion (largest visual item; needs MP1's light system to be settled first, otherwise the tone work is done twice).
6. **MP7** — sidebar brand collapse + divider baseline.
7. **MP6** — Platform-Admin header (remove the operator Preferences entry; reserve the Language-Switcher slot). Small and unblocked; may fold into MP7's branch since both touch `dashboard-shell.tsx`.
8. **MP5** — calling-code alignment (fully independent; may run in parallel with anything).

---

## 11. Branch / PR boundaries

One review file per branch, per the review-file workflow contract.

| Branch | Workstream | Est. days |
|---|---|---|
| `fix/post-prep2-operator-black-pages` | MP0 (BUG-4, BUG-5, `(operator)` error boundary) | 1–2 |
| `feat/post-prep2-theme-scopes` | MP1 (+ MP4 if trivially adjacent — both touch `app/(auth)/layout.tsx`) | 1–1.5 |
| `feat/post-prep2-marketing-brand` | MP3 (+ MP4 if not folded above) | 0.5 |
| `feat/post-prep2-marketing-typography` | MP2 | 2–3 |
| `feat/post-prep2-sidebar-brand-collapse` | MP7 (7a + 7b together — same two files) | 1 |
| `feat/post-prep2-operator-header-slot` | MP6 (may fold into MP7 — same file) | 0.25–0.5 |
| `feat/post-prep2-phone-code-alignment` | MP5 | 0.5 |

No branch may depend on an unmerged sibling except as ordered in §10. Each branch is independently
revertable.

---

## 12. Files likely affected

- **MP0:** `app/(operator)/operator/clinics/[id]/page.tsx`, `app/(operator)/operator/reports/[reportId]/page.tsx`, `app/(operator)/operator/reports/[reportId]/export/route.ts`, `app/(operator)/operator/invitations/page.tsx` (if the discriminating test implicates it), `lib/supabase/admin.ts` (`getOperatorClinicHistory`, `safeAuditSummary`), `lib/operator-reports/registry.ts` (`invitationsQuery`), `lib/operator-reports/types.ts` (param parsing), **new** `app/(operator)/error.tsx` + `app/(operator)/not-found.tsx`, tests. Possibly **no code change at all** if the root cause is environmental (§3.2 H1) — in which case the deliverable is the documented environment fix plus the error boundary plus the regression tests.
- **MP1:** `app/globals.css` (dark-variant definition, new `.light` block, marketing tone tokens, removal of `.dark .marketing-page`), `components/marketing/marketing-page.tsx`, `components/marketing/legal-page.tsx`, `components/marketing/early-access-dialog.tsx`, `components/marketing/mobile-marketing-menu.tsx`, `components/marketing/product-screenshot.tsx` (any `dark:` utilities), `app/(auth)/layout.tsx`, `app/layout.tsx` (only if the Toaster needs scoping). **No migration, and `actions/theme.ts` / `components/layout/theme-toggle.tsx` / the two dashboard layouts are *not* touched — theme persistence is P2 (§6.D).**
- **MP2:** `app/layout.tsx` (font imports + variables), `app/globals.css` (`@theme` font mapping, fallback stacks, motion keyframes), `components/marketing/marketing-page.tsx` (type scale), `lib/marketing-copy.ts` (only if a line must be adjusted for layout), `docs/P15C_PERFORMANCE_GATE.md` (re-recorded).
- **MP3:** `components/marketing/marketing-logo.tsx`.
- **MP4:** `app/(auth)/layout.tsx`.
- **MP5:** `components/shared/international-phone-input.tsx`, possibly `components/shared/searchable-combobox.tsx` (item slot), `components/ui/command.tsx` (only if the item layout must be relaxed — prefer not to).
- **MP6:** `components/layout/dashboard-shell.tsx` (audience prop; conditional Preferences entry; reserved slot), `app/(operator)/layout.tsx` + `app/(protected)/layout.tsx` (pass the audience), `tests/unit/components/__snapshots__/dashboard-shell.test.tsx.snap`.
- **MP7:** `components/layout/sidebar.tsx`, `components/layout/dashboard-shell.tsx`, `app/globals.css` (shared shell-height token), `tests/unit/components/__snapshots__/dashboard-shell.test.tsx.snap`, `tests/e2e/smoke.spec.ts`.

---

## 13. Reusable architecture decisions

1. **Theme scope classes are the one mechanism** for surface-level theme forcing: `.light` (forced light subtree) and `.dark` (forced dark subtree), with the dark variant defined as `&:is(.dark *):not(:is(.light *))`. No component may hard-code a second theme mechanism, and no surface may force a theme with a pile of `dark:` overrides.
2. **The marketing section-tone map is a single exported constant.** Retuning the light rhythm is one edit, not a sweep — this is what makes the "adjustable when the user provides the next visual reference" requirement real.
3. **Fonts stay in `next/font`** — `next/font/google` for OFL families (build-time self-hosted), `next/font/local` for licensed families (P2's Thmanyah). Families are referenced **only** through the `--font-*` CSS variables and the `@theme` mapping; no component names a family directly.
4. **The brand lockup has exactly two behaviors, by surface:** inside the dashboard shell it **toggles** the sidebar; outside it (marketing, legal, login) it **navigates to `/`**. No third behavior.
4b. **Per-user UI preferences will live in one auth-user-keyed store** (`user_ui_preferences`, PK = `auth.users.id`, self-only RLS), never on `profiles` — because `profiles` is clinic-scoped and the **Platform Admin has no `profiles` row**. It carries theme **and** locale in one mechanism. **Approved architecture; built in P2** (§6.D) — this sprint neither creates it nor pre-empts it with a stopgap. **No UI preference may ever be stored on `clinics`** — there is no clinic theme and no clinic language.
4c. **The dashboard shell is audience-aware, not role-sniffing.** `DashboardShell` takes an explicit `clinic | operator` audience from its layout. Audience decides which utilities render (clinic → Preferences entry; operator → reserved language slot). Nothing infers the audience from a role string.
5. **One shell top-band height token** shared by the sidebar brand row and the content header — the divider baseline is structural, not a magic number in two files.
6. **The searchable-combobox item slot takes a grid**, so every registry-driven picker (country, currency, report filter) can columnise its own fields without forking the shell (Pre-P2 `PREP2-R5` built the shell; this extends it, it does not duplicate it).
7. **Logical CSS properties only** in all new/edited code (P2B protection). `ms-/me-/ps-/pe-/text-start/text-end/border-s/border-e`, never their physical twins.
8. **Route segments that can throw must own an error boundary.** `(operator)` gets one; any future route group ships with one.

---

## 14. Security & no-PHI guardrails

- **No RLS policy, middleware, or gate-order change.** Any workstream that finds itself editing `middleware.ts`, `lib/supabase/middleware.ts`, or a policy must stop and escalate.
- **No migration and no schema change of any kind.** `supabase/migrations/` and `types/database.ts` must be **untouched** on every branch in this sprint — the same check the Pre-P2 phase review ran (`git status --short supabase/ types/database.ts` → empty) is a merge gate here. The approved `user_ui_preferences` store, its RLS, its profile-migration strategy, and its backfill are **P2A deliverables** (§6.D).
- **Operator surfaces (MP0):** `requirePlatformAdmin()` stays on every query path; queries stay limited to platform tables, clinic metadata, and count-only aggregates; `safeAuditSummary()`'s allowlist stays allowlist-shaped with `default: null`. **No patient PHI may appear in a query, a rendered row, a log line, a Sentry breadcrumb, or an error message** — the new `(operator)/error.tsx` must render the digest and nothing else from the error.
- **Public surfaces (MP1/MP2/MP3):** the early-access RPC boundary, per-IP fail-closed rate limiting, and the three approved `get_public_registration_status()` fields are untouched. No new anon-readable data. No `NEXT_PUBLIC_` addition. Secrets stay in `server-only` modules.
- **Phone (MP5):** server-side `normalizePhone`/E.164 enforcement remains the source of truth; the client presentation change must not widen or narrow what the server accepts.
- **Auth (MP1/MP4):** theming and a link `href` change nothing about authentication. Login, reset-password, magic-link/recovery, invited signup, open signup, and invitation acceptance semantics are byte-for-byte preserved, and their e2e specs must pass unmodified.
- **No fabricated data anywhere** — no synthesized legal-acceptance rows (§8), no invented payment history, no fake testimonials, no placeholder language button pretending to work.

---

## 15. Accessibility requirements

- **WCAG 2.1 AA floor.** Text contrast ≥4.5:1, UI-component contrast ≥3:1, focus visible everywhere, no keyboard traps.
- **MP1:** the forced-dark login must meet contrast on the form, labels, helper text, errors, disabled states, and the focus ring — a panel that was designed against light tokens can silently fail here. The forced-light marketing palette must keep the current **Lighthouse accessibility 100**, including every new light tone against `--m-ink`. Both surfaces must set `color-scheme` correctly so native form controls and scrollbars match.
- **MP2:** heading order and single `h1` preserved; the new type scale must not drop any body text below 16 px on mobile or below 4.5:1; motion strictly behind `prefers-reduced-motion`; no motion-only affordance.
- **MP3:** the logo link keeps its accessible name ("ClinicFlow home"), its ≥44 px target, and a focus ring that is visible on both the light header and the dark footer.
- **MP5:** the combobox keeps its `role="combobox"`/listbox semantics (cmdk), its `aria-label` ("Country calling code"), search, type-ahead, and arrow/Enter/Escape navigation. The flag stays `aria-hidden`; the ISO code and dial code must be part of the option's accessible name, not decoration.
- **MP7:** the brand toggle is a real `<button>` (Enter **and** Space), exposes `aria-expanded` and `aria-controls`, carries an action-and-state accessible name, has a ≥44 px hit target, and its focus ring is never clipped or overpainted. In the mobile sheet the brand row is non-interactive and exposes no `aria-expanded`.
- **MP6:** no control is added; the reserved slot contains nothing (an empty reserved slot cannot fail an audit — a stubbed button would).
- Light **and** dark verification is part of acceptance for MP1, MP5, and MP7.

---

## 16. Responsive requirements

- **Breakpoint contract unchanged:** `<md` = mobile sheet nav; `md`–`lg` = collapsible sidebar; `lg+` = full shell.
- **MP7:** the brand toggle must be verified at the `md` boundary (where the sheet takes over), expanded and collapsed, and mid-transition. The collapsed rail is `w-20` — the brand row must centre the mark without changing height.
- **MP2/MP3:** marketing sections stay mobile-first; the new type scale must be checked at **360 / 768 / 1024 / 1440 px**; no horizontal body scroll at any width; the primary CTA stays within the first viewport at 360×640; the logo lockup must not wrap or shift at 320 px.
- **MP5:** the popover (`w-[280px]`) must not overflow at 320 px; the grid columns must degrade gracefully (the ISO column is the first to be dropped at the narrowest width, never the dial code); the trigger must not resize as the selection changes.
- **MP1:** forced-light marketing and forced-dark login must both hold at every breakpoint, including the mobile marketing menu and the mobile auth lockup.

---

## 17. Performance budgets

The gate contract is `docs/P15C_PERFORMANCE_GATE.md`: **three mobile Lighthouse runs on the
production build, each ≥90 performance and ≥90 accessibility.** Current recorded state: performance
**91 / 90 / 91**, accessibility **100 / 100 / 100**, initial script transfer **198,703 bytes**, LCP
3.5–3.7 s.

- **The margin is one point** (`PREP2-P2`). Treat any change to `/` as performance-affecting until measured.
- **MP2 font budget:** total font payload delta **≤ +30 KB** over today's (measure `.woff2` bytes actually shipped, not the family's full range); **no new render-blocking request** (next/font self-hosts and inlines the `@font-face`); `display: swap` retained; only the weights actually used are loaded; `adjustFontFallback` left on so CLS stays 0. Fewer families is a valid way to buy budget — dropping one of the three current families pays for the new ones.
- **MP2 motion budget:** transform/opacity only; no layout-triggering animation; TBT must stay ≤ ~10 ms; no animation may run before or during LCP; the hero product image stays `priority`.
- **MP1:** the `.light` scope and the token changes are pure CSS — the CSS delta must stay negligible (< 2 KB gzipped) and no JS is added.
- **MP5/MP6/MP7:** no first-load JS delta on any dashboard route (these are markup/class changes). Measure the route JS before/after and record it.
- **Re-record the gate document** (scores, script transfer, LCP, date, commit) on the branch that last touches `/` — that is MP2.

---

## 18. Testing requirements

- **Unit (Vitest):**
  - MP0: whichever helper/parser actually failed; the report param parser against the exact failing query string; `safeAuditSummary` with an unknown action (returns `null`, does not throw); the clinic-history mapper against a clinic with a missing subscription / no invitations / no coupons / no overrides / no usage rows.
  - MP1: the marketing page and legal pages render with the forced-light scope class and **without** any `dark:` utility (assert by scanning the rendered class strings); the auth layout renders with the forced-dark scope class. (`setTheme` is not touched, so its existing coverage must pass **unmodified** — that is the proof this sprint changed no persistence.)
  - MP6: `DashboardShell` with `surface="operator"` renders **no** Preferences entry and **no** language control; with `surface="clinic"` it renders the Preferences entry exactly as today. Snapshot both.
  - MP5: the combobox item renders flag / name / ISO / dial in the fixed grid; the dial column carries `tabular-nums`; long names truncate; the E.164 emission and the hidden-input contract are unchanged (existing `p15d-phone` / `p15d-formdata-phone` / `clinic-signup-phone-country` / `searchable-combobox` suites must pass **unmodified**).
  - MP7: sidebar snapshot in both states (the existing `dashboard-shell.test.tsx.snap` will change — review the diff, don't blind-update); the brand button exposes `aria-expanded`, an action-and-state accessible name, and no `href`; the sheet-mode brand row is non-interactive.
  - MP2: the reduced-motion test (`p15c-reduced-motion.test.ts`) and the marketing-page test (`p15c-marketing-page.test.tsx`) must pass, adjusted only for the new type classes.
- **Integration (fresh local DB):** MP0 — the operator clinic-history query and the invitations report query against (a) a fully-migrated schema, (b) a clinic with no subscription / no invitations / no usage rows; the existing no-PHI assertions extended over any query touched (`ws7-operator-reports`, `ws8-operator-clinic-history`). **No new integration schema fixture** — this sprint adds no table. (The `user_ui_preferences` denial suite — user A vs. user B, platform admin vs. clinic user, and a platform admin storing their own theme without a `profiles` row — is written in **P2A**, with the table.)
- **E2E (Playwright, serial, production build, `PORT=3100`+):** the existing 21-test suite must stay green throughout. Additions:
  - **MP0:** platform-admin opens a clinic from the Clinics table → the history page renders its sections (this test would have caught BUG-4); platform-admin opens the Invitations report → rows render, a filter applies, the URL round-trips.
  - **MP1:** with a dark session, `/` and `/privacy` render **light** (assert a light background token / absence of the dark class in the marketing subtree) and `/login` renders **dark**; with a light session, `/login` is still dark. **Theme independence (what holds today and must not regress):** in **separate browser contexts**, user A sets dark and user B still sees their own theme — no cross-user contamination, and no clinic-wide theme. *(The shared-browser / cross-device case is the P2 `user_ui_preferences` test, §6.D — it is a known limitation until then and must not be asserted as passing here.)*
  - **MP6:** the operator header shows **no** Preferences entry and no language control; the clinic header still shows Preferences and it still opens `/preferences` for a doctor and for a receptionist.
  - **MP4:** clicking the login logo lands on `/` (and the recovery/magic-link e2e still passes).
  - **MP5:** search "united" → the list filters; keyboard arrow + Enter selects; a `+44` number saves and re-opens intact (existing coverage — must not regress).
  - **MP7:** clicking the sidebar brand collapses the sidebar (`data-collapsed="true"`) and does **not** navigate (`page.url()` unchanged); Enter and Space both toggle; the focus ring is visible; the sidebar brand row and the header have the same bottom-border Y coordinate (bounding-box assertion — this is the objective test for 7b).
- **Lighthouse:** three mobile runs on the production build after MP2; gate doc re-recorded.
- **Per-branch gate:** `pnpm typecheck && pnpm lint && pnpm test` plus the targeted integration/e2e before each PR; full serial e2e on the final integrated tree. **No branch adds a migration**, so every branch must also pass the schema gate: `git status --short supabase/ types/database.ts` → **empty**.
- **Physical-direction grep gate** on every branch: zero new physical-direction classes on added lines or in new files.

---

## 19. Manual-testing checklist

- [ ] **MP0:** the affected operator account opens the affected clinic → the history page renders every section; the Invitations report opens with default params, with each filter, on page 2, and its CSV export downloads; `/operator/invitations` (list) also works; a *deliberately* broken operator query shows the new error card with a digest, not a black page.
- [ ] **MP1:** sign in, set the dashboard to **dark**, then visit `/`, `/privacy`, `/terms` → all **light**, coherently, with no dark strip or mixed section; visit `/login` → **dark**; set the dashboard to **light** → `/login` is still **dark**, `/` is still **light**; the dashboard itself honors the chosen theme on every page.
- [ ] **MP1 (theme independence):** the Clinic Owner sets dark on their machine; the Doctor, the Receptionist, and the Platform Admin on their own machines are each unaffected. No clinic-wide theme exists anywhere in Settings. *(Known and accepted until P2: on a **shared browser** the next user inherits the previous user's theme, and the choice does not follow a user to a second device — §6.D. Do not file these as MP1 defects.)*
- [ ] **MP2:** the marketing headline reads as formal and premium at 360 / 768 / 1440 px; no line breaks badly; body text is comfortably readable; motion feels intentional, not template-y; with OS "reduce motion" on, **nothing animates**; the page still loads fast on a throttled mobile profile.
- [ ] **MP3:** the ClinicFlow mark appears with **no square, badge, or background container** in the marketing header and footer; it reads clearly on both; it matches the login and sidebar treatment.
- [ ] **MP4:** clicking the logo/wordmark on `/login` (desktop and mobile) opens the marketing landing page; password reset, magic-link, and invited-signup links still work end to end.
- [ ] **MP5:** open the country dropdown → flags, names, ISO codes, and calling codes each sit in their own aligned column; the calling codes form one clean right-aligned numeric column; search, arrows, Enter, and Escape all work; a UK number still saves; the popover fits on a 320 px phone; both themes.
- [ ] **MP6:** signed in as the **Platform Admin** → the operator header shows **no Preferences entry** and **no language button** (the slot is empty); signed in as a **clinic** user (Clinic Owner, Doctor, Receptionist) → Preferences is still in the user menu and still opens; no fake language button anywhere on either surface.
- [ ] **MP7:** clicking the sidebar logo/brand collapses and expands the sidebar; Tab reaches it, Enter and Space both work, the focus ring is fully visible; it never navigates; the mobile sheet still opens and closes normally; the divider under the brand lines up **exactly** with the header's bottom border — expanded, collapsed, mid-animation, both themes, desktop and tablet.

---

## 20. Acceptance criteria per workstream

- **MP0:** the root cause is *named* in the review file with a captured server error and the §3.2 discriminating-test result; both pages load in the affected environment; every clinic-history section and every Invitations-report filter/sort/page/export path is verified against missing/legacy data; `(operator)/error.tsx` exists and surfaces the digest; regression tests (unit + integration + e2e) added; **no generic fallback hides a failure**; `requirePlatformAdmin()`, no-PHI, and read-only history all intact.
- **MP1:** `/`, `/privacy`, `/terms` render a coherent **Light** page under a dark session, with no `dark:` utility and no `.dark .marketing-page` block left in the tree; `/login` and every auth route render **Dark** under a light session; theme independence is **tested** (no clinic-wide theme; no cross-user contamination across devices) and the current device-cookie persistence scope — with its shared-browser/cross-device gap — is **documented honestly in the review file** as a limitation P2 closes via `user_ui_preferences` (§6.D); **no migration, no `types/database.ts` change, and `actions/theme.ts` untouched**; the light tone system is a single adjustable constant; contrast and the Lighthouse a11y 100 hold; **no middleware or RLS change**.
- **MP2:** the marketing Latin stack is replaced with a formal/premium family chosen from a **recorded comparison** (screenshots + payload + Lighthouse per candidate); the loading strategy is documented and stays self-hosted with zero external requests; copy and IA preserved (any minor copy adjustment listed); motion is richer, restrained, transform/opacity-only, and fully disabled under `prefers-reduced-motion`; the performance gate is re-cleared on three runs and **re-recorded** in `docs/P15C_PERFORMANCE_GATE.md`.
- **MP3:** the transparent mark renders with **no container** in header and footer; correct sizing, contrast, spacing, and responsive behavior on both backgrounds; the same treatment in both places; accessible name, hit target, and focus ring preserved.
- **MP4:** the logo + wordmark on every auth screen is one semantic link to `/`; every auth flow (login, forgot, reset, change-password, magic-link/recovery, invited signup, open signup, invitation acceptance) is unchanged and green in e2e.
- **MP5:** flag, name, ISO code, and dial code sit in a consistent grid; dial codes use tabular numerals in one aligned, fixed-width column; worldwide coverage, search, type-ahead, keyboard navigation, selected-country/auto-follow behavior, E.164 emission, and server enforcement are all unchanged; verified against the longest names, 4-digit codes, 320 px width, and both themes.
- **MP6:** the **operator** header carries **no Preferences entry** (the broken clinic-user link is gone) and **no language control**; its reserved slot is **empty** and documented in code as reserved for the P2 **Operator Language Switcher** (which will govern the operator dashboard's language **only**); the **clinic** header and `/preferences` are **unchanged** and reachable by every clinic role including the Clinic Owner; no fake language button exists on any surface; the shell's audience is an explicit prop, not a role sniff.
- **MP7:** the dedicated arrow toggle is gone; the brand area toggles collapse via a real `<button>` with `aria-expanded`, `aria-controls`, an action-and-state accessible name, Enter **and** Space, a ≥44 px target, and an unclipped focus ring; it never navigates; the sheet brand row is non-interactive; the sidebar and header bottom borders share **one continuous baseline** (bounding-box-asserted) in both states, both themes, desktop and tablet, and during the width transition.

---

## 21. Risks and rollback

| Risk | Mitigation / rollback |
|---|---|
| BUG-4/BUG-5 turn out to be environmental (missing migrations) and "fixing" them produces no code diff | That is a legitimate outcome — the §3.3 protocol distinguishes environment from code *before* any fix. Deliverable becomes: documented environment fix + the `(operator)` error boundary + regression tests that would have caught it. Do not invent a code change to justify the branch. |
| The `.light` scope + dark-variant redefinition regresses the dashboard's dark mode | The redefinition only *narrows* the dark variant, and nothing under `(protected)`/`(operator)` carries `.light`. Guarded by the existing dashboard snapshot + e2e suites; the CSS change is one revert away. |
| Forced-dark login breaks contrast on a panel designed against light tokens | Contrast audit is an explicit acceptance criterion; the auth e2e suite covers the flows, and the change is a single wrapper class to revert. |
| The new marketing font fails the razor-thin Lighthouse gate | Budget checks happen at the *font-selection* step (§ MP2 comparison), not at the end; dropping a family pays for a new one; rollback = revert the `app/layout.tsx` font imports. |
| The brand-as-collapse control confuses users who expect the logo to navigate | The sidebar brand does **not** navigate today, so nothing is taken away; the affordance (icon + tooltip + `aria-expanded`) teaches the action, and "Dashboard"/"Mission Control" remains the home affordance. If it still tests badly, restoring the chevron button is a one-file revert. |
| Removing the Preferences entry from the **operator** header is mistaken for removing it from clinic users | The audience prop makes the two surfaces structurally distinct, and both snapshots are asserted. The clinic-side manual check and e2e (Doctor + Receptionist can still open Preferences) are explicit acceptance criteria. |
| The known theme limitation (shared browser / cross-device) is mistaken for a regression during manual testing | It is stated in §6.D, in the MP1 acceptance criteria, and in the manual checklist as **accepted until P2**. It is pre-existing behavior — this sprint does not touch theme persistence at all, which is exactly why it cannot regress it. |
| Pressure to "just quickly" namespace the theme cookie as a stopgap | Explicitly forbidden (§5, §9-MP1). A half-correction would be discarded by P2's `user_ui_preferences` migration and would complicate its profile-migration/backfill story for no lasting benefit. |
| The combobox grid regresses the currency or operator-report pickers that share the shell | The grid lives in the *item slot*, not the shell; the three consumers' unit suites (`searchable-combobox`, `operator-report-shell`, `p15d-currency`) must pass unmodified. |
| Snapshot churn hides a real regression in MP7 | The snapshot diff must be reviewed line by line in the review file, never blind-updated. |
| Each branch independently revertable | Enforced by the §11 boundaries. |

---

## 22. Open questions still requiring user input

### Decided 2026-07-14 (closed — recorded here so the history is not lost)

- **Q1 — the header Preferences shortcut → RESOLVED.** "Owner" means the **Platform Owner / SaaS Operator**, not the Clinic Owner. The **operator** header must not show Preferences (it is a broken clinic-user link there), and that position is **permanently reserved for the Operator Language Switcher**, which will govern the operator dashboard's language **only**. **Clinic users — including the Clinic Owner — keep Preferences exactly as designed.** See §9-MP6, §6.A.
- **Q2 — theme persistence → RESOLVED: per authenticated user, *implemented in P2*.** The model is approved — not per device, not per clinic; independent for **every** authenticated account **including the Platform Admin** — and the store is an auth-user-keyed `user_ui_preferences` table with self-only RLS (a `profiles` column cannot work: the Platform Admin has no `profiles` row). **The implementation timing moved to P2** (2026-07-14): its migration, RLS, profile-migration strategy, and backfill are P2A deliverables. **This sprint ships no migration** and documents the current device-cookie scope honestly. See §6.D and §9-MP1.

### Still open

3. **Q3 — marketing display font.** The recommendation is **IBM Plex Sans** (UI) + **Source Serif 4** (display). Do you prefer the maximum-coherence alternative, **IBM Plex Sans + IBM Plex Serif** (one superfamily, one voice), or do you want to buy a licensed Latin display face (which would use `next/font/local`, like Thmanyah, and needs the files from you)? The implementation will bring you a rendered side-by-side before committing either way.
4. **Q4 — marketing section tones.** You said the exact light-tone distribution stays adjustable until you provide the next visual reference. Should the three existing **deep-teal inverse bands** (Security, Early-access CTA, Footer) stay as brand anchors within the light page, or should they also become light tones?
5. **Q5 — forced-dark scope.** Forced dark clearly covers `/login`, `/forgot-password`, `/reset-password`, `/change-password`. What about the **public funnel** pages — invited signup (`/signup/[token]`), open signup, and the early-access page — which today follow the dashboard theme? Recommended: they belong to the **marketing funnel** and should be **Light** (visitor arrives from the site or an email, not from the app). Confirm.
6. **Q6 — what happens to `clinics.locale`.** Because dashboard language is now **always per-user** and **there is no clinic language**, `clinics.locale` can no longer resolve anyone's UI language (P2 resolution becomes **user → `en`**, with no clinic tier). Should the column be (a) **retained purely as clinic formatting metadata** — it sits alongside `timezone`/`currency`/`digits`, where a clinic-level locale still has a legitimate non-language use for dates/numbers on clinic-wide artifacts (recommended) — or (b) **retired** in P2? Not open: it may never again be a language source.
7. **Q7 — seat-count definition (billing phase, not now).** "Active staff user" needs one deterministic definition before billing is built: does an *invited-but-not-yet-signed-up* staff member count (you said pending invitations do **not**), and what exactly marks a user "disabled/inactive" today — the schema has no `is_active` flag on `profiles`, so the billing phase will need one or an equivalent derivation. Recorded now so it is not discovered later.

---

## 23. Final definition of done

The sprint is done when:

- Both operator black pages load, with the root cause **named and evidenced** in `docs/reviews/POST_PREP2_MP0_REVIEW.md` and regression coverage that would have caught them; the `(operator)` segment has a real error boundary.
- `/` and the legal pages render a coherent **Light** page for every visitor, in every session, on every device — with the light-tone system expressed as one adjustable constant.
- Every auth screen renders **Dark**, always; its logo + wordmark links to `/`; every auth flow is unchanged and green.
- The marketing site carries a formal, premium Latin type system chosen from a recorded comparison, with richer but restrained, reduced-motion-safe animation, the original copy and IA, and the **re-cleared, re-recorded** Lighthouse gate.
- The ClinicFlow mark appears with **no decorative container** anywhere on the marketing site.
- Dashboard theme independence is **verified and tested** (no clinic-wide theme; no cross-user contamination across devices), and the current device-cookie persistence scope is **documented honestly** as a limitation P2 closes with `user_ui_preferences` — whose migration, RLS, profile-migration strategy, and backfill are recorded as **P2A** work and are **not** in this sprint.
- The **operator** header carries no Preferences entry and an **empty, documented, reserved** slot for the P2 Operator Language Switcher; **clinic users keep Preferences unchanged**; no fake language button exists on any surface.
- The country dropdown shows flag / name / ISO / dial code in one aligned grid with tabular numerals, with worldwide coverage, search, keyboard navigation, and E.164 enforcement all intact.
- The sidebar collapses from its brand area — keyboard-accessible, `aria-expanded`, never navigating — and the sidebar and header dividers form one continuous baseline.
- No fake language button exists; the header slot is reserved and documented for P2.
- **P2 is untouched:** no `next-intl`, no Arabic copy, no Thmanyah files, no RTL, no language switcher (grep-verified, as in the Pre-P2 contract).
- **The sprint remained documentation and UI work only:** `supabase/migrations/` and `types/database.ts` are **untouched** (grep/status-verified on every branch), and `actions/theme.ts` is unchanged.
- All seven review files are APPROVED under the standard workflow; the full validation suite is green on the integrated tree (`supabase db reset` clean, `pnpm typecheck`, `pnpm lint`, full unit + integration, serial production Playwright 100 %); no new physical-direction CSS classes (grep-verified); no RLS/middleware/monetary-column change; and the §6.D (`user_ui_preferences`), §7 (billing), and §8 (legal-acceptance) decisions are recorded in `docs/AI_AGENT_PLAN.md` **without any implementation**.

---

## 24. Post-implementation quick UI polish — completed 2026-07-14

This addendum records finish-level presentation work completed inside the existing Post-Pre-P2
polish sprint. It is **not P2**, does not alter MP0–MP7, and introduces no migration, language or
locale persistence, dashboard-theme architecture, settings architecture, roadmap, routing, pricing,
or business-logic change.

- **Preferences balance — complete.** The existing `max-w-2xl` content column is now horizontally
  centered with `mx-auto`; its cards, copy, width, and responsive behavior are unchanged.
- **Currency option alignment — complete.** Every option uses four fixed grid columns: derived
  currency symbol, currency name, two-letter country ISO code, and three-letter currency code.
  The registry remains the single source of truth, and search, selection, persistence, keyboard
  behavior, and the shared combobox shell are unchanged.
- **Sidebar readability and alignment — complete.** Inactive navigation labels use a slightly
  brighter `text-sidebar-foreground/80`; the single shared shell-height token is restored to
  `4.5rem` (72 px), so the sidebar brand row and dashboard navbar again share one comfortable,
  continuous baseline. Active, hover, focus, spacing, weight, and brand-as-collapse behavior are
  unchanged.
- **Public theme control — complete.** Landing, Privacy, and Terms default to Light and expose a
  small local Light/Dark toggle in their headers. The state is scoped to the public marketing/legal
  subtree, including its mobile menu and Early Access dialog; it neither reads nor writes the
  dashboard theme cookie. Dashboard behavior is unchanged and authentication remains forced Dark.
- **English type consistency — complete.** Manrope is the single English family behind
  `--font-sans`, `--font-heading`, `--font-display`, and `--font-mono`, covering marketing,
  authentication, dashboard, tables, and captured product views. Display and data roles retain
  their existing weights/tracking, but no alternate English family remains. This does not change
  the separate Arabic-font work reserved for P2.
- **Marketing window chrome — complete.** The macOS traffic lights have more space below them; the
  unwanted gray decorative line beside them and the cramped divider treatment are removed.
- **Marketing captures — complete.** All ten affected AVIF assets were replaced through the
  deterministic local seed/capture pipeline. The calendar demo uses a focused Monday–Friday clinic
  schedule, so appointment cards render wider. Nine generated, photorealistic fictional portraits
  now cover every visible patient plus the logged-in administrator; patient-list and patient-record
  mobile layouts keep the existing structure while hiding secondary columns before they can crowd
  the portraits. The capture now waits for every intended local portrait and verifies photographic
  detail in each visible avatar region of the final AVIF, preventing fallback or stale captures.
  The source portraits live in `public/marketing/demo-avatars/`; no initials or cartoon treatments
  appear. Landing asset paths, capture dimensions, and the 300 KB ceiling are unchanged.
- **Kuwaiti revenue composition — complete.** The fictional completed-payment seed now produces
  naturally varied KWD figures, with the captured major totals above KWD 2,500 (for example the
  monthly revenue summary renders KWD 15,447.250 and the patient record KWD 3,240.500).
- **Hero texture — complete.** A static CSS-only honeycomb pattern is scoped to
  `.marketing-hero::before`, spans the full viewport width behind the hero content, and renders at
  `opacity: .07` (7%), with no animation and no spill into later landing sections.
- **Responsive landing composition — complete.** The Hero is a true full-width section while its
  content remains centered inside a readable `max-w-[120rem]` container; the copy keeps its
  existing narrower measure and the screenshot column expands on wide/27-inch displays. Product
  workflows use the same 120rem ceiling with screenshot-weighted columns from `xl` upward. The
  desktop navigation and header CTA now wait until `xl` (1280 px), leaving the logo, 44 px theme
  control, and 44 px menu control collision-free below that breakpoint. At widths below 768 px,
  every product frame uses the complete 390×844 mobile AVIF with `object-contain` and its native
  portrait ratio; the already-optimized AVIF is served directly to avoid a second lossy transform.
  No screenshot asset, copy, color, animation, theme behavior, or route changed in this correction.
- **Early Access spacing — complete.** The section keeps its layout and responsive structure while
  using a vertically centered `min-h-[78dvh]`, `py-48` / `lg:py-60`, a larger heading and body,
  and wider internal rhythm. The cohort proof band and progress card also gain more vertical space,
  larger progress text, and a slightly taller bar. Its responsive minimum height now steps from
  32rem on phones through 36rem / 40rem / 44rem to 48rem on large desktops, keeping the whole band
  vertically balanced rather than enlarging only the card. The form/dialog itself is not enlarged.
- **Authenticated navbar flow — complete.** The clinic/operator dashboard top header keeps its
  original height, layout, controls, permissions, and mobile treatment, but no longer uses
  sticky/fixed positioning. It scrolls away naturally with the document and returns only at the
  page top; the public marketing header is unchanged.
- **Mobile dashboard and revenue captures — complete.** The dashboard revenue summary stacks as
  compact rows at 320 px, reflows into two columns plus a full-width month card from 360 px, and
  returns to its original three-column desktop layout at `sm`. The mobile Revenue / Sales Report
  now places its results before its still-available filters, showing complete KWD totals and table
  data immediately; its metrics use one compact row at 320 px and two columns from 360 px while the
  desktop filter-first order remains unchanged. The capture pipeline can select names and variants,
  so only `dashboard-mobile.avif` and `reports-mobile.avif` were regenerated. It now rejects bucket
  overlap, clipped figures, horizontal overflow, or filter-first report composition at 320×568,
  360×800, 390×844, and 430×932 before writing an asset.
- **Landing Back to Top — complete.** The public landing page alone now exposes a fixed circular
  primary-color Back-to-Top control after a meaningful scroll distance. It has a 48 px target,
  screen-reader label, keyboard focus ring, safe-area-aware mobile/desktop offsets, a fade/slide
  transition, and `z-30` placement below the `z-40` marketing header and dialog/top-layer overlays.
  It hides and leaves the tab order near the top, scrolls smoothly when motion is allowed, and
  switches to an instant return with all transitions disabled under reduced motion. Authenticated,
  operator, authentication, and legal pages do not render it.

`docs/AI_AGENT_PLAN.md` required no update: these are completed presentation details in the
existing Post-Pre-P2 sprint and do not change the roadmap or any future-phase contract.

**Validation:** `pnpm marketing:capture` passed and replaced all 10 affected fictional-demo assets,
including final-AVIF avatar-region checks; direct desktop/mobile visual review confirmed the
portraits. The production build inside that pipeline passed (52/52 static pages); `pnpm typecheck`
passed; `pnpm lint` passed with 0 errors and the same 4 pre-existing warnings; the full non-DB
Vitest suite passed (105 files, 539 tests); and the targeted authenticated-header Playwright test
passed. The final responsive correction additionally passed 16 targeted unit tests and production
Playwright checks at 320, 360, 390, 430, 768, 1024, 1440, 1920, and 2560 px, including exact
document-width, header-overlap, touch-target, full-bleed pattern, image-ratio, containment, and
wide-screen screenshot-size assertions. Final production-build and diff/status gates are recorded
in the implementation handoff. The final phone-capture correction additionally passed capture-time
layout assertions at all four requested phone sizes; visual review confirmed the three dashboard
revenue cards and the report's KWD totals/results in the final AVIFs. Targeted production Playwright
checks passed the four-size landing asset contract plus Back-to-Top visibility, edge spacing,
keyboard activation, return-to-top behavior, and reduced-motion handling.

---

## Appendix A — Sprint summary (one paragraph)

Prove and fix the two operator black pages first — both are the only paths that read
`clinic_invitations.email_sent_at`, both throw, and the `(operator)` segment has no error boundary,
so the failure paints as a black screen — then land the theme spine (a `.light`/`.dark` scope
primitive that makes the marketing site permanently Light and the login permanently Dark while the
dashboard stays each user's own choice, with the device-cookie persistence documented honestly and
corrected in the smallest safe way), then the small brand fixes (the un-badged marketing logo, the
login logo linking to `/`), then the largest visual item (a formal, premium, self-hosted Latin type
system chosen from a measured comparison, plus richer restrained motion that still clears the
razor-thin Lighthouse gate), then the shell work (the sidebar brand becomes the collapse control and
the brand/header dividers finally share one baseline), the Platform-Admin header correction (its
Preferences entry — a broken clinic-user link — is removed and the position permanently reserved for
the P2 Operator Language Switcher, while every clinic user keeps Preferences untouched), and the
calling-code column alignment. Seven branches, ~6–9 dev-days, **documentation and UI only — zero
migrations**: the approved auth-user-keyed `user_ui_preferences` store (theme + locale, per
authenticated account including the Platform Admin) is recorded as the official persistence
architecture but **implemented in P2**, along with its RLS, profile-migration strategy, and backfill.
No clinic-wide language or theme, no P2 scope — with the per-seat pricing model and the future
legal-acceptance/audit requirement recorded in `docs/AI_AGENT_PLAN.md` for their own later phases.
