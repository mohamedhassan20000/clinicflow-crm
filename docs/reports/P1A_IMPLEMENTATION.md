# P1A Implementation Report

## Scope completed

- Added the complete P1A SaaS schema: `platform_admins`, `platform_settings`, `clinic_invitations`, `plans`, `subscriptions`, `usage_counters`, `coupons`, `coupon_redemptions`, and relational `clinic_feature_overrides`.
- Added the required enums, foreign keys, uniqueness/check constraints, partial/composite indexes, three seeded plans, and `clinics.onboarding_completed_at`.
- Added fail-closed RLS: clinics can read only their own SaaS rows; platform-admin-only tables and all SaaS writes require `is_platform_admin()`.
- Added `requirePlatformAdmin()` independently of clinic RBAC. Platform admins do not require clinic profiles and receive no clinical-table access.
- Added atomic `increment_usage(...)`; snapshots are resolved from the clinic subscription's plan limits, and only the service role or a platform admin can increment counters.
- Updated the P0 scoped admin wrapper classifications and regenerated Supabase database types.

## Tests and verification

- `supabase db reset` — passed; all migrations applied from a clean database.
- `pnpm lint` — passed with 4 pre-existing warnings and 0 errors.
- `pnpm typecheck` — passed.
- `pnpm test` — passed: 53 files, 293 tests.
- `pnpm test:integration` — passed: 3 files, 32 tests against local Supabase.
- `pnpm build` — passed. The first sandboxed attempt could not fetch existing Google Fonts; the permitted network retry passed.
- `supabase db lint --local --level warning` — completed successfully with two pre-existing unused-variable warnings in legacy billing RPCs.

New tests cover migration structure, platform-admin guard behavior, scoped-wrapper classification, per-table two-clinic RLS isolation, self-escalation denial, real PHI denial with positive controls, usage snapshot poisoning, coupon constraints, the settings singleton, the zero-argument platform-admin check, cross-clinic RPC denial, and 20 concurrent atomic usage increments.

## Review fixes

- **H1:** Removed caller-controlled `p_limit_snapshot`. The RPC maps each metric to a plan limit, resolves the snapshot through `subscriptions → plans.limits`, rejects clinics without subscriptions, and denies ordinary clinic sessions. Atomic upserts and cross-tenant denial remain intact.
- **M1:** Removed `coupons` from strict clinic scoping. It now uses an explicit-scope wrapper classification that neither injects nor filters `clinic_id`, preserving global, invitation-assigned, and clinic-assigned coupons.
- **M2:** Required `percent is not null` for `percent_discount` coupons; a live invalid insert now fails.
- **M3:** Seeded a real patient, appointment, and medical note. The operator is denied all three while the owning clinic admin reads each positive-control row.
- **L1:** Replaced `is_platform_admin(uuid)` with `is_platform_admin()`. Authenticated callers can check only their current identity; arbitrary UUID lookup fails.
- **L2:** Added live assertions for coupon rejection, server-resolved usage snapshots, poisoning denial, platform-settings singleton enforcement, platform-admin self-grant denial, and relevant RLS behavior.

## Assumptions

- Invitation requests and issued invitations share `clinic_invitations`; a pending request has no token/expiry until P1C issues it.
- `subscriptions.provider` remains unrestricted provider text and defaults to `manual`; no gateway-specific schema or dependency was added.
- Plan prices are seeded at zero because final pricing is still a founder decision; P1B/P1D will manage commercial behavior without a schema change.
- Platform settings remain unavailable through direct anonymous/authenticated table reads in P1A. P1C must expose only the safe public registration values through a reviewed read path.

## Deferred by design

- P1B: billing provider interface/manual adapter, trial enforcement, coupon application, entitlement resolution, and usage-cap behavior.
- P1C: request/signup/token lifecycle, `create_clinic_with_owner`, onboarding, and rate limiting.
- P1D: operator UI/actions and data export.
- No UI, payment gateway, checkout, webhook, messaging, or AI work was added.
