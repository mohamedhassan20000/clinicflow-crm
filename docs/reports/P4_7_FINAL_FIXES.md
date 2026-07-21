# P4.7 Final Review — Implementation of Remaining Fixes

**Phase:** P4.7 (P4.7A + P4.7B)  
**Input:** `docs/reviews/P4.7_FINAL_REVIEW.md`  
**Date:** 2026-07-21  
**Scope:** FR-M1, FR-M2, and FR-L1 only. No P4.8A work was started.

## 1. Outcome

The three remaining focused-review findings are fixed:

1. a primary-admin database failure remains distinguishable from a verified secondary administrator and resolves to `lookup_failed`;
2. the English and Arabic help corpus now correctly says that managers cannot access the Patients page; and
3. the authenticated capability-panel browser test now exercises the same Axe checks in English/LTR and Arabic/RTL.

No feature, route, permission, entitlement, migration, RLS policy, tenant-data read, or mutation was added.

## 2. FR-M2 — primary-admin lookup failures retain the correct reason

**Files:** `lib/primary-admin.ts`, `tests/unit/lib/p45b-primary-admin.test.ts`, `tests/unit/ai/p47a-navigation-registry.test.ts`

`getPrimaryClinicAdminId` previously returned `null` for both of these materially different states:

- the query succeeded and found no eligible primary administrator; and
- the query failed, so primary-admin status could not be determined.

The helper now throws a scoped internal error when the Supabase query returns an error. `isPrimaryClinicAdmin` therefore cannot turn an internal failure into `false`. The navigation resolver's existing fail-closed boundary catches that failure and returns `lookup_failed`, with no `href`. A successful lookup that identifies another administrator still returns `false` and remains `primary_admin_required`.

The primary-admin helper unit test now drives the real query-error result and asserts rejection instead of `null`. The navigation test continues to assert the user-visible boundary: lookup failure produces `lookup_failed`, while a verified secondary administrator produces `primary_admin_required`.

## 3. FR-M1 — patient-file guidance matches the role/page matrix

**Files:** `lib/ai/help/corpus.ts`, `tests/unit/ai/p47a-help-tools.test.ts`

The `register-new-patient` note now states, in both locales:

- doctors can view patient files but cannot create them;
- managers cannot access the Patients page; and
- an administrator or receptionist must register the patient.

The new corpus contract test derives the roles with Patients-page access from `ROLE_PAGE_SLUGS`, pins that set to admin, receptionist, and doctor, checks that registration remains limited to admin and receptionist, and asserts the matching English and Arabic guidance. This ties the prose to the shipped page-access matrix so the manager statement cannot drift independently.

## 4. FR-L1 — capability-panel Axe coverage now includes RTL

**File:** `tests/e2e/p4b-assistant.spec.ts`

The authenticated Assistant flow now uses a shared capability-panel accessibility assertion in both supported directions:

- English: verifies `lang="en"`, `dir="ltr"`, expanded ARIA state, panel visibility, serious/critical Axe violations, close behavior, and focus restoration.
- Arabic: switches the signed-in account through the real Preferences language control, verifies `lang="ar"` and `dir="rtl"`, opens the localized capability panel, and repeats the same Axe and focus checks.

The Arabic case also verifies the localized Assistant heading before opening the panel. The existing chat and contextual patient-assistant checks remain unchanged.

## 5. AI Provider settings runtime crash (Error ID `1166202417`)

**Files:** `lib/supabase/admin.ts`, `tests/unit/lib/admin-client-scope.test.ts`

### Root cause

The live Next.js development log and source-mapped server/client stack identified
the failing path as:

`AiProviderSettingsPage` → `listStaffAiPermissions` →
`createClinicScopedAdminClient(...).from("user_ai_permissions")` →
`assertKnownTable`.

`user_ai_permissions` was introduced as a clinic-owned table with a required
`clinic_id`, and the AI Provider page reads it to render manager financial-AI
grants. The table was never added to `CLINIC_SCOPED_TABLES`, however. The scoped
service-role proxy therefore treated it as unclassified and threw synchronously
before Supabase received the query. That uncaught Server Component exception
rendered the protected/global error boundary with digest `1166202417`.

This was not a null provider row, an entitlement mismatch, an RSC serialization
problem, or a primary-admin query failure. The successful primary-admin and
entitlement gates reached the later financial-permission load; the exact stack
ended at the scoped-client classification guard.

### Exact fix

`user_ai_permissions` is now classified in `CLINIC_SCOPED_TABLES`. This is the
narrow reviewed classification for its schema: every select/update/delete made
through the scoped service-role client receives `clinic_id = <current clinic>`,
and inserts/upserts receive the same clinic id while mismatched ids remain
rejected. No exception was caught or hidden, and no guardrail was relaxed.

The regression test drives the same `user_ai_permissions` read used by the
settings page and proves both that the proxy accepts it and that it injects the
clinic filter. Before the fix, the test fails with the same "unclassified table"
exception as the runtime page.

The P4.7 primary-admin change remains unchanged: a database lookup error still
rejects and resolves to `lookup_failed` at the navigation boundary, while a
successful lookup for a different administrator remains
`primary_admin_required`.

## 6. Validation

| Check | Result |
|---|---|
| Runtime-crash focused suites (`admin-client-scope`, AI permission/provider actions, primary admin, navigation) | ✅ 5 files, **56/56 tests** |
| Focused final-fix and P4.7 presentation/UI suites | ✅ 7 files, **133/133 tests** |
| Full non-integration unit suite (`pnpm test`) | ✅ 184 files, **1,260/1,260 tests** |
| Typecheck (`pnpm typecheck`) | ✅ clean |
| Full ESLint (`pnpm lint`) | ✅ 0 errors; 25 existing warnings outside these fixes |
| RTL gate (`pnpm lint:rtl`) | ✅ 413 files; 10 documented exceptions |
| i18n string gate (`pnpm lint:i18n`) | ✅ 299 files; 14 documented exceptions |
| Message parity (`pnpm i18n:missing`) | ✅ 2,749 base leaves; locale variants valid |
| Unused message keys (`pnpm i18n:unused`) | ✅ none |
| Production build (`pnpm build`) | ✅ Next.js 16.2.6; 65 static pages generated |
| Diff whitespace (`git diff --check`) | ✅ clean before this report; rechecked after creation |
| Playwright discovery for `p4b-assistant.spec.ts` | ✅ 1 Chromium test discovered |
| Authenticated manual page reload | ✅ active `/settings/ai` session mounted `app/(protected)/settings/ai/page.tsx` under the settings layout; `configErrors: []`, `sessionErrors: []` |

The production build emitted only the repository's existing warning that the
`middleware` convention is deprecated in favor of `proxy`. The local Supabase
API and database were running during the runtime reproduction. After hot
compilation and an authenticated tab refresh, the Next.js page metadata showed
the real AI Provider page component mounted under the settings layout, and the
diagnostics no longer reported the exception or any replacement runtime error.

## 7. Scope confirmation

- Only the three remaining findings and this AI Provider settings runtime crash were addressed.
- No unrelated implementation was modified.
- No P4.8A work was started.
- `docs/reviews/P4.7_FINAL_REVIEW.md` was not modified.
