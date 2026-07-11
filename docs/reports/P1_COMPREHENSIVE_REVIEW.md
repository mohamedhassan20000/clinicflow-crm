# Phase 1 Comprehensive Architectural Review — Canonical Fix Handoff

**Date:** 2026-07-11
**Scope reviewed:** P1A (SaaS platform schema + RLS), P1B (billing + entitlements), P1C (early access + signup + onboarding), P1D (operator mission control + data export), reviewed as one integrated system together with the P0 auth/middleware layer they build on.
**Verdict:** REQUEST CHANGES (narrow). See [Final recommendation](#final-recommendation).

Previously accepted findings are **not** repeated here (export-while-expired product question, medical-notes metadata-only export, soft non-atomic issuance quota, UTC platform week, manual token delivery, zero-priced plans, no payment gateway).

Severity legend: **High** = must fix before real tenants; **Medium** = material correctness/security/scalability gap, schedulable; **Low** = defense-in-depth, robustness, or coverage gap.

---

## High

### H1 — Platform admins have no working sign-in path (redirect loop)

- **Severity:** High
- **Title:** Authenticated profileless users (platform admins) loop between `/login` and `/dashboard`; the operator persona cannot sign in cleanly.
- **Why it is a problem:** The operator is a first-class P1 persona, yet the login flow was built entirely around clinic profiles. A platform admin signing in sees "Profile not found. Contact your administrator." *after* their session cookies are already committed; afterwards, visiting `/login` (or `/dashboard`) triggers an infinite middleware redirect loop (`/login → /dashboard → /login`), which browsers surface as an error page. The only reachable surface is `/operator*`, and only by typing the URL manually after an apparently failed login. This is a P0 auth × P1A cross-phase seam defect on a core flow.
- **Root cause:** The P1A trust boundary ("platform admins deliberately hold no clinic profile") was never integrated into the P0 login flow. `signIn` requires a `profiles` row unconditionally, and the middleware treats "authenticated + no profile" as an error state on protected paths while simultaneously bouncing authenticated users off `/login` to `/dashboard`.
- **Files/components involved:**
  - `actions/auth.ts` — `signIn` (profile check at ~lines 102–108 runs after `signInWithPassword` has set cookies; no `platform_admins` check).
  - `lib/supabase/middleware.ts` — profileless-on-protected redirect (~lines 148–151) and authenticated-on-auth-page redirect (~lines 235–239) form the loop.
- **Recommended implementation approach:**
  1. In `signIn`, when no profile exists, check `platform_admins` (self-read RLS policy already permits this). If the user is a platform admin, return `{ ok: true, redirectTo: "/operator" }`. If neither profile nor platform admin, sign the session back out before returning the error (do not leave a live session behind a failed login).
  2. In middleware, in the authenticated `/login` branch and in the profileless-on-protected branch, check `platform_admins` before redirecting: platform admins go to `/operator`, true orphans get signed out and sent to `/login` (breaking the loop).
  3. Add a unit/behavioral test for the middleware matrix row "authenticated, no profile, platform admin / not platform admin" and an E2E for operator login.
- **Acceptance criteria:**
  - A platform admin with no clinic profile signs in via the login form and lands on `/operator` with no error message.
  - A signed-in platform admin visiting `/login` or `/dashboard` is redirected to `/operator` (no loop).
  - An authenticated user with neither profile nor platform-admin membership is signed out and lands on `/login` (no loop, no live session).
  - Dual-role admins (profile + platform_admins) retain existing behavior (clinic gates apply outside `/operator`).
- **Blocks Phase 2:** Yes
- **AI_AGENT_PLAN.md update needed:** No

### H2 — `redeem_coupon` is self-serve, brute-forceable, and role-unrestricted

- **Severity:** High
- **Title:** Any authenticated clinic member can call the `redeem_coupon` RPC directly; unassigned coupons are redeemable by any tenant that guesses the code.
- **Why it is a problem:**
  - Any receptionist/doctor can mutate their clinic's subscription state (no role check — only clinic membership).
  - A `lifetime_free` coupon flips a **cancelled** subscription back to `active`, silently reversing an operator cancellation (billing ↔ operator interaction bug).
  - Unassigned coupons (`clinic_id` and `invitation_id` both null) are shared promo codes with human-chosen formats (`LAUNCH50`-style). The RPC is callable directly via PostgREST with no rate limit and no logging, so code brute-forcing is practical and invisible.
  - No P1 application code calls it at all (the TS wrapper `redeemCoupon` in `lib/billing/coupons.ts` has zero callers; the signup path redeems inside SQL as service_role) — the `authenticated` grant is pure attack surface with no product use today.
- **Root cause:** P1B granted execute to `authenticated` to support a future clinic-facing "enter coupon" surface that P1 never shipped, and the in-function authorization check stops at clinic membership (`auth_clinic_id() = p_clinic_id`) with no role restriction, throttling, or audit.
- **Files/components involved:**
  - `supabase/migrations/20260710130000_p1b_atomic_billing_operations.sql` — `redeem_coupon` authorization block (~lines 24–28) and grants (~lines 151–153).
  - `lib/billing/coupons.ts` — unused TS wrapper `redeemCoupon` (keep, but its future caller must add guards).
- **Recommended implementation approach:** New migration (do not edit the applied P1B file):
  1. Revoke execute on `redeem_coupon` from `authenticated`, leaving `service_role` (signup path) and — if operator-driven redemption is wanted — an in-function `is_platform_admin()` allowance. If a clinic-facing surface is planned for P2, re-grant later behind a clinic-**admin** role check plus rate limiting in the calling server action.
  2. Inside the function, refuse to resurrect a `cancelled` subscription (or make that an explicit platform-admin-only branch) so a coupon can never undo an operator cancellation.
  3. Log redemption attempts (success and failure) — dovetails with M1's operator/platform audit log.
  4. Extend the P1B integration tests: authenticated non-admin caller is rejected; cancelled subscription is not reactivated by a coupon.
- **Acceptance criteria:**
  - A plain authenticated clinic user calling `redeem_coupon` via PostgREST receives a permission error for any coupon.
  - Signup-time invitation coupon application still works (service_role path unchanged; `create_clinic_with_owner` coupon loop passes existing tests).
  - A coupon redemption can no longer transition a `cancelled` subscription to `active` (except via an explicit operator path, if kept).
  - Redemption attempts appear in an audit/log trail.
- **Blocks Phase 2:** Yes
- **AI_AGENT_PLAN.md update needed:** Yes — if the plan describes a clinic-facing coupon-entry surface, record that it is deferred and must ship with role + rate-limit guards.

---

## Medium

### M1 — No operator audit trail; platform admins can mint platform admins

- **Severity:** Medium (ship with the Highs — cheapest before real tenants exist)
- **Title:** Platform-admin actions are unaudited, and the `platform_admins` RLS policy allows self-serve privilege escalation.
- **Why it is a problem:** None of the operator mutations (manual grants, cancellations, coupon CRUD, feature overrides, platform settings, invitation issue/revoke) write an audit record; clinic-side `audit_logs` exists but platform events are silent. Combined with the `platform_admins_manage_platform_admins` `for all` policy, a single compromised operator account can insert additional platform admins via PostgREST — contradicting the P1D report's "provisioned by direct service-role insert" assumption — with no trace. For a SaaS control plane this is the largest governance gap.
- **Root cause:** P1A shipped a symmetric "admins manage the admin table" policy instead of service-role-only provisioning, and P1D shipped operator actions without an audit sink.
- **Files/components involved:**
  - `supabase/migrations/20260710120000_p1a_saas_platform_schema.sql` — `platform_admins_manage_platform_admins` policy (~lines 39–42).
  - `actions/operator.ts`, `actions/early-access.ts` — all operator mutations.
- **Recommended implementation approach:** New migration + small action-layer change:
  1. Replace the `for all` policy on `platform_admins` with select-only for platform admins; inserts/updates/deletes become service-role-only (matching the documented provisioning model).
  2. Add a `platform_audit_logs` table (actor, action, target ids, payload jsonb, created_at; platform-admin read, insert via a small security-definer helper or service role).
  3. Add one `logOperatorAction(...)` helper called from every mutation in `actions/operator.ts` / invitation lifecycle actions; include coupon redemptions (H2).
- **Acceptance criteria:**
  - A platform admin cannot insert a row into `platform_admins` through PostgREST.
  - Every operator mutation produces exactly one audit row with actor, action, and target.
  - Integration test covers the escalation denial and one audited action.
- **Blocks Phase 2:** Yes
- **AI_AGENT_PLAN.md update needed:** Yes — the plan should reflect that platform-admin provisioning is service-role-only and that an operator audit log is part of the P1 baseline.

### M2 — Middleware performs 3–5 sequential DB round trips per protected request

- **Severity:** Medium
- **Title:** Per-request `profiles` + `subscriptions` + `clinics.onboarding_completed_at` (+ page permissions on cookie miss) lookups make middleware the system's main scalability bottleneck.
- **Why it is a problem:** Every protected navigation costs `getUser()` token verification plus up to three uncached queries; admins pay the onboarding lookup forever, even after completion. Every mutating server action then repeats the subscription lookup (`requireActiveSubscription` → uncached service-role query). Latency compounds per request and per tenant; the well-designed 300s `getEntitlements` cache is unused by both gates.
- **Root cause:** P1B/P1C gates were added to middleware as direct queries; only the P0 page-visibility check got the cookie-cache treatment.
- **Files/components involved:**
  - `lib/supabase/middleware.ts` — subscription lookup (~lines 189–206), onboarding lookup (~lines 211–232).
  - `lib/billing/subscriptions.ts` — `getSubscriptionAccess` (uncached).
  - `lib/rbac.ts` — `requireMutationRole` / `requireMutationUser`.
- **Recommended implementation approach:** Reuse the existing page-visibility cookie pattern: a short-TTL (e.g., 60–120s) httpOnly cookie or cached lookup carrying `{subscription access, onboarding complete}` keyed to user id, invalidated on the operator grant/cancel path (which already calls `revalidateTag`) by shortening TTL rather than perfect invalidation — fail-closed on parse failure. Stop performing the onboarding query once `onboarding_completed_at` is observed non-null (cache that fact). Keep server-action-level `requireActiveSubscription` as the authoritative check (optionally routed through the tag-cached entitlements loader).
- **Acceptance criteria:**
  - Steady-state protected GET for a non-admin performs at most one DB query in middleware beyond `getUser()` (cookie warm).
  - Trial expiry / operator cancellation locks the tenant out within the chosen TTL (documented), and server actions still deny immediately.
  - Existing middleware behavioral matrix tests pass, extended for the cached path.
- **Blocks Phase 2:** No
- **AI_AGENT_PLAN.md update needed:** No

### M3 — Open registration mode has no tenant-creation cap

- **Severity:** Medium
- **Title:** In `open` mode, clinic + trial creation is unbounded except for a 5/hr/IP rate limit.
- **Why it is a problem:** `weekly_invite_limit` governs invitation issuance only; `validate_clinic_signup` in open mode admits anyone, and `create_clinic_with_owner` provisions a full tenant (auth user, clinic, subscription, permissions). Distributed or disposable-email signup can mass-create tenants (DB bloat, auth-directory pollution, skewed operator metrics).
- **Root cause:** The weekly limit was scoped to invitations by design (§3.2); no equivalent control was defined for open mode because P1 launches invite-only.
- **Files/components involved:**
  - `supabase/migrations/20260710140000_p1c_early_access_signup.sql` — `validate_clinic_signup`, `create_clinic_with_owner`.
  - `actions/auth.ts` — `signUpClinic` rate limit.
- **Recommended implementation approach:** Founder decision first (this is product policy). Cheapest robust option: enforce a global weekly acceptance cap in `create_clinic_with_owner` when mode is `open`, reusing `get_public_registration_status`'s accepted-this-week counter against `weekly_invite_limit` (or a dedicated `weekly_open_signup_limit` column). Alternatively require email confirmation before provisioning. Keep the IP rate limit as-is.
- **Acceptance criteria:**
  - With mode `open` and the cap reached, signup fails with a clear "registration closed this week" error and no tenant rows are created.
  - Invite-token signups remain exempt (acceptance is never blocked, per §3.2).
  - Integration test for the cap boundary.
- **Blocks Phase 2:** No (platform ships invite-only; must be resolved before `open` mode is ever enabled)
- **AI_AGENT_PLAN.md update needed:** Yes — record the open-mode cap policy decision.

### M4 — Mission Control synchronously scans the entire Auth directory per render

- **Severity:** Medium
- **Title:** `listOrphanedSignupUsers` pages `auth.admin.listUsers` sequentially (up to 500 pages × 100 users) inside the operator dashboard render.
- **Why it is a problem:** At even a few thousand auth users the operator home page becomes multi-second and hammers the Auth admin API on every visit; cost grows linearly with the user directory forever.
- **Root cause:** Orphan detection was implemented as an exhaustive REST scan because no SQL path was added for it.
- **Files/components involved:**
  - `lib/supabase/admin.ts` — `listOrphanedSignupUsers` (~lines 112–151).
  - `app/(operator)/operator/page.tsx` — called inside the dashboard `Promise.all`.
- **Recommended implementation approach:** Replace the REST scan with a single security-definer SQL function (service-role/platform-admin execute) that selects `auth.users` rows where `raw_user_meta_data->>'signup_flow' = 'clinic_owner'` and no `profiles` row exists — the same shape as the existing `find_resumable_clinic_owner`. One round trip, index-friendly. Alternatively move the scan behind an on-demand "Scan now" action with a cached result.
- **Acceptance criteria:**
  - Mission Control renders with one bounded query for orphan detection regardless of auth-directory size.
  - Orphan list results match the current scan on a seeded fixture (including the truncation warning removal or its equivalent).
- **Blocks Phase 2:** No
- **AI_AGENT_PLAN.md update needed:** No

### M5 — Early-access request squatting (first-writer-wins on unverified emails)

- **Severity:** Medium
- **Title:** An attacker submitting a victim's email first pins junk clinic/owner/phone metadata; the victim's later legitimate request is silently discarded.
- **Why it is a problem:** `request_clinic_invitation` upserts on pending email with a no-op update, so the second (legitimate) submitter still sees "ok" while their data is dropped. The operator then reviews and issues against attacker-controlled metadata. Direct harm is bounded (the invitation still binds to the real email at signup), but the request pipeline is corruptible undetectably.
- **Root cause:** The pending-email unique index plus `do update set updated_at = updated_at` (deliberate no-op to prevent token-bearing rows being touched) also freezes the descriptive fields.
- **Files/components involved:**
  - `supabase/migrations/20260710140000_p1c_early_access_signup.sql` — `request_clinic_invitation` (~lines 54–88), pending-email unique index.
- **Recommended implementation approach:** New migration: in the conflict branch, when the existing pending row has **no token issued** (`token_hash is null`), update `clinic_name/owner_name/phone/updated_at` from the new submission (latest-writer-wins for un-issued requests); keep the no-op when a token is already issued. Optionally record a `resubmission_count` so the operator sees contested emails.
- **Acceptance criteria:**
  - A second request for the same pending, un-issued email replaces the descriptive fields.
  - A request against an already-issued pending invitation remains a no-op (token untouched).
  - Integration test covers both branches.
- **Blocks Phase 2:** No
- **AI_AGENT_PLAN.md update needed:** No

### M6 — Export is not a consistent snapshot and is an incomplete portability set

- **Severity:** Medium
- **Title:** The seven export queries are independent parallel reads (no snapshot), and `follow_ups`, `patient_packages`/`package_templates`, and staff data are absent.
- **Why it is a problem:** Cross-table references can disagree under concurrent writes (an appointment referencing a patient absent from `patients.csv`; invoices drifting from appointments). Beyond the accepted medical-notes exclusion, "your data export" is materially partial, which matters for the PDPL data-portability story.
- **Root cause:** `fetchAll` per table over PostgREST offers no shared transaction/snapshot, and P1D mapped §3.6 "invoices" narrowly without sweeping the remaining clinic-owned tables.
- **Files/components involved:**
  - `app/(protected)/settings/export/route.ts` — table list and `fetchAll` pagination.
  - `lib/zip.ts` — unchanged.
- **Recommended implementation approach:** Two independent, cheap steps: (1) add the missing CSVs (`follow_ups`, `patient_packages`, `package_templates`, staff roster metadata) through the same RLS session; (2) add a `manifest.txt`/`README.txt` entry in the ZIP stating the export timestamp, included tables, known exclusions, and the non-snapshot caveat. A true snapshot (single security-definer RPC or repeatable-read function) can wait for a P2+ operator-assisted export if ever needed.
- **Acceptance criteria:**
  - Export ZIP contains the added tables and a manifest documenting scope and caveats.
  - Existing export integration tests extended for the new entries; `unzip` verification still passes.
- **Blocks Phase 2:** No
- **AI_AGENT_PLAN.md update needed:** Yes — §3.6 export scope should list the full table set and the manifest requirement.

---

## Low

### L1 — `couponExpiryFromInput` throws on garbage operator input

- **Severity:** Low
- **Title:** Non-date-only, non-ISO input reaches `new Date(value).toISOString()` and throws an uncaught `RangeError` (500) instead of a field error.
- **Why it is a problem:** Unhandled server-action crash from a form field; poor operator UX and noisy Sentry.
- **Root cause:** `createCoupon`'s zod schema validates `expiresAt` only as `string`; `lib/operator.ts` `couponExpiryFromInput` assumes parseable input.
- **Files/components involved:** `actions/operator.ts` (`couponSchema`, `createCoupon`), `lib/operator.ts` (`couponExpiryFromInput`).
- **Recommended implementation approach:** Validate in the schema (refine: date-only regex or `!Number.isNaN(Date.parse(value))`) and return a field error.
- **Acceptance criteria:** Garbage `expiresAt` returns a `fieldErrors.expiresAt` message; no thrown error. Unit test added.
- **Blocks Phase 2:** No
- **AI_AGENT_PLAN.md update needed:** No

### L2 — `grantManualSubscription` read-then-write is not atomic

- **Severity:** Low
- **Title:** Concurrent grants, or a grant racing a coupon redemption, last-write-wins on subscription period fields.
- **Why it is a problem:** Inconsistent with P1B's own "multi-step billing state changes belong in an RPC" doctrine; a race can silently shorten or overwrite a comped period. Operator-only and rare, hence Low.
- **Root cause:** The action reads `current_period_end` then updates by id in a second statement.
- **Files/components involved:** `actions/operator.ts` (`grantManualSubscription`, `cancelManualSubscription`), `lib/operator.ts` (`manualGrantPeriod`).
- **Recommended implementation approach:** Move grant/cancel into a small security-definer RPC (platform-admin/service-role only) that locks the subscription row `for update` and computes the period in SQL, mirroring `redeem_coupon`'s structure.
- **Acceptance criteria:** Concurrent grant + redemption integration test yields a serialized, non-clobbered result.
- **Blocks Phase 2:** No
- **AI_AGENT_PLAN.md update needed:** No

### L3 — Billing mutation gate silently applies to public-path POSTs

- **Severity:** Low
- **Title:** `AUTH_MUTATION_EXEMPT_PATHS` is an exact-match set; any authenticated POST outside it is billing-gated, including public pages.
- **Why it is a problem:** An expired-subscription user cannot submit `/early-access`; any future public POST route silently inherits the gate unless remembered in the set. Fail-closed, but a hidden coupling that will bite in P2+.
- **Root cause:** The P1B mutation gate keys on "not exempted" rather than "belongs to a billing-gated surface".
- **Files/components involved:** `lib/supabase/middleware.ts` (`AUTH_MUTATION_EXEMPT_PATHS`, `isAuthenticatedMutation`).
- **Recommended implementation approach:** Scope the mutation gate to protected/operator prefixes (allow-list of gated surfaces) instead of an exemption deny-list, or add the `(public)` route group's paths to the exemptions with a comment establishing the convention.
- **Acceptance criteria:** Authenticated user with an expired subscription can POST the early-access form; protected-path mutations remain gated; middleware matrix test updated.
- **Blocks Phase 2:** No
- **AI_AGENT_PLAN.md update needed:** No

### L4 — Export route lacks its own billing check

- **Severity:** Low
- **Title:** `/settings/export` enforces only `requireRole("admin")`; the billing gate exists solely in middleware reachability.
- **Why it is a problem:** Every other guarded operation double-checks in the action/route layer; this one depends on middleware matcher behavior. Whatever the founder decides on the flagged export-while-expired question, the decision should live in the route.
- **Root cause:** P1D route written before the export-while-expired product question was settled.
- **Files/components involved:** `app/(protected)/settings/export/route.ts`.
- **Recommended implementation approach:** Once the product decision lands: either add `requireActiveSubscription(user.clinicId)` or explicitly document/allow expired-clinic export in the route with a comment. Either way the route becomes self-contained.
- **Acceptance criteria:** Route behavior matches the recorded product decision without relying on middleware; test added.
- **Blocks Phase 2:** No
- **AI_AGENT_PLAN.md update needed:** Yes — record the founder decision on expired-clinic export (already flagged in the P1D report).

### L5 — Entitlement cache invalidation assumes a shared Next data cache

- **Severity:** Low
- **Title:** `revalidateTag("entitlements:…")` is correct on Vercel; a self-hosted multi-instance deployment would serve up to 300s of stale entitlements per instance.
- **Why it is a problem:** Silent deployment-model coupling; a future self-host would weaken operator kill-switch latency without anyone noticing.
- **Root cause:** `unstable_cache` + tag invalidation relies on the platform's shared data cache.
- **Files/components involved:** `lib/entitlements.ts`, `actions/operator.ts` (`invalidateEntitlements`), `lib/billing/coupons.ts`.
- **Recommended implementation approach:** Documentation only: one paragraph in README/deployment docs stating the assumption and the 300s staleness bound as the self-host fallback.
- **Acceptance criteria:** Deployment docs state the assumption and bound.
- **Blocks Phase 2:** No
- **AI_AGENT_PLAN.md update needed:** No

### L6 — `create_clinic_with_owner` duplicates TS constants in SQL

- **Severity:** Low
- **Title:** The page-permission slug list and country→timezone/currency mapping are hardcoded in the signup RPC, duplicating TS-side constants.
- **Why it is a problem:** When the P0 page list or localization defaults change, new clinics drift from existing behavior with no compiler/test to catch it.
- **Root cause:** Atomic signup required these values inside the transaction; they were inlined rather than centralized.
- **Files/components involved:** `supabase/migrations/20260710140000_p1c_early_access_signup.sql` (`create_clinic_with_owner`), `lib/page-permissions.ts`, `lib/constants.ts`.
- **Recommended implementation approach:** Add a cross-check unit/integration test asserting the SQL-seeded slugs equal `getRolePageSlugs("admin")` (and the country map equals the TS map), so drift fails CI. Full de-duplication (config table) is optional later.
- **Acceptance criteria:** CI test fails if either list drifts.
- **Blocks Phase 2:** No
- **AI_AGENT_PLAN.md update needed:** No

### L7 — Dead `authenticated` grant on `increment_usage`

- **Severity:** Low
- **Title:** `increment_usage` is granted to `authenticated`, but its guard rejects every non-platform-admin authenticated caller.
- **Why it is a problem:** Least-privilege hygiene; the grant advertises a surface that always fails, inviting future confusion about whether clinic self-metering is supported.
- **Root cause:** Grant retained from the P1A version while the P1B rewrite tightened the in-function check.
- **Files/components involved:** `supabase/migrations/20260710130000_p1b_atomic_billing_operations.sql` (grants ~lines 233–235).
- **Recommended implementation approach:** New migration revoking execute from `authenticated` (keep `service_role`; platform-admin access continues via the in-function check under their own session — verify and adjust grant accordingly).
- **Acceptance criteria:** Authenticated non-admin call fails at the grant layer; existing usage-cap integration tests pass.
- **Blocks Phase 2:** No
- **AI_AGENT_PLAN.md update needed:** No

### L8 — Missing end-to-end journey coverage

- **Severity:** Low
- **Title:** No E2E for trial-expiry lockout → operator grant → recovery; invitation issue → tokened signup; onboarding redirect enforcement; export download.
- **Why it is a problem:** Integration tests cover the DB layer thoroughly, but the highest-risk cross-phase *journeys* are only covered piecewise — H1 is exactly the class of defect an operator-login E2E would have caught.
- **Root cause:** P1 E2E scope stopped at the P1C signup spec.
- **Files/components involved:** `tests/e2e/` (new specs), `playwright.config.ts`.
- **Recommended implementation approach:** Add four Playwright specs: (1) operator login → Mission Control; (2) issue invitation → signup with token → onboarding → dashboard; (3) expired trial → dashboard lockout → operator manual grant → access restored; (4) admin export download + ZIP smoke validation. Reuse the existing local-stack seeding helpers.
- **Acceptance criteria:** The four journeys run green in CI against the local Supabase stack.
- **Blocks Phase 2:** No (but specs 1–3 should accompany the H1/H2/M1 fixes as their verification)
- **AI_AGENT_PLAN.md update needed:** No

---

# Required before Phase 2

- **H1** — Platform-admin sign-in path / redirect loop
- **H2** — `redeem_coupon` exposure (revoke `authenticated` grant, block cancelled-subscription resurrection, log redemptions)
- **M1** — Operator audit trail + service-role-only `platform_admins` provisioning

# Can be deferred to Phase 2

- **M2** — Middleware round-trip reduction (subscription/onboarding caching)
- **M3** — Open-mode tenant-creation cap (must land before `open` mode is ever enabled; platform launches invite-only)
- **M4** — Mission Control orphan scan → single SQL query
- **M5** — Early-access request squatting (refresh un-issued pending requests)
- **M6** — Export manifest + missing tables
- **L1–L8** — Robustness, hygiene, documentation, and E2E coverage items (L8 specs 1–3 should accompany the blocking fixes as verification)

# Final recommendation

Phase 1 is architecturally sound: tenant isolation is RLS-first with a genuinely separate control plane, all multi-step billing state changes that matter are atomic in the database, defaults fail closed, and authorization is layered (middleware → layout → action guard → RLS) so no single bypass is fatal. Nothing found requires redesign.

It is **not production-ready today** because the two High findings sit on Phase 1's core value proposition — the operator persona cannot sign in cleanly (H1), and the billing system exposes a brute-forceable, unaudited, role-unrestricted subscription-mutation RPC to every authenticated user (H2) — and because platform-admin actions are currently both unaudited and self-escalating (M1), which is cheapest to fix before any real tenant exists.

All three blocking fixes are small and localized: two focused migrations, a platform-admin-aware login/middleware branch, and a thin audit helper. **After H1, H2, and M1 are fixed and verified (ideally with the L8 journey specs 1–3), Phase 1 is production-ready as the SaaS foundation and Phase 2 can start on it.** The remaining Medium items are scalability and pipeline-integrity improvements that can be scheduled into Phase 2 without blocking it.
