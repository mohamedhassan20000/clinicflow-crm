# P4.10B — Cross-Entity Conversation Context and Context UX

**Date:** 2026-07-26  
**Branch:** `feat/p410b-conversation-context-entities`  
**Status:** Implemented; P4.10 is complete. P4.11 remains unstarted.  
**Roadmap:** `docs/AI_AGENT_PLAN.md` §8 — P4.10B.  
**Baseline:** P4.10A was reviewed and approved with zero findings (`docs/reviews/P4.10A_REVIEW.md`). Every verified P4.10A guarantee is preserved.

---

## 1. Scope delivered

P4.10B extends the P4.10A conversation-scoped `active_context` machinery from patients to every remaining roadmap entity: appointments, invoices, staff, departments, and reports. It adds natural per-type switching, explicit clarification choices, bilingual visible context chips, and an accessible clear control.

The implementation is deliberately additive:

- one independent slot per entity type on the existing JSON object;
- the existing patient slot and patient-bound conversation fallback remain unchanged;
- no new table, column, migration, RLS policy, grant, RPC, entitlement, model, task class, tool, or public route;
- no workflow, write-capable AI action, patient persona, persistent memory, or cross-conversation recall.

## 2. Entity behavior

| Entity | Trusted set/switch path | Default consumer | Re-authorization on every use |
|---|---|---|---|
| Patient | Existing P4.10A high-confidence authorized search; explicit revalidated candidate choice | `get_patient_summary`, `search_patient_visits` | Doctor gate + authenticated patient RLS |
| Appointment | Exactly one row returned by a complete, non-truncated authenticated appointment query; explicit revalidated choice | `list_appointments`, `list_doctor_appointments` with explicit active-appointment intent | Analytics/doctor gate + authenticated appointment RLS and existing role scope |
| Invoice | Exactly one completed outstanding row returned by the complete, non-truncated authenticated financial query; explicit revalidated choice | `list_outstanding_invoices` with explicit active-invoice intent | Financial entitlement + per-user permission + authenticated RLS |
| Staff | High-confidence deterministic `search_staff_ranked` resolution; explicit revalidated choice | Doctor/staff filter in `list_appointments` and supported clinic reports, with explicit active-staff intent | Analytics/report gate + authenticated profile RLS |
| Department | High-confidence deterministic `search_departments_ranked` resolution; explicit revalidated choice | Department filter in `list_appointments` | Analytics gate + authenticated department RLS |
| Report | Successful server-registry resolution of an allow-listed report; explicit revalidated choice | `run_clinic_report` | Per-report role matrix plus analytics or financial gate |

A new proposal replaces only the slot for its entity type. Other active slots remain intact. A turn can resolve several types together—for example, a doctor, department, and the single appointment returned by those filters—and persistence applies all proposals once after the turn succeeds.

## 3. Trust boundary preserved

### Server-derived identity only

The model does not write `active_context`. Tools can only submit proposals to the per-turn recorder; the owner-scoped persistence layer applies them after a successful turn.

- Opaque UUIDs supplied in model tool arguments may be checked through authenticated RLS for that one call, but they carry `trustedForContext: false` and are never promoted into stored context.
- Staff and department names are stored only after a high-confidence deterministic ranked resolution.
- Appointment and invoice slots are stored only from one-row authenticated query results, never from an explicit model UUID.
- Report ids are closed, server-owned registry slugs. A slot is proposed only after the selected report passes its role/permission gate and executes successfully.
- Clarification choices contain only an entity type and candidate id. The server action re-authorizes the conversation owner, re-reads the entity through the authenticated RLS client, re-runs the relevant analytics/financial/report gate, and derives the canonical label itself. A stale, deleted, foreign-clinic, unauthorized, or malformed selection is rejected without updating context.

### Advisory defaults never grant access

Active context remains an identity default only. Every consuming tool independently rechecks its normal role, subscription, entitlement, page visibility, per-user permission where applicable, and RLS scope. A stale or forged slot can therefore yield only a normal clarification/not-found/denied result; it cannot widen the caller's access.

For list tools, omission is not treated as entity-scoped intent. `list_appointments`, `list_doctor_appointments`, and `list_outstanding_invoices` expose per-entity `use_active_*` flags that the model sets only when the user explicitly refers to that active entity. Broad and aggregate requests leave those flags false or omitted and remain broad even while chips are visible. The system prompt also forbids copying an active internal id into an explicit id argument as a substitute for the intent flag.

The clear and choose actions additionally scope every conversation read and update to:

- authenticated `clinic_id`;
- authenticated `user_id`;
- the existing `doctor` persona value;
- `status = active`;
- the existing owner-scoped conversation RLS policy.

## 4. Display labels are strictly UI-only

`display_label` is used only to render the chip visible to the user.

- `buildActiveContextPrompt` enumerates only validated entity types and internal ids/slugs. It never reads a display label.
- The browser chat request body contains the typed page context and latest message only. It never sends `active_context` or any chip label.
- Tool defaults receive only validated ids through `DoctorToolContext`.
- The explicit-choice action ignores browser display text by schema: it accepts no label field and derives the canonical label from an authenticated server read.
- Unit and component tests use prompt-injection-style labels and assert that they appear in neither localized prompt nor chat payload.

## 5. UX, i18n, RTL, and accessibility

The assistant header renders one compact ClinicFlow-styled chip for each active slot:

- localized entity label plus the UI-only display label;
- a 28px clear/× button with a localized, entity-specific accessible name;
- logical `ps`/`pe` spacing and flex wrapping for RTL and narrow layouts;
- disabled mutation controls while a turn or another context mutation is in progress;
- polite live-region announcements for successful updates, clears, and failures.

Ambiguous patient, staff, department, and report results expose structured candidate buttons. Choosing one calls the server revalidation boundary; the candidate label shown in the browser is never trusted for persistence.

English and Arabic catalogs contain parity keys for all six entity labels, the clear control, candidate prompt, success states, and the fail-closed error state.

## 6. Lifecycle, tenancy, and schema posture

P4.10B reuses the P4.10A `agent_conversations.active_context jsonb` column and archive trigger exactly as approved:

- context remains conversation-scoped and owner-private;
- archive clears the complete JSON object;
- delete removes it with the conversation;
- a new conversation starts with no active slots;
- no slot crosses conversation, user, or clinic boundaries;
- no P4.10B migration exists because the P4.10A JSON object was intentionally extensible;
- existing policies, grants, constraints, and generated database types are unchanged by P4.10B.

## 7. Files added or modified by P4.10B

**Added**

- `actions/assistant-context.ts`
- `tests/unit/actions/p410b-assistant-context.test.ts`
- `tests/unit/ai/p410b-context-tools.test.ts`
- `tests/unit/ai/p410b-conversation-context.test.ts`
- `tests/unit/components/p410b-active-context-ui.test.tsx`
- `docs/reports/P4_10B_IMPLEMENTATION.md`

**Modified**

- `lib/ai/conversation-context.ts`
- `lib/ai/conversations.ts`
- `lib/ai/staff-agent.ts`
- `lib/ai/clinic-reports.ts`
- `lib/ai/tools/context.ts`
- `lib/ai/tools/entity-filters.ts`
- `lib/ai/tools/list-appointments.ts`
- `lib/ai/tools/list-doctor-appointments.ts`
- `lib/ai/tools/list-outstanding-invoices.ts`
- `lib/ai/tools/run-clinic-report.ts`
- `app/api/agent/chat/route.ts`
- `app/api/agent/launcher-session/route.ts`
- `app/(protected)/assistant/page.tsx`
- `components/assistant/assistant-chat.tsx`
- `components/assistant/assistant-launcher.tsx`
- `messages/en.json`
- `messages/ar.json`
- `tests/unit/ai/p410a-conversation-context.test.ts`
- `tests/unit/api/p48a-launcher-session-route.test.ts`
- `tests/unit/integration/p410a-conversation-context-rls.test.ts`
- `docs/AI_AGENT_PLAN.md`
- `docs/reports/OPERATING_ASSISTANT_EXPANSION_PROPOSAL.md`
- `docs/reports/P4_10A_IMPLEMENTATION.md`

P4.10A files already present in the working tree remain part of the approved baseline and are not claimed as new P4.10B schema work.

## 8. Test coverage

- **Cross-entity module contract:** all six slot types, per-type validation, multi-proposal persistence, natural switching, exact-slot clear, allow-listed report slugs, and en/ar prompt label exclusion.
- **Tool behavior:** explicit intent-gated active appointment/staff/department/invoice list scoping, active report defaults, per-call authorization assertions, deterministic multi-entity resolution, stale-context fail-closed behavior, model-UUID non-promotion, report selection and authorization.
- **Server actions:** all six explicit choice types, canonical server labels, relevant analytics/financial gates, owner/clinic/persona/status scoping, stale/foreign candidate denial, exact-slot clear.
- **Component behavior:** six visible chips, six localized accessible clear names, exact-slot clearing, payload label exclusion, supported structured clarification mapping.
- **Live RLS:** all six slots round-trip through local Postgres, one type switches without disturbing its neighbors, and the complete context remains invisible to a same-clinic colleague and another clinic. Existing P4.10A live tests continue to cover archive, delete, patient revocation, and cross-clinic patient defaults.
- **Regression:** the complete pre-existing P4.10A module/tool/migration/live suite remains green.

## 9. Review Fixes

The findings in `docs/reviews/P4.10_COMPREHENSIVE_REVIEW.md` were implemented without changing the approved authorization, RLS, billing, auditing, PHI, or model/client UUID trust boundaries.

### P410-M1 — advisory context no longer silently narrows list tools

- Added independent `use_active_appointment`, `use_active_staff`, and `use_active_department` intent flags to `list_appointments`, `use_active_appointment` to `list_doctor_appointments`, `use_active_invoice` to `list_outstanding_invoices`, and `use_active_staff` to the doctor dimension of `run_clinic_report`.
- An active slot is read as a list filter only when its matching flag is explicitly true. Argument omission now leaves clinic-wide and other broad list queries broad while the active slot remains stored and visible.
- Per-entity flags prevent a request about one active entity from accidentally applying every active slot in the conversation.
- An explicit active-context request with no corresponding slot returns clarification instead of silently widening to a broad query.
- Explicitly scoped stale or unauthorized slots still fail through the existing authenticated RLS and authorization path; broad requests do not probe or apply those slots.
- Audit `from_active_context` fields now report only context filters that were explicitly selected and actually available.
- The advisory prompt tells the model to use the matching `use_active_*` flag only for explicit entity-scoped intent, omit all such flags for broad/aggregate intent, and never copy the prompt's active id into an explicit id argument.

### P410-M2 — only complete-result uniqueness can set context

- `list_outstanding_invoices` now requires `!truncated` as well as one returned row before proposing an invoice slot. A `limit: 1` request over multiple matches therefore cannot pin the first row.
- `list_appointments` applies the same non-truncation guard.
- `list_doctor_appointments` now fetches one row past its fixed cap internally, slices back to the existing cap, and requires a complete single-row result before proposing an appointment.
- Exactly one true, authorized match preserves the existing natural-resolution behavior; complete multi-row and truncated results produce no context proposal.

### P410-L1 — context mutations use the shared AI-platform limiter

- `chooseAssistantConversationContext` and `clearAssistantConversationContext` now call the existing `checkRateLimit` implementation with namespace `assistant-context-mutation`, caller key `${clinicId}:${userId}`, and the launcher-consistent `{ limit: 30, windowSeconds: 60, failureMode: "open" }` policy.
- A denied request returns the stable `{ success: false, reason: "rate_limited" }` result before creating a Supabase client or reading/mutating the conversation.
- No new rate-limit mechanism, persistence, entitlement, permission, or route was introduced.

### Regression coverage

- Broad clinic-wide appointment, outstanding-balance, and doctor-performance report queries with active slots.
- Explicit appointment/staff/department/invoice scoping with active slots.
- Broad requests with no active slot.
- Stale or unauthorized active staff/invoice slots under broad and explicit intent.
- `limit: 1` with multiple invoice matches, complete ambiguity, exactly one true invoice match, and truncated appointment results.
- Both context actions invoke the shared limiter, and denied calls return before database-client creation.

## 10. Validation results

| Check | Result |
|---|---|
| Focused P4.10A + P4.10B unit/action/component/migration/API set | Pass — 8 files, 87 tests |
| Live integration suite, including P4.10 cross-entity RLS | Pass — 25 files, 267 tests against local Supabase |
| `pnpm test` | Pass — 209 files, 1,538 tests |
| `pnpm typecheck` | Pass — zero errors |
| `pnpm lint` | Pass — zero errors; 25 pre-existing repository warnings |
| `pnpm lint:i18n` | Pass — 306 files; 14 documented exceptions |
| `pnpm i18n:missing` | Pass — 2,842 base leaf messages; locale variants valid |
| `pnpm i18n:unused` | Pass — no unreferenced keys |
| `pnpm lint:rtl` | Pass — 426 files; 10 documented exceptions |
| `pnpm build` | Pass — production build; 67 pages generated |
| Migration/policy posture | Pass — no P4.10B migration, policy, grant, schema, or generated-type change |
| `git diff --check` | Pass |

No commit, push, or pull request is part of this implementation.

The build reports the repository's existing middleware-to-proxy deprecation notice. The first sandboxed build attempt could not fetch the existing Google-hosted Manrope font; the identical build passed with network access. The live suite likewise required loading the existing `.env.local` local-Supabase variables and permission to connect to `127.0.0.1:54321`. Neither condition is a product regression.

## 11. Explicitly not implemented

P4.11 remains untouched: no workflow engine, workflow ledger, workflow entitlement, dry-run/confirmation system, action step, or write-capable AI behavior. P5 patient AI, persistent/cross-conversation memory, clinic-global memory, and new clinical or financial permissions are also outside P4.10B.
