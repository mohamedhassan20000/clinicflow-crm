# P1 Phase Review Blocking Fixes

**Date:** 2026-07-11  
**Scope:** Only the findings listed under **Required before Phase 2** in `P1_COMPREHENSIVE_REVIEW.md`.

## Implemented

### H1 — Platform-admin sign-in path / redirect loop

- `signIn` now recognizes a profileless `platform_admins` member and directs the session to `/operator`.
- A profileless authenticated user who is not a platform admin is signed out before the login error is returned.
- Middleware now resolves profileless users on `/login` and clinic-protected paths: platform admins go to `/operator`; true orphan sessions are signed out and returned to `/login`.
- Dual-role platform admins keep the existing clinic-profile behavior outside the operator route group.
- Middleware matrix coverage was added for the platform-admin and orphan branches.

### H2 — `redeem_coupon` exposure

- A new migration revokes `redeem_coupon` execution from `authenticated`; only `service_role` retains execute permission.
- The function also checks its caller internally, preserving defense in depth if grants change later.
- Coupon redemption refuses all cancelled subscriptions, so a coupon cannot reverse an operator cancellation.
- Successful redemptions write a `coupon.redeemed` platform audit event in the same transaction.
- Integration coverage verifies the authenticated-call denial, cancelled-subscription protection, successful audit entry, and the unchanged service-role signup/redemption path.
- The plan now records that any future clinic-facing coupon entry must add clinic-admin authorization and rate limiting before widening the RPC grant.

### M1 — Operator audit trail and platform-admin provisioning

- The authenticated `FOR ALL` policy on `platform_admins` was removed. Authenticated platform admins retain self-read only; provisioning and removal are service-role-only.
- Added `platform_audit_logs` with actor, action, target, optional clinic, structured payload, and timestamp fields. Platform admins can read the log; direct authenticated inserts are not permitted.
- Added the guarded `log_platform_audit_event` helper RPC and an action-layer `logOperatorAction` helper.
- Successful platform-settings, subscription, feature-override, coupon, and invitation mutations now produce one audit event.
- Integration coverage verifies that a platform admin cannot mint another platform admin.
- The implementation plan now records service-role-only provisioning and the audit log as P1 baseline requirements.

## Explicitly deferred

No findings in **Can be deferred to Phase 2** were implemented: M2–M6 and L1–L8 remain deferred.

## Validation

- TypeScript typecheck
- ESLint
- Unit test suite
- Local Supabase migration application
- Full integration suite
- Production build
- Playwright end-to-end suite

Final command results are recorded in the implementation handoff after the complete suite finishes.
