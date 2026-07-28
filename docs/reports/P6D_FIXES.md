# P6D Review Fixes

**Date:** 2026-07-29

**Review:** `docs/reviews/P6D_REVIEW.md`

**Scope:** P6D review fixes only. No comprehensive P6 review, new P6
functionality, commit, push, or merge.

## 1. Fixes applied

### 1.1 Meta business-verification readiness fails closed

Replaced the substring approval heuristic with an exact, case-insensitive
allow-list:

- `approved`
- `verified`

Empty values, `not_verified`, `unverified`, pending/negative states, values that
only contain an approved word, and all unrecognized values now fail the readiness
check. This prevents a Meta channel from becoming production-ready without an
explicit approved business/account-review signal.

### 1.2 Meta quality readiness fails closed

Replaced the inverse negative-state heuristic with an exact, case-insensitive
healthy-state allow-list:

- `green`
- `yellow`

`UNKNOWN`, empty values, `RED`, negative/degraded states, and all unrecognized
values now fail the quality readiness check instead of being treated as healthy.

### 1.3 Read-only cron failures no longer retry successful core work

Restored the daily cron HTTP failure policy to the three core mutation jobs:
appointment reminders, invoice follow-ups, and pending-booking expiry. The route
returns `503` only when all three core jobs reject.

Meta reconciliation and WhatsApp health checks remain independent,
best-effort/read-only jobs. Their rejection no longer forces the route to return
`503`, so a diagnostic outage does not re-run otherwise successful reminder and
follow-up work. Failure visibility remains intact:

- rejected jobs are captured by Sentry with their existing job tags;
- fulfilled summaries, including per-job `failed` counts, remain in the JSON
  response;
- a rejected read-only job remains explicitly represented as `null` in its
  response field.

### 1.4 Verified-event wording matches the stored timestamp

Changed the EN/AR dashboard label from webhook/inbound-oriented wording to:

- English: `Last verified provider callback`
- Arabic: `آخر استدعاء موثّق من المزوّد`

This accurately describes `last_verified_webhook_at`: any signature-verified
provider callback that was successfully routed to the clinic/channel, including
message, template-status, and account-update callbacks.

## 2. Focused test coverage

- Business readiness matrices cover the two approved states and reject
  `not_verified`, `unverified`, pending/negative states, empty/null values,
  substring lookalikes, and unrecognized values.
- Quality readiness matrices cover `GREEN`/`YELLOW` and reject `UNKNOWN`,
  empty/null values, negative states, and unrecognized/substr-like values.
- Cron route tests verify rejected reconciliation and health jobs return `200`,
  still report successful core results, and are captured by Sentry.
- Cron route tests verify fulfilled all-failed diagnostic summaries remain visible
  without changing the route to `503`.
- Catalog assertions lock the accurate EN/AR provider-callback wording.

## 3. Files changed in this fix cycle

- `lib/messaging/health.ts`
- `app/api/cron/reminders/route.ts`
- `messages/en.json`
- `messages/ar.json`
- `tests/unit/lib/p6d-whatsapp-health.test.ts`
- `tests/unit/api/p3d-cron-routes.test.ts`
- `tests/unit/components/p6d-whatsapp-health-dashboard.test.tsx`
- `docs/reports/P6D_FIXES.md`

No migration or database-type change was required.

## 4. Validation results

| Validation | Result |
|---|---|
| Focused fix tests | 3 files / **42 tests passed** |
| P6D/P6C and touched unit regressions | 10 files / **92 tests passed** |
| Live local-Supabase integration/regression | 5 files / **36 tests passed** |
| Full non-integration suite | 250 files / **1,906 tests passed** |
| TypeScript | `pnpm exec tsc --noEmit` — pass |
| Focused ESLint | P6D source and changed tests — pass |
| RTL gate | `pnpm lint:rtl` — pass; 482 files scanned |
| Message unused check | `pnpm i18n:unused` — pass |
| EN/AR catalog regression | 1 file / **2 tests passed** |
| Production build | `pnpm build` — pass; 71 routes generated |
| Diff whitespace | `git diff --check` — pass |

The live suite used the local Supabase instance and covered P6D health boundaries,
P6C review-fix reconciliation, messaging RLS, WhatsApp webhook persistence, and
operator-report boundaries.

The two repository-wide P6C i18n scanner findings were intentionally left
unchanged:

- `pnpm lint:i18n` reports the existing TypeScript callback-signature false
  positive in `components/settings/whatsapp-onboarding-wizard.tsx:141`;
- `pnpm i18n:missing` reports the existing three dynamic P6C connection-state /
  connection-reason lookups.

No new scanner finding originates from a P6D fix file.
