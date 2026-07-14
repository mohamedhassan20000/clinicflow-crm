# Post-Pre-P2 MP2 Review — Marketing Typography & Motion

**Status:** IMPLEMENTED — awaiting comprehensive review
**Workstream:** MP2 (`docs/POST_PRE_P2_MANUAL_POLISH.md` §9-MP2)
**Review cycle:** 1
**Review date:** 2026-07-14
**Final verdict:** **IMPLEMENTED — awaiting comprehensive review**

This is the authoritative MP2 implementation-review record. Later reviews must preserve Review
Cycle 1, retain stable finding IDs, and append history rather than replace it.

## Review Cycle 1

### 1. Implementation scope

Implemented MP2 only:

- replaced DM Sans + Instrument Serif with IBM Plex Sans + IBM Plex Serif while retaining Geist
  Mono;
- kept the existing `next/font/google` build-time self-hosting mechanism and shared CSS-variable
  contract;
- retuned the marketing hero and section display scale for the sturdier serif metrics;
- staged the hero eyebrow, title, body, actions, and assurances with visible transform-only entry;
- deepened section reveals with translate + scale, added section-label rule drawing, added a subtle
  view-timeline product-frame parallax, delayed the existing gentle float until after measured LCP,
  and unified card/CTA hover timing;
- preserved the marketing copy, information architecture, optimized priority hero image, theme
  scoping, early-access behavior, and all accessibility semantics;
- captured and measured the required recommended/alternate font comparison;
- re-cleared and re-recorded the three-run marketing performance gate.

No MP3 logo work, MP4 auth-logo navigation, MP5 phone layout, MP6/MP7 shell work, P2 i18n/RTL,
Arabic copy/font work, migration, schema, RLS, middleware, billing, authentication, or data-path
change is included.

### 2. Exact files changed

Product code:

- `app/layout.tsx`
- `app/globals.css`
- `components/marketing/marketing-page.tsx`

Tests/documentation:

- `tests/unit/components/mp2-marketing-typography-motion.test.ts` (new)
- `docs/P15C_PERFORMANCE_GATE.md`
- `docs/reviews/POST_PRE_P2_MP2_REVIEW.md` (new)
- `docs/reviews/assets/post-pre-p2-mp2/source-serif-{360,768,1440}.png` (new)
- `docs/reviews/assets/post-pre-p2-mp2/plex-serif-{360,768,1440}.png` (new)

Explicitly unchanged by MP2:

- `lib/marketing-copy.ts` — no copy adjustment was needed;
- every marketing logo component — MP3 remains unstarted;
- every auth route/link — MP4 remains unstarted;
- `supabase/`, `types/database.ts`, RLS, middleware, and `actions/theme.ts`;
- all MP0/MP1 implementation and review records.

### 3. Recorded font comparison and decision

Both candidates used the same final MP2 scale and motion code and were rendered from production
builds at 360, 768, and 1440 px. The captures cover the hero, workflow narrative, feature grid,
security band, pricing, early-access band, and FAQ.

| Viewport | Source Serif 4 candidate | IBM Plex Serif alternate |
|---|---|---|
| 360 px | [source-serif-360.png](assets/post-pre-p2-mp2/source-serif-360.png) | [plex-serif-360.png](assets/post-pre-p2-mp2/plex-serif-360.png) |
| 768 px | [source-serif-768.png](assets/post-pre-p2-mp2/source-serif-768.png) | [plex-serif-768.png](assets/post-pre-p2-mp2/plex-serif-768.png) |
| 1440 px | [source-serif-1440.png](assets/post-pre-p2-mp2/source-serif-1440.png) | [plex-serif-1440.png](assets/post-pre-p2-mp2/plex-serif-1440.png) |

| Stack/configuration | Font transfer on `/` | Lighthouse Performance (3 runs) | Accessibility | Decision |
|---|---:|---:|---:|---|
| Pre-MP2: DM Sans + Instrument Serif normal/italic + Geist Mono | 94,292 B | historical gate 91 / 90 / 91 | 100 / 100 / 100 | baseline |
| IBM Plex Sans variable + Source Serif 4 400/600 + Geist Mono | 116,882 B | 89 / 88 / 90 | 100 / 100 / 100 | rejected — failed gate |
| IBM Plex Sans variable + IBM Plex Serif 400/600 + Geist Mono | 97,324 B | 89 / 89 / 91 | 100 / 100 / 100 | visually strong; unused 600 preload removed |
| **Selected: IBM Plex Sans variable + IBM Plex Serif 400 + Geist Mono** | **80,874 B** | **92 / 92 / 92** | **100 / 100 / 100** | **selected** |

The Source Serif candidate supplied slightly warmer editorial contrast, while IBM Plex Serif was
equally formal at all three widths and created one coherent institutional superfamily with the new
body face. The performance result was decisive: the selected stack is 13,418 bytes lighter than the
pre-MP2 page and 36,008 bytes lighter than the Source Serif candidate. IBM Plex Serif weight 600
was not used by any `font-display` element, so retaining its preload would have violated the
only-load-used-weights rule.

The loading strategy remains `next/font/google` with `subsets: ["latin"]` and `display: "swap"`.
Lighthouse network records show every font URL under `/_next/static/media/*.woff2`; there is no
runtime Google Fonts request, external DNS dependency, new CSP origin, or manually linked font.

### 4. Typography and motion implementation audit

#### 4.1 Typography

- `--font-sans` and `--font-heading` resolve through `--font-plex-sans` with an explicit Segoe UI /
  system / Helvetica / Arial fallback stack.
- `--font-display` resolves through `--font-plex-serif` with Georgia and Times New Roman fallbacks.
- Geist Mono remains the utility/numeral face and gains an explicit system-monospace fallback.
- The hero changed from `clamp(3.25rem,7.2vw,7.4rem)`, `.88` leading, and `-.06em` tracking to
  `clamp(3.05rem,6.2vw,6.65rem)`, `.93` leading, and `-.042em` tracking.
- Marketing display sections use a consistent responsive 2.75–4.75 rem range, approximately 1.0
  leading, and restrained −.03em to −.032em tracking.
- No copy or heading order changed; the page still has one `h1` and the same section IDs/IA.

#### 4.2 Motion

- Hero stages run at 60/130/205/280/355 ms with one shared spring curve. The elements remain
  visible and animate only transform, so the headline is not hidden from LCP or accessibility.
- The priority product frame has no entrance animation. Its single allowed ambient float begins at
  4 seconds—after the measured 3.37–3.39 s LCP—and remains disabled below 768 px.
- View-timeline section reveals animate `translateY` + `scale`, never layout properties.
- Section-label rules draw via pseudo-element scale; workflow frames receive a 10 px view-timeline
  parallax on their inner picture, leaving the frame hover transform independent.
- Cards and CTAs share one easing curve; hover uses transform plus the already-approved shadow
  refinement. No width, height, inset, or scroll-position animation exists and no library/JS was
  added.
- `prefers-reduced-motion: reduce` disables hero stages, float, section reveals, label draw,
  parallax, card/frame/CTA transitions, and hover/active transforms.

### 5. Accessibility, responsive, and performance audit

- Production responsive checks passed at 360, 768, 1024, and 1440 px with no horizontal body
  overflow. The 360×800 capture keeps the primary CTA in the first viewport.
- Heading order, one-`h1` contract, link/button semantics, focus styles, and image priority/alt text
  are unchanged.
- An initial scroll-reveal implementation used opacity and caused Lighthouse contrast to fall from
  100 to 96 for off-screen content. Opacity was removed from section reveals; the final three runs
  are 100 Accessibility.
- Actual font transfer decreased 94,292 → 80,874 bytes (−13,418 bytes), comfortably inside the
  ≤+30 KB budget.
- CSS source gzip changed from the MP1-recorded 5,053 bytes to 5,532 bytes (+479 bytes), below the
  +2 KB pure-CSS budget.
- Initial script transfer is 198,701 bytes in all three runs (the preceding final Pre-P2 record was
  198,703 bytes); MP2 added no JavaScript or animation dependency.
- Final Lighthouse Performance is 92 / 92 / 92; Accessibility, Best Practices, and SEO are
  100 / 100 / 100 in every run. LCP is 3.39 / 3.37 / 3.37 s and remains honestly above the
  aspirational 2.5 s target. TBT is 12.5 / 3.5 / 6.5 ms.

### 6. Validation commands and exact results

| Command | Result |
|---|---|
| `pnpm exec vitest run tests/unit/components/mp2-marketing-typography-motion.test.ts tests/unit/components/p15c-marketing-page.test.tsx tests/unit/components/p15c-reduced-motion.test.ts tests/unit/components/mp1-theme-scoping.test.tsx` | **PASS** — 4 files, 13 tests |
| `pnpm test` | **PASS** — 99 files, 516 tests |
| `pnpm typecheck` | **PASS** — exit 0; no diagnostics |
| `pnpm lint` | **PASS WITH WARNINGS** — 0 errors; 4 pre-existing warnings |
| `PORT=3121 node --env-file=.env.local node_modules/@playwright/test/cli.js test tests/e2e/login.spec.ts --project=chromium --workers=1` | **PASS** — production build; Chromium 8/8 in 20.0s, including 360/768/1440 containment and reduced motion |
| Three final Lighthouse 13.4.0 mobile runs against `http://127.0.0.1:3120/` | **PASS** — Performance 92/92/92; Accessibility/Best Practices/SEO 100/100/100 |
| 1024 px production full-page visual spot-check | **PASS** — balanced wrapping, CTA in first viewport, no horizontal overflow |
| font network-transfer comparison from Lighthouse `network-requests` | **PASS** — 94,292 → 80,874 bytes (−13,418 bytes) |
| `git status --short supabase/ types/database.ts` | **PASS** — empty |
| added-line physical-direction grep gate | **PASS** — zero matches |
| P2 implementation grep gate | **PASS** — no new `next-intl`, Arabic/RTL, Thmanyah, locale switcher, or preference-store implementation |
| `git diff --check` | **PASS** — no whitespace errors |

The production builds emit the pre-existing Next.js `middleware` deprecation warning. The lint run
emits the same four pre-existing warnings recorded by MP1. The in-app browser runtime exposed no
browser in this session, so the existing repository Playwright/Chromium toolchain captured the
required production screenshots and performed responsive checks.

### 7. Security and scope review

- MP2 changes presentation only. No query, mutation, RPC, server action, auth flow, route gate,
  environment variable, public data boundary, log statement, or dependency was added.
- The early-access RPC, fail-closed rate limit, and public registration-status fields are unchanged.
- No patient/clinical field, PHI surface, service-role path, operator path, or serialized data shape
  changed.
- Theme scope classes and the MP1 light/dark architecture remain intact.
- No migration, database type, RLS, middleware, billing, entitlement, P2 persistence, i18n, RTL,
  Arabic typography, or language control was introduced.

### 8. Stable findings

- **POSTPREP2-MP2-R1 — RESOLVED:** DM Sans + Instrument Serif read as generic/startup-editorial;
  the selected IBM Plex superfamily supplies one formal, institutional, healthcare-credible Latin
  voice with explicit fallbacks.
- **POSTPREP2-MP2-R2 — RESOLVED:** marketing motion was limited to a container entrance, float,
  translate-only reveal, and hover lift; MP2 adds staged hero choreography, label drawing,
  translate/scale section entry, frame parallax, and unified CTA/card physics without JS or layout
  animation.
- **POSTPREP2-MP2-R3 — RESOLVED:** Source Serif 4 failed the mandatory three-run performance gate;
  IBM Plex Serif matched the visual quality and the selected 400-only build passes 92/92/92 while
  reducing font transfer below baseline.
- **POSTPREP2-MP2-R4 — RESOLVED:** reveal opacity reduced computed contrast and Lighthouse
  Accessibility to 96; removing opacity restored 100/100/100 while preserving translate/scale
  motion.

### 9. Git state and scope audit

- Branch observed: `fix/post-pre-p2-manual-polish`.
- The dirty working tree already contained preserved MP0, MP1, manual-plan, and screenshot changes
  before MP2 began; none were reset, restored, overwritten, staged, or discarded.
- The staging area remains empty.
- No commit, push, merge, branch creation, stage, reset, restore, checkout, clean, or stash action
  occurred.
- MP2 added/edited only the files listed in §2. MP3 and every later workstream remain unstarted.

### 10. Final verdict

**IMPLEMENTED — awaiting comprehensive review**

MP2 is complete. The selected IBM Plex system is visually formal at every required viewport,
lighter than the previous font payload, and green across the three-run performance/accessibility
gate. Motion is richer but concentrated, CSS-only, LCP-safe, and fully disabled for reduced-motion
users. Copy, IA, MP0/MP1 work, and every later workstream remain unchanged.

## Re-review history

- **Review Cycle 1 — 2026-07-14:** initial MP2 implementation audit. Four implementation findings
  resolved; no optional MP2 polish finding remains open. Status is implemented and awaiting
  comprehensive review.
