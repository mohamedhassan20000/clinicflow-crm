# Summary

- Added one typed JSON-LD helper that builds the required `WebSite`, `Organization`, `SoftwareApplication`, and `FAQPage` graph with canonical public ClinicFlow URLs.
- Added one server-rendered homepage JSON-LD script with safe less-than-sign escaping.
- Sourced localized FAQ entities from the same `getMarketingCopy(...).faq.items` tree used by the rendered marketing page; no second FAQ list was added.
- Added focused Phase 4 coverage for localization, canonical URLs, forbidden fields and routes, safe serialization, and server-rendered output.

# Files changed

- `lib/seo/structured-data.ts` — added the typed graph builder and safe serializer.
- `app/page.tsx` — added the localized graph construction and one JSON-LD script.
- `tests/unit/lib/structured-data.test.tsx` — added focused Phase 4 tests.
- `docs/reviews/seo/P4_IMPLEMENTATION.md` — recorded the Phase 4 implementation and validation.

# Tests executed

- `npm test -- tests/unit/lib/structured-data.test.tsx`
- `npm run typecheck`
- `npm run lint`
- `npm test -- tests/unit/components/ws9-legal-and-seo.test.tsx`
- `npm test`
- `npm run build`

# Validation results

- Focused Phase 4 suite: passed, 1 file and 6 tests.
- Typecheck: passed.
- Lint: passed with 0 errors and the same 26 pre-existing warnings recorded in prior phases.
- Focused legal/SEO suite: passed, 1 file and 15 tests.
- Full unit suite: passed, 118 files and 640 tests.
- Production build: passed and generated 55 pages. The first sandboxed attempt could not fetch the configured Manrope Google Font; the identical network-enabled rerun passed.
- Structured-data validation: passed for the schema.org context, exactly four top-level graph types, canonical `https://www.clinicflow.fit` URLs, localized descriptions, localized FAQ parity, safe serialization, and absence of unsupported commercial/reputation fields, private routes, and tenant identifiers.

# Manual verification

- Started the production build locally on port 3100 and inspected server-rendered HTML for `/?landingLocale=en` and `/?landingLocale=ar`.
- Confirmed each locale emits exactly one parseable `application/ld+json` script with no raw less-than signs.
- Confirmed `lang`, localized description, and every JSON-LD FAQ question/answer match the active locale and rendered FAQ DOM.
- Confirmed the existing marketing page remains present and unchanged in both locales.
- Stopped the local production server after verification.

# Known issues

- The existing English FAQ catalog contains 9 items while the existing Arabic catalog contains 8, although the specification describes the shared source as a 9-item list. Phase 4 does not alter marketing copy or UI, so each locale's JSON-LD truthfully mirrors its current rendered FAQ array.
- Lint retains 26 pre-existing warnings outside the Phase 4 scope.
- The successful build retains Next.js's existing middleware-file-convention deprecation warning; Phase 4 did not modify middleware.

# Ready for review

- Phase 4 is complete and ready for architectural review.
- No Phase 5 or later work was implemented.
- No review file, commit, or push was created.
