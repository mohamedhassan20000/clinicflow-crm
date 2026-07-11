# P1D Implementation Report

## Review findings and fixes

The P1D review returned REQUEST CHANGES with two High, four Medium, and five Low findings. Every finding is fixed; no product scope was added.

- **H1 — export truncated at PostgREST's 1,000-row cap:** every exported table is now paged (`fetchAll`, `.range()` over a stable `created_at, id` ordering, `PAGE_SIZE = 1000`) until a short page proves exhaustion. Tenant scope is unchanged: every query still runs through the caller's RLS session with the explicit `clinic_id` filter. A live integration test seeds **1,050 patients** and asserts all 1,050 appear in `patients.csv` — a count the pre-fix route could never exceed 1,000.
- **H2 — CSV formula injection:** `csvRow` now neutralizes any string cell starting with `=`, `+`, `-`, `@`, tab, or carriage return by prefixing an apostrophe and force-quoting the cell. Numeric values (e.g. negative amounts) are unaffected. Unit tests cover all six dangerous prefixes plus normal/numeric cells; a live export test seeds a patient named `=HYPERLINK(...)` and asserts the neutralized form in the ZIP.
- **M1 — silent zero-row invitation updates:** `issueClinicInvitation` and `revokeClinicInvitation` append `.select("id")` to their conditional updates and treat zero matched rows as failure. A raw invitation link is returned only when the new token hash was actually persisted; a revoke that left the token live is reported as an error, never success. Unit tests cover the stale/concurrent paths for issue, resend, and revoke.
- **M2 — orphan scan capped at 1,000 Auth users:** `listOrphanedSignupUsers` now walks pages until the API returns a short (final) page. A documented safety bound (500 pages × 100 users) exists only to stop a pathological directory from hanging the panel; hitting it returns `truncated: true`, which Mission Control renders as an explicit incompleteness warning.
- **M3 — untested export role gate:** a dedicated guard test proves the route invokes `requireRole` with exactly `"admin"`, and that receptionist, doctor, and manager sessions are rejected before a single table is queried — no ZIP bytes are ever produced. The live tenant-isolation test is preserved unchanged.
- **M4 — no export size/memory protection:** the route enforces a 256 MB uncompressed-payload budget while assembling entries and returns a clear 413 with guidance ("contact platform support for an operator-assisted export") when exceeded — never a silent partial archive. `buildZip` additionally refuses (RangeError) archives that would overflow the non-ZIP64 format: >65,535 entries, any entry >4 GiB, or total offset >4 GiB.
- **L1 — quota projection wording:** the issuance error and the invitations-page banner now state that the projection is conservative (accepted this week **plus all open invitations regardless of issue week**), that issuance is a soft, non-atomic operator control, and that acceptance is never blocked. The non-atomic read-then-issue behavior is documented in code.
- **L2 — headline stats capped by row arrays:** Mission Control totals (clinics, subscription states, pending requests, open invitations, coupons, overrides) are now exact `count` queries; subscription state splits use filtered count queries mirroring `resolveSubscriptionAccess` semantics. Detail lists are explicitly bounded (`OPERATOR_CLINIC_LIST_LIMIT = 500`, expiring trials 50, activity 8, invitations 200) with a visible "showing newest N of M" notice; the clinic detail page fetches its clinic directly (`getOperatorClinic`) instead of searching the bounded list, and the clinics table fetches subscriptions for exactly the listed clinics in chunked `.in()` queries.
- **L3 — dual-role platform admins:** both the middleware operator branch and `requirePlatformAdmin()` now check any existing clinic profile: a deactivated profile is signed out/denied, `must_change_password` redirects to the password flow first. Platform admins with no profile (the designed shape) pass untouched. Middleware tests cover admitted-no-profile, admitted-active-profile, denied-inactive, and password-change-first.
- **L4 — coupon date-only expiry:** a date-only expiry is now inclusive — `couponExpiryFromInput` normalizes it to `23:59:59.999Z` of the selected day; full ISO timestamps pass through. The coupons form states the inclusive semantics. Boundary unit tests added.
- **L5 — discarded signing failures:** a failed bulk `createSignedUrls` call now fails the export with a clear 502; per-document failures are recorded in a new `signing_error` column in `documents.csv`, so a blank link is never silently presented as complete.

## Export pagination and size strategy

Bounded, not streaming: each table is paged at 1,000 rows per request through the caller's RLS session and accumulated in memory, with a running byte budget capped at 256 MB of uncompressed CSV (413 on breach). A store-only ZIP of CSVs at clinic scale sits far below that budget; streaming was rejected as disproportionate complexity for P1D and can replace the cap without changing the route's contract if a real clinic ever approaches it. `buildZip` independently guards the ZIP format's own uint16/uint32 limits so an oversized archive can never be silently corrupted.

## Medical notes of soft-deleted patients (documented decision)

`medical_notes_metadata.csv` excludes notes whose patient is soft-deleted: the `medical_notes` RLS select policy requires a live patient row, and including those notes would require a service-role bypass of the PHI boundary, which the export route must never hold. The exclusion is visible rather than silent — `patients.csv` deliberately includes soft-deleted patients with their `deleted_at`. Documented in the route and here; restoring a patient restores their notes to the next export.

## Summary

- Added the operator Mission Control panel at `app/(operator)/` behind `requirePlatformAdmin()`, monitoring clinics, trials (with 7-day expiry list), subscriptions by effective access state, usage vs. limits, invitations with live weekly progress, coupons and redemptions, feature overrides, recent invitation activity, and orphaned clinic-owner signup Auth users. Delivery-health and Sentry widgets are explicit placeholders pending P3.
- Added operator management: registration mode / weekly limit / invitation expiry settings, invitation create-issue-resend-revoke with the §3.2 issuance-time weekly-limit block (explicit override), coupon CRUD with clinic/invitation assignment, per-clinic feature-flag overrides, and manual subscription grants/cancellation through the P1B `manual` provider. Every entitlement-affecting mutation invalidates `entitlements:<clinicId>`.
- Added the per-clinic data export `app/(protected)/settings/export/route.ts`: clinic-admin-only ZIP containing `patients.csv`, `appointments.csv`, `medical_notes_metadata.csv` (metadata only — note bodies excluded), `invoices.csv` (billed services, deposits, settlements), and `documents.csv` with 24-hour signed URLs.
- Added `/operator` middleware handling: platform admins (who deliberately hold no clinic profile) bypass the clinic gates on operator routes only; all other users — including authenticated non-GET Server Action replays — are redirected away before any operator surface renders.

## Files changed

- New: `actions/operator.ts`, `lib/operator.ts`, `lib/zip.ts`, `components/operator/operator-action-form.tsx`, `app/(operator)/layout.tsx`, `app/(operator)/operator/{page,clinics/page,clinics/[id]/page,invitations/page,coupons/page,settings/page}.tsx`, `app/(protected)/settings/export/route.ts`
- Modified: `actions/early-access.ts` (issuance quota block + form-shaped signatures), `lib/supabase/admin.ts` (`listOperatorClinics`, `listOrphanedSignupUsers`), `lib/supabase/middleware.ts` (operator trust boundary)
- Tests: `tests/unit/lib/operator.test.ts`, `tests/unit/lib/p1d-invitation-lifecycle.test.ts`, `tests/unit/lib/p1d-export-guard.test.ts`, `tests/unit/integration/p1d-operator-panel.test.ts`, `tests/unit/integration/p1d-data-export.test.ts`, extended `tests/unit/lib/p1b-middleware-gating.test.ts`
- Review-fix pass additionally modified: `lib/zip.ts`, `lib/operator.ts`, `lib/rbac.ts`, `app/(protected)/settings/export/route.ts`, `actions/early-access.ts`, `actions/operator.ts`, `lib/supabase/admin.ts`, `lib/supabase/middleware.ts`, and the operator pages (`page`, `clinics/page`, `clinics/[id]/page`, `invitations/page`, `coupons/page`)

## Migrations

None, as the plan requires. P1D manages P1A–P1C objects exclusively through existing RLS policies and RPCs. No new dependency was added either: the export ZIP is produced by a small store-only writer (`lib/zip.ts`) on Node's built-in `zlib.crc32`, verified against the system `unzip` tool.

## Operator security model

- Platform-admin identity is `platform_admins` membership only — fully independent of clinic RBAC; operators hold no clinic profile and therefore no tenant role.
- Three enforcement layers: middleware redirects non-members off every `/operator` path (GET and POST); the `(operator)` layout re-checks with `requirePlatformAdmin()`; every operator server action calls `requirePlatformAdmin()` before touching data.
- All operator reads/writes of SaaS tables (`platform_settings`, `subscriptions`, `plans`, `coupons`, `clinic_invitations`, `clinic_feature_overrides`, `usage_counters`) go through the operator's own RLS session — the panel gains no service-role query path to tenant tables.
- Exactly two reviewed service-role helpers exist for data RLS cannot serve: `listOperatorClinics()` (clinic metadata columns only) and `listOrphanedSignupUsers()` (Auth users with the signup marker and no profile — the P1C compensation backstop).
- Raw invitation tokens are returned once to the operator UI, rendered as a one-time link, and never persisted or logged.

## PHI isolation

- `patients`, `medical_notes`, and even `clinics` remain invisible to the operator session — asserted live with a seeded patient and a clinic-admin positive control reading the same row.
- The operator panel renders no clinical data anywhere; usage/subscription/invitation views carry clinic names (metadata) at most.
- The `listOperatorClinics` helper selects a fixed metadata column list; no PHI table is reachable from any operator code path.

## Management capabilities

- **Settings:** registration mode, weekly invite limit, invitation expiry — effective immediately on the public flow (asserted live via anon `get_public_registration_status` after an operator flip).
- **Invitations:** create+issue, resend (token rotation), revoke; issuance is blocked when accepted-this-week plus open invitations reach the weekly limit, with an explicit operator override; already-issued invitations always stay redeemable (§3.2).
- **Coupons:** create all three kinds with expiry, redemption caps, and clinic- or invitation-assignment (mutually exclusive, mirroring the DB constraint); activate/deactivate.
- **Subscriptions:** manual grants (plan, N months extending a live period, or unbounded) and immediate cancellation via `manualBillingProvider.cancelSubscription`; both invalidate the clinic's entitlement cache, as do override changes.
- **Overrides:** per-clinic feature-flag upsert/remove on the relational `clinic_feature_overrides` table.

## Data-export security

- `requireRole("admin")` (tenant admin) plus the middleware admin/manager settings gate; every query runs through the caller's RLS session, so cross-tenant rows are structurally excluded (asserted live with a two-clinic fixture — the foreign patient never appears in the archive).
- Document access is via 24-hour signed URLs listed in `documents.csv`; file bytes are not embedded. Medical note bodies are deliberately excluded (metadata only, per §3.6).
- The billing-gate middleware applies to the route: an expired clinic cannot self-export until re-activated — surfaced as an open product question below rather than silently exempted.

## Tests and validation

New coverage: issuance-quota block/override; manual-grant period math including month-end clamping; ZIP structural validity and CSV escaping; middleware operator cases (platform admin without profile admitted on GET+POST with no clinic billing gates queried; non-members redirected on every operator route); live operator PHI denial with positive control; live operator SaaS management vs. clinic-admin denial (subscription self-grant, override self-serve, settings write); live registration-mode immediacy; live tenant-isolated export ZIP content.

Added by the review-fix pass: CSV formula-injection units for every dangerous prefix plus normal/numeric cells; ZIP entry-count overflow refusal; coupon inclusive-expiry boundary units; invitation stale/concurrent-state units (issue, resend, revoke against zero-row updates — no raw token without a persisted hash, no false revoke success); export role-gate units (guard invoked with exactly `"admin"`; receptionist/doctor/manager rejected before any query); dual-role middleware cases (inactive profile denied, pending password change redirected, no-profile and active-profile admitted); live export completeness past the 1,000-row cap (1,050 seeded patients, all present) and live formula-payload neutralization.

Final validation (after all fixes):

- `pnpm lint` — passed, 0 errors, 4 pre-existing warnings.
- `pnpm typecheck` — passed.
- `pnpm test` — passed: 63 files, 351 tests.
- `pnpm test:integration` — passed: 8 files, 54 tests against local Supabase.
- `pnpm test:e2e` — passed: 7 Playwright tests.
- `pnpm build` — passed, including all six operator routes and `/settings/export`.
- `supabase db lint --local --level warning` — only the two pre-existing `v_service_id` warnings in legacy billing RPCs.
- `git diff --check` — clean.
- `supabase db reset` — not run: P1D adds no migrations (plan-mandated); integration and e2e suites ran against the fully migrated local stack.
- ZIP output additionally verified end-to-end with the system `unzip` binary (listing + payload extraction).
- Environment note: `.env.local`'s `LOCAL_SUPABASE_PUBLISHABLE_KEY` had gone stale against the running local stack (legacy JWT vs. current `sb_publishable_…`), which 401'd anonymous integration paths; it was updated to the stack's current key. No product code was involved.

## Assumptions

- Platform admins are provisioned by direct `platform_admins` insert (service role), as established in P1A; no self-serve grant surface exists.
- "Invoices" in §3.6 maps to the existing patient-billing tables: `appointment_services` (billed line items), `patient_deposits`, and `outstanding_settlements`, combined in one typed `invoices.csv`.
- The issuance quota projects accepted-this-week plus currently redeemable (unexpired, token-bearing, pending) invitations, since the schema records no separate issued-at timestamp; this is the conservative reading of §3.2.
- The Sentry "error summaries" monitor is a placeholder card pointing at the Sentry project; embedding the Sentry API was judged out of P1D's UI scope and is not required by the plan's acceptance criteria.

## Deviations

- None from product scope. One implementation note: the export ZIP uses a purpose-built store-only writer instead of a third-party ZIP dependency (the plan does not prescribe a library; the repo's package store made adding one disproportionately risky).

## Open product question (flagged, not invented)

- Whether an **expired** clinic should still reach `/settings/export` (PDPL data-portability argument) is undecided; today the P1B billing gate blocks it and the operator can re-activate a clinic to unblock an export. Needs a founder decision before public launch.

## Deferred by design

- P3: delivery-health widgets, job/webhook monitoring data, invitation email delivery (operator currently hands the one-time link to the recipient).
- Orphan cleanup actions (deletion) — the panel lists orphans; remediation stays with the resumable signup flow and service-role tooling.
- All P2+ (i18n/RTL), payment gateways, checkout, and webhooks.
