# Summary

- Refined the existing landing-document redirect condition so it runs only when the `cf_marketing_locale` cookie exists and differs from the Arabic anonymous default.
- Cookie-less `GET /` now falls through to the existing Arabic request-cookie mutation and Supabase session refresh instead of redirecting.
- Added focused regression coverage for a cookie-less root GET with no `sec-fetch-dest`, `rsc`, or `next-router-state-tree` headers.
- Preserved the English-cookie one-hop reset, explicit valid `landingLocale` handling, RSC/navigation bypasses, protected-route delegation, matcher, cookie attributes, and all Supabase/auth/onboarding/billing behavior.
- Implemented Phase 5 only. No user-agent special case, routing refactor, or later-phase work was added.

# Files changed

- `middleware.ts` — added the cookie-presence requirement to the existing redirect condition only.
- `tests/unit/lib/p5-homepage-crawlability.test.ts` — added focused middleware behavior and preservation coverage.
- `docs/reviews/seo/P5_IMPLEMENTATION.md` — recorded the Phase 5 implementation and validation.

# Tests executed

- `npm test -- tests/unit/lib/p5-homepage-crawlability.test.ts` before the fix and after the fix.
- `npm test -- tests/unit/lib/p5-homepage-crawlability.test.ts tests/unit/lib/p2a-locale-resolution.test.ts tests/unit/components/p2a-language-switcher.test.tsx tests/unit/lib/public-flow-middleware.test.ts tests/unit/lib/p1b-middleware-gating.test.ts`
- `npm run typecheck`
- `npm run lint`
- `npm test -- tests/unit/components/ws9-legal-and-seo.test.tsx`
- `npm test`
- `npm run build`
- `PORT=3100 node --env-file=.env.local node_modules/@playwright/test/cli.js test tests/e2e/login.spec.ts`
- `PORT=3100 node --env-file=.env.local node_modules/@playwright/test/cli.js test tests/e2e/smoke.spec.ts`
- `PORT=3100 node --env-file=.env.local node_modules/@playwright/test/cli.js test tests/e2e/smoke.spec.ts --grep 'WS7 operator report filters persist'`
- `PORT=3100 node --env-file=.env.local node_modules/@playwright/test/cli.js test tests/e2e/smoke.spec.ts --retries=1`

# Validation results

- Test-first proof: before the condition change, the new cookie-less document test failed with `307` instead of `200`; the other 6 preservation tests passed.
- Focused Phase 5 tests after the fix and follow-up: passed, 1 file and 8 tests.
- Focused locale/middleware regression suite: passed, 5 files and 62 tests.
- Typecheck: passed.
- Lint: passed with 0 errors and 26 pre-existing warnings.
- Focused legal/SEO gate: passed, 1 file and 15 tests.
- Full unit suite: passed, 119 files and 647 tests.
- Production build: passed and generated 55 pages. The first sandboxed attempt could not fetch the configured Manrope Google Font; the identical network-enabled rerun passed.
- Focused login/landing Playwright spec on port 3100: passed, 17 tests.
- Dedicated Playwright smoke file on port 3100: final full run passed, 22 tests. Two earlier full attempts stopped on an unrelated WS7 keyboard-timing assertion; that test passed in isolation, and the complete final run passed with one standard retry configured without skipping any test.
- No Phase 5 behavior regression was found in locale resolution, cookie persistence, RSC/navigation handling, protected routes, auth, session refresh, onboarding, or billing gates.

# Manual verification

- Production build on port 3100: cookie-less `GET /` returned `200` with no redirect and rendered `<html lang="ar" dir="rtl">` with the Arabic homepage title.
- The same build with `cf_marketing_locale=en`: the first request returned `307` to `/?landingLocale=ar`; following redirects produced `200` after exactly one redirect and rendered Arabic RTL HTML.
- The browser login/landing flow confirmed the marketing language switcher round-trip, English preservation on login, and Arabic reset on a later full landing reload.
- The dedicated smoke flow confirmed protected-route redirection, authenticated deep-route access, sign-out, account-locale isolation, anonymous marketing-locale isolation, and authenticated-session preservation.

# Known issues

- Lint retains 26 pre-existing warnings outside Phase 5 scope.
- Next.js emits the existing `middleware.ts` deprecation warning. Renaming it to `proxy.ts` is a routing-architecture change and was intentionally not performed in this isolated phase.
- The WS7 operator-report keyboard test showed transient timing failures during two full smoke attempts, then passed alone and in the final complete 22-test run. No related code or test was changed.

# Ready for review

- Phase 5 is complete and ready for architectural review.
- No Phase 6 work, separate review file, commit, or push was created.
