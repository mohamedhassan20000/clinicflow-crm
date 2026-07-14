# Post-Pre-P2 MP7 Review — Sidebar Brand Collapse Control & Divider Baseline

**Status:** IMPLEMENTED — awaiting comprehensive review
**Workstream:** MP7 (`docs/POST_PRE_P2_MANUAL_POLISH.md` §9-MP7)
**Review cycle:** 1
**Review date:** 2026-07-14
**Final verdict:** **IMPLEMENTED — awaiting comprehensive review**

This is the authoritative MP7 implementation-review record. Later reviews must preserve Review
Cycle 1, retain stable finding IDs, and append history rather than replace it.

## Review Cycle 1

### 1. Implementation scope

Implemented MP7 only:

- removed the dedicated, overhanging sidebar chevron button;
- made the complete desktop/tablet brand row the one collapse/expand control;
- retained the existing logo, wordmark, persisted collapse state, `w-72` / `w-20` widths, and
  200 ms width transition;
- added explicit action-and-state accessibility (`Collapse navigation` / `Expand navigation`),
  `aria-expanded`, `aria-controls`, a matching `title`, native Enter/Space behavior, and a fully
  inset focus-visible outline;
- moved the existing chevron affordance inside the brand row, visible on hover/focus without
  displacing the centred mark in collapsed mode;
- kept the mobile-sheet brand row non-interactive and left the mobile-header lockup unchanged;
- introduced one `--shell-header-h: 4rem` shell token consumed by both the brand row and content
  header, and gave both dividers the same `border-border` token so they share one visual baseline;
- added focused unit coverage, reviewed expanded/collapsed snapshots, and extended the real
  production-browser shell test across keyboard, navigation safety, themes, responsive modes,
  transition time, and fractional zoom.

No MP0–MP6 behavior was redone or changed. No P2 work, migration, schema, RLS, middleware, route,
server action, theme-persistence change, or language control is included.

### 2. Exact files changed

Product code:

- `components/layout/sidebar.tsx` — removes the dedicated toggle; renders the desktop brand as the
  full-row button; adds the controlled nav IDs, state/action labels, title, inline chevron
  affordance, and inert sheet-brand branch; consumes the shared height and divider tokens;
- `components/layout/dashboard-shell.tsx` — replaces the header's independent `h-16` utility with
  the shared shell-height token; no utility, menu, route, or mobile-brand behavior changed;
- `app/globals.css` — adds the single `--shell-header-h: 4rem` structural token.

Tests/documentation:

- `tests/unit/components/mp7-sidebar-brand-control.test.tsx` (new) — native Enter/Space behavior,
  accessible state/control relationship, single-control/no-link contract, and inert sheet brand;
- `tests/unit/components/dashboard-shell.test.tsx` — asserts the expanded and collapsed brand-button
  contract while retaining persistence and legacy-key migration coverage;
- `tests/unit/components/__snapshots__/dashboard-shell.test.tsx.snap` — deliberately reviewed MP7
  structural snapshot update in both sidebar states;
- `tests/e2e/smoke.spec.ts` — replaces the obsolete overhanging-toggle assertions with MP7's full
  end-to-end acceptance checks;
- `docs/reviews/POST_PRE_P2_MP7_REVIEW.md` (new).

Explicitly unchanged by MP7:

- the dashboard and operator nav models, first home links (`Dashboard` / `Mission Control`), route
  destinations, item visibility, active-state logic, and nav styling;
- the mobile header's brand lockup and the sheet's open/close authority;
- the marketing and auth logo behavior — those outside-shell lockups continue to navigate to `/`;
- collapse persistence (`clinicflow:sidebar-collapsed` plus the legacy-key migration), animation
  duration/easing, sidebar widths, and the `<md` / `md+` breakpoint contract;
- MP6's explicit shell audience, operator reserved slot, and clinic Preferences behavior;
- `actions/theme.ts`, `components/layout/theme-toggle.tsx`, `supabase/`, `types/database.ts`,
  middleware, RLS, and every database/query path.

### 3. Implementation and acceptance audit

- **One collapse control.** The former absolute `size-7` chevron button and its synthetic 48 px
  hit area are gone. Desktop/tablet now renders one `<button type="button">` that fills the complete
  64 px brand row. It contains the mark, the expanded wordmark, and the hover/focus chevron; it has
  no nested link or other interactive descendant.
- **State and relationship are explicit.** Expanded renders `aria-label="Collapse navigation"`,
  `aria-expanded="true"`, `aria-controls="dashboard-navigation"`, and the matching title. Collapsed
  renders the inverse action/state. The controlled desktop nav owns that exact ID.
- **Native keyboard behavior is preserved.** No key handler was added. Native button semantics give
  both Enter and Space activation, verified in Vitest and Chromium against the persisted shell state.
- **Visible, unclipped focus.** The full-row control uses a 2 px focus-visible outline with a negative
  offset, keeping every edge inside the sidebar rather than depending on an overhang. The production
  test focuses the control and asserts a rendered outline width of at least 2 px.
- **Affordance without ambiguity.** A directional chevron fades in inside the row on hover/focus.
  Expanded places it at inline-end; collapsed keeps the mark centred and absolutely places the
  chevron beside it. The title repeats the current action.
- **It never navigates.** The browser records the URL before collapse and asserts it is unchanged
  afterward. This does not remove an existing home action: before MP7 the sidebar brand was a plain
  image, not a link. `Dashboard` and `Mission Control` remain the only dashboard-shell home
  affordances.
- **The cross-surface brand rule is now literal:** inside the dashboard shell, the brand toggles;
  outside it, the marketing/login brand navigates to `/`. No third behavior exists.
- **The sheet stays authoritative on mobile.** `mode="sheet"` renders the same visual mark/wordmark
  inside a plain block, with no button, `aria-expanded`, title, or collapse callback. The existing
  sheet close control and link-click close behavior remain unchanged.
- **One structural baseline.** The former `h-18` / `h-16` mismatch is gone. The brand row and header
  both consume `h-[var(--shell-header-h)]`, whose single definition is 4 rem / 64 px. Their 1 px
  bottom borders both use `border-border`; the test asserts equal bottom Y coordinates and equal
  computed border colors rather than relying on visual estimation.
- **Animation is preserved.** The sidebar still transitions only its width for 200 ms with the
  existing ease-out curve. Baseline equality is sampled immediately after toggle while that
  transition is active, then again in both settled states.

### 4. Accessibility, responsive, theme, animation, and performance audit

- **Accessibility:** real button semantics; action-and-state name; `aria-expanded`;
  `aria-controls`; native Enter/Space; 64 px target; visible inset focus outline; no nested
  interactive content; no navigation side effect. The sheet brand exposes no false collapse state.
- **Responsive:** verified at desktop, the exact 768 px `md` boundary, and 767 px sheet mode. The
  desktop rail is hidden below `md`; the sheet opens/closes normally and its brand remains inert.
- **Theme:** the baseline endpoint and divider color are asserted before and after switching the
  authenticated shell to dark. No theme tokens other than the requested divider token changed.
- **Zoom and transition:** endpoint equality is asserted at 100%, 110%, and 125% CSS zoom, expanded,
  collapsed, and immediately after a collapse click while width is animating. The shared height is
  independent of width, so no divider jump or double line occurs.
- **React/component quality:** the existing state store and update path are unchanged; no effect,
  listener, dependency, memoization, or data-fetching path was added. The change uses semantic
  rendering branches for desktop versus sheet and adds no client dependency.
- **Route JavaScript budget (§17):** compared with the MP6 final manifest recorded in
  `POST_PRE_P2_MP6_REVIEW.md`. All route chunk counts remain identical and no dependency/module
  graph is added. The shared shell's required accessibility/markup contract adds only 376 raw bytes
  on each route (98–100 gzip bytes):

| Route | MP6 baseline | MP7 | Delta |
|---|---:|---:|---:|
| `/dashboard` | 14 chunks; 412,367 raw / 124,028 gzip bytes | 14 chunks; 412,743 raw / 124,128 gzip bytes | +376 raw / +100 gzip bytes |
| `/operator` | 11 chunks; 704,976 raw / 209,823 gzip bytes | 11 chunks; 705,352 raw / 209,921 gzip bytes | +376 raw / +98 gzip bytes |
| `/preferences` | 12 chunks; 315,022 raw / 99,566 gzip bytes | 12 chunks; 315,398 raw / 99,666 gzip bytes | +376 raw / +100 gzip bytes |

  The graph is unchanged; the measured sub-0.1 KB gzip delta is the new `aria-controls`/title/ID and
  desktop-versus-sheet brand markup. The existing chevron pair was deliberately reused, avoiding a
  new icon or package. This satisfies the no-new-dashboard-code budget in substance and is recorded
  exactly rather than rounded to zero.

### 5. Validation commands and exact results

| Command | Result |
|---|---|
| `pnpm exec vitest run tests/unit/components/mp7-sidebar-brand-control.test.tsx tests/unit/components/dashboard-shell.test.tsx -u` | **PASS** — 2 files, 6 tests; 2 intentional snapshots reviewed and updated |
| `pnpm test` | **PASS** — 104 files, 526 tests |
| `pnpm test:integration` (local Supabase, CLI-generated local keys) | **PASS** — 12 files, 81 tests |
| `pnpm typecheck` | **PASS** — exit 0; no diagnostics |
| `pnpm lint` | **PASS WITH WARNINGS** — 0 errors; the same 4 pre-existing warnings recorded by MP1–MP6 |
| `pnpm build` | **PASS** — optimized Next.js 16.2.6 production build; only the existing middleware-file deprecation warning |
| `PORT=3158 … playwright test --project=chromium --workers=1` | **PASS** — final production-build serial suite, **28/28** in 1.7 min |
| Production client-reference-manifest raw/gzip comparison (`/dashboard`, `/operator`, `/preferences`) | **PASS** — identical chunk counts/no dependency addition; exact deltas in §4 |
| `git status --short supabase/ types/database.ts` | **PASS** — empty |
| Added-line physical-direction utility grep over MP7 files | **PASS** — zero matches |
| P2 grep (`next-intl`, `dir="rtl"`, `thmanyah`) over `app` / `components` / `tests` | **PASS** — zero matches |
| `git diff --check` | **PASS** — no whitespace errors |
| `git diff --cached --stat` | **PASS** — empty staging area |

Run notes, recorded honestly:

- The first integration invocation lacked the local Supabase key exports, so all suites stopped
  before collecting tests. A sandboxed attempt to obtain them then could not access the Docker
  socket. The approved local-Docker rerun mapped the CLI-generated keys and passed 12/12 files,
  81/81 tests; no code or test changed for this environment setup.
- The first production-browser run found an assertion precision error: the 287 px inner button sits
  inside the sidebar's 288 px border box. The test now explicitly permits the sidebar's single
  1 px end border. The UI was already correct; the subsequent complete serial runs passed 28/28.
- A penultimate full run passed before the divider-color assertion was added. The final exact-tree
  run rebuilt production and passed all 28 tests, including equal computed divider colors.

### 6. Security and scope review

- MP7 is presentation-only. It adds no query, mutation, RPC, route, server action, validation rule,
  environment variable, log line, or public configuration value.
- No RLS policy, middleware, migration, database type, monetary column, entitlement, billing, PHI,
  or PII handling changed.
- No auth, user-menu, Preferences, theme-persistence, marketing, login, phone-input, or operator
  report behavior changed.
- No P2 language, locale, Arabic copy, Thmanyah font, RTL, language switcher, or per-user-preference
  persistence was introduced.

### 7. Stable findings

- **POSTPREP2-MP7-R1 — RESOLVED:** the dedicated overhanging chevron control is removed; the full
  64 px brand row is now the single desktop/tablet collapse button.
- **POSTPREP2-MP7-R2 — RESOLVED:** the brand control exposes action-and-state labels,
  `aria-expanded`, `aria-controls`, title text, a 64 px target, and a visible unclipped focus outline;
  native Enter and Space both toggle without custom key handlers.
- **POSTPREP2-MP7-R3 — RESOLVED:** the brand never navigates and removes no prior home action — it
  was not a link before MP7. Dashboard/Mission Control remain the shell's home affordances, while
  the outside-shell marketing/login lockups continue to navigate to `/`.
- **POSTPREP2-MP7-R4 — RESOLVED:** the inline chevron communicates the action on hover/focus in both
  widths without moving the centred collapsed mark or changing the existing width animation.
- **POSTPREP2-MP7-R5 — RESOLVED:** mobile sheet branding is non-interactive and exposes no collapse
  state; the existing mobile header and sheet open/close behavior remain intact.
- **POSTPREP2-MP7-R6 — RESOLVED:** the 72 px versus 64 px divider mismatch is replaced by one
  64 px CSS token and one border-color token, bounding-box and computed-color asserted in light,
  dark, desktop, tablet, transition, and fractional-zoom states.
- **POSTPREP2-MP7-R7 — RESOLVED:** dashboard-route chunk graphs are unchanged; the exact shared-shell
  markup delta is 376 raw / 98–100 gzip bytes with no new dependency or icon module.

### 8. Optional polish findings

None. MP7 is the final approved workstream in this manual-polish sprint. P2 remains unstarted.

### 9. Git state and scope audit

- Branch observed: `fix/post-pre-p2-manual-polish`.
- The dirty working tree already contained preserved MP0–MP6, planning, test, review, and generated
  screenshot changes before MP7 began; none were reset, restored, overwritten, staged, or discarded.
- The staging area remains empty.
- MP7 added/edited only the files listed in §2.
- No commit, push, merge, branch creation, stage, reset, restore, checkout, clean, or stash action
  occurred.

### 10. Final verdict

**IMPLEMENTED — awaiting comprehensive review**

MP7 is complete. The sidebar's dedicated toggle is gone; its desktop/tablet brand row is now the
single accessible collapse control with native keyboard behavior, explicit state, an internal
hover/focus affordance, no navigation, preserved persistence, and the existing width animation.
The mobile sheet brand remains inert. One 64 px token and one divider token now give the sidebar and
header an objectively continuous baseline across widths, themes, transition time, and tested zoom
levels. No other UI, database, security, or P2 work was changed.

## Re-review history

- **Review Cycle 1 — 2026-07-14:** initial MP7 implementation audit. Seven required findings
  resolved; no optional MP7 polish finding remains open. Status is implemented and awaiting
  comprehensive review.
