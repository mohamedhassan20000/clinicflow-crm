# Summary

Implemented Phase 1 public crash-surface closure only. Added a localized root route error boundary that follows the existing authenticated boundary pattern, plus a self-contained bilingual global boundary for root-layout failures with Sentry capture and safe retry behavior.

# Files changed

- `app/error.tsx` — localized recoverable public/root route boundary.
- `app/global-error.tsx` — standalone root-layout fallback with inline styling and bilingual static copy.
- `messages/en.json` — one public error-description key.
- `messages/ar.json` — matching Arabic public error-description key.
- `tests/unit/app/p1-public-error-boundaries.test.tsx` — focused privacy, digest, recovery, self-containment, bilingual-copy, and Sentry assertions.
- `docs/reviews/ux/P1_IMPLEMENTATION.md` — this implementation report.

# Tests executed

- `pnpm exec vitest run tests/unit/app/p1-public-error-boundaries.test.tsx` — passed, 1 file / 2 tests.
- `pnpm test` — passed, 121 files / 653 tests.
- `pnpm typecheck` — passed.
- `pnpm lint` — passed with 0 errors and 26 pre-existing warnings outside the Phase 1 diff.
- `pnpm lint:rtl` — passed.
- `pnpm lint:i18n` — passed.
- `pnpm i18n:missing` — passed; 2,313 base leaf messages with valid locale parity.
- `pnpm build` — passed; optimized production build compiled, typechecked, and generated all 55 static pages.
- `git diff --check` — passed.

# Validation results

- The public boundary renders localized safe copy, a safe digest only, a home escape link, and a working retry action.
- The global boundary renders without application providers, includes its own `html` and `body`, uses only inline styles, renders English and Arabic copy, calls `Sentry.captureException(error)`, and exposes a working retry action.
- Focused tests confirm error messages containing mock patient, tenant, national-ID, and stack details are not rendered.
- Production build route output includes the marketing, legal, auth, signup, protected, and operator routes without routing or compilation regression.
- The three existing protected/auth/operator error boundaries, root layout, middleware, routing, and hydration architecture are unchanged.
- Local development smoke responses: `/` returned 200; `/dashboard` preserved its 307 redirect to `/login`; an invalid `/signup/test-token` request reached the route and returned its expected 404 state.

# Manual verification

- Browser-driven temporary-throw verification could not be executed because this session exposed no browser backend.
- The equivalent boundary rendering, privacy, digest, bilingual copy, Sentry capture, and reset behaviors were exercised in jsdom.
- The application started successfully on port 3100 and served the scoped route smoke checks without server errors.
- RTL and locale parity were verified by the repository gates; visual RTL mirroring remains part of the pending browser-only check.

# Known issues

- The specification's visual temporary-throw checks remain pending in a browser-capable environment.
- `pnpm build` emits the pre-existing Next.js middleware-to-proxy deprecation warning.
- `pnpm lint` emits 26 pre-existing warnings outside the Phase 1 diff. No unrelated warning was changed.

# Ready for review

Yes. The Phase 1 implementation and automated validation are ready for architectural review, with the browser-only manual verification limitation recorded above.
