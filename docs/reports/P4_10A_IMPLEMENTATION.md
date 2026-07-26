# P4.10A — Conversational Entity Context (Session Memory) Core

**Date:** 2026-07-25
**Branch:** `feat/p410a-ai-actions`
**Status:** Implemented and approved with zero findings. This is the historical P4.10A baseline report; P4.10B was subsequently implemented on 2026-07-26 without weakening these guarantees. P4.11 remains unstarted.
**Roadmap:** `docs/AI_AGENT_PLAN.md` §8 — P4.10 execution split, sub-phase P4.10A.
**Depends on:** Approved P4.6C entity resolution (the only trusted name→id binding) and P4.6B entity tools; the approved P4.9 baseline.
**Explicitly excluded:** P4.10B (all other entity types + context-switch UX + visible active-context chip + ar/en chip copy), P4.11 workflows, patient AI, and every write-capable AI behavior.

---

## 1. Scope delivered

P4.10A adds the server-side, session-scoped **active-entity context** so that within one conversation the assistant keeps track of the patient under discussion — "open Mohamed Hassan" → "when was his last visit?" resolves to the same patient without re-asking — while leaving every authorization boundary untouched. Patients are the only entity type in P4.10A, and there is **no UI**.

| Deliverable | Where |
|---|---|
| `active_context` jsonb column on `agent_conversations` + archive-clears-context trigger | `supabase/migrations/20260725120000_p410a_conversation_context.sql` |
| Context module: types, defensive parse, per-turn proposal recorder, slot apply/switch, advisory prompt | `lib/ai/conversation-context.ts` |
| Load/persist of `active_context` through the existing owner-scoped RLS client | `lib/ai/conversations.ts` |
| Tool context fields: `activePatientId`, `conversationId`, `contextRecorder` | `lib/ai/tools/context.ts` |
| Patient default-parameter + clarification on both patient tools | `lib/ai/tools/get-patient-summary.ts`, `lib/ai/tools/search-patient-visits.ts` |
| High-confidence single-match resolution proposes the active patient | `lib/ai/tools/search-authorized-patients.ts` |
| Agent wiring: active-patient default + advisory prompt line | `lib/ai/staff-agent.ts` |
| Route wiring: recorder creation + proposal applied at persistence | `app/api/agent/chat/route.ts` |
| Generated database table types | `types/database.ts` |

No new table, RLS policy, grant, entitlement, RPC, prompt persona, model policy, tool, route, page, or client component was added. Nothing new is billable and no new public endpoint exists.

## 2. Context model and trust boundary

`active_context` is a jsonb object on the existing owner-scoped `agent_conversations` row holding at most one slot per entity type — `{ entity_type, entity_id, display_label, set_at, set_by }` — with only the `patient` slot enabled in P4.10A. Its lifecycle is entirely the conversation's:

- **Session-scoped only.** It is cleared when the conversation ends — a `BEFORE UPDATE` trigger nulls it on the `status → archived` transition — and removed with the conversation by the existing clinic/owner cascade on delete. It is never persistent memory, never cross-conversation, never cross-user, and is excluded from any model-training/telemetry path exactly like the rest of the conversation.
- **No new authorization surface.** The column is governed by the existing `agent_owner_all_conversations` policy, so a staff member can only read or write the active context of their own conversation in their own clinic. The operator panel still has no policy on this table. No new grant or RLS policy was added.

**Ids are always server-derived, never asserted by the model.** A slot is only ever written from (a) a **high-confidence single-match** P4.6C resolution (`search_authorized_patients`, where the id comes from the RLS-authorized ranking RPC), or (b) a **page-context** patient binding — the doctor patient-page launch, which is the existing, reviewed `agent_conversations.patient_id` mechanism and is used directly as the default. The `user_choice` source is defined in the model for the P4.10B clarification-pick UI but has no reachable writer in P4.10A. The model can *ask* to switch patient (by naming one, which triggers a new resolution) but can never inject an id from free text.

## 3. How context is used

Each turn the route loads the persisted context and uses it two ways, both advisory:

1. **Advisory prompt line** (`buildActiveContextPrompt`) — appended after the existing page-context prompt. Like page context, it references the active patient by **internal id only, never the stored display label**, so no tenant-authored name enters the system instruction (closing the stored-prompt-injection vector by construction), and it restates that the context grants no access and that ids are never shown in the answer.
2. **Server-side default parameter** — `get_patient_summary` and `search_patient_visits` now take `patient_id` as *optional*; when the model omits it, the effective id is `patient_id ?? ctx.activePatientId`. When neither is present the tool returns a structured `needs_clarification` result (audited as a clarification) asking which patient, rather than guessing.

The active patient is resolved as `activePatientId(active_context) ?? conversation.patientId`, so a conversationally-resolved patient takes precedence and a doctor patient-page launch falls back to its bound, already-re-authorized patient.

### The write path (why a per-turn recorder)

The conversation row is deliberately kept virtual until a turn completes (so an aborted/errored turn leaves no empty conversation), so a tool cannot write `active_context` mid-turn. Instead a tool *proposes* a resolved entity into a per-turn `ConversationContextRecorder`; the route applies the proposal once, inside `persistDoctorTurn`, to the row it is already writing. Last write in a turn wins (a later explicit switch supersedes an earlier resolution), one slot per entity type means a new patient replaces the old one (a natural switch), and a turn with no proposal leaves the stored context untouched.

## 4. Authorization is unchanged and revalidated every turn

This is the headline security property and is proven behaviorally, not by inspection. The active context is an **advisory identity default only**:

- Every patient tool still runs `assertDoctorToolAccess` (role + entitlement + subscription) and then reads through the RLS client scoped by `clinic_id` and the doctor-assignment/department policies on the *effective* id — exactly as it does for an explicitly named id. A stale or forged context id therefore returns `found: false`, never data: a doctor who loses access to a patient mid-conversation gets the standard not-found path on the next turn, and a context pointing at another department's or another clinic's patient returns nothing. Live tests cover all three.
- Context is never set from a `medium`/`low` or multi-candidate resolution — only a single high-confidence match proposes it — so a namesake ambiguity never silently binds a patient.
- Tool mounting, task-class gating, plan entitlements, per-user financial permissions, rate limiting, PHI redaction, untrusted-text neutralization, and the usage/billing accounting boundary are all unchanged. The context adds no tool and widens no mount.

## 5. PHI and data-handling posture

- `active_context` stores an entity id, a display label (the patient name, for the P4.10B chip), and metadata — the same sensitivity class as the conversation `title` and message bodies, under the identical owner/clinic RLS scope, with no operator visibility, cleared on archive and removed on delete.
- The display label **never reaches the model in P4.10A**: the prompt line uses the id only, and the patient tools receive only the id. (P4.10B, which renders the label in a React chip, must continue to keep it out of model context.)
- No new PHI egress path is introduced; the patient tools' existing redaction of note/contact content is unchanged.

## 6. Files added / modified

**Added**
- `supabase/migrations/20260725120000_p410a_conversation_context.sql`
- `lib/ai/conversation-context.ts`
- `tests/unit/ai/p410a-conversation-context.test.ts`
- `tests/unit/ai/p410a-context-tools.test.ts`
- `tests/unit/db/p410a-conversation-context-migration.test.ts`
- `tests/unit/integration/p410a-conversation-context-rls.test.ts`

**Modified**
- `lib/ai/conversations.ts` — load/return `activeContext`; apply a proposal into `active_context` at persistence.
- `lib/ai/tools/context.ts` — `activePatientId`, `conversationId`, `contextRecorder` on `DoctorToolContext`.
- `lib/ai/tools/get-patient-summary.ts`, `lib/ai/tools/search-patient-visits.ts` — optional `patient_id` + active-patient fallback + clarification, with the effective id re-authorized and the audit noting `from_active_context`.
- `lib/ai/tools/search-authorized-patients.ts` — propose the active patient on a single high-confidence match.
- `lib/ai/staff-agent.ts` — compute the active-patient default and append the advisory prompt line.
- `app/api/agent/chat/route.ts` — create the recorder, pass session context to the agent, and apply the proposal on persist.
- `types/database.ts` — `active_context` on `agent_conversations` Row/Insert/Update (hand-added to match the generator; parity verified against a local `supabase gen types`).
- `tests/unit/ai/p4b-conversations.test.ts` — additive `activeContext` field in one strict `toEqual`.
- `tests/unit/ai/p49b-scope-and-patient-launcher.test.ts` — the P4.9B phase-boundary guard now tracks only the still-unstarted P4.11 workflow objects, since `active_context` is legitimately P4.10A.

## 7. Test coverage

- **Module** (`p410a-conversation-context.test.ts`, 11 tests): defensive parse (drops malformed/forward-version/unknown-key/mismatched-type slots without throwing), recorder last-write-wins + label trim/cap, `applyProposal` set/switch and validation-drop, and the prompt line (id-only, never the label; localized en/ar security posture).
- **Tool behavior** (`p410a-context-tools.test.ts`, 10 tests): resolution proposes only on a single high-confidence match (never medium/ambiguous, never without a conversation); `get_patient_summary` / `search_patient_visits` use the active patient when the id is omitted, prefer an explicit id, return `found: false` for a stale/out-of-scope context id, and ask for clarification with no context.
- **Live RLS integration** (`p410a-conversation-context-rls.test.ts`, 9 tests): the resolution → next-turn round-trip resolves the same patient; a later resolution switches it; a no-proposal turn is inert; `active_context` is owner-private and clinic-isolated (colleague and other clinic read nothing); archive clears it; delete removes it; and the default parameter re-authorizes every turn through live doctor-scoping RLS (in-scope → summary, other department → `found: false`, other clinic → `found: false`).
- **Migration + type parity** (`p410a-conversation-context-migration.test.ts`, 5 tests): column shape + object check, archive-clears trigger, no new table/policy/grant, no P4.10B/P4.11 objects, and `active_context` present on Row/Insert/Update.

## 8. Validation results (2026-07-25)

| Check | Result |
|---|---|
| Focused P4.10A set (module + tools + migration) | Pass — 3 files, 26 tests |
| Focused live P4.10A RLS/lifecycle integration | Pass — 1 file, 9 tests against local Supabase |
| `pnpm test` (unit, excludes integration) | Pass — 205 files, 1,497 tests |
| `pnpm test:integration` | Pass — 25 files, 266 tests against local Supabase |
| `pnpm typecheck` | Pass |
| `pnpm lint` | Pass — 0 errors; 25 pre-existing repository warnings |
| `pnpm lint:i18n` | Pass — 305 files; 14 documented exceptions |
| `pnpm i18n:missing` | Pass — 2,831 base messages; locale variants valid |
| `pnpm i18n:unused` | Pass — no unreferenced keys |
| `pnpm lint:rtl` | Pass — 426 files; 10 documented exceptions |
| Generated database-type parity | Pass — `agent_conversations.active_context` matches a local `supabase gen types` |
| `pnpm build` | Pass — Next.js; 67 pages generated |
| `git diff --check` | Clean |

The production build retains the repository's existing middleware-to-proxy deprecation notice; the local Supabase CLI reports a newer release is available. Neither is caused by P4.10A. No commit was made, per the session directive.

## 9. i18n / RTL / accessibility

P4.10A adds no UI, so there are no new message keys, components, or physical-direction styles; the i18n and RTL gates pass unchanged. The one model-facing localized string — the advisory active-context prompt line — is provided in both en and ar and is asserted by test. Accessibility of the (P4.10B) active-context chip is out of scope for this sub-phase.

## 10. Scope boundary at P4.10A completion

At P4.10A completion there was no additional entity type (appointments, invoices, staff, departments, reports), context-switch UX, or visible active-context chip. Those P4.10B items were subsequently implemented and are reported separately in `docs/reports/P4_10B_IMPLEMENTATION.md`. There remains no workflow engine, `ai_workflow_runs` table, `ai.workflows` entitlement, plan/dry-run/confirm execution, or action step — all P4.11. No patient-facing AI and no write-capable AI behavior were added. The P4.9B phase-boundary test continues to assert the absence of the P4.11 workflow objects.
