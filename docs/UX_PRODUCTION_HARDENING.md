# UX Production Hardening — Phased Implementation Specification

**Status:** APPROVED SCOPE — ready for implementation (phase by phase, on explicit instruction only)
**Date:** 2026-07-16
**Base of audit:** `feat/production-seo-hardening` at `a2767c2` (clean tree). Every file reference below was read at that commit.
**Single source of truth:** this file is the only planning document for this sprint. §Phases *is* the implementation order; no separate implementation-order document may be created.
**Review contract:** every phase follows the established review-file workflow — implementation → `docs/reviews/ux/P<N>_IMPLEMENTATION.md` → review/fix cycle → merge. Each phase is independently implementable, testable, reviewable, and rollbackable.
**Position in roadmap:** after the merged SEO production hardening (`docs/SEO_PRODUCTION_HARDENING.md`). This sprint is UX gap-closure only; it introduces no migration, no new runtime dependency (one optional dev-only dependency in P4), and no architectural change.

---

## 1. Governing rules (apply to every phase)

These override anything ambiguous later in this document.

1. **The current production architecture is correct.** If any requirement below conflicts with the existing architecture during implementation, the architecture wins and the deviation is recorded in that phase's implementation report. The specification adapts to the project, never the opposite.
2. **No redesign. No business-logic changes.** No Supabase, RLS, database, billing, permissions, middleware, or domain-model changes of any kind.
3. **No new libraries** for animation, state management, offline, or routing. No service worker, no write queue. The only permitted new dependency in the entire sprint is the optional **dev-only** `@axe-core/playwright` in P4 — and P4 is skipped entirely if that is unacceptable.
4. **No React Context, no global providers, no new custom hooks** unless absolutely necessary. Prefer extending existing shared components ([components/shared/](components/shared/), [components/ui/](components/ui/)) over creating new ones. If an existing component can be reused with small modifications, that always takes priority.
5. **Do not replace existing working states.** Every change fills a verified gap or standardizes a proven inconsistency. Existing `error.tsx`, `loading.tsx`, empty states, toasts, and confirmation dialogs stay as they are.
6. **Preserve** Arabic/English i18n, RTL/LTR (logical properties only — `ms-/me-/ps-/pe-/text-start`; `pnpm lint:rtl` must stay green), responsive behavior, accessibility, and the performance gate (`docs/P15C_PERFORMANCE_GATE.md`).
7. **All user-facing strings** go through next-intl: keys added to **both** `messages/en.json` and `messages/ar.json`; `pnpm i18n:missing` and `pnpm lint:i18n` must pass.
8. **Minimize surface area:** fewest files, no duplication, no speculative abstraction.
9. **Do not commit or push.** Each phase ends with a clean report and waits for review.
10. Standard gates per phase: `pnpm typecheck`, `pnpm lint`, `pnpm lint:rtl`, `pnpm lint:i18n`, `pnpm i18n:missing`, `pnpm test` (scoped as each phase states), and the phase's manual verification list. E2E, where required, runs per the validation-suite convention (local Supabase keys via `supabase status`, dev server on `PORT=3100`).

---

## 2. Corrections to the original audit (verified during spec writing)

Recorded here so the implementation does not chase phantom gaps:

- **`/patients/[id]`, `/patients/new`, `/patients/[id]/edit`, and `/appointments/new` are NOT loading-blind.** Next.js App Router applies the closest ancestor `loading.tsx` to nested segments, so these routes already show the segment skeletons at [app/(protected)/patients/loading.tsx](<app/(protected)/patients/loading.tsx>) and [app/(protected)/appointments/loading.tsx](<app/(protected)/appointments/loading.tsx>). The same applies to all `/reports/*` sub-pages via [app/(protected)/reports/loading.tsx](<app/(protected)/reports/loading.tsx>).
- The **true** loading gaps are the two segments with no ancestor boundary at all: the **settings segment** (only `settings/staff/` has one) and the **operator segment** (only `operator/reports/[reportId]/` has one). P2 is scoped accordingly, plus one shape-fidelity boundary for the heaviest detail page.

---

## 3. Phase list

| Phase | Title | Status | Required? |
|---|---|---|---|
| **P1** | Public crash-surface closure (root error boundaries) | pending | Required |
| **P2** | Loading-boundary coverage for settings + operator segments | pending | Required |
| **P3** | Input-loss protection, skip link, login localization, loading a11y | pending | Required |
| **P4** | Offline notice + automated axe coverage | pending | **Optional** — only if clearly low-risk and lightweight |

Phases are ordered by user value but are independent: any phase can be implemented, reviewed, and rolled back without the others.

---

## 4. Phase 1 — Public crash-surface closure

### Objective

Any unexpected render/data error on a public or unbounded route shows a branded, localized, recoverable error page instead of Next.js's unstyled default — the exact "black page" failure class this repo already proved and fixed on the operator side (BUG-4/5, `docs/POST_PRE_P2_MANUAL_POLISH.md` §3).

### Current verified gap

`find app -name "error.tsx"` returns exactly three boundaries: [app/(auth)/error.tsx](<app/(auth)/error.tsx>), [app/(protected)/error.tsx](<app/(protected)/error.tsx>), [app/(operator)/error.tsx](<app/(operator)/error.tsx>). There is **no `app/error.tsx` and no `app/global-error.tsx`**. Consequently:

- Errors thrown on `/` (marketing), `/privacy`, `/terms`, `/early-access`, `/signup`, `/signup/[token]`, `/signup/complete`, `/auth/confirm`, `/forgot-password`, `/reset-password` (the recovery pages live under [app/auth/layout.tsx](app/auth/layout.tsx) / [app/(public)/layout.tsx](<app/(public)/layout.tsx>), which have no boundary) fall through to the framework default. `/signup/[token]` is a prospective customer's first authenticated-ish interaction.
- Errors thrown **in the root layout itself** ([app/layout.tsx](app/layout.tsx) — `getLocale`/`getMessages`/`resolveTheme` all run there) have no `global-error.tsx` catcher at all.

### Existing components/patterns to reuse

- The boundary pattern in [app/(protected)/error.tsx](<app/(protected)/error.tsx>): client component, `useEffect(() => console.error(error))`, `AlertTriangle` in a `bg-destructive/10` circle, localized title/description, digest line, `reset()` button + escape link. Copy this structure; do not invent a new visual language.
- [components/ui/button.tsx](components/ui/button.tsx), `lucide-react` icons, existing message-namespace conventions.
- Sentry is already initialized in [sentry.client.config.ts](sentry.client.config.ts) / server / edge.

### Exact scope

1. **`app/error.tsx`** (new): root-level boundary covering every segment that lacks a closer one. Same structure as the protected boundary; escape link goes to `/` (label along the lines of "Back to home") instead of `/dashboard`. Translations via `useTranslations` — reuse existing keys where an identical string already exists (e.g. `somethingWentWrong` / `tryAgain` variants in the `auth` and `protected` namespaces); add new keys only where none fits, in the namespace the implementation finds most consistent (the `public` namespace exists). Route groups with their own `error.tsx` are unaffected — the closest boundary always wins, so this is purely additive.
2. **`app/global-error.tsx`** (new): catches root-layout failures. **Constraint: when this renders, the root layout — and with it `globals.css`, fonts, and `NextIntlClientProvider` — is gone.** It must therefore be fully self-contained: renders its own `<html>`/`<body>`, minimal inline styles (no Tailwind classes — they may not be loaded), **static bilingual text (Arabic and English both rendered, no i18n runtime)**, a plain "Try again" button calling `reset()`. Per Sentry's own template for this file, call `Sentry.captureException(error)` in a `useEffect` — this is the one place errors would otherwise vanish entirely. Keep it under ~60 lines.
3. **Message keys** (only if new ones are needed): added to `messages/en.json` **and** `messages/ar.json`.

### Files to inspect (read before writing)

- `app/(protected)/error.tsx`, `app/(auth)/error.tsx`, `app/(operator)/error.tsx` (pattern + which keys already exist)
- `app/layout.tsx` (what global-error loses when the root layout unmounts)
- `messages/en.json`, `messages/ar.json` (existing error-string keys)
- `sentry.client.config.ts`
- Sentry `global-error` reference template for `@sentry/nextjs`

### Files expected to change

| File | Change |
|---|---|
| `app/error.tsx` | **new** |
| `app/global-error.tsx` | **new** |
| `messages/en.json`, `messages/ar.json` | additive keys, only if needed |

Nothing else. If implementation discovers a fourth file is genuinely required, stop and record why in the report before proceeding.

### Systems that must not change

The three existing group boundaries; theme scoping (`.marketing-page` light scope, auth dark panel); middleware; Sentry config files; any page or layout component.

### Implementation requirements

- `app/error.tsx` is a client component; match the existing boundary's markup rhythm and logical-properties convention.
- Accepted behavior (do not fix): a dark-theme session that hits the root boundary on `/` sees the boundary in dark tokens, because the boundary replaces the page content and the `.marketing-page` light scope with it. This is a degraded-state screen; theme purity is out of scope.
- `global-error.tsx` must not import from `@/components/ui/*`, `next-intl`, or anything that assumes the root layout rendered. `import * as Sentry from "@sentry/nextjs"` is fine.
- No retry loops, no error classification, no reporting UI beyond the digest.

### Focused tests

- Unit (vitest, `tests/unit/app/`): render `app/error.tsx` with a mock error + digest → asserts title, digest text, `reset` invoked on click (mirror however existing boundary tests are structured under `tests/unit/`, if any; otherwise a minimal new spec).
- `global-error.tsx`: render test asserting self-containment (no throw without providers) and that `reset` is called. If jsdom fights the `<html>` wrapper, assert on the inner content component instead — do not contort the test.

### Manual verification

1. Temporarily throw inside `app/page.tsx` (dev only, not committed) → branded boundary appears on `/` in both `ar` and `en`, "Try again" recovers after removing the throw.
2. Temporarily throw inside `app/(public)/signup/[token]/page.tsx` → same boundary.
3. Temporarily throw inside `app/layout.tsx` → `global-error` renders legibly (light, readable, bilingual) instead of a blank/black page.
4. Confirm `/dashboard` errors still hit the **protected** boundary (unchanged).
5. RTL check: boundary on `/?landingLocale=ar` renders correctly mirrored.

### Risks

- `global-error.tsx` only renders in production builds for root-layout errors (dev overlays intercept). Verify with `pnpm build && pnpm start` if dev behavior is inconclusive.
- Over-styling `global-error` with framework CSS that isn't loaded → keep inline styles.

### Completion criteria

Both files exist, all gates green (§1.10), manual list passes, no other file changed beyond message JSON.

### Stop condition

If either boundary cannot be made to render without touching any layout, middleware, or provider, **stop and report** — do not restructure layouts to accommodate the boundary.

### Implementation report

`docs/reviews/ux/P1_IMPLEMENTATION.md`

---

## 5. Phase 2 — Loading-boundary coverage

### Objective

Every authenticated navigation shows skeleton feedback within one frame, including the settings and operator segments, so the app never appears frozen on slow clinic networks.

### Current verified gap

- **Settings segment:** `app/(protected)/settings/` has [layout.tsx](<app/(protected)/settings/layout.tsx>) and 8 pages but no `loading.tsx`; only `settings/staff/` has one. Navigating to `/settings`, `/settings/services`, `/settings/departments`, `/settings/insurance`, `/settings/packages`, `/settings/clinic`, `/settings/customize` gives no feedback until the RSC resolves.
- **Operator segment:** only `operator/reports/[reportId]/` has a `loading.tsx`. `/operator` (dashboard), `/operator/clinics`, `/operator/clinics/[id]`, `/operator/coupons`, `/operator/invitations`, `/operator/reports` (index), `/operator/settings` have no boundary.
- **Shape fidelity (secondary):** `/patients/[id]` ([828-line RSC](<app/(protected)/patients/[id]/page.tsx>), the heaviest page in the product) currently falls back to the patients **list** skeleton — feedback exists but its shape is misleading during the longest wait in the app.

### Existing components/patterns to reuse

- [TableSkeleton](components/shared/data-table.tsx#L46) and [components/ui/skeleton.tsx](components/ui/skeleton.tsx).
- The hand-shaped segment skeletons: [app/(protected)/patients/loading.tsx](<app/(protected)/patients/loading.tsx>) (header block + toolbar + table) and [app/(protected)/settings/staff/loading.tsx](<app/(protected)/settings/staff/loading.tsx>).
- The a11y-correct example: [app/(operator)/operator/reports/[reportId]/loading.tsx](<app/(operator)/operator/reports/[reportId]/loading.tsx>) (`role="status"` + localized `aria-label`) — new files follow **this** pattern from day one (P3 retrofits the older files).

### Exact scope

Three new files, nothing else:

1. **`app/(protected)/settings/loading.tsx`** — generic settings-shaped skeleton (page-header block + card/table block). Covers all settings children without their own boundary; `settings/staff/loading.tsx` continues to win for staff (closest boundary), so it is untouched.
2. **`app/(operator)/operator/loading.tsx`** — generic operator-shaped skeleton (header + stat-row + table block). One file covers the whole operator segment; `operator/reports/[reportId]/loading.tsx` continues to win for report detail.
3. **`app/(protected)/patients/[id]/loading.tsx`** — detail-shaped skeleton approximating the patient page's real rhythm (header with avatar circle + info cards + sectioned lists). This *narrows* an existing fallback; it does not replace a working state.

Explicitly **out of scope**: loading files for `/profile`, `/preferences`, `/onboarding`, auth pages, marketing (all light or already covered); any Suspense restructuring inside pages; streaming/PPR work.

### Files to inspect

- The three reuse references above, plus `app/(protected)/settings/layout.tsx` (the skeleton must sit sensibly inside the settings nav layout — the boundary renders **inside** the layout, so it must skeleton only the content pane, not the settings nav)
- `app/(protected)/patients/[id]/page.tsx` (real page shape to approximate)
- `app/(operator)/operator/page.tsx`, `app/(operator)/operator/clinics/page.tsx` (operator shapes)

### Files expected to change

| File | Change |
|---|---|
| `app/(protected)/settings/loading.tsx` | **new** |
| `app/(operator)/operator/loading.tsx` | **new** |
| `app/(protected)/patients/[id]/loading.tsx` | **new** |
| `messages/en.json`, `messages/ar.json` | additive `aria-label` keys, only if no existing key fits |

### Systems that must not change

All existing `loading.tsx` files; every page/layout; data fetching; navigation.

### Implementation requirements

- Skeleton-only components: no data fetching, no client interactivity beyond what `useTranslations` needs for the `aria-label`.
- `role="status"` + localized `aria-label` on the wrapper; `aria-hidden="true"` on the skeleton internals (match the operator report loading file).
- Logical properties only; verify both themes (skeleton token is theme-aware already).
- Approximate shape, don't replicate: ≤ ~50 lines per file. No pixel-matching.

### Focused tests

- Render tests are low value for pure skeletons; a single vitest render per new file asserting `role="status"` and no crash is sufficient. Do not build snapshot tests.

### Manual verification

1. With devtools network throttled to Slow 3G (or a `setTimeout` temporarily added to a page's data fetch, not committed): navigate to `/settings/services`, `/operator/clinics`, `/operator/clinics/[id]`, `/patients/[id]` → skeleton appears immediately, correct shape, both themes, both locales (RTL mirror check on `/settings`).
2. `/settings/staff` still shows its own dedicated skeleton (unchanged precedence).
3. `/operator/reports/<id>` still shows its dedicated skeleton.

### Risks

- The settings boundary rendering inside `settings/layout.tsx` — if the layout itself fetches slowly, the boundary can't help that; accepted (the layout is light).
- Skeleton/page shape drift over time — accepted; approximation is the standing convention here.

### Completion criteria

Three files exist, gates green, manual list passes, zero modified pages.

### Stop condition

If achieving feedback on any route would require restructuring a page into Suspense children or touching a layout, **stop and report** — segment-level `loading.tsx` is the entire permitted mechanism.

### Implementation report

`docs/reviews/ux/P2_IMPLEMENTATION.md`

---

## 6. Phase 3 — Input-loss protection, skip link, login localization, loading a11y

### Objective

Close the four small, verified UX/a11y/consistency gaps in the authenticated experience: long-form data loss, keyboard skip navigation, hardcoded English login validation, and silent loading states.

### Current verified gap

1. **Unsaved-changes:** [components/appointments/appointment-form.tsx](components/appointments/appointment-form.tsx) (878 lines) and [components/patients/patient-form.tsx](components/patients/patient-form.tsx) (663 lines) — both RHF forms — have no protection against refresh/tab-close (`grep -ri beforeunload components` → 0 hits). A receptionist mid-entry loses everything.
2. **Skip link:** [components/layout/dashboard-shell.tsx](components/layout/dashboard-shell.tsx) has none (`grep -ri "skip" components/layout` → 0); keyboard users traverse the full sidebar on every page.
3. **Login validation is hardcoded English:** [login-form.tsx:24-27](components/auth/login-form.tsx#L24-L27) — `"Email is required"`, `"Enter a valid email"`, `"Password is required"` — while every other form localizes via the message catalogs / [lib/validations/error-map.ts](lib/validations/error-map.ts).
4. **Loading a11y:** of the 8 pre-existing `loading.tsx` files, only the operator report one has `role="status"` + `aria-label`; the other 7 are visually fine but announce nothing to screen readers.

### Existing components/patterns to reuse

- RHF `form.formState.isDirty` — both forms already own a `useForm` instance; no new state is needed.
- The confirm-before-discard interaction already established in [components/settings/page-visibility-customizer.tsx](components/settings/page-visibility-customizer.tsx) and the 16 existing `AlertDialog` surfaces — reuse [components/ui/alert-dialog.tsx](components/ui/alert-dialog.tsx) verbatim for any in-app-navigation confirm.
- Login localization: follow whichever localized-schema pattern the sibling auth forms use ([components/auth/change-password-form.tsx](components/auth/change-password-form.tsx), [reset-password-form.tsx](components/auth/reset-password-form.tsx), [forgot-password-form.tsx](components/auth/forgot-password-form.tsx)) — inspect first, copy that pattern exactly rather than inventing one.
- Loading a11y: the operator-report loading file is the template.

### Exact scope

**3a. Unsaved-changes guard (smallest reliable solution — decided):**

- **One tiny shared client component**, `components/shared/unsaved-changes-guard.tsx` (~30 lines): props `{ when: boolean }`; a single `useEffect` that, while `when` is true, registers a `beforeunload` handler (`event.preventDefault()` + legacy `returnValue`) and removes it on cleanup/unmount. No context, no provider, no hook export — a render-null component is the minimal shared surface for two consumers. (If review prefers zero new files, the fallback is the identical `useEffect` inlined into both forms; the shared component is preferred only because it avoids duplicating browser-quirk code.)
- Mount it in the appointment form and the patient form: `<UnsavedChangesGuard when={form.formState.isDirty && !isSubmitting} />` (exact pending-flag names per each form). It must be **disarmed** while a submit is in flight and after success — successful submits navigate client-side (`router.push/replace`), which never fires `beforeunload`, so no unload prompt appears on save; the disarm is for full-page redirects/edge cases.
- **In-app navigation — safely controllable surfaces only:** if either form renders its **own** Cancel/Back affordance, wire that affordance (and only that) through an `AlertDialog` confirm when dirty, reusing the existing discard-dialog copy pattern. Inspect both forms first; if a form has no such affordance, add nothing.
- **Documented limitation (accepted, by decision):** App Router exposes **no stable API to intercept or cancel client-side navigations** (sidebar links, browser back within the SPA). Global interception via router monkey-patching, `window.history` manipulation, or link-wrapper providers is **prohibited** by this spec as fragile and architecture-hostile. Protection therefore covers: browser refresh, tab/window close, external navigation, and the forms' own cancel/back controls. Sidebar-link data loss remains possible and is recorded as a known limitation in the implementation report. This is the safest partial protection, chosen deliberately over a risky complete one.

**3b. Skip link:**

- In `dashboard-shell.tsx`: a visually-hidden-until-focused anchor as the first focusable element (`sr-only focus:not-sr-only` + positioned styling consistent with shell tokens), `href="#main-content"`; add `id="main-content"` and `tabIndex={-1}` to the existing `<main>` ([dashboard-shell.tsx:115](components/layout/dashboard-shell.tsx#L115)). Covers both clinic and operator surfaces in one change (shared shell). Localized label ("Skip to content"), logical properties. Marketing/auth are out of scope (single-column, low nav burden).

**3c. Login schema localization:**

- Replace the three hardcoded strings in `login-form.tsx` with the sibling auth forms' localization pattern; keys added to both catalogs if not already present. No behavior change.

**3d. Loading-boundary a11y retrofit:**

- Add `role="status"` + localized `aria-label` wrapper (operator-report pattern) to the 7 pre-existing protected loading files: dashboard, patients, appointments, followups, revenue, reports, settings/staff. Content unchanged; wrapper attributes only. (P2's new files ship correct already.)

### Files to inspect

- `components/appointments/appointment-form.tsx` (full read: submit flow at the `onSubmit`/`pendingFd` machinery, existing `AlertDialog` at L856, any cancel/back affordance, pending flags)
- `components/patients/patient-form.tsx` (same)
- `components/settings/page-visibility-customizer.tsx` (discard-dialog copy pattern)
- `components/layout/dashboard-shell.tsx`, `components/layout/sidebar.tsx` (tab order for the skip link)
- `components/auth/change-password-form.tsx`, `reset-password-form.tsx`, `forgot-password-form.tsx` (the localization pattern to copy), `lib/validations/error-map.ts`
- All 8 existing `loading.tsx` files + `app/(operator)/operator/reports/[reportId]/loading.tsx`
- `messages/en.json`, `messages/ar.json`

### Files expected to change

| File | Change |
|---|---|
| `components/shared/unsaved-changes-guard.tsx` | **new** (~30 lines; the sprint's only new component) |
| `components/appointments/appointment-form.tsx` | mount guard; optional cancel-affordance confirm |
| `components/patients/patient-form.tsx` | mount guard; optional cancel-affordance confirm |
| `components/layout/dashboard-shell.tsx` | skip link + `main` id/tabIndex |
| `components/auth/login-form.tsx` | localized schema messages |
| 7 × existing `loading.tsx` (protected) | `role="status"` + `aria-label` wrapper attrs |
| `messages/en.json`, `messages/ar.json` | additive keys |

### Systems that must not change

Form validation logic, submit flows, server actions, RHF schemas beyond message strings; sidebar navigation behavior; the router; middleware; any dialog's existing semantics.

### Implementation requirements

- The guard component: no context/provider/hook export; no `usePathname`/router subscription; `beforeunload` only.
- Skip link must be the **first** element in shell tab order and must not appear on screen except when focused; verify RTL positioning.
- `aria-label` strings localized in both catalogs; reuse one shared "Loading…"-style key across loading files rather than 7 bespoke keys, unless a per-page label already exists.
- Login schema: build inside the component with `t()` or via the error map — whichever the sibling forms already do. Do not introduce a third pattern.

### Focused tests

- Unit: guard component — registers `beforeunload` when `when=true`, removes on `when=false`/unmount (jsdom `addEventListener` spy).
- Unit: login form renders localized required-field errors on empty submit (both catalogs load in tests via the existing i18n test helpers under `tests/unit/helpers`/`mocks` — inspect and reuse).
- Existing form test suites must stay green untouched.

### Manual verification

1. Start a new appointment, type into one field, hit browser refresh → native "leave site?" prompt; cancel → data intact. Repeat for tab close and for patient create/edit.
2. Save the appointment successfully → **no** prompt at any point.
3. Untouched form → refresh prompts nothing.
4. Tab from a fresh `/dashboard` load → skip link appears first, Enter lands focus in main content; verify in RTL and on the operator shell.
5. `/login` in Arabic → submit empty → Arabic validation messages.
6. VoiceOver (or NVDA) on a throttled `/patients` navigation → loading state is announced.

### Risks

- `beforeunload` prompts are browser-controlled (generic text, sometimes suppressed without user interaction) — accepted; that is the platform ceiling without prohibited interception.
- `isDirty` false-positives if a form resets defaults asynchronously — verify both forms' `defaultValues` behavior before wiring; if a form initializes dirty, gate on `isDirty && touched` or fix the default, whichever is smaller.
- Skip link visual regression in the header stack — keep it absolutely positioned within existing tokens.

### Completion criteria

All four sub-items done, gates green, manual list passes, the known in-app-navigation limitation documented in the report.

### Stop condition

If reliable dirty detection or safe cancel-affordance wiring in either form requires restructuring the form's submit machinery, **stop for that form** and ship `beforeunload`-only protection for it, recording the reduction. Never touch the router or history to compensate.

### Implementation report

`docs/reviews/ux/P3_IMPLEMENTATION.md`

---

## 7. Phase 4 — Offline notice + automated axe coverage (OPTIONAL)

**Gate:** implement only if both items prove clearly low-risk and lightweight during inspection; either item may be dropped independently. Dropping P4 entirely is an acceptable outcome and is recorded, not justified.

### Objective

(a) A user who loses connectivity is told so once, via the existing toast system. (b) The authenticated shell gets a minimal automated accessibility regression check.

### Current verified gap

- `grep -ri "navigator.onLine\|offline" components lib app` → 0 hits: a dropped connection surfaces only as eventual generic failure toasts.
- No axe/a11y assertions anywhere in `tests/`; the Lighthouse a11y gate covers marketing only.

### Existing components/patterns to reuse

- sonner is mounted globally ([app/layout.tsx:43](app/layout.tsx#L43)); `toast.warning`/`toast.success` with ids for dedupe.
- E2E conventions in [tests/e2e/](tests/e2e/) and [playwright.config.ts](playwright.config.ts); local-stack workflow (Supabase keys via `supabase status`, `PORT=3100`).

### Exact scope

1. **`components/shared/network-status-toast.tsx`** (new, ~25 lines): client component rendering null; one `useEffect` with `online`/`offline` listeners → `toast.warning(t("youAreOffline"), { id: "network-status", duration: Infinity })` and `toast.success(t("backOnline"), { id: "network-status" })` on recovery. Mounted **once** next to the `Toaster` in `app/layout.tsx`. No context, no polling, no fetch probing, no queueing, no retry logic.
2. **`tests/e2e/a11y.spec.ts`** (new) + **`@axe-core/playwright`** (dev-only dependency — the sprint's single permitted addition; if adding it is rejected, drop this item): axe scan of `/login` and, using the existing e2e auth helpers, `/dashboard` and `/patients`; assert no `critical`/`serious` violations, with any pre-existing violation triaged in the report (documented + skipped-with-reason if fixing would exceed this spec's scope) rather than silently allowed.

### Files to inspect

- `app/layout.tsx`, `components/ui/sonner.tsx`
- `tests/e2e/smoke.spec.ts` + `tests/e2e/login.spec.ts` (auth/session helpers to reuse), `playwright.config.ts`

### Files expected to change

| File | Change |
|---|---|
| `components/shared/network-status-toast.tsx` | **new** |
| `app/layout.tsx` | mount one component |
| `tests/e2e/a11y.spec.ts` | **new** |
| `package.json` / `pnpm-lock.yaml` | `@axe-core/playwright` (devDependencies) |
| `messages/en.json`, `messages/ar.json` | 2 keys |

### Systems that must not change

Server actions, fetch behavior, sonner config, existing e2e specs, CI config.

### Implementation requirements

- Toast only — no banners, no blocking UI, no disabling of controls while offline.
- The axe spec must not add violations-fixing changes to application code in this phase; findings become follow-up items in the report.

### Focused tests

- Unit: dispatch `offline`/`online` events on `window` in jsdom → correct toasts fired (spy on sonner).
- The axe spec itself is the test.

### Manual verification

1. Dev server up, devtools → Network → Offline → warning toast appears once (persists); back Online → success toast replaces it. Both locales.
2. `pnpm test:e2e -- a11y` green against the local stack on `PORT=3100`.

### Risks

- `navigator.onLine` is heuristic (can report online behind a captive portal) — accepted; the toast is informational, nothing gates on it.
- Axe may surface pre-existing violations that fail the new spec on day one — triage per the requirement above; do not weaken thresholds silently.

### Completion criteria

Either or both items shipped per the gate, gates green, or the phase is explicitly recorded as dropped.

### Stop condition

If the offline listener needs anything beyond `window` events + sonner, or the axe spec needs app-code changes to pass, stop that item and record it.

### Implementation report

`docs/reviews/ux/P4_IMPLEMENTATION.md`

---

## 8. Items deliberately excluded (do not implement, do not revisit without a new decision)

| Item | Reason |
|---|---|
| Optimistic UI (`useOptimistic`) | The pervasive pending-state pattern is the correct choice for a medical CRM; optimistic writes add risk with no user value here |
| Service worker / offline queue / write replay | Prohibited; over-engineering for a desktop-first clinic tool |
| Global navigation interception for unsaved changes | No stable App Router API; fragile router/history patching is prohibited (§6.3a limitation) |
| Debounced type-ahead patient search | Existing explicit-apply filter is deliberate and works |
| Table row-link semantics rework (`role="link"` → overlay `<Link>`) | Working, keyboard-accessible; change is cosmetic-adjacent |
| Session-expiry pre-warning / token countdown | Over-engineering; the middleware redirect behavior is sound |
| Loading files for `/profile`, `/preferences`, `/onboarding`, auth, marketing | Light pages; no verified gap |
| Theme correctness of the root error boundary under a dark session | Degraded-state screen; accepted |
| Page-visibility cookie 1h staleness | By design (server actions re-check); documentation note only, no code |
| Any new Context/provider/hook beyond §6/§7's two render-null components | Rule §1.4 |

---

## 9. Sprint completion

The sprint is complete when P1–P3 are implemented, reviewed via their reports, and merged, and P4 is either shipped or explicitly recorded as dropped. Total expected footprint: ~10 new small files, ~12 modified files, zero modified systems.
