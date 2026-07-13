# Pre-P2 WS2 Review — Reusable Table System

**Status:** IMPLEMENTED — awaiting review
**Workstream:** WS2 (`docs/PRE_P2_POLISH.md` §7-WS2)
**Date:** 2026-07-13

## 1. What was built

- **`components/ui/table.tsx`** — the shadcn Table primitive, hand-added (the CLI
  registry was not reachable in this environment; the file matches the shadcn API:
  `Table`, `TableHeader`, `TableBody`, `TableFooter`, `TableHead`, `TableRow`,
  `TableCell`, `TableCaption`). Encodes the §7-WS2 hierarchy **once**:
  - Header: solid `bg-muted` (full opacity, not `/50`), `text-foreground font-semibold`,
    `border-b-2 border-border` (full-opacity) vs. `border-border/50` row dividers.
  - Rows: `hover:bg-muted/50`, `data-[state=selected]:bg-muted`.
  - `TableHead` renders `<th scope="col">`; optional `sticky` header prop
    (`sticky top-0 z-10`) for long lists.
  - Built-in `overflow-x-auto` container (responsive; never per-page).
  - `dense` prop for print-facing report density (tight padding, `text-xs` headers).
- **`components/shared/data-table.tsx`** — the declarative treatment:
  - `DataTable` — column-def-driven listing with numeric right-align/`tabular-nums`,
    optional sticky header, `rowKey`, `caption`, and a built-in empty state.
  - `TableEmptyState` — shared icon + title + description + optional action.
  - `TableSkeleton` — loading placeholder matching the table rhythm.

## 2. Consumers migrated (zero raw `<table>` styling remains)

`grep -rln "<table" components/ app/` → only `components/ui/table.tsx` (the primitive).

- **Operator:** `components/operator/report-shell.tsx` (→ `DataTable`),
  `app/(operator)/operator/clinics/page.tsx`, `.../coupons/page.tsx`, `.../invitations/page.tsx`.
- **Tenant tables:** `components/patients/{patient-table,archive-table,trash-table,appointments-report-list}.tsx`,
  `components/settings/{staff-table,settings-trash-section}.tsx`,
  `components/appointments/appointments-recycle-bin.tsx`,
  `components/followups/followups-view.tsx`, `components/revenue/revenue-report.tsx`.
- **Reports (print-facing, migrated last per §20):** the five
  `components/reports/{doctor-performance,cancellation,no-show,followups,receptionist-performance}-report.tsx`
  + `revenue-summary-report.tsx`.
- **Settings CRUD pages:** `app/(protected)/settings/{departments,insurance,services,packages}/page.tsx`.
- **Patient sub-report pages:** `app/(protected)/patients/[id]/{appointments-report,followups-report,medical-notes-report}/page.tsx`.

`staff-by-department.tsx` renders `StaffTable` (already migrated) — no own table.

## 3. Print safety

The global print stylesheet (`app/globals.css:384-431`) hard-normalizes all
`table`/`th`/`td` for print (forced borders, `#fff`/`#000`, `overflow: visible` on
`[class*="overflow"]`), so the shared primitive's `bg-muted` header and the
`overflow-x-auto` wrapper are overridden in print exactly as the old bespoke tables
were. Revenue and patient print reports keep their `print:` modifiers; totals rows
moved to semantic `TableFooter`.

## 4. Logical properties (P2B protection)

All migrated cells use `text-start`/`text-end` (converted from `text-left`/`text-right`).
Two pre-existing `text-right` on letterhead **divs** in `revenue-report.tsx` were left
untouched (not new, not table cells).

## 5. Tests

- **Unit:** `tests/unit/components/data-table.test.tsx` (5 tests) — `<th scope="col">`,
  numeric right-align, empty-state-instead-of-empty-table, custom `render`, empty-state
  action, skeleton row count. **5/5 pass.**
- Full unit suite **447/447** (dashboard-shell snapshot updated for the WS1 sidebar
  class change — intentional).
- `pnpm typecheck` clean; `pnpm lint` 0 errors (4 pre-existing warnings).
- Visual: departments settings table rendered in the browser — solid header, strong
  border hierarchy, dark-mode tokens (screenshot captured).

## 6. Acceptance criteria (§19-WS2)

- [x] Shared primitive exists (`ui/table` + `shared/data-table`)
- [x] Zero raw per-page `<table>` styling in migrated files
- [x] Header/row/border hierarchy per §7-WS2
- [x] Dark mode verified (muted/foreground tokens)
- [x] Empty/loading slots available and used (settings, patients, operator)

## 7. Files changed

New: `components/ui/table.tsx`, `components/shared/data-table.tsx`,
`tests/unit/components/data-table.test.tsx`.
Migrated: the ~20 consumers listed in §2.
