# P2A Review — i18n Infrastructure, `user_ui_preferences`, and Thmanyah Typography

**Status:** IMPLEMENTED — Cycle 2 review findings addressed
**Workstream:** P2A (`docs/AI_AGENT_PLAN.md` §8 "P2 execution split", §4.1, §4.3, §4.5, §13-Q11)
**Branch:** `feat/p2a-i18n-infrastructure` (base `3b16157`, all work uncommitted)
**Review cycle:** 2 (Cycle 1 preserved below, unmodified except for the two corrections it earned — **P2A-D1**, **P2A-D2** — each marked in place)
**Review dates:** Cycle 1 — 2026-07-14 · Cycle 2 — 2026-07-14
**Final verdict:** **✅ READY — all Cycle 2 review findings closed; full suite green on a healthy stack.**
Two items remain deliberately open and are *not* defects: **P2A-L1**, a licensing decision escalated to and
taken by the founder (§2.4), and **P2A-O1**, the deliberate deferral of the zod error map's registration to
P2C. **P2A-N1 is closed by release sequencing, not by code** (§11): P2A/P2B/P2C integrate onto one P2 branch
and none merges to `main` alone.

This is the authoritative P2A implementation-review record. Later reviews must preserve Review
Cycle 1, retain stable finding IDs, and append history rather than replace it.

---

## Review Cycle 1

### 1. Implementation scope

Implemented P2A only:

- `next-intl` (4.13.2) request configuration and provider, with **no `[locale]` URL segment**;
- locale resolution **user → `en`**, with **no clinic tier** (§4.1 as amended 2026-07-14);
- **English default** everywhere; **Arabic foundation** (`ar` resolves, `dir="rtl"`, Arabic font stack);
- root `lang`/`dir` wiring driven by the same resolution the messages come from;
- the **`user_ui_preferences`** store: migration, self-only RLS, denial suite, no backfill (documented);
- **theme rewired onto the store** — it now follows the *user*, not the browser;
- locale persistence (`updateOwnLocale`) and the **anonymous marketing locale cookie**;
- **all three switcher mounts** — marketing header, clinic Preferences page, operator header;
- **Manrope (Latin) + Thmanyah (Arabic)** via `next/font/local`, IBM Plex Sans Arabic as the fallback tier;
- the `clinics.locale` disposition decision (**§13-Q11**);
- the shared zod error map + `translateFieldErrors` (see **P2A-O1** — deliberately not globally registered);
- regenerated `types/database.ts`; unit, integration (real-RLS), component, and e2e tests; documentation.

**Not started, by instruction:** P2B (RTL retrofit / logical-properties codemod / shadcn regeneration),
P2C (string extraction, Arabic translation, digits/date/currency polish, full RTL QA). No physical-direction
CSS was converted and no existing UI string was extracted.

---

### 2. Font analysis — **read this section first**

#### 2.1 Files used from `Thmanyah-Font-Family/`

| File | Use |
|---|---|
| `LICENSE.pdf` (5 pp, English) | Read in full |
| `ترخيص خط ثمانية.pdf` (4 pp, Arabic) | Read in full — **this is the prevailing text**; the English LANGUAGE clause states the Arabic version governs any conflict |
| `thmanyah typeface/thmanyahsans/woff2/*.woff2` (5 files) | **Shipped.** The only face appropriate for UI body text |
| `thmanyah typeface/thmanyahsans/otf/*.otf` (5 files) | Read only, to parse real `OS/2` weight classes. **Not shipped** (desktop format) |

Deliberately **not** used: `دليل جماليات خط ثمانية.pdf` (18 MB specimen/marketing guide), and the
**serif text** and **serif display** subfamilies (display faces, not UI body text). No font was
downloaded, generated, substituted, or modified.

#### 2.2 Weight mapping (verified from the shipped files, not assumed)

Family names (`name` table, `nameID 1`) are **per-face and not uniform** — `thmanyah sans Light`,
`thmanyah sans` (Regular), `thmanyah sans Med`, `thmanyah sans` (Bold), `thmanyah sans Black`. This has no
effect on rendering: `next/font/local` assigns its own generated family name and never consults `nameID 1`.
`fsSelection` italic bit is **0 on every face**.
*(Corrected in Cycle 2 — **P2A-D2**. Cycle 1 stated a single family name, `thmanyah sans`, which the binaries do not say.)*

| File | Real `OS/2.usWeightClass` | `next/font/local` weight | Size |
|---|---|---|---|
| `thmanyahsans-Light.woff2` | 300 | `300` | 72 KB |
| `thmanyahsans-Regular.woff2` | 400 | `400` | 78 KB |
| `thmanyahsans-Medium.woff2` | 500 | `500` | 79 KB |
| `thmanyahsans-Bold.woff2` | 700 | `700` | 79 KB |
| `thmanyahsans-Black.woff2` | 900 | `900` | 77 KB |

All five are declared. Declaring them is free: a browser downloads a face only when a rendered node
actually resolves to that weight.

#### 2.3 Missing weights — **affects the design system**

- **SemiBold (600) does not exist.** §4.3 *expected* it ("Regular 400, Medium 500, SemiBold 600,
  Bold 700"), and the app relies on it: `app/globals.css` sets `h1–h6 { font-weight: 600 }`, and
  shadcn buttons/labels use `font-semibold`/`font-medium`. In Arabic, every `font-weight: 600` will
  resolve to the **700** face by the CSS weight-matching algorithm. Arabic headings will therefore
  render **heavier** than their Latin counterparts. This is a visual-parity item for **P2B/P2C QA**,
  not a defect in this change — but it must not be discovered late.
- **No italics in any weight** (normal for Arabic families; §4.3 anticipated this).

#### 2.4 Licensing — **P2A-L1 (escalated; founder decision on record)**

The Arabic license (prevailing) and the English license agree:

- **Permitted:** embed the font in websites/web apps **"only as part of a compiled, packaged, or
  obfuscated product"** (*"وذلك فقط كجزء من منتج مُجمَّع أو مُعبأ أو مُعمّى"*).
- **Prohibited:** making the font available "in any manner that allows end users or third parties to
  **extract, download, access**, reuse, or redistribute the Font Software independently as font
  files, **including through web embedding**."
- Arabic catch-all: any use not *expressly* permitted — including copying, **repackaging**
  (*إعادة حزم*), or letting a third party reach the font files — is a violation.

`next/font/local` emits each face to a public, directly-fetchable URL. **This was verified, not
assumed:** `GET /_next/static/media/thmanyahsans_Regular-s.p.07f88l3mceio0.woff2` → **HTTP 200,
77,776 bytes, `content-type: font/woff2`**. Under a plain reading of the prohibition — which names
web embedding explicitly — standard webfont self-hosting is not permitted by this license.

This conflict was **surfaced before any code was written**, together with the fact that §4.3's own
binding rule requires permitted web-app usage to be *confirmed against the purchased licence before
integration*. §4.3 assumed `next/font/local` output was acceptable; it was written before anyone had
read the licence, and that assumption does not survive the text.

**The founder, who holds the licence, elected to ship Thmanyah via `next/font/local` and to accept
the risk knowingly.** The implementer did not make this call and does not represent it as compliant.
What was done to contain it:

- **The repository was made private** before any font file was placed under version control.
  Committing font binaries to the *public* repo would have been unambiguous redistribution — the
  clearest prohibition in the licence — and permanent in git history.
- **Only the five `woff2` sans faces ship.** No OTFs, no serif families, nothing beyond the UI need.
- The fonts are never linked, indexed, listed, or offered as a download anywhere in the product.

**Open, and the founder's to close:** the licence expressly invites this — *"For license exceptions,
extended rights, or customized use cases not expressly stated in this License, please contact the
Company at ask@thmanyah.com."* A written webfont/extended grant would retire **P2A-L1** entirely.
Until then the exposure is real and is recorded here rather than buried.

---

### 3. Exact files changed

**New — product code**

- `app/fonts.ts` — Manrope (Latin), Thmanyah (Arabic primary, 5 real weights), IBM Plex Sans Arabic (fallback tier);
- `app/fonts/thmanyah/*.woff2` (5 licensed files — see §2.4);
- `lib/i18n/config.ts` — locales, `en` default, cookie names, labels, `localeDirection`;
- `lib/i18n/resolve.ts` — the pure resolution rules (no DB, no framework — unit-testable);
- `lib/preferences/server.ts` — request-memoized (`cache()`) read of the store; `resolveLocale`, `resolveTheme`;
- `i18n/request.ts` — next-intl `getRequestConfig`;
- `messages/en.json`, `messages/ar.json` — skeletons (switcher + validation keys only);
- `actions/locale.ts` — `updateOwnLocale` (account) and `setMarketingLocale` (anonymous cookie);
- `components/i18n/language-switcher.tsx` — the one real control, `scope: "account" | "marketing"`;
- `lib/validations/error-map.ts` — message keys + `translateFieldErrors` (see **P2A-O1**);
- `supabase/migrations/20260714120000_p2a_user_ui_preferences.sql`.

**Modified — product code**

- `app/layout.tsx` — `lang`/`dir` from the resolved locale, font variables, `NextIntlClientProvider`; font declarations moved out to `app/fonts.ts`;
- `app/globals.css` — Arabic stack scoped to `html[lang="ar"]` only; Arabic heading tracking reset to `normal`;
- `app/page.tsx` — mounts the marketing switcher;
- `app/(protected)/layout.tsx`, `app/(operator)/layout.tsx` — theme now read from the store; operator mounts the header switcher;
- `app/(protected)/preferences/page.tsx` — the read-only "English (US)" card becomes the real control; the Appearance copy no longer claims "this device";
- `components/layout/dashboard-shell.tsx` — optional `headerSlot` (operator only; the clinic header still gets **no** language control);
- `components/marketing/marketing-page.tsx` — optional `languageSwitcher` node (kept synchronous — it is rendered directly by existing component tests);
- `actions/theme.ts` — writes the store, then the cookie hint;
- `actions/auth.ts` — `signOut` clears the theme hint;
- `next.config.ts` — `createNextIntlPlugin`, composed under the Sentry wrapper;
- `types/database.ts` — regenerated (only addition: `user_ui_preferences`);
- `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` (the `pnpm add` left placeholder `allowBuilds` values that broke every pnpm script; resolved via `ignoredBuiltDependencies`, matching the existing convention).

**Tests**

- New: `tests/unit/lib/p2a-locale-resolution.test.ts`, `tests/unit/lib/p2a-typography.test.ts`,
  `tests/unit/lib/p2a-zod-error-map.test.ts`, `tests/unit/db/p2a-user-ui-preferences-migration.test.ts`,
  `tests/unit/db/p2a-database-types.test.ts`, `tests/unit/components/p2a-language-switcher.test.tsx`,
  `tests/unit/integration/p2a-user-ui-preferences-rls.test.ts`.
- Updated: `tests/unit/actions/theme.test.ts` (now covers the row write),
  `tests/unit/components/mp2-marketing-typography-motion.test.ts` (fonts moved to `app/fonts.ts`; MP2's
  contract re-asserted — Manrope primary, no Arabic face on any English surface),
  `tests/e2e/smoke.spec.ts` (see §6).

---

### 4. Migration summary

`supabase/migrations/20260714120000_p2a_user_ui_preferences.sql` — the only P2 migration.

```sql
user_ui_preferences (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  theme      text not null default 'light' check (theme in ('light','dark')),
  locale     text not null default 'en'    check (locale in ('en','ar')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
)
```

- **Keyed on `auth.users`, never on `profiles`** — load-bearing: a Platform Admin has no `profiles`
  row, so a profiles-keyed column is *structurally incapable* of holding the SaaS Owner's theme or the
  operator dashboard's language. Asserted by a test, and by a live row for a real platform admin.
- `updated_at` reuses the existing `public.set_updated_at()` trigger.
- **Backfill: none, deliberately.** A browser cookie is not readable server-side outside a request, so
  historical theme choices cannot be migrated. Rows are created **lazily on first write**, defaulting to
  `light`/`en`. This is documented in the migration itself, not invented (§4.5).
- **§13-Q11 decided — option (a): `clinics.locale` is RETAINED as clinic *formatting* metadata**
  (dates/numbers on clinic-wide artifacts, alongside `timezone`/`currency`/`digits`) and is **retired as a
  language source**. It may never resolve any user's UI language again. The constraint is recorded as a
  `COMMENT ON COLUMN` so it travels with the schema rather than living only in a planning document.
  The column is **not** dropped.

---

### 5. RLS summary

Self-only, on every verb, with **no platform-admin exception**:

| Policy | Verb | Clause |
|---|---|---|
| `user_ui_preferences_select_self` | SELECT | `using (user_id = (select auth.uid()))` |
| `user_ui_preferences_insert_self` | INSERT | `with check (user_id = (select auth.uid()))` |
| `user_ui_preferences_update_self` | UPDATE | `using` **and** `with check` |
| `user_ui_preferences_delete_self` | DELETE | `using (user_id = (select auth.uid()))` |

`revoke all … from anon`; `grant select, insert, update, delete … to authenticated`. The absence of
`is_platform_admin()` in the file is the point, and is asserted by a test.

**Proven against the live database** (`tests/unit/integration/p2a-user-ui-preferences-rls.test.ts`,
10 tests, real JWTs for four actors — two clinic users in one clinic, one in another clinic, and a real
platform admin): an account reads/writes only its own row; reads of another's row return empty; inserts
and deletes of another's row are rejected and the victim row is unchanged; anonymous access is nil; the
check constraints reject an unsupported `locale`/`theme` at the database boundary; and theme and locale
writes never disturb each other.

---

### 6. Locale behavior

```
authenticated:  user_ui_preferences.locale  ->  'en'
anonymous:      cf_marketing_locale cookie  ->  'en'
```

There is **no clinic tier** and **no clinic language**, by construction: the switcher can address
nothing but the caller's own row or this browser's cookie.

- **The marketing cookie is never consulted for a signed-in account.** Reading the landing page in
  Arabic must not silently change the language of the dashboard you then sign in to — asserted in a unit
  test and end-to-end.
- **Three independent mounts.** Marketing header (anonymous cookie) · clinic Preferences page (own row) ·
  operator header (own row). The **clinic dashboard header gets no language control at all**. The operator
  slot MP6 reserved is now filled, and **the placeholder-free rule ends here — the control that landed
  actually switches the language**, asserted in the browser.
- **Theme now follows the user, not the browser** (§4.5). The two gaps the polish sprint documented and
  left open are closed and tested: a second user on the same browser gets *their own* theme, and a user's
  theme follows them to a second device (a fresh context with no cookie still renders their stored theme).
- Switching applies at runtime: server action → `router.refresh()`. **No sign-out, no full reload.**
- `en` renders identically to before: the Arabic font stack is scoped to `html[lang="ar"]`, and the English
  cascade is asserted to contain no Arabic face.

---

### 7. Commands run and exact results

| # | Command | Result |
|---|---|---|
| 1 | `pnpm typecheck` | **PASS** (clean) |
| 2 | `pnpm lint` | **PASS** — 0 errors, 4 warnings, all pre-existing (unchanged from base) |
| 3 | `pnpm test` (unit) | **PASS** — 112 files, **583 tests** |
| 4 | `pnpm test:integration` | **PASS** — 13 files, **91 tests** (incl. the 10 new real-RLS tests) |
| 5 | `pnpm build` | **PASS** — compiled successfully; **2 static routes** (`robots.txt`, `sitemap.xml`), every page route dynamic (`ƒ`), as at base. *(Corrected in Cycle 2 — **P2A-D1**. Cycle 1 read "52 static pages" off `✓ Generating static pages (52/52)`, which is the prerender-pass count, not static output.)* |
| 6 | `pnpm test:e2e` (`PORT=3100`) | **PASS** — **32/32** |
| 7 | `supabase db reset` | **PASS** — migration applies from scratch |
| 8 | `docker exec … psql -c "\d public.user_ui_preferences"` | Table, PK→`auth.users`, both check constraints, `updated_at` trigger, and all 4 self-only policies present |
| 9 | `curl -s http://localhost:3100/` | `<html lang="en" dir="ltr" …>` |
| 10 | `curl -s -H "Cookie: cf_marketing_locale=ar" http://localhost:3100/` | `<html lang="ar" dir="rtl" …>` |
| 11 | `curl -o /dev/null -w '%{http_code} %{size_download}' …/thmanyahsans_Regular-….woff2` | **200, 77776 bytes** — the licensed face is publicly fetchable (**P2A-L1**, §2.4) |
| 12 | grep of built CSS chunks | `html[lang=ar]` → `var(--font-thmanyah), var(--font-plex-arabic), …`; `@font-face{font-family:thmanyah;…font-weight:300…}` present |

**e2e changes and why they were necessary**

- `MP6/P2A: …` (was "MP6: … reserves the language slot") — MP6 asserted the operator slot was **empty**
  and that **no language control existed anywhere**. P2A ends that rule by design. The test now asserts the
  operator header has a real switcher, that Preferences is still absent from the operator menu, that the
  **clinic** header still has **no** language control, and that Preferences now carries the real control.
- `P2A: theme follows the user, not the browser…` (was "theme cookies stay isolated…") — the old test
  encoded the **device** semantics §4.5 deliberately replaced (it assumed a fresh browser context always
  starts light). It now asserts the account semantics, including the second-device case.
- `WS6 operator clinic detail…` — asserted the operator starts light in a fresh context. Since theme is now
  stored per account, an earlier test can legitimately leave them dark. The test now **drives** the starting
  theme rather than assuming it; its subject (both themes render correctly on mobile) is unchanged.
- **New:** `P2A: the language switcher really switches, and one account's language reaches no other` and
  `P2A: the anonymous marketing locale is independent of every account`.

---

### 8. Acceptance-criteria matrix (§8, P2A "Tests/acceptance")

| Criterion | Status | Evidence |
|---|---|---|
| Locale resolution: user beats `en` default; **no clinic tier** | ✅ | `p2a-locale-resolution.test.ts`; no clinic read exists in the resolver |
| Anonymous marketing cookie independent of any authenticated preference | ✅ | unit + e2e (`…marketing locale is independent…`) |
| One user's locale change leaves every other user untouched (same clinic and across clinics) | ✅ | real-RLS integration test; e2e (Doctor `ar` + Receptionist `en`, same clinic, simultaneously) |
| Platform Admin's locale changes nothing for any clinic user, and vice versa | ✅ | real-RLS integration test; e2e |
| RLS denial — no account reads or writes another's row, platform admin included | ✅ | 10 real-JWT integration tests |
| **Theme follows the user** — 2nd user on same browser; theme follows to a 2nd device | ✅ | e2e `P2A: theme follows the user…` |
| Zod messages resolve through keys in both locales | ⚠️ **partial** | map + helper + both locales tested — but **not globally registered**: see **P2A-O1** |
| App renders byte-identical in `en` | ✅ | Arabic stack scoped to `html[lang="ar"]`; full unit/e2e suites green; MP2 English-cascade assertion retained |

---

### 9. Open items (stable IDs)

#### P2A-L1 — Licensed font is publicly fetchable (**founder decision on record**)
Serving Thmanyah through `next/font/local` exposes each face at a public URL (verified: HTTP 200,
77,776 bytes), which a plain reading of the licence prohibits — it names web embedding explicitly and
permits embedding only in a "compiled, packaged, or obfuscated product". Escalated before implementation;
the founder chose to ship and accept the risk. Contained by making the repo **private** and shipping only
the five `woff2` UI faces. **Retire by obtaining a written webfont/extended grant** (`ask@thmanyah.com`),
which the licence expressly invites. See §2.4.

#### P2A-O1 — The zod error map is not globally registered (deliberate)
`lib/validations/error-map.ts` ships with `clinicFlowErrorMap`, `validationKeyForIssue`, and
`translateFieldErrors`, all tested in both locales. It is **not** installed via `z.config()`, because every
form in the app currently renders zod's message text straight through: registering it today would print
`validation.required` in the UI of every un-migrated schema, regressing English and breaking the
"renders byte-identically in `en`" acceptance criterion. Registration belongs with the schema/consumer
migration in **P2C** (string extraction). This is the one P2A line item that is infrastructure-only rather
than end-to-end.

#### P2A-O2 — Arabic has no 600 weight; `font-weight: 600` resolves to 700
Not a defect in this change; a **visual-parity item for P2B/P2C QA**. Arabic headings and any
`font-semibold` element will render at 700. See §2.3.

#### P2A-O3 — Pre-existing e2e flake in `p1c-signup.spec.ts` (not P2A)
"expired-subscription user can submit the public root dialog" intermittently times out waiting for the
early-access dialog after clicking, when the click lands before the marketing page hydrates. **Verified
pre-existing:** it fails identically at base `3b16157` in a clean worktree with none of this branch's code,
and it passes in the clean full run (32/32). Reported, not "fixed", because it is outside P2A's scope.

#### P2A-O4 — `resolveTheme`/`resolveLocale` add one `auth.getUser()` + one row read per request
Both are `cache()`-memoized per request, so the store costs one query per render rather than one per
consumer. The WS7 performance gate was re-measured and is unaffected (**p95 55.4 ms**, budget 1,000 ms).
Recorded so a future reviewer does not have to rediscover the cost.

---

### 10. Explicitly unchanged by P2A

- No physical-direction CSS was converted, no shadcn primitive was regenerated, no icon was mirrored, and
  no CI grep-gate was added — **all P2B**.
- No existing UI string was extracted or translated; `messages/*.json` carry only the keys P2A itself
  introduces — **P2C**.
- **No clinic-wide language or theme setting was introduced, and none may ever be** (§4).
- The marketing site stays Light and the auth pages stay Dark (pure CSS scoping, untouched).
- Middleware, RBAC, billing, entitlements, patient/appointment/report data paths, and every other RLS
  policy are untouched.

---

## Review Cycle 2 — remediation of the phase-review findings

**Date:** 2026-07-14
**Scope:** close the findings raised in `docs/reviews/P2A_PHASE_REVIEW.md` (Cycle 1 review pass). **No P2B
and no P2C work was started.** Nothing was committed, pushed, merged, staged, reset, cleaned, or stashed.
Cycle 1 above is preserved; the two factual errors it contained are corrected **in place and marked**, so the
record is accurate without losing its history.

### 11. Findings closed in Cycle 2

#### P2A-G1 — CLOSED — the licensed font source can no longer be committed

`.gitignore` now excludes the founder's delivery artifact and every non-shipped font format, while
re-including exactly the five faces the product ships:

```gitignore
# licensed font source — founder delivery artifact, must never enter git history (P2A-G1 / P2A-L1).
/Thmanyah-Font-Family/
*.otf
*.ttf
*.woff
*.woff2
!/app/fonts/thmanyah/*.woff2
```

This is deliberately **stronger than the finding asked for**. Ignoring the directory alone would have
protected today's tree but not tomorrow's: a copy of the family dropped anywhere else, or a stray OTF, would
have been staged by the next `git add -A`. The format-level exclusions plus a single explicit re-inclusion make
the shipped set an **allowlist** — the only font binaries git can ever see are the five named WOFF2 faces.

Verified:

- `git status -uall` no longer lists `Thmanyah-Font-Family/` at all (33 files / 23 MB, incl. 15 OTFs, the two
  licence PDFs, and the 18 MB specimen guide);
- `git check-ignore -v` confirms both `LICENSE.pdf` and a sans OTF resolve to the new rule;
- every font binary git can see is one of the five WOFF2 under `app/fonts/thmanyah/` — nothing else;
- no font binary was ever tracked at base (`git ls-files` for `otf|ttf|woff|woff2|pdf` → **0 files**), so **no
  history rewrite is needed**. The containment **P2A-L1** rests on is now structural rather than a matter of
  care at `git add` time.

#### P2A-G2 — CLOSED — the WS5 screenshot artifacts are out of the P2A diff

The 13 `docs/reviews/assets/pre-p2-ws5/*.png` files were restored byte-for-byte to their committed content
(written back from the `HEAD` blobs via `git cat-file -p`, since `git restore`/`checkout` were prohibited for
this pass). They are **Pre-P2 WS5** review evidence, overwritten as a side effect of `pnpm test:e2e`, not a
P2A deliverable.

Sequencing mattered: the e2e suite rewrites these files on every run, so the revert was performed **after**
the final e2e run, not before. `git status -- docs/reviews/assets/pre-p2-ws5/` is now empty and the path is
absent from the P2A diff. The underlying trap — a tracked `docs/` path used as a test output directory — is
unchanged and will re-fire in P2B/P2C; it is noted in the phase review for a later sub-phase and is out of
P2A's scope.

#### P2A-N1 — CLOSED by release sequencing (decision recorded) — **no code change; the switchers stay**

**Decision (founder): P2A, P2B, and P2C continue on one long-lived P2 integration branch and will not merge
to `main` separately. `main` receives P2 once, after P2C.**

This closes the exposure the phase review identified — an ungated Arabic option reaching production while the
RTL retrofit (P2B) and the Arabic strings (P2C) do not yet exist — **at the release layer, where it actually
lives, rather than in the product code.** The reasoning is worth stating plainly, because the tempting fix was
the wrong one:

- **The switchers are not gated, not feature-flagged, and not removed.** The plan's binding requirement stands
  — *"the placeholder-free rule ends here — the control that lands must actually switch the language."* Adding
  an env-flag filter over `LOCALES` would have satisfied the finding by partially un-building what P2A was
  asked to build, and would have created a deliberate deletion to remember in P2C.
- **The risk was never "Arabic is selectable"; it was "Arabic is selectable *on `main`, alone, for 8–13 days*."**
  P2A never reaches `main` alone, so the window in which the composition is broken never opens in front of a
  real user. Every Arabic surface remains fully exercisable on the integration branch and in preview — which is
  exactly where P2B and P2C need it.
- Option 3 from the phase review ("accept explicitly") was **rejected**: `vercel.json` carries no branch
  override, so Vercel's Git integration does treat `main` as production (`clinicflow.fit`), and the exposure
  would have been real.

Recorded in `docs/AI_AGENT_PLAN.md` §8 ("P2 execution split"), whose merge-order line previously read
*"merge order P2A → P2B → P2C"* with P2A marked *"merge 1st"* — language that implied three separate merges to
`main` and was the root of the ambiguity. It now reads **integration order**, with the release-sequencing
decision stated explicitly above the sub-phase list.

#### P2A-D1 — CLOSED — "52 static pages" corrected (§7, row 5)

The Cycle 1 evidence line read the prerender-pass counter (`✓ Generating static pages (52/52)`) as static
output. Re-confirmed against a fresh `pnpm build` in this cycle: the build emits exactly **2** static routes —
`○ /robots.txt` and `○ /sitemap.xml` — and **every page route is dynamic (`ƒ`)**. This is **not a regression**:
the root layout has always called a Dynamic API (`cookies()` before P2A, `resolveTheme()`/`getLocale()` now),
so every page route was already dynamic at base `3b16157`. §7 is corrected in place and marked.

#### P2A-D2 — CLOSED — the font family-name claim corrected (§2.2)

Cycle 1 stated a single family name, `thmanyah sans`. The binaries do not say that: per-face `nameID 1` is
`thmanyah sans Light` / `thmanyah sans` / `thmanyah sans Med` / `thmanyah sans` / `thmanyah sans Black`.
Immaterial to rendering — `next/font/local` generates its own family name and never reads `nameID 1` — but §2.2
earns its credibility by being exact, so it is corrected in place and marked. The **weight mapping in §2.2 is
unaffected and stands**: 300/400/500/700/900, no 600, italic bit 0 on every face. Corrected in
`docs/AI_AGENT_PLAN.md` §4.3 as well, which repeated the same claim.

#### P2A-D3 — CLOSED — the plan's "zod message-key refactor" bullet amended

`docs/AI_AGENT_PLAN.md` §8's P2A **in-scope** bullet promised *"zod message-key refactor + shared error map +
`translateFieldErrors` helper."* The map and the helper shipped; the **refactor of `lib/validations/*` did
not**, and the bullet contradicted the P2A-O1 note directly above it. The bullet is amended to record the
refactor and the map's global registration as **accepted deviations moved to P2C**, with the reason stated
(23 zod constraint calls across four schema files supply no explicit `message`, so registering the map today
would print raw `validation.*` keys into every un-migrated form and regress English). **P2A-O1 is unchanged
and remains the authoritative record of the deferral** — only the plan line that disagreed with it was fixed.

#### One additional defect found and fixed during Cycle 2 verification (not in the phase review)

`git diff --check` flagged `types/database.ts:2458: new blank line at EOF` — the `supabase gen types` run left
a trailing blank line the base file did not have. Stripped; `git diff --check` is now clean. Typecheck and the
full unit suite were re-run afterwards and stay green.

### 12. Cycle 2 rerun results — the full suite, on a healthy stack

Docker Desktop and the local Supabase stack were confirmed healthy before the run, which retires the phase
review's §3 gap: `pnpm test:integration` and `pnpm test:e2e` **could not be re-run in Cycle 1** because the
reviewer's Docker VM developed a filesystem I/O fault. Both were re-run here, in full, and both pass.

| # | Command | Result |
|---|---|---|
| 1 | Docker / Supabase availability | ✅ **Healthy** — `docker info` OK; `supabase status` reports the local stack running |
| 2 | `pnpm typecheck` | ✅ **PASS** — clean |
| 3 | `pnpm lint` | ✅ **PASS** — **0 errors, 4 warnings**, all pre-existing and unchanged from base |
| 4 | `pnpm test` (unit) | ✅ **PASS** — **112 files, 583 tests** |
| 5 | `pnpm test:integration` | ✅ **PASS** — **13 files, 91 tests**, incl. the **10 real-RLS denial tests** Cycle 1 could not execute |
| 6 | `pnpm build` | ✅ **PASS** — compiled successfully; **2 static routes**, all page routes dynamic (confirms **P2A-D1**) |
| 7 | `pnpm test:e2e` (`PORT=3100`) | ✅ **PASS** — **32/32**, incl. both new P2A locale specs |
| 8 | `git diff --check` | ✅ **Clean** (after the EOF fix above) |
| 9 | `git status --short -uall Thmanyah-Font-Family/` | ✅ **Empty** — nothing tracked, nothing stageable |
| 10 | Font binaries visible to git | ✅ **Exactly the five WOFF2** under `app/fonts/thmanyah/` — no OTF, no PDF, no serif face |
| 11 | `git status -- docs/reviews/assets/pre-p2-ws5/` | ✅ **Empty** — the WS5 artifacts are absent from the P2A diff |

The **10 real-RLS integration tests passing on a live database** is the substantive addition of this cycle: the
security claims in §5 — self-only on every verb, no platform-admin exception, `anon` denied, cross-account
reads and writes rejected with a real JWT — are now **executed and green**, not merely inferred from the policy
text.

### 13. Open items after Cycle 2

| ID | State | Note |
|---|---|---|
| **P2A-L1** | **Open — founder's, by decision** | The licensed faces are publicly fetchable via `next/font/local`. Retire with a written webfont/extended grant (`ask@thmanyah.com`), which the licence expressly invites. Containment is now **structural** (see P2A-G1). |
| **P2A-O1** | Open — deliberate | Zod error map not globally registered; registration lands in P2C with the schema/consumer migration. Deferral independently confirmed sound by the phase review. |
| **P2A-O2** | Open — QA item | Arabic has no 600 weight; `font-weight: 600` resolves to the 700 face. **P2B/P2C visual-parity QA.** |
| **P2A-O3** | Open — pre-existing | `p1c-signup.spec.ts` flake, outside P2A. Did not recur in this cycle's clean 32/32 run. |
| **P2A-O4** | Open — recorded, no action | One `auth.getUser()` + one row read per request, `cache()`-memoized. WS7 perf gate unaffected. |
| **P2A-N1** | **CLOSED** | Closed by release sequencing (§11) — one P2 integration branch; no separate merge to `main`. |
| **P2A-G1 / G2 / D1 / D2 / D3** | **CLOSED** | See §11. |

**Cycle 2 verdict: ✅ READY.** The blockers were packaging and a release decision, exactly as the phase review
diagnosed; both are closed, no product-code defect was found in either cycle, and the full suite — including the
two suites Cycle 1 could not run — is green on a healthy stack.
