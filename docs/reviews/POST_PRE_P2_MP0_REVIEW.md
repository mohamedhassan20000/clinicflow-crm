# Post-Pre-P2 MP0 Review — Operator Black Pages (BUG-4, BUG-5)

**Status:** IMPLEMENTED — awaiting comprehensive review
**Workstream:** MP0 (`docs/POST_PRE_P2_MANUAL_POLISH.md` §9-MP0)
**Review cycle:** 1 — remote-environment resolution and manual re-test
**Implementation date:** 2026-07-14
**Implementer:** Codex

This is the authoritative MP0 implementation record. A comprehensive reviewer must retain
the stable finding IDs below and append later review cycles instead of replacing this history.

## 1. Implementation scope

MP0 was limited to BUG-4/BUG-5 investigation, operator-segment error/not-found boundaries,
and regression coverage for the two affected operator reads. MP1 and every later manual-polish
workstream were not started.

No query fallback was added. A database/schema error still fails visibly and reaches the
operator error boundary; it is never converted into an empty clinic-history section or an empty
Invitations report.

## 2. Root cause and mandatory evidence

### 2.1 Affected environment and reproduction

- **Environment:** linked remote Supabase project `ayzetxywrqouqpurbjuv`, which `.env.local`
  targets and `docs/reviews/PRE_P2_WS0_REVIEW.md` identifies as the production-backed project.
- **Interactive account:** none used. No affected operator credentials were supplied, and no
  remote user or session was created. The exact PostgREST select was issued read-only with the
  configured project public key; column resolution happens before row authorization, so the
  schema error is independent of operator identity.
- **Clinic:** none required for the discriminating schema query. The user-reported clinic ID was
  not available in the repository or prompt. The clinic-history invitation subquery fails while
  resolving its selected columns, before `accepted_clinic_id = <clinic>` can make the result
  clinic-specific.
- **Steps:** inspect linked migration state; issue the clinic-history/report column projection;
  issue the `/operator/invitations` list projection as the §3.2 discriminating test.

No claim is made that the user-reported production route was interactively re-run. That requires
the affected operator session and, first, application of the pending migration (MP0-R1).

### 2.2 Captured server/database error (verbatim)

The direct read of
`clinic_invitations?select=id,email_sent_at&limit=1` returned HTTP 400:

```json
{"code":"42703","details":null,"hint":null,"message":"column clinic_invitations.email_sent_at does not exist"}
```

The exact Invitations-list projection returned the same response:

```json
{"code":"42703","details":null,"hint":null,"message":"column clinic_invitations.email_sent_at does not exist"}
```

### 2.3 Discriminating-test result

**CONFIRMED H1.** `/operator/invitations` selects `email_sent_at` and its exact projection fails
with the same `42703`. This distinguishes schema drift from report-param parsing, relation
resolution, serialization, or clinic legacy-data rendering.

`supabase migration list` independently showed:

```text
20260712090000 |                | 2026-07-12 09:00:00
20260712150000 |                | 2026-07-12 15:00:00
```

The first missing migration, `20260712090000_p15b_invitation_email.sql`, adds
`clinic_invitations.email_sent_at`. The second is the already-recorded P1.5D remote drift and is
not the cause of BUG-4/BUG-5.

### 2.4 Named failing paths and data assumption

- BUG-4: `getOperatorClinicHistory()` in `lib/supabase/admin.ts` selects
  `clinic_invitations.email_sent_at`; the remote schema does not contain that column, the helper
  returns the PostgREST error, and the clinic page throws.
- BUG-5: `invitationsQuery()` in `lib/operator-reports/registry.ts` selects and filters
  `clinic_invitations.email_sent_at`; PostgREST returns the same `42703`, and the report page/export
  propagate the failure.
- The list-page result proves the shared failing assumption is **"the linked database has applied
  `20260712090000_p15b_invitation_email`"**, not a component renderer or URL-state defect.

### 2.5 Root-cause fix rationale

The only correct affected-environment fix is to apply the existing, already-reviewed migration.
Adding a compatibility retry without `email_sent_at` would hide deployment drift and make email
delivery filters/history dishonest, which §3.3 explicitly forbids.

No `supabase db push`, migration application, or equivalent remote write was performed because
the task explicitly prohibited pushing anything. Consequently, the affected remote pages remain
blocked until MP0-R1 is completed by an authorized operator. The code implementation adds the
required error boundary and regression coverage without pretending the environment is fixed.

## 3. Exact files changed

Product code:

- `app/(operator)/error.tsx` (new)
- `app/(operator)/not-found.tsx` (new)
- `lib/supabase/admin.ts` (`safeAuditSummary` exported for direct safety regression testing;
  behavior unchanged)

Tests:

- `tests/unit/components/mp0-operator-boundaries.test.tsx` (new)
- `tests/unit/lib/mp0-operator-audit-safety.test.ts` (new)
- `tests/unit/lib/ws7-operator-report-params.test.ts`
- `tests/unit/integration/ws7-operator-reports.test.ts`
- `tests/unit/integration/ws8-operator-clinic-history.test.ts`
- `tests/e2e/smoke.spec.ts`

Documentation:

- `docs/reviews/POST_PRE_P2_MP0_REVIEW.md` (new)

The pre-existing user-owned edits to `docs/AI_AGENT_PLAN.md` and the untracked
`docs/POST_PRE_P2_MANUAL_POLISH.md` were read and preserved, not rewritten by MP0.

## 4. Implementation details

### 4.1 Operator route boundaries

- `app/(operator)/error.tsx` mirrors the protected boundary's recovery model, retains the Next.js
  digest, offers retry and `/operator` escape actions, and renders no property from the underlying
  error other than `digest`.
- `app/(operator)/not-found.tsx` keeps unknown operator resources inside a legible operator card
  with a route back to Mission Control.
- A production-build e2e deliberately visits `/operator/clinics/not-a-uuid`, causing the guarded
  query to fail. The resulting digest-bearing error card renders instead of the previous dark/blank
  default page.

### 4.2 Clinic-history regressions

- Fully populated history still renders every approved section.
- A legacy clinic with no subscription, invitations, coupon redemptions, feature overrides,
  usage counters, audit events, onboarding completion, or working hours returns explicit empty
  collections/nulls and renders its honest empty states.
- Usage pagination covers 26 rows, page 2, metric filtering, and out-of-range clamping.
- An unknown `patient.exported` audit action returns `null`; its payload is never rendered or
  serialized. Existing integration assertions continue to reject patient/owner/contact keys.

### 4.3 Invitations-report regressions

- The live-database suite covers `status=all|pending|accepted|revoked|expired`,
  `emailSent=all|yes|no`, an accepted-clinic filter, inclusive date filters, ascending and
  descending sort, 27 filtered rows across page 2, and a 27-row CSV export.
- Malformed status/clinic/date/email/sort/direction/page/page-size URL state falls back to the
  report's safe defaults before a query is built.
- Production e2e covers the list page, default report route, applied filter, URL persistence after
  reload, sort URL, and CSV download using the same report query.

## 5. Security and no-PHI audit

- `requirePlatformAdmin()` remains the first operation in `getOperatorClinicHistory()` and
  `invitationsQuery()`; no authorization path changed.
- Clinic history remains read-only. No operator mutation, RLS, middleware, billing, entitlement,
  signup, coupon, or appointment behavior changed.
- No patient or clinical table was added to an operator query.
- The boundary renders static copy plus the digest only. A unit fixture places a patient name and
  national ID in `error.message` and proves neither appears in the DOM.
- `safeAuditSummary()` remains an allowlist-shaped switch with `default: null`.
- CSV and serialized-history assertions reject patient/medical/contact fields.

## 6. Validation commands and exact results

| Command | Result |
|---|---|
| `supabase status` | **PASS** — local development stack running |
| `supabase migration list` | **ROOT CAUSE CONFIRMED** — linked remote missing `20260712090000` and `20260712150000` |
| Read-only remote PostgREST probes for the clinic-history and Invitations-list projections | **ROOT CAUSE CONFIRMED** — HTTP 400, PostgreSQL `42703`, `email_sent_at` absent |
| `pnpm exec vitest run tests/unit/components/mp0-operator-boundaries.test.tsx tests/unit/lib/mp0-operator-audit-safety.test.ts tests/unit/lib/ws7-operator-report-params.test.ts` | **PASS** — 3 files, 11 tests |
| `node --env-file=.env.local node_modules/vitest/vitest.mjs run tests/unit/integration/ws7-operator-reports.test.ts tests/unit/integration/ws8-operator-clinic-history.test.ts --no-file-parallelism` | **PASS** — 2 files, 12 tests against local Supabase |
| `PORT=3100 node --env-file=.env.local node_modules/@playwright/test/cli.js test tests/e2e/smoke.spec.ts --project=chromium --workers=1 --grep "MP0 operator"` | **PASS** — production build/start, Chromium 1/1 in 24.1s; deliberate query error produced digest `697819224` and the operator error card |
| `pnpm test` | **PASS** — 97 files, 510 tests |
| `pnpm typecheck` | **PASS** — exit 0, no diagnostics |
| `pnpm lint` | **PASS WITH WARNINGS** — 0 errors; 4 pre-existing warnings |
| `git diff --check` | **PASS** — no whitespace errors |
| schema gate: `git status --short supabase/ types/database.ts` | **PASS** — empty |
| added-line physical-direction grep gate | **PASS** — no added physical-direction utility |

The first targeted Playwright attempt failed before route assertions because the test locator also
matched a hidden input. The locator was narrowed to `input[type="date"]`; the final production run
above passed. `supabase db reset` was not run because the task explicitly prohibited reset. The
already-running local stack is fully migrated: both targeted integration suites inserted/read
`email_sent_at` successfully and passed.

## 7. Acceptance-criteria checklist

- [x] Root cause named and supported by the exact captured PostgreSQL error
- [x] §3.2 Invitations-list discriminating test completed and H1 confirmed
- [ ] Pending migration applied to the affected remote environment (MP0-R1; prohibited in this task)
- [ ] Both routes interactively re-verified with the affected operator account and affected clinic
      after MP0-R1 (credentials/clinic identifier not supplied)
- [x] Fully migrated local clinic-history route renders every section
- [x] Missing/legacy optional data renders honestly without throwing
- [x] Invitations report filters, sort directions, page 2, and CSV export verified
- [x] Operator `error.tsx` retains the digest and exposes no underlying error/PHI
- [x] Operator `not-found.tsx` provides a stable Mission Control return
- [x] Unit, integration, and production-build e2e regressions added and passing
- [x] No generic fallback hides a query/schema failure
- [x] `requirePlatformAdmin()`, no-PHI, and read-only-history guardrails preserved
- [x] No migration/schema/type, RLS, middleware, billing, P2, MP1, or later-workstream change

## 8. Stable findings

- **POSTPREP2-MP0-R1 — OPEN (ENVIRONMENT, BLOCKING AFFECTED-ENVIRONMENT APPROVAL):** the linked
  remote database is missing `20260712090000_p15b_invitation_email`; apply the existing pending
  migrations through the authorized deployment runbook, then re-run the affected operator clinic,
  Invitations list, Invitations report filters/page 2, and CSV export. This implementation did not
  perform that push because the task forbade pushing anything.
- **POSTPREP2-MP0-R2 — RESOLVED:** `(operator)` had no error/not-found boundary, allowing an RSC
  throw to escape to the dark default page. Both segment boundaries now exist and are covered in
  unit and production e2e tests.
- **POSTPREP2-MP0-R3 — RESOLVED:** existing tests did not exercise a missing-subscription/fully
  sparse clinic, every Invitations lifecycle filter, report page 2, the exact malformed Invitations
  URL state, or a digest-bearing operator failure. The regression matrix now covers each path.

## 9. Git state and scope audit

- Branch observed: `fix/post-pre-p2-manual-polish`.
- Staging area remains empty.
- No commit, push, merge, branch creation, stage, reset, restore, clean, or stash action occurred.
- User-owned documentation changes remain present and preserved.
- `supabase/migrations/`, `types/database.ts`, RLS, middleware, `actions/theme.ts`, monetary columns,
  and the appointment domain are untouched.
- MP1 and every later workstream remain unstarted.

## 10. Implementation verdict

**IMPLEMENTED — awaiting comprehensive review**

The MP0 code hardening and regression suite are complete and green on the fully migrated local
stack. Comprehensive approval of the affected environment remains blocked by POSTPREP2-MP0-R1:
the existing invitation-email migration must be applied remotely, then the user-reported account
and clinic must be re-verified. No code fallback should be accepted as a substitute.

## Re-review history

- **Review Cycle 0 — 2026-07-14:** implementation audit created. Two code/test findings resolved;
  one affected-environment migration finding remains open under the task's no-push constraint.
- **Review Cycle 1 — 2026-07-14:** the user confirmed both pending remote migrations were applied
  successfully and the affected operator routes were manually re-tested successfully.

## Review Cycle 1 — Remote-environment resolution and MP0 completion

### 1. Environment resolution

The user confirmed that the two migrations previously missing from the remote Supabase project
were applied successfully:

- `20260712090000_p15b_invitation_email`
- `20260712150000_p15d_intl_ux_foundations`

The remote migration drift recorded in Review Cycle 0 is therefore resolved. In particular,
`clinic_invitations.email_sent_at` now exists in the affected environment, removing the proved
`42703` root cause shared by BUG-4 and BUG-5.

### 2. Manual re-test

The user confirmed a successful manual re-test of both affected operator routes after the
migrations were applied:

- Operator Clinics table → open the affected clinic: **PASS** — the clinic-history page loads.
- Operator Reports → Invitations: **PASS** — the Invitations report loads.

This closes the affected-environment verification left pending in Review Cycle 0. The automated
local regression results and no-PHI/security audit recorded above remain unchanged.

### 3. Stable-finding update

- **POSTPREP2-MP0-R1 — CLOSED (Review Cycle 1):** the linked remote migration drift was resolved
  by successfully applying `20260712090000` and `20260712150000`; the affected clinic-history and
  Invitations-report routes were then manually re-tested successfully.
- **POSTPREP2-MP0-R2 — RESOLVED:** unchanged from Review Cycle 0.
- **POSTPREP2-MP0-R3 — RESOLVED:** unchanged from Review Cycle 0.

All MP0 findings are now closed or resolved.

### 4. Final MP0 acceptance state

- [x] Root cause named and supported by the captured PostgreSQL `42703`
- [x] §3.2 discriminating test completed and H1 confirmed
- [x] Both pending migrations applied successfully to the affected remote environment
- [x] Both affected operator routes manually re-tested successfully after migration application
- [x] Required unit, integration, and production-build e2e regression coverage remains green
- [x] Operator error/not-found boundaries exist and preserve digest/no-PHI requirements
- [x] `requirePlatformAdmin()`, no-PHI, and read-only-history guardrails remain intact
- [x] No generic fallback hides database failures
- [x] MP0 is complete

### 5. Final MP0 status

**IMPLEMENTED — awaiting comprehensive review**

MP0 is complete. The remote schema drift is resolved, POSTPREP2-MP0-R1 is closed, and both
user-reported operator failure paths have passed manual re-testing. No application-code change or
later workstream was included in Review Cycle 1.
