# P2A Comprehensive Phase Review — i18n Infrastructure, `user_ui_preferences`, Thmanyah Typography

**Reviewer:** independent review pass (Claude)
**Review date:** 2026-07-14
**Branch:** `feat/p2a-i18n-infrastructure` (base `3b16157`, all work uncommitted)
**Scope reviewed:** P2A only. P2B and P2C were not implemented and were not expected to be.
**Implementation record under review:** `docs/reviews/P2A_REVIEW.md` (Review Cycle 1)

> **Cycle 2 (2026-07-14): every finding below is now CLOSED. The current verdict for P2A is ✅ APPROVED —
> see "Review Cycle 2" at the end of this file.** The Cycle 1 pass is preserved verbatim below, including its
> ❌ verdict, because the history of a review is part of its value. Read the Cycle 2 section for the live state.

## Final verdict — Cycle 1 (superseded by Cycle 2; preserved as history)

> ## ❌ CHANGES REQUIRED

**Another review cycle IS required** (Cycle 2), for two pre-commit blockers and one decision. No product
code defect was found — the blockers are **git packaging** and a **release-exposure decision**, and both
are cheap to close.

The engineering itself is strong. Every P2A behavioral claim I could verify independently held up,
including the ones that are easy to fake and were not faked: the font weights were read from the shipped
binaries, the RLS policies were read from the live database, and the zod deferral rationale was
confirmed against the real schemas. **No code was modified by this review.** Nothing was committed,
staged, pushed, reset, restored, cleaned, or stashed.

| ID | Severity | Title | Blocks commit? |
|---|---|---|---|
| **P2A-G1** | **BLOCKER** | `Thmanyah-Font-Family/` is untracked and un-ignored — `git add -A` commits 33 licensed font files (23 MB) into permanent history | **Yes** |
| **P2A-N1** | **HIGH — decision** | Arabic is selectable in production with no RTL retrofit and no Arabic strings; no gate exists | **Yes — needs an explicit decision** |
| **P2A-G2** | MEDIUM | 13 modified `pre-p2-ws5/*.png` are e2e test output, not P2A deliverables — must be excluded | Yes (exclude from commit) |
| **P2A-D1** | MINOR | Review §7 "52 static pages" misreads Next's build output | No |
| **P2A-D2** | MINOR | Review §2.2 font family-name claim does not match the files | No |
| **P2A-D3** | MINOR | Plan's P2A in-scope "zod message-key refactor" silently slipped to P2C | No |

Carried forward from Cycle 1, re-confirmed and unchanged: **P2A-L1**, **P2A-O1**, **P2A-O2**, **P2A-O3**, **P2A-O4**.

---

## 1. Independent verification results

Everything in this section I verified myself against the code, the binaries, the live database, or a
real build — not by reading `P2A_REVIEW.md`. Where the implementation record made a claim, I tried to
break it.

| # | Item required to be verified | Result | How I verified it |
|---|---|---|---|
| 1 | next-intl request configuration | ✅ Correct | `i18n/request.ts` exports `getRequestConfig`, wired via `createNextIntlPlugin("./i18n/request.ts")` and composed **inside** the Sentry wrapper (`next.config.ts`), so both plugins apply. Production build compiles. No `[locale]` URL segment, so no route changed path. |
| 2 | Locale resolution rules | ✅ Correct | `resolveLocaleFrom` (`lib/i18n/resolve.ts`) is pure and dependency-free: authenticated → stored row → `en`; anonymous → marketing cookie → `en`. The marketing cookie is **not** consulted for a signed-in account, so reading the landing page in Arabic cannot change the dashboard you sign in to. |
| 3 | English default | ✅ Correct | `DEFAULT_LOCALE = "en"`, and the DB column defaults to `'en'` (confirmed live: `locale text not null default 'en'`). Both layers agree. |
| 4 | No clinic-language tier | ✅ Correct — verified by absence | `lib/preferences/server.ts` never reads `clinics`; there is no clinic branch in the resolver. §13-Q11 is **decided (option a)**: `clinics.locale` is retained as *formatting* metadata and retired as a language source, recorded as a `COMMENT ON COLUMN` so the constraint travels with the schema. The switcher is structurally incapable of addressing anything but the caller's own row or this browser's cookie. |
| 5 | All three language switcher scopes | ✅ Correct | Marketing (`app/page.tsx`, `scope="marketing"` → cookie only), clinic Preferences (`scope="account"`), operator header (`scope="account"` via the new `headerSlot`). The **clinic dashboard header correctly gets no control** — `headerSlot` is passed only by `app/(operator)/layout.tsx`. The operator's choice writes their own `auth.users`-keyed row, so it cannot reach a clinic. |
| 6 | Per-user theme and locale persistence | ✅ Correct | `actions/theme.ts` upserts the row *then* writes the cookie hint; `actions/locale.ts` upserts `locale` only. Each upsert supplies a single column, so theme and locale writes cannot disturb one another. `signOut` now clears the theme cookie, which correctly stops one user's theme leaking to the next user on the same browser before their row is read. |
| 7 | Platform Admin support without a `profiles` row | ✅ Correct | Verified live: `user_ui_preferences_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE`. Keying on `auth.users` — not `profiles` — is what makes the store structurally capable of holding a Platform Admin's theme and locale. This is the load-bearing design decision of the migration and it is right. |
| 8 | `user_ui_preferences` migration | ✅ Correct | Verified live via `psql \d`: PK on `user_id`, FK→`auth.users` ON DELETE CASCADE, both check constraints (`theme in ('light','dark')`, `locale in ('en','ar')`), and the `trg_user_ui_preferences_updated_at` trigger reusing the existing `public.set_updated_at()`. Backfill is deliberately none, with an honest reason recorded in the migration itself. |
| 9 | All self-only RLS policies | ✅ Correct | Verified live from `pg_policies` — all four verbs present, all self-only, **no platform-admin exception**:<br>`select`: `using (user_id = (select auth.uid()))`<br>`insert`: `with check (user_id = (select auth.uid()))`<br>`update`: `using` **and** `with check`<br>`delete`: `using (user_id = (select auth.uid()))`<br>All use the `(select auth.uid())` initplan form, matching repo convention. |
| 10 | Anonymous denial | ✅ Correct | Verified live: `anon` holds **zero** grants on the table (`information_schema.role_table_grants` → 0 rows). Denial is enforced at the *grant* layer, beneath RLS — the strongest form. |
| 11 | Database types | ✅ Correct | `user_ui_preferences` present in `types/database.ts` with correct Row/Insert/Update shapes. The regeneration also reordered `fx_rates` and added a `platform_audit_logs_clinic_id_fkey` relationship — this is genuine generator drift from a real `supabase gen types` run, not a hand-edit, and it is harmless. |
| 12 | Root `lang` and `dir` | ✅ Correct | `app/layout.tsx` sets `lang={locale}` and `dir={localeDirection(locale)}` from `getLocale()` — the *same* next-intl resolution the messages come from, so `lang`/`dir` and the message bundle can never disagree. |
| 13 | Manrope English typography | ✅ Correct | `app/fonts.ts` keeps Manrope variable as the Latin face. The Arabic stack in `app/globals.css` is scoped to `html[lang="ar"]` only, so the English cascade is untouched and English renders identically. |
| 14 | Thmanyah Arabic typography and **real weight mapping** | ✅ Correct — independently re-derived | I parsed the shipped `woff2` binaries with fontTools rather than trusting the table in the record. `OS/2.usWeightClass`: **Light 300, Regular 400, Medium 500, Bold 700, Black 900**. `fsSelection` italic bit = **0 on every face**. There is genuinely **no 600**. `app/fonts.ts` declares exactly these five and no others — the mapping is real, not assumed. All five files are **byte-identical (md5) to the founder-supplied source**: unmodified, unsubsetted, not fabricated. |
| 15 | No P2B RTL retrofit | ✅ Correctly absent | `components.json` still `"rtl": false`. 139 physical-direction occurrences across 42 files remain untouched. No icon mirroring, no CI grep-gate. Correct — this is P2B. *(But see **P2A-N1**: it is precisely this correct absence that creates the exposure.)* |
| 16 | No P2C string extraction | ✅ Correctly absent | `useTranslations`/`getTranslations` appear only in the three new switcher mounts. `messages/*.json` carry only the `language.*` and `validation.*` keys P2A itself introduces. No existing UI string was extracted or translated. |
| 17 | Zod error-map status; is **P2A-O1** correctly deferred? | ✅ **Yes — deferral confirmed sound** | The map is genuinely **not registered**: no `z.config`, and no product file imports `error-map.ts` (only tests do). I then tested the *rationale* rather than accepting it: **23 zod constraint calls across `appointment.ts`, `settings.ts`, `package-template.ts`, and `patient-package.ts` supply no explicit `message`** (e.g. `z.string().min(2).max(100)`, `z.string().uuid()`). Registering `clinicFlowErrorMap` globally today would make every one of those emit a raw `validation.*` key into the UI, regressing English exactly as claimed. **The deferral to P2C is correct and the stated reason is factually true.** |
| 18 | Full validation evidence | ⚠️ **Partially re-verified** — see §3 | typecheck, lint, unit (583), and production build re-run green by me. Integration and e2e **could not be re-run**: the local Docker VM failed mid-session. Not a P2A fault. |
| 19 | Git scope and accidental artifacts | ❌ **Two problems** | See **P2A-G1** and **P2A-G2**. |

---

## 2. Findings

### P2A-G1 — BLOCKER — `Thmanyah-Font-Family/` would be committed

`Thmanyah-Font-Family/` is **untracked and absent from `.gitignore`**. A routine `git add -A` or
`git commit -a` therefore commits **33 files / 23 MB** of licensed font source into permanent git
history:

- **15 OTF desktop faces** (sans, serif-text, serif-display) — the desktop format the licence never
  permitted anyone to redistribute;
- **15 woff2 files** across all three subfamilies — three times what the product needs;
- **3 PDFs**, including `LICENSE.pdf` and the Arabic licence (the prevailing text), plus the 18 MB
  specimen guide.

This directly destroys the containment that **P2A-L1** rests on. The Cycle 1 record states the risk is
contained because *"only the five `woff2` sans faces ship"* and *"no OTFs, no serif families, nothing
beyond the UI need."* That statement is true of `app/fonts/thmanyah/` — and false of the repository as a
whole the moment anyone stages everything. Git history is not retractable: once these land, removing them
later requires a history rewrite, and the founder's accepted risk silently grows from "five UI faces are
publicly fetchable" to "the complete licensed family, in desktop format, is in our history."

The intended state — exactly five files — is otherwise **correct today**:

```
app/fonts/thmanyah/
  thmanyahsans-Light.woff2    72,380 B   weight 300
  thmanyahsans-Regular.woff2  77,776 B   weight 400
  thmanyahsans-Medium.woff2   79,064 B   weight 500
  thmanyahsans-Bold.woff2     79,160 B   weight 700
  thmanyahsans-Black.woff2    77,112 B   weight 900
```

**Required before any commit:** add `Thmanyah-Font-Family/` to `.gitignore` (the source tree is the
founder's delivery artifact and belongs outside the repo), then confirm `git status -uall` no longer
lists it. I did not make this change — it is a code change and the brief was review-only.

### P2A-N1 — HIGH (decision required) — Arabic ships to production with no RTL retrofit and no Arabic strings

**The Cycle 1 record does not mention this anywhere, and it is the largest un-surfaced risk in the change.**

P2A lands a **real, ungated Arabic option** on three surfaces — including the **public marketing site**,
reachable by any anonymous visitor. `LOCALES = ["en", "ar"]` is rendered unconditionally by all three
switchers; there is no feature flag, no environment gate, no filter.

Selecting Arabic today sets `dir="rtl"` and swaps in the Thmanyah stack, while:

- **139 physical-direction Tailwind classes across 42 files remain un-retrofitted** (`ml-*`, `pr-*`,
  `border-l-*`, `text-left`, …) — that is P2B's job, correctly not done here;
- **100% of UI strings are still English** — that is P2C's job, correctly not done here.

The result is a UI that mirrors its layout without mirroring its styles, and renders English prose in an
Arabic face. Each sub-phase is individually correct; the *composition* is what is broken, and P2A is the
one that makes it reachable.

This matters because of merge order. The plan merges **P2A → P2B → P2C** with P2B+P2C estimated at
**8–13 days**, and the repo has a `vercel.json` with no branch override, so Vercel's Git integration
treats **`main` as production** (`clinicflow.fit`). Merging P2A to `main` alone therefore puts a visibly
broken Arabic mode in front of real clinic users, the Platform Admin, and every anonymous visitor to the
marketing site, for the duration of P2B and P2C.

To be clear about what is *not* wrong here: the plan explicitly demanded a real control in P2A — *"the
placeholder-free rule ends here — the control that lands must actually switch the language."* The
implementer built precisely what was asked, and the switcher genuinely works. What the plan never settled
is whether P2A is safe to **merge to `main` and deploy on its own**, and nobody has made that call.

**This needs an explicit decision before commit. Three viable options:**

1. **Integration branch (recommended).** Merge P2A into a long-lived `feat/p2` branch; `main` receives P2
   only after P2C. Zero product code changes, zero throwaway work, and it is the option the P2A→P2B→P2C
   merge order already implies.
2. **Gate the `ar` option.** Filter `LOCALES` in the switchers behind an env flag (off in production, on
   in preview), retired in P2C. Keeps sub-phases independently shippable; costs a few lines and one
   deliberate deletion later.
3. **Accept explicitly.** Only defensible if `main` is not in fact serving `clinicflow.fit` during P2 —
   which I could not confirm from the repo, and which contradicts the default Vercel wiring.

### P2A-G2 — MEDIUM — the 13 modified PNGs are e2e test output and must be excluded

`docs/reviews/assets/pre-p2-ws5/*.png` (13 files) show as modified. **They are not P2A deliverables and
carry no P2A signal.** They are written by the e2e suite itself on every run — `captureWs5Pair()` at
[tests/e2e/smoke.spec.ts:366](tests/e2e/smoke.spec.ts#L366) screenshots straight into
`WS5_SCREENSHOT_DIR = "docs/reviews/assets/pre-p2-ws5"`. They are **Pre-P2 WS5** review evidence, and the
implementer overwrote them simply by running `pnpm test:e2e`.

I checked whether the churn was a real P2A regression before dismissing it, because "screenshots changed
after a theme refactor" is exactly what a theme leak would look like. It is not one:

- The screenshot theme is **forced via a DOM class** (`setScreenshotTheme`), not read from the store, so
  the new per-account theme cannot influence what these capture.
- The size deltas fit **time-dependent calendar content, not a rendering change**: day/week views moved a
  lot (30 KB → 60 KB) while month views moved **under 1%** (70,557 → 70,954 B). A font or theme change
  would have moved all three alike. A different clock time and weekday moves exactly the two views whose
  content depends on the clock.

**Required:** exclude this path from the P2A commit (`git restore -- docs/reviews/assets/pre-p2-ws5/`, at
commit time). Committing them would silently replace another sub-phase's approved review evidence with
noise from an unrelated test run. I did not run the restore — the brief prohibits it.

Separately, and **not** a P2A defect: a test suite that overwrites tracked review evidence in `docs/` on
every run is a standing trap that will re-fire in P2B and P2C. Worth redirecting to an untracked output
directory in a later sub-phase.

### P2A-D1 — MINOR — "52 static pages" misreads the build output

`P2A_REVIEW.md` §7 row 5 records `pnpm build` → *"PASS — compiled successfully, 52 static pages."* Next
printed `✓ Generating static pages using 9 workers (52/52)`, which is the **prerender-pass count, not
static output**. The build actually emits **2** static routes (`robots.txt`, `sitemap.xml`); every page
route is dynamic (`ƒ`).

No product impact, and **not a regression** — the root layout has always called a Dynamic API (`cookies()`
before P2A, `resolveTheme()`/`getLocale()` now), so every page route was already dynamic at base. Only the
evidence line is wrong. Worth correcting so a future reviewer does not chase a phantom regression.

### P2A-D2 — MINOR — the font family-name claim does not match the files

`P2A_REVIEW.md` §2.2 states *"Family name (`name` table): `thmanyah sans`."* Per-face `nameID 1` is
actually `thmanyah sans Light`, `thmanyah sans`, `thmanyah sans Med`, `thmanyah sans`, and
`thmanyah sans Black`. Harmless in practice — `next/font/local` assigns its own generated family name and
never consults `nameID 1` — but the record states something the binaries do not say, and the rest of that
section earns its credibility by being exact.

### P2A-D3 — MINOR — the plan's "zod message-key refactor" slipped to P2C without amending the plan

The plan's P2A **in-scope** bullet still reads: *"zod message-key refactor + shared error map
(`lib/validations/error-map.ts`) + `translateFieldErrors` helper."* The shared map and the helper shipped.
The **refactor of `lib/validations/*` to message keys did not**, and no product file imports the module —
it is exercised only by its tests.

**P2A-O1 is correctly deferred** (I confirmed the rationale in §1, item 17) — but P2A-O1 documents the
*registration* deferral, while the plan's in-scope line promises the *refactor*, and that line was never
amended. The plan's P2A header note was updated to record P2A-O1; the in-scope bullet beneath it still
contradicts it. Either amend the bullet or record this as an accepted deviation, so the next reader is not
left reconciling two lines of the same document that disagree.

---

## 3. Validation evidence — what I re-ran, and what I could not

| # | Command | Cycle 1 claim | My result |
|---|---|---|---|
| 1 | `pnpm typecheck` | PASS | ✅ **PASS** (clean) |
| 2 | `pnpm lint` | PASS — 0 errors, 4 pre-existing warnings | ✅ **PASS** — 0 errors, 4 warnings, all pre-existing |
| 3 | `pnpm test` (unit) | PASS — 112 files, 583 tests | ✅ **PASS** — 112 files, **583 tests** |
| 4 | `pnpm build` | PASS | ✅ **PASS** — compiled successfully (but see **P2A-D1**) |
| 5 | live schema — `\d public.user_ui_preferences` | table, PK, FK, checks, trigger | ✅ **Confirmed directly via psql** |
| 6 | live RLS — `pg_policies` | 4 self-only policies, no admin exception | ✅ **Confirmed directly via psql** |
| 7 | live grants — `information_schema` | `anon` revoked | ✅ **Confirmed: `anon` has zero grants** |
| 8 | font binaries — `OS/2.usWeightClass` | 300/400/500/700/900, no 600, no italics | ✅ **Confirmed by parsing the shipped woff2** |
| 9 | font provenance — md5 vs. source | unmodified, only 5 sans faces | ✅ **Confirmed byte-identical to the founder's files** |
| 10 | `pnpm test:integration` (incl. 10 real-RLS tests) | PASS — 13 files, 91 tests | ⚠️ **Could not re-run** — see below |
| 11 | `pnpm test:e2e` | PASS — 32/32 | ⚠️ **Could not re-run** — see below |

**Why 10 and 11 could not be re-run — and why it is not a P2A fault.**
Docker Desktop's VM developed a **filesystem I/O fault** during this session: container operations began
failing with `open /var/lib/docker/containers/<id>/hosts: input/output error`, the Postgres container then
died mid-query, and Docker Desktop would not restart (its socket never reappeared). This is a machine-level
fault on the reviewer's host, not a defect in the change.

I confirmed it is environmental rather than a P2A regression: with the stack degraded, **all 13 integration
files failed** — including `p1a-saas-platform-rls`, `p1b-billing-entitlements`, and `p1d-data-export`, which
predate P2A entirely — and they failed on **stack errors, not assertions** (`Database error checking email`,
`Could not query the database for the schema cache`). Once I supplied the local keys, the suite discovered
**91 tests across 13 files, exactly matching the Cycle 1 count**, before the auth container's failure stopped
them from executing.

Crucially, **before** the fault I had already verified the security-critical substance of those tests
*directly against the live database*: the migration, all four self-only policies, both check constraints, the
FK to `auth.users`, the `updated_at` trigger, and `anon`'s complete absence from the grant table. What remains
un-re-verified by me is only the **behavioral denial suite** (one account attempting to read/write another's
row through a real JWT) and the **e2e browser assertions**. I have no reason to doubt them — the policies they
exercise are provably correct as written — but I did not personally re-run them, and I will not claim I did.

**Cycle 2 must re-run both once Docker is healthy.** I also refuted one hypothesis worth recording so it is not
re-investigated: I suspected the new e2e locale test was non-idempotent (it leaves the doctor and operator on
Arabic and nothing resets `user_ui_preferences`). It is **not** a defect — `seedSmokeData` mints fresh
suffixed users on every run (`suffix = e2e-${Date.now()}-…`), so each run starts from accounts with no stored
row, defaulting to `en`.

---

## 4. Carried forward from Cycle 1 — re-confirmed, unchanged

- **P2A-L1** — the licensed faces are publicly fetchable via `next/font/local`; a plain reading of the licence
  prohibits it; the **founder elected to ship and accept the risk**. Still open, still the founder's to close
  with a written grant from `ask@thmanyah.com`. **See P2A-G1: the containment this rests on is currently one
  `git add -A` away from failing.**
- **P2A-O1** — the zod error map is not globally registered. **Deferral independently confirmed correct** (§1,
  item 17). See **P2A-D3** for the plan-consistency loose end.
- **P2A-O2** — Arabic has no 600 weight; `font-weight: 600` resolves to the 700 face. **Independently confirmed
  from the binaries.** Visual-parity item for P2B/P2C QA.
- **P2A-O3** — pre-existing e2e flake in `p1c-signup.spec.ts`, outside P2A.
- **P2A-O4** — `resolveTheme`/`resolveLocale` add one `auth.getUser()` + one row read per request, `cache()`-
  memoized per render. Honest and bounded; no action.

---

## 5. What must happen before commit

1. **P2A-G1** — add `Thmanyah-Font-Family/` to `.gitignore`; verify `git status -uall` no longer lists it.
2. **P2A-N1** — take the release-exposure decision (integration branch / gate the `ar` option / explicit
   acceptance) and record it in `P2A_REVIEW.md`.
3. **P2A-G2** — exclude `docs/reviews/assets/pre-p2-ws5/` from the P2A commit.
4. **P2A-D1 / D2 / D3** — correct the three record inaccuracies (cheap; do them in the same pass).
5. **Re-run `pnpm test:integration` and `pnpm test:e2e`** once Docker is healthy, and paste real results.

**Another review cycle is required.** Cycle 2 should be narrow: confirm the git packaging is clean, confirm
the P2A-N1 decision is recorded, and confirm the two suites pass on a healthy stack. No re-review of the
product code is warranted — it is correct.

---

## 6. Assessment

Setting the packaging aside, this is the strongest sub-phase record in the project so far. The parts that
are usually faked are not faked here: the font weights were **read from the binaries** rather than assumed
(and the plan's assumed 600 was found to be wrong and reported rather than papered over); the licence was
**actually read**, the conflict **escalated before code was written**, and the founder's decision recorded
as theirs rather than laundered into a compliance claim; the backfill was **declined honestly** instead of
inventing history; and the `auth.users` keying is the one design decision that makes Platform Admin support
possible at all — it is correct, and it is correct for the stated reason.

The gap is not engineering judgment; it is that the change was reviewed as *code* and not as a *commit*. The
font source tree and the stale screenshots are both artifacts of the working directory rather than the
implementation, and both would have shipped. And P2A-N1 is the blind spot of a well-executed sub-phase: each
piece is individually right, and nobody asked what the three pieces do to users while standing alone on
`main`.

---

# Review Cycle 2 — remediation verified

**Date:** 2026-07-14
**Scope:** verify the Cycle 1 findings are closed, and re-run the two suites Cycle 1 could not execute.
P2B and P2C remain **not started**, correctly. Nothing was committed, pushed, merged, staged, reset,
cleaned, or stashed.

## Final verdict — Cycle 2

> ## ✅ APPROVED

**No further review cycle is required.** All six Cycle 1 findings are closed, the two suites blocked by the
Cycle 1 Docker fault now pass in full, and the packaging is clean. The product code was correct in Cycle 1 and
**was not modified** in this cycle — the only source change is one whitespace fix in generated types.

| ID | Cycle 1 severity | Disposition in Cycle 2 | How it was closed |
|---|---|---|---|
| **P2A-G1** | BLOCKER | ✅ **CLOSED** | `.gitignore` now excludes `/Thmanyah-Font-Family/` **and** `*.otf`, `*.ttf`, `*.woff`, `*.woff2`, re-including only `!/app/fonts/thmanyah/*.woff2`. The shipped set is an **allowlist**, not a hope. `git status -uall` no longer lists the source tree; the only font binaries git can see are the five WOFF2. No font was ever tracked at base → **no history rewrite needed**. |
| **P2A-N1** | HIGH — decision | ✅ **CLOSED by decision, not by code** | **P2A/P2B/P2C integrate onto one long-lived P2 branch; none merges to `main` separately.** This is option 1 (the recommended one). The switchers were **not gated and not removed** — the plan's "the control that lands must actually switch the language" rule stands. Recorded in `AI_AGENT_PLAN.md` §8 and `P2A_REVIEW.md` §11. |
| **P2A-G2** | MEDIUM | ✅ **CLOSED** | The 13 `pre-p2-ws5/*.png` restored byte-for-byte from their `HEAD` blobs, **after** the final e2e run (the suite rewrites them on every run). The path is absent from the P2A diff. |
| **P2A-D1** | MINOR | ✅ **CLOSED** | §7 corrected in place and marked. Re-confirmed against a fresh build: **2 static routes** (`robots.txt`, `sitemap.xml`); every page route dynamic — as at base, so not a regression. |
| **P2A-D2** | MINOR | ✅ **CLOSED** | §2.2 corrected in place and marked; the same claim fixed in `AI_AGENT_PLAN.md` §4.3. The **weight mapping is unaffected** (300/400/500/700/900, no 600). |
| **P2A-D3** | MINOR | ✅ **CLOSED** | The plan's P2A in-scope bullet now records the `lib/validations/*` message-key refactor and the map's global registration as **accepted deviations moved to P2C**, with the reason. It no longer contradicts P2A-O1. |

**Carried forward, unchanged and not defects:** **P2A-L1** (founder's licensing decision — now backed by
*structural* containment rather than care at `git add` time), **P2A-O1** (deliberate deferral, independently
confirmed sound in Cycle 1), **P2A-O2**, **P2A-O3**, **P2A-O4**.

## Validation — Cycle 1's gap is retired

Docker Desktop and the local Supabase stack were healthy for this run, so the two suites Cycle 1 flagged as
`⚠️ Could not re-run` were executed in full.

| # | Command | Cycle 1 | Cycle 2 |
|---|---|---|---|
| 1 | Docker / Supabase availability | ❌ Docker VM I/O fault | ✅ **Healthy** |
| 2 | `pnpm typecheck` | ✅ PASS | ✅ **PASS** — clean |
| 3 | `pnpm lint` | ✅ PASS | ✅ **PASS** — 0 errors, 4 pre-existing warnings |
| 4 | `pnpm test` (unit) | ✅ PASS — 583 | ✅ **PASS** — 112 files, **583 tests** |
| 5 | `pnpm test:integration` | ⚠️ **Could not re-run** | ✅ **PASS** — 13 files, **91 tests** (incl. the **10 real-RLS denial tests**) |
| 6 | `pnpm build` | ✅ PASS | ✅ **PASS** — 2 static routes, all page routes dynamic |
| 7 | `pnpm test:e2e` (`PORT=3100`) | ⚠️ **Could not re-run** | ✅ **PASS** — **32/32** |
| 8 | `git diff --check` | not run | ✅ **Clean** — one new finding, fixed: `types/database.ts:2458` had a generator-introduced blank line at EOF |
| 9 | `git status -uall Thmanyah-Font-Family/` | ❌ 33 files stageable | ✅ **Empty** |
| 10 | Font binaries visible to git | ❌ 33 files / 23 MB | ✅ **Exactly 5 WOFF2** under `app/fonts/thmanyah/` |
| 11 | WS5 screenshots in the diff | ❌ 13 modified | ✅ **Absent** |

The security substance Cycle 1 could only verify *statically* — self-only RLS on every verb, no platform-admin
exception, `anon` denied, cross-account reads/writes rejected — is now **executed against a live database with
real JWTs and green**. That was the one open question of Cycle 1's evidence, and it is answered.

## Assessment — Cycle 2

Cycle 1's diagnosis held exactly: the defects were in the *commit*, not the code, and the one genuine risk was
a release decision nobody had made. Both are now closed in the right layer — the font source is excluded by an
allowlist that survives future carelessness rather than by a single directory rule, and the Arabic exposure is
closed by **never putting P2A on `main` alone**, without un-building the working switcher the plan demanded.
The standing trap Cycle 1 noted in passing — the e2e suite writing screenshots into a tracked `docs/` path —
is still live and will re-fire in P2B and P2C; it is out of P2A's scope and remains the right thing to fix in
a later sub-phase.
