# Summary

- Added locale-following, pipe-separated absolute browser titles for `/`, `/privacy`, and `/terms`.
- Moved the canonical `metadataBase` to the root metadata generator while preserving the root `%s · ClinicFlow` title template and root noindex rule.
- Preserved visible legal-page headings by adding metadata-specific title keys under the existing legal namespaces.
- Added resolved metadata coverage for both locales, canonical URLs, public indexing, root noindex, title-template preservation, and catalog parity.

# Files changed

- `app/layout.tsx` — centralized `metadataBase` without changing the root title template or robots rule.
- `app/page.tsx` — removed the page-local `metadataBase` and made the localized homepage title absolute.
- `app/privacy/page.tsx` — applied the localized privacy metadata title as an absolute title.
- `app/terms/page.tsx` — applied the localized terms metadata title as an absolute title.
- `messages/en.json` — added the approved English public metadata title values.
- `messages/ar.json` — added the approved Arabic public metadata title values.
- `tests/unit/components/ws9-legal-and-seo.test.tsx` — added the Phase 1 resolved metadata and catalog assertions.
- `docs/reviews/seo/P1_IMPLEMENTATION.md` — recorded the Phase 1 implementation and validation.

# Tests executed

- `npm run typecheck`
- `npm run lint`
- `npm test -- tests/unit/components/ws9-legal-and-seo.test.tsx`
- `npm run i18n:missing`
- `npm run i18n:unused`
- `npm test`
- `npm run build`

# Validation results

- Typecheck: passed after correcting a Phase 1 test-only `metadataBase` parameter annotation.
- Lint: passed with 0 errors and the same 26 pre-existing warnings recorded in Phase 0.
- Focused legal/SEO unit suite: passed, 1 file and 7 tests.
- Message parity: passed, 2,308 base leaf messages.
- Unused messages: passed with no unreferenced keys.
- Full unit suite: passed, 116 files and 617 tests.
- Production build: passed and generated 52 pages. The first sandboxed attempt could not fetch the configured Manrope Google Font; the identical approved-network rerun passed.
- Diff check: passed.

# Manual verification

- Started the production build locally on port 3100 and inspected the rendered HTML for `/`, `/privacy`, and `/terms` in English and Arabic using the existing marketing-locale inputs.
- Confirmed all six exact localized titles, one localized brand occurrence per title, canonical `https://www.clinicflow.fit` URLs, `index, follow`, and matching `lang`/`dir` values.
- Confirmed the root `%s · ClinicFlow` template and root noindex rule through the resolved metadata test.
- Stopped the local production server after verification.

# Known issues

- No browser backend was available in this session, so the language-switcher click-through and a signed-in `/dashboard` tab could not be verified interactively. The same locale resolution and unchanged authenticated-title template are covered by the Phase 1 metadata tests.
- Lint retains 26 pre-existing warnings outside the Phase 1 scope.
- The successful build retains Next.js's existing middleware-file-convention deprecation warning.
- `docs/SEO_PRODUCTION_HARDENING.md` and the Phase 0 working-tree changes remain uncommitted and were not modified as part of Phase 1.

# Ready for review

- Phase 1 is complete and ready for architectural review.
- No Phase 2 or later work was implemented.
- No commit or push was performed.
