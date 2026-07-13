# Pre-P2 WS8 Review — Complete Clinic History (Operator Clinic Detail)

**Status:** IMPLEMENTED — awaiting comprehensive review
**Workstream:** WS8 (`docs/PRE_P2_POLISH.md` §7-WS8)
**Date:** 2026-07-13
**Implementer:** Codex

---

## 1. Current-state audit and scope

The approved plan, roadmap, and every PRE_P2 review through WS7 were read before
implementation. The existing dirty working tree contained the preserved, uncommitted
WS0–WS7 work. No prior workstream file was reset, restored, staged, committed, rewritten,
or discarded.

WS8 was limited to the existing operator clinic detail, one new guarded read boundary in
`lib/supabase/admin.ts`, focused no-PHI integration coverage, and this review record. No
WS9, marketing, P2/i18n, schema, migration, RLS, middleware, billing-domain, subscription
semantics, or tenant clinical behavior was introduced. Operational notes remain fully
deferred: there is no `clinic_notes` schema, query, UI, or placeholder.

## 2. Implementation completed

`app/(operator)/operator/clinics/[id]/page.tsx` is now a complete, sectioned operator
record with an explicit data-honesty legend:

- **Recorded fact** — fields read directly from reviewed platform/clinic metadata rows.
- **Derived from audit log** — safe summaries reconstructed from allowlisted operator
  events; explicitly identified as not being an immutable subscription-event ledger.
- **Future integration** — absent billing-provider data is stated plainly and never
  synthesized.

The page now renders:

- Clinic profile: country, timezone, locale, canonical currency, creation/onboarding
  timestamps, and a grouped clinic-working-hours summary (including split shifts and the
  legacy clinic default fallback).
- Current subscription: plan, status/access reason, provider, trial end, current period,
  and row update timestamp. Existing manual grant/cancel controls are preserved unchanged;
  WS8 adds no mutation.
- Invitation lineage: request/current status/email-sent/accepted/expiry timestamps. Owner
  name, email, phone, raw token, and token hash are intentionally not selected.
- Coupon redemptions joined to safe coupon fields (code, kind/benefit, redemption time,
  current coupon state).
- Current feature overrides plus the existing set/remove controls. Audit-recorded changes
  appear in the timeline.
- Filterable, database-counted, server-paginated usage history with approved metrics,
  25/50/100 page sizes, shareable query state, safe invalid-parameter defaults, exact
  totals, and out-of-range-page clamping with a correct last-page refetch.
- A merged newest-first timeline containing clinic/subscription creation facts,
  invitation timestamps, coupon redemptions, and safe operator-action summaries for
  manual grants/extensions/cancellations, override changes, invitation issuance/resends,
  invitation revocation/email sends, and coupon redemption.
- A quiet **“Payments & contracts — available after billing integration”** section that
  explicitly states that payments, invoices, transaction renewals, and contract references
  are not stored by the current manual provider and are not invented.

All timestamps on this operator record are displayed with an explicit UTC label so the
history does not imply an unstated local timezone.

## 3. Guarded query architecture

`getOperatorClinicHistory()` in `lib/supabase/admin.ts` is the only new privileged read
path. It calls `requirePlatformAdmin()` before creating the service-role client, then reads
only these approved tables/fields:

| Source | Returned shape |
|---|---|
| `clinics` | Profile/localization/onboarding/working-hour fallback metadata |
| `clinic_working_hours` | Weekday and shift bounds |
| `subscriptions` + `plans` | Current commercial subscription row and plan labels |
| `clinic_invitations` | Lifecycle IDs/status/timestamps only |
| `coupon_redemptions` + `coupons` | Redemption and promotion facts |
| `clinic_feature_overrides` | Current feature key/state/timestamps |
| `usage_counters` | Metric/count/limit rows, filtered and ranged in Postgres |
| `platform_audit_logs` | Allowlisted actions converted to sanitized summaries |

No patient, appointment, medical-note, document, settlement, deposit, staff-profile, or
Auth-user table is queried. Raw audit payloads never leave the server-only helper. The
helper filters to eight approved platform actions and maps only known safe fields; an
unrecognized same-clinic audit row cannot appear in the returned history.

Audit rows are collected in reviewed 1,000-row chunks up to 10,000 per source. If that
safety ceiling is ever reached, the page shows an explicit incompleteness warning rather
than presenting a bounded result as complete. Invitation audit actions that predate a
clinic association are recovered by the accepted invitation IDs, then de-duplicated with
clinic-keyed events.

## 4. Data-honesty and history limitations

- `subscriptions` remains one mutable current row. The page does not claim it is immutable
  plan history.
- The creation snapshot plus `subscription.granted`, `subscription.cancelled`, and
  `coupon.redeemed` audit actions are the honest available trial/grant/extension history.
  Exact historical `trial_ends_at` values cannot be reconstructed when older audit payloads
  did not store them; the UI does not fabricate them.
- Open-registration or legacy-provisioned clinics can legitimately have no accepted
  `clinic_invitations` row; the empty state explains that case.
- No historical payments, invoices, renewals-as-transactions, or contracts exist until a
  future billing integration supplies them.
- No operational-notes behavior exists anywhere in WS8, by the resolved Q3 decision.

## 5. Security and no-PHI verification

`tests/unit/integration/ws8-operator-clinic-history.test.ts` seeds a real local clinic with
subscription, accepted invitation, coupon redemption, feature override, split working
hours, 26 usage rows, and platform audit events. It verifies:

- every approved recorded section and safe audit-derived action is returned;
- invitation PII and token fields are absent;
- a deliberately inserted same-clinic `patient.exported` audit event containing a patient
  name and national-ID marker is excluded by the action allowlist;
- no raw `payload`, actor ID, patient/medical key, owner contact field, phone, or email is
  present anywhere in the returned object graph;
- usage filtering occurs before pagination, exact totals are returned, page 2 is correct,
  and an invalid high page clamps and refetches the real last page;
- invalid metric/page/page-size URL state falls back safely;
- a failed `requirePlatformAdmin()` guard rejects the history query before privileged data
  access.

The existing P1D/P1.5B/WS7 operator authorization and no-PHI suites remained green in the
full integration run.

## 6. Accessibility, responsiveness, and P2 protection

- Every section has an `aria-labelledby` relationship and a visible heading.
- Invitation, coupon, and usage data use the shared WS2 semantic `DataTable` (`th[scope]`,
  caption, horizontal containment, sticky usage header, and shared empty states).
- Usage pagination is a labelled `nav`; filters use explicit labels and native controls.
- The WS6 real-link Back control and semantic breadcrumbs remain intact, including restored
  filtered clinic-list state.
- The existing production Playwright clinic-detail flow passed at 390px in light and dark
  themes with no body overflow.
- New/edited UI uses logical properties (`ps`, `pe`, `start`, `text-end`, `border-s`) only;
  the physical-direction grep is clean.

## 7. Validation commands and exact results

| Command | Exact result |
|---|---|
| `node --env-file=.env.local node_modules/vitest/vitest.mjs run tests/unit/integration/ws8-operator-clinic-history.test.ts --no-file-parallelism` | **PASS** — 1 file, 3 tests; final run 918ms |
| `pnpm test` | **PASS** — 91 files, 487 tests; 17.68s |
| `node --env-file=.env.local node_modules/vitest/vitest.mjs run tests/unit/integration --no-file-parallelism` | **PASS** — 12 files, 80 tests; 11.67s |
| `pnpm typecheck` | **PASS** — exit 0; no diagnostics (final run 2.3s) |
| `pnpm lint` | **PASS WITH WARNINGS** — exit 0, 0 errors, 4 pre-existing warnings (`dashboard/page.tsx`, `record-dialog.tsx`, `patient-form.tsx`, `department-form.tsx`) |
| `pnpm build` | **PASS** — Next.js 16.2.6 production build; compiled in 5.3s, TypeScript in 7.6s, 48/48 static pages generated; known middleware-to-proxy deprecation warning |
| `PORT=3104 node --env-file=.env.local node_modules/@playwright/test/cli.js test --workers=1 --grep "WS6 operator clinic detail"` | **PASS** — production build/start and Chromium 1/1; test 3.1s, 21.4s total |
| Physical-direction grep over the WS8 page | **PASS** — no physical-direction utility introduced |
| Diff check over `supabase/migrations`, `middleware.ts`, and `lib/supabase/middleware.ts` | **PASS** — no changed path |
| `git diff --check` | **PASS** — no whitespace errors |

The first targeted integration attempt inside the filesystem sandbox could not reach local
Supabase (`TypeError: fetch failed`). It was rerun with approved local-service access. The
first approved run exposed an out-of-range PostgREST range response for `usagePage=999`;
the loader was corrected to count first, clamp, and fetch the resolved page. The final
targeted and full integration runs pass. No migration reset was required because WS8 adds
no migration or schema change.

## 8. Acceptance criteria checklist

- [x] Explicit data-honesty legend distinguishes recorded, audit-derived, and unavailable data
- [x] Full clinic profile and working-hours summary render without PHI
- [x] Current subscription fields remain present and honest about the mutable-row model
- [x] Invitation lineage renders lifecycle timestamps without owner contact data
- [x] Coupon redemption history is joined and displayed
- [x] Feature overrides remain present; existing controls are preserved
- [x] Usage history is filterable and server-paginated through the shared table system
- [x] Manual grants/extensions/cancellations, override changes, invitation resends, and coupon effects appear when recorded in the audit log
- [x] Timeline merges recorded facts and audit-derived events in time order
- [x] Payments/contracts placeholder is explicit and contains no invented data
- [x] Platform-admin guard applies to the new query boundary
- [x] No-PHI integration tests pass over every returned section and audit path
- [x] WS8 adds no mutation, migration, schema, RLS, middleware, or canonical-money change
- [x] No `clinic_notes` schema, UI, query, or placeholder exists
- [x] No WS9 or later workstream was started
- [x] Targeted integration, full unit/integration, typecheck, lint, build, production browser, logical-direction, and diff gates pass

## 9. Files changed

WS8 product code:

- `app/(operator)/operator/clinics/[id]/page.tsx`
- `lib/supabase/admin.ts`

WS8 tests/documentation:

- `tests/unit/integration/ws8-operator-clinic-history.test.ts` (new)
- `docs/reviews/PRE_P2_WS8_REVIEW.md` (this file)

## 10. Known limitations or unresolved required work

The limitations in §4 are source-data limitations and are made visible in the UI. No
required WS8 implementation work is known to remain. This is an implementation and
validation record only; it does not constitute independent comprehensive approval or
approval to merge.

## 11. Git status

- Current branch: `main`, tracking `origin/main`.
- The working tree remains dirty by design with the preserved WS0–WS7 files plus the four
  WS8 paths in §9.
- The staging area is empty. No branch, commit, push, merge, stage, reset, restore, stash,
  clean, or destructive command was used.

Stop after WS8. WS9 was not started.
