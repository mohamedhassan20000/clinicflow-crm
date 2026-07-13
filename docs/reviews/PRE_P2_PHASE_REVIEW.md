# Pre-P2 Product Polish — Integrated Phase Review

**Status:** REVIEWED
**Scope:** the complete Pre-P2 Product Polish sprint (WS0–WS9) as one integrated working tree
**Contract:** `docs/PRE_P2_POLISH.md` (scope, §19 acceptance criteria, §12 architecture decisions, §13 security guardrails, §16 performance budgets, §17 testing, §22 definition of done)
**Reviewer:** Claude (review only — no application code was modified)
**Review cycle:** 1
**Review date:** 2026-07-13
**Base commit:** `cf240b3` (`main`, tracking `origin/main`; working tree dirty by design)
**Final verdict:** **APPROVED AFTER MINOR FIXES**

This file is the authoritative integrated phase-review record. Re-reviews must preserve
Review Cycle 1, retain the stable finding IDs below, and append a dated cycle rather than
replacing history.

---

## Review Cycle 1

### 1. What was reviewed

Read in full before any verification: `docs/PRE_P2_POLISH.md`, `docs/AI_AGENT_PLAN.md`,
`docs/reviews/PRE_P2_FINAL_VALIDATION.md`, and all ten workstream records
(`PRE_P2_WS0_REVIEW.md` … `PRE_P2_WS9_REVIEW.md`).

Independently inspected: every modified and untracked source file (132 paths; 81 tracked
files changed, 5,663 insertions / 1,994 deletions), all new reusable components, all new
operator query paths, the marketing assets and screenshot-generation scripts, the test
suites, and the documentation changes to previous review files. Implementation reports were
treated as claims to be checked, not as evidence.

**Headline:** the sprint is real, and the implementation reports are substantially accurate.
The blocking bug has a genuine root-cause fix, the security model is untouched, no patient
PHI reaches any public or operator surface, and every gate I re-ran reproduces. Five items
require attention before commit; none is a blocking defect, and none is a security defect.

### 2. Commands actually run, and their exact results

All commands were run by me against the current working tree. Local Supabase was already
running (`supabase status` → running). Integration/Playwright/Lighthouse runs required
local-service access.

| # | Command | Exact result |
|---|---|---|
| 1 | `git status --short \| wc -l` | 132 changed/untracked paths; staging area empty |
| 2 | `git status --short supabase/ middleware.ts lib/supabase/middleware.ts types/database.ts` | **Empty** — no migration, middleware, or database-type file changed |
| 3 | `pnpm typecheck` | **PASS** — exit 0, no diagnostics |
| 4 | `pnpm lint` | **PASS WITH WARNINGS** — exit 0; **0 errors, 4 warnings** (all pre-existing; see §7) |
| 5 | `pnpm test` | **PASS** — **93 files, 501/501 tests**; 17.74s |
| 6 | `node --env-file=.env.local node_modules/vitest/vitest.mjs run tests/unit/integration --no-file-parallelism` | **PASS** — **12 files, 80/80 tests**; 10.79s |
| 7 | `PORT=3113 node --env-file=.env.local node_modules/@playwright/test/cli.js test --workers=1` | **PASS** — **21/21 passed**; 1.1m (production build + serial Chromium) |
| 8 | `pnpm build` | **PASS** — Turbopack production build; middleware→proxy deprecation warning only |
| 9 | `node --env-file=.env.local node_modules/next/dist/bin/next start -p 3114` + `curl` on `/`, `/privacy`, `/terms`, `/robots.txt` (anonymous) | **PASS** — `200 / 200 / 200 / 200`; legal + SEO routes are publicly reachable without a session |
| 10 | `pnpm dlx lighthouse@13.4.0 http://127.0.0.1:3114/ … --only-categories=performance,accessibility,best-practices,seo` ×3 (mobile, production build) | **GATE PASS** — Performance **91 / 92 / 90**; Accessibility **100 / 100 / 100**; Best Practices 100; SEO 100. LCP 3.5 / 3.3 / 3.6 s |
| 11 | `grep -rln "<table" components/ app/` | Only `components/ui/table.tsx` (the primitive) — WS2 migration is complete |
| 12 | `grep -n "requirePlatformAdmin" lib/operator-reports/registry.ts lib/supabase/admin.ts` | Guard present on all **7** report queries (`:235,:324,:371,:425,:472,:523,:568`), the filter-option loader (`:775`), and the WS8 history boundary (`admin.ts:448`) |
| 13 | Physical-direction class scan over all added lines + all new files | **2 violations found** — see PREP2-R2 |
| 14 | `grep -rl "next-intl"` / `dir="rtl"` / `lang="ar"` over source | **Clean** — matches only in `docs/`; no P2 runtime, no i18n dependency in `package.json` |
| 15 | `head -2` on `lib/supabase/admin.ts`, `lib/currency/server.ts`, `lib/currency/open-exchange-rates.ts` | All three retain `import "server-only"` |
| 16 | `grep -rln "SECRET_KEY\|OPEN_EXCHANGE_RATES_APP_ID\|CRON_SECRET" components/ app/` | Only `app/api/cron/fx-rates/route.ts` (server route handler). No secret in any client component; no `NEXT_PUBLIC_` addition in the diff |
| 17 | `sips -s format png public/marketing/patients-desktop.avif` + visual inspection | Real product UI; all data visibly fictional (`DEMO-####` file numbers, `FICTIONAL-####` national IDs, `+9655000000X` phones). **No PHI** |
| 18 | `git diff tests/` scan for `.skip` / `.only` / `fixme` / removed assertions | No skips or onlys added; assertions net **+129 / −10**. No test was weakened |

The final validation report (`PRE_P2_FINAL_VALIDATION.md`) is **accurate and reproducible**:
its Cycle-2 claims (typecheck 0, lint 0 errors, unit 501/501, integration 80/80, Playwright
21/21, Lighthouse gate pass) all reproduced independently on my runs. Its Cycle-1 failure
history is preserved honestly rather than rewritten.

### 3. Verification by workstream

| WS | Verified | Notes |
|---|---|---|
| **WS0** dashboard error | **PASS** | Root cause is real and correctly identified: `formatMoney` merged registry `minorUnits` into both fraction-digit bounds, so any caller passing `{ maximumFractionDigits: 0 }` produced `min > max` → `Intl.NumberFormat` `RangeError`. The fix at `lib/currency/conversion.ts:29-40` resolves the bounds *after* caller options, letting an explicit caller bound win. This is a root-cause fix, not a cosmetic fallback. Query-error logging added to the dashboard fan-outs and `actions/doctor-dashboard.ts`; boundary copy improved. Regression coverage exists at both unit and e2e level (empty-clinic, all four roles) |
| **WS1** sidebar toggle | **PASS** | Correct diagnosis (sticky creates a stacking context, so the button's own `z-index` could never beat the `z-30` header). Fix elevates the `aside` to `z-40` (`sidebar.tsx:64`) and adds `before:-inset-2.5` → 28 px visual / **48 px effective** hit target (`sidebar.tsx:80`). `aria-expanded` and `rtl:` transforms preserved. The unclipped toggle is independently visible in the WS9 product screenshot I inspected |
| **WS2** table system | **PASS** | `components/ui/table.tsx` + `components/shared/data-table.tsx` exist; header hierarchy is encoded once (solid `bg-muted`, `text-foreground font-semibold`, `border-b-2` vs `border-border/50` rows); `overflow-x-auto` is built into the primitive; `<th scope="col">` is real. **Zero** raw `<table>` markup remains outside the primitive (command 11) |
| **WS3** phone/country | **PASS with PREP2-R1** | `lib/phone/registry.ts` now derives from `getCountries()` (200+), with the pinned priority group, `Intl.DisplayNames` names, and computed flag emoji — no new metadata payload. `isPhoneCountry`/`normalizePhone` widen server-side in lockstep with the UI. `localPhoneValue` round-trips legacy GB/DE/FR values (**BUG-3 / P15D-P4 genuinely closed**). E.164 storage and the FormData contract are unchanged. **However, carried finding P15D-P7 was not implemented** — see PREP2-R1 |
| **WS4** currency/Preferences | **PASS with PREP2-P1** | Header `CurrencySelector` removed and file deleted; `/preferences` is guarded only by `requireUser()` and linked from the header user menu, so **every** staff role reaches it without widening `/settings` (which middleware hard-gates to admin/manager — correctly left untouched). Canonical-vs-personal copy is explicit; canonical `clinics.currency` stays read-only. Registry expanded to 40 hand-seeded, OER-covered currencies with derived display fields; the FX provider keeps its **all-or-nothing** snapshot rule (`open-exchange-rates.ts:19-21`). `convertForDisplay` (≈ marking, 48 h stale, 72 h suppress) is byte-for-byte preserved. No monetary column touched. P15-P1 (`lib/currency/format.ts`) and P15-P3 (`cache()`) are genuinely closed. Route-name deviation noted as PREP2-P1 |
| **WS5** calendar | **PASS** | Shared token/helper module (`components/appointments/calendar-visuals.tsx`) replaces per-file opacities; current-time indicator exists in **all three** views (`week-calendar.tsx:231`, `day-calendar.tsx:129`, `month-calendar.tsx:190`) and refreshes on a 60 s interval (`calendar-visuals.tsx:55`); non-working bands and today treatments are shared. Before/after screenshots and contrast measurements are recorded in the WS5 review |
| **WS6** back navigation | **PASS** | `lib/navigation/return-url.ts` is the security-relevant piece and it is correct: rejects non-local values, rejects protocol-relative `//`, caps length, and — critically — accepts a return path **only if its pathname is in a per-route allowlist**, falling back to the stable parent otherwise. It is rendered as a `Link`, never used as a server redirect. `PageHeader` puts the back link before the `h1`, names its destination, and emits `nav[aria-label="Breadcrumb"]` + `aria-current="page"` |
| **WS7** operator reports | **PASS** | Declarative filters/sort/pagination per the §7 matrix; zod parsing boundary with safe fallbacks; server-side `range()` + exact counts replace the 1000-row cap (**P15B-R13 closed in code**); export honors filters and ignores pagination, with a 10,000-row cap surfaced via `x-report-export-truncated` rather than silently truncating. `requirePlatformAdmin()` guards every query path including the export route (which reaches it through `report.query`). CSV formula-injection hardening retained |
| **WS8** clinic history | **PASS** | `getOperatorClinicHistory()` (`lib/supabase/admin.ts:444`) guards with `requirePlatformAdmin()` before creating the service-role client. Audit payloads never leave the server: `safeAuditSummary()` (`admin.ts:379-437`) is an **allowlist of 8 actions** with a `default: null`, so an unrecognized row (including the deliberately seeded `patient.exported` event in the integration test) cannot surface. Payments/contracts is an honest labeled placeholder (`clinics/[id]/page.tsx:467-469`) with no synthesized data. No `clinic_notes` schema, UI, or placeholder exists, per the resolved Q3 decision |
| **WS9** marketing | **PASS with PREP2-R3** | Real ClinicFlow mark, real seeded-demo screenshots (10 AVIF, 7.6–35 KB), `next/image` art-directed delivery, descriptive alt text naming the data as fictional. Seed and capture scripts **refuse non-local hosts** (`seed-marketing-demo.ts:38`, `capture-marketing-screenshots.ts:137`) and enforce a 300 KB per-asset budget. Copy is honest: no fabricated testimonials, no invented prices, and explicit non-certification statements (`lib/marketing-copy.ts:168,244`). `/privacy` and `/terms` carry a prominent pending-legal-review notice and bind nothing. Early-access RPC/rate-limit boundary is functionally unchanged. Gate passes — but the **gate document records the wrong numbers**; see PREP2-R3 |

### 4. Cross-cutting guardrail verification

| Guardrail | Result | Evidence |
|---|---|---|
| RLS / middleware / gate order unchanged | **PASS** | `supabase/`, `middleware.ts`, `lib/supabase/middleware.ts`, `types/database.ts` all unchanged (command 2). No migration was added — WS7's optional index was correctly not created after p95 measured 73.8 ms |
| Multi-tenancy, RBAC, platform-admin authz | **PASS** | Every new operator query re-guards with `requirePlatformAdmin()` (command 12). `/settings` stays admin/manager-gated; WS4 deliberately routed around it rather than widening it |
| No patient PHI on public/operator surfaces | **PASS** | Operator selects carry clinic metadata, counts, and lifecycle timestamps only: invitations exclude owner name/email/phone/token (`registry.ts:378`), activity excludes actor and payload (`registry.ts:530`), users aggregate reads `clinic_id, created_at` only. Audit rendering is allowlist-based. Marketing screenshots contain only fictional data (command 17), and the integration suites assert all of this |
| Billing / subscriptions / entitlements / rate limiting / audit | **PASS** | No file in those paths changed semantically; WS8 adds **no mutation**; the early-access RPC boundary is untouched |
| Canonical monetary values | **PASS** | `convertForDisplay` still returns canonical on missing/expired rates; no monetary column is written anywhere in the diff; `fx_rates` shape unchanged (row count only grows) |
| Secrets server-only | **PASS** | `server-only` retained on all three sensitive modules; no `NEXT_PUBLIC_` addition; no secret referenced from `components/` (commands 15–16) |
| No P2 scope introduced | **PASS** | No `next-intl` dependency, no locale routing, no `dir="rtl"`/`lang="ar"` runtime (command 14) |
| No new physical-direction CSS | **FAIL** | 2 violations — **PREP2-R2** |
| No unrelated changes in the diff | **PASS** | Every changed path maps to a declared workstream. `sharp` is added as a **devDependency** only, for the screenshot pipeline. The two new `package.json` scripts are the documented `marketing:seed` / `marketing:capture` |
| Prior P1.5 / Pre-P2 required findings still resolved | **PASS (code) / FAIL (records)** | P15-R1 dynamic import, P15D-P4, P15B-R13, P15-P1, P15-P3, P15C-P2, P15C-P3 are all closed **in code**. Their sub-phase review files were mostly not updated — **PREP2-R4**. P15D-P7 is **not** closed — **PREP2-R1** |

---

## 5. Required findings

Stable IDs. All five must be resolved before commit. **None is a blocking defect** — the
product builds, passes every suite, and is behaviourally correct as it stands.

### PREP2-R1 — Carried finding P15D-P7 was never implemented (WS3 scope gap)

**Category:** required fix — missed acceptance criterion
**Evidence:** [components/auth/clinic-signup-form.tsx:30](components/auth/clinic-signup-form.tsx#L30) passes **no `defaultCountry`** to `InternationalPhoneInput`, while the clinic-country `<select>` on [line 32](components/auth/clinic-signup-form.tsx#L32) independently defaults to `KW`. `git status --short components/auth/` is **empty** — the file was not touched by this sprint at all.

`docs/PRE_P2_POLISH.md` §7-WS3 requires: *"Address carried P15D-P7 (signup clinic-country vs. phone-country selects are independent) by defaulting phone country to the chosen clinic country until the user overrides."* §22 lists P15D-P7 among the carried items that must be closed.

`PRE_P2_WS3_REVIEW.md` §3 states the seven surfaces "inherit the combobox with no per-surface change" — which is precisely why this was missed: P15D-P7 needed a per-surface change on signup.

**Impact:** a clinic signing up as Saudi Arabia still gets a Kuwait phone-country default. Cosmetic-severity for the user, but it is an explicit, unmet WS3 acceptance criterion.
**Fix:** pass the selected clinic country into the signup phone input as `defaultCountry` (the state already exists in the form), and add a unit or e2e assertion.

### PREP2-R2 — Two new physical-direction CSS classes (hard acceptance-criterion violation)

**Category:** required fix — hard criterion (§5, §12.7, §19-WS3, §19-WS4, §22 "grep-verified")
**Evidence:**
- [components/shared/international-phone-input.tsx:95](components/shared/international-phone-input.tsx#L95) — `className="ml-auto text-xs tabular-nums text-muted-foreground"` (new line, WS3)
- [components/settings/currency-combobox.tsx:81](components/settings/currency-combobox.tsx#L81) — `className="ml-auto text-xs font-medium tabular-nums text-muted-foreground"` (new file, WS4)

Both must be `ms-auto`. Everything else in the sprint is clean — the only other added directional utility is `inset-x-0` (axis-symmetric, RTL-safe, acceptable).

**Impact:** in RTL (P2B) the dial-code and currency-code trailing labels will push to the wrong inline edge. This is exactly the inventory growth §5 forbids.
**Note:** `PRE_P2_WS3_REVIEW.md` §6 and `PRE_P2_WS4_REVIEW.md` both assert "no new physical-direction classes." **Those claims are inaccurate** and should be corrected when the fix lands.

### PREP2-R3 — The performance-gate document records pre-Cycle-2 numbers

**Category:** required fix — documentation accuracy (§22 DoD: *"the Lighthouse gate doc carries fresh passing numbers for the redesigned `/`"*)
**Evidence:** `docs/P15C_PERFORMANCE_GATE.md` records **92 / 92 / 92** Performance at **207 KB** initial script transfer. Those numbers were measured during WS9, **before** Validation Cycle 2 rewrote the marketing entry path (`app/page.tsx`, `components/marketing/marketing-page.tsx`, `early-access-button.tsx`, new `early-access-dialog.tsx`, `mobile-marketing-menu.tsx` — see `PRE_P2_FINAL_VALIDATION.md` §"Files changed by Cycle 2").

The tree that would actually be committed measures differently. My independent three-run gate (command 10) on the current build: **91 / 92 / 90** Performance, **100 / 100 / 100** Accessibility. The final validation's own Cycle-2 run: 91 / 90 / 91 at **198,703 bytes**.

**Impact:** the gate document does not describe the code being shipped. The gate itself **passes** — this is an accuracy defect, not a performance failure.
**Fix:** re-record the gate doc with the Cycle-2 numbers, the ~199 KB script transfer, and the date/commit of the final tree.

### PREP2-R4 — Carried findings not marked closed in their sub-phase review files

**Category:** required fix — documentation (§22 DoD explicitly requires this)
**Evidence:** `git status --short docs/` shows only **`docs/reviews/P1.5C_REVIEW.md`** was updated (P15C-P2/P3/P4). Not updated:
- `docs/reviews/P1.5B_REVIEW.md` — **P15B-R13** (1000-row cap) is closed in code by WS7, unmarked in its record.
- `docs/reviews/P1.5D_REVIEW.md` — **P15D-P4** closed by WS3 and **P15D-P8** closed by WS3's resync effect, both unmarked; **P15D-P7** is not closed at all (PREP2-R1).
- `docs/reviews/P1.5_PHASE_REVIEW.md` — **P15-P1** and **P15-P3** closed by WS4, unmarked. **P15-P2** (hidden-input cleanup, optional per §9.1) was not done and is not recorded as deferred.

**Fix:** mark each item closed (or explicitly deferred, for P15-P2) in its own review file, per the review-file workflow contract.

### PREP2-R5 — Three duplicate combobox implementations (violates architecture decision §12.2)

**Category:** required fix — duplicated abstraction *(a documented waiver is an acceptable resolution)*
**Evidence:** `docs/PRE_P2_POLISH.md` §12.2 mandates *"One searchable-combobox pattern (cmdk-based) shared by the country picker (WS3) and currency picker (WS4) — **build once in WS3**."* Three independent implementations exist instead, each hand-rolling the same Popover + Command + trigger + selected-state structure:
- `CountryCombobox` inside [components/shared/international-phone-input.tsx](components/shared/international-phone-input.tsx) (190 lines)
- [components/settings/currency-combobox.tsx](components/settings/currency-combobox.tsx) (91 lines)
- [components/operator/report-filter-combobox.tsx](components/operator/report-filter-combobox.tsx) (82 lines)

**Impact:** no functional bug today, but it is the exact duplicated abstraction §12 was written to prevent, and it triples the surface for the RTL/i18n sweep in P2. It is also how PREP2-R2 became *two* violations instead of one — the same `ml-auto` was copy-pasted between two of them.
**Fix:** extract the shared trigger/popover/search shell into one `components/shared/searchable-combobox.tsx` and have all three consume it — **or** record an explicit, reasoned waiver amending §12.2 (the three do have genuinely different triggers, and the report filter must stay GET-form compatible via a hidden input).

---

## 6. Optional polish findings

- **PREP2-P1 — "Settings → Preferences" is actually `/preferences`.** [app/(protected)/preferences/page.tsx](app/(protected)/preferences/page.tsx) sits outside `/settings` because `lib/supabase/middleware.ts:54` hard-gates `/settings` to admin/manager and §13 forbids touching middleware. **The deviation is correct** — the plan itself offers "a direct 'Preferences' link in the header user menu" as the compliant alternative, and that is what shipped ([dashboard-shell.tsx:84](components/layout/dashboard-shell.tsx#L84)). But §18/§19 language and the manual-test checklist still say "Settings → Preferences", so a tester will look in the wrong place. Either add a Preferences entry to the Settings nav that links to `/preferences`, or amend the plan wording.
- **PREP2-P2 — The Lighthouse performance margin is razor-thin.** My run 3 scored exactly **90** — the floor. One point of regression fails the gate. LCP is 3.3–3.6 s against §16's ≤2.5 s *target* (correctly documented as aspirational, not gated, in the WS9 review). Worth a follow-up hero-image/LCP pass before treating the gate as safe headroom.
- **PREP2-P3 — `.avif` is missing from the middleware matcher.** `middleware.ts:17` excludes `svg|png|jpg|jpeg|gif|webp` but not `avif`, so a direct request to `/marketing/*.avif` runs the full session middleware (an `auth.getUser()` round-trip). No security impact — the path is not protected, and the marketing page itself serves through `/_next/image`, which *is* excluded. Fixing the matcher is a middleware edit and therefore **out of scope for this sprint** (§13); log it for P2.
- **PREP2-P4 — Latent doctor-dashboard query bug, now visible.** WS0's new logging surfaces PostgreSQL `22P02 invalid input syntax for type uuid: ""` from doctor-dashboard stats query #4 on the empty-clinic path (recorded in `PRE_P2_FINAL_VALIDATION.md` §Known issues, and it appeared in my Playwright run too). The UI degrades safely and the test passes. This is WS0's hardening working as designed — but it is a real latent bug that should be fixed at source.
- **PREP2-P5 — Scroll position is not restored** on WS6 back-navigation (carried from `PREP2-WS6-P1`; URL-owned state *is* restored).
- **PREP2-P6 — Signup's clinic-country select still offers only 4 countries** (`KW/SA/AE/EG`) while phone entry now supports 200+. Out of WS3's stated scope (phone countries), but the asymmetry is now visible to users and is worth a decision.

---

## 7. Pre-existing / unrelated issues (not introduced by this sprint, not blocking)

- **4 lint warnings.** Unused `last30DaysBounds` in `app/(protected)/dashboard/page.tsx` — I verified it exists identically on `HEAD` (`git show HEAD:… | grep -c` → 1), so it is **not** a WS0 regression. Plus a missing effect dependency in `components/followups/record-dialog.tsx` and two React-Compiler `watch()` advisories from React Hook Form.
- **`last_login_update_failed` (`42501`)** server-log noise during e2e — inventoried by P1.5 reviews.
- **Next.js 16.2.6 `middleware` → `proxy` deprecation warning** on every build.
- **Remote Supabase project is missing two migrations** (`20260712090000_p15b_invitation_email`, `20260712150000_p15d_intl_ux_foundations`), per `PRE_P2_WS0_REVIEW.md` §2. This is an **environment** action for the user (`supabase db push`), not a code change — but display-currency conversion and the invitation email marker are silently disabled in that environment until it is done. Also flagged there: `package.json` `db:types` references a stale project id.

---

## 8. Readiness

- **Ready for manual testing: YES.** No blocking defect exists. Every gate reproduces: typecheck 0, lint 0 errors, unit 501/501, integration 80/80, production Playwright 21/21, build clean, Lighthouse 91/92/90 performance with 100 accessibility. The five required findings are localized and none prevents exercising the product. Manual testing can begin immediately and in parallel with the fixes — use the §18 checklist, noting PREP2-P1 (Preferences lives at `/preferences`, reached from the header user menu, not the Settings nav).
- **Ready for commit: NOT YET.** Resolve PREP2-R1 through PREP2-R5 first (R5 may be resolved by a documented waiver).
- **Is another full review cycle required? NO.** The required fixes are small and localized: one prop on one form (R1), two class renames (R2), two documentation updates (R3, R4), and one refactor-or-waiver (R5). A **targeted verification pass** is sufficient — re-run `pnpm typecheck && pnpm lint && pnpm test`, re-run the physical-direction grep, and confirm the two documents. If PREP2-R5 is resolved by refactoring rather than waiver, extend that pass to the full unit suite plus the phone/currency/operator-report e2e tests, since it touches three shipped components.

---

## 9. Git state

- Branch `main`, tracking `origin/main`, base `cf240b3`. Staging area empty.
- Working tree dirty by design with the complete WS0–WS9 sprint.
- **No application, test, migration, or configuration file was modified by this review.** No commit, push, merge, stage, reset, restore, clean, or stash operation was performed. This review file is the only file created. Temporary artifacts (PNG conversions, Lighthouse JSON, server log) were written to the session scratchpad, outside the repository.

---

## 10. Final verdict

**APPROVED AFTER MINOR FIXES**

The sprint delivers what `docs/PRE_P2_POLISH.md` asked for. BUG-1's root cause is correctly
identified and fixed at source with regression coverage; BUG-2 and BUG-3 are genuinely
closed; the security model, RLS, middleware, multi-tenancy, RBAC, billing, entitlements,
audit behaviour, and canonical monetary values are all provably untouched; no patient PHI
reaches any public or operator surface; secrets remain server-only; no P2 scope leaked in;
and the final validation report is honest and reproducible. Fix PREP2-R1 … PREP2-R5, then
commit. No further full review cycle is required.

## Re-review history

- **Review Cycle 1 — 2026-07-13:** initial integrated phase review of WS0–WS9. Five required
  findings raised (PREP2-R1 … PREP2-R5), six optional polish findings (PREP2-P1 … PREP2-P6).
  No blocking defect. Verdict: APPROVED AFTER MINOR FIXES.

---

## Targeted Verification — Review Cycle 2 (2026-07-13)

This cycle is limited to PREP2-R1 through PREP2-R5. Review Cycle 1 above is preserved in
full. No P2 feature, migration, middleware, RLS, billing, entitlement, canonical-money, or
unrelated behavior was changed.

### Finding status

| Finding | Status | Evidence |
|---|---|---|
| **PREP2-R1** | **RESOLVED** | `ClinicSignupForm` controls its clinic country and passes it as `defaultCountry`; `InternationalPhoneInput` auto-follows later default changes until a phone-country option is explicitly selected. The native hidden `phoneCountry` and normalized E.164 FormData contract remain unchanged. The targeted signup test covers initial KW, automatic SA follow, manual AE override, and a later clinic-country change that leaves AE intact. |
| **PREP2-R2** | **RESOLVED** | Both reported `ml-auto` utilities are now `ms-auto`. Added-line and untracked-source physical-direction scans returned no matches; the WS3/WS4 review records carry appended correction notes. |
| **PREP2-R3** | **RESOLVED** | `docs/P15C_PERFORMANCE_GATE.md` preserves the older measurements and appends Final Validation Cycle 2's shippable-tree results: Performance 91/90/91, Accessibility 100/100/100, LCP 3.5/3.7/3.5 s, and 198,703-byte initial script transfer. |
| **PREP2-R4** | **RESOLVED** | Appended closure evidence to `P1.5B_REVIEW.md` (P15B-R13), `P1.5D_REVIEW.md` (P15D-P4/P7/P8), and `P1.5_PHASE_REVIEW.md` (P15-P1/P2/P3). P15-P2 was also closed in code: RHF consumers omit `name`, while native FormData consumers retain the hidden E.164/country fields. Historical cycles were not rewritten. |
| **PREP2-R5** | **RESOLVED — REFACTORED** | Added `components/shared/searchable-combobox.tsx` as the single Popover + Command + trigger/search/selection shell. Country, currency, and operator-report filters supply only consumer-specific trigger/item rendering and side effects. Report filters retain their hidden GET-form input; currency retains its server action/refresh; phone retains E.164/country submission. A direct scan of the three consumers finds no remaining local Popover/Command implementation. No waiver was used. |

### Commands executed and exact results

| Command | Result |
|---|---|
| `pnpm exec vitest run tests/unit/components/clinic-signup-phone-country.test.tsx tests/unit/components/p15d-formdata-phone.test.tsx tests/unit/components/searchable-combobox.test.tsx tests/unit/components/operator-report-shell.test.tsx tests/unit/lib/p15d-phone.test.ts tests/unit/lib/p15d-currency.test.ts` (first development run) | **FAIL** — existing tests passed, but the new combobox suite failed before collecting tests because its mocked action referenced a non-hoisted variable. Replaced it with `vi.hoisted`. |
| Same targeted command (second development run) | **PASS** — 6 files, 28/28 tests. |
| Same targeted command after adding explicit P15D-P8 coverage | **FAIL** — 28 tests passed and the new resync assertion expected unformatted `2079460000`; the component correctly rendered its existing national format `020 7946 0000`. The assertion was corrected without changing product code. |
| Same targeted command (final) | **PASS** — 6 files, **29/29 tests**; 2.19 s. Covers signup phone-country behavior plus country, currency, and report combobox consumers. |
| `pnpm typecheck` | **PASS** — exit 0, no diagnostics. |
| `pnpm exec eslint components/auth/clinic-signup-form.tsx components/shared/searchable-combobox.tsx components/shared/international-phone-input.tsx components/settings/currency-combobox.tsx components/operator/report-filter-combobox.tsx components/patients/patient-form.tsx components/settings/clinic-form.tsx components/settings/staff-form.tsx tests/unit/components/clinic-signup-phone-country.test.tsx tests/unit/components/searchable-combobox.test.tsx` | **PASS WITH WARNING** — exit 0, 0 errors, the pre-existing React Hook Form compiler advisory in `patient-form.tsx`. |
| `pnpm lint` | **PASS WITH WARNINGS** — exit 0, 0 errors and the same 4 warnings recorded in Review Cycle 1 (plus the same `jsx-ast-utils` advisory text). |
| `pnpm test` | **PASS** — **95 files, 506/506 tests**; 21.44 s. |
| `pnpm build` | **PASS WITH KNOWN WARNING** — Next.js 16.2.6 Turbopack production build, 52/52 static-generation tasks; middleware-to-proxy deprecation warning only. |
| `PORT=3120 node --env-file=.env.local node_modules/@playwright/test/cli.js test tests/e2e/smoke.spec.ts --workers=1 --grep "display currency preference\|operator shell renders\|WS7 operator report filters"` (managed sandbox) | **INFRASTRUCTURE FAIL BEFORE TESTS** — local TSX server socket creation was denied with `listen EPERM .../tsx-501/45678.pipe`. |
| Same Playwright command with approved local-service access | **PASS** — production Chromium **3/3** in 29.5 s: currency/preferences, phone-country operator invitation (SA + GB persistence), and operator report filter/URL/export. WS7 filtered-report p95: 64.2 ms. Existing non-failing `last_login_update_failed` diagnostic remained. |
| `git diff --unified=0 -- app components \| rg '^\+[^+].*(ml-\|mr-\|pl-\|pr-\|left-\|right-\|text-left\|text-right\|border-l-\|border-r-\|rounded-l-\|rounded-r-\|space-x-)'` | **PASS (no matches)** — `rg` exit 1, empty output across tracked added lines. |
| `for file in $(git ls-files --others --exclude-standard -- app components); do sed 's/^/+/' "$file"; done \| rg '^\+.*(ml-\|mr-\|pl-\|pr-\|left-\|right-\|text-left\|text-right\|border-l-\|border-r-\|rounded-l-\|rounded-r-\|space-x-)'` | **PASS (no matches)** — `rg` exit 1, empty output across untracked source files. |
| `rg -n 'Popover\|Command(Input\|Item\|List\|Empty)' components/shared/international-phone-input.tsx components/settings/currency-combobox.tsx components/operator/report-filter-combobox.tsx` | **PASS (no matches)** — `rg` exit 1; the three consumers no longer duplicate the shell. |
| `git diff --check` | **PASS** — exit 0, no whitespace errors. |

### Readiness

All five required findings are resolved, R5 was refactored rather than waived, and every
required targeted/full validation command available to this scope is green. Manual product
testing remains the next gate before the user chooses whether to commit.

APPROVED FOR MANUAL TESTING AND COMMIT
