# P1.5C marketing performance gate

The production marketing page at `/` must score at least **90 Performance** and **90 Accessibility** in Lighthouse’s mobile preset before P1.5C is merged.

## Manual procedure

1. Build and run the production application with the local Supabase environment available:
   `pnpm build` followed by `pnpm start`.
2. Run Lighthouse against `http://localhost:3000/` using the mobile preset, a fresh browser profile, and simulated throttling.
3. Record the date, commit/worktree identifier, Lighthouse version, Performance score, and Accessibility score below.
4. A score below 90 in either category fails the gate. Fix the regression and repeat the run; do not waive the threshold without updating the authoritative implementation plan.

## Latest result

- Date: 2026-07-12
- Target: local production build, `http://127.0.0.1:3100/`
- Lighthouse: 13.4.0, mobile form factor, simulated throttling
- Performance: **96**
- Accessibility: **100**
- Result: **PASS**

Command used:

`pnpm dlx lighthouse http://127.0.0.1:3100/ --only-categories=performance,accessibility --form-factor=mobile --output=json --output-path=/tmp/p15c-lighthouse.json --chrome-flags='--headless --no-sandbox --disable-gpu' --quiet`

## P15-R1 verification — 2026-07-13

The early-access form is now loaded dynamically when its dialog opens, keeping
the international phone-input dependency out of the marketing page's initial
JavaScript path. Three consecutive Lighthouse 13.4.0 mobile runs against the
local production build at `http://127.0.0.1:3100/` produced:

| Run | Performance | Accessibility | Result |
|---|---:|---:|---|
| 1 | **96** | **100** | PASS |
| 2 | **90** | **100** | PASS |
| 3 | **92** | **100** | PASS |

Command used for each run (with the output path numbered 1–3):

`pnpm dlx lighthouse http://127.0.0.1:3100/ --only-categories=performance,accessibility --form-factor=mobile --output=json --output-path=/tmp/p15-r1-lighthouse-1.json --chrome-flags='--headless --no-sandbox --disable-gpu' --quiet`

## PRE-P2 WS9 redesign verification — 2026-07-13

The redesigned RSC marketing shell was measured from the production build at
`http://127.0.0.1:3105/` on worktree base `cf240b3` (the WS0–WS9 integrated,
uncommitted worktree). The only client-side marketing islands remain the
existing early-access dialog and the mobile navigation sheet. Hero and product
screenshots are optimized AVIF assets with explicit dimensions.

| Run | Performance | Accessibility | Simulated LCP | Initial script transfer | Result |
|---|---:|---:|---:|---:|---|
| 1 | **92** | **100** | 3.30 s | 207 KB | PASS |
| 2 | **92** | **100** | 3.29 s | 207 KB | PASS |
| 3 | **92** | **100** | 3.30 s | 207 KB | PASS |

All three mandatory ≥90 Performance / ≥90 Accessibility runs pass, accessibility
remains 100, and initial script transfer stays below the approximately 260 KB
baseline. The practical LCP ≤2.5 s target remains aspirational in Lighthouse's
simulated mobile result; the trace identified the server-rendered hero heading
as LCP, with only approximately 55 ms TTFB plus 61 ms element-render delay in
run 1 and no blocking-script regression.

Command used for each run (with the output path numbered 1–3):

`pnpm dlx lighthouse@13.4.0 http://127.0.0.1:3105/ --only-categories=performance,accessibility --form-factor=mobile --output=json --output-path=/tmp/ws9-lighthouse-1.json --chrome-flags='--headless --no-sandbox --disable-gpu' --quiet`

## Final shippable-tree validation — Final Validation Cycle 2 (2026-07-13)

The measurements above remain part of the historical record. After Final Validation
Cycle 2 changed the marketing entry path, the resulting integrated Pre-P2 tree was rebuilt
and audited three times at `http://127.0.0.1:3112/`. These are the latest verified results
for the tree intended to ship, as recorded in `docs/reviews/PRE_P2_FINAL_VALIDATION.md`.

| Run | Performance | Accessibility | Best Practices | SEO | Simulated LCP | Initial script transfer | Result |
|---|---:|---:|---:|---:|---:|---:|---|
| 1 | **91** | **100** | **100** | **100** | 3.5 s | 198,703 bytes | PASS |
| 2 | **90** | **100** | **100** | **100** | 3.7 s | 198,703 bytes | PASS |
| 3 | **91** | **100** | **100** | **100** | 3.5 s | 198,703 bytes | PASS |

All three mandatory ≥90 Performance / ≥90 Accessibility runs pass. Initial script
transfer improved from the preceding WS9 measurement of approximately 207 KB to
198,703 bytes. The ≤2.5 s LCP target remains aspirational and is not represented as met.

Command used for each run (with the output path numbered 1–3):

`pnpm dlx lighthouse@13.4.0 http://127.0.0.1:3112/ --quiet --chrome-flags="--headless --no-sandbox" --only-categories=performance,accessibility,best-practices,seo --output=json --output-path=/tmp/pre-p2-fix-lighthouse-run-1.json`

## Post-Pre-P2 MP2 typography and motion verification — 2026-07-14

MP2 replaced the Latin stack with IBM Plex Sans (variable, normal) + IBM Plex Serif
(400 normal), retained Geist Mono, and deepened the marketing motion using CSS transforms and
view timelines only. All fonts still load through `next/font/google`, which self-hosts the emitted
WOFF2 assets; the production page makes no runtime request to Google or another font origin.

The selected build was audited three times at `http://127.0.0.1:3120/` using the same Lighthouse
13.4.0 mobile preset and simulated throttling as the previous gate:

| Run | Performance | Accessibility | Best Practices | SEO | Simulated LCP | TBT | Initial script transfer | Result |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| 1 | **92** | **100** | **100** | **100** | 3.39 s | 12.5 ms | 198,701 bytes | PASS |
| 2 | **92** | **100** | **100** | **100** | 3.37 s | 3.5 ms | 198,701 bytes | PASS |
| 3 | **92** | **100** | **100** | **100** | 3.37 s | 6.5 ms | 198,701 bytes | PASS |

All three runs clear the mandatory ≥90 Performance / ≥90 Accessibility gate. Accessibility stays
at 100, the initial script transfer is unchanged from the final Pre-P2 record within measurement
noise (198,703 → 198,701 bytes), and TBT remains well below the approximately 10 ms budget except
for a 12.5 ms first-run variance. The existing aspirational LCP ≤2.5 s target remains unmet and is
not represented as passing.

The actual font transfer on `/` decreased from **94,292 bytes** before MP2 to **80,874 bytes** in
the selected build (**−13,418 bytes**). Source Serif 4 was measured as the recommended comparison
candidate but failed the performance gate; the complete candidate record and the 360/768/1440
screenshots are in `docs/reviews/POST_PRE_P2_MP2_REVIEW.md`.

Command used for each final run (with the output path numbered 1–3):

`pnpm dlx lighthouse@13.4.0 http://127.0.0.1:3120/ --quiet --chrome-flags='--headless --no-sandbox' --only-categories=performance,accessibility,best-practices,seo --output=json --output-path=/tmp/mp2-final-lighthouse-1.json`
