# Pre-P2 WS0 Review — Dashboard Error Investigation & Fix (BUG-1)

**Status:** IMPLEMENTED — awaiting review
**Workstream:** WS0 (`docs/PRE_P2_POLISH.md` §7-WS0)
**Date:** 2026-07-13
**Implementer:** Claude Code

---

## 1. Root cause (identified with evidence)

**BUG-1 is a client-side `RangeError` in `lib/currency/conversion.ts` `formatMoney`, introduced by P1.5D.** It is *not* schema drift, *not* the admin-client cache chain, and *not* the subscription gates.

`formatMoney` merged the currency registry's `minorUnits` into **both** `minimumFractionDigits` and `maximumFractionDigits`, then spread caller options on top:

```ts
{ minimumFractionDigits: definition?.minorUnits, maximumFractionDigits: definition?.minorUnits, ...options }
```

Every dashboard money surface passes `{ maximumFractionDigits: 0 }` for compact figures
(`components/dashboard/revenue-widget.tsx:37`, `doctor-dashboard.tsx:99`,
`doctor-dashboard-charts.tsx:86`, `analytics-section-charts.tsx:407`) and
`components/reports/report-formatters.ts:18` passes `0 | 1`. For any display currency with
`minorUnits > 0` (i.e. **all clinics** — KWD=3, TRY=2, USD=2 …) the resolved options become
`min=2..3, max=0..1`, and `Intl.NumberFormat` throws
`RangeError: maximumFractionDigits value is out of range`, crashing `<RevenueWidget>` and
bubbling to `app/(protected)/error.tsx` ("Something went wrong").

**Reproduction (2026-07-13, local stack, fully migrated schema):** seeded a fresh clinic +
admin (`scratchpad ws0/seed-admin.mjs`), drove login → `/dashboard` with Playwright against
`next dev` on `PORT=3100`. Result: error boundary rendered; captured browser console stack:
`RangeError: maximumFractionDigits value is out of range → new NumberFormat → formatMoney →
formatCurrency → fmtMoney → RevenueWidget`. The crash reproduces on a **brand-new empty
clinic**, admin role — no legacy data required.

**Why the e2e suite never caught it:** the smoke fixture seeds receptionist/doctor/operator
users but **no admin or manager**, and the receptionist dashboard renders no compact money
figure. The P1.5D display-currency e2e checks the patient page (which passes no
fraction-digit override), so the conflicting-override path was never exercised.

**Bisect by role branch:** admin and manager (analytics charts) and doctor (revenue stat)
all crash; receptionist does not render compact money and survives. Matches the report
("admin … sees the boundary").

## 2. Secondary environmental finding (documented, not the crash)

The remote Supabase project (`ayzetxywrqouqpurbjuv`, targeted by `.env.local` and the
production deploy) is missing the two newest migrations — `20260712090000_p15b_invitation_email`
and `20260712150000_p15d_intl_ux_foundations`. Confirmed via the project's migration table and
live API logs: `GET /rest/v1/profiles?select=display_currency` → **400**,
`GET /rest/v1/fx_rates` → **404**. These degrade gracefully in code (`data: null` fallbacks) and
do **not** produce the boundary, but they silently disable display-currency conversion and the
invitation email-sent marker in that environment.

**Runbook note (user action required — not performed by this sprint):** run
`supabase db push` (or `supabase migration up`) against the remote project to apply the two
missing migrations. The P1.5D migration includes the reviewed E.164 backfill; it was clean-slate
verified in the P1.5D review. Also note `package.json` `db:types` references a stale project id
(`tslylwruuntrqjdzreot`); the linked project is `ayzetxywrqouqpurbjuv`.

## 3. Fix

- `lib/currency/conversion.ts` — `formatMoney` now resolves fraction-digit bounds after the
  caller's options: when a caller overrides only one bound and the registry default on the
  other bound conflicts (min > max), the caller's bound wins. No behavior change for calls
  without overrides (registry minor units still applied; unit-locked).
- No cosmetic fallback added anywhere; the error path itself is fixed.

### Hardening (same workstream, per §7-WS0 step 4)

- `app/(protected)/dashboard/page.tsx` — all three `Promise.all` fan-outs (admin,
  receptionist, manager) now pass through `logAndReturn(role, results)`, which logs any
  per-query `error` server-side with the failing query index. Rendering still degrades to
  empty sections (`?? []` / `?? 0`), but failures are no longer silent.
- `actions/doctor-dashboard.ts` — `fetchDoctorDashboardStats` gets the same query-error
  logging (`logStatsQueryErrors`).
- `app/(protected)/error.tsx` — boundary copy now explains what happened, that data is safe,
  what to do next, and keeps the digest; adds a "Go to dashboard" escape hatch.
- Empty-clinic rendering verified: zero-data admin dashboard renders meaningful empty states
  ("No appointments today", zeroed revenue) — screenshot captured during reproduction.

## 4. Regression tests

- **Unit:** `tests/unit/lib/p15d-currency.test.ts` — new case "honors caller fraction-digit
  overrides without an Intl RangeError": KWD (3 minor units) with `maximumFractionDigits: 0`
  and `1`, approximate-conversion path with override, JPY with `minimumFractionDigits: 2`,
  and no-override registry behavior. **7/7 pass.**
- **E2E:** `tests/e2e/smoke.spec.ts` — new serial test "a fresh empty clinic renders every
  role dashboard without the error boundary": seeds an empty clinic + admin/manager/doctor/
  receptionist, logs in as each, asserts the role heading renders, the boundary text is
  absent, zero `pageerror` events, and (admin) the Revenue collected widget renders.
  **Passed 1/1 (10.7s)** against the dev server; included in the full serial suite run.

## 5. Acceptance criteria (§19-WS0)

- [x] Root cause identified and documented with the failing component named (`formatMoney` → `RevenueWidget`)
- [x] Fix applied at the root cause; no cosmetic fallback masking errors
- [x] Empty-clinic fixture green (all four roles)
- [x] Error boundary copy improved (digest retained)
- [x] Environmental vs. code distinction documented (§2 runbook note)

## 6. Files changed

- `lib/currency/conversion.ts`
- `app/(protected)/dashboard/page.tsx`
- `actions/doctor-dashboard.ts`
- `app/(protected)/error.tsx`
- `tests/unit/lib/p15d-currency.test.ts`
- `tests/e2e/smoke.spec.ts`
