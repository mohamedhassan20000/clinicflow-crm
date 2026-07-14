# P2B Comprehensive Phase Review — RTL Retrofit, shadcn RTL Configuration, Icon Mirroring, CI Direction Gate

**Reviewer:** independent review pass (Claude)
**Review date:** 2026-07-14
**Review cycle:** 1
**Branch:** `feat/p2a-i18n-infrastructure` — the P2 integration branch (base `3b16157`; P2A + P2B both uncommitted)
**Scope reviewed:** P2B only. P2C was not implemented and was not expected to be.
**Implementation record under review:** `docs/reviews/P2B_REVIEW.md` (Review Cycle 1)

**No code was modified by this review.** Nothing was committed, staged, pushed, merged, reset, restored,
cleaned, or stashed. The working tree is byte-identical to the state I found it in (83 modified / 24
untracked, verified by checksum — see §5).

---

## Final verdict

> ## ✅ APPROVED AFTER MINOR FIXES

**Another full review cycle is NOT required.** Every P2B deliverable is correct, and every claim in
`P2B_REVIEW.md` that I tried to break held up — including the two that are easiest to fake and were not
faked (**P2B-F1** and **P2B-F2** are real bugs in shadcn's transformer, and I reproduced both from first
principles rather than taking the record's word). The retrofit itself is sound: **zero** physical-direction
styles survive my own independent grep, and RTL geometry is correct on every surface I measured, including
one the implementation never tested.

The findings below are **all in the gate, not in the retrofit** — two live blind spots in
`check-logical-properties.mjs` that let a directional style through today. They matter because the gate is
the artifact **P2C inherits**: P2C lands ~1,000–1,500 strings and a lot of new markup, and it is the phase
where a blind gate does the most damage. Both fixes are a few lines. They can be verified by re-running
`pnpm lint:rtl` and `pnpm test` — no re-review of the product code is warranted.

| ID | Severity | Title | Blocks P2C? |
|---|---|---|---|
| **P2B-R1** | MINOR | `ToggleLeft` / `ToggleRight` are directional, are used, and are invisible to the gate — neither mirrored nor documented, while the `Switch` they depict *does* flip in Arabic | No — fix before P2C leans on the gate |
| **P2B-R2** | MINOR | The gate does not catch physical CSS `left:` / `right:` longhands, though its own header comment claims it does | No — same |
| **P2B-R3** | INFO | `bg-gradient-to-r` (2 uses) is a physical direction the gate does not cover; cosmetic only | No |
| **P2B-R4** | INFO | The repo's horizontal-overflow assertion is structurally weaker than §6 claims (it measures through an `overflow-x-hidden` clip). I re-measured with a clipping-immune method: **the property genuinely holds** | No |
| **P2B-R5** | INFO | The RTL e2e set omits the operator surface, print/report pages, dialogs, and the `inline-end` sheet. I verified the operator surface myself — **green** | No |

**Confirmed and closed by this review:** **P2B-D1**, **P2B-D2**, **P2B-F1**, **P2B-F2**, **P2B-O1** — all
five are accurately characterized in the record. See §2.

---

## 1. Independent verification results

Everything here I verified against the code, a real Tailwind v4 compile, or a real browser — not by reading
`P2B_REVIEW.md`. Where the record made a claim, I tried to break it.

| # | Item required to be verified | Result | How I verified it |
|---|---|---|---|
| 1 | **All physical-direction CSS conversions** | ✅ **Complete** | I ran **my own** grep — deliberately broader and independent of their gate's regexes — across `app`, `components`, `lib`, `hooks`, `contexts` for `ml-/mr-/pl-/pr-`, `left-/right-`, `text-left/right`, `border-l/r-`, `rounded-{l,r,tl,tr,bl,br}-`, `float-left/right`, `space-x-reverse`, `divide-x-reverse`. **0 hits.** The conversion is genuinely complete, not merely gate-clean. |
| 2 | **The CI grep gate** | ✅ Correct, with two blind spots | `pnpm lint:rtl` runs `scripts/check-logical-properties.mjs`, wired into `.github/workflows/ci.yml` directly after `pnpm lint`. Re-ran it myself: `✓ 289 files scanned · 2 documented exceptions`, exit 0. The lookaheads that keep `rounded-lg` and `border-red-500` from false-positiving are present and correct. Blind spots → **P2B-R1**, **P2B-R2**. |
| 3 | **Both documented exceptions** | ✅ Correct, and correctly reasoned | Exactly 2, both inline `rtl-allow:` comments in `components/dashboard/revenue-widget.tsx:109,112` — the `ArrowUpRight`/`ArrowDownRight` trend deltas. `scripts/rtl-allowlist.json` is **empty** (`files: []`), as claimed. The reasoning is right: these live in the chart's LTR coordinate space (§4.2 step 4), and mirroring them would point growth backwards. |
| 4 | **shadcn RTL transformer usage** | ✅ Correct | `scripts/rtl-codemod.mjs` locates shadcn's transformer in the CLI's dist bundle by a marker from its class-mapping table (`["ml-","ms-"]`) and **throws loudly** if a shadcn upgrade moves it — it does not silently convert nothing. `components.json` is flipped to `"rtl": true`, so future `shadcn add` is RTL-correct. |
| 5 | **Preservation of local shadcn customizations** | ✅ Preserved | I read the **entire** `components/ui/*` diff hunk by hunk. Every hunk is a class-token rewrite — no logic, prop, import, or structure changed anywhere. `sheet.tsx` keeps its `XIcon` swap; `button.tsx` keeps its variants (only the `pr-`/`pl-` inside `size` changed); **`table.tsx` does not appear in the diff at all**, confirming the Pre-P2 WS2 rewrite had already removed its physical classes. `--overwrite` would indeed have destroyed all of this. **P2B-D1 is a correct call.** |
| 6 | **Tailwind v4 `space-x-*` handling (P2B-F1)** | ✅ **Reproduced independently** | I compiled the candidates against the repo's own **Tailwind v4.2.2** and read the emitted CSS. `space-x-2` → `margin-inline-start` / `margin-inline-end` (**already logical — it flips with `dir` on its own**); `rtl:space-x-reverse` → `--tw-space-x-reverse: 1`, which swaps start/end on an already-flipped property. That is a genuine **double flip**. Same for `divide-x-*` → `border-inline-*-width`. The finding is real, the diagnosis is exactly right, and the codemod's `stripDoubleFlips()` is the correct fix. Tree-wide: **0** occurrences of `rtl:space-x-reverse` / `rtl:divide-x-reverse`, and `-space-x-2` correctly survives in `avatar.tsx`. |
| 7 | **Sheet logical-side behavior (P2B-F2)** | ✅ Correct, and the fix is the right one | `SheetContent` takes `"top" \| "bottom" \| "inline-start" \| "inline-end"` (default `inline-end`); positions (`start-0`/`end-0`), borders (`border-e`/`border-s`) **and** slide animations all key off logical sides. I verified the animations are not dead classes: **`tw-animate-css@1.4.0` really does ship `slide-in-from-start/end` and `slide-out-to-start/end`.** All **3** call sites use logical sides (`dashboard-shell.tsx` → `inline-start`; `staff-profile-sheet.tsx`, `add-staff-dialog.tsx` → `inline-end`). Measured in a real browser: the drawer hugs the left edge in `en` and the **right** edge in `ar` from the same `inline-start`. |
| 8 | **Icon mirroring — `rotate-180` only where geometrically correct** | ✅ Correct | I enumerated **every** mirror in the tree. `rtl:rotate-180` is applied only to `ChevronLeft`, `ChevronRight`, `ArrowLeft`, `LogIn`, `LogOut` — all symmetric about the horizontal axis, so a half-turn **is** the horizontal flip. No diagonal glyph carries `rotate-180`. |
| 9 | **Icon mirroring — `scale-x` for diagonal glyphs** | ✅ Correct | `rtl:-scale-x-100` is applied to exactly the diagonal/asymmetric glyphs: `ArrowUpRight` (marketing nav ×3), `Send` (note composer), `ExternalLink` (doctor queue). **P2B-D2 is right and the record's reasoning is right**: rotating `ArrowUpRight` 180° points it *down-left* — a different icon, not a mirrored one. `page-header.tsx` uses the third legitimate form (`rtl:hidden` / `rtl:block` glyph swap). |
| 10 | **Sidebar placement in RTL** | ✅ Correct — measured | `sidebar.tsx` carries `border-e` and is placed first in the flex row, so `dir` alone moves it. Measured on all 5 high-traffic pages: bounding box hugs the **left** edge in `en`, crosses to the **right** edge in `ar`. I also confirmed `inset-e-1.5` (used by the collapsed-rail chevron) is a **real** Tailwind v4 utility — it compiles to `inset-inline-end`, not a dead class. |
| 11 | **Dialogs, drawers, tables, forms, calendars, reports in RTL** | ✅ Correct — measured where reachable, sound by construction elsewhere | Tables (`/patients`, `/settings/staff`), calendars (`/appointments`), reports (`/revenue`), forms and the patient detail/report page all render direction-safe in `ar` (§4). Drawer measured (item 7). **Dialogs verified statically but rigorously**: `start-1/2` + `-translate-x-1/2 rtl:translate-x-1/2` — I confirmed from the compiled CSS that `.rtl\:translate-x-1\/2` is emitted **after** `.-translate-x-1\/2`, so it wins the cascade tie, and `start-1/2` resolves to `inset-inline-start: 50%`. The dialog stays centred in both directions (centring is direction-symmetric anyway). |
| 12 | **Operator pages in RTL** | ✅ **Green — but I had to test it myself** | Not covered by any repo test (**P2B-R5**). I drove the operator through its header switcher into Arabic and measured `/operator`, `/operator/clinics`, `/operator/reports`: `dir=rtl`, sidebar at **x=992 of a 1280 viewport** (correctly flipped to the right edge), zero overflow on all three. |
| 13 | **No horizontal overflow in LTR or RTL** | ✅ **Holds — verified with a stronger measure than the repo's** | See **P2B-R4**. The repo's assertion reads `documentElement.scrollWidth - clientWidth`, but the shell's `<main>` is `overflow-x-hidden` ([dashboard-shell.tsx:112](../../components/layout/dashboard-shell.tsx#L112)), which **clips** content overflow so it can never reach the document. I re-measured with `getBoundingClientRect()` — immune to that clipping, since clipping is a paint effect, not a layout effect — walking every element in `main` on all 5 pages plus the operator surface, in `ar`. **Worst escape past the viewport: 0px.** Nothing overflows. The property is true; the repo's *evidence* for it is weaker than §6 claims. |
| 14 | **No P2C string extraction or translation work** | ✅ Correctly absent | `useTranslations`/`getTranslations` appear in exactly **3** files — the P2A switcher mounts (`app/page.tsx`, `app/(protected)/preferences/page.tsx`, `app/(operator)/layout.tsx`). `messages/en.json` and `messages/ar.json` are 22 lines each and carry **only** the `language.*` and `validation.*` keys P2A introduced. No UI string was extracted; no Arabic copy was added. |
| 15 | **No schema or migration changes** | ✅ None | `supabase/migrations/` contains exactly one new file — P2A's `20260714120000_p2a_user_ui_preferences.sql`. No migration is modified. The integration suite is byte-identical in shape to P2A's (13 files / 91 tests), which is what you would expect from an untouched RLS surface. |
| 16 | **Preservation of all P2A locale/theme behavior** | ✅ Intact | All four P2A e2e behaviors pass in my own full run: the language switcher really switches and one account's language reaches no other; theme follows the user, not the browser; the anonymous marketing locale is independent of every account; the operator header keeps its language slot while clinic users keep Preferences. The `user_ui_preferences` RLS suite is green against a live database. |
| 17 | **WS5 screenshot artifacts absent from the final diff** | ✅ **Absent — and I re-proved the trap is still live** | `git status -- docs/reviews/assets/pre-p2-ws5/` is empty in the tree as delivered. I then ran `pnpm test:e2e` myself: **the suite immediately dirtied all 13 tracked PNGs again**, exactly as §9 predicts. I restored them from a byte-exact pre-run copy (checksum `e3d53c0a…` before and after). §9's containment claim is true, **and** its warning that the trap will re-fire in P2C is confirmed by direct observation. |
| 18 | **Full validation evidence** | ✅ **Every command re-run and reproduced** | See §5. All 8 figures in the record's §7 match what I got, including the exact test counts. |

---

## 2. The record's own findings — all five confirmed

I treated §3 and §4 of `P2B_REVIEW.md` as claims to be broken, not as reporting.

- **P2B-D1** (primitives converted in place, not regenerated) — **confirmed a correct deviation.** The local
  primitives really are no longer generated code, `--overwrite` really would have destroyed substantive work
  (§1 item 5), and applying shadcn's *own* transformer to the local file really is the same rewrite with the
  customizations kept. Reusing the CLI's transformer rather than re-implementing the mapping is the right
  engineering call, and locating it by a content marker that **throws** on a shadcn upgrade is the right way
  to do a fragile thing safely.
- **P2B-D2** (two mirror utilities, not one) — **confirmed correct, and the plan's §4.2 step 3 was wrong.**
  `rtl:rotate-180` alone would have shipped a down-left `ArrowUpRight`. Verified: no diagonal glyph carries a
  rotation, and no symmetric glyph carries a scale.
- **P2B-F1** (Tailwind v4 `space-x-*` double flip) — **reproduced from the compiled CSS.** Real bug in
  shadcn's transformer. Correctly stripped and correctly guarded by a unit test. **Worth reporting upstream**,
  as the record says.
- **P2B-F2** (Sheet pinned physically, border flipped) — **confirmed.** And the fix chosen is better than the
  fix that was available: an allowlist would have silenced the symptom, whereas `side` genuinely *was* the
  wrong model — a physical `left` cannot express "beside the sidebar" in a bidirectional app. The e2e test
  written for it is the one test in the suite that would actually have caught the original bug.
- **P2B-O1** (revenue trend arrows deliberately unmirrored) — **confirmed, and correctly reasoned.** The two
  exceptions are inline-documented at the point they apply, which is where a reader will actually see them.

The re-measured inventory (**48 files / 131 flagged lines**, vs. the stale 87/339) is consistent with
everything I observed, and the record's parenthetical honesty about it being a file/line measure rather than
a token census is the kind of thing that makes the rest of the document trustworthy.

---

## 3. Findings

### P2B-R1 — MINOR — `ToggleLeft` / `ToggleRight` are directional, live, and invisible to the gate

The gate's `DIRECTIONAL_ICONS` list is complete for the current tree with **one exception**. I enumerated
every capitalized JSX tag in `app` and `components` and cross-checked it against the list:

```
components/settings/department-actions.tsx:116   <ToggleRight className="h-4 w-4 text-emerald-600" />
components/settings/department-actions.tsx:118   <ToggleLeft  className="h-4 w-4 text-muted-foreground" />
components/settings/insurance-actions.tsx:118    <ToggleRight className="h-4 w-4 text-emerald-600" />
components/settings/insurance-actions.tsx:120    <ToggleLeft  className="h-4 w-4 text-muted-foreground" />
```

These are lucide's **switch glyphs** — a track with the knob rendered on one side — used as the active/inactive
state indicator in the departments and insurance row menus. They are directional by construction. They are
**not** in `DIRECTIONAL_ICONS`, so the gate never flagged them; they are **not** mirrored; and they are **not**
in the documented exception list. The decision was never made, which is precisely the failure mode the gate
exists to prevent.

What makes this more than pedantry: **P2B correctly made the real `Switch` flip in Arabic** —
`components/ui/switch.tsx` gained `rtl:…:-translate-x-[calc(100%-2px)]`, and I confirmed from the compiled CSS
that the `rtl:` rule is emitted after the base rule and wins. So in Arabic the actual toggle widget moves its
knob to the correct side, while the icon *depicting that same widget*, two clicks away in a menu, does not.
The two now disagree.

Either resolution is defensible and both are cheap — mirror them with `rtl:-scale-x-100`, or add an
`rtl-allow:` comment recording that a toggle glyph is a fixed pictogram. What is not defensible is that the
gate cannot see them. **Add `ToggleLeft`/`ToggleRight` to `DIRECTIONAL_ICONS` and then make the call.**

### P2B-R2 — MINOR — the gate does not catch physical CSS `left:` / `right:`, though it says it does

`scripts/check-logical-properties.mjs` opens by stating what it fails on:

> *"Physical utilities (ml-, pr-, left-, text-right, border-l, rounded-tl, …) and physical CSS
> **longhands (margin-left, padding-right, left:, text-align: right, …)**"*

`CSS_RULES` has entries for `margin-left/right`, `padding-left/right`, `border-left/right`, `text-align`, the
corner-radius longhands, and the camelCase style-object forms — but **no rule for a bare `left:` / `right:`
declaration.** The `left-*` entry in `CLASS_RULES` is the *Tailwind class* form (`(?<![\w-])-?left-(?=(\d|px|full|auto|\[))`)
and does not match `left: 24px`.

This is not hypothetical. `app/globals.css` already contains one, inside the print block:

```css
/* app/globals.css:847-853 — .print-compact-header */
position: fixed;
top: 0;
left: 0;
right: 0;
```

The gate scanned that file and reported it as neither a violation nor a documented exception — it simply did
not see it. **Here it is harmless**: `left: 0` with `right: 0` is direction-symmetric (equivalent to
`inset-inline: 0`), so the print header spans the page correctly in both directions. But a future
`left: 24px` in `globals.css` — or in any CSS P2C adds — ships silently, in the one file type where a physical
longhand is most likely to be hand-written.

Two regex entries close it. Recommend also allowing the symmetric `left: 0; right: 0` idiom via an
`rtl-allow:` comment rather than rewriting the print block, since it is correct as written.

### P2B-R3 — INFO — `bg-gradient-to-r` is a physical direction the gate does not cover

Two uses, both decorative:

- `components/auth/login-form.tsx:160` — the sign-in button's gradient fill. Full-width button; direction is
  invisible.
- `components/dashboard/revenue-widget.tsx:143` — a progress bar. The bar itself is correct in RTL (`start-0`
  + a `width: %`, so it fills from the inline start), but the gradient inside it still runs left→right, so in
  Arabic the brighter stop lands at the far end rather than the origin.

Both stops are the same hue at 70%/50% opacity, so the visual difference is close to nil. **No action
required** — recorded so it is a known, rather than a discovery in P2C's visual QA. If the gate is extended,
`bg-gradient-to-r|l` (and `bg-linear-to-r|l` in v4 syntax) is the natural place.

### P2B-R4 — INFO — the overflow assertion is weaker than §6 claims; the property still holds

§6 and §8 present *"`scrollWidth - clientWidth ≤ 1` on every page in both directions"* as the strong evidence —
*"not a spot-check but a measured assertion."* The measurement is taken on `document.documentElement`. But the
shell wraps all page content in `<main className="flex-1 overflow-x-hidden …">`
([dashboard-shell.tsx:112](../../components/layout/dashboard-shell.tsx#L112)), and `overflow-x-hidden`
**clips** horizontal overflow rather than propagating it. Content that overflows inside `main` can therefore
never raise `documentElement.scrollWidth`, and the assertion cannot fail on it. For the five protected pages,
that assertion is close to vacuous. (It remains meaningful on the marketing page, which has no such wrapper.)

I did not leave this as a suspicion. I re-measured every element inside `main` with `getBoundingClientRect()`,
which reports true layout geometry regardless of ancestor clipping, on all five pages plus the three operator
pages, under `dir=rtl`:

```
RTL /dashboard      main=0  doc=0  worstEscape=0px
RTL /patients       main=0  doc=0  worstEscape=0px
RTL /appointments   main=0  doc=0  worstEscape=0px
RTL /settings/staff main=0  doc=0  worstEscape=0px
RTL /revenue        main=0  doc=0  worstEscape=0px
RTL patient detail  main=0  doc=0  worstEscape=0px
```

**Nothing overflows in RTL.** The retrofit is genuinely clean. The finding is about the *test*, not the app:
if a future change did push content past the viewport in Arabic, it would be clipped and invisible, and this
test would still be green. Swapping the probe to `main.scrollWidth - main.clientWidth` — or to the
bounding-box walk above — would make it able to fail. Worth doing in P2C, where new markup lands.

### P2B-R5 — INFO — the RTL e2e set omits the operator surface, dialogs, and the `inline-end` sheet

The four new browser tests cover the five clinic pages, the mobile drawer, and marketing. They do **not**
open a dialog under `dir=rtl`, do not open either `inline-end` sheet under `dir=rtl`, and do not visit the
**operator** surface in Arabic at all — even though the operator has its own language switcher (P2A), its own
layout, and its own modified page (`app/(operator)/operator/page.tsx` is in the diff).

I closed the operator gap myself. Driving the operator into Arabic through its header switcher:

```
/operator          dir=rtl  sidebar x=992 (vw=1280 → flipped to the right edge)  overflow=0  escape=0
/operator/clinics  dir=rtl  sidebar x=992                                        overflow=0  escape=0
/operator/reports  dir=rtl  sidebar x=992                                        overflow=0  escape=0
```

**Green.** The operator surface is direction-safe; it just was not proven to be. Dialogs and the `inline-end`
sheet I verified by construction rather than by measurement (§1 items 7, 11) — both mechanisms are proven
(the `inline-start` drawer test exercises the identical code path with the opposite token, and the dialog's
cascade order I read out of the compiled CSS), so I am not asserting a defect. Adding `/operator` to
`RTL_PAGES` is a one-line change and closes the only surface with its own shell that nothing covers.

---

## 4. What I measured in a real browser

Beyond re-running the repo's own suite, I drove Chromium against a live local stack to test the claims the
suite does not make. All under `dir="rtl"` with a real account switched through the real control.

| Surface | Measured | Result |
|---|---|---|
| `/dashboard`, `/patients`, `/appointments`, `/settings/staff`, `/revenue` | sidebar bounding box; `main` scroll overflow; worst element escape past the viewport | ✅ sidebar crosses to the right edge; **0px** overflow, **0px** escape |
| Patient detail + report path | same | ✅ 0 / 0 |
| `/operator`, `/operator/clinics`, `/operator/reports` | same (**not covered by any repo test**) | ✅ sidebar at x=992 / vw=1280; 0 / 0 |
| Mobile nav drawer @ 390×844 | drawer edge in `en` vs `ar` from the same `side="inline-start"` | ✅ hugs left in `en`, right in `ar` |
| Calendar next-day chevron | computed `rotate` | ✅ `none` in `en`, `180deg` in `ar` |
| `ms-4 pe-8 text-end rtl:-scale-x-100` probe | computed margins/padding/align/scale under `dir=rtl` | ✅ mirrors exactly |
| Tailwind v4.2.2 compile | `space-x-*`, `divide-x-*`, `rtl:*-reverse`, `inset-e-*`, logical slides, switch/dialog cascade order | ✅ **P2B-F1 reproduced**; `inset-e-*` and the logical slide utilities confirmed real, not dead classes |

---

## 5. Validation evidence — every command re-run

Docker and the local Supabase stack were healthy. I re-ran the record's full §7 table rather than trusting it.
**Every figure reproduced exactly.**

| # | Command | Record's claim | My result |
|---|---|---|---|
| 1 | `pnpm lint:rtl` | PASS — 289 files, 0 undocumented, 2 exceptions | ✅ **PASS** — `289 files scanned · 2 documented exceptions`, exit 0 |
| 2 | `pnpm typecheck` | PASS — clean | ✅ **PASS** — clean |
| 3 | `pnpm lint` | PASS — 0 errors, 4 pre-existing warnings | ✅ **PASS** — 0 errors, **4 warnings**, all pre-existing (`react-hooks/incompatible-library`) |
| 4 | `pnpm test` (unit) | PASS — 113 files, 593 tests | ✅ **PASS** — **113 files, 593 tests** |
| 5 | `pnpm test:integration` | PASS — 13 files, 91 tests | ✅ **PASS** — **13 files, 91 tests** (identical to P2A; RLS surface untouched) |
| 6 | `pnpm build` | PASS — 2 static routes, all page routes dynamic | ✅ **PASS** — **2 static** (`robots.txt`, `sitemap.xml`), every page route `ƒ` |
| 7 | `pnpm test:e2e` (`PORT=3100`) | PASS — 36/36 | ✅ **PASS** — **36/36**, incl. all four P2B RTL tests |
| 8 | `git diff --check` | Clean | ✅ **Clean** |
| 9 | `git status -- docs/reviews/assets/pre-p2-ws5/` | Empty | ✅ **Empty** — and see §1 item 17: I re-fired the trap and restored it |
| 10 | Working tree unchanged by this review | — | ✅ **83 modified / 24 untracked**, identical to the state I found; `tests/e2e/smoke.spec.ts` verified byte-identical by md5 after my probes |

**On the two snapshot updates.** I checked the claim that they are class renames with no rendering change, and
it is exactly true: the entire diff of `dashboard-shell.test.tsx.snap` is `pr-2 → pe-2` and `pl-2 → ps-2`.
Under `dir="ltr"`, `pe-2` compiles to `padding-inline-end`, which resolves to `padding-right` — the same
declaration `pr-2` emitted. No element, attribute, or structure moved. **LTR is unchanged.**

**A note on the gate's negative tests.** §5 of the record claims the suite *"plants real violations and requires
the gate to fail on them."* It does — `tests/unit/lib/p2b-rtl-retrofit.test.ts` writes a real `.tsx` file
carrying `ml-4 text-right` into `components/`, asserts the gate exits **1** and names both the offence *and*
the fix, then plants an un-mirrored `<ChevronRight>`, asserts failure, and finally asserts the gate goes green
once the mirror is added. That is a gate that is actually tested, not decorated.

---

## 6. Acceptance-criteria matrix (§8, P2B "Tests/acceptance")

| Criterion | Verdict | Basis |
|---|---|---|
| CI grep-gate green — zero physical-direction classes outside the documented exceptions | ✅ **Met** | Re-run green. Independently re-grepped: 0 physical classes tree-wide. 2 exceptions, both inline; allowlist file empty. Two blind spots (**P2B-R1**, **P2B-R2**) do not affect this result — they are gaps in *future* coverage. |
| English UI unchanged in LTR (snapshots) | ✅ **Met** | Full suite green; the 2 snapshot deltas are class renames whose compiled CSS is byte-identical in LTR (§5). |
| Spot-check RTL rendering on the 5 highest-traffic pages | ✅ **Exceeded** | Measured geometry, not class names, on all 5 in both directions — plus the operator surface, which I added (§4). |
| No migration | ✅ **Met** | None added; none modified. |
| P2A locale/theme behavior preserved | ✅ **Met** | All P2A unit + e2e locale/theme tests green; `user_ui_preferences` RLS suite green against a live DB. |
| P2C not started | ✅ **Met** | 3 files use translations (the P2A switcher mounts); `messages/*.json` carry only P2A's keys. No string extracted, no Arabic copy added. |

---

## 7. What should happen before P2C

1. **P2B-R1** — add `ToggleLeft`/`ToggleRight` to `DIRECTIONAL_ICONS`, then either mirror the four call sites
   with `rtl:-scale-x-100` or record an `rtl-allow:` decision. (Recommend mirroring, for consistency with the
   `Switch` widget they depict.)
2. **P2B-R2** — add `left:` / `right:` longhand rules to `CSS_RULES`, and annotate the symmetric
   `left: 0; right: 0` in the print block with an `rtl-allow:` comment rather than rewriting it.
3. **P2B-R4 / P2B-R5** *(optional, cheap, and best done while the context is warm)* — point the overflow probe
   at `main` instead of `documentElement`, and add `/operator` to `RTL_PAGES`.
4. **P2B-R3** — no action; recorded as a known.

**Verification for 1–3 is `pnpm lint:rtl` + `pnpm test`.** No further phase review is required; confirm these in
the P2C review record.

**Carried into P2C, unchanged:** **P2A-O2** (Arabic has no 600 weight — headings resolve to the 700 face; a
visual-parity judgement that needs real Arabic copy, so it correctly belongs to P2C's visual QA),
**P2A-L1** (the founder's licensing decision), **P2A-O1** (the zod error map lands with P2C's schema
migration), **P2A-O3** (the `p1c-signup.spec.ts` flake did not recur — 36/36 clean in my run too).

**The standing WS5 trap is still live.** I confirmed by direct observation that `pnpm test:e2e` overwrites 13
tracked review artifacts in `docs/reviews/assets/pre-p2-ws5/` on every run, and that only a manual restore
keeps them out of the diff. P2B contained it correctly and correctly declared the fix out of scope — but this
is now the **third** phase carrying the same landmine, and it only takes one person forgetting the restore to
silently replace another sub-phase's approved evidence. **Redirect the screenshot output to an untracked
directory in P2C.**

---

## 8. Assessment

This is a genuinely strong sub-phase, and it is strong in the way that is hardest to fake: the two most
valuable things in it — **P2B-F1** and **P2B-F2** — are bugs in *someone else's* code that only surface in a
language nobody on the team reads, and both were found by not trusting the tool. The `space-x` double flip in
particular would have been invisible forever: English stays perfect, the class looks like the one shadcn's own
CLI writes, and the only symptom is a gap on the wrong side of an avatar stack in Arabic. Reaching for the
compiled Tailwind output to check whether v4 still needs a v3 workaround is the move that separates a retrofit
that works from one that merely passes.

The Sheet fix is the better story, though, because the easy fix was right there. An allowlist entry would have
made the gate green and left the bug in. Instead the implementer noticed that `side="left"` is *unrepresentable*
in a bidirectional app — that the model, not the class, was wrong — and changed the model. That is the kind of
call that a review can confirm but never manufacture.

My findings are correspondingly small, and they cluster in one place: **the gate is slightly less complete than
its own documentation claims.** It misses a directional icon that is on screen today, and it misses the CSS
longhand form its header comment promises to catch. Neither breaks Arabic now. Both matter *later*, because the
gate is the one P2B artifact whose entire job is to protect P2C — and P2C is 1,000+ strings and a great deal of
new markup written by people who will trust the green check. A gate is only worth what it catches on the day
someone stops paying attention.

Two things I want on the record as *not* wrong, because both look wrong at first glance and I checked:
`overflow-x-hidden` on `<main>` does hollow out the repo's overflow assertion — **but I re-measured with a
clipping-immune method and the app genuinely does not overflow in RTL**, so the retrofit is clean and only the
test is soft. And `inset-e-1.5` in the sidebar looks exactly like a hallucinated utility — **it is real**, and
it compiles to `inset-inline-end`.

**Verdict: ✅ APPROVED AFTER MINOR FIXES.** No further review cycle. P2C may proceed once **P2B-R1** and
**P2B-R2** are closed in the gate.
