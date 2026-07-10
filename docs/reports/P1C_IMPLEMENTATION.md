# P1C Implementation Report

## Summary

- Added the public early-access page with validated invitation requests, normalized email/phone data, silent pending-request deduplication, configurable weekly-limit copy, and live accepted-this-week progress.
- Added invite-only and operator-switchable open signup routes. Invitation tokens are random, SHA-256 hashed at rest, rotated on resend, expiring, revocable, and consumed atomically.
- Added the two-boundary owner signup flow: normal Supabase Auth `signUp()` followed by a service-role-only `create_clinic_with_owner` RPC. The flow supports best-effort Auth-user compensation, metadata-scoped orphan resume, and owner-profile idempotency.
- Added atomic clinic provisioning: invitation claim, localized clinic, owner profile, default page permissions, 14-day Basic trial, accepted invitation, and invitation-assigned coupon redemption are one PostgreSQL transaction.
- Added the protected onboarding wizard using the existing working-hours, department, service, insurance, staff, and doctor-schedule workflows. Completion is explicit and idempotent.
- Added middleware ordering for authentication, profile, password change, subscription/trial, onboarding, then role/page visibility, including an expired-subscription loop guard.
- Added an Upstash REST sliding-window limiter for early access, signup, login, and password recovery. Anonymous signup surfaces fail closed on backend failure; auth/recovery remain available with logged fallback.

## Migration

- `20260710140000_p1c_early_access_signup.sql`
  - Corrects accepted-invitation history so `accepted_clinic_id` may become null after clinic deletion.
  - Adds the normalized pending-email uniqueness constraint.
  - Adds the shared UTC platform-week function.
  - Adds anon-safe `get_public_registration_status()` exposing only registration mode, weekly limit, and accepted count.
  - Adds the validated/deduplicated public invitation-request RPC and safe signup-validation RPC.
  - Adds service-role-only `create_clinic_with_owner(...)` and authenticated `complete_own_onboarding()`.

## Review findings and exact fixes

- **H1 — public rate-limit bypass:** `request_clinic_invitation(...)` now explicitly revokes `PUBLIC`, `anon`, and `authenticated` execution and grants only `service_role`. The rate-limited Server Action calls it through a reviewed service-role helper; SQL validation and normalized-email deduplication remain defense in depth.
- **H2 — orphan account control:** resume first resolves a resumable user through the service-only lookup, then authenticates the submitted email/password using a non-persistent throwaway Supabase client. Provisioning proceeds only when the authenticated user id equals the lookup result; wrong credentials receive the generic existing-account response.
- **H3 — non-admin onboarding loop:** middleware redirects only clinic admins into the admin-only wizard. Receptionists and doctors in an incomplete clinic continue through normal RBAC/page visibility.
- **M1 — capped Auth scan:** replaced `auth.admin.listUsers()` pagination with `find_resumable_clinic_owner(text)`, a `SECURITY DEFINER`, `search_path = ''`, fully-qualified exact normalized-email lookup. It requires clinic-owner metadata, no profile, and service-role execution.
- **M2 — invalid coupon bricking:** the signup transaction catches only `COUPON_INACTIVE`, `COUPON_EXPIRED`, and `COUPON_LIMIT_REACHED`, emits `SIGNUP_COUPON_SKIPPED` with invitation id/coupon code/reason for operator logs, and continues without that promotion. Every unexpected database, assignment, integrity, or security error is rethrown so the complete transaction still rolls back.
- **M3 — middleware query/error behavior:** subscription lookup runs only for billing or admin-onboarding gates; the clinic lookup runs only for a protected admin request with valid subscription access. Clinic lookup errors no longer masquerade as incomplete onboarding or cause a misleading redirect.
- **M4 — missing tests:** added action-level Auth compensation, live correct-password orphan resume, wrong-password denial, same-owner idempotency, and the full Playwright request/invite/signup/verification/onboarding/dashboard journey.
- **L1 — global settings lock:** removed `FOR UPDATE` from the registration-mode read; the conditional invitation claim remains the concurrency boundary.
- **L2 — nullable token:** moved `p_invitation_token_hash` to the trailing parameter with `DEFAULT NULL`; regenerated types now make it optional and no null-to-string casts remain.
- **L3 — forwarded IP trust:** documented that the first `x-forwarded-for` hop is trusted because Vercel normalizes it; self-hosting requires a trusted proxy.
- **L4 — platform week:** recorded ISO Monday 00:00 UTC in `docs/AI_AGENT_PLAN.md`, matching the shared SQL function.
- **L5 — E2E fixture repairs:** the pre-existing appointment smoke test now opens the detail before clicking its action; the settlement fixture pays its full seeded balance and asserts durable database state; fixture ids are randomized to prevent residue collisions. These changes repair the existing tests only and add no product behavior.
- **Browser-flow follow-up:** successful signup now redirects to stable `/signup/complete`; otherwise consuming the token caused the dynamic token page to revalidate to 404 before success could render.

## Tests added or updated

- Live P1C integration coverage: approved public fields only, public write denial, normalized request deduplication, service-only orphan lookup, secure resume, concurrent single-token signup, same-owner idempotency, coupon skip classification, unexpected-failure rollback, complete trial graph, and accepted-count semantics.
- Rate-limit unit coverage for fail-closed public surfaces, fail-open auth recovery, and flooding denial.
- Middleware coverage for incomplete onboarding, completed onboarding, expired subscriptions, and redirect-loop prevention.
- Full Playwright P1C journey: request invitation → service-issued token → signup → local email-verification handling → login → onboarding → dashboard.
- Existing Playwright fixtures include P1 subscription/onboarding state, collision-free IDs, correct appointment-detail interaction, and durable settlement assertions.

## Validation results

- `supabase db reset` — passed from a clean database with every migration applied.
- `pnpm lint` — passed with 0 errors and 4 pre-existing warnings.
- `pnpm typecheck` — passed.
- `pnpm test` — passed: 60 files, 320 tests.
- `pnpm test:integration` — passed: 6 files, 50 tests; runs without file parallelism because tests intentionally exercise the singleton platform registration setting.
- `pnpm test:e2e` — passed: 7 Playwright tests, including the complete P1C journey.
- `pnpm build` — passed (Next.js 16 production build, including the stable signup-completion route).
- `supabase db lint --local --level warning` — passed with only the two pre-existing unused `v_service_id` warnings in legacy billing RPCs; no P1C warnings.
- `git diff --check` — passed.

## Assumptions and deviations

- `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are required in deployed environments and are documented in `.env.example`.
- P1C lifecycle actions return the one-time raw invitation token to the future P1D operator surface. P1D owns operator UI and email-delivery presentation; raw tokens are never persisted or logged.
- The platform week is Monday 00:00 UTC, implemented once in SQL. This is platform-wide and intentionally independent of clinic timezone.
- Expected invalid invitation coupons are skipped and logged as PostgreSQL warnings; P1D may surface those operational events in Mission Control later, but no P1D UI was added here.
- No product-scope deviations from P1C were introduced. A function/constraint migration was required as explicitly allowed by the plan.

## Unresolved issues

- None within the reviewed P1C scope. The existing four lint warnings and two legacy database-lint warnings remain outside P1C and unchanged.

## Deferred by design

- P1D operator Mission Control, invitation/coupon management UI, registration settings UI, orphan cleanup UI, and data export.
- Payment gateways, checkout, billing webhooks, messaging/email invitation delivery, i18n/RTL, and all P2+ work.
