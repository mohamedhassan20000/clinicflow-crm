# P2B Review — RTL Retrofit, shadcn RTL Configuration, Icon Mirroring, CI Direction Gate

**Status:** **IMPLEMENTED — awaiting comprehensive review**
**Workstream:** P2B (`docs/AI_AGENT_PLAN.md` §8 "P2 execution split", §4.2)
**Branch:** `feat/p2a-i18n-infrastructure` — the **P2 integration branch** (base `3b16157`; P2A + P2B both uncommitted, per the P2A-N1 release-sequencing decision: P2A/P2B/P2C integrate onto one branch and none merges to `main` alone)
**Review cycle:** 1
**Date:** 2026-07-14

This is the authoritative P2B implementation-review record. Later reviews must retain the stable
finding IDs below and append history rather than replace it.

**P2A was not reopened.** No P2A file was altered except where P2B's own conversion touched it
(`app/globals.css` print block, `components/layout/dashboard-shell.tsx`, `components/ui/*`), and every
P2A behavior — locale resolution, the three switchers, `user_ui_preferences`, theme-follows-the-user —
is re-asserted green below. **P2C was not started:** no string was extracted, no Arabic copy was added.

---

## 1. What P2B had to do, and what it did

| §8 P2B scope item | Status |
|---|---|
| `components.json` → `"rtl": true` + shadcn primitive regeneration with diff review | ✅ — flipped; primitives converted **in place** by shadcn's own transformer, not by `--overwrite` (**P2B-D1**) |
| Logical-properties codemod of app-owned files (**inventory re-measured first**) | ✅ — re-measured (§2), 49 files rewritten |
| Manual pass on intentional physical cases (charts, print layouts) | ✅ — charts untouched by design; print block converted; 2 documented exceptions (**P2B-O1**) |
| Directional icon mirroring | ✅ — 29 icons across 16 files, **two** mirror utilities (**P2B-D2**) |
| CI grep-gate on new physical-direction classes | ✅ — `pnpm lint:rtl`, wired into CI; fails on physical classes **and** on un-mirrored directional icons |
| Full layout validation in LTR and RTL | ✅ — 4 new browser tests measuring **computed geometry**, not class names (§6) |
| **Out:** string extraction / Arabic copy (P2C); Recharts internals (stay LTR) | ✅ — neither touched |
| **Migrations** | ✅ **none**, as specified |

---

## 2. The re-measured inventory

The plan's standing figure — **87 files / 339 occurrences** — was measured on 2026-07-09, *before* the
P1.5A shell redesign, and §8 explicitly requires re-measurement. Measured against the current tree
(P2A applied), immediately before the codemod ran:

| | Files | Flagged lines |
|---|---|---|
| **Pre-codemod (re-measured)** | **48** | **131** |
| Post-codemod | 0 | 0 undocumented (+ 2 documented exceptions) |

The count is lower than the 2026-07-09 audit because P1.5A retired the old top-nav shell and every
component written since was authored logical-properties-first, exactly as §8 predicted. Two files
already carried hand-written RTL handling and the codemod correctly left them alone:
`components/layout/sidebar.tsx` (`rtl:rotate-180`, `inset-e-*`) and `components/shared/page-header.tsx`
(an `rtl:hidden` / `rtl:block` glyph swap).

*(The gate counts one hit per line per rule, so a line carrying both `ml-2` and `pl-4` counts twice
while a line with two `ml-` counts once. It is a file/line measure, not a token census — stated plainly
rather than dressed up as a precise occurrence count.)*

---

## 3. The three substantive findings — **read this section first**

Everything else in P2B is mechanical. These three are not, and two of them are latent RTL bugs that
would have shipped silently, because **all three are invisible in English**.

### P2B-D1 — shadcn primitives were converted in place, not regenerated (accepted deviation)

§4.2 step 1 says to "re-add the shadcn primitives … (they are generated code; regeneration converts
them to RTL-safe variants). Diff-review each against local customizations."

**They are no longer purely generated code.** All 22 local primitives diverge from the registry, and
not cosmetically: `table.tsx` is a rewritten **Pre-P2 WS2 deliverable** (shared header/divider
treatment, `dense` and `containerClassName` props); `sheet.tsx` swaps the registry's
`IconPlaceholder` for `XIcon`; `button.tsx` changes two variants; every file rewrites the registry's
`@/registry/radix-nova/*` imports. `shadcn add --overwrite` would have destroyed all of it.

**What was verified before choosing:** the shadcn CLI does **not** serve different content for
`rtl: true` — `GET /r/styles/radix-nova/dropdown-menu.json` and `…?rtl=true` return **byte-identical**
JSON. The RTL conversion is a **local AST transform** the CLI applies at write time. So
"regeneration" *is* "registry source + transform", and applying that same transform to the local file
is the identical rewrite with the customizations preserved.

The codemod therefore calls **shadcn's own transformer** (`scripts/rtl-codemod.mjs` locates it in the
CLI's dist bundle by its class-mapping table, and throws loudly if a shadcn upgrade moves it) rather
than re-implementing the mapping. Evidence that in-place ≡ regeneration: the transformer's change
footprint on the pristine registry source and on our local file **matches on 21 of 22 primitives**
(the exception is `table.tsx`, whose rewrite had already removed the physical classes).

`components.json` is flipped to `"rtl": true`, so any *future* `shadcn add` emits logical classes.

### P2B-F1 — shadcn's transformer double-flips `space-x-*` on Tailwind v4 (found; stripped)

shadcn's RTL transformer appends `rtl:space-x-reverse` to every `space-x-*` (and
`rtl:divide-x-reverse` to every `divide-x-*`). That was correct for **Tailwind v3**, where `space-x-*`
compiled to a physical `margin-left`.

**Tailwind v4 compiles it to `margin-inline-start` / `margin-inline-end`** — it already flips with
`dir` on its own. Verified against compiled v4.2.2 output:

```css
.space-x-2 > :not(:last-child) { margin-inline-start: calc(… * var(--tw-space-x-reverse));
                                 margin-inline-end:   calc(… * calc(1 - var(--tw-space-x-reverse))); }
.rtl\:space-x-reverse           { &:where(:dir(rtl), …) { --tw-space-x-reverse: 1; } }
```

Setting `--tw-space-x-reverse: 1` on an already-flipped logical property is a **double flip**: the gap
moves to the start side of every non-last child, so the first child gains a leading indent and the last
gap disappears. The codemod strips both tokens in a post-pass (`stripDoubleFlips()`), and a unit test
fails if one ever reappears. Blast radius today is one utility (`-space-x-2`, the avatar-group overlap),
but a future `shadcn add` would reintroduce it silently — English would stay perfect.

### P2B-F2 — shadcn's transformer leaves `Sheet` internally inconsistent (found; fixed properly)

The transformer **exempts inset utilities** under a `data-[side=left]` / `data-[side=right]` variant —
but it does **not** exempt their borders. Run over the registry sheet it produces:

```
data-[side=left]:left-0   (physical — exempted)   +   data-[side=left]:border-e   (logical — flipped)
```

In Arabic that pins the panel to the physical left while drawing its divider on the physical left too —
the outer edge — instead of the content-facing edge.

Papering over that with an allowlist would have missed the real problem: **`side` is the wrong model.**
All three call sites mean a *logical* side — the mobile nav drawer belongs beside the sidebar
(`side="left"`), and the two detail panels belong opposite it (`side="right"`). In Arabic the drawer
must open from the **right**, which a physical `left` can never express.

`SheetContent` now takes `"top" | "bottom" | "inline-start" | "inline-end"` (default `inline-end`), and
positions, borders **and** slide animations all key off logical sides (`start-0`, `border-e`,
`slide-in-from-start-10` — `tw-animate-css` ships the logical variants). The three call sites were
updated. This is where shadcn upstream is heading anyway: its transformer already contains
`data-[side=inline-start]` rules. Asserted in unit tests **and** measured in the browser (§6).

---

## 4. Directional icon mirroring — **P2B-D2**

§4.2 step 3 names `rtl:rotate-180`. That utility is correct **only for glyphs symmetric about the
horizontal axis**. Rotating `ArrowUpRight` by 180° points it **down-left** — a different icon, not a
mirrored one. Two utilities were used, and the distinction is enforced by the gate's failure message:

| Mirror | Applied to | Why |
|---|---|---|
| `rtl:rotate-180` | `ChevronLeft/Right`, `ArrowLeft`, `LogIn`, `LogOut` | Symmetric about the horizontal axis, so a half-turn **is** the horizontal flip |
| `rtl:-scale-x-100` | `ArrowUpRight` (nav), `Send`, `ExternalLink` | Diagonal/asymmetric — needs a true horizontal flip |

**29 icons across 16 files.** Two files already handled themselves (§2) and were left alone.

**Deliberately not mirrored (P2B-O1):** the `ArrowUpRight` / `ArrowDownRight` **trend deltas** in
`components/dashboard/revenue-widget.tsx`. "Up and to the right" means *rising over time*, in the
chart's coordinate space — and charts stay LTR by design (§4.2 step 4). Mirroring them would point
growth backwards. Each carries an `rtl-allow:` comment at the point it applies, so the exception is a
decision on the record rather than an oversight. The gate found both on its own before they were
annotated, which is the check doing its job.

Recharts internals were **not touched** (§4.2 step 4) — no chart file appears in the diff.

---

## 5. The CI gate

`scripts/check-logical-properties.mjs` — `pnpm lint:rtl`, wired into `.github/workflows/ci.yml`
directly after `pnpm lint`.

It fails on:
- **physical-direction utilities** — `ml-/mr-/pl-/pr-`, `left-/right-`, `text-left/right`, `border-l/r`,
  `rounded-l/r/tl/tr/bl/br`, `float-`, `clear-`, `scroll-m*/p*` (with the lookaheads that keep
  `rounded-lg` and `border-red-500` from being false positives);
- **physical CSS longhands** — `margin-left`, `padding-right`, `border-left`, `text-align: left|right`,
  the corner-radius longhands, and their camelCase style-object forms;
- **directional icons with no RTL mirror.**

Exceptions must be *documented*, never silent: an inline `rtl-allow: <reason>` comment, or an entry in
`scripts/rtl-allowlist.json`. **The allowlist file is empty** — every exception in the product today is
an inline comment sitting next to the code it excuses.

```
✓ RTL gate: no undocumented physical-direction styles (289 files scanned · 2 documented exceptions).
```

A gate that only ever returns green is indistinguishable from a gate that does nothing, so the test
suite **plants real violations and requires the gate to fail on them** — a physical class, and an
un-mirrored `<ChevronRight>` — then requires it to pass once the mirror is added.

> ### Amendment — the gate as it stands after P2B-R1 / P2B-R2 (closed at the top of P2C, 2026-07-14)
>
> The P2B phase review (`docs/reviews/P2B_PHASE_REVIEW.md`) found **two blind spots in this gate**, and
> both are now closed. The description above is P2B's as-delivered state; this is the current one.
> Full detail lives in `docs/reviews/P2C_REVIEW.md` §1.
>
> - **P2B-R1** — `ToggleLeft` / `ToggleRight` joined `DIRECTIONAL_ICONS`, and the four live call sites
>   (`components/settings/department-actions.tsx`, `components/settings/insurance-actions.tsx`) were
>   mirrored with `rtl:-scale-x-100`, matching the `Switch` widget they depict. The icon list is now 31
>   icons across 17 files.
> - **P2B-R2** — `CSS_RULES` gained bare `left:` / `right:` entries, so the gate now catches the physical
>   longhand its own header comment always claimed to catch.
> - **The widened gate found six real sites.** They were **fixed, not waived**: the auth brand panel's
>   six decorative inset values became `insetInlineStart` / `insetInlineEnd`, and the print header's
>   symmetric `left: 0; right: 0` became `inset-inline: 0`.
> - **Exception list: 2 → 6 lines** (10 rule hits). The two revenue trend arrows are unchanged (**P2B-O1**);
>   the four new ones are Recharts `margin` props, which are chart-space geometry rather than page layout
>   (§4.2 step 4). All six are inline `rtl-allow:` comments; the allowlist file is still empty.
> - **Both new rules carry negative tests** in `tests/unit/lib/p2b-rtl-retrofit.test.ts` (10 → 15 tests):
>   an unmirrored toggle glyph fails; a bare `left:` in a JSX style object fails; a bare `right:` in
>   hand-written CSS fails; each passes once converted.

---

## 6. Full layout validation, LTR and RTL

The retrofit's entire risk profile is that **it is invisible in English**: `pe-4` and `pr-4` render
identically under `dir="ltr"`, so the whole English suite — snapshots included — stays green whether
the conversion is right, wrong, or absent. The four new browser tests are therefore the only ones that
can fail on a bad retrofit. They read **computed geometry**, not class names.

| Test | What it actually measures |
|---|---|
| `P2B: every high-traffic page is direction-safe` | On **`/dashboard`, `/patients`, `/appointments`, `/settings/staff`, `/revenue`**: in `en` the sidebar's bounding box hugs the left edge; after switching the account to `ar` the **same** sidebar must cross to the right edge. And on every page, in **both** directions, `scrollWidth - clientWidth ≤ 1` — horizontal overflow is how a missed physical property announces itself. |
| `P2B: logical properties and directional icons actually resolve` | The calendar's next-day chevron computes `rotate: none` in `en` and **`rotate: 180deg`** in `ar`. A probe element carrying `ms-4 pe-8 text-end rtl:-scale-x-100` computes, under `dir=rtl`, `margin-right: 16px` / `margin-left: 0`, `padding-left: 32px` / `padding-right: 0`, `text-align: right`, `scale: -1 1` — i.e. the logical utilities genuinely mirror. |
| `P2B: the mobile nav drawer opens from the inline start` | At 390×844 the drawer hugs the **left** edge in `en` and the **right** edge in `ar`, from the *same* `side="inline-start"`. A physical `side="left"` would leave it exactly where it was — this is the test that would have caught **P2B-F2**. |
| `P2B: the marketing site is direction-safe` | The anonymous landing page does not scroll horizontally in either direction. |

---

## 7. Commands run and exact results

| # | Command | Result |
|---|---|---|
| 1 | `pnpm lint:rtl` (the new gate) | ✅ **PASS** — 289 files, 0 undocumented, 2 documented exceptions |
| 2 | `pnpm typecheck` | ✅ **PASS** — clean |
| 3 | `pnpm lint` | ✅ **PASS** — **0 errors, 4 warnings**, all pre-existing and unchanged from the P2A baseline |
| 4 | `pnpm test` (unit) | ✅ **PASS** — **113 files, 593 tests** (P2A: 112 / 583 → +1 file, +10 tests) |
| 5 | `pnpm test:integration` | ✅ **PASS** — **13 files, 91 tests** — identical to P2A. P2B has no migration; the RLS surface is untouched |
| 6 | `pnpm build` | ✅ **PASS** — **2 static routes** (`robots.txt`, `sitemap.xml`), every page route dynamic — identical to P2A |
| 7 | `pnpm test:e2e` (`PORT=3100`) | ✅ **PASS** — **36/36** (P2A: 32/32 → +4 P2B RTL tests) |
| 8 | `git diff --check` | ✅ **Clean** |
| 9 | `git status -- docs/reviews/assets/pre-p2-ws5/` | ✅ **Empty** — see §9 |
| 10 | `git status -uall -- Thmanyah-Font-Family/` | ✅ **Empty** — nothing tracked, nothing stageable |
| 11 | Font binaries visible to git | ✅ **Exactly the five WOFF2** under `app/fonts/thmanyah/` — the P2A-G1 allowlist is intact and untouched |

**Two snapshots were updated** (`tests/unit/components/__snapshots__/dashboard-shell.test.tsx.snap`) and
this deserves to be stated precisely, because "English UI unchanged in LTR (snapshots)" is a P2B
acceptance criterion. The snapshots capture **class strings**, and the class strings changed
(`has-data-[icon=inline-end]:pr-2` → `pe-2`). The **rendering did not**: compiled against Tailwind v4.2.2,
`pe-2` emits `padding-inline-end`, which resolves to `padding-right` under `dir="ltr"` — the exact
declaration `pr-2` emitted. The delta is confined to those two class tokens; no element, attribute, or
structure moved. LTR computed layout is unchanged.

---

## 8. Acceptance-criteria matrix (§8, P2B "Tests/acceptance")

| Criterion | Status | Evidence |
|---|---|---|
| CI grep-gate green — zero physical-direction classes outside the documented exception list | ✅ | §5; 2 exceptions, both inline-documented, allowlist file empty |
| English UI unchanged in LTR (snapshots) | ✅ | §7 — full suite green; the 2 snapshot updates are class renames whose compiled CSS is identical in LTR |
| Spot-check RTL rendering on the 5 highest-traffic pages | ✅ **exceeded** | §6 — not a spot-check but a measured assertion of sidebar geometry + zero horizontal overflow on all 5, in both directions |
| No migration | ✅ | none added |
| P2A locale/theme behavior preserved | ✅ | all P2A unit + e2e locale/theme tests green; `user_ui_preferences` RLS suite 10/10 |
| P2C not started | ✅ | no string extracted, no Arabic copy added |

---

## 9. The WS5 screenshot trap re-fired, and was contained

As the P2A phase review predicted, `pnpm test:e2e` overwrote the 13 tracked review artifacts in
`docs/reviews/assets/pre-p2-ws5/`. They are **Pre-P2 WS5** evidence, not a P2B deliverable.

Their committed bytes were captured from the `HEAD` blobs **before** the e2e run and written back
**after** the final run (sequencing matters — a restore before the last run would simply be undone).
`git status -- docs/reviews/assets/pre-p2-ws5/` is empty and `git diff` reports no change: they are
byte-identical to the committed content and absent from the P2B diff.

**The underlying trap is unchanged**: a tracked `docs/` path is still being used as a test output
directory, and it will re-fire in P2C. Redirecting it to an untracked output directory remains the right
fix and remains out of P2B's scope.

---

## 10. Files changed

**New**
- `scripts/check-logical-properties.mjs` — the CI gate (physical classes, physical CSS longhands, un-mirrored icons);
- `scripts/rtl-allowlist.json` — the documented exception list (**empty**, by design);
- `scripts/rtl-codemod.mjs` — the logical-properties codemod (wraps shadcn's own transformer; strips the v4 double-flip);
- `tests/unit/lib/p2b-rtl-retrofit.test.ts` — 10 tests, incl. the gate's negative tests.

**Modified — configuration**
- `components.json` — `"rtl": true`;
- `package.json` — `lint:rtl`, `rtl:codemod`;
- `.github/workflows/ci.yml` — the gate runs after `pnpm lint`.

**Modified — product code**
- 49 files rewritten by the codemod (22 `components/ui/*` primitives + 27 app-owned components/routes);
- `components/ui/sheet.tsx` + its 3 call sites — the logical side model (**P2B-F2**);
- 16 files — directional icon mirroring (29 icons);
- `components/dashboard/revenue-widget.tsx` — the 2 documented `rtl-allow` exceptions;
- `app/globals.css` — the print block's `padding-left/right: 0` → `padding-inline: 0`.

**Tests**
- `tests/e2e/smoke.spec.ts` — 4 new P2B RTL tests;
- `tests/unit/components/__snapshots__/dashboard-shell.test.tsx.snap` — 2 snapshots, class renames only (§7).

---

## 11. Open items (stable IDs)

| ID | State | Note |
|---|---|---|
| **P2B-D1** | Accepted deviation — recorded | shadcn primitives converted **in place** by shadcn's own transformer rather than by `--overwrite`, which would have destroyed substantive local customizations (incl. a Pre-P2 WS2 deliverable). Same transform, customizations kept. `components.json` is flipped, so future `shadcn add` is RTL-correct. §3. |
| **P2B-D2** | Accepted deviation — recorded | Icon mirroring uses **two** utilities, not the one §4.2 names. `rtl:rotate-180` is wrong for diagonal glyphs. §4. |
| **P2B-F1** | **Closed in this change** | shadcn's transformer double-flips `space-x-*`/`divide-x-*` on Tailwind v4. Stripped by the codemod; guarded by a unit test. **Worth reporting upstream.** §3. |
| **P2B-F2** | **Closed in this change** | shadcn's transformer leaves `Sheet` pinned physically while flipping its border. Fixed by moving `Sheet` to a logical side model. §3. |
| **P2B-O1** | Open — deliberate | The 2 trend arrows in `revenue-widget.tsx` are **not** mirrored: they live in the chart's coordinate space, which stays LTR by design (§4.2 step 4). Inline-documented. §4. |
| **P2A-O2** | **Open — carried into P2C** | Arabic has no 600 weight, so every `font-weight: 600` (all `h1`–`h6`, `font-semibold`) resolves to the **700** face: Arabic headings render heavier than their Latin counterparts. P2B confirms the layout is direction-safe; it does **not** close this, which is a *visual-parity* judgement that needs real Arabic copy to assess. It belongs to **P2C's visual QA**, exactly where P2A filed it. |
| **P2A-L1** | Open — founder's, by decision | Unchanged by P2B. The licensed faces remain publicly fetchable via `next/font/local`. Retire with a written grant (`ask@thmanyah.com`). |
| **P2A-O1** | Open — deliberate | Zod error map still not globally registered; lands in P2C with the schema/consumer migration. Untouched by P2B. |
| **P2A-O3** | Open — pre-existing | The `p1c-signup.spec.ts` flake did **not** recur: 36/36 clean. |

---

## 12. Explicitly unchanged by P2B

- **No migration, no schema change, no RLS change.** The integration suite is identical to P2A's (13 files / 91 tests).
- **No string was extracted and no Arabic copy was added** — that is P2C. `messages/*.json` carry only the keys P2A introduced.
- **Recharts internals stay LTR by design** (§4.2 step 4). No chart file is in the diff.
- **P2A's locale and theme behavior is intact**: resolution `user → en`, no clinic tier, the three switchers, the anonymous marketing cookie's independence, and theme-follows-the-user.
- The marketing site stays Light and the auth pages stay Dark.
- The **font allowlist is untouched** and `Thmanyah-Font-Family/` remains outside git entirely.
- Middleware, RBAC, billing, entitlements, and every patient/appointment/report data path are untouched.

**Verdict: IMPLEMENTED — awaiting comprehensive review.** Nothing was committed, pushed, merged, staged,
reset, restored, cleaned, or stashed.
