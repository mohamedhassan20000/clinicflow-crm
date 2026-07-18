# Phase 4 Manual Testing Fixes

**Date:** 2026-07-18  
**Status:** Implemented and validated locally; production migration deployment remains required  
**Scope:** Assistant/page-customization authorization, role-specific staff personas, and patient-page crash isolation. No Phase 5 functionality was added.

## Outcome

The global Assistant page now supports all four normal clinic roles without granting non-doctors clinical tools. Assistant visibility uses the existing per-user customization system, is admin-managed, and is enforced from persisted state on the sidebar, direct route, chat API, and tool boundaries. The Patient Assistant launcher is doctor-only and fail-soft, so Assistant-specific failures cannot make an otherwise authorized patient record unavailable.

## Root causes

### Assistant page crash

The production-linked Supabase schema does not currently expose `agent_conversations`, `agent_messages`, or `clinic_faq`; direct REST checks returned `PGRST205` (table absent from the schema cache). The P4A migration that creates those tables exists in the repository but has not been deployed to that linked environment.

The Assistant Server Component eagerly called `loadLatestDoctorConversation()` whenever entitlement/usage checks passed. The missing `agent_conversations` relation therefore threw during Server Component rendering and reached the shared global error boundary.

### Patient record crash

Phase 4 added the same eager conversation load to the patient record's optional Assistant launcher. That promise participated in the patient page's server data load, so the missing AI relation rejected the whole patient page even though the patient query and patient authorization had succeeded.

### Visibility bypass risk found during investigation

Middleware previously accepted an unsigned `cf_page_visibility` cookie as authoritative for up to an hour. A user could forge or retain stale page slugs and bypass the saved page-visibility decision on direct navigation. This was not the observed crash, but it violated the required authorization model and was removed.

## Implementation

### Permanent customization model

`docs/AI_AGENT_PLAN.md` now defines one permanent rule for every future clinic-facing module:

- register the page in the existing `PageSlug`/navigation/customization registry;
- declare its role-eligible defaults and localized navigation copy;
- let the clinic admin manage saved per-user visibility through the existing system;
- enforce hidden state on direct routes and server/API/tool boundaries;
- never treat frontend state as authorization;
- keep entitlement, visibility, and data authorization independent.

The clinic admin remains the only clinic role that can open or mutate customization settings. The new migration removes the older manager write policy at the database boundary.

### Assistant page and persistence handling

- Registered Assistant in the default eligible pages for admin, manager, doctor, and receptionist.
- Replaced the doctor-only page guard with authenticated staff resolution.
- Added a shared page resolver that distinguishes hidden, upgrade, inactive subscription, usage cap, temporary lookup failure, and available states.
- Conversation loading now captures unexpected failures safely and converts missing/unavailable persistence into the localized temporary-unavailable state.
- The P4 schema migration remains the actual database fix; the controlled state prevents schema/deployment drift from crashing the application while it is corrected.

### Patient record isolation

- The patient record completes its own patient/RLS authorization before considering the launcher.
- The launcher is evaluated only for a doctor viewing an active patient the doctor is already authorized to access.
- Hidden Assistant, missing entitlement, inactive subscription, usage denial, missing conversations, or any unexpected Assistant dependency failure returns no launcher and never rejects the patient page.
- Patient context cannot be created or persisted for a non-doctor, even through a direct chat request.

### Role-specific Assistant policy

| Role | Global page | Mounted tools | Clinical data | Patient launcher |
|---|---|---|---|---|
| Admin | Entitled + saved visible | Authorized non-clinical patient lookup; availability | No doctor-only notes, summaries, or visit search | No |
| Manager | Entitled + saved visible | Authorized non-clinical patient lookup; availability | No doctor-only notes, summaries, or visit search | No |
| Receptionist | Entitled + saved visible | Authorized non-clinical patient lookup; availability | No doctor-only notes, summaries, or visit search | No |
| Doctor | Entitled + saved visible | Authorized patient lookup; patient summary; visit search; own appointments; availability | Only patients returned by existing clinic/assignment/department RLS | Yes, after patient authorization and all Assistant checks |

Tool registration is explicit and deny-by-default. Every tool rechecks authenticated role, active subscription, `ai_assistant` entitlement, and saved Assistant visibility before opening the authenticated Supabase client. Patient lookup returns only `id`, `full_name`, `file_number`, `phone`, and `email`; it does not select clinical notes, diagnoses, national IDs, dates of birth, or medical history. Existing patient RLS remains the source of clinic, assignment, and department scope. Sensitive tool calls continue through the audit RPC.

General staff conversations are private to their owner and clinic. All four normal roles may persist a general conversation; only doctors may persist a patient-scoped conversation.

### Localization and UX

English and Arabic catalogs now include role-appropriate titles, descriptions, empty states, suggestions, input labels/placeholders, tool activity, disclaimers, and temporary-unavailable copy. Existing logical-direction utilities and RTL-safe icon treatment are preserved. The UI retains the existing responsive/light/dark design system.

## Files changed

### Product and server behavior

- `lib/page-permissions.ts`
- `lib/server-page-permissions.ts`
- `lib/supabase/middleware.ts`
- `actions/page-permissions.ts` was reviewed; its customization page/list/mutation boundaries are already admin-only, so no action code change was required.
- `app/(protected)/assistant/page.tsx`
- `app/(protected)/patients/[id]/page.tsx`
- `app/api/agent/chat/route.ts`
- `components/assistant/assistant-access-gate.tsx`
- `components/assistant/assistant-chat.tsx`
- `components/assistant/patient-assistant-launcher.tsx`

### Assistant authorization, personas, and tools

- `lib/ai/authorization.ts`
- `lib/ai/conversations.ts`
- `lib/ai/errors.ts`
- `lib/ai/surface.ts`
- `lib/ai/staff-agent.ts`
- `lib/ai/prompts/staff.ts`
- `lib/ai/tools/index.ts`
- `lib/ai/tools/check-availability.ts`
- `lib/ai/tools/search-authorized-patients.ts`

### Schema, localization, plan, and tests

- `supabase/migrations/20260718210000_p4_manual_testing_assistant_permissions.sql`
- `messages/en.json`
- `messages/ar.json`
- `docs/AI_AGENT_PLAN.md`
- `tests/unit/ai/p4a-authorization.test.ts`
- `tests/unit/ai/p4a-doctor-tools.test.ts`
- `tests/unit/ai/p4b-surface-access.test.ts`
- `tests/unit/api/p4b-chat-route.test.ts`
- `tests/unit/components/p4b-assistant-chat.test.tsx`
- `tests/unit/db/p4-manual-assistant-permissions-migration.test.ts`
- `tests/unit/integration/p4a-ai-tools-rls.test.ts`
- `tests/unit/integration/rls-security.test.ts`
- `tests/unit/lib/dashboard-navigation.test.ts`
- `tests/unit/lib/p1b-middleware-gating.test.ts`
- `tests/unit/lib/p4-assistant-page-visibility.test.ts`

## Test coverage added or updated

- All four staff roles resolve a controlled Assistant page.
- Administrative roles render a non-clinical persona and cannot mount/execute doctor tools.
- Saved hidden Assistant state removes sidebar visibility and denies direct navigation.
- A forged legacy visibility cookie cannot bypass saved state.
- Visibility lookup failure fails closed at authorization boundaries.
- Entitlement, inactive subscription, usage cap, and reservation compensation remain enforced.
- Missing conversation persistence renders a controlled global state.
- Patient launcher is doctor-only and cannot reject the patient page when any Assistant dependency fails.
- Non-doctor patient-scoped conversation creation is denied.
- Live RLS verifies same-clinic admin/manager/receptionist lookup, doctor department scope, cross-clinic denial, owner-scoped conversations, and admin-only customization writes.
- English/Arabic message parity and administrative UI copy are covered.

## Validation results

| Check | Result |
|---|---|
| TypeScript | `pnpm typecheck` — passed |
| ESLint | `pnpm lint` — passed with 25 pre-existing warnings and no errors/new Assistant warnings |
| Translation parity | `pnpm i18n:missing` — 2,581 keys, passed |
| RTL gate | `pnpm lint:rtl` — 372 files, passed |
| i18n hardcoded-string gate | `pnpm lint:i18n` — 292 files, passed |
| Unit tests | `pnpm test` — 158 files / 901 tests passed |
| Live Supabase RLS integration | P4A + core RLS suites — 2 files / 35 tests passed |
| Production build | `pnpm build` — passed, 64 static pages generated |
| Relevant browser E2E | `tests/e2e/p4b-assistant.spec.ts` — 1 Chromium test passed |
| Diff hygiene | `git diff --check` — passed |

The build still reports Next.js's existing `middleware` → `proxy` convention deprecation warning. The focused E2E also emitted existing test-seed/dashboard warnings unrelated to this change; the scenario passed.

## Deployment requirement

The new migration was applied successfully to the local Supabase stack and the live local RLS suites passed. The linked production environment still needs the repository migrations beginning with `20260718160000_p4a_ai_doctor_tools.sql`, followed in order by `20260718210000_p4_manual_testing_assistant_permissions.sql`. Until they are deployed, the global page will show a controlled temporary-unavailable state and the patient launcher will remain omitted rather than crashing.

Migration deployment was not performed from this workspace because the Supabase CLI has no `SUPABASE_ACCESS_TOKEN`/database deployment credentials. This is the only known production activation step; no commit or push was made.

## Remaining manual testing

After applying the migrations to the target environment:

1. Sign in as admin, manager, receptionist, and doctor in both English and Arabic; open `/assistant` from the sidebar and by direct URL.
2. As the primary clinic admin, hide/show Assistant for representative users in Settings → Customize; confirm the sidebar and direct route update from saved state.
3. Verify a Basic/non-entitled clinic, inactive subscription, and exhausted AI usage each show the appropriate localized state.
4. Verify admin/manager/receptionist can use only non-clinical lookup/availability and cannot elicit notes, summaries, diagnoses, or another clinic's patient.
5. Verify a doctor can find assigned/same-department patients but not an unauthorized department or clinic patient.
6. Open an authorized patient as doctor with Assistant visible/hidden, entitled/not entitled, and conversation present/absent; the patient record must always render and the launcher must follow the conditions.
7. Repeat the key states on mobile and desktop in light/dark themes, including Arabic RTL, checking for raw translation keys or overflow.
