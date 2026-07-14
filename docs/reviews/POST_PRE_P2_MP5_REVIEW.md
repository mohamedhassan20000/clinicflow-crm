# Post-Pre-P2 MP5 Review — Country Calling-Code Alignment

**Status:** IMPLEMENTED — awaiting comprehensive review
**Workstream:** MP5 (`docs/POST_PRE_P2_MANUAL_POLISH.md` §9-MP5)
**Review cycle:** 1
**Review date:** 2026-07-14
**Final verdict:** **IMPLEMENTED — awaiting comprehensive review**

This is the authoritative MP5 implementation-review record. Later reviews must preserve Review
Cycle 1, retain stable finding IDs, and append history rather than replace it.

## Review Cycle 1

### 1. Implementation scope

Implemented MP5 only:

- replaced the country picker's free-flowing row with a fixed flag / name / ISO / dial-code grid;
- fixed the numeric column at `5rem`, aligned it to the logical inline end, and enabled tabular
  numerals on both list rows and the trigger;
- constrained the popover to `min(280px, calc(100vw - 2rem))`, preserving a full four-column row
  at 320 px without horizontal page overflow;
- made country names truncate within the flexible column while keeping the complete country name,
  ISO code, and calling code in each option's accessible name;
- retained the existing fixed-width 132 px trigger and prevented its contents from changing the
  control width when a country changes;
- added focused unit and production-browser coverage for responsive alignment, accessibility,
  search, keyboard selection, Escape, hidden inputs, E.164 emission, and dark/light rendering.

No MP6 operator-header work, MP7 sidebar work, P2 functionality, migration, schema, RLS,
middleware, route, server-action, phone-registry, validation, or persistence change is included.
MP0–MP4 were not redone or overwritten.

### 2. Exact files changed

Product code:

- `components/shared/international-phone-input.tsx` — minimal four-cell option markup, stable trigger
  markup, and viewport-bounded popover width;
- `app/globals.css` — MP5-only country-picker grid, truncation, ISO visibility, and numeric-alignment
  rules using logical direction properties.

Tests/documentation:

- `tests/unit/components/mp5-phone-code-alignment.test.tsx` (new);
- `tests/e2e/login.spec.ts` — one 320 px light-surface MP5 test;
- `tests/e2e/smoke.spec.ts` — MP5 assertions added to the existing dark operator invitation flow;
- `docs/reviews/POST_PRE_P2_MP5_REVIEW.md` (new).

Explicitly unchanged by MP5:

- `components/shared/searchable-combobox.tsx` and every currency/report combobox consumer;
- `lib/phone/registry.ts`, its worldwide `libphonenumber-js` registry, priority ordering, search
  projection, `normalizePhone`, formatting, and inference behavior;
- the `phoneCountryAutoFollows` state, controlled-value resynchronization, hidden `name` /
  `nameCountry` FormData contract, server normalization, and database persistence path;
- `tests/e2e/p1c-signup.spec.ts` — the final diff is empty; no unrelated Playwright coupling or
  synchronization change was retained;
- `supabase/`, `types/database.ts`, `actions/theme.ts`, middleware, authentication, billing, and all
  MP0–MP4 implementation/review files.

### 3. Implementation and acceptance audit

- Each option's rendered child is one `.phone-cc-grid` with exactly four ordered cells: flag,
  country name, ISO code, and dial code. The grid uses
  `1.5rem minmax(0, 1fr) 2.75rem 5rem` at 320 px and above.
- The fixed flag cell absorbs platform-dependent emoji advance widths. Flags are decorative and
  remain `aria-hidden`.
- The name column has `min-width: 0`, ellipsis overflow, and no wrapping. The actual option name is
  not shortened, so assistive technology still receives the full country name.
- The ISO cell is uppercase, centered, monospaced, and muted. Below 320 px it is visually clipped
  first so the name and dial code retain usable space, but it stays in the accessibility tree. At
  the required 320 px acceptance width it is visible as the fourth-column layout.
- The dial cell is a fixed 5 rem column with `text-align: end` and `tabular-nums`. This covers short
  and multi-digit values such as `+1`, `+44`, `+246`, and `+965` without ragged row endings.
- The trigger remains 132 px wide. Its internal two-column grid fixes the flag cell and lets the
  calling code truncate safely without resizing the control; its numerals are tabular.
- The popover width is bounded by both 280 px and the viewport minus 2 rem. Production Chromium
  measured the popover fully inside a 320 px viewport with no document-level horizontal overflow.
- The focused unit test derives the longest country name from the real `PHONE_COUNTRIES` registry,
  rather than maintaining a shortened test fixture. Production Chromium additionally exercises
  "British Indian Ocean Territory" with `IO` / `+246`.
- The option's computed accessible name contains the complete country name, ISO code, and calling
  code. The visual flag does not add emoji noise to the name.
- Search remains the existing `name|code|dialCode` projection. The tests filter with "united",
  select the United Kingdom through ArrowDown + Enter, close with Escape, retain hidden country
  `GB`, emit `+442079460000`, and persist that E.164 value through the existing operator flow.
- The existing unmodified `searchable-combobox`, `p15d-phone`, `p15d-formdata-phone`, and
  `clinic-signup-phone-country` suites prove shared cmdk behavior, server enforcement, hidden-input
  submission, and signup country auto-follow remain intact.

### 4. Responsive, theme, accessibility, and performance audit

- **320 px light surface:** four computed grid columns, ISO visible, long-name ellipsis, dial column
  end-aligned with tabular numerals, popover width ≤280 px, and no horizontal overflow.
- **Dark operator surface:** Kuwait's `KW` / `+965` option remains legible and accessible; searching
  and selecting the United Kingdom by keyboard still saves and re-reads the E.164 number.
- No color override was added. All MP5 text continues to use the existing foreground and muted
  tokens, so the same structure inherits the already-reviewed light and dark themes.
- No physical-direction utility or CSS property was introduced. Numeric alignment uses logical
  `text-align: end`.
- No dependency, module, dynamic import, network request, asset, or new client behavior was added.
  The production client-manifest chunk graphs are unchanged. Exact route payload comparison:

| Route | Baseline | MP5 | Delta |
|---|---:|---:|---:|
| `/operator/invitations` | 12 chunks; 459,647 raw / 132,878 gzip bytes | 12 chunks; 459,592 raw / 132,860 gzip bytes | −55 raw / −18 gzip bytes |
| `/signup` | 10 chunks; 394,683 raw / 112,722 gzip bytes | 10 chunks; 394,628 raw / 112,715 gzip bytes | −55 raw / −7 gzip bytes |

The MP5 no-first-load-JavaScript-increase budget therefore passes; the small negative byte deltas
come from replacing longer utility-class strings with the minimal fixed-grid markup.

### 5. Validation commands and exact results

| Command | Result |
|---|---|
| `pnpm exec vitest run tests/unit/components/mp5-phone-code-alignment.test.tsx tests/unit/components/searchable-combobox.test.tsx tests/unit/components/p15d-formdata-phone.test.tsx tests/unit/components/clinic-signup-phone-country.test.tsx tests/unit/lib/p15d-phone.test.ts` | **PASS** — 5 files, 22 tests |
| `pnpm test` | **PASS** — 102 files, 522 tests |
| `pnpm typecheck` | **PASS** — exit 0; no diagnostics |
| `pnpm lint` | **PASS WITH WARNINGS** — 0 errors; the same 4 pre-existing warnings recorded by MP1–MP4 |
| `pnpm build` | **PASS** — optimized Next.js 16.2.6 production build; 52 static pages generated; only the existing middleware-file deprecation warning |
| `PORT=3146 … test tests/e2e/p1c-signup.spec.ts --project=chromium --workers=1` | **PASS** — complete dependent file in order, 2/2 |
| `PORT=3145 … test --project=chromium --workers=1` | **PASS** — final production-build serial suite, **27/27** in 1.3 min |
| Production client-manifest raw/gzip comparison | **PASS** — unchanged chunk graphs and no route-payload increase; exact values in §4 |
| `git status --short supabase/ types/database.ts` | **PASS** — empty |
| Added-line physical-direction utility grep over MP5 files | **PASS** — zero matches |
| P2 grep (`next-intl`, `dir="rtl"`, `thmanyah`) over `app` / `components` / `tests` | **PASS** — zero matches |
| `git diff --check` | **PASS** — no whitespace errors |
| `git diff --cached --stat` | **PASS** — empty staging area |

Browser-run note: an isolated run of only the expired-subscription test was discarded because it
skips the preceding test that initializes its module-scoped `clinicId`. One earlier complete-file
run then encountered the pre-existing lazy-dialog mount race; no unrelated test edit was retained.
The subsequent complete file passed 2/2 unchanged, and the one requested final full serial suite
also passed both tests and all 27 cases. The in-app browser capability exposed no runnable browser
backend in this environment, so responsive and theme verification used the repository's real
production Playwright harness.

The repository does not expose a Prettier executable, so an optional `pnpm exec prettier --check`
attempt reported `Command "prettier" not found`; the repository's required lint and whitespace
gates both pass.

### 6. Security and scope review

- MP5 is presentation-only. It adds no query, mutation, RPC, route, server action, validation rule,
  environment variable, log line, or public configuration value.
- Server-side phone enforcement remains `normalizePhone`; the hidden E.164 and country inputs retain
  their original names and submission semantics.
- No RLS policy, middleware, migration, database type, monetary column, entitlement, billing, PHI,
  or PII handling changed.
- No P2 language, locale, RTL, font, switcher, or per-user-preference implementation was introduced.
- The shared combobox primitive was deliberately not changed, preventing currency and
  operator-report consumers from inheriting phone-specific layout behavior.

### 7. Stable findings

- **POSTPREP2-MP5-R1 — RESOLVED:** flag emoji widths and a free-flowing flex row produced ragged
  country options; every option now uses one fixed four-column grid.
- **POSTPREP2-MP5-R2 — RESOLVED:** options lacked an ISO column and their dial codes were only
  edge-flushed; ISO codes are now explicit and dial codes occupy one fixed, end-aligned, tabular
  5 rem column.
- **POSTPREP2-MP5-R3 — RESOLVED:** the fixed 280 px popover could overflow the narrowest viewport;
  it is now viewport-bounded and production-tested at 320 px with zero page overflow.
- **POSTPREP2-MP5-R4 — RESOLVED:** accessibility could regress if the decorative flag or responsive
  ISO treatment obscured option identity; flags are hidden and full name / ISO / dial information
  remains in the computed accessible name.
- **POSTPREP2-MP5-R5 — RESOLVED:** worldwide registry coverage, search, Arrow/Enter/Escape behavior,
  country auto-follow, hidden inputs, E.164 emission, server normalization, and persisted `+44`
  behavior are unchanged and covered by focused, full-unit, and production-browser suites.
- **POSTPREP2-MP5-R6 — RESOLVED:** the dashboard-route JavaScript budget is met with unchanged chunk
  graphs and slightly smaller exact raw/gzip totals on both measured phone-input routes.

### 8. Optional polish findings

None. MP6 and MP7 remain intentionally unstarted.

### 9. Git state and scope audit

- Branch observed: `fix/post-pre-p2-manual-polish`.
- The dirty working tree already contained preserved MP0–MP4, planning, test, review, and generated
  screenshot changes before MP5 began; none were reset, restored, overwritten, staged, or
  discarded.
- The staging area remains empty.
- MP5 added/edited only the files listed in §2. The temporary readiness-wait experiment in
  `tests/e2e/p1c-signup.spec.ts` was removed with `apply_patch`; its final diff is empty.
- No commit, push, merge, branch creation, stage, reset, restore, checkout, clean, or stash action
  occurred.

### 10. Final verdict

**IMPLEMENTED — awaiting comprehensive review**

MP5 is complete. Country options now render as a stable flag / name / ISO / dial-code grid with a
fixed tabular numeric column, a fixed trigger, accessible complete option names, and a popover that
fits a 320 px viewport in both theme contexts. Registry coverage, search, keyboard behavior,
country auto-follow, hidden inputs, E.164 enforcement, and persistence remain unchanged and green.
MP6 and MP7 remain unstarted.

## Re-review history

- **Review Cycle 1 — 2026-07-14:** initial MP5 implementation audit. Six required findings
  resolved; no optional MP5 polish finding remains open. Status is implemented and awaiting
  comprehensive review.
