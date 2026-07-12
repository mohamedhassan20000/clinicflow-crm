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
