# Post-Pre-P2 MP1 Review — Theme Scoping

**Status:** IMPLEMENTED — awaiting comprehensive review
**Workstream:** MP1 (`docs/POST_PRE_P2_MANUAL_POLISH.md` §9-MP1)
**Review cycle:** 1
**Review date:** 2026-07-14
**Final verdict:** **IMPLEMENTED — AWAITING COMPREHENSIVE REVIEW**

This is the authoritative MP1 implementation-review record. Later reviews must preserve Review
Cycle 1, retain stable finding IDs, and append history rather than replace it.

## Review Cycle 1

### 1. Implementation scope

Implemented only the approved theme-scope architecture:

- `.light` re-declares the complete light token set and sets `color-scheme: light`;
- `.dark` sets `color-scheme: dark`;
- Tailwind's dark variant no longer applies inside an explicitly light subtree;
- marketing and legal roots, including the portaled early-access dialog, are forced Light;
- login, forgot-password, reset-password, change-password, open signup, invitation signup,
  signup completion, and the auth-confirm callback are forced Dark;
- portaled Sonner toasts inherit the active forced surface through pure CSS;
- dashboard layouts continue reading the existing device cookie and continue using the existing
  toggle/action unchanged;
- marketing section tones are centralized in one exported map, use four section tones, and keep
  only the security and footer bands as deep-teal inverse anchors.

No MP2 typography/motion work, MP3–MP7 work, P2 localization/persistence work, migration,
database-schema change, RLS change, middleware change, or authentication behavior change is
included.

### 2. Exact files changed

Product code:

- `app/globals.css`
- `app/(auth)/layout.tsx`
- `app/(public)/layout.tsx`
- `app/(public)/signup/layout.tsx` (new)
- `app/auth/layout.tsx` (new)
- `components/marketing/early-access-dialog.tsx`
- `components/marketing/legal-page.tsx`
- `components/marketing/marketing-page.tsx`
- `components/marketing/product-screenshot.tsx`

Tests/documentation:

- `tests/unit/components/mp1-theme-scoping.test.tsx` (new)
- `tests/e2e/login.spec.ts`
- `tests/e2e/smoke.spec.ts`
- `docs/reviews/POST_PRE_P2_MP1_REVIEW.md` (new)

Explicitly unchanged by MP1:

- `actions/theme.ts`
- `components/layout/theme-toggle.tsx`
- `app/(protected)/layout.tsx`
- `app/(operator)/layout.tsx`
- `app/layout.tsx`
- `supabase/`
- `types/database.ts`

### 3. Acceptance-criteria checklist

- [x] One reusable `.light` / `.dark` scope mechanism governs forced surfaces
- [x] Dark variants are excluded from explicit light subtrees
- [x] Landing page stays Light when the root cookie makes `<html>` dark
- [x] Privacy and Terms pages stay Light in a dark session
- [x] Marketing-owned rendered classes contain no `dark:` utilities
- [x] The `.dark .marketing-page` palette override is removed
- [x] Portaled early-access dialog and Sonner toaster follow the forced surface
- [x] Login, forgot-password, reset-password, and change-password are always Dark
- [x] Open signup, invitation signup, signup completion, and auth confirmation are always Dark
- [x] Forced surfaces set the native `color-scheme` correctly
- [x] Dashboard cookie read, toggle, immediate document-class update, refresh, and persistence are
      unchanged
- [x] Separate authenticated browser contexts retain independent cookie themes
- [x] No clinic-wide theme storage exists or was introduced
- [x] Marketing section tones are centralized and limited to four section backgrounds
- [x] CSS source gzip delta is negligible: 4,938 → 5,053 bytes (**+115 bytes**)
- [x] No JavaScript was added for theme scoping
- [x] No new physical-direction class was added
- [x] No migration, schema, RLS, P2 persistence model, or `user_ui_preferences` implementation was
      introduced
- [x] Unit suite, typecheck, lint, production build, targeted Playwright, full serial Playwright,
      schema gate, direction gate, and `git diff --check` pass

### 4. Validation commands and exact results

| Command | Result |
|---|---|
| `pnpm exec vitest run tests/unit/components/mp1-theme-scoping.test.tsx tests/unit/components/p15c-marketing-page.test.tsx tests/unit/actions/theme.test.ts` | **PASS** — 3 files, 11 tests |
| `pnpm test` | **PASS** — 98 files, 513 tests (20.01s) |
| `pnpm typecheck` | **PASS** — exit 0; no diagnostics |
| `pnpm lint` | **PASS WITH WARNINGS** — 0 errors; 4 pre-existing warnings |
| `PORT=3106 node --env-file=.env.local node_modules/@playwright/test/cli.js test tests/e2e/login.spec.ts --workers=1` | **PASS** — production build; Chromium 8/8 (20.4s) |
| `PORT=3107 node --env-file=.env.local node_modules/@playwright/test/cli.js test tests/e2e/smoke.spec.ts --workers=1 --grep "theme cookies stay isolated"` | **PASS** — production build; Chromium 1/1 (23.1s) |
| `PORT=3108 node --env-file=.env.local node_modules/@playwright/test/cli.js test --workers=1` | **PASS** — production build; Chromium 24/24 (1.2m) |
| `git status --short supabase/ types/database.ts actions/theme.ts components/layout/theme-toggle.tsx 'app/(protected)/layout.tsx' 'app/(operator)/layout.tsx'` | **PASS** — empty |
| Added-line physical-direction grep over MP1 files | **PASS** — zero matches |
| `rg -n 'dark:' components/marketing` | **PASS** — zero matches |
| `git diff --check` | **PASS** — no whitespace errors |
| Source CSS gzip comparison (`HEAD:app/globals.css` → worktree) | **PASS** — 4,938 → 5,053 bytes; +115 bytes, below the +2 KB budget |

The first Playwright attempt omitted `.env.local` loading and stopped at config validation; the
second sandboxed attempt reached the known `tsx` IPC `EPERM`. The recorded browser results above
are the successful approved local-server/Chromium runs. Production builds emitted the pre-existing
Next.js `middleware` deprecation warning. Authenticated flows emitted the already-documented
`last_login_update_failed` `42501` warnings; neither warning affected test results.

No MP1 integration suite is required: MP1 changes no query, database object, persistence model, or
server-side theme action.

### 5. Security and permission review

- The root cookie, authenticated theme action, and authorization check are unchanged.
- No theme value is stored on `clinics`, `profiles`, or any new table.
- No migration, RLS policy, RPC, service-role path, middleware gate, signup semantic, invitation
  semantic, recovery semantic, or auth redirect changed.
- Marketing's public registration-status RPC and early-access mutation boundary are unchanged.
- No PHI field, log statement, public environment variable, dependency, or network boundary was
  added.

### 6. Required findings

All required MP1 findings discovered during implementation are resolved:

- **POSTPREP2-MP1-R1 — RESOLVED:** the root `dark` class leaked into marketing and legal pages;
  explicit light roots and the light-excluding dark variant now keep both surfaces Light.
- **POSTPREP2-MP1-R2 — RESOLVED:** auth form tokens inherited a light dashboard cookie; the shared
  auth layout now owns a forced-dark scope.
- **POSTPREP2-MP1-R3 — RESOLVED:** signup and auth-confirm routes live outside `(auth)` and would
  otherwise miss its scope; route-local layouts now force those authentication families Dark.
- **POSTPREP2-MP1-R4 — RESOLVED:** portaled dialog/toast UI does not naturally inherit route-subtree
  variables; the dialog carries the light scope and pure CSS mirrors forced-surface tokens onto the
  root toaster.
- **POSTPREP2-MP1-R5 — RESOLVED:** marketing dark utilities and the dark marketing palette created a
  second theme mechanism; they are removed, and section tone rhythm is centralized in
  `MARKETING_SECTION_TONES`.

### 7. Optional polish findings

None. MP2 typography and motion, MP3 logo treatment, MP4 login-logo navigation, and all later
manual-polish workstreams remain intentionally unstarted.

### 8. Known limitations

- Theme persistence is still one device cookie, exactly as approved for this sprint. On a shared
  browser, the next signed-in user inherits the previous cookie, and a user's selection does not
  follow them to another device.
- This is a known, accepted, time-boxed limitation. P2A closes it by implementing the approved
  auth-user-keyed `user_ui_preferences` model in one complete persistence change.
- What MP1 guarantees today is no clinic-wide theme and no contamination between separate browser
  contexts/devices. The production E2E test verifies two users in the same clinic in separate
  contexts.
- The full E2E validation regenerated seven tracked PRE-P2 WS5 screenshot artifacts. They are test
  outputs, not MP1 product changes; no reset, restore, checkout, clean, or other prohibited Git
  operation was used to remove them.

### 9. Git state

- Current branch remains `main`.
- The dirty working tree already contained preserved MP0/manual-plan work before MP1 began.
- MP1 added only the files listed in §2; the full E2E run also regenerated the seven tracked WS5
  screenshot artifacts disclosed in §8.
- The staging area is empty.
- No commit, push, merge, branch creation, stage, reset, restore, checkout, clean, stash, or
  destructive Git action occurred.

### 10. Final verdict

**IMPLEMENTED — AWAITING COMPREHENSIVE REVIEW**

MP1's code and required validation are complete. The landing/legal surfaces are always Light,
every authentication route family is always Dark, dashboard theme behavior remains on the
documented unchanged cookie architecture, and no P2 persistence or schema work was started.

Stop here. MP2 and later workstreams are not started.

## Re-review history

- **Review Cycle 1 — 2026-07-14:** initial MP1 implementation record. Five required findings
  resolved; no optional MP1 polish finding remains open. Status is implemented and awaiting
  comprehensive review.
