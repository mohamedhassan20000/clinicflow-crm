# Summary

- Completed the `legal.noticeTitle` rename with semantic parity: `ClinicFlow Liability Limitations` in English and `حدود مسؤولية ClinicFlow` in Arabic.
- Updated every repository expectation found for the superseded English and Arabic headings.
- Preserved both legal disclaimer bodies and all application code unchanged.
- Created and worked on `feat/production-seo-hardening`.

# Files changed

- `messages/ar.json` — adopted the existing Arabic heading rename.
- `messages/en.json` — renamed the English heading.
- `tests/unit/components/ws9-legal-and-seo.test.tsx` — aligned the rendered heading and locale catalog expectations.
- `tests/e2e/terms-ar.spec.ts` — aligned the English and Arabic terms-page heading expectations found by the required repository search.
- `tests/e2e/login.spec.ts` — aligned the legal-page English heading expectation found by the required repository search.
- `docs/reviews/seo/P0_IMPLEMENTATION.md` — recorded Phase 0 implementation and validation.

# Tests executed

- `npm run typecheck && npm run lint`
- `npm test -- tests/unit/components/ws9-legal-and-seo.test.tsx`
- `npm run i18n:missing`
- `npm test`
- `npm run build`

# Validation results

- Typecheck: passed.
- Lint: passed with 0 errors and 26 pre-existing warnings outside the Phase 0 files.
- Focused legal/SEO unit suite: passed, 1 file and 4 tests.
- Message parity: passed, 2,306 base leaf messages.
- Full unit suite: passed, 116 files and 614 tests.
- Production build: passed and generated 52 static pages. The first sandboxed attempt could not fetch the configured Manrope Google Font; the identical command passed with approved network access.
- Repository search: no superseded heading remains outside the implementation specification.
- Diff check: passed.

# Manual verification

- Started the production build locally on port 3100.
- Rendered `/terms` with `cf_marketing_locale=en`; confirmed `ClinicFlow Liability Limitations` and the unchanged English disclaimer body.
- Rendered `/terms` with `cf_marketing_locale=ar`; confirmed `حدود مسؤولية ClinicFlow` and the unchanged Arabic disclaimer body.
- Stopped the local server after verification.

# Known issues

- Lint retains 26 pre-existing warnings outside the Phase 0 scope.
- The successful build retains Next.js's existing middleware-file-convention deprecation warning.
- `docs/SEO_PRODUCTION_HARDENING.md` was already untracked before implementation and remains unmodified.

# Ready for review

- Phase 0 is complete and ready for architectural review.
- Phase 1 was not started. No commit or push was performed.
