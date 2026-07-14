# Post-Pre-P2 MP4 Review — Login Navigation

**Status:** IMPLEMENTED — awaiting comprehensive review
**Workstream:** MP4 (`docs/POST_PRE_P2_MANUAL_POLISH.md` §9-MP4)
**Review cycle:** 1
**Review date:** 2026-07-14
**Final verdict:** **IMPLEMENTED — awaiting comprehensive review**

This is the authoritative MP4 implementation-review record. Later reviews must preserve Review
Cycle 1, retain stable finding IDs, and append history rather than replace it.

## Review Cycle 1

### 1. Implementation scope

Implemented MP4 only:

- repointed the **desktop** brand lockup in the authentication layout from `/login` to `/`;
- repointed the **mobile** brand lockup in the same layout from `/login` to `/`;
- preserved each lockup as **one semantic link** (mark + "ClinicFlow" wordmark inside a single
  focusable `<Link>`, no nested interactive element) with the accessible name **"ClinicFlow home"**;
- added focused unit and production-browser regression coverage proving both lockups navigate to
  the marketing landing page and that no authentication-layout link still targets `/login`.

No MP5 phone-column work, MP6 operator-header work, MP7 sidebar work, P2 functionality, language
control, preference persistence, migration, schema, RLS, middleware, route, server-action,
validation, or rate-limiting change is included. MP0–MP3 were not redone or overwritten.

### 2. Exact files changed

Product code:

- `app/(auth)/layout.tsx` — two `href` values only (`/login` → `/`).

Tests/documentation:

- `tests/unit/components/mp4-auth-logo-navigation.test.tsx` (new)
- `tests/e2e/login.spec.ts` (one added MP4 test; every pre-existing MP1/MP2/MP3 test preserved
  unmodified)
- `docs/reviews/POST_PRE_P2_MP4_REVIEW.md` (new)

Explicitly unchanged by MP4:

- the auth layout's forced-dark scope, brand panel, hero copy, feature list, auth card, and
  mobile/desktop structure (only the two `href` attributes changed);
- every auth route and its page: `/login`, `/forgot-password`, `/reset-password`,
  `/change-password`, `app/auth/confirm`, `/signup/[token]`, open signup, and the early-access flow;
- every auth server action, validation schema, redirect, gate, and rate limit;
- `middleware.ts`, `lib/supabase/middleware.ts`, `supabase/`, `types/database.ts`;
- the marketing site, sidebar, dashboard shell, and phone input;
- the MP0, MP1, MP2, and MP3 implementation/review records.

### 3. Implementation and acceptance audit

- Both lockups now render `href="/"`. The complete product diff for this workstream is the two
  `href` lines; the MP1 forced-dark wrapper line already present in the working tree is untouched.
- Each lockup is a single `<Link>` containing the mark `<Image>` plus the wordmark text — one
  focusable element, not two. The unit suite asserts zero nested `a`, `button`, or positively
  tab-indexed descendant inside either lockup.
- The accessible name stays `aria-label="ClinicFlow home"` on both lockups, so the wordmark and
  the eyebrow text do not fragment the name, and the desktop mark keeps `alt=""` (decorative
  beside the visible wordmark).
- **Recovery handoff verified safe.** `app/page.tsx` still redirects `code` / `token_hash` /
  `type` / `error` / `error_description` params to `/auth/confirm`, and `/` is anonymous-reachable
  (asserted by the existing e2e). Sending a logged-out visitor from `/login` to `/` therefore
  cannot strand a magic-link, password-reset, or invitation handoff; the password-reset,
  forced-password, invited-signup, and open-signup e2e paths all pass unmodified.
- The link is `next/link`, so keyboard activation (Enter) and middle/modifier-click behavior are
  native; no key handler was hand-rolled.
- Focus remains visible: neither lockup suppresses the global `outline-ring/50` focus treatment,
  and no focus style was added or removed.
- The mobile lockup is the visible one below `lg`, the desktop lockup above it. The production
  e2e clicks whichever lockup is actually visible at 1440 × 900 and at 390 × 844 and lands on `/`
  in both cases.

### 4. Validation commands and exact results

| Command | Result |
|---|---|
| `pnpm exec vitest run tests/unit/components/mp4-auth-logo-navigation.test.tsx` | **PASS** — 1 file, 2 tests |
| `pnpm test` | **PASS** — 101 files, 520 tests |
| `pnpm typecheck` | **PASS** — exit 0; no diagnostics |
| `pnpm lint` | **PASS WITH WARNINGS** — 0 errors; the same 4 pre-existing warnings recorded by MP1–MP3 |
| `PORT=3130 node --env-file=.env.local node_modules/@playwright/test/cli.js test --project=chromium --workers=1` | **PASS** — production build; full serial suite **26/26** in 1.2 min (login, signup, and smoke specs all green) |
| `PORT=3130 … test tests/e2e/login.spec.ts --project=chromium --workers=1` | **PASS** — 10/10, including the new "the login brand lockup opens the marketing landing page" at 1440 px and 390 px |
| `git status --short supabase/ types/database.ts` | **PASS** — empty |
| Added-line physical-direction utility grep over MP4 files | **PASS** — zero matches |
| `git diff --check` | **PASS** — no whitespace errors |
| P2 grep (`next-intl`, `dir="rtl"`, `thmanyah`) over `app`/`components`/`tests` | **PASS** — zero matches |

The first unit run asserted the mark via `getByRole("img")`; the desktop mark is intentionally
decorative (`alt=""`, role `presentation`), so the assertion was corrected to inspect the `<img>`
element directly. The final result above is green. No integration suite is required: MP4 changes
no query, mutation, database object, or server boundary.

MP4 adds no JavaScript behavior, dependency, asset, network request, font, or CSS payload — two
`href` attribute values changed — so the MP2 three-run Lighthouse record remains the applicable
marketing performance gate and was not overwritten.

### 5. Security and scope review

- Authentication semantics are byte-for-byte preserved: no route, server action, validation
  schema, session handling, redirect, gate order, or rate limit was touched. A link `href` is not
  an authentication boundary.
- No RLS policy, middleware, migration, schema type, monetary column, entitlement, or billing
  change. No PHI/PII enters any new code path; no new log line, environment variable, or
  `NEXT_PUBLIC_` value was added.
- The destination `/` is already a public, anonymous-reachable marketing route with its existing
  recovery-param handoff; MP4 exposes nothing new.
- No P2 functionality, language control, or `user_ui_preferences` implementation was introduced.

### 6. Stable findings

- **POSTPREP2-MP4-R1 — RESOLVED:** the desktop authentication brand lockup linked to `/login`
  (a self-link from the login page itself); it now links to `/`.
- **POSTPREP2-MP4-R2 — RESOLVED:** the mobile authentication brand lockup carried the same
  `/login` self-link; it now links to `/`.
- **POSTPREP2-MP4-R3 — RESOLVED:** both lockups are verified as a single semantic link with the
  "ClinicFlow home" accessible name, no nested interactive element, and native keyboard
  activation — asserted in unit tests and in production Chromium at desktop and mobile widths.
- **POSTPREP2-MP4-R4 — RESOLVED:** every auth flow (login, forgot-password, reset-password,
  change-password, magic-link/recovery via `app/page.tsx` → `/auth/confirm`, invited signup, open
  signup, invitation acceptance) is unchanged and green in the full serial production e2e run.

### 7. Optional polish findings

None. MP5, MP6, and MP7 remain intentionally unstarted.

### 8. Git state and scope audit

- Branch observed: `fix/post-pre-p2-manual-polish`.
- The dirty working tree already contained preserved MP0–MP3, planning, test, review, and
  generated screenshot changes before MP4 began; none were reset, restored, overwritten, staged,
  or discarded.
- The staging area remains empty.
- MP4 added/edited only the files listed in §2.
- No commit, push, merge, branch creation, stage, reset, restore, checkout, clean, or stash action
  occurred.

### 9. Final verdict

**IMPLEMENTED — awaiting comprehensive review**

MP4 is complete. The ClinicFlow mark-plus-wordmark lockup on every authentication screen — desktop
and mobile — is one semantic link to the marketing landing page with the "ClinicFlow home"
accessible name, and every authentication flow is unchanged and green. MP5, MP6, and MP7 remain
unstarted.

## Re-review history

- **Review Cycle 1 — 2026-07-14:** initial MP4 implementation audit. Four required findings
  resolved; no optional MP4 polish finding remains open. Status is implemented and awaiting
  comprehensive review.
