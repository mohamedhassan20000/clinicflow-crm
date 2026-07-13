# Pre-P2 WS4 Review — Currency Preference Placement & Expanded Registry

**Status:** IMPLEMENTED — awaiting review
**Workstream:** WS4 (`docs/PRE_P2_POLISH.md` §7-WS4)
**Date:** 2026-07-13

## 1. Placement — Preferences reachable by ALL staff roles

- **Header `CurrencySelector` removed** (`components/layout/dashboard-shell.tsx`);
  `components/layout/currency-selector.tsx` deleted.
- **New Preferences page** hosting Display Currency + Theme + a Language
  placeholder (Language control arrives with P2A next-intl).
- **Entry point:** a "Preferences" item in the header user-menu dropdown
  (`SlidersHorizontal` icon), available to **every** authenticated role.

### Route decision (important — read against §13)

The plan's illustrative path was `app/(protected)/settings/preferences/`, but the
Settings area is hard-gated to admin/manager **in `lib/supabase/middleware.ts`**
(`ADMIN_MANAGER_PREFIXES = ["/settings"]`, redirect at lines 281-291). §13 forbids
touching middleware without escalation. The plan explicitly offered the compliant
alternative — "a direct 'Preferences' link in the header user menu." So the page
lives at **`app/(protected)/preferences/page.tsx`** (URL `/preferences`, outside
`/settings`), secured by the `(protected)` layout's `requireUser()` and reachable by
admin, manager, doctor, and receptionist alike. **No middleware/gate change was
made.** Admin-only Clinic Settings sub-pages keep their own `requireRole` guards —
not widened.

**Verified end-to-end (live browser):** a receptionist opens the user menu →
Preferences → `/preferences` (heading visible); the same receptionist hitting
`/settings/staff` is still redirected to `/dashboard`; the header no longer renders
a Display-currency control.

## 2. Canonical vs. personal distinction

The Display-currency card states the conversion is approximate (≈), personal ("to
you"), and that clinic records never change; it names the clinic's canonical
operating currency read-only beneath the selector. Canonical `clinics.currency` is
never editable.

## 3. Expanded, provider-intersected registry (Q5)

`lib/currency/registry.ts` rewritten: a hand-verified seed of `{ code, countryCode,
minorUnits }` (40 currencies — the target-market set plus global majors, **all
Open Exchange Rates-covered and Intl-formattable**), with `countryName`,
`currencyName`, and `flag` **derived** from `Intl.DisplayNames` / regional-indicator
arithmetic. Only the money-critical fields are hand-maintained; ISO 4217 minor units
are explicit (JPY/KRW = 0, GCC dinars = 3, default 2). Adding a currency is one
validated line; the conversion path is never touched. `CURRENCY_CODES` is the single
provider symbol list.

- `updateDisplayCurrency` still validates server-side against `isSupportedCurrency`
  (`actions/profile.ts` unchanged).
- The FX provider (`open-exchange-rates.ts`) now requests `CURRENCY_CODES` and keeps
  the **all-or-nothing** snapshot rule (a short response fails closed, last good
  rows retained) — every registry currency is OER-covered.
- Selector is a **searchable cmdk combobox** (`components/settings/currency-combobox.tsx`),
  sharing the WS3 pattern; offers only registry currencies.

## 4. Unavailable/expired FX behavior — unchanged

`convertForDisplay` still preserves canonical values, marks `≈`, flags `· stale
rate` >48h, and suppresses conversion >72h. Canonical monetary columns are never
written (no migration in this workstream).

## 5. Carried polish closed

- **P15-P1** — one shared money composer: `lib/currency/format.ts`
  (`composeDisplayMoney`) now used by both `contexts/clinic-settings-context.tsx` and
  `lib/currency/server.ts`; the duplicated `≈ X (Y)` string is gone.
- **P15-P3** — `lib/currency/server.ts` wraps the `display_currency` + `fx_rates`
  load in React `cache()` (`loadDisplayContext`), and `app/(protected)/layout.tsx`
  now shares that same memoized loader — converted pages add no duplicate queries.

## 6. Tests

- **Unit:** `p15d-currency.test.ts` — registry ≥30 entries, derived
  names/flags/country present, correct minor units (JPY/KRW 0, BHD/OMR 3), FX
  provider snapshot maps the wider set; the WS0 fraction-digit case still green.
  `settings-nav.test.tsx` unchanged (Preferences is not a settings tab).
  `clinic-settings-context.test.tsx` green against the shared composer.
- **E2E:** `smoke.spec.ts` "display currency preference (Settings → Preferences)"
  — header selector absent; receptionist reaches Preferences via the user menu;
  currency change persists (`USD`) and renders `≈ US$ (… KWD)` on the patient page;
  canonical KWD intact. **1/1 passed.**
- Full unit suite **459/459**; `pnpm typecheck` clean; `pnpm lint` 0 errors.

## 7. Acceptance criteria (§19-WS4)

- [x] Header control removed
- [x] Preferences page exists, reachable by every staff role without widening
      admin-only settings (verified: receptionist reaches it; still blocked from Staff)
- [x] Canonical vs. personal distinction in copy
- [x] Selector searchable, limited to FX-provider-covered tested currencies
- [x] Unavailable-FX behavior preserved (canonical shown, no invented rates)
- [x] No monetary column touched
- [x] P15-P1 / P15-P3 closed

## 8. Files changed

New: `app/(protected)/preferences/page.tsx`, `components/settings/currency-combobox.tsx`,
`lib/currency/format.ts`.
Changed: `lib/currency/registry.ts`, `lib/currency/open-exchange-rates.ts`,
`lib/currency/server.ts`, `contexts/clinic-settings-context.tsx`,
`app/(protected)/layout.tsx`, `components/layout/dashboard-shell.tsx`,
`tests/unit/lib/p15d-currency.test.ts`, `tests/e2e/smoke.spec.ts`.
Removed: `components/layout/currency-selector.tsx`.

## Targeted correction — 2026-07-13

The integrated phase review found one WS4 `ml-auto` in the currency option rendering.
PREP2-R2 replaced it with `ms-auto`; the final added-line/new-file physical-direction scan
is clean. The original workstream history above is otherwise unchanged.
