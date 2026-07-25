# P4.9A — Assistant Customization Core

**Date:** 2026-07-22  
**Branch:** `feat/p49a-agent-workflows`  
**Status:** Implemented with approved review fixes; P4.9B remains unstarted.  
**Roadmap:** `docs/AI_AGENT_PLAN.md` §8 — P4.9 execution split, sub-phase P4.9A.  
**Depends on:** Approved P4.8 launcher registry and server-side resolver.  
**Explicitly excluded:** P4.9B settings UI and every later phase.

---

## 1. Scope delivered

P4.9A adds the premium placement data and resolution layer without adding a settings surface.

| Deliverable | Where |
|---|---|
| Role-level launcher placement table | `assistant_launcher_settings` in `20260722120000_p49a_assistant_customization.sql` |
| Optional per-user placement override table | `assistant_launcher_user_overrides` in the same migration |
| Clinic-scoped RLS and primary-admin-only writes | Same migration, reusing `is_primary_clinic_admin` |
| Composite-key placement audit trigger | Same migration, writing non-PHI changes to `audit_logs` |
| Review-fix audit/grant hardening for already-applied local/deployed baselines | `20260722130000_p49a_review_fixes.sql` |
| `pro_ai`-only namespaced entitlement seed | `ai.assistant_customization` on the stable plan catalog |
| Closed commercial feature vocabulary | `lib/ai/commercial-policy.ts` |
| Server-only placement precedence resolver | `lib/ai/launcher-placement.ts` |
| P4.8 launcher integration | `lib/ai/launchers.ts` |
| Scoped read-only service-role table classification | `lib/supabase/admin.ts` |
| Generated database table types | `types/database.ts` |

No route, page, server action, message key, client component, prompt, model policy, tool, RPC, or AI workflow was added.

## 2. Placement schema and RLS

`assistant_launcher_settings` stores one optional role-level decision per `(clinic_id, area, role)`. It also stores the last actor and update timestamp. `assistant_launcher_user_overrides` stores one optional user-level decision per `(clinic_id, user_id, area)`.

Both tables:

- use the exact nine P4.8 area identifiers and reject unknown areas;
- cascade with clinic deletion;
- enable RLS and revoke anonymous/public access;
- allow authenticated users to read only rows belonging to `auth_clinic_id()`;
- allow writes only when `is_primary_clinic_admin(clinic_id, auth.uid())` passes;
- preserve tenant integrity for user overrides with the composite `(user_id, clinic_id) → profiles(id, clinic_id)` foreign key.

Direct role-setting writes must attribute `updated_by` to the authenticated primary admin. Both tables use a dedicated composite-key audit trigger because the legacy `write_audit_log` trigger assumes a single UUID `id`. Inserts, updates, and deletes write non-PHI old/new placement rows to the existing clinic-scoped `audit_logs` ledger.

Placement resolution remains readable through the clinic-scoped service client, but that wrapper and the database grants now make both placement tables read-only to raw service-role table access. The supported mutation boundary is an authenticated primary-admin Supabase session, so RLS authorization and `auth.uid()` audit attribution execute together. The trigger also rejects a mutation when `auth.uid()` is absent instead of writing a null actor. The project has no synthetic service profile that could safely satisfy the existing `audit_logs.actor_id → profiles.id` relationship, so an actorless maintenance write is rejected; any future service maintenance path must be a separately reviewed RPC with an explicit, database-verified actor.

## 3. Entitlement and resolution contract

The migration seeds `ai.assistant_customization = true` only on the stable `pro_ai` row and explicitly stores `false` on `basic` and `pro`. The existing `hasFeature` policy still requires the `pro_ai` plan and the legacy AI umbrella, so a clinic feature override cannot lift Basic or Professional into this AI feature.

The server resolver applies the roadmap precedence exactly:

1. Resolve `ai.assistant_customization` through the existing subscription, plan, and clinic-override entitlement chain.
2. Start from the code-owned registry default.
3. If entitled, apply the clinic's role-level setting when present.
4. Apply the current user's override last when present.

When customization is not entitled, persisted settings are inert and code defaults apply. When an entitled placement lookup fails, the optional launcher is omitted rather than guessing that no disable row exists. The host page remains available.

The P4.8 resolver still checks role eligibility before reading placement, so a stored row for an unsupported role/area combination cannot create a launcher. After placement passes, the existing source-page visibility, Assistant-page visibility, feature requirements, financial permission, subscription, usage-cap, rate-limit, persistence-readiness, and deferred-session checks run unchanged.

## 4. Preserved platform guarantees

- **Authorization and tool mounting:** behavioral parity coverage resolves direct Assistant authorization and the complete authorized tool-name set with default, role-disabled, user-disabled, and user-enabled placement. A visible launcher grants no tool; a hidden launcher removes no global Assistant or API authorization.
- **Tenant isolation and RLS:** both new tables have live two-clinic PostgREST denial coverage. The server read path also uses the reviewed clinic-scoped admin wrapper, which injects `clinic_id` and rejects unclassified tables.
- **PHI protection:** placement rows contain area, role/user identifier, and booleans only. No patient, appointment, invoice, conversation, prompt, message, or clinical content is stored or logged.
- **Billing and usage:** launcher placement does not reserve AI budget, increment usage, select provider/model policy, or execute a tool. Existing chat execution remains the only billable boundary.
- **Rate limiting:** neither existing launcher hydration nor chat limiters were changed. Placement is resolved during the existing server-rendered launcher gate and introduces no public endpoint.
- **Auditing:** every successful placement mutation is made through an authenticated primary-admin session and recorded in `audit_logs` with that exact actor. Raw service-role mutations are rejected rather than producing unattributed rows; actual Assistant tool calls retain their independent per-invocation audit path.
- **Failure containment:** a placement lookup failure removes only the optional launcher enhancement and is handled by the existing sanitized P4.8 fail-soft telemetry path.

The backend/Next.js guidance reinforced keeping this as a direct server-side read used by Server Components, with no internal GET route or client-side authorization state.

## 5. Test coverage

New and expanded coverage includes:

- pure precedence matrices for entitlement/default/role/user combinations;
- no database read when customization is not entitled;
- exact tenant, area, role, and user filters for entitled reads;
- fail-closed lookup behavior;
- P4.8 resolver omission before usage/session hydration when placement is disabled;
- unsupported role/area denial before placement;
- behavioral parity across default, role-disabled, user-disabled, and user-enabled placement for direct Assistant authorization and the complete mounted tool-name set;
- enabled-placement denial coverage for unsupported roles, missing financial permission, and missing financial entitlement;
- disabled launcher-session API behavior alongside an independently successful and billable chat API request;
- an explicit P4.9B absence contract for the settings page and mutation actions;
- `basic`/`pro` denial even when operator overrides attempt to enable customization;
- scoped-admin-wrapper classification for both new tables;
- static migration checks for schema, RLS, entitlement, audit, and no P4.10/P4.11 objects;
- live primary-admin vs. secondary-admin/doctor write authorization;
- live primary-admin insert/update/delete audit assertions for role settings and user overrides, including exact actors, actions, composite keys, and old/new enabled values;
- raw service-role mutation rejection plus proof that denied service, secondary-admin, and cross-clinic attempts create neither placement rows nor audit rows;
- live same-clinic reads and cross-clinic invisibility for both tables;
- live cross-tenant target-FK denial, unknown-area denial, actor-spoof denial, update/delete denial, and audit-ledger assertions;
- generated TypeScript type parity against the applied local schema;
- keyboard operation plus accessible name/description regression coverage for a placement-visible launcher.

## 6. Validation

Final validation after the approved review fixes on 2026-07-22:

| Check | Result |
|---|---|
| Focused P4.9A/P4.8/commercial/accessibility set | Pass — 7 files, 99 tests |
| Focused live P4.9A RLS/audit integration | Pass — 1 file, 12 tests |
| `pnpm test` | Pass — 197 files, 1,446 tests |
| `pnpm test:integration` | Pass — 24 files, 257 tests against local Supabase |
| `pnpm typecheck` | Pass |
| `pnpm lint` | Pass — 0 errors; 25 pre-existing repository warnings |
| `pnpm lint:i18n` | Pass — 302 files; 14 documented exceptions |
| `pnpm i18n:missing` | Pass — 2,785 base messages; locale variants valid |
| `pnpm i18n:unused` | Pass — no unreferenced keys |
| `pnpm lint:rtl` | Pass — 421 files; 10 documented exceptions |
| Local generated database-type comparison | Pass — both table shapes match `types/database.ts` |
| Local Supabase DB lint | Original P4.9A validation passed; not rerun because it was outside the requested review-fix matrix |
| `pnpm build` | Pass — Next.js 16.2.6; 66 pages generated |
| `git diff --check` | Pass |

The production build retains the repository's existing Next.js middleware-to-proxy deprecation notice. The local Supabase CLI also reports that a newer CLI release is available; neither warning is caused by P4.9A.

## 7. Review Fixes

### P49A-M1 — meaningful audit actors on every successful mutation

- Changed the scoped service-role wrapper from read/write classification to read-only classification for both placement tables, preserving tenant-injected resolution reads while rejecting wrapper mutations before a database request.
- Restricted database service-role grants to `SELECT`; authenticated users retain `SELECT/INSERT/UPDATE/DELETE` under the existing primary-admin RLS policies.
- Hardened `audit_assistant_launcher_placement()` to reject any actorless mutation with `ASSISTANT_LAUNCHER_ACTOR_REQUIRED` / SQLSTATE `42501` instead of inserting `actor_id = null`.
- Added an additive review-fix migration so an environment that already applied the original P4.9A migration receives the corrected function and grants without a database reset.
- Expanded live coverage to all three mutation operations on both tables, exact primary-admin actor IDs and old/new composite-key payloads, no mutation/audit for unauthorized attempts, and raw service-role rejection.

This preserves the existing audit ledger, RLS policies, primary-admin authority, and tenant boundaries. It intentionally does not add a P4.9B mutation action or settings surface.

### P49A-M2 — behavioral authorization and mounting verification

- Removed the source-file string inspection that inferred isolation from import/table-name absence.
- Added behavior-level module integration coverage showing placement changes affect only launcher/session availability while direct Assistant authorization and the complete tool mount remain identical.
- Added enabled-override scenarios proving unsupported roles, missing financial permission, and missing financial entitlement still deny the launcher and protected tools.
- Added API-boundary coverage proving a disabled launcher session fails closed without reserving usage, while the independent chat API remains usable and crosses the existing accounting boundary exactly once.

No production authorization, tool registry, chat billing, rate-limit, entitlement, or launcher product behavior changed for P49A-M2; only the regression evidence changed.

## 8. P4.9B remains out of scope

There is no `/settings/assistant` page, area × role matrix, per-user editor, upgrade-gate UI, localized settings copy, or placement mutation action. P4.9B must build those controls on this storage and must continue to treat them as UI visibility only. P4.10 session memory, P4.11 workflows, patient AI, and all write-capable AI behavior remain unstarted.
