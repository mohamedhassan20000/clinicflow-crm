# ClinicFlow Operating-Assistant Expansion — Architecture & Roadmap Proposal

**Date:** 2026-07-20
**Status:** Approved direction (founder-approved 2026-07-20, including the §16–§17 additions). Sections 1–17 are the pre-implementation analysis required before broadening the assistant. The only code implemented alongside this proposal is **P4.6C Wave 1** (patient entity search — §6, migration `20260720120000_p46c_entity_search.sql`). Everything else is roadmap-planned in `docs/AI_AGENT_PLAN.md` (§8) and not implemented.
**Companion revision:** `docs/AI_AGENT_PLAN.md` — *Revised: 2026-07-20* entry (adds P4.6C, P4.8, P4.9).

---

## 1. Current gaps in the shipped implementation

Shipped state audited on `main` (P4 + P4.5 merged, PRs #43/#44):

| # | Gap | Evidence |
|---|---|---|
| 1 | **No aggregate/statistics capability.** "How many departments / patients / appointments today?" is unanswerable: no count, stat, revenue, or report tool exists. | `lib/ai/tools/index.ts` — the entire model-facing surface is 5 tools (doctor) / 2 tools (admin/manager/receptionist). Entitlement keys `ai.staff_analytics` / `ai.financial_insights` exist in `lib/ai/platform/commercial-policy.ts` but no tool implements them. |
| 2 | **Rigid patient search.** `search_authorized_patients` used `ilike '%substring%'` on `full_name` plus **exact-only** `file_number`/`phone` equality — no fuzzy match, no ranking, no Arabic normalization (alef/hamza/taa-marbuta variants), no transliteration, no confidence metadata. The baseline `pg_trgm` index existed but was never used for similarity ranking. | `lib/ai/tools/search-authorized-patients.ts` (pre-P4.6C version); `idx_patients_name_trgm` in the baseline schema. *(Fixed by Wave 1, §6.)* |
| 3 | **Thin non-doctor personas.** Admin/manager/receptionist — the roles that most need operational answers — get only patient lookup + availability. | `buildAdministrativeTools` in `lib/ai/tools/index.ts`. |
| 4 | **No help/navigation/capability layer.** "How do I use ClinicFlow?" and "where do I configure X?" have no tool; users cannot discover what the assistant can do. | No `search_help` / `get_navigation_target` / `list_my_capabilities`; no help corpus. |
| 5 | **One contextual entry point.** Only the doctor-only patient-profile Sheet launcher exists, and only `patientId` is ever passed as context. | `components/assistant/patient-assistant-launcher.tsx`, `resolvePatientAssistantLauncher` in `lib/ai/surface.ts`, `app/api/agent/chat/route.ts`. |
| 6 | **No tool registry.** Tools are hand-assembled per role in `buildStaffTools`; there is no declarative metadata (domain, entitlement, privacy class, task class) to drive capability discovery or launcher/customization features. | `lib/ai/tools/index.ts`. |

Strong foundations to build on (do not rework): the P4.5 platform layer (task classes, certified model routes, budget reserve/reconcile, managed/BYOK/hybrid credential modes, immutable `ai_usage_events`, per-tool audit via `log_agent_tool_call`), deny-by-default role→toolset mapping, RLS-through-every-tool, and fully bilingual prompts/UI.

**Correction to a common assumption:** soft-deleted patients were *not* leaking through the old search tool — `patients_select_role_scoped` RLS already filters `NOT is_deleted` (and doctor assignment/department scope). The new search RPC is `SECURITY INVOKER` precisely to keep inheriting that policy.

## 2. Mapping of requested capabilities to existing roadmap phases

| Requested capability | Roadmap home | Status |
|---|---|---|
| Aggregate questions (departments, patients, appointments, no-show/cancellation rates, doctor utilization) | **P4.6** (`get_clinic_summary`, `get_patient_stats`, `get_appointment_stats`, list tools, `run_clinic_report`) | Planned, not implemented |
| Revenue/financial reporting (admin; permission-gated manager) | **P4.6** financial tools + `ai.financial_insights` + per-user permission | Planned, not implemented |
| Declarative typed tool registry | **P4.6A** keystone refactor | Planned, not implemented |
| Help corpus, navigation guidance, `list_my_capabilities`, capability panel | **P4.7** | Planned, not implemented |
| Cheap task classes for help/navigation | **P4.7** `staff_help` (haiku-tier) on the P4.5 registry | Planned, not implemented |
| Role-decreasing permissions, server-enforced | Shipped spine (§6.8, P4.5 resolution chain) + P4.6 matrix | Architecture shipped; tools missing |
| **Fuzzy/Arabic/transliteration entity search with ranked candidates** | **Was missing → new P4.6C** | Wave 1 implemented |
| **Contextual "Ask Assistant" launchers + page-context contract** | **Was missing → new P4.8** | Planned by this proposal |
| **Premium per-role/per-user launcher placement customization** | **Was missing → new P4.9** | Planned by this proposal |

## 3. Missing roadmap work (now added)

1. **P4.6C — Intelligent entity search & name resolution** (inserted into P4.6; merge-first within the phase). Deterministic DB-native search infrastructure for patients now, and the same pattern for staff/departments/services when their tools land in P4.6A.
2. **P4.8 — Contextual Assistant Launchers & Page-Context Contract.** One reusable launcher + a typed page-context contract; entry points across patient profile, appointments, dashboard, revenue, reports, invoices, staff, departments, doctor schedule.
3. **P4.9 — AI Assistant Customization** (premium, `pro_ai`-only). Primary-admin configuration of where launchers appear, per area × role with optional per-user overrides.
4. **P4.10 — Conversational Entity Context (Session Memory)** *(founder addition, approved 2026-07-20)*. Server-side, conversation-scoped active-entity tracking so follow-up questions ("when was **his** last visit?") resolve without re-asking. Design in §16.
5. **P4.11 — Multi-Step AI Workflow Execution** *(founder addition, approved 2026-07-20)*. Reusable orchestration of multiple registry tools with dry-run + confirmation for action steps. Design in §17.

## 4. Proposed new/revised phases and sub-phases

Recorded normatively in `docs/AI_AGENT_PLAN.md` §8. Summary:

- **P4.6 (revised, 13–18 days):** P4.6C (3–4 d, merge first) → P4.6A (6–9 d) → P4.6B (4–5 d).
- **P4.8 (new, 5–7 days):** P4.8A context contract + launcher core + first three areas (patient, appointments, dashboard); P4.8B remaining areas + polish. Depends on P4.6B (needs aggregate tools for the contexts to be useful) and reuses P4.7A's navigation registry.
- **P4.9 (new, 4–6 days):** P4.9A schema + entitlement + server-side resolution + tests; P4.9B primary-admin settings UI. Depends on P4.8.
- **P4.10 (new, 4–6 days):** P4.10A context core (patients, no UI); P4.10B all entity types + context UX. Depends on P4.6C/P4.6B; ordered after P4.9.
- **P4.11 (new, 8–12 days):** P4.11A workflow engine + run ledger (read-only, no UI); P4.11B action steps + confirmation UX. Depends on P4.10, P4.6A, P4.7A; P3 messaging cores for send steps.

Recommended overall order: **P4.6C (done, Wave 1) → P4.6A → P4.6B → P4.7A → P4.7B → P4.8A → P4.8B → P4.9A → P4.9B → P4.10A → P4.10B → P4.11A → P4.11B**, with P4.7 parallelizable with P4.6B as already planned.

## 5. Tool inventory by domain and role (target state)

Legend: A=admin, M=manager, R=receptionist, D=doctor. Financial = `ai.financial_insights` + per-user permission (A implicit; M opt-in; R/D never).

| Domain | Tool | Roles | Phase |
|---|---|---|---|
| patients | `search_authorized_patients` (ranked, fuzzy, ar/en) | A M R D | shipped + P4.6C |
| patients | `get_patient_summary`, `search_patient_visits` | D | shipped |
| patients | `get_patient_stats(group_by)` (aggregates, small-cell suppression) | A M | P4.6A |
| patients | `count_new_patients(date_range)` | A M R | P4.6A |
| appointments | `check_availability` | A M R D | shipped |
| appointments | `list_doctor_appointments` | D | shipped |
| appointments | `list_appointments(date_range, status?, doctor_id?, department_id?)` (row-capped, field allow-list) | A M R | P4.6A |
| appointments | `get_appointment_stats(date_range, group_by)` (statuses, no-show/cancellation rates, doctor utilization) | A M | P4.6A |
| clinic/departments/staff | `get_clinic_summary` (department count, staff counts, patient/appointment counts, trends) | A M | P4.6A |
| follow-ups | `list_pending_followups(date_range?, outcome?)` | A M R | P4.6A |
| revenue/invoices | `get_revenue_summary`, `compare_revenue_periods(a, b)` | A, M(perm) | P4.6A |
| invoices | `list_outstanding_invoices(limit)` (name + amount + age only) | A, M(perm) | P4.6A |
| reports | `run_clinic_report(report, range, filters)` over `lib/reports/data.ts` cores | per-report role/permission | P4.6A |
| help | `search_help(query, locale)` | A M R D | P4.7A |
| navigation | `get_navigation_target(feature)` (permission-honest) | A M R D | P4.7A |
| meta | `list_my_capabilities()` | A M R D | P4.7B |

Aggregate questions like "how many departments does the clinic have?" resolve through `get_clinic_summary` → a purpose-built `SECURITY DEFINER` clinic-scoped RPC that re-resolves `auth_clinic_id()` and returns **aggregates only** — never raw rows through a generic query path. Text-to-SQL remains permanently rejected (roadmap 2026-07-19 decision).

## 6. Search / entity-resolution design (P4.6C — Wave 1 implemented)

**Principle:** matching and ranking are deterministic and database-native. The model receives ranked candidates plus server-computed confidence and behavioral guidance; it never fuzzy-matches names itself.

Implemented in migration `supabase/migrations/20260720120000_p46c_entity_search.sql` + `lib/ai/entity-search.ts`:

1. **`normalize_search_text(text)`** (immutable SQL): lowercase; strip Arabic diacritics/tatweel; fold أ/إ/آ/ٱ→ا, ة→ه, ى→ي, ؤ→و, ئ→ي; Arabic-Indic digits→Latin; punctuation→space; collapse whitespace. **`normalize_phone(text)`**: digits only, Arabic-Indic mapped.
2. **Generated columns** `patients.search_name` / `patients.search_phone` (STORED) + partial GIN `gin_trgm_ops` index on `search_name` and btree on `search_phone` (`WHERE NOT is_deleted`).
3. **`search_patients_ranked(p_query, p_query_alt, p_limit)`** — `SECURITY INVOKER` (RLS decides visibility: clinic isolation, doctor scoping, soft-delete), `STABLE`, capped at 20 rows. Score = `GREATEST(similarity, word_similarity)` over the normalized query **and** the transliterated variant; exact file-number, phone-suffix (≥7 digits, last-8 match), and exact normalized-name matches score 1.0; name-prefix matches floor at 0.75; fuzzy floor 0.18. Returns `(id, full_name, file_number, phone, email, score, match_kind)`.
4. **Transliteration** (`transliterateQuery`): deterministic, curated ~60-name ar↔en token map (Mohamed/Muhammad/Mohammad→محمد, Hassan/Hasan→حسن, …) with a digraph-first character-map fallback for unmapped tokens. The variant is passed as `p_query_alt`, so "Mohamed Hassan" retrieves «محمد حسن» and vice versa.
5. **Confidence contract** (`classifyConfidence`): `high` = top ≥ 0.65 **and** lead over runner-up ≥ 0.2 (namesakes therefore always clarify); `medium` ≥ 0.35; else `low`. The tool returns `{ confidence, guidance, patients[] }`; guidance instructs the model to proceed only on `high`, otherwise to present candidates and ask the user — never silently pick.
6. **Extension pattern:** staff (`profiles.full_name`), departments, and services get the same generated-column + ranked-RPC treatment in P4.6A when their tools land; the normalization functions are shared. Embeddings are deliberately not used — normalized trigram search covers name resolution at zero marginal cost.

## 7. Authorization & privacy design

Unchanged spine, extended not weakened:

- Resolution chain per request (P4.5): subscription → plan features/overrides → provider mode → page visibility → role tool allow-list → per-tool assert (`assertStaffToolAccess` / `assertDoctorToolAccess` / new `assertFinancialInsightsAccess`) → RLS or clinic-scoped `SECURITY DEFINER` aggregate RPC → budget. The model never decides authorization; unauthorized tools are **not mounted** (deny-by-default registration).
- **Admin stays non-clinical** (shipped §6.8 matrix untouched): aggregates only, with small-cell suppression (buckets < 5 report "<5") so aggregates cannot be reversed into individuals.
- Financial tools: entitlement **and** per-user permission (manager default OFF) enforced at the application layer because RLS already allows manager/receptionist financial reads (roadmap §P4.6 security note).
- Page context (P4.8) and launcher placement (P4.9) are **advisory UI concerns**: context is validated then injected as prompt context; it never selects tools, roles, or scopes. A visible launcher grants nothing; a hidden launcher removes nothing.

## 8. Contextual assistant launcher architecture (P4.8)

- **`AssistantPageContext`** — a zod discriminated union, one variant per area: `{ type: "patient", patientId }`, `{ type: "appointments", dateRange, status?, doctorId? }`, `{ type: "revenue", dateRange }`, `{ type: "reports", report: ClinicReportId, range }`, `{ type: "invoices", filter }`, `{ type: "staff" }`, `{ type: "departments" }`, `{ type: "dashboard" }`, `{ type: "doctor-schedule" }`. Revenue is deliberately date-only because the financial AI tools cannot apply visible page filters. Doctor schedule identifies only the recurring working-hours host and carries no doctor identity or fabricated appointment range. Validated server-side in `app/api/agent/chat/route.ts`; unknown/invalid context is dropped, not errored.
- **`components/assistant/assistant-launcher.tsx`** — one reusable client component (generalizing today's `patient-assistant-launcher.tsx`): renders the Sheet, seeds role-appropriate suggested prompts per area, and posts the typed context with each turn. No assistant logic is duplicated per page.
- **`lib/ai/launchers.ts`** — a declarative launcher registry: `{ area, contextType, roles, requiredFeatures, requiredUserPermission?, defaultEnabled }`. A server resolver (generalizing `resolvePatientAssistantLauncher`) decides visibility per request; pages render the launcher only when the resolver says so. P4.9 settings feed the same resolver.
- Server treats context as **advisory**: it is redacted/minimized, injected into the system prompt ("the user is viewing the appointments list for 2026-07-01…07-07 filtered to no-shows"), and may bias suggested prompts. All data still flows through authorized tools.

## 9. AI Assistant Customization design (P4.9, premium)

- **Entitlement:** `ai.assistant_customization`, `pro_ai`-only (resolves through the standard P4.5 namespaced-feature chain).
- **Schema:** `assistant_launcher_settings (clinic_id, area, role, enabled, updated_by, updated_at, PK (clinic_id, area, role))` and `assistant_launcher_user_overrides (clinic_id, user_id, area, enabled, PK (clinic_id, user_id, area))`. RLS: clinic-scoped reads; writes primary-admin-only (reusing the `lib/primary-admin.ts` + `user_page_permissions` management pattern).
- **Resolution order (server-side, in the launcher resolver):** entitlement gate → code-owned role defaults (doctors: patient/visits/appointments; receptionists: appointments/patient search/follow-ups; admins: dashboard/revenue/reports/staff/departments) → clinic per-role setting → per-user override. Without the entitlement, defaults apply and the settings UI is an upgrade gate.
- **Hard rule:** customization edits **UI visibility only**. It can never mount a tool, widen a role, or bypass §6.8/P4.6 authorization — a launcher toggle for an area the role cannot use is simply not offered.
- **UI:** one settings page (`app/(protected)/settings/assistant/`), matrix of area × role toggles + optional per-user list, following the existing settings CRUD pattern.

## 10. Database changes & migrations

| Migration | Phase | Contents |
|---|---|---|
| `20260720120000_p46c_entity_search.sql` (**shipped with this proposal**) | P4.6C | `normalize_search_text`, `normalize_phone`, `patients.search_name`/`search_phone` generated columns, trgm/btree partial indexes, `search_patients_ranked` (SECURITY INVOKER) |
| P4.6A migration | P4.6A | `SECURITY DEFINER` clinic-scoped aggregate RPCs (clinic summary, patient/appointment stats with small-cell suppression, revenue summary/comparison); per-user financial permission storage; `ai.staff_analytics`/`ai.financial_insights` seeds; staff/department/service search columns + ranked RPCs (same P4.6C pattern) |
| P4.7A | P4.7 | none (corpus is in-repo; navigation registry is code) |
| P4.8 | P4.8 | none (context contract and launcher registry are code) |
| P4.9A | P4.9 | `assistant_launcher_settings`, `assistant_launcher_user_overrides` + RLS + `ai.assistant_customization` seed |
| P4.10A | P4.10 | `agent_conversations.active_context jsonb` (session-scoped; cleared with the conversation; no new table) |
| P4.11A | P4.11 | `ai_workflow_runs` ledger (content-free plan + per-step status + confirmation record, clinic/user-scoped RLS) + `ai.workflows` seed |

## 11. Entitlement keys & plan behavior

All keys resolve true only under `pro_ai` (AI is the exclusive top-tier differentiator; `basic`/`pro` get upgrade gates):

- Existing: `ai_assistant` (legacy umbrella), `ai.staff_assistant`, `ai.staff_analytics`, `ai.financial_insights` (+ per-user permission), `ai.managed`/`ai.byok`/`ai.hybrid_fallback`.
- New: `ai.assistant_customization` (P4.9) and `ai.workflows` (P4.11). Help/navigation (P4.7) and conversational context (P4.10) ride on `ai.staff_assistant` — not separately sellable.

## 12. Cost-control strategy

- **Deterministic DB search** for entity resolution — zero model/embedding cost; embeddings reserved for genuinely semantic retrieval only (none needed in P4.6–P4.9).
- **Typed aggregate RPC tools** answer statistics in one cheap tool call with compact structured outputs (hard row caps, field allow-lists).
- **Task-class routing** on the P4.5 registry: `staff_help` (haiku-tier) for help/navigation; `staff_operational_query` for lists/stats; the sonnet-tier route stays reserved for clinical summarization. Every turn still passes `prepareAiExecution` (budget reservation, caps, immutable ledger).
- **Static help corpus** and capability metadata are cacheable and content-free of tenant data.

## 13. Testing strategy

- **Per-tool authorization suite** (extends `tests/unit/ai/`): every P4.6 matrix cell; financial tools unmountable without entitlement + permission; `pro`/`basic` denial; two-clinic aggregate isolation; small-cell suppression floors.
- **Entity search** (`tests/unit/ai/p46c-entity-search.test.ts`, shipped): normalization parity fixtures (Arabic folding, diacritics, digits), transliteration both directions + fallback, confidence classification (namesakes → clarify), tool contract (ranked output, guidance, audit, RPC error).
- **Integration (local Supabase):** `search_patients_ranked` under doctor RLS scope (`tests/unit/integration/p4a-ai-tools-rls.test.ts`, updated); variant-name fixture ("Muhammad Hassan"/"Mohamed Hasan"/"محمد حسن"/"Mohammad H. Hassan") retrieval; soft-deleted exclusion; cross-clinic denial.
- **P4.7:** navigation-honesty and capability-panel parity tests (panel = actual tool mount). **P4.8/P4.9:** launcher-visibility ≠ authorization tests (hidden launcher, direct API call still authorized independently; visible launcher, unauthorized tool still denied).
- E2E per the existing validation-suite workflow (mocked model; Playwright on PORT=3100).

## 14. Recommended implementation order

1. **P4.6C** — done (this Wave 1): fixes the sharpest daily pain (name search) with no dependency on the registry.
2. **P4.6A → P4.6B** — aggregate/operational/financial tools + registry + UI: unlocks "how many…" questions.
3. **P4.7A → P4.7B** — help corpus, navigation, capability panel (parallelizable with P4.6B).
4. **P4.8A → P4.8B** — contextual launchers.
5. **P4.9A → P4.9B** — premium placement customization.
6. **P4.10A → P4.10B** — conversational entity context (§16).
7. **P4.11A → P4.11B** — multi-step workflow execution (§17).
8. P5 patient AI proceeds unchanged afterward.

## 15. Implement now vs later

- **Now (shipped with this proposal):** this document; the `AI_AGENT_PLAN.md` 2026-07-20 revision; P4.6C Wave 1 for patients (migration + `lib/ai/entity-search.ts` + rewritten `search_authorized_patients` + unit/integration test updates).
- **Later (normal sub-phase branch/PR/review workflow):** P4.6A/B, P4.7, P4.8, P4.9, P4.10, P4.11 as ordered above; staff/department/service ranked search (P4.6A); patient-facing AI (P5).

## 16. Conversational entity context / session memory (P4.10 — founder addition, approved 2026-07-20)

**Goal:** "Open Mohamed Hassan" → "when was his last visit?" → "what medications is he taking?" → "book him for next Thursday" all refer to the same patient, until the user naturally switches ("now show me Sara's file").

- **Storage:** `agent_conversations.active_context jsonb` — at most one active entity per entity type: `{ entity_type, entity_id, display_label, set_at, set_by: 'resolution' | 'user_choice' | 'page_context' }`. **Session-scoped only:** it lives and dies with the conversation — never persistent memory, never cross-conversation, never cross-user, cleared on conversation end, and content-excluded from ledgers/telemetry like all conversation data.
- **Trust boundary (how context is set):** only from (a) a **high-confidence** P4.6C resolution, (b) the user explicitly picking a clarification candidate, or (c) a P4.8 page-context launch. The model may *request* a switch but never *asserts* an entity id from free text — ids are always server-derived, mirroring the existing identity rule.
- **Usage:** injected each turn as advisory prompt context and used as a server-side **default parameter** when an entity-scoped tool is called without an id (e.g. `get_patient_summary` with no `patient_id` → active patient). **Authorization is revalidated on every tool call** — role, entitlement, subscription, page visibility, RLS — so context can never return anything the same user couldn't fetch by naming the entity explicitly; access revoked mid-conversation denies the next turn.
- **Entity coverage:** patients first (P4.10A), then appointments, invoices, staff, departments, reports (P4.10B); extensible through the P4.6A registry's entity metadata. UI shows an active-context chip with a clear (×) affordance.
- **Gating:** rides on `ai.staff_assistant`; no new entitlement. **Out of scope:** persistence of any kind, patient-persona context (P5), write behavior (P4.11).
- **Tests:** pronoun follow-up re-runs full per-tool authorization; no context from `medium`/`low` without user choice; natural switching; mid-conversation revocation; conversation deletion clears context; cross-conversation/two-clinic isolation.

## 17. Multi-step AI workflow execution (P4.11 — founder addition, approved 2026-07-20)

**Goal:** orchestrate multiple authorized tools to complete a higher-level task — "find tomorrow's unconfirmed appointments and send them reminders", "find overdue invoices and send reminder emails", "generate this month's revenue report and summarize it", "find today's cancellations and notify reception" — as **reusable orchestration over the typed registry, never hardcoded flows, never unrestricted database access**.

- **Execution model — plan → preview → confirm → execute:** the model emits a typed workflow plan whose steps reference registry tools only; the plan is validated server-side against the caller's actual resolved tool mount (an unmounted tool fails validation). Read-only plans execute directly. Any plan with an **action step** always runs **dry-run first** — the user sees exactly what would happen ("12 reminders to these patients") and must explicitly confirm; confirmation is per-run, server-side, non-replayable.
- **Human-in-the-loop preserved:** action steps reuse existing cores and their safety semantics — messaging through the §7 send boundary with `message_dispatches` idempotency, bookings as `pending` only. Destructive operations (deletes, status overrides, billing mutations) are **not expressible as steps at all**.
- **Per-step enforcement:** each step re-runs its tool's own authorization and audit exactly as a standalone call; the engine adds a run envelope, never substitutes for per-tool checks. Partial failure is first-class: failed steps halt dependents, completed work is reported honestly, and re-running a confirmed workflow executes only unfinished steps (idempotent via the run ledger + dispatch ledger).
- **Cost-aware:** dedicated task class through `prepareAiExecution`; hard per-run step cap; per-run cost ceiling reserved up front; standard concurrency/rate limits; honest mid-run degradation on budget exhaustion.
- **Persistence:** `ai_workflow_runs` (clinic/user-scoped RLS): plan with redacted param summaries (content-free like `ai_usage_events`), per-step status/timing, dry-run snapshot hash, confirmation actor/timestamp, terminal state — the audit answer to "what did the assistant do and who approved it".
- **Gating:** new `ai.workflows` entitlement (`pro_ai`-only); action-step categories additionally honor their own feature entitlements. **Out of scope:** unattended/scheduled workflows, patient-facing workflows, clinic-authored custom steps.
- **Tests:** unmounted-tool plan denial; unconfirmed action plans never execute; dry-run → confirm → execute with full per-step audit; partial-failure honesty + idempotent re-run; budget-cap degradation; entitlement/plan denial; two-clinic run isolation.
