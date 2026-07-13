# Pre-P2 WS5 Implementation Report — Calendar Readability

**Workstream:** WS5 — Calendar readability  
**Implementation date:** 2026-07-13  
**Branch:** `main`  
**Scope boundary:** WS5 only; WS6 and later workstreams were not started.

## Scope implemented

- Audited and retuned all appointment calendar views: week, day, and month.
- Added a shared two-level grid hierarchy with dedicated light/dark calendar tokens.
- Raised hour labels to 11px, medium weight, tabular numerals, and a WCAG-passing
  foreground blend.
- Added clear today treatments to headers and bodies in every view.
- Added current-time indicators to week/day time grids and a compact current-time
  marker to the month view. The visual time refreshes once per minute on long-lived tabs.
- Added schedule-derived visual bands for opening gaps, shift breaks, closing gaps,
  and closed days. These are visual-only and do not participate in availability.
- Strengthened appointment-card and month-event contrast without using arbitrary
  department colors as text colors.
- Added hover, focus, opened-event, and selected create-flow time-slot states.
- Preserved the existing horizontal-scroll calendar behavior and verified it at 320px.
- Generated before/after screenshot pairs for every view in light and dark themes,
  plus a 320px responsive screenshot.

## Architecture decisions

1. Calendar-specific color tokens live in `app/globals.css` rather than weakening or
   globally changing the app's general `border` and `muted-foreground` tokens.
2. `components/appointments/calendar-visuals.tsx` is the single visual source for:
   grid/header/label/selected-slot class sets, grid bounds, visual non-working bands,
   the current-time indicator, and the minute-refresh clock.
3. Non-working bands are derived from the already-loaded `ClinicWorkingHoursValues`.
   The helper is explicitly visual-only; it is not imported by booking or conflict code.
4. Department colors are retained as accents and mixed borders/backgrounds. Calendar
   text uses theme foreground tokens so arbitrary clinic colors cannot create unreadable
   text in either theme.
5. The month view uses a compact `Now · time` marker because it has no spatial time axis;
   week/day retain the 2px line and axis dot specified by the WS5 plan.
6. Screenshot “before” states are deterministic reproductions of the audited baseline
   (9px, 50%-muted labels; faint borders; no now line/today body tint), injected only
   during capture. Production UI is never switched into the baseline state.

## Files changed

### Product code

- `app/globals.css`
- `components/appointments/calendar-visuals.tsx` (new)
- `components/appointments/week-calendar.tsx`
- `components/appointments/day-calendar.tsx`
- `components/appointments/month-calendar.tsx`
- `components/appointments/appointment-form.tsx`
- `components/appointments/status-badge.tsx`

### Tests

- `tests/unit/components/appointment-calendar-readability.test.tsx` (new)
- `tests/e2e/smoke.spec.ts`

### Review evidence

- `docs/reviews/assets/pre-p2-ws5/week-light-before.png`
- `docs/reviews/assets/pre-p2-ws5/week-light-after.png`
- `docs/reviews/assets/pre-p2-ws5/week-dark-before.png`
- `docs/reviews/assets/pre-p2-ws5/week-dark-after.png`
- `docs/reviews/assets/pre-p2-ws5/day-light-before.png`
- `docs/reviews/assets/pre-p2-ws5/day-light-after.png`
- `docs/reviews/assets/pre-p2-ws5/day-dark-before.png`
- `docs/reviews/assets/pre-p2-ws5/day-dark-after.png`
- `docs/reviews/assets/pre-p2-ws5/month-light-before.png`
- `docs/reviews/assets/pre-p2-ws5/month-light-after.png`
- `docs/reviews/assets/pre-p2-ws5/month-dark-before.png`
- `docs/reviews/assets/pre-p2-ws5/month-dark-after.png`
- `docs/reviews/assets/pre-p2-ws5/day-light-responsive-320.png`
- `docs/reports/PRE_P2_WS5_IMPLEMENTATION.md`
- `docs/reviews/PRE_P2_WS5_REVIEW.md`

## Reusable components introduced

`components/appointments/calendar-visuals.tsx` introduces:

- `CALENDAR_STYLES`
- `getCalendarGridBounds`
- `getCalendarNonWorkingBands`
- `CalendarNonWorkingBands`
- `CalendarNowIndicator`
- `useCalendarNow`
- shared minute/time conversion used only for calendar presentation

No new dependency was added.

## Security considerations

- No RLS policy, migration, middleware, RBAC, tenant query, or admin-client path changed.
- No new database query or client-to-server input was added.
- Calendar test fixtures remain tenant-scoped and are removed by the existing cleanup.
- No PHI is included in committed screenshots; fixture names are generated smoke-test data.
- No secret or environment value is written to source or review artifacts.

## Business-logic preservation

- Appointment create/update/delete/restore actions are unchanged.
- Availability and time-slot calculation actions are unchanged.
- Conflict/buffer validation is unchanged.
- Appointment status transitions and billing behavior are unchanged.
- Calendar query ranges, filtering, grouping, click/keyboard detail interactions, and
  navigation URLs are unchanged.
- Existing timezone formatting remains `DEFAULT_TIME_ZONE`-based. WS5 only reuses the
  same formatter for visual placement and refreshes it once per minute.
- The new working/non-working calculation paints background bands only; it never enables,
  disables, selects, books, or rejects a slot.

## Tests executed

| Command | Exact result |
|---|---|
| `pnpm exec vitest run tests/unit/components/appointment-calendar-readability.test.tsx tests/unit/components/appointment-calendar-performance.test.ts` | PASS — 2 files, 10 tests |
| `pnpm exec vitest run tests/unit/components/appointment-calendar-readability.test.tsx tests/unit/components/appointment-calendar-performance.test.ts tests/unit/actions/time-slots.test.ts tests/unit/actions/appointment-form-autofill.test.tsx` | PASS — 4 files, 19 tests |
| `pnpm test` | PASS — 85 files, 466 tests |
| `pnpm typecheck` | PASS — exit 0, no diagnostics |
| `pnpm lint` | PASS with warnings — 0 errors, 4 pre-existing warnings |
| `PORT=3101 node --env-file=.env.local node_modules/@playwright/test/cli.js test --workers=1 --grep "WS5 calendar readability"` | PASS — production `next build` + `next start`; Chromium 1/1 in 4.3s, 22.5s total |
| `git diff --check` | PASS — no whitespace errors before report creation; rerun after documents recorded in the review |

## Validation results

- WCAG contrast calculation for hour labels (sRGB relative luminance after OKLCH
  conversion and alpha compositing):
  - Light: **1.80:1 before → 6.26:1 after**
  - Dark: **3.42:1 before → 8.04:1 after**
  - Final values exceed WCAG 2.1 AA's 4.5:1 normal-text threshold.
- Playwright verified all three views, both themes, readable computed hour-label size/
  weight/opacity, today state, current-time state, break bands, event presence, and 320px
  internal scrolling without body overflow.
- Visual inspection of the production screenshots confirmed no heavy shadows or added
  chrome; hierarchy comes from line contrast, tint, typography, and narrow accents.
- Production build passed as a prerequisite of the final Playwright run.

## Known limitations

- The in-app browser runtime exposed no browser instance in this session. The required
  visual verification was completed with the repository's Chromium Playwright suite.
- The production E2E server logs the pre-existing `last_login_update_failed` (`42501`)
  message already documented by prior phase reviews; the calendar flow still passes.
- Full integration/database suites were not required because WS5 changes no query,
  mutation, schema, RLS, or server behavior. Targeted Playwright exercised the real local
  database and production application build.

## Git status

- `git status --short --branch` begins `## main...origin/main`.
- The working tree remains intentionally dirty with preserved WS0–WS4 modified/untracked
  files plus the WS5 files listed above; the pre-existing WS4 deletion of
  `components/layout/currency-selector.tsx` remains present.
- `git diff --cached --name-only` returned no paths: nothing is staged.
- No file was committed, pushed, stashed, reset, restored, or cleaned.
