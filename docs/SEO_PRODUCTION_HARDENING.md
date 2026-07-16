# SEO Production Hardening — Implementation Specification (Final)

Status: **Approved for implementation** — supersedes the original draft after architectural review (2026-07-16).
Branch: `feat/production-seo-hardening` (created in Phase 0; never work directly on `main`).

ClinicFlow is a production multi-tenant clinic-management SaaS. This specification defines one
conservative SEO, browser-branding, metadata, structured-data, and public-surface hardening pass.

The highest priority is **ZERO REGRESSION**. Every phase is designed to be implemented, tested,
reviewed, committed, and rolled back independently. Do not merge phases. Do not reorder phases
except as explicitly allowed.

---

## Architectural review summary (source of truth)

The original draft was audited against the repository and the live production site on 2026-07-16.
Findings that shape this spec:

1. **Already implemented — do not rebuild, verify only:**
   - Canonical www origin: `MARKETING_SITE_URL = "https://www.clinicflow.fit"` in
     `lib/marketing-copy.ts`, consumed by `app/robots.ts`, `app/sitemap.ts`, canonical URLs, and
     tests (commits `5dd4152`, `b4cebb3`).
   - Indexing boundaries: root layout sets `robots: { index: false }`; `/`, `/privacy`, `/terms`
     override with `index: true, follow: true`. Verified live.
   - Robots/sitemap: preview `disallow: /`, correct allow/disallow lists, www sitemap URL, stable
     truthful `lastModified` (`2026-07-13`). Verified live. **No code change in these files unless a
     phase below names them.**
   - Localized metadata mechanism (messages → `generateMetadata`) is fully built.
2. **Live defect (fixed in Phase 5):** a cookie-less `GET /` — every crawler and first-time
   visitor — receives `307 → /?landingLocale=ar` because `middleware.ts` redirects when the
   `cf_marketing_locale` cookie is *absent*, not only when it differs from Arabic. The canonical
   homepage never serves a direct 200 to Googlebot.
3. **Live defect (fixed in Phase 2):** the social image is
   `/marketing/dashboard-ar-desktop.avif`. Social scrapers (WhatsApp, LinkedIn, X, Telegram,
   Facebook) broadly do not decode AVIF — the site has no working social preview today. A dedicated
   1200×630 PNG/JPG is a **required** deliverable.
4. **Working-tree divergence (fixed in Phase 0):** `messages/ar.json` carries an uncommitted
   `legal.noticeTitle` rename that contradicts `tests/unit/components/ws9-legal-and-seo.test.tsx`
   and `messages/en.json`. Decision: **complete the rename in both locales** (see Phase 0).
5. **Title-template mechanics:** the root layout template is `"%s · ClinicFlow"`. Legal pages
   render `سياسة الخصوصية · ClinicFlow` (middle dot) via that template; the homepage title
   empirically renders *without* the suffix. All public-title work must use
   `title: { absolute: ... }` on the three public pages and must assert **resolved** metadata in
   tests, never raw message strings. The app-wide `·` template for authenticated pages stays
   untouched.
6. **Middleware matcher gap:** the matcher excludes `svg|png|jpg|jpeg|gif|webp` but not `avif` or
   `webmanifest` — all marketing screenshots already pass through Supabase session middleware, and
   a new manifest would too. The manifest and the matcher extension ship as **one atomic phase**
   (Phase 3).
7. **Repo conventions:** reports live under `docs/` and `docs/reviews/` (not a top-level
   `reports/`). Review files follow `docs/reviews/<SUBPHASE>_REVIEW.md` with stable finding IDs.

---

## Global non-negotiable safety rules (apply to every phase)

- Minimal diff only. Preserve all existing application behavior.
- Do not modify Supabase migrations, RLS, database functions, tables, RPCs, authentication,
  protected-route authorization, billing, subscriptions, tenant isolation, clinical data, or
  patient workflows.
- Do not implement anything from the AI-agent roadmap; no LLM dependency; no payment provider.
- No service worker, no offline caching, no install prompts, no PWA runtime behavior. A web
  manifest is allowed only as browser metadata (Phase 3).
- Do not redesign the marketing website. Do not change spacing, layout, motion, typography, themes,
  responsive behavior, RTL behavior, dialogs, forms, or visual hierarchy except where an icon asset
  itself is replaced.
- Do not modify the licensed Arabic font or expose/copy font files.
- Do not change the locale-storage architecture. No `/en` or `/ar` URL prefixes. **No hreflang**
  while Arabic and English share the same URLs with cookie-selected locale.
- Preserve `<html lang={locale} dir={localeDirection(locale)}>`.
- No fake ratings, testimonials, customers, prices, review counts, awards, locations, medical
  claims, or aggregateOffer data. Never claim ClinicFlow provides diagnosis, medical advice,
  clinical decision-making, or patient care.
- Public marketing/legal pages stay indexable; authenticated, operator, auth, and API surfaces stay
  non-indexable. Never expose PHI or tenant information in metadata, JSON-LD, logs, static HTML,
  images, or test snapshots.
- No analytics or tracking dependency of any kind in this task (no GA/GTM/Clarity/PostHog/
  Plausible/Vercel Analytics/Speed Insights). No invented environment variables. List analytics as
  a future decision in the final report.
- No obsolete meta tags (`revisit-after`, `rating`, `distribution`, `expires`, `pragma`), no
  keyword-stuffing, no hidden SEO headings, no user-agent cloaking, no Googlebot special-casing.
- Never bypass failures with `eslint-disable`, `@ts-ignore`, skipped/only tests, loosened
  assertions, mock removal, test deletion, or CI changes.
- Do not commit or push unless the user explicitly asks. Each phase ends with a proposed commit,
  not an executed one, unless instructed otherwise.

## Global validation gates (run per phase, plus in full at Phase 7)

```
npm run typecheck
npm run lint
npm test -- tests/unit/components/ws9-legal-and-seo.test.tsx
npm test
npm run build
```

Supporting repo gates where a phase touches their domain: `npm run lint:i18n`, `npm run lint:rtl`,
`npm run i18n:missing`, `npm run i18n:unused`. E2E (`npm run test:e2e`) runs on `PORT=3100`
(port 3000 is occupied by the user's dev server). Use only scripts that exist in `package.json`.

---

# Phase 0 — Repository Stabilization & Baseline

## Objective
Establish a clean, validated baseline: complete the legal disclaimer heading rename in **both**
locales with semantic parity, align the tests, record the baseline, and create the working branch.
The current legal translation mismatch is part of this stabilization — not a separate milestone.
Phase 0 is a stabilization effort, not a hard gate: a closely related, clearly-scoped issue
surfaced by the baseline run (e.g. another assertion or message key pinned to the old heading, a
stale snapshot of the same copy) is resolved **within** this phase rather than halting progress.

## Scope
- Complete the `legal.noticeTitle` rename:
  - Arabic (already changed, uncommitted): `حدود مسؤولية ClinicFlow`
  - English (to change): `ClinicFlow Liability Limitations`
- Update the test assertions that pin the old values.
- Run all baseline gates; record results. Create `feat/production-seo-hardening`.

## Files to inspect
- `messages/ar.json` (uncommitted diff at `legal.noticeTitle`)
- `messages/en.json` (`legal.noticeTitle`, currently "Service limits and clinical responsibility")
- `tests/unit/components/ws9-legal-and-seo.test.tsx` (asserts the old heading twice: the rendered
  Terms heading and the raw catalog values)
- `components/marketing/legal-page.tsx` (renders `noticeTitle`; read-only)

## Files expected to change
- `messages/en.json` — `legal.noticeTitle` only.
- `tests/unit/components/ws9-legal-and-seo.test.tsx` — the rendered-heading assertion and the two
  catalog assertions for `noticeTitle`.
- (`messages/ar.json` change already exists in the working tree; it is adopted, not authored, here.)

## Must not change
- Legal body copy (`noticeBody`, sections) in either locale.
- Any other message key. Any application code. `robots.ts`, `sitemap.ts`, layouts, middleware.

## Validation
- `npm run typecheck && npm run lint`
- `npm test -- tests/unit/components/ws9-legal-and-seo.test.tsx`
- `npm run i18n:missing` (en/ar parity)
- `npm test` and `npm run build` — record any pre-existing failures verbatim; do not misattribute
  them to this task.

## Manual verification
- Render `/terms` locally in both locales; confirm the disclaimer heading reads
  `ClinicFlow Liability Limitations` / `حدود مسؤولية ClinicFlow` and the body is unchanged.

## Risks
- Semantic drift between locales — mitigated by changing only the heading, with the body untouched.
- Other tests or e2e specs may pin the old English heading; grep the whole repo for
  `Service limits and clinical responsibility` and `حدود الخدمة والمسؤولية السريرية` before editing.

## Completion criteria
- All gates green (or pre-existing failures documented and demonstrably unrelated).
- Branch `feat/production-seo-hardening` created from a clean, consistent tree.
- Proposed commit: `fix(legal): align liability-limitations heading across locales`

## Stop condition
If a baseline failure is closely related to the heading rename or the same legal copy (another
pinned assertion, catalog parity, a stale expectation of the old string), fix it within Phase 0 and
document it in the phase notes. Stop and report only for failures that are genuinely unrelated to
this stabilization (e.g. broken business logic, infrastructure, or flaky e2e outside the touched
surfaces) — record them verbatim as the pre-existing baseline and wait for user direction before
starting Phase 1.

---

# Phase 1 — Public Titles & Canonical Metadata

## Objective
Give the three public pages locale-following, pipe-separated browser titles with no duplicated
brand suffix, and centralize `metadataBase` — metadata only, zero runtime behavior change.

## Scope
- New localized title values (sourced from `messages/{en,ar}.json`, not hardcoded locale
  conditionals):
  - Home — EN: `ClinicFlow | Clinic Management Software`
    AR: `كلينيك فلو | نظام إدارة العيادات`
  - Privacy — EN: `Privacy Policy | ClinicFlow` AR: `سياسة الخصوصية | كلينيك فلو`
  - Terms — EN: `Terms of Service | ClinicFlow` AR: `شروط الخدمة | كلينيك فلو`
- Apply them via `title: { absolute: ... }` in each public page's `generateMetadata` so the root
  template cannot append a second brand. **Do not change the root template**
  (`"%s · ClinicFlow"`) — authenticated tab titles keep their current format.
- Move `metadataBase: new URL(MARKETING_SITE_URL)` from `app/page.tsx` to the root layout's
  `generateMetadata` (needed by Phase 2's legal-page OG images; harmless now).
- Keep existing localized descriptions unless a small wording adjustment is required for
  consistency.
- Tests: assert **resolved** metadata (the object returned by each page's `generateMetadata`,
  including the `absolute` mechanics) for localized titles, no `ClinicFlow ... ClinicFlow`
  duplication, canonical www URLs, `index/follow` on the three public pages, and root noindex.
  English/Arabic catalog parity for every new/renamed message key.

## Files to inspect
- `app/layout.tsx`, `app/page.tsx`, `app/privacy/page.tsx`, `app/terms/page.tsx`
- `messages/en.json`, `messages/ar.json` (`marketing.seo`, `legal.privacy.title`,
  `legal.terms.title`)
- `tests/unit/components/ws9-legal-and-seo.test.tsx`
- `tests/e2e/*.spec.ts` — grep for any pinned `<title>` expectations before changing strings.

## Files expected to change
- `app/layout.tsx` (add `metadataBase`; nothing else)
- `app/page.tsx`, `app/privacy/page.tsx`, `app/terms/page.tsx` (title handling only)
- `messages/en.json`, `messages/ar.json` (title strings under existing namespaces)
- `tests/unit/components/ws9-legal-and-seo.test.tsx` (extend; preserve all existing assertions
  except title expectations that legitimately change)

## Must not change
- Root `robots: { index: false }` and the root title **template** for authenticated pages.
- `app/robots.ts`, `app/sitemap.ts`, `middleware.ts`, locale/i18n config, any component markup.
- Existing OG/Twitter fields beyond what the title strings feed.

## Validation
- Phase gates plus `npm run i18n:missing` / `npm run i18n:unused`.

## Manual verification
- `npm run build && npm run start`, inspect view-source on `/`, `/privacy`, `/terms` in both
  locales (via the language switcher): exact titles, single brand occurrence, canonical www URLs,
  correct robots meta. Confirm authenticated pages (e.g. `/dashboard`) still show `%s · ClinicFlow`.

## Risks
- The live homepage/legal pages resolve the template differently (observed in review) — asserting
  resolved metadata, not catalog strings, is mandatory.
- E2E specs may pin old titles.

## Completion criteria
All gates green; titles verified in both locales; no duplicate suffix; app titles unchanged.
Proposed commit: `feat(seo): localized pipe-separated public titles and shared metadataBase`

## Stop condition
If achieving the pipe separator would require changing the root template (and therefore every
authenticated tab title), stop and report instead of proceeding.

---

# Phase 2 — Browser & Social Branding Assets

## Objective
Replace the default favicon with the real ClinicFlow mark, ship the standard icon set, and ship a
**required** dedicated 1200×630 PNG/JPG Open Graph image that social scrapers can actually decode.

## Scope
- Source of truth: `public/brand/clinicflow-mark.png` (417×358 — **non-square; pad to a square
  canvas**, do not stretch). Do not invent or redesign the logo; do not alter the marketing header
  logo or remove existing source assets.
- Generate with the already-installed `sharp` (no new image dependency; no committed temp files):
  - `app/favicon.ico` (replace)
  - `app/icon.png` and `app/apple-icon.png`
  - `public/brand/icon-192.png`, `public/brand/icon-512.png` (consumed by Phase 3's manifest)
  - `app/opengraph-image.png` (1200×630) — or an explicit metadata path if the file convention
    conflicts with localized metadata; choose the least complex reliable option. Content: ClinicFlow
    mark + concise English message ("ClinicFlow — Clinic Management Software for Private Clinics"),
    existing brand colors, fictional/demo UI only, no patient-identifying information, no live
    data, no medical claims.
- Point homepage OG/Twitter images at the new asset (correct `width`/`height`, localized alt).
  Add localized OG/Twitter metadata to `/privacy` and `/terms`, reusing the brand image with each
  page's own canonical URL, title, and description. No separate legal-page images.
- Tests: icon files exist with valid non-zero (and where specified, exact) dimensions; OG image is
  PNG/JPG at 1200×630; homepage and legal metadata reference it; `summary_large_image` retained.

## Files to inspect
- `public/brand/clinicflow-mark.png`, `public/logo.png`, `app/favicon.ico`
- `app/page.tsx`, `app/privacy/page.tsx`, `app/terms/page.tsx`
- Existing marketing asset tests (grep `tests/` for `avif`/asset checks)

## Files expected to change
- New: `app/icon.png`, `app/apple-icon.png`, `app/opengraph-image.png` (or explicit path),
  `public/brand/icon-192.png`, `public/brand/icon-512.png`
- Replaced: `app/favicon.ico`
- Modified: `app/page.tsx`, `app/privacy/page.tsx`, `app/terms/page.tsx` (image metadata only),
  `messages/{en,ar}.json` (image alt keys if needed), ws9 test (extend)

## Must not change
- `components/marketing/marketing-logo.tsx`, any visible marketing UI, `/marketing/*.avif` assets
  (they remain as page content), robots/sitemap/middleware.

## Validation
- Phase gates; the new asset-dimension tests; `npm run build` (Next validates metadata file
  conventions at build time).

## Manual verification
- Local build: request `/favicon.ico`, `/icon.png`, `/apple-icon.png`, the OG image path — all 200
  with correct content types. View-source: icon links and `og:image` (absolute www URL via
  `metadataBase`). Document that browser favicon caches may need a hard refresh / tab reopen /
  time to update.

## Risks
- Non-square source → distorted icons if padded incorrectly.
- `app/opengraph-image.png` file convention overriding localized alt text — verify; fall back to
  explicit `images` metadata paths if it does.

## Completion criteria
All gates green; assets verified locally; social metadata points at a scraper-decodable image.
Proposed commit: `feat(brand): ClinicFlow favicon, icon set, and dedicated social image`

## Stop condition
If the brand mark cannot produce a legible small-size icon without redesign, stop and report.

---

# Phase 3 — Web Manifest + Middleware Static-Asset Matcher (atomic)

## Objective
Add a metadata-only web manifest **and** extend the middleware matcher so manifest and AVIF
requests stop running Supabase session middleware. These ship together or not at all.

## Scope
- New `app/manifest.ts` (`MetadataRoute.Manifest`): name/short_name `ClinicFlow`, description
  aligned with the English product description, `start_url: "/"`, `scope: "/"`,
  `display: "standalone"`, `background_color` from the existing marketing light surface,
  `theme_color` from the established brand, icons = the Phase 2 192/512 PNGs with exact sizes and
  correct MIME types. **No** service worker, offline caching, install prompts, background sync,
  push, or any PWA runtime behavior.
- Extend the matcher exclusion in `middleware.ts` as an **explicit list only** (never a generic
  any-extension pattern): add `avif` and `webmanifest` to the existing
  `svg|png|jpg|jpeg|gif|webp` group; add `ico|xml|txt` only after verifying no route handler or
  page depends on middleware for such paths. Everything else in the matcher stays byte-identical.
- Tests: unit test for the manifest object (values, icon sizes/types); matcher regex test asserting
  exclusions (`/manifest.webmanifest`, `/marketing/dashboard-desktop.avif`) and non-exclusions
  (`/dashboard`, `/api/...`, `/patients`).

## Files to inspect
- `middleware.ts` (matcher only), `lib/supabase/middleware.ts` (read-only, to confirm no
  dependency on excluded paths), Phase 2 icon outputs.

## Files expected to change
- New: `app/manifest.ts`, one focused new test file (or ws9 extension).
- Modified: `middleware.ts` — the `config.matcher` string **only**.

## Must not change
- The middleware function body: landing-locale logic, Supabase session refresh, cookie
  persistence, auth/onboarding/subscription gating order. (Phase 5 owns the function body.)
- Any application route behavior.

## Validation
- Phase gates; new matcher/manifest tests; full `npm test` (middleware is load-bearing).

## Manual verification
- Local build: `/manifest.webmanifest` returns 200 with correct JSON and icon URLs; a protected
  route still redirects unauthenticated users to login (proves the matcher still covers app
  routes); marketing page loads normally in both locales.

## Risks
- An over-broad matcher regex silently removing auth middleware from an application route — the
  highest risk in this phase; mitigated by the explicit list and the non-exclusion tests.

## Completion criteria
All gates green; manifest served; matcher exclusions proven by tests; auth behavior demonstrably
intact. Proposed commit: `feat(seo): web manifest and static-asset middleware exclusions`

## Stop condition
If any route handler or page is found to rely on middleware for `ico|xml|txt` paths, ship only
`avif` + `webmanifest` and document the rest. If matcher behavior cannot be proven by tests, do
not edit `middleware.ts` at all — ship the manifest alone only if its fetch cost is acceptable,
otherwise defer the whole phase and report.

---

# Phase 4 — Structured Data (JSON-LD)

## Objective
Add truthful, server-rendered JSON-LD to the public marketing homepage only.

## Scope
- Small typed helper module (e.g. `lib/seo/structured-data.ts`) building one `@graph` with:
  - **WebSite**: name `ClinicFlow`; alternateName `Clinic Flow`, `كلينيك فلو`; url
    `https://www.clinicflow.fit`. No `SearchAction` (no public site search exists).
  - **Organization**: name, url, logo (absolute www URL of a Phase 2 icon). No address, phone,
    founders, founding date, social profiles, or contactPoint — none are verified public facts.
  - **SoftwareApplication**: name, `applicationCategory: BusinessApplication`,
    `applicationSubCategory: Clinic Management Software`, `operatingSystem: Web`, url, description
    from the active marketing locale. **No** aggregateRating, review, offers, price, currency,
    trial claims, plan names, availability, or install info.
  - **FAQPage**: generated from the **same** localized FAQ data the page renders
    (`marketing.faq.items` via the existing copy tree, 9 items) — never a second maintained list.
    Locale follows the request, matching the rendered DOM.
- One `<script type="application/ld+json">` in `app/page.tsx`, serialized with every `<` escaped to
  the `\u003c` sequence before `dangerouslySetInnerHTML`. (CSP already permits inline scripts.)
- Tests: schema.org context; canonical www URLs; graph contains exactly the four types; FAQ parity
  with the rendered translation data in both locales; **negative** assertions — no aggregateRating,
  no offers, no private routes, no patient/tenant data. Do not claim guaranteed rich results
  anywhere.

## Files to inspect
- `components/marketing/marketing-page.tsx` + `faq-accordion.tsx` (how FAQ copy is sourced),
  `lib/marketing-copy.ts`, `app/page.tsx`, `messages/{en,ar}.json` (`marketing.faq`).

## Files expected to change
- New: `lib/seo/structured-data.ts`, one focused test file (or ws9 extension).
- Modified: `app/page.tsx` (script tag + helper call only).

## Must not change
- Rendered marketing markup, FAQ component, copy tree shape, any metadata from Phases 1–2.

## Validation
- Phase gates; new JSON-LD tests in both locales.

## Manual verification
- Local build view-source: one JSON-LD script, parseable, escaped, locale-consistent with the page.
  Optionally validate the copied JSON with the Schema Markup Validator (manual, not automated).

## Risks
- Drift between rendered FAQ and schema — eliminated by sourcing both from the same translator
  call. Serialization XSS — eliminated by the `<` escaping requirement.

## Completion criteria
All gates green; JSON-LD present, truthful, localized, tested.
Proposed commit: `feat(seo): truthful JSON-LD graph on the marketing homepage`

## Stop condition
If any schema field cannot be filled with a verified, public, stable fact, omit the field (or the
entire schema) rather than approximating.

---

# Phase 5 — Homepage Crawlability Fix (isolated)

## Objective
Make a cookie-less `GET /` return `200` (Arabic) instead of `307 → /?landingLocale=ar`, while
preserving every documented landing-locale behavior. This is the highest-value SEO change in the
spec and lives in its own phase and commit.

## Scope
- **Test-first.** Add a failing middleware test proving: cookie-less document GET of `/` currently
  redirects. Then apply the minimal fix in `middleware.ts`: perform the one-hop
  `landingLocale` redirect **only when the `cf_marketing_locale` cookie exists and differs from
  `ANONYMOUS_DEFAULT_LOCALE`**; when the cookie is absent, fall through to the existing
  `request.cookies.set(...)` line (Arabic is already the anonymous default via `resolveLocale`).
- Behaviors that must be proven unchanged by tests:
  - English cookie on a full landing document load → still one-hop redirect + cookie reset to `ar`.
  - `?landingLocale=<locale>` still sets the cookie and renders.
  - RSC/soft navigations (rsc header / `next-router-state-tree`) still bypass the reset.
  - Session refresh (`updateSession`) still runs on every matched request.
  - Authenticated locale preference is untouched (it never reads the marketing cookie).

## Files to inspect
- `middleware.ts` (function body), `lib/i18n/config.ts`, `lib/preferences/server.ts`,
  `lib/i18n/resolve.ts`, any existing middleware/landing-locale tests (grep `landingLocale` across
  `tests/`), `docs/reviews/P2A_REVIEW.md` (documented landing-reset semantics).

## Files expected to change
- `middleware.ts` — the single redirect condition only.
- One focused middleware test file (new or extended).

## Must not change
- The matcher (owned by Phase 3). Supabase session refresh. Cookie name, path, maxAge, sameSite.
  Gate ordering. Anything in `updateSession`. No Googlebot/user-agent special-casing.

## Validation
- Phase gates; the new middleware tests; full `npm test`; Playwright smoke suite on `PORT=3100`
  (login flow exercises the English-cookie reset path).

## Manual verification
- Local build: `curl -s -o /dev/null -w "%{http_code} %{redirect_url}" http://localhost:3000/`
  with no cookie → `200`, Arabic `lang="ar"`; with `cf_marketing_locale=en` → one `307` to
  `/?landingLocale=ar` then `200` Arabic; language switcher round-trip in a browser; login →
  logout → landing still resets to Arabic.

## Risks
- This is the P2A-documented landing-reset logic — the riskiest touch in the whole spec. The
  condition change is one boolean refinement; anything larger is out of scope.

## Completion criteria
Cookie-less GET of `/` serves 200 Arabic; all documented behaviors proven unchanged; all gates
green. Proposed commit: `fix(seo): serve 200 to cookie-less visitors on the canonical homepage`

## Stop condition
If preserving every documented behavior is not possible with the single-condition change, revert
the edit, keep the failing test as documentation (skipped is not allowed — remove it instead), and
record the finding + recommended follow-up in the Phase 7 report.

---

# Phase 6 — Localized Root 404 (OPTIONAL)

## Objective
Add a conservative localized public `app/not-found.tsx` — **only if it introduces no routing,
localization, or architectural risk. Otherwise explicitly skip it** and record the skip in the
Phase 7 report.

## Scope
- Reuse existing marketing visual language and components as-is (`MarketingLogo`, existing tokens).
  Localized Arabic/English text via next-intl with correct RTL/LTR; link back to `/`; optional
  `/login` link; real HTTP 404; no stack traces, Supabase details, tenant or patient context.
- Verify Next.js emits noindex for not-found (it does by default) rather than overriding.
- New message keys in both catalogs with parity.

## Files to inspect
- `app/(protected)/not-found.tsx`, `app/(operator)/not-found.tsx` (must remain authoritative for
  their groups), `app/layout.tsx`, marketing components.

## Files expected to change
- New: `app/not-found.tsx`; `messages/{en,ar}.json` (small `notFound` namespace); small test.

## Must not change
- Route-group not-found files, error boundaries, root layout, middleware. No `global-error` file.

## Validation
- Phase gates; test that a nonexistent public path returns 404 with localized copy and noindex.

## Manual verification
- Local build: random nonexistent path → styled 404, both locales, correct dir, status 404,
  protected-group 404s unchanged.

## Risks
- Root not-found renders inside the root layout with next-intl — if any hydration warning, locale
  inconsistency, or route-group interference appears, invoke the stop condition.

## Completion criteria
Either: 404 shipped with all gates green — or an explicit documented skip. Both are valid
completions. Proposed commit (if shipped): `feat(marketing): localized public 404`

## Stop condition
Any routing, localization, or rendering anomaly → remove the file entirely and record the skip.

---

# Phase 7 — Full Validation, Manual Verification & Report

## Objective
Prove the whole pass regression-free and document it per repository conventions.

## Scope
- Full gates: typecheck, lint, `lint:i18n`, `lint:rtl`, `i18n:missing`, `i18n:unused`, `npm test`,
  `npm run test:integration` if the repo's convention requires it, `npm run build`, Playwright on
  `PORT=3100`. No task is complete with a failing gate.
- Manual verification against the local production build, in **both locales** via the language
  switcher: `/`, `/privacy`, `/terms`, `/robots.txt`, `/sitemap.xml`, `/manifest.webmanifest`,
  a random nonexistent path, all icon paths, the OG image path. Inspect rendered source for
  canonical, localized title, description, robots, OG, Twitter, manifest link, icon links,
  JSON-LD, `html lang`, `html dir`. Confirm: no private data serialized, no protected API called
  for metadata, no auth loop, no landing redirect loop, no visual regression, no hydration
  warning, no console error.
- Report: `docs/SEO_PRODUCTION_HARDENING_IMPLEMENTATION.md` (repo uses `docs/`, not `reports/`)
  covering: scope; files changed per phase; decisions; what was intentionally not changed; title
  rules; canonical-domain rule; indexing boundaries; structured data included and intentionally
  omitted; favicon/icon source; manifest note; locale/hreflang decision; middleware decisions
  (matcher + crawlability fix, or their documented deferrals); Phase 6 outcome; validation results
  with counts; manual checks; analytics deferred as a future decision; remaining recommendations;
  the post-deploy checklist below. Do not rewrite historical reports; update another report only
  if this work makes a current-state claim in it factually wrong.

## Post-deploy manual checklist (include verbatim in the report)
1. Confirm the production deployment is Ready.
2. Open https://www.clinicflow.fit/ — confirm the ClinicFlow favicon (caches may lag: hard
   refresh / reopen tab / wait).
3. Confirm English title `ClinicFlow | Clinic Management Software`; switch to Arabic and confirm
   `كلينيك فلو | نظام إدارة العيادات`.
4. Confirm a cookie-less request to `/` returns 200 (e.g. `curl -I` from a clean client).
5. Confirm `/robots.txt`, `/sitemap.xml`, `/manifest.webmanifest` return 200.
6. Confirm the social image URL returns 200; test a share preview in one messenger.
7. Google Rich Results Test / Schema Markup Validator on the homepage.
8. Search Console: inspect `https://www.clinicflow.fit/`, run the live URL test, request indexing
   only after verification, recheck the sitemap after reprocessing. (Search Console is manual,
   post-deploy — never from code.)

## Completion criteria / final response
Report: branch name; per-phase summary; exact files added/modified; tests added/updated; validation
results with counts; manual checks performed; deferred recommendations; risks; `git status`;
proposed commit message per phase (overall: `feat(seo): harden production metadata and brand
surfaces`). Do not commit or push unless the user explicitly asks. Do not claim completion with any
gate failing.

## Stop condition
Any red gate that cannot be traced to a pre-existing, documented baseline failure.

---

## Explicitly removed from the original draft (already implemented or rejected)

- Canonical-www migration (§2), indexing-boundary implementation (§5), robots/sitemap
  implementation (§10) — all live and correct; retained only as test assertions and manual checks.
- hreflang / localized routes / locale-architecture changes — rejected; architecture stands.
- "Audit whether the AVIF social image is suitable" — resolved: it is not; the PNG/JPG OG image is
  required (Phase 2).
- Conditional hedging on the middleware matcher — resolved: the `avif`/`webmanifest` gap is real
  (Phase 3).
- Sitemap `lastModified` rework — the current stable, truthful date is already the recommended
  pattern; touch it only if legal-page dates change truthfully.
- Robots `host` field — nonstandard but harmless; leave untouched.
- The `reports/` paths and generic repository-audit boilerplate — corrected to this repo's `docs/`
  conventions.
- Analytics of any kind — deferred to a future decision (report note only).
