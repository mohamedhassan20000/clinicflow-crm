# P1B Implementation and Review-Fix Report

## Scope completed

- Added the provider-neutral billing contract and P1-only manual adapter.
- Added fail-closed subscription/trial access, entitlement/feature resolution, coupon redemption, and hard usage limits.
- Wired subscription enforcement into every existing tenant-data mutating Server Action while preserving read-only and authentication-recovery access.
- Added atomic database operations for coupon redemption and usage reservation.
- Added no P1C/P1D/UI/gateway/webhook/onboarding/messaging/AI scope.

## Review findings and fixes

- **C1 mutation bypass:** every business mutation now uses `requireMutationRole` or `requireMutationUser`; read helpers retain `requireRole`/`requireUser`. Middleware also gates authenticated non-GET requests outside an explicit auth-recovery allow-list. Replaying a business action against an exempt URL still reaches its action-level subscription guard.
- **H1/M2 coupon sequencing and concurrency:** replaced all client-side claim/compensation writes with transactional `redeem_coupon(...)`. The function locks the coupon and subscription, validates authorization/state/assignment/expiry/limit/duplicates, inserts the redemption, increments the count, and applies the effect in one transaction.
- **H2 unbounded grants:** `months_free` records redemption without changing `active + current_period_end = null`; both TypeScript and SQL preserve unlimited access.
- **H3 cache invalidation:** successful `redeemCoupon` calls invalidate `entitlements:<clinicId>`; failed RPCs do not.
- **M1 middleware fail-open:** missing/erroring profiles deny every protected request; missing/erroring subscriptions deny every billing-gated request.
- **M3 upgrade/downgrade behavior:** effective limit is `max(existing snapshot, current plan limit)`. Upgrades apply immediately; downgrades retain the current-period floor.
- **M4 hard-cap race:** `increment_usage` is now the atomic reservation path. Concurrent increments beyond the effective cap raise `USAGE_LIMIT_EXCEEDED` without changing the counter.
- **L1/L2 tests:** replaced source-string assertions with middleware and guard behavior tests; live tests cover all coupon kinds, concurrency, rollback, unbounded grants, upgrade/downgrade limits, and overshoot prevention.
- **L3/L4 duplication/cache brittleness:** extracted pure subscription access resolution for middleware/domain reuse, removed the duplicate entitlement subscription fetch, and uses an explicit test-runtime uncached path instead of matching Next.js internal error strings.
- **L5 trust/semantics:** invitation IDs are verified in SQL against an accepted invitation owned by the clinic. Manual cancellation is documented as immediate while retaining the prior period end as history.

## Migration added

- `20260710130000_p1b_atomic_billing_operations.sql`
  - Adds `redeem_coupon(uuid, text, uuid)` as `SECURITY DEFINER`, `search_path = ''`, fully qualified SQL, and explicit authenticated/service-role grants.
  - Replaces `increment_usage` with an atomic hard-cap reservation implementation.

P1A assigned all schema work to P1A, but this migration is a justified P1B correctness deviation: PostgREST cannot make the required multi-table coupon transition atomic, and hard caps cannot be guaranteed by a separate read/check call.

## Server Actions updated

- Appointments, follow-ups, patient CRUD/archive/notes/finance, patient avatars/documents/packages, medical-note attachments, package templates, page permissions, clinic/staff/settings/catalog mutations, staff files, profile mutations, and theme preference.
- Read-only action paths remain readable: dashboards, time slots, billing context, conflict checks, trash/archive listings, document/attachment reads, working hours, doctor schedules, staff-file listing, and page-permission listing.
- Sign-in/out and password recovery/change actions remain available as authentication recovery operations.

## Tests added or changed

- Behavioral middleware matrix: dashboard GET, protected GET/POST, explicit auth POST exemptions, missing/erroring profile, subscription lookup failure, and active subscription allow.
- Mutation-guard behavior and coupon cache invalidation/error mapping.
- Coupon effects for lifetime, finite-month, one-year-compatible month arithmetic, percentage, and unbounded-grant interaction.
- Live transactional tests: all coupon kinds, unlimited and limited concurrent redemption, failed-assignment rollback, duplicate/limit integrity, upgrade/downgrade resolution, and 20-way hard-cap contention with no overshoot.
- Updated P1A atomic usage test to operate on the entitled Pro+AI limit now that increments enforce caps.

## Assumptions

- `active + current_period_end = null` is an unbounded manual grant.
- Percentage coupon value is retained through `coupon_redemptions -> coupons`; no gateway-specific subscription column is needed.
- The RPC accepts service role for the future P1C signup transaction and authenticated own-clinic/platform-admin callers; all invitation ownership is revalidated in the database.

## Deferred by design

- P1C signup, early access, invitation lifecycle UI, onboarding, and rate limiting.
- P1D operator UI/actions and data export.
- Payment gateways, checkout, provider webhooks, dunning, messaging, and AI.
