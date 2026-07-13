# Pre-P2 WS1 Review — Sidebar Collapse Control Fix (BUG-2)

**Status:** IMPLEMENTED — awaiting review
**Workstream:** WS1 (`docs/PRE_P2_POLISH.md` §7-WS1)
**Date:** 2026-07-13

## 1. Root cause

`position: sticky` **always creates a stacking context**, so the toggle button's own
z-index could never escape the `aside`: the aside's context (z-index auto) resolved below
the content column's sticky header (`z-30`, opaque `bg-card/95`), which painted over the
overhanging half of the button. Verified empirically with a computed-style probe:
button `z: 40, position: absolute` still lost to `header z: 30` (`elementFromPoint` at the
button's overhang returned `HEADER`) until the aside itself was elevated.

## 2. Fix (`components/layout/sidebar.tsx`)

- `aside` (sidebar mode) gains `z-40` so its stacking context sits above the header's `z-30`
  (comment in code explains why). The overhang design is kept.
- Toggle button: `z-40` within the aside and an invisible expanded hit area
  `before:absolute before:-inset-2.5` → 28px visual, **48px effective hit target** (≥44px,
  WCAG 2.5.8). Focus ring, `aria-expanded`, and `rtl:` transforms unchanged.

## 3. Verification

- **E2E (extended `tests/e2e/smoke.spec.ts` dashboard-shell test):** bounding box extends past
  the sidebar edge; `elementFromPoint` at the overhang center resolves to the toggle (the
  painted-over regression check that failed before the fix and passes after); `aria-expanded`
  true→false across collapse; collapsed `data-collapsed=true`; keyboard focus + Enter
  re-expands. **1/1 passed.**
- **Visual:** expanded + collapsed screenshots captured — button fully round and visible in
  both states (light theme; dark theme uses the same sidebar tokens and the same stacking fix,
  verified by the theme-independent z-index change).
- Mobile (<md): aside is `hidden`, sheet nav unaffected (no toggle rendered in sheet mode).

## 4. Acceptance criteria (§19-WS1)

- [x] Toggle unclipped in expanded/collapsed states (screenshot + elementFromPoint assertion)
- [x] ≥44px hit target (48px effective)
- [x] Keyboard + `aria-expanded` verified in e2e
- [x] E2E assertion added to the dashboard-shell test

## 5. Files changed

- `components/layout/sidebar.tsx`
- `tests/e2e/smoke.spec.ts`
