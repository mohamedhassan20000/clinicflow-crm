# Pre-P2 WS3 Review — Global Country & Phone Selector (BUG-3)

**Status:** IMPLEMENTED — awaiting review
**Workstream:** WS3 (`docs/PRE_P2_POLISH.md` §7-WS3)
**Date:** 2026-07-13

## 1. What changed

- **`lib/phone/registry.ts`** — `PHONE_COUNTRIES` now **derives from
  `libphonenumber-js` `getCountries()`** (every supported country, 200+), not a
  hand-maintained 9-country list. Per country: ISO code, English name via
  `Intl.DisplayNames("en", {type:"region"})`, dial code via
  `getCountryCallingCode`, flag emoji from regional-indicator arithmetic (no
  assets). A pinned `PRIORITY_PHONE_COUNTRIES` group (KW, SA, AE, QA, BH, OM, EG,
  TR) sits at the top; the rest are alphabetical by English name.
  - `isPhoneCountry` widened to the full `getCountries()` set.
  - `localPhoneValue` now renders **any** valid stored E.164 read-normally
    (`formatNational` for the inferred country) instead of falling back to KW —
    this is the structural fix for **BUG-3 / P15D-P4** (legacy GB/DE/FR values
    round-trip).
- **`components/shared/international-phone-input.tsx`** — the `Select` is replaced
  by a **cmdk Command combobox in a Popover** (`CountryCombobox`): search filters
  on name / ISO code / dial code, full keyboard nav (arrows/Enter/Escape via
  cmdk), `role="combobox"` trigger with `aria-label="Country calling code"`, and
  `role="option"` items. Trigger stays compact (flag + dial code). The FormData
  hidden inputs (`name` = E.164, `${name}Country`) are unchanged, so the
  server-side contract is identical.
  - Added a guarded `useEffect` resync (tracks last-emitted value via a ref) so an
    external `value` change (RHF reset reusing a dialog) re-syncs country/local
    **without** fighting the user's typing — closes P15D-P8.

## 2. Server-side enforcement (unchanged contract, wider set)

`normalizePhone` still validates per country and returns E.164 or `null`; because
`isPhoneCountry` now accepts every libphonenumber country, server validation
matches the widened UI exactly. All server call sites are untouched
(`actions/{auth,early-access,settings,profile}.ts`, `lib/signup.ts`,
`lib/validations/settings.ts`) — they already route through `normalizePhone`.
E.164 storage, the `phoneCountry` plumbing, and the backfill's preserve-unparseable
guarantee are unchanged. `defaultCountry` still flows from clinic country at the
signup fallback (`actions/auth.ts:404`).

## 3. All 7 surfaces move together

Every entry point imports the same `InternationalPhoneInput`/`InternationalPhoneField`
(`early-access-form`, `clinic-signup-form`, operator `invitations`,
`patient-phone-input`, `clinic-form`, `staff-form`, `profile-page`) — they inherit
the combobox with no per-surface change.

## 4. Bundle (§16)

No new libphonenumber metadata: `getCountries`/`getCountryCallingCode`/
`Intl.DisplayNames` use data already shipped by the existing `libphonenumber-js`
dependency and the platform Intl. The country list is computed at module load, not
a shipped dataset. The marketing page's phone input remains dynamically imported
(P15-R1), so `/`'s initial bundle is unaffected — re-verified in the WS9 Lighthouse
run.

## 5. Tests

- **Unit** `tests/unit/lib/p15d-phone.test.ts` (14 tests): GCC + US round-trips;
  rejects unknown country; **registry now >200 countries with priority group
  pinned first and the rest alphabetical**; every entry has flag + dial code; and
  a new **legacy round-trip** suite (GB/DE/FR/IN/PK/PH) proving stored non-GCC
  E.164 values validate, render read-normally, and re-normalize to the same E.164
  (BUG-3 closed). **14/14 pass.**
- **Unit** `tests/unit/components/p15d-formdata-phone.test.tsx` — FormData contract
  (E.164 + country) still green under the combobox.
- **E2E** `tests/e2e/smoke.spec.ts` operator test: SA invitation via the searchable
  combobox (type "Saudi" → select), **plus a new 🇬🇧 United Kingdom invitation**
  asserting `+442079460000` persisted — the non-registry country end-to-end path
  required by §17. **1/1 passed.**
- Visual: combobox open with "United" typed → UAE / United Kingdom / United States
  filtered with flags + dial codes (screenshot captured).
- `pnpm typecheck` clean.

## 6. Acceptance criteria (§19-WS3)

- [x] All libphonenumber countries selectable with search / type-ahead / keyboard
- [x] Server validation matches the widened UI
- [x] E.164 storage unchanged
- [x] Legacy values round-trip (P15D-P4 / BUG-3 closed)
- [x] Bundle delta within budget (no new metadata)
- [x] Logical CSS only (no new physical-direction classes)

## 7. Files changed

`lib/phone/registry.ts`, `components/shared/international-phone-input.tsx`,
`tests/unit/lib/p15d-phone.test.ts`, `tests/e2e/smoke.spec.ts`.

## Targeted correction — 2026-07-13

The integrated phase review later found one WS3 `ml-auto` despite the checklist result
above. PREP2-R2 replaced it with `ms-auto`; the final added-line/new-file
physical-direction scan is clean. This note preserves the original review claim while
recording its correction.
