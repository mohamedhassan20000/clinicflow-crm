# Pre-P2 WS9 Review — Marketing-Site Redesign

**Status:** IMPLEMENTED — awaiting comprehensive review
**Workstream:** WS9 (`docs/PRE_P2_POLISH.md` §7-WS9)
**Date:** 2026-07-13
**Implementer:** Codex

---

## 1. Current-state audit and scope

`docs/PRE_P2_POLISH.md`, `docs/AI_AGENT_PLAN.md`, the P1.5C review/performance
gate, and every PRE_P2 review from WS0 through WS8 were read before implementation.
The existing dirty worktree contained the preserved, uncommitted WS0–WS8 work. No prior
workstream was reset, restored, staged, committed, rewritten, discarded, or functionally
expanded.

WS9 is limited to the public marketing/legal surface, its copy and static product imagery,
the local fictional-demo seed/capture pipeline, the P15C metadata/theme/performance
carry-overs assigned to WS9, focused tests, and this handoff. It introduces no P2 runtime,
`next-intl`, Arabic/RTL behavior, schema, migration, RLS, middleware, role, billing,
canonical-money, or authenticated product-flow change. The existing early-access form,
server action, exact-root public-flow exemption, rate limiting, normalization, dedupe, and
signup semantics remain unchanged.

## 2. Marketing implementation completed

The public `/` page is now a server-rendered healthcare-SaaS product narrative with the
real ClinicFlow mark and a deliberately composed sea-glass/Atlantic visual system. The
shell remains a Server Component; client JavaScript is limited to the existing dynamically
loaded early-access dialog and the accessible mobile `Sheet` navigation.

The page ships the complete WS9 information architecture:

- Sticky branded header with Product, Features, Security, Pricing, FAQ, Log in, and early-
  access destinations; the mobile menu has an accessible name, focus trap, keyboard open,
  and Escape close.
- One semantic h1, a focused value proposition, existing open/invite-only CTA behavior,
  honest assurances, and a prioritized real dashboard screenshot.
- Live limited-cohort proof using only the three approved
  `get_public_registration_status()` values and an ARIA progressbar.
- Four connected workflow chapters—Schedule, Front desk, Patient record, and Reports—with
  real seeded product screenshots, descriptive alt text, and responsive art direction.
- Six capability summaries, a substantive tenant/security section, and explicit language
  that ClinicFlow does not claim formal certification or a named compliance regime.
- Three clearly provisional pricing tiers with no fabricated amounts or commercial terms.
- The existing real early-access request form, eight FAQ entries, and a complete branded
  footer linking Privacy Policy and Terms of Service.

All visible marketing and legal copy is centralized in `lib/marketing-copy.ts`. The copy
is English-only plain data: there is no locale routing or i18n runtime. No content, assets,
layout, branding, or wording was copied from the quality-reference site.

## 3. Real screenshot pipeline and no-PHI boundary

`scripts/seed-marketing-demo.ts` creates a deterministic local-only fictional clinic,
staff, departments, services, patients, appointments, package/deposit/follow-up/medical-
note context, and reporting activity. The namespace uses fixed `92000000-…` record IDs,
`.example.invalid` email addresses, synthetic identifiers, and visibly fictional data.
The script refuses non-local Supabase hostnames. No production data, copied patient data,
or PHI is read.

`scripts/capture-marketing-screenshots.ts`:

- refuses a non-local application URL and calls the seed function as its sole data source;
- passes the local Supabase environment at both Next.js build time and runtime;
- signs into the fictional admin account and captures Dashboard, Schedule, Patients,
  Patient record, and Revenue report from the real production-rendered product;
- captures each view at exactly **1440×960** and **390×844**, in a clean light session
  with animations, toasts, carets, and development portals suppressed;
- converts the temporary PNGs to AVIF and enforces a hard 300,000-byte per-file limit;
- removes temporary raw captures and leaves ten assets under `public/marketing/`.

The generated AVIF files are 8–36 KB each. `ProductScreenshot` uses Next.js
`getImageProps()` with a `<picture>` source so desktop/mobile captures receive responsive
optimization, explicit dimensions, and art-directed delivery. The asset contract test
verifies all ten names, AV1/HEIF encoding, exact dimensions, and the byte budget.

### Screenshot refresh procedure

1. Start the fully migrated local Supabase stack and ensure `.env.local` contains the
   existing `LOCAL_SUPABASE_URL`, `LOCAL_SUPABASE_PUBLISHABLE_KEY`, and
   `LOCAL_SUPABASE_SECRET_KEY` values.
2. Run `pnpm marketing:capture` from the repository root. No separate seed command is
   required: capture resets/upserts the fixed fictional namespace first.
3. The command builds and starts the production application on local port 3105, captures
   both standard viewports, validates the asset budget, then stops its server.
4. Run `pnpm exec vitest run tests/unit/components/ws9-marketing-assets.test.ts` and the
   production marketing e2e/Lighthouse gates below before accepting refreshed assets.

`pnpm marketing:seed` is also available for inspecting the demo interactively. Repeated
seed/capture runs completed successfully during WS9, proving the checked-in process is
re-runnable.

## 4. Legal, metadata, and rendering decisions

- `/privacy` and `/terms` are professional placeholder documents with substantive topic
  structure, footer/home navigation, a prominent pending-legal-review notice, and no
  invented retention, compliance, contractual, or certification claims.
- `/` now declares the production `metadataBase`, canonical URL, OpenGraph/Twitter cards
  backed by the real dashboard asset, and index/follow behavior.
- `app/robots.ts` blocks preview indexing, allows the public marketing/legal surface in
  production, and disallows authenticated/API paths. `app/sitemap.ts` lists `/`,
  `/privacy`, and `/terms`.
- P15C-P2 and P15C-P3 are marked closed in `docs/reviews/P1.5C_REVIEW.md`: metadata is
  complete and the marketing surface now has a full dark palette selected by the existing
  theme cookie.
- P15C-P4 was evaluated. `/` deliberately remains dynamic so the approved live cohort
  status is neither stale nor moved into a new client fetch. The three-run production gate
  shows this choice remains within the mandatory performance and script budgets.

## 5. Accessibility, responsive behavior, theme, and motion

- Semantic header/main/footer landmarks, one h1, ordered headings, labelled sections,
  descriptive product alt text, an ARIA progressbar, visible focus treatment, and Radix
  dialog/sheet focus management are present.
- Lighthouse accessibility is **100** in all three final mobile runs. Scroll-linked reveals
  no longer animate opacity, preventing composited-color contrast regressions.
- Browser coverage verifies no body overflow at exactly 360, 768, and 1440 px; the seeded
  product captures were additionally inspected at 1440×960 and 390×844.
- A dark-theme cookie produces the root `dark` class and `color-scheme: dark` marketing
  palette while keeping the hero visible and dialog/sheet tokens coherent.
- `prefers-reduced-motion: reduce` disables hero, float, scroll-reveal, hover movement, and
  transitions. Small-screen hero entrance animation is also disabled for faster mobile
  paint.
- The physical-direction utility grep is clean. New UI uses logical inline/block
  properties only. No `next-intl`, `rtl`, or locale-routing reference exists in WS9 files.

## 6. Performance gate

`docs/P15C_PERFORMANCE_GATE.md` now carries the final Lighthouse 13.4.0 mobile results
from the production build at `http://127.0.0.1:3105/`:

| Run | Performance | Accessibility | Simulated LCP | Initial script transfer | Result |
|---|---:|---:|---:|---:|---|
| 1 | **92** | **100** | 3.30 s | 207 KB | PASS |
| 2 | **92** | **100** | 3.29 s | 207 KB | PASS |
| 3 | **92** | **100** | 3.30 s | 207 KB | PASS |

The mandatory three-run ≥90 Performance / ≥90 Accessibility contract passes and the
initial script transfer stays below the approximately 260 KB baseline. The practical
simulated LCP ≤2.5 s target remains aspirational; it is recorded rather than waived or
hidden. Lighthouse identifies the server-rendered h1 as LCP, with approximately 55 ms
TTFB plus 61 ms element-render delay in run 1, zero layout shift, and no blocking-script
regression.

## 7. Validation commands and exact results

| Command | Exact result |
|---|---|
| `pnpm marketing:capture` | **PASS** — repeatable local seed, Next.js 16.2.6 production build, and 10 real fictional-demo AVIF captures; final build compiled in 6.2s, TypeScript 8.1s, 52/52 static pages generated |
| `pnpm exec vitest run tests/unit/components/ws9-marketing-assets.test.ts` | **PASS** — 1 file, 10 asset-contract tests; 751ms |
| `pnpm typecheck` | **PASS** — exit 0; no diagnostics |
| `pnpm lint` | **PASS WITH WARNINGS** — exit 0, 0 errors, 4 pre-existing warnings (`dashboard/page.tsx`, `record-dialog.tsx`, `patient-form.tsx`, `department-form.tsx`) |
| `pnpm test` | **PASS** — 93 files, 501 tests; 18.36s |
| `node --env-file=.env.local node_modules/vitest/vitest.mjs run tests/unit/integration/p1c-early-access-signup.test.ts --no-file-parallelism` | **PASS** — 1 file, 9 tests; 1.31s |
| `PLAYWRIGHT_BASE_URL=http://127.0.0.1:3105 node --env-file=.env.local node_modules/@playwright/test/cli.js test tests/e2e/login.spec.ts --workers=1` | **PASS** — production Chromium 7/7; 2.7s (root, 360/768/1440 containment, reduced motion, dark theme, legal pages, mobile keyboard navigation, login) |
| Full serial production Playwright: `PORT=3106 node --env-file=.env.local node_modules/@playwright/test/cli.js test --workers=1` | **18/19 PASS** — all WS9 and real P1C early-access flows passed; one out-of-scope older settlement assertion failed because `getByText("Settlement Smoke Patient")` now strictly matches both the WS6 breadcrumb and h1 |
| Lighthouse 13.4.0 mobile production run ×3 | **PASS** — 92/100, 92/100, 92/100; 207 KB initial script each; recorded in the performance gate |
| Manual responsive/product visual QA | **PASS** — landing and all lazy-loaded product images inspected at desktop/mobile standards; no broken crop, missing asset, or overflow found |
| Physical-direction and `next-intl`/RTL grep over WS9 | **PASS** — no physical-direction utility or P2 runtime introduced |
| Diff check over `middleware.ts`, `supabase/migrations`, and `types/database.ts` | **PASS** — no changed path |
| `git diff --check` | **PASS** — no whitespace errors |

The full-browser failure is not caused by WS9 and is deterministic assertion ambiguity in
`tests/e2e/smoke.spec.ts:844` after the previously implemented WS6 breadcrumb. Updating
that prior-workstream smoke test would violate the instruction not to modify previous
workstreams except where WS9 requires it, so it is intentionally reported and left for
comprehensive integrated review. The WS9-focused production suite and both real early-
access tests in the full run are green.

## 8. Acceptance criteria checklist

- [x] Real ClinicFlow logo is consistent with login/auth branding
- [x] All WS9 header, hero, proof, product, feature, security, pricing, early-access, FAQ, and footer sections ship
- [x] Product previews are real production-rendered screenshots from a repeatable fictional local demo with no PHI
- [x] Ten responsive AVIF assets meet exact viewport, encoding, dimension, alt-text, and size contracts
- [x] Screenshot refresh process is documented and re-runnable through package scripts
- [x] Privacy Policy and Terms of Service placeholders are live, footer-linked, and explicitly pending legal review
- [x] No fabricated customer proof, price, legal commitment, certification, or compliance claim appears
- [x] Existing early-access dialog/action and open-registration behavior remain functionally identical
- [x] English-only copy is centralized; no P2 i18n/Arabic/RTL behavior is introduced
- [x] One h1, semantic structure, focus management, contrast, reduced motion, and descriptive image text are verified
- [x] Light/dark sessions and 360/768/1440 responsive containment are verified
- [x] Three-run production Lighthouse gate passes at 92 Performance / 100 Accessibility
- [x] Initial JavaScript remains below baseline and screenshots stay well below asset budget
- [x] P15C-P2/P3 are closed; P15C-P4 is evaluated and documented
- [x] No schema, migration, RLS, middleware, security-boundary, or canonical-data change is introduced
- [x] Focused unit, integration, production build, browser, direction, and diff gates pass
- [ ] Full integrated Playwright is 100% green — 18/19; the sole failure is the out-of-scope WS6 breadcrumb/settlement assertion ambiguity documented in §7

## 9. Files changed

WS9 product code:

- `app/page.tsx`
- `app/globals.css` (marketing-only variables, motion, and interaction rules)
- `app/privacy/page.tsx`
- `app/terms/page.tsx`
- `app/robots.ts`
- `app/sitemap.ts`
- `components/marketing/marketing-page.tsx`
- `components/marketing/early-access-button.tsx`
- `components/marketing/legal-page.tsx`
- `components/marketing/marketing-logo.tsx`
- `components/marketing/mobile-marketing-menu.tsx`
- `components/marketing/product-screenshot.tsx`
- `lib/marketing-copy.ts`

WS9 asset pipeline and generated assets:

- `scripts/seed-marketing-demo.ts`
- `scripts/capture-marketing-screenshots.ts`
- `public/marketing/*.avif` (10 new files)
- `package.json`
- `pnpm-lock.yaml`

WS9 tests/documentation:

- `tests/e2e/login.spec.ts`
- `tests/unit/components/p15c-marketing-page.test.tsx`
- `tests/unit/components/p15c-reduced-motion.test.ts`
- `tests/unit/components/ws9-legal-and-seo.test.tsx`
- `tests/unit/components/ws9-marketing-assets.test.ts`
- `docs/P15C_PERFORMANCE_GATE.md`
- `docs/reviews/P1.5C_REVIEW.md` (WS9 closure/evaluation addendum only)
- `docs/reviews/PRE_P2_WS9_REVIEW.md` (this file)

## 10. Known limitations or unresolved required work

The simulated LCP target and integrated settlement assertion are recorded in §§6–8. Both
mandatory Lighthouse thresholds, accessibility 100, script budget, and every WS9-specific
functional gate pass. No additional WS9 implementation work is known to remain. This is
an implementation and validation record only; it does not constitute independent
comprehensive approval or approval to merge.

## 11. Git status

- Current branch remains `main` at base `cf240b3`.
- The worktree remains dirty by design with preserved WS0–WS8 changes plus the WS9 paths
  listed in §9.
- The staging area remains empty. No branch, commit, push, merge, stage, reset, restore,
  git clean, or stash operation was used.

Stop after WS9. No P2 implementation was started.
