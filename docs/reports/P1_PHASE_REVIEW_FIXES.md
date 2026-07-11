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

### Follow-up — clinic-owner signup failure masking and orphan resume

Production signups intermittently returned "An account already exists for this email" while `auth.users` had no row for the email. Root cause: `signUpClinic` funneled **every** `signUp` failure (email-send rate limits, SMTP outages, endpoint rate limits) into the duplicate-account branch, and the orphan-resume path verified control with `signInWithPassword`, which Supabase rejects outright for unconfirmed users.

- **Error separation:** a real `signUpError` is now logged server-side (`clinic_signup_auth_failed` with code/status/invitation id, never the password) and mapped to enumeration-neutral, cause-specific user messages (rate limit, email delivery, signup disabled, weak password, generic retry). Only Supabase's genuine duplicate signals — an obfuscated user with empty `identities`, or `user_already_exists`/`email_exists` — enter the duplicate/resume branch, so "account already exists" is now only shown when Supabase actually asserted existence.
- **Resume-lookup failures** (`find_resumable_clinic_owner` RPC errors, e.g. a missing service-role key) now log `clinic_signup_resume_lookup_failed` and return a neutral retry message instead of the exists message.
- **Unconfirmed orphan resume:** `find_resumable_clinic_owner` now also returns the orphan's email-confirmation state (migration `20260711120000`, still service-role-only and still restricted to profile-less `signup_flow = 'clinic_owner'` users). The action resumes an orphan when (a) `signInWithPassword` succeeds (confirmed orphan), (b) it fails with `email_not_confirmed` — GoTrue verifies the password before the confirmation gate, so this proves control — with a best-effort confirmation resend, or (c) the orphan is unconfirmed and the caller holds a valid invitation token bound to that exact email, in which case the service role sets the submitted password and resends the confirmation. Confirmed accounts are never password-overwritten; open-mode (tokenless) signups cannot reclaim an orphan without the correct password.
- **Provisioning** stays idempotent (`create_clinic_with_owner` early-returns the existing clinic) and compensation deletion still applies only to users created in the same request, never to resumed orphans.
- **Redirects:** the confirmation `emailRedirectTo` derives from `NEXT_PUBLIC_SITE_URL` in production and the forwarded request host on previews/local. `NEXT_PUBLIC_SITE_URL` was added to `.env.example` and the README env table.
- **Configuration documentation:** README deployment now has a "Supabase Auth email & URL configuration" checklist — custom SMTP (the default Supabase mailer's per-hour cap is the most likely production trigger of the masked failures), Site URL, the preview/production redirect-URL allowlist, and Auth rate-limit review.
- **Tests:** `tests/unit/actions/p1c-signup-errors.test.ts` covers the branch matrix (rate-limit and SMTP failures produce non-exists messages and no orphan lookup; password never appears in logs; duplicate-with-no-orphan returns the exists message; lookup failure returns the neutral retry message; confirmed-orphan, `email_not_confirmed`, and token-authorized reclaim resume paths; token reclaim refused without a token and refused for confirmed orphans; fresh-signup provisioning). The local-Supabase integration suite gained unconfirmed-orphan cases asserting environment-independent outcomes: a retry resumes the orphan without a duplicate clinic, and a retry with a different password never leaves the orphan sign-in-able with a password the caller did not just submit. (The local stack runs with mailer autoconfirm and without enumeration protection, so the production-only resume branches are exercised by the unit matrix.)

### Follow-up — middleware intercepted the signup Server Action POST

Vercel logs showed `POST /signup/[token]` answered with `307 → /login`, which the Server Action client rendered as a black "This page couldn't load" screen. The authenticated-mutation billing gate treated any non-GET outside the exact-match `AUTH_MUTATION_EXEMPT_PATHS` set as a business mutation; a browser holding any session cookie (stale, half-provisioned signup, or a fresh email-confirmation session) that submitted the signup form therefore hit the fail-closed profile lookup and was redirected mid-action. Fix: `PUBLIC_FLOW_PREFIXES` (`/signup`, `/early-access`, `/auth/confirm`, `/forgot-password`, `/reset-password`) now short-circuit `updateSession` right after the session-cookie refresh, for GET and POST, anonymous or authenticated — prefix matching is exact-or-slash so lookalike paths are excluded. `AUTH_MUTATION_EXEMPT_PATHS` shrank to the session-bound pages (`/login`, `/change-password`) that must keep their auth-page gates. Operator, tenant, onboarding, forced-password, deactivation, and billing protections are unchanged on protected and operator prefixes; `tests/unit/lib/public-flow-middleware.test.ts` proves anonymous GET/POST pass-through for every public flow, the stale-session signup POST regression, and that protected GET/POST routes still redirect, fail closed, and billing-gate.

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
