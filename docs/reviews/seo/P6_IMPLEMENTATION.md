# Summary

Implemented the optional localized public root 404 as a server-rendered `app/not-found.tsx`. It uses the existing next-intl request locale, root-layout `lang`/`dir`, ClinicFlow marketing tokens, and `MarketingLogo`; it contains only safe public copy and a link to `/`. No metadata override was added, so Next.js retains its automatic not-found `noindex` behavior and real HTTP 404 response.

# Files changed

- Added `app/not-found.tsx`.
- Modified `messages/en.json` with the English `notFound` namespace.
- Modified `messages/ar.json` with the Arabic `notFound` namespace.
- Added `tests/unit/components/p6-localized-root-not-found.test.tsx`.
- Added `tests/e2e/localized-root-not-found.spec.ts`.
- Added `docs/reviews/seo/P6_IMPLEMENTATION.md`.

# Tests executed

- `npm test -- tests/unit/components/p6-localized-root-not-found.test.tsx` — passed, 3/3.
- `npm test -- tests/unit/components/ws9-legal-and-seo.test.tsx` — passed, 15/15.
- `npm test` — passed, 651/651 across 120 files.
- `npm run typecheck` — passed.
- Targeted ESLint for all Phase 6 code and tests — passed.
- `npm run lint` — passed with 26 existing warnings and no errors.
- `npm run lint:rtl` — passed.
- `npm run i18n:missing` — passed, 2,312 base leaf messages.
- `npm run i18n:unused` — passed.
- `npm run lint:i18n` — failed on the pre-existing Phase 3 literal in `app/manifest.ts`; no Phase 6 file was reported.
- `npm run build` — passed after allowing the configured Google Font fetch.
- `PLAYWRIGHT_BASE_URL=http://localhost:3100 npx playwright test tests/e2e/localized-root-not-found.spec.ts --project=chromium` — passed, 2/2.

# Validation results

- Random unknown public paths return `404 Not Found` in the production server.
- English renders the expected localized heading with `lang="en"` and `dir="ltr"`.
- Arabic renders the expected localized heading with `lang="ar"` and `dir="rtl"`.
- Robots metadata contains `noindex`; `app/not-found.tsx` defines no metadata override.
- Browser validation found no hydration, page, console, or unexpected subresource errors.
- The home recovery link resolves to `/` in both locales.
- The protected and operator 404 components retain their existing headings and destinations, and neither route-group file has a Phase 6 diff.
- No routing, auth, Supabase, tenant, patient, manifest, JSON-LD, sitemap, robots, or middleware code was changed.

# Manual verification

- Queried two random unknown paths from the local production server with Arabic and English locale cookies.
- Confirmed HTTP 404 status, localized text, `html` locale/direction attributes, and `noindex` in returned HTML.
- Confirmed the production build exposes the root `/_not-found` route and retains the existing protected/operator files unchanged.

# Known issues

- No Phase 6 issue found.
- The repository-wide `lint:i18n` gate independently reports the existing Phase 3 English manifest description in `app/manifest.ts`; it is outside Phase 6 scope and was not modified.

# Ready for review

Yes. Phase 6 is ready for architectural review.
