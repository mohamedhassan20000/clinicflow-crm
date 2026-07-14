# Post-Pre-P2 MP3 Review — Marketing Logo Treatment

**Status:** IMPLEMENTED — awaiting comprehensive review
**Workstream:** MP3 (`docs/POST_PRE_P2_MANUAL_POLISH.md` §9-MP3)
**Review cycle:** 1
**Review date:** 2026-07-14
**Final verdict:** **IMPLEMENTED — awaiting comprehensive review**

This is the authoritative MP3 implementation-review record. Later reviews must preserve Review
Cycle 1, retain stable finding IDs, and append history rather than replace it.

## Review Cycle 1

### 1. Implementation scope

Implemented MP3 only:

- removed the decorative cyan badge wrapper, rounded container, clipping, and inset shadow from
  the shared marketing logo;
- rendered the existing transparent `/brand/clinicflow-mark.png` asset directly beside the
  existing ClinicFlow wordmark;
- used the same direct-image treatment for the light header and deep-teal footer through the
  existing shared `MarketingLogo` component;
- preserved the `/` destination, `ClinicFlow home` accessible name, `min-h-11` target, normal and
  inverse focus-ring offsets, explicit image dimensions, spacing, and wordmark typography;
- added focused unit and production-browser regression coverage for the unbadged structure,
  transparent background, dimensions, alignment, hit target, and responsive containment.

No MP4 auth-logo navigation, MP5 phone layout, MP6 operator-header work, MP7 sidebar work, P2
functionality, language control, preference persistence, migration, schema, RLS, middleware,
authentication, early-access, or data-path change is included.

### 2. Exact files changed

Product code:

- `components/marketing/marketing-logo.tsx`

Tests/documentation:

- `tests/unit/components/mp3-marketing-logo.test.tsx` (new)
- `tests/e2e/login.spec.ts` (MP3-specific marketing-logo production check only; preserved MP1/MP2
  coverage already present in the dirty tree)
- `docs/reviews/POST_PRE_P2_MP3_REVIEW.md` (new)

Explicitly unchanged by MP3:

- `/brand/clinicflow-mark.png` itself;
- every auth logo/link and `app/(auth)/layout.tsx` — MP4 remains unstarted;
- the sidebar and dashboard shell — MP6/MP7 remain unstarted;
- marketing copy, page structure, typography, motion, theme scopes, and performance-gate record;
- `supabase/`, `types/database.ts`, RLS, middleware, and every P2 surface;
- the MP0, MP1, and MP2 implementation/review records.

### 3. Implementation and acceptance audit

- The mark is now a direct child of the semantic logo link; there is no intermediate badge or
  background container.
- The removed markup contains the complete artificial treatment:
  `bg-[#13c7d8]`, `rounded-xl`, `overflow-hidden`, and the inset white shadow.
- The existing RGBA source asset remains unchanged at 417 × 358 px with alpha transparency.
- Render dimensions remain explicit (`width={34}`, `height={30}`), with the existing `h-8 w-auto`
  display size and a new `shrink-0` on the image itself after removal of the wrapper.
- Header and footer continue to render the same component and same image source. The footer uses
  only the existing inverse wordmark/focus colors; the mark needs no brightness or inverse filter.
- The link remains `href="/"`, `aria-label="ClinicFlow home"`, and `min-h-11` (44 px minimum).
- The focus treatment remains `focus-visible:ring-2 focus-visible:ring-cyan-400` with the light
  `#f5fbfb` offset in the header and dark `#073846` offset in the footer.
- No copy, navigation behavior, layout hierarchy, or image request changed.

### 4. Responsive and visual audit

Production Chromium checked the shared lockup at 320, 360, 768, 1024, and 1440 px:

- both logo links remain inside the viewport and at least 44 px tall;
- the image is a direct child with a computed transparent background in header and footer;
- image and wordmark vertical centers remain within 2 px at every tested width;
- the 320 px header lockup stays on one line and does not shift into the mobile-menu control;
- the cyan mark is crisp on the light `--m-paper` header and remains clearly legible on the
  `#073846` footer without a backing shape or image filter;
- the 1440 px lockups preserve the existing header/footer spacing and alignment.

Temporary production screenshots were inspected for the 320 and 1440 px header and footer. They
were validation outputs under `/tmp`, not repository artifacts.

### 5. Validation commands and exact results

| Command | Result |
|---|---|
| `pnpm exec vitest run tests/unit/components/mp3-marketing-logo.test.tsx tests/unit/components/p15c-marketing-page.test.tsx` | **PASS** — 2 files, 8 tests |
| `pnpm test` | **PASS** — 100 files, 518 tests |
| `pnpm typecheck` | **PASS** — exit 0; no diagnostics |
| `pnpm lint` | **PASS WITH WARNINGS** — 0 errors; the same 4 pre-existing warnings recorded by MP1/MP2 |
| `PORT=3130 node --env-file=.env.local node_modules/@playwright/test/cli.js test tests/e2e/login.spec.ts --project=chromium --workers=1` | **PASS** — production build; Chromium 9/9 in 19.6s |
| Production logo geometry/transparent-background check at 320/360/768/1024/1440 px | **PASS** — header and footer contained, aligned, transparent, and ≥44 px |
| Production visual spot-check at 320 and 1440 px | **PASS** — clear on light header and dark footer; no badge, wrap, or shift |
| `file` + `sips` inspection of `public/brand/clinicflow-mark.png` | **PASS** — unchanged 417 × 358 RGBA PNG with alpha |
| `git status --short supabase/ types/database.ts` | **PASS** — empty |
| Added-line physical-direction utility grep over MP3 files | **PASS** — zero matches |
| `git diff --check` | **PASS** — no whitespace errors |

The first focused unit run expected the raw source URL, while `next/image` correctly rendered an
optimized `/_next/image` URL. The assertion was corrected to inspect the decoded optimized URL;
the final result above is green. The first sandboxed Playwright attempt reached the known `tsx`
IPC `EPERM`; the approved production run passed. The build emitted the pre-existing Next.js
`middleware` deprecation warning. No MP3 integration suite is required because MP3 changes no
query, mutation, database object, or server boundary.

MP3 adds no JavaScript behavior, dependency, image asset, network request, or font/CSS payload.
The existing optimized image request and explicit dimensions are unchanged, so the MP2 three-run
Lighthouse record remains the applicable marketing performance gate and was not overwritten.

### 6. Security and scope review

- MP3 changes static presentation only. No query, mutation, RPC, server action, auth flow, route
  gate, environment variable, log statement, dependency, or public-data boundary changed.
- The early-access RPC, fail-closed rate limit, registration-status fields, and dialog behavior are
  unchanged.
- No PHI/PII field, operator path, clinic path, or serialized data shape changed.
- No migration, schema type, RLS policy, middleware, billing, entitlement, i18n/RTL, language
  control, or `user_ui_preferences` implementation was introduced.

### 7. Stable findings

- **POSTPREP2-MP3-R1 — RESOLVED:** the real transparent ClinicFlow mark was nested inside an
  artificial cyan rounded badge; the wrapper and every badge-specific style are removed.
- **POSTPREP2-MP3-R2 — RESOLVED:** the marketing lockup now matches the established direct-mark
  treatment used outside marketing while preserving one shared header/footer component, explicit
  dimensions, link semantics, hit target, focus treatment, and responsive alignment.
- **POSTPREP2-MP3-R3 — RESOLVED:** the direct mark was verified on both approved marketing
  backgrounds and needs no footer-only filter or backing container.

### 8. Optional polish findings

None. MP4 and every later workstream remain intentionally unstarted.

### 9. Git state and scope audit

- Branch observed: `fix/post-pre-p2-manual-polish`.
- The dirty working tree already contained preserved MP0, MP1, MP2, planning, test, review, and
  generated screenshot changes before MP3 began; none were reset, restored, overwritten, staged,
  or discarded.
- The staging area remains empty.
- MP3 added/edited only the files listed in §2.
- No commit, push, merge, branch creation, stage, reset, restore, checkout, clean, or stash action
  occurred.

### 10. Final verdict

**IMPLEMENTED — awaiting comprehensive review**

MP3 is complete. The marketing header and footer now show the transparent ClinicFlow mark directly
with no square, badge, background container, clipping, or inset decoration. The shared lockup
retains its navigation, accessibility, dimensions, focus treatment, spacing, contrast, and
responsive behavior. MP4 and all later workstreams remain unstarted.

## Re-review history

- **Review Cycle 1 — 2026-07-14:** initial MP3 implementation audit. Three required findings
  resolved; no optional MP3 polish finding remains open. Status is implemented and awaiting
  comprehensive review.
