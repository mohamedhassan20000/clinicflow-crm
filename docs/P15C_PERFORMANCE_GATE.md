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
