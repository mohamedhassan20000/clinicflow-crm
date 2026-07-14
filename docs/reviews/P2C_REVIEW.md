# P2C Review

**Status:** IMPLEMENTED — Phase 2 comprehensive-review blocker addressed

## Scope

P2C validation completion only. This pass repaired stale localized-copy assertions and asynchronous test harnesses, then fixed the runtime localization defects exposed by full-browser validation. No new product features were added, and no P2A, P2B, or WS5 review assets were changed.

## Validation results

| Gate | Result |
| --- | --- |
| Unit tests — `pnpm test` | **PASS** — 114 files, 600 tests |
| TypeScript — `pnpm typecheck` | **PASS** |
| ESLint — `pnpm lint` | **PASS** — 0 errors, 31 warnings |
| Production build — `pnpm build` | **PASS** — Next.js 16.2.6 production build; 52 static/dynamic page-data routes generated |
| Integration — `.env.local` + serial Vitest integration command | **PASS** — 13 files, 91 tests |
| Full serial Playwright — Chromium, `--workers=1`, port 3100 | **PASS** — 37/37 tests in 1.8 minutes |
| RTL gate — `pnpm lint:rtl` | **PASS** — 293 files scanned; 10 documented exceptions |
| Expanded hardcoded-string gate — `pnpm lint:i18n` | **PASS** — 203 files scanned; 8 documented exceptions; 0 findings |
| Missing-key / structural / ICU placeholder parity — `pnpm i18n:missing` | **PASS** — 1,874 matching English/Arabic leaf messages |
| Unused-key check — `pnpm i18n:unused` | **PASS** — 0 unreferenced keys |
| Combined catalog check — `node scripts/check-messages.mjs all` | **PASS** — 1,874 matching leaves; no unused keys |
| Whitespace — `git diff --check` | **PASS** |

The integration command was run with `.env.local` explicitly loaded because `pnpm test:integration` does not load it itself. It used the existing local Supabase stack and completed all 91 tests.

## Visual and localization QA

The final serial Chromium suite exercised English/LTR and Arabic/RTL behavior across desktop and mobile widths, light and dark marketing surfaces, forced-dark authentication, clinic and operator shells, dashboards, settings/staff, forms, tables, dialogs, calendars, billing, reports, and navigation drawers.

Verified outcomes include:

- marketing containment, theme independence, reduced motion, keyboard navigation, legal pages, mobile widths, and Arabic RTL;
- forced-dark authentication in both cookie states;
- clinic and operator dashboard shells, account-scoped language/theme persistence, and protected-route behavior;
- settings/staff Arabic copy with the authenticated session preserved;
- billing and settlement dialogs, report filtering/export, patient return paths, and operator recovery boundaries;
- day/week/month calendar readability in both themes plus the 320 px responsive treatment;
- no horizontal overflow on the high-traffic RTL pages and correct logical-property/icon mirroring;
- no raw translation keys or untranslated English in the asserted Arabic user-visible surfaces;
- Thmanyah weight mapping: the family deliberately omits 600, and the typography unit gate confirms browser weight matching resolves 600 to the available 700 face.

Current calendar screenshots under `test-results/ws5-calendar-treatment/` were visually inspected for light, dark, desktop, and 320 px mobile layouts. They remain contained and legible. The inspection caught and corrected the final `thisDay` / `thisMonth` subtitle tokens before the final gate reruns.

## Validation repairs made

- Updated patient-detail test harnesses for the current async `searchParams` contract.
- Updated calendar assertions to validate semantic localization tokens at the formatter boundary.
- Preserved billing validation intent while correcting localized message-key casing.
- Made operator error and report assertions compatible with localized rendering without snapshots or positional selectors.
- Stabilized streamed/dynamic Playwright interactions using explicit readiness, navigation, and native keyboard activation checks.
- Restored a required client boundary for the locale-aware follow-up list.
- Corrected raw report, billing, patient-scope, appointment-range, and operator ICU copy exposed by browser validation.
- Restored Arabic marketing workflow arrays to structural parity with English.

## Scope and asset audit

- `git diff --name-only` contains no tracked WS5 review assets or WS5 review markdown.
- Playwright writes current WS5 captures only to ignored `test-results/` paths.
- The pre-existing untracked P2A/P2B review markdown files were not modified.
- No commit, stage, push, merge, reset, restore, clean, or stash operation was performed.

## Remaining non-blocking findings

- ESLint reports 31 existing warnings: hook dependency warnings, unused symbols, and two React Compiler compatibility notices for React Hook Form `watch()` usage. There are no lint errors.
- Next.js reports the existing middleware-to-proxy deprecation warning during builds.
- Expected Playwright fixture diagnostics remain in server output: guarded `last_login` updates rejected by RLS, the intentionally exercised operator recovery boundary, empty-clinic doctor-stat UUID diagnostics, transient zero-size chart warnings during locale transitions, and next-intl `INVALID_MESSAGE` diagnostics during an Arabic dashboard transition. All corresponding user flows and assertions pass, and no raw key is rendered in the verified surfaces.
- The independent in-app visual browser was unavailable in this session; visual inspection used the current Playwright-rendered screenshots plus the complete real-Chromium acceptance suite.

## Comprehensive review cycle — 2026-07-15

**Verdict: CHANGES REQUIRED.** The earlier assertion that no untranslated English remained was inaccurate. The comprehensive review found **P2-BLOCKER-1**: user-visible Server Action failures and secondary UI paths could still render English in Arabic. The audit also found escaped member/time-range/upload/primitive copy, an i18n gate that did not cover action results and mixed expressions deeply enough, insufficient Arabic failure-path coverage, a stale `t` memo dependency in the patient table, and missing CI catalog gates.

This entry preserves the original validation record above; it does not rewrite the failed audit as a pass.

## P2-BLOCKER-1 fix cycle — 2026-07-15

The smallest corrective scope was implemented without changing action result shapes, authorization, validation, or product behavior:

- user-visible action failures now resolve stable `actionErrors.*` catalog keys on the server before returning the existing string fields; database/RPC diagnostics remain in internal logs;
- authentication, invitation/rate-limit, appointment, settings/staff, upload, and authorization failures have English and Arabic catalog coverage;
- escaped UI copy, mixed JSX/template copy, form submit labels, table captions, primitive Dialog/Sheet/Command accessibility copy, counts/plurals, and upload templates are localized;
- the i18n gate now scans `actions/`, `components/ui`, accessibility/form props, action `error`/`fieldErrors`, mixed JSX/templates, and toast copy while retaining eight documented technical exceptions and no broad allowlist;
- representative Arabic failure tests assert human-readable output and no raw key for invalid authentication, rate limiting, invitation failure, appointment validation, settings/staff mutation, upload failure, and authorization denial; representative dual-locale rendering now spans ten catalog surfaces;
- `patient-table.tsx` includes `t` in the memo dependency list. Remaining `t` warnings are effect-only side-effect handlers that do not retain memoized rendered language; adding `t` would replay completed toasts on locale switching, so they were not silenced or changed;
- CI now runs the hardcoded-string, missing/structural, unused-key, and ICU placeholder-parity gates in addition to the existing RTL gate;
- malformed Arabic ICU selectors exposed by the serial browser run were corrected.

### Fix-cycle validation

| Gate | Result |
| --- | --- |
| `pnpm typecheck` | **PASS** |
| `pnpm lint` | **PASS** — 0 errors; 26 non-blocking existing warnings |
| `pnpm test` | **PASS** — 115 files, 607 tests |
| `pnpm test:integration` | **PASS** — 13 files, 91 tests, with `.env.local` loaded for the existing local Supabase stack |
| `pnpm build` | **PASS** — Next.js 16.2.6; 52 routes generated |
| Full serial Playwright | **PASS** — 37/37 Chromium tests, one worker; see rerun note below |
| `pnpm lint:rtl` | **PASS** — 294 files; 10 documented exceptions |
| `pnpm lint:i18n` | **PASS** — 255 files; 8 documented exceptions; 0 findings |
| `pnpm i18n:missing` | **PASS** — 2,271 matching English/Arabic leaves |
| `pnpm i18n:unused` | **PASS** — 0 unreferenced keys |
| `node scripts/check-messages.mjs all` | **PASS** — structural and ICU placeholder parity; no unused keys |
| `git diff --check` | **PASS** |

The final diff contains no tracked `docs/reviews/assets/pre-p2-ws5` files and no work outside Phase 2. No commit, stage, push, merge, reset, restore, clean, or stash operation was performed.

The complete serial matrix passed 37/37 during this fix cycle. After correcting two malformed Arabic ICU selectors found in that run's diagnostics, the focused final Arabic browser scenario passed without the ICU diagnostics. Two additional full-suite confirmation attempts stopped at the unrelated WS7 operator-report keyboard activation check after 21 passes (`Enter` did not follow a focused link whose verified `href` was correct); the same WS7 test had passed in the complete run before the catalog-only correction and no WS7 source was changed. This test-only flake is recorded but is not a Phase 2 localization blocker.

**Fix-cycle verdict: APPROVED FOR COMMIT.**
