# Post-Pre-P2 MP6 Review — Platform-Admin Header: Remove Preferences, Reserve the Language Slot

**Status:** IMPLEMENTED — awaiting comprehensive review
**Workstream:** MP6 (`docs/POST_PRE_P2_MANUAL_POLISH.md` §9-MP6)
**Review cycle:** 1
**Review date:** 2026-07-14
**Final verdict:** **IMPLEMENTED — awaiting comprehensive review**

This is the authoritative MP6 implementation-review record. Later reviews must preserve Review
Cycle 1, retain stable finding IDs, and append history rather than replace it.

## Review Cycle 1

### 1. Implementation scope

Implemented MP6 only:

- gave `DashboardShell` an explicit, **required** `surface: "clinic" | "operator"` audience prop,
  passed by the route-group layout that owns the shell — no role sniffing anywhere;
- removed the user-menu **Preferences** entry from the **operator (Platform Admin)** header, where
  it was a broken clinic-user link;
- **reserved** that position for the P2 Operator Language Switcher by leaving it **empty** and
  documenting the reservation in code, pointing at `AI_AGENT_PLAN.md` §4.1;
- kept **Preferences unchanged for every clinic role** — Clinic Owner, Admin, Doctor, Receptionist,
  Nurse, and any future staff role;
- added focused unit coverage for both audiences and a production-browser end-to-end test covering
  the operator header, the clinic header, and the absence of any language control.

**Not implemented, by design:** no P2 localization, no `next-intl`, no locale persistence, no
placeholder/fake language switcher, no language button of any kind on any surface. The reserved slot
renders **nothing**.

No MP7 sidebar work, logo-collapse change, theme-persistence change, migration, schema, RLS,
middleware, route, or server-action change is included. MP0–MP5 were not redone or overwritten.

### 2. Exact files changed

Product code:

- `components/layout/dashboard-shell.tsx` — new `DashboardSurface` type and required `surface` prop;
  the Preferences `DropdownMenuItem` is now rendered only when `surface === "clinic"`; the operator
  position carries the reserved-slot comment naming the P2 Operator Language Switcher and its
  scope;
- `app/(operator)/layout.tsx` — passes `surface="operator"`;
- `app/(protected)/layout.tsx` — passes `surface="clinic"`.

Tests/documentation:

- `tests/unit/components/mp6-operator-header-slot.test.tsx` (new);
- `tests/unit/components/dashboard-shell.test.tsx` — the four existing renders now pass the explicit
  `surface="clinic"` audience (a required prop; no assertion or snapshot expectation was changed);
- `tests/e2e/smoke.spec.ts` — one new serial MP6 test (operator + doctor, separate browser
  contexts);
- `docs/reviews/POST_PRE_P2_MP6_REVIEW.md` (new).

Explicitly unchanged by MP6:

- `app/(protected)/preferences/page.tsx` — its route, contents, read-only "Language — English (US)"
  card, and clinic-role access model are byte-for-byte untouched;
- `components/layout/sidebar.tsx`, the collapse chevron, the brand row, and the divider baseline —
  **MP7 remains unstarted**;
- `actions/theme.ts`, `components/layout/theme-toggle.tsx`, and the theme cookie — theme persistence
  is a P2 deliverable and was not touched;
- `tests/unit/components/__snapshots__/dashboard-shell.test.tsx.snap` — **no snapshot churn**: the
  clinic surface renders identically to before, which is itself the proof that clinic users are
  unaffected;
- `supabase/`, `types/database.ts`, `middleware.ts`, `lib/rbac.ts`, `lib/supabase/*`, and all
  MP0–MP5 implementation/review files.

### 3. Implementation and acceptance audit

- **The audience is explicit, never inferred.** `surface` is a required prop on `DashboardShellProps`
  with no default, so TypeScript forces every current and future layout to declare which dashboard it
  is mounting. The operator layout passes `"operator"`; the protected layout passes `"clinic"`. No
  code path reads `user.roleLabel`, a role string, `platform_admins`, or any other signal to decide
  what the header renders. This is the §13.4c architecture decision, implemented literally.
- **Why the removal is a defect fix, not a preference.** `/preferences` calls `requireUser()` and
  reads `clinics`/`profiles`. A Platform Admin authenticates through `platform_admins.user_id →
  auth.users` and has **no `profiles` row and no `clinic_id`**, so the entry was a link the account
  shown it could not use. It is now absent from the operator surface, and the route stays exactly as
  unreachable for a platform admin as it was before — MP6 removes a broken link, it does not grant
  or revoke any access.
- **The reserved slot is reserved, not stubbed.** On the operator surface the position renders
  `null`. There is no button, no menu item, no combobox, no disabled control, and no "English"
  label anywhere. The in-code comment states the reservation, names the P2 Operator Language
  Switcher, points at `AI_AGENT_PLAN.md` §4.1, and records the switcher's scope — the operator
  dashboard's language, for that platform-admin user only, never a clinic and never a clinic user —
  so P2 mounts the real control in exactly this position without re-deriving the decision.
- **Clinic users are untouched.** With `surface="clinic"` the menu renders My profile → Preferences →
  Sign out exactly as it did at `cf139cb`. The unit suite asserts the Preferences item is present
  with `href="/preferences"` for `owner`, `admin`, `doctor`, `receptionist`, and `nurse` role labels;
  the clinic snapshot is unchanged; and the existing WS4 receptionist e2e (`display currency
  preference (Settings → Preferences)`) still reaches Preferences from the user menu and passes
  unmodified.
- **The operator header keeps everything else it owned:** the theme toggle (the Platform Admin's
  theme is their own per-user choice, §6.C), the avatar/user menu, the email label, and Sign out.
- **No P2 leakage.** A grep for `next-intl`, `dir="rtl"`, and `thmanyah` across `app/`,
  `components/`, and `tests/` returns zero matches. The word "language" appears in MP6 only inside
  negative assertions and code comments.

### 4. Accessibility, responsive, theme, and performance audit

- **Accessibility:** MP6 adds no control, so it adds no accessible name, no focus target, and no
  keyboard interaction. An empty reserved slot cannot fail an audit — a stubbed button would. The
  operator menu's remaining items keep their roles and names; Sign out is still reachable and
  operable.
- **Responsive/theme:** the change is a conditional render inside an existing dropdown; no layout,
  breakpoint, spacing, or token changed. The operator e2e runs on the dark operator session already
  established by the suite and the clinic e2e on a light session; both render correctly.
- **Route JavaScript budget (§17 — "no first-load JS delta on any dashboard route; measure before
  and after and record it").** Measured with the MP5 method — the production client-reference
  manifest per route, raw and gzip, over the real built chunks. Baseline = the same working tree with
  `components/layout/dashboard-shell.tsx` and both layouts restored to `cf139cb`:

| Route | Baseline | MP6 | Delta |
|---|---:|---:|---:|
| `/dashboard` | 14 chunks; 412,339 raw / 124,015 gzip bytes | 14 chunks; 412,367 raw / 124,028 gzip bytes | +28 raw / +13 gzip bytes |
| `/operator` | 11 chunks; 704,948 raw / 209,809 gzip bytes | 11 chunks; 704,976 raw / 209,823 gzip bytes | +28 raw / +13 gzip bytes |
| `/preferences` | 12 chunks; 314,994 raw / 99,553 gzip bytes | 12 chunks; 315,022 raw / 99,566 gzip bytes | +28 raw / +13 gzip bytes |

  **Chunk graphs are identical on every route** — no module, dependency, dynamic import, or icon was
  added or removed (`SlidersHorizontal` is still imported and still used by the clinic branch). The
  +28 raw bytes are the compiled `surface === "clinic" ? … : null` conditional inside the shared
  shell chunk, which is why the delta is the same on all three routes. Comments are stripped by the
  compiler and cost nothing. This is a markup-level change with a measured, sub-14-byte-gzip effect;
  the MP6 budget passes.

### 5. Validation commands and exact results

| Command | Result |
|---|---|
| `pnpm exec vitest run tests/unit/components/mp6-operator-header-slot.test.tsx tests/unit/components/dashboard-shell.test.tsx` | **PASS** — 2 files, 6 tests; the existing shell snapshots matched **unchanged** |
| `pnpm test` | **PASS** — 103 files, 524 tests |
| `pnpm test:integration` (local Supabase, keys from `supabase status -o env`) | **PASS** — 12 files, 81 tests |
| `pnpm typecheck` | **PASS** — exit 0; no diagnostics |
| `pnpm lint` | **PASS WITH WARNINGS** — 0 errors; the same 4 pre-existing warnings recorded by MP1–MP5 |
| `pnpm build` | **PASS** — optimized Next.js 16.2.6 production build; only the existing middleware-file deprecation warning |
| `PORT=3155 … playwright test --project=chromium --workers=1` | **PASS** — final production-build serial suite, **28/28** in 1.2 min (27 pre-existing + the new MP6 test) |
| `PORT=3154 … playwright test tests/e2e/p1c-signup.spec.ts --project=chromium --workers=1` | **PASS** — 2/2, complete file in order |
| Production client-reference-manifest raw/gzip comparison (`/dashboard`, `/operator`, `/preferences`) | **PASS** — identical chunk graphs; exact deltas in §4 |
| `git status --short supabase/ types/database.ts` | **PASS** — empty |
| Added-line physical-direction utility grep over the MP6 files | **PASS** — zero matches |
| P2 grep (`next-intl`, `dir="rtl"`, `thmanyah`) over `app` / `components` / `tests` | **PASS** — zero matches |
| `git diff --check` | **PASS** — no whitespace errors |
| `git diff --cached --stat` | **PASS** — empty staging area |

Notes on the runs, recorded honestly:

- One earlier full serial run failed the pre-existing `p1c-signup` lazy-dialog mount race that MP5
  already documented (`expired-subscription user can submit the public root dialog`). It is unrelated
  to MP6 — the file passed **2/2** on an immediate complete-file rerun, and the subsequent full
  serial suite passed **28/28** with no test edit.
- One earlier failing assertion in the new MP6 tests was mine, not the product's: Radix marks the
  rest of the page inert while the dropdown is open, so the theme-toggle assertion had to be made
  before the menu opens. Both the unit and e2e tests now assert it in the correct order.
- The baseline build for §4 was produced by temporarily restoring the three product files to
  `cf139cb` and rebuilding; all MP6 versions were copied out first and restored immediately after,
  and `git status` confirms the working tree returned intact. Nothing was staged, stashed, reset,
  committed, or discarded.

### 6. Security and scope review

- MP6 is presentation-only. It adds no query, mutation, RPC, route, server action, validation rule,
  environment variable, log line, or public configuration value.
- **No access-control change.** `requireUser()`, `requirePlatformAdmin()`, RLS policies, the
  middleware gate order, and the `/preferences` route guard are untouched. Removing a menu link
  changes no authorization; the route was, and remains, a clinic-user route.
- No migration, schema, database type, monetary column, entitlement, billing, PHI, or PII handling
  changed.
- No P2 language, locale, RTL, font, switcher, or per-user-preference implementation was introduced,
  and no placeholder pretending to work was added.

### 7. Stable findings

- **POSTPREP2-MP6-R1 — RESOLVED:** the operator header showed a **Preferences** entry pointing at
  `/preferences`, a clinic-user route a Platform Admin (no `profiles` row, no `clinic_id`) cannot
  use — a broken link shown to the one account it can never serve. The entry is gone from the
  operator surface.
- **POSTPREP2-MP6-R2 — RESOLVED:** the position is now the **permanently reserved slot** for the P2
  Operator Language Switcher, documented in `dashboard-shell.tsx` with its P2 pointer and its scope
  (operator dashboard only, for that platform-admin user; never a clinic, never a clinic user).
- **POSTPREP2-MP6-R3 — RESOLVED:** reserved means **empty**. No placeholder, stub, disabled control,
  or fake language button ships on any surface; the P2 grep is clean.
- **POSTPREP2-MP6-R4 — RESOLVED:** `DashboardShell` previously rendered its utilities
  unconditionally for both audiences. It now takes a **required explicit `surface` prop** —
  `"clinic"` from `(protected)`, `"operator"` from `(operator)` — so the two dashboards are
  structurally distinct and nothing is inferred from a role string.
- **POSTPREP2-MP6-R5 — RESOLVED:** clinic users are provably unaffected. Preferences is still in the
  clinic user menu for Clinic Owner, Admin, Doctor, Receptionist, and Nurse; the clinic snapshot is
  unchanged; and the doctor and receptionist e2e paths both still open `/preferences`.
- **POSTPREP2-MP6-R6 — RESOLVED:** the dashboard-route JavaScript budget holds — identical chunk
  graphs on `/dashboard`, `/operator`, and `/preferences`, with a measured +13 gzip bytes from the
  conditional itself.

### 8. Optional polish findings

None. MP7 remains intentionally unstarted, and no MP7-adjacent code (sidebar, brand row, collapse
control, divider baseline) was touched even though it lives in the same file.

### 9. Git state and scope audit

- Branch observed: `fix/post-pre-p2-manual-polish`.
- The dirty working tree already contained preserved MP0–MP5, planning, test, review, and generated
  screenshot changes before MP6 began; none were reset, restored, overwritten, staged, or discarded.
  `git diff --stat` after MP6 still shows all of them.
- The staging area remains empty.
- MP6 added/edited only the files listed in §2.
- No commit, push, merge, branch creation, stage, reset, restore, checkout, clean, or stash action
  occurred.

### 10. Final verdict

**IMPLEMENTED — awaiting comprehensive review**

MP6 is complete. The Platform Owner's operator header no longer shows a Preferences entry it could
never use, and that position is now an empty, code-documented reservation for the P2 Operator
Language Switcher — with no localization, no `next-intl`, no locale persistence, and no fake
switcher anywhere. `DashboardShell` distinguishes the operator dashboard from the clinic dashboard
through an explicit required audience prop rather than role sniffing. Every clinic role keeps
Preferences exactly as it works today, proven by an unchanged snapshot, per-role unit assertions, and
green doctor and receptionist end-to-end paths. MP7 remains unstarted.

## Re-review history

- **Review Cycle 1 — 2026-07-14:** initial MP6 implementation audit. Six required findings resolved;
  no optional MP6 polish finding remains open. Status is implemented and awaiting comprehensive
  review.
