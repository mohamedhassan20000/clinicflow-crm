# ClinicFlow — Staff/User AI Assistant: Open-Source Agent Framework Architecture Study

Study date: 2026-08-24
Branch: `feat/p7-manual-qa-polish`
Scope: **architecture study only.** No production code, prompt, tool, test, dependency, or
migration was modified. Nothing was installed, deployed, or reconfigured. The only
repository change is this file.

Subject: the **internal Staff/User Assistant** used by admins, managers, receptionists,
doctors, and assistants. The Patient/WhatsApp booking assistant appears only where a
comparison requires it; it is explicitly out of scope for redesign, per
`docs/reviews/AI_ASSISTANT_LANGGRAPH_ARCHITECTURE_STUDY.md` (2026-08-22), whose conclusion
this study does not re-litigate.

---

## 0. Executive answer

**Do not adopt an agent/orchestration framework for the Staff Assistant. Improve the
architecture that already exists.**

The reason is specific and measurable, not stylistic. Every headline capability the
candidate frameworks sell — a declarative tool registry, deny-by-default authorization,
two-phase preview→confirm human-in-the-loop, durable per-conversation entity state,
per-invocation audit, budget metering, prompt-injection neutralisation, multi-step tool
loops, cheap-route intent classification, and permission-filtered capability discovery —
**is already implemented in ClinicFlow, in TypeScript, underneath a security boundary that
no framework in this comparison is designed to preserve.**

Measured against the current code:

| Framework selling point | ClinicFlow's existing equivalent | Location |
|---|---|---|
| Declarative tool registry | `AI_TOOL_REGISTRY` — 22 tools, deny-by-default on role × plan feature × per-user permission × task class | `lib/ai/tools/registry.ts` |
| Dynamic / deferred tool discovery | 89 actions + 13 resources are **not** in the static schema; discovered via `describe_action` / `describe_capabilities` | `lib/ai/tools/describe-*.ts` |
| Human-in-the-loop / approvals | HMAC-signed, single-use, input-digest-bound confirm token, withheld from model context, redeemed only by an authenticated Server Action | `lib/ai/actions/confirm.ts`, `lib/ai/tools/execute-action.ts` |
| Durable state / checkpoints | `agent_conversations.active_context` — 6 server-derived entity slots + pending confirmations, RLS-scoped | `lib/ai/conversation-context.ts` |
| Multi-step tool loop | AI SDK v6 `ToolLoopAgent`, `stopWhen: stepCountIs(20/25)` | `lib/ai/staff-agent.ts`, `lib/ai/platform/registry.ts` |
| Routing / model tiering | Deterministic intent router selecting a *certified policy*, never an authorization | `lib/ai/platform/execution.ts` |
| Guardrails | `sanitizeUntrustedDeep` + `withProvenance` at the mount boundary; 136-case injection corpus | `lib/ai/tools/index.ts`, `lib/ai/eval/injection-corpus.ts` |
| Observability | `logAgentTool` → redacted `audit_logs` per invocation, + `ai_budget_*` ledger, + Sentry | `lib/ai/audit.ts`, `lib/ai/platform/execution.ts` |
| Evals | 100-case bilingual rubric corpus, offline consistency-graded in CI, live-graded opt-in | `lib/ai/eval/*` |

What ClinicFlow is genuinely missing is **five small, nameable primitives** — none of which
is a framework, and four of which are ~50–250 lines each. They are listed in §12 and
summarised here:

1. **Cross-turn tool memory.** `modelSafeHistory` strips every non-text part before the
   model sees history (`lib/ai/conversation-parts.ts:20-25`). A multi-step task spanning
   two turns loses every tool result from turn 1.
2. **Tool-call repair on the staff side.** The patient agent has
   `experimental_repairToolCall`; the staff agent does not (`lib/ai/staff-agent.ts` vs
   `lib/ai/patient-agent.ts:107`).
3. **An explicit plan artifact** for composite turns, so the user sees intent before writes.
4. **Step-level tracing** (`experimental_telemetry`) — currently zero OTel instrumentation.
5. **A scored staff eval gate in CI** — the corpus exists; CI grades rubric *consistency*,
   not answers.

**Verdict: IMPROVE CURRENT (Option B), with one narrow, deferred hybrid seam.**
**Expected real-world improvement from the recommended work: MODERATE.**
**Expected real-world improvement from adopting any framework in this comparison: LOW —
and negative on security surface and migration risk.**

The blunt version: **this is an intelligence and context problem being considered as an
orchestration problem.** Orchestration frameworks do not make a model choose the right
tool. Better tool descriptions, cross-turn tool memory, an explicit plan step, and a scored
eval loop do. §14 separates these precisely.

---

## 1. What was actually inspected

Verified against current code on `feat/p7-manual-qa-polish`, not against prior reports.

**Orchestration & runtime**
`lib/ai/staff-agent.ts` (93 LOC), `app/api/agent/chat/route.ts` (371), `lib/ai/client.ts`,
`lib/ai/platform/execution.ts` (819), `lib/ai/platform/registry.ts` (268),
`lib/ai/platform/types.ts`, `tenant-provider.ts`, `managed-gateway.ts`,
`provider-connections.ts`, `cost.ts`, `credential-crypto.ts`,
`app/api/agent/launcher-session/route.ts`.

**Tools & capability surface**
`lib/ai/tools/registry.ts` (524), `lib/ai/tools/index.ts` (the mount resolver + hardening
wrapper), and all 22 tool modules under `lib/ai/tools/`.

**Actions (writes)**
`lib/ai/actions/registry.ts`, `types.ts` (421), `execute.ts` (817), `confirm.ts` (298),
`canonical.ts`, `errors.ts`, `resolver-context.ts`, `privileged-notifications.ts`, and all
nine definition modules (`appointments`, `billing`, `clinical`, `documents`, `followups`,
`patients`, `privileged`, `settings`, `legacy-actions`).

**Resources (reads)**
`lib/ai/resources/registry.ts`, `types.ts`, `compile.ts`, `fields.ts`, `filters.ts`,
`export-hatch.ts`, `context-proposal.ts`, `clinic-dates.ts`, and all 13 resource
definitions.

**Authorization / RBAC / entitlement**
`lib/ai/authorization.ts`, `lib/ai/permissions.ts`, `lib/ai/permission-keys.ts`,
`lib/ai/commercial.ts`, `lib/ai/commercial-policy.ts`, `lib/entitlements`,
`actions/ai-permissions.ts`, `actions/page-permissions.ts`, `actions/report-permissions.ts`,
plus the RLS integration suites (`tests/unit/integration/p4a-ai-tools-rls.test.ts`,
`p46-ai-permissions-rls.test.ts`, `phase5-domain-write-rls.test.ts`).

**Conversation / context / memory**
`lib/ai/conversation-context.ts` (358), `conversations.ts`, `conversation-parts.ts`,
`page-context.ts`, `page-context-seed.ts`, `entity-resolution.ts`, `entity-search.ts`,
`persistence-readiness.ts`, `retention.ts`.

**Safety**
`lib/ai/untrusted-text.ts`, `guardrails.ts`, `redact.ts`, `audit.ts`, `errors.ts`,
`usage.ts`, `surface.ts`.

**Documents / analytics / help**
`lib/ai/documents/capability.ts`, `lib/ai/clinic-reports.ts`, `lib/ai/help/{corpus,
navigation,search}.ts`, `lib/ai/tool-presentation.ts`, `lib/ai/capabilities.ts`.

**UI**
`components/assistant/assistant-chat.tsx` (1518), `assistant-launcher.tsx`,
`capability-panel.tsx`, `conversation-history-panel.tsx`, `assistant-access-gate.tsx`,
`app/(protected)/assistant/page.tsx`, `actions/assistant-conversations.ts`.

**Tests / evals**
`lib/ai/eval/{eval-set,grade,authorized-tools,injection-corpus,index}.ts`; 114 AI-related
test files, of which 58 in `tests/unit/ai/` touch the staff surface; `tests/e2e/p4b-assistant.spec.ts`.

**Docs**
`docs/AI_ASSISTANT_FULL_CAPABILITY_PLAN.md`, `docs/AI_AGENT_PLAN.md`,
`docs/AI_ASSISTANT_RAG_AUDIT_AND_PLAN.md`,
`docs/reviews/AI_ASSISTANT_LANGGRAPH_ARCHITECTURE_STUDY.md`,
`docs/reviews/AI_ASSISTANT_TYPED_BOOKING_STATE_IMPLEMENTATION.md`,
`docs/reports/AI_ASSISTANT_ACTION_ROUTING_{FIX,REVIEW}.md`,
`docs/reports/AI_ASSISTANT_PHASE_{0,0B,1,2,3,4,5,5F,6,7}_*.md`,
`docs/reports/AI_ASSISTANT_FINAL_COMPREHENSIVE_REVIEW.md`,
`docs/reports/OPERATING_ASSISTANT_EXPANSION_PROPOSAL.md`,
`docs/reviews/ROLES_REPORTS_ASSISTANT_EXTENSION_FINAL_REVIEW.md`.

**Total AI subsystem size:** 36,132 LOC across ~160 files in `lib/ai/` + `app/api/agent/`.

### 1.1 Measurement method

Quantities in §2 were produced by executing the real registries and prompt builders through
the project's own Vitest resolver (a throwaway spec, run and deleted; `git status` confirms
no test file was added or left behind). They are measured, not estimated. Token figures use
a 3.6 chars/token approximation and are labelled `~`.

---

## 2. The current architecture, measured

### 2.1 Request path — four layers, one model loop

```
Staff user (assistant page or contextual launcher)
 └─ POST /api/agent/chat                        app/api/agent/chat/route.ts
     ├─ authorizeStaffAssistant()               role + subscription + entitlement + page visibility
     ├─ checkRateLimit  30/60s per clinic       fail-open
     ├─ zod request parse, 4 000-char cap
     ├─ ensureDoctorConversation()              pure read; RLS-scoped history (40 turns)
     ├─ staffTaskForRole(role, {...})           DETERMINISTIC router → task class  ← no LLM
     ├─ prepareAiExecution()                    certified model route, ZDR policy,
     │                                          worst-case budget reservation
     ├─ resolvePageContextSeed()                server re-reads every seeded entity via RLS
     └─ createStaffAgent()                      lib/ai/staff-agent.ts
         └─ ToolLoopAgent (ai@6.0.230)
             ├─ instructions = persona + product-knowledge + action-safety + suppression
             │                 + page-context line + active-context line
             ├─ tools = resolveToolMount(...)   deny-by-default, per-caller
             ├─ stopWhen = stepCountIs(4 | 8 | 20 | 25)
             ├─ prepareStep → beginStep() + assertAiInputWithinPolicy()
             └─ onStepFinish → execution.observeStep()   per-step usage metering
     └─ toUIMessageStreamResponse → onFinish → finalizeExecution() + persistDoctorTurn()
```

Layer ownership:

- **L1 Transport/turn** (`route.ts`) — auth, rate limit, routing, budget, persistence,
  error classification. Fully deterministic. No LLM decides anything here.
- **L2 Model loop** (`staff-agent.ts`) — one `ToolLoopAgent`, one flat tool set, one prompt.
  **This is the only layer any framework in this study would replace.** It is 93 lines.
- **L3 Tools** (22) — each re-asserts role, entitlement, subscription, page visibility, and
  per-user permission inside `execute`, then delegates to L4.
- **L4 Domain/RPC/DB** — actions, resources, RLS, `protect_*` triggers, `audit_logs`.

### 2.2 Capability surface — measured

| Quantity | Value |
|---|---|
| Registered model-facing tools (`AI_TOOL_REGISTRY`) | **22** |
| Registered write actions (`AI_ACTION_REGISTRY`) | **89** |
| Registered read resources (`RESOURCE_REGISTRY`) | **13** |
| Registered resource fields | **151** |
| Registered resource filters | **95** |
| Action risk mix | 49 normal · 15 destructive · 13 sensitive · 9 privileged · 3 bulk |

**Tool exposure per role** (registry-declared maximum, before entitlement/permission gates):

| Role | Tools | Actions |
|---|---|---|
| admin | 22 | 88 |
| manager | 22 | 60 |
| receptionist | 16 | 41 |
| doctor | 13 | 21 |
| assistant | 13 | 22 |

### 2.3 Prompt and schema budget — measured

| Component | Chars | ~Tokens |
|---|---|---|
| System prompt, admin/EN | 5,179 | ~1,439 |
| System prompt, admin/AR | 4,013 | ~1,115 |
| System prompt, doctor/EN | 5,109 | ~1,419 |
| **Tool descriptions + JSON schemas, admin/EN (22 tools)** | **25,467** | **~7,074** |
| **Static per-step context floor (admin/EN)** | **~30,650** | **~8,510** |

Per-tool breakdown (admin/EN, description + JSON Schema, chars):

```
query_resource       2425   get_patient_stats    2127   aggregate_resource   1963
run_clinic_report    1640   list_outstanding_inv 1662   preview_document     1548
get_navigation_targ  1267   search_help          1139   get_appointment_stats 1138
list_pending_followu 1078   get_record           1059   get_clinic_summary   1000
compare_revenue_per   971   get_revenue_summary   875   search_authorized_pat 843
check_availability    829   execute_action        786   count_new_patients    745
list_my_capabilities  744   describe_documents    668   describe_capabilities 531
describe_action       429
```

**This is the single most important number in the study.** Against a policy ceiling of
192,000 input tokens/step for the administrative and composite classes, the static surface
is ~8.5k — **4.4% of budget.** The prompt is *not* overloaded, and it is not on a path to
becoming overloaded, because of §2.4.

### 2.4 Why the surface does not grow with capability — the deferred-disclosure design

The 89 actions, 13 resources, 151 fields, and 95 filters are **not** in the static tool
schema. They are reached through four generic carriers:

- `query_resource` / `get_record` / `aggregate_resource` — one schema fronting 13 resources.
  Only the 13 resource *ids* are inlined in the description (`lib/ai/tools/query-resource.ts:14`);
  fields, filters, operators, relations, sorts, and caps are fetched on demand by
  `describe_capabilities`, **permission-filtered to the exact caller**.
- `execute_action` / `describe_action` — one schema fronting all 89 actions.
  `describe_action` returns only the actions *this user* is authorized and entitled to
  preview (`lib/ai/actions/execute.ts::describeAuthorizedActions`).

This is precisely the "dynamic tool selection" that LangGraph, Deep Agents, and the OpenAI
Agents SDK offer as a scaling feature — **already built, and built better for this domain**,
because ClinicFlow's discovery endpoint is authorization-aware. A framework's dynamic tool
loader filters by semantic relevance; ClinicFlow's filters by *what the caller may legally
do*, which is the filter that matters in a clinical multi-tenant product.

Consequence for the question "does tool routing become unreliable as capabilities grow?":
**adding the 90th action changes the model's static context by zero bytes.** Growth pressure
lands on `describe_action`'s *result* size, not the tool schema — and that result is already
role-scoped (a receptionist sees 41 actions, a doctor 21).

### 2.5 Routing — deterministic, and it selects budget, never authority

`lib/ai/platform/execution.ts` implements a keyword/regex router with four signals:

1. `isOperationalQueryIntent` — aggregation/list/financial vocabulary, EN + AR.
2. `isHelpIntent` — instructional mood, with an aggregation-lead override (guard 2).
3. `isActionableWriteRequest` — **conjunctive**: a write verb *and* a concrete operand
   (clock time, date, weekday, file number, proper name, or a pronoun resolving against a
   live active-context slot). This is guard 3, added after the action-routing regression.
4. `WORKFLOW_INTENT_RE` — composite/multi-step phrasing → `staff_composite`.

Arabic is handled with bounded stem lookarounds (`arabicStems`) so `عدل` cannot fire inside
`معدل`. The router is unit-pinned in `tests/unit/ai/action-routing.test.ts` and
`action-routing-authorization.test.ts`.

**Critically:** the router picks a `CertifiedTaskPolicy`. It never picks tools.
`resolveToolMount` deliberately does *not* narrow by task class except for the single
`staff_help` containment route (`lib/ai/tools/index.ts:85-97`, with an explicit
"do not tighten this" note and a pinning invariant). So a routing miss costs money, never
capability — with the one exception of `staff_help`, which is why guard 3 exists.

Task policies:

| Class | Model | maxSteps | maxOutputTokens | maxInput/step |
|---|---|---|---|---|
| `staff_clinical_summary` | Sonnet 4.5 | 8 | 1,500 | 48,000 |
| `staff_administrative` | Sonnet 4.5 | 20 | 1,500 | 192,000 |
| `staff_operational_query` | Sonnet 4.5 | 20 | 1,200 | 192,000 |
| `staff_composite` | Sonnet 4.5 | 25 | 1,500 | 192,000 |
| `staff_help` | Haiku 4.5 | 4 | 700 | 12,000 |

### 2.6 Human-in-the-loop — already stronger than every framework surveyed

`execute_action` **cannot write.** It runs `previewRegisteredAction` only. The mechanism:

1. Preview validates authorization + input, runs the action's dry-run, mints an HMAC-SHA256
   confirm token bound to `{actionId, inputDigest, userId, clinicId, conversationId, nonce, exp}`
   with a 10-minute TTL (2 minutes for `privileged`).
2. `toModelOutput` **strips the token** from the model's projection
   (`lib/ai/tools/execute-action.ts:56-60`). The model literally cannot see it, so it cannot
   self-confirm in a later step. The UI receives the full output.
3. The user presses a button. `confirmAssistantAction` (an authenticated Server Action)
   redeems the token via `claimAiActionConfirmation` — single-use, replay-detected,
   expiry-checked, input-digest-compared.
4. **Authorization is re-asserted from scratch at confirm time** (`assertActionAccess`), so a
   permission revoked between preview and confirm blocks the write.
5. Privileged actions add a step-up (`verifyAiActionStepUp`) and a before/after digest binding.
6. `ai_action_receipts` + redacted `audit_logs` (`actor_type='ai'`) record the outcome.
7. Pending confirmations are persisted into `active_context.pending_confirmations`, so a
   page refresh does not lose the card.

Compare: LangGraph's `interrupt()`, LangChain's `humanInTheLoopMiddleware`, and AI SDK
`WorkflowAgent`'s `needsApproval` all pause the *graph* and resume it with the human's
answer. **None of them binds the approval to a signed digest of the exact validated input,
withholds the resume handle from model context, or re-authorizes at resume.** Adopting any
of them for confirmations would be a security downgrade. §8 states this as a hard constraint.

### 2.7 Memory / state

Three mechanisms, all server-owned:

- **`active_context`** — one optional slot per entity type across
  `patient | appointment | invoice | staff | department | report`, each carrying
  `entity_id`, `display_label`, `set_at`, `set_by ∈ {resolution, user_choice, page_context}`.
  Persisted on `agent_conversations` (RLS-scoped to the owner + clinic). **Ids are always
  server-derived**; a model-asserted id can never enter a slot. Slots are **advisory** —
  every tool re-authorizes on every call. `display_label` is deliberately never sent to the
  model; only `entity_type` + `entity_id` reach the prompt.
- **Conversation history** — 40 turns, RLS-scoped.
- **Persisted assistant parts** — `boundedAssistantParts` stores sanitized tool parts (with a
  byte cap) so the *UI* can re-render what the assistant did after a refresh.

### 2.8 Observability & evaluation, as they stand

- Per-invocation audit: `logAgentTool` → `toolAuditSummary` redaction → `audit_logs`. The
  mount wrapper (`harden`) additionally audits every denial, clarification, and error —
  the three classes each tool would otherwise miss.
- Budget ledger: worst-case reservation → per-step `observeStep` → `reconcileAiBudget`,
  with outcome and `errorClass` (`recovered_tool_error`, `stream_failed`, `client_aborted`,
  `input_limit_reached`).
- Sentry for exceptions, tagged by area.
- **No OpenTelemetry.** `experimental_telemetry` is not set anywhere; there is no span tree
  showing prompt → step → tool args → result → next step.
- Evals: `lib/ai/eval/eval-set.ts` holds ~100 bilingual cases (≈50 staff, ≈50 patient) with
  machine-checkable rubrics (`expectTools`, `forbidTools`, `expectRefusal`, `expectClarify`,
  `mustCite`). **CI grades rubric *consistency* against the authorization oracle** — i.e.
  "is every expected tool reachable for this persona?" — not answer quality. Live grading
  exists but is opt-in behind `AI_EVAL_LIVE=1`. The 136-case injection corpus does run.

---

## 3. The current assistant's real limitations

These are the defects found by reading current code. They are the honest input to the
framework question, and each is annotated with whether a framework would fix it.

### L1 — Cross-turn tool amnesia *(real, high impact, framework does not fix it)*

```ts
// lib/ai/conversation-parts.ts:20-25
export function modelSafeHistory(messages: UIMessage[]): UIMessage[] {
  return messages.map((message) => ({
    ...message,
    parts: message.parts.filter((part) => part.type === "text"),   // ← all tool parts dropped
  }));
}
```

Every prior turn reaches the model as **text only**. Tool calls, tool results, previews, and
confirmation outcomes from earlier turns are invisible to it. The UI keeps them
(`boundedAssistantParts`); the model does not.

Concrete failure: *"Show me today's appointments, identify who hasn't confirmed"* (turn 1),
then *"now prepare follow-ups for those three"* (turn 2). In turn 2 the model has only its
own prose summary of turn 1's rows. If the summary elided a file number, the model must
re-query — or, worse, may reconstruct a patient id from prose. `active_context` carries at
most **one** patient, so a three-patient working set has nowhere to live.

*Would a framework fix this?* No. LangGraph would persist a `messages` channel in a
checkpoint — but the same choice (what goes back into the model) would still be ClinicFlow's
to make, and the reason for the current filter is a real one (unbounded tool payloads and
PHI re-injection). The fix is a **bounded, sanitized, recency-windowed tool-part replay**,
which is ~80 lines here and is not a framework feature.

### L2 — No tool-call repair on the staff side *(real, medium, framework does not fix it)*

`lib/ai/patient-agent.ts:107` mounts `experimental_repairToolCall: createPatientToolCallRepair(...)`.
`lib/ai/staff-agent.ts` mounts nothing. A malformed staff tool call never reaches `execute`,
so it is **not audited** (the `harden` wrapper is downstream of parsing), surfaces as a
`tool-output-error` part, and the model must recover from a raw validator message.

This matters more on the staff side than the patient side, because `query_resource` has the
largest and most easily-mis-emitted schema in the system (1,502 chars of JSON Schema with
nested filter operators).

*Would a framework fix this?* No — the primitive already exists in the AI SDK the project
already depends on. This is one import and one line, plus a staff-shaped repair policy.

### L3 — No plan-before-act artifact *(real, medium, partially framework-shaped)*

`staff_composite` gives 25 steps but no structure. There is no todo list, no plan tool, no
`prepareStep` narrowing (`staff-agent.ts:82-86` returns `{}`). For
*"find tomorrow's schedule gaps and suggest how to fill them"* the model improvises a
sequence, and the user sees tool activity without ever being shown intent.

*Would a framework fix this?* Partially — Deep Agents ships a `write_todos` planning tool and
LangGraph lets you make planning an explicit node. But a planning tool is **a tool**: ~60
lines returning a structured plan that the UI renders. It does not need a graph runtime.

### L4 — Discovery round-trips cost steps *(real, low-medium, framework does not fix it)*

Deferred disclosure (§2.4) trades context for latency. A first-time `query_resource` on an
unfamiliar resource ideally costs `describe_capabilities` → `query_resource` = 2 model steps.
In practice the model often guesses a filter name, gets `AiResourceInputError`, then calls
`describe_capabilities` = 3 steps. There is no per-turn cache of the discovery result
and no `activeTools` pre-narrowing.

*Would a framework fix this?* No. The fix is (a) inlining the top-N filter names for the
2–3 hottest resources into the description, and (b) `prepareStep`-based `activeTools`
narrowing after the intent is known — both AI SDK primitives already available.

### L5 — Observability has no step-level trace *(real, medium, framework partially fixes it)*

`audit_logs` answers *"which tools ran, for whom, with what redacted params, and what
outcome"* — genuinely more than most frameworks give you, and it is RLS-protected and
PHI-redacted. What it does not answer is *"why did the model pick that tool"*: there is no
span tree, no prompt snapshot, no step timing.

*Would a framework fix this?* LangSmith would — **at the cost of shipping PHI-adjacent
prompts and tool results to a third party**, which the ZDR/no-training privacy policy
(`clinical-zdr-no-training-v1`) is built to prevent. The safe fix is
`experimental_telemetry` (already supported by ai@6) into a self-hosted OTel collector.

### L6 — Evaluation does not grade answers in CI *(real, high, framework does not fix it)*

The corpus and grader exist. CI asserts `EVAL_PASS_THRESHOLD` against *rubric consistency*.
So a prompt change that makes the assistant pick the wrong tool 30% more often passes CI.
Given that **prompt and tool-description quality is the dominant lever on assistant
intelligence** (§14), this is the single biggest gap in the whole system.

*Would a framework fix this?* No. LangSmith/Mastra ship eval runners; ClinicFlow has a
grader already (`gradeTurn`, `scoreEvalRun`). What is missing is a nightly job with
credentials and a budget, not a library.

### L7 — No long-running / durable mid-execution work *(real, low relevance today)*

`maxDuration = 60` on the route. A turn is one HTTP request. If the process dies mid-turn,
the turn is lost (the ledger reconciles, the user retries). There is no background execution
and no mid-execution resume.

*Is this a problem?* Today, no. Every staff task in the brief completes in seconds. Writes
are gated behind a human button press, so "long-running" would mean *waiting for a human*
— and **that pause is already durable**, because the confirmation is a signed token in a
database row plus a persisted UI part, not an in-flight process. This is the one area where
a framework (Vercel Workflow DevKit) would add a genuine capability, and §11 defines the
narrow future case where it becomes worth it.

### L8 — Parallel tool execution is available but unexploited *(low)*

The AI SDK executes multiple tool calls in one step concurrently when the model emits them
together. Nothing in ClinicFlow prevents this, and nothing encourages it. For
*"revenue this month vs last month"*, `compare_revenue_periods` already does both in one
call — the domain tools were designed to avoid the need. Remaining upside is small.

### L9 — Router is lexical, not semantic *(low)*

`isActionableWriteRequest` cannot see an intent phrased outside its lexicon. But the blast
radius is capped by design: it selects a budget. The only capability-affecting route is
`staff_help`, which is why guard 3 is conjunctive. Replacing it with an LLM classifier means
a model call to decide how much model call to allow — explicitly rejected in the code
comments, and correctly.

### Non-limitations (verified, do not "fix" these)

- **Prompt size** — ~8.5k tokens of ~192k. Not a problem, and structurally bounded (§2.4).
- **Tool count** — 22 static, deny-by-default, permission-filtered. Well under the range
  where routing accuracy degrades.
- **HITL** — stronger than every framework surveyed (§2.6).
- **Authorization** — four independent layers; a registry mistake is not exploitable.
- **Injection** — sanitized at the mount boundary by construction, 136-case corpus.
- **Multi-turn entity reference** — `active_context` handles the single-entity case well.

---

## 4. Task-by-task: current execution vs. each proposed architecture

For each task: how it runs **today** (traced through real code), and what each candidate
would change. Step counts are model round-trips.

### T1 — "Show me today's appointments, identify patients who haven't confirmed, and prepare follow-ups."

**Today** (admin, `staff_composite`, 25 steps):
1. `query_resource{resource:"appointments", filters:{date:today, status:...}}` — RLS-scoped,
   exact total, truncation notice.
2. Model filters unconfirmed from the returned rows (no extra call).
3. `describe_action` (if the follow-up contract is unfamiliar) → `followups.record` schema.
4. `execute_action{action:"followups.record", input:{...}}` **per patient** → one preview card
   each. Each card is a separate signed token; each needs its own button press.

≈4–7 model steps. Writes: 0 until the user clicks. Bulk >25 is refused by policy.
**Works today.** Weakness: N separate confirmations for N patients — deliberate
(`bulk` risk class caps at 25 with per-item preview), and defensible in a clinical product.

**LangGraph:** a `fetch → classify → propose` graph with an `interrupt()` before writes.
Same tool calls, same step count, plus graph overhead. The `interrupt()` would have to be
adapted back onto the signed-token flow (it cannot replace it — §8), so the graph adds a
node topology and buys nothing the 25-step loop does not already do.

**Deep Agents:** would add a `write_todos` plan — *genuinely useful here*, giving the user
"1. list today 2. find unconfirmed 3. draft follow-ups" before anything runs. That is the
one real win, and it is a ~60-line tool (§12.3).

**Multi-agent supervisor:** supervisor → Appointment Agent → Messaging Agent. Adds **2+ model
calls** for handoffs and forces the appointments data across an agent boundary in text.
Strictly worse.

**Current + L1/L3 fixes:** identical step count, plus a visible plan and a working set that
survives into turn 2. **Best option.**

### T2 — "Find Ahmed Hassan, summarize his recent visits and prescriptions, then prepare a follow-up."

**Today** (doctor, `staff_clinical_summary`, **8 steps**):
1. `search_authorized_patients{query:"Ahmed Hassan"}` — handles partial/misspelled/AR-EN
   transliteration (`name-transliteration.ts`, `entity-resolution.ts`). Single high-confidence
   match → `contextRecorder.propose("patient", id, label, "resolution")` → the slot is set for
   the next turn.
2. `query_resource{resource:"appointments", filters:{patient:<id>}}`
3. `query_resource{resource:"prescriptions", filters:{patient:<id>}}`
4. (optionally `medical_notes`)
5. `execute_action{action:"followups.record"}` → preview card.

5–6 steps against a budget of 8. **Tight.** Add one clarification (two "Ahmed Hassan"s) or one
malformed filter and the turn hits the cap. This is a real, measured risk — and the fix is a
one-line policy change (`staff_clinical_summary.maxSteps: 8 → 12–14`), not a framework.

Note steps 2–4 are **independently parallelisable** and the model may already emit them in
one step. Encouraging that in the prompt is free.

**LangGraph:** identical tool sequence inside nodes. No improvement.
**Multi-agent:** Patient Agent → Clinical Agent → Messaging Agent = 3 handoffs ≈ +3 calls and
a re-resolution risk at each boundary (does the Clinical Agent get the *id*, or the *name*
again?). Every handoff is a place a patient id can be re-guessed. **Actively dangerous.**

### T3 — "Show revenue this month compared with last month and explain the biggest change."

**Today** (admin with `ai.financial_insights`, `staff_operational_query`, 20 steps):
1. `compare_revenue_periods{...}` — **one tool, both periods, server-computed delta.**
2. Optionally `list_outstanding_invoices` or `run_clinic_report{revenue}` for the driver.

**1–2 steps.** The prompt forbids deriving a figure by subtraction, including from a
different tool's earlier total. A manager without the grant gets a truthful
`permission_not_granted` denial with `DENIAL_GUIDANCE` telling the model not to estimate.

**No framework improves a 1-step task.** An Analytics Agent would make it a 3-step task.
This is the clearest case in the study: the win came from **tool design** — folding a
two-period comparison into one server-computed tool — not from orchestration.

### T4 — "Create a patient-history document for X."

**Today** (any staff, `ai.documents` entitled):
1. `search_authorized_patients` → patient id (server-derived).
2. `describe_documents` → catalog entries the caller may issue + required slots.
3. `preview_document` → auto-fills reporting period / active patient / issuing user; reports
   exactly which required inputs remain; turns validation errors into questions; returns
   `status: ready` + an exact `params` object.
4. `execute_action{action:"documents.issue", input:<the exact params returned>}` → preview card.
5. User confirms → document number + download href.

4–5 steps, with a **structured slot-filling loop** the assistant does not have to invent —
`preview_document`'s description even encodes retry semantics
(`transient_failure` → retry once; `unauthorized_scope` → never retry, never disclose which
of four causes applied).

This is a fully-realised "sub-agent with its own state machine", implemented as **two tools
and one action**. Deep Agents' subagent abstraction would wrap this in a second model loop
with its own context window and buy nothing.

### T5 — "Find tomorrow's schedule gaps and suggest how to fill them."

**Today:** `check_availability{date:tomorrow}` (+ optionally `list_pending_followups` /
`query_resource` on follow-ups) → the model proposes. 2–4 steps.

**Weakest case for the current architecture** — it is genuinely open-ended and the model
improvises. A **plan artifact (L3)** helps the user *see and steer* the approach. Nothing
about a graph makes the suggestions better; the reasoning is model quality plus what the
availability tool returns. If the answers are weak, the lever is a richer
`check_availability` result (gap durations, adjacent bookings, waitlist candidates), not an
orchestrator.

### T6 — "Change a setting."

**Today:** `describe_action` → `clinic.update_reminders` (or `clinic.update_profile`,
`clinic_working_hours.upsert`, …) → `execute_action` → preview with before/after diff →
confirm. 2–3 steps. Authorization: role + `ai.write_administration` + page visibility +
per-user permission, re-asserted at confirm.

**Every framework here is strictly worse**, because every one of them would want to own the
approval step, and none reproduces the digest-bound single-use token.

### T7 — "Cancel an appointment."

**Today:** resolve the appointment (`query_resource` / active-context slot) →
`execute_action{appointments.soft_delete | appointments.update_status}` → **destructive**
risk class → preview names the exact record → confirm → `ai_action_receipts` + audit.
Permanent delete is separately registered and separately gated. Bulk destructive is refused
outright by policy.

2–3 steps. Framework value: **zero**. Framework risk: **high** (approval semantics).

### T8 — "Find a patient and perform several related actions."

**Today:** search → `active_context.patient` slot set from a *server-derived* resolution →
subsequent tools inherit the id as a server-side default, and the advisory prompt line
carries `entity_type + entity_id` (never the name). Within one turn: fine. **Across turns:
degraded by L1** — the model remembers *which patient*, but not *what it found*.

This is the task that most justifies the L1 fix, and it is the task that a naive reading
would use to justify LangGraph. But LangGraph's checkpoint would store the same data
ClinicFlow already stores in `active_context`; the delta is only *what is replayed into the
model*, which is a ClinicFlow policy decision either way.

### Scorecard across T1–T8

| Task | Steps today | Works today? | Framework would improve? |
|---|---|---|---|
| T1 today's appts → follow-ups | 4–7 | Yes | No (plan tool helps — not a framework) |
| T2 patient → history → follow-up | 5–6 / **8 budget** | Yes, tight | No (raise maxSteps) |
| T3 revenue comparison | 1–2 | Yes | No |
| T4 patient-history document | 4–5 | Yes | No |
| T5 schedule gaps | 2–4 | Partly | No (richer tool result + plan) |
| T6 change a setting | 2–3 | Yes | No — worse |
| T7 cancel appointment | 2–3 | Yes | No — worse |
| T8 patient + several actions | varies | Within a turn | No (fix L1 in-house) |

**Zero of eight** are improved by adopting a framework. Five are improved by the §12
primitives.

---

## 5. Would specialized agents / a supervisor help?

The proposed decomposition:

```
Supervisor
 ├── Patient/Clinical Agent   ├── Appointment Agent   ├── Analytics Agent
 ├── Documents Agent          ├── Settings/Admin Agent └── Messaging Agent
```

Evaluated honestly against ClinicFlow's measurements, not against generic advice:

| Claim | Verdict | Evidence |
|---|---|---|
| Improves reliability | **No** | Reliability is currently limited by cross-turn context (L1) and eval coverage (L6), neither of which a handoff addresses. Handoffs *add* a failure mode: entity re-resolution at each boundary. |
| Reduces tool confusion | **Marginal, not needed** | 22 static tools; a doctor sees 13. Routing confusion at this size is not the observed defect. |
| Reduces prompt size | **No** | Each sub-agent still needs the persona, the injection clause, the action-safety clause, the suppression clause, and the product-knowledge clause. Six agents ≈ **6× the shared prompt**, and the total across a turn goes *up*. |
| Increases latency | **Yes** | +1 supervisor classification call minimum, +1 per handoff. T2 goes from 5–6 steps to ~9–10. |
| Increases model calls | **Yes, 40–80%** on composite tasks | Direct consequence of the above. |
| Complicates authorization | **Yes, seriously** | Today, authorization is resolved **once per turn** by `resolveToolMount` against the authenticated `AuthedUser`, then re-asserted per tool. Six agents means six mounts, six entitlement reads, six permission-key resolutions — and a real risk that a sub-agent is constructed with a synthesized context rather than the authenticated one. That is the exact failure `ACTION_CAPABLE_ROLES` was introduced to prevent (a hand-maintained role list drifting from the registry, silently removing 21 doctor-authorized and 22 assistant-authorized actions). **A supervisor architecture reintroduces that class of drift six times over.** |
| Unnecessary abstraction | **Yes** | The proposed agents map almost exactly onto the existing **action namespaces** (`appointments.*`, `patients.*`, `billing.*`, `documents.*`, `clinic.*`, `staff.*`). ClinicFlow already has the decomposition — as *data*, in one registry, under one authorization pass. Promoting it to six model loops adds runtime cost without adding structure. |

**Conclusion: multi-agent is rejected for the Staff Assistant.** It is the wrong answer to a
problem ClinicFlow does not have, and it degrades the one property (single-pass, single-user
authorization resolution) that is hardest to get right and easiest to break.

### 5.1 The simpler alternative — is Router → dynamic tools → execution better?

```
User → Router/Planner → dynamically selected ClinicFlow tools → existing execution/auth layer
```

**ClinicFlow is already 80% of this.** The router exists (deterministic, §2.5). Dynamic tool
selection exists (deferred disclosure, §2.4). The execution/auth layer exists.

The missing 20% is the **planner** (L3) and **`activeTools` narrowing** (L4) — both AI SDK
primitives, both in-house, no new dependency. Yes, this outperforms a full multi-agent
graph: fewer model calls, one authorization pass, one prompt, and the plan is visible to the
user instead of hidden in a supervisor's reasoning.

**This is the recommended target architecture (§13).**

---

## 6. Framework-by-framework assessment

### 6.1 LangGraph.js

**Status (verified 2026-08):** production-stable, feature parity with Python for StateGraph,
conditional edges, checkpointing, streaming, and HITL. TS releases lag Python by roughly
4–8 weeks.

**What it would replace:** `lib/ai/staff-agent.ts` (93 lines).

**What it would buy ClinicFlow:**
- Durable checkpoints — *already covered* by `active_context` + persisted parts + the fact
  that a turn is one request.
- `interrupt()` HITL — **weaker** than the signed-token flow; cannot replace it (§8).
- Explicit topology — real, but ClinicFlow's composite tasks are not fixed pipelines; they
  are open-ended requests over 22 tools. Encoding them as a graph means either one giant
  agent node (i.e. today) or hand-authored graphs per task shape (unmaintainable at 89 actions).

**What it would cost:**
- A model-adapter seam. The certified execution layer (`prepareAiExecution` → tenant provider
  → gateway → `observeStep` → `reconcileAiBudget`) is built on AI SDK `LanguageModel`
  interfaces. LangGraph.js wants LangChain model objects. Bridging means either a shim or
  re-implementing per-step budget metering — and **the budget ledger is load-bearing for
  commercial correctness** (worst-case reservation, hybrid BYOK accounting, monthly caps).
- `@langchain/langgraph` + `@langchain/core` + a checkpointer = 3+ new runtime dependencies
  in a clinical product.
- A second state store (checkpoints) alongside the authoritative one (`active_context`),
  with real tenant-isolation questions (§9).

**Verdict: reject for full migration. Not justified for selected workflows either** — see
§11 for the one future case.

### 6.2 LangChain agents (v1 `createAgent` + middleware)

**Status:** v1 shipped; `createAgent` is the canonical TS entry point; middleware hooks
before-model / after-model / around-tool; `humanInTheLoopMiddleware` gates named tools.

**Honest assessment:** this is the *closest conceptual match* to what ClinicFlow already
runs. `createAgent(model, tools, prompt, middleware)` ≈ `ToolLoopAgent` + the `harden`
wrapper + `prepareStep`. ClinicFlow's `harden()` **is** around-tool middleware:
sanitize + provenance + denial-to-result conversion + audit. `prepareStep` **is**
before-model middleware.

So the migration is: replace a working middleware implementation with a generic one, lose
the AI SDK v6 streaming/`toUIMessageStreamResponse` integration that
`components/assistant/assistant-chat.tsx` (1,518 lines) is built on, and gain nothing.

**Verdict: reject.** Lower risk than LangGraph, and even lower reward.

### 6.3 Deep Agents (`deepagents`, JS)

**Status:** LangChain's batteries-included harness; `createDeepAgent` returns a compiled
LangGraph graph; ships planning (`write_todos`), subagents, a virtual filesystem, and
opinionated prompts. Peer-depends on LangChain runtime packages.

**Relevance:** the **planning tool concept is genuinely relevant** (L3). The rest is not:
- Virtual filesystem — ClinicFlow has a real, RLS-protected document platform.
- Subagents — rejected in §5.
- Opinionated prompts — ClinicFlow's prompts are bilingual, clinically-constrained, and
  hard-won; replacing them is a regression.

Adopting Deep Agents means adopting LangGraph transitively, for one idea worth ~60 lines.

**Verdict: reject the framework, adopt the one idea (§12.3).**

### 6.4 Microsoft Agent Framework

**Verified, and this matters:** Microsoft Agent Framework (`microsoft/agent-framework`) —
the Semantic Kernel + AutoGen successor — officially supports **.NET, Python, and Go**.
As of this study there is **no first-class JavaScript/TypeScript support**, no published
roadmap, and no committed timeline; the open discussion asking for it has a maintainer
acknowledgement and no answer. The only JS implementation is an unaffiliated community port.

**Do not confuse this with the Microsoft 365 Agents SDK**, which *does* ship JS/TS
(`@microsoft/agents-*`, Node 20+) — but is a **different product**: a bot/channel framework
for Teams, Copilot, and M365 conversational surfaces. It is not an orchestration framework
for a Next.js clinical CRM, and its value proposition (M365 channel integration) is
irrelevant to ClinicFlow. Likewise Azure AI Agents (`@azure/ai-agents`) is a TS client
library for a hosted Azure service, not a self-hosted orchestrator — and routing clinical
prompts through Azure AI Agents would introduce a new PHI processor.

**Verdict: reject on language support alone.** Adopting it would mean either a polyglot
backend (a second runtime, a second deployment target, a second auth propagation path
across a network boundary — for a product whose entire security model is
"authorization is re-asserted in-process on every tool call") or betting on an unaffiliated
community port. Both are unacceptable for a clinical product.

### 6.5 Other candidates genuinely evaluated

**Mastra** (v1.0, Jan 2026; ~26k stars; Node/Vercel/Cloudflare; **model-agnostic via the
Vercel AI SDK**). The strongest non-LangChain TS option, and the only one whose model layer
would *not* fight `lib/ai/platform/`. Its suspend/resume workflows are real and its eval and
observability tooling is good. But: it wants to own agents, memory, workflows, and storage —
four things ClinicFlow already owns with clinic-scoped RLS. Its memory layer in particular
would become a second store of conversational state outside RLS, which §9 rules out.
**Verdict: reject now; it is the framework to re-evaluate first if the §11 triggers fire.**

**OpenAI Agents SDK (`@openai/agents`).** Production-grade TS, Zod-native, four clean
primitives (Agents, Tools, Handoffs, Guardrails). Its core value is handoffs — rejected in
§5 — and its model story is OpenAI-centric, while ClinicFlow is certified on Anthropic
routes with ZDR guarantees. **Reject.**

**Vercel Workflow DevKit + AI SDK `WorkflowAgent`** (`@ai-sdk/workflow` + `workflow`).
`WorkflowAgent` is *the same agent loop as `ToolLoopAgent`* plus durable state, `'use step'`
tool durability, `needsApproval` HITL, and per-tool-call workflow steps for observability.
**This is the most architecturally compatible option in the entire study**, because it is the
same vendor and the same `ai` package ClinicFlow already runs — the migration would be
`ToolLoopAgent` → `WorkflowAgent`, not a rewrite. Two caveats: it requires the Vercel
Workflow runtime (cannot self-host), and its `needsApproval` must **not** replace the signed
confirm token (§8). **Verdict: not now — ClinicFlow has no durable-execution requirement
today (L7) — but this is the designated hybrid seam if one appears (§11).**

**AI SDK v6 itself.** Already the dependency. `stopWhen`, `prepareStep`, `activeTools`,
`toolChoice`, `experimental_repairToolCall`, `experimental_telemetry`, `onStepFinish` —
**four of these are unused by the staff agent and three of them are exactly the missing
primitives.** The cheapest capability in this entire study is using more of what is
installed.

---

## 7. Decision matrix

Scores 1–5; 5 = best for ClinicFlow specifically. "Current+" = the improved current
architecture recommended in §12/§13.

| Criterion | **Current+** | LangGraph.js | LangChain v1 | Deep Agents | MS Agent Fw | Mastra | Vercel WDK / WorkflowAgent |
|---|---|---|---|---|---|---|---|
| Fit with ClinicFlow | **5** | 2 | 2 | 2 | 1 | 3 | 4 |
| TypeScript / Next.js integration | **5** | 3 | 3 | 3 | **1** (no official TS) | 4 | **5** |
| Tool routing | **4** | 3 | 3 | 3 | 2 | 3 | 4 |
| Multi-step reasoning | **4** | 4 | 3 | 4 | 3 | 4 | 4 |
| Durable workflows | 3 | 4 | 2 | 4 | 3 | 4 | **5** |
| Human-in-the-loop | **5** | 3 | 3 | 3 | 2 | 3 | 3 |
| Memory / state | 4 | 4 | 3 | 4 | 3 | 4 | 4 |
| Observability | 3 | 4 (LangSmith = PHI risk) | 3 | 4 | 3 | 4 | 4 |
| Security compatibility | **5** | 2 | 3 | 2 | 1 | 2 | 4 |
| RLS compatibility | **5** | 2 | 3 | 2 | 1 | 2 | 4 |
| Existing tool reuse | **5** | 3 | 4 | 3 | 1 | 3 | **5** |
| Migration complexity (5 = easiest) | **5** | 2 | 3 | 2 | 1 | 2 | 4 |
| Runtime complexity (5 = simplest) | **5** | 2 | 3 | 2 | 1 | 2 | 3 |
| Vendor / framework coupling (5 = least) | **5** | 2 | 2 | 2 | 2 | 2 | 2 |
| Performance / latency | **5** | 3 | 4 | 3 | 3 | 4 | 4 |
| Token efficiency | **5** | 3 | 4 | 3 | 3 | 4 | 4 |
| Testing complexity (5 = easiest) | **4** | 3 | 3 | 2 | 1 | 3 | 3 |
| Long-term maintainability | **4** | 3 | 3 | 3 | 2 | 3 | 4 |
| **Total (/90)** | **81** | 52 | 55 | 51 | 34 | 56 | **68** |

Reading the matrix honestly: **Current+ wins decisively**, and the runner-up is not a
LangChain-family framework — it is **Vercel Workflow DevKit**, precisely because it is the
least intrusive: same vendor, same `ai` package, same tool objects, same streaming
integration. That ordering is the whole argument for a *deferred hybrid seam* rather than a
migration.

---

## 8. Security constraint compliance

The mandated architecture:

```
Agent/orchestrator → ClinicFlow AI tools → ClinicFlow authorization + domain logic → RLS/RPC/DB
```

This is **exactly** the current shape, and it holds because the orchestrator is 93 lines and
owns nothing. Compliance analysis for any candidate:

| Prohibition | Current | LangGraph / LangChain / Deep Agents / Mastra | Vercel WDK |
|---|---|---|---|
| Never bypass tools to touch the DB | Held — no DB client reaches the model loop; `createClinicScopedAdminClient` has a table allow-list that throws on unclassified tables | Held **only by discipline** — every one of these ships DB/retriever/memory tool packs that make direct DB access one import away | Held (no DB layer of its own) |
| Never treat agent memory as authorization state | Held — `active_context` is advisory; every tool re-authorizes; ids are server-derived only | **At risk** — checkpoint state is the framework's natural place to stash "the user is allowed to X" | Held if state stays advisory |
| Never replace RBAC/RLS | Held | Held (nothing proposes to) | Held |
| Never replace server-side permission checks | Held — `resolveToolMount` + per-tool `execute` re-assertion | Held | Held |
| Never replace destructive-action confirmation | Held — HMAC token withheld from model context | **Violated if `interrupt()` / `humanInTheLoopMiddleware` / `needsApproval` is used for confirmations** | **Violated if `needsApproval` is used for confirmations** |
| Never trust model-selected patient/clinic/user IDs | Held — `AuthedUser` comes from the session; `active_context` ids are server-derived; every tool re-resolves | Held per-tool, but **multi-agent handoffs create new places for an id to be re-asserted in text** | Held |

### 8.1 Would framework-managed state create tenant-isolation risk? **Yes.**

Concretely, for any framework with its own checkpointer:

1. **Checkpoints live outside RLS.** `active_context` is a column on `agent_conversations`,
   protected by the same RLS policies as every other clinic row. A LangGraph/Mastra
   checkpoint store is a framework-owned table (or Redis) keyed by a thread id. Getting
   clinic isolation right there means **re-implementing tenant isolation in application code**
   — the exact thing RLS exists to make impossible to forget.
2. **Checkpoints capture tool results verbatim.** Today, tool output reaching persistence
   passes `sanitizeUntrustedDeep`, `redactCredentials`, and `boundedAssistantParts`. A
   checkpointer serialises the raw graph state, so **unredacted PHI lands in a second store**
   with its own retention story — against `lib/ai/retention.ts` and the ZDR policy.
3. **Thread-id confusion is a cross-tenant bug class.** If a thread id is ever derived from
   anything less than `(clinicId, userId, conversationId)` validated server-side, resuming
   the wrong checkpoint is a cross-tenant read. ClinicFlow's equivalent risk does not exist,
   because resumption reads a row the caller's RLS client can already see.
4. **Two sources of truth diverge.** `active_context` says patient A; the checkpoint says
   patient B. Which wins? Any answer other than "the RLS-protected row" is a security bug.

**Conclusion: existing ClinicFlow state must remain the sole source of truth. Framework
checkpoints must never hold authorization-relevant state, and preferably must not exist.**
If a framework is ever adopted, its state must be a *derived cache* of ClinicFlow state,
reconstructible and discardable — which removes most of the reason to adopt it.

---

## 9. Quantified migration surface (if a framework were adopted anyway)

For LangGraph.js, the least-bad LangChain-family option:

| Dimension | Estimate |
|---|---|
| New runtime dependencies | 3–5 (`@langchain/langgraph`, `@langchain/core`, `@langchain/anthropic` or a model shim, a checkpointer, `zod` interop) |
| Files rewritten | `lib/ai/staff-agent.ts`, `app/api/agent/chat/route.ts` (streaming contract), `lib/ai/platform/execution.ts` (step metering seam), `lib/ai/tools/index.ts` (mount → graph tool binding) |
| Files re-verified but not rewritten | all 22 tool modules, all 89 action definitions, all 13 resources (~28,000 LOC) |
| UI impact | `components/assistant/assistant-chat.tsx` (1,518 LOC) is built on `useChat` + `toUIMessageStreamResponse` + typed tool parts (`tool-execute_action`). LangGraph streams a different shape. **This is the largest single cost and it is client-side.** |
| Tests affected | 58 staff-touching specs in `tests/unit/ai/`, plus `tests/unit/api/*chat-route*`, `action-routing-route`, `p45a-agent-wiring`, and `tests/e2e/p4b-assistant.spec.ts` |
| New DB objects | ≥1 checkpoint table + RLS policies + retention (§8.1) |
| Migration effort | **6–10 engineer-weeks**, with a certified-execution-layer regression risk that cannot be fully covered by unit tests |
| Capability delivered | **None of T1–T8 improves** |

For **Vercel WorkflowAgent**, by contrast: 1 new dependency pair, `staff-agent.ts` +
route changes, tools annotated `'use step'`, UI streaming contract **preserved** (same `ai`
package). Roughly **1–2 engineer-weeks**. That asymmetry is why WDK is the designated seam
and LangGraph is not.

---

## 10. RECOMMENDATION

**Option B — Improve the current architecture with specific missing primitives**, with a
documented, deferred hybrid seam (Option F) that is *not* opened now.

Rationale in one paragraph: the Staff Assistant's measured constraints are cross-turn tool
memory, an 8-step clinical budget, absent tool-call repair, no plan artifact, no step-level
tracing, and no scored eval gate. Not one of those is a framework's job. Meanwhile the
architecture already provides deny-by-default tool mounting, permission-filtered dynamic
discovery, digest-bound single-use human confirmation, server-derived advisory entity state,
per-invocation redacted audit, per-step budget metering, and injection neutralisation by
construction — a set no surveyed framework matches, and several would weaken.

**If only 10–20% of a framework would help, exactly which 20%?**

| Framework idea | Worth having? | Implement ourselves? | Cost |
|---|---|---|---|
| Planning / todo artifact (Deep Agents) | **Yes** | Yes — one tool + one UI part | ~60 LOC + ~80 LOC UI |
| Durable pause/resume mid-execution (LangGraph, WDK) | Not yet (L7) | N/A — defer to WDK if ever needed | 0 now |
| Step-level tracing (LangSmith) | **Yes** | Yes — `experimental_telemetry` → self-hosted OTel; **never** a third-party PHI sink | ~40 LOC + collector |
| Tool-call repair (framework retry policies) | **Yes** | Already in `ai@6`; already written for patients | ~1 line + ~60 LOC policy |
| Dynamic tool narrowing (`activeTools`) | **Yes** | Already in `ai@6` `prepareStep` | ~40 LOC |
| Scored eval runner (LangSmith / Mastra evals) | **Yes** | Grader already exists (`gradeTurn`) | ~120 LOC + CI job |
| Multi-agent handoffs | **No** | — | — |
| Framework checkpointer | **No — actively harmful** (§8.1) | — | — |

Every "yes" is in-house, and the total is **under 500 lines plus a CI job.**

---

## 11. The deferred hybrid seam — conditions to open it

Do **not** open it now. Open it only when a *durable* requirement actually exists:

- A staff workflow must survive minutes-to-days between steps **while executing** (not
  merely between turns) — e.g. "run this reconciliation across 5,000 invoices and tell me
  when it's done", or "wait for the lab result webhook, then draft the follow-up".
- A turn legitimately exceeds the 60s function budget.
- Scheduled/unattended assistant execution becomes a product requirement (note: the current
  prompt **forbids** unattended execution, deliberately).

When that happens, the seam is **`ToolLoopAgent` → `WorkflowAgent`** (`@ai-sdk/workflow`),
not LangGraph — same vendor, same `ai` package, same tool objects, same UI streaming
contract, ~1–2 weeks. And even then:

- `needsApproval` is used **only** for non-write pauses. The signed-token confirmation flow
  stays exactly as it is for every write. Non-negotiable.
- Workflow state stays a derived cache; `active_context` remains authoritative.
- Patient booking stays entirely outside it (§13.9).

---

## 12. The five primitives to build instead

### 12.1 — Cross-turn tool memory (fixes L1) · **highest value**

Replace the blanket filter in `modelSafeHistory` with a bounded replay: for the **last 2
turns only**, include tool parts that are already sanitized, capped (e.g. 4 KB/part, 12 KB
total), and restricted to a replay allow-list (`query_resource`, `get_record`,
`aggregate_resource`, `search_authorized_patients`, `preview_document`, `describe_action`).
Never replay `execute_action` previews (they carry confirmation semantics and must not look
re-confirmable) and never replay a payload that failed sanitisation.

Files: `lib/ai/conversation-parts.ts`, `app/api/agent/chat/route.ts`. **~80 LOC.**

Security note: this puts *already-persisted, already-sanitized, already-RLS-scoped* data back
into the model's context for the same user. It widens no boundary. Must be pinned by a test
asserting that no `tool-execute_action` part and no unsanitized part can be replayed.

### 12.2 — Staff tool-call repair (fixes L2)

Add `experimental_repairToolCall` to `createStaffAgent` with a staff-shaped policy that
**only ever subtracts**: case-insensitive tool-name match, then drop invalid arguments one at
a time (every generic read answers usefully with fewer arguments), then fall back to
`describe_capabilities` / `describe_action` — never `execute_action`, never an invented id.
Audit every repair.

Files: new `lib/ai/staff-tool-call-repair.ts`, `lib/ai/staff-agent.ts`. **~70 LOC.**

### 12.3 — Plan artifact for composite turns (fixes L3)

A `propose_plan` tool: model-facing, read-only, no clinic data, returns an ordered list of
intended steps that the UI renders above the activity trail. Mount it for
`staff_composite` (and `staff_administrative`). Prompt clause: for a multi-part request,
propose the plan first. Purely advisory — it grants nothing and gates nothing.

Files: `lib/ai/tools/propose-plan.ts`, `registry.ts`, `prompts/staff.ts`,
`components/assistant/assistant-chat.tsx`. **~60 LOC + ~80 LOC UI.**

### 12.4 — Step-level tracing (fixes L5)

Enable `experimental_telemetry` on the staff agent with `recordInputs: false` /
`recordOutputs: false` by default (PHI), emitting span *metadata* — step index, tool name,
duration, token counts, finish reason, denial reason — into a **self-hosted** OTel
collector. Never a third-party trace SaaS.

Files: `lib/ai/staff-agent.ts`, `lib/ai/platform/execution.ts`, instrumentation config.
**~40 LOC + infra.**

### 12.5 — Scored staff eval gate in CI (fixes L6) · **highest leverage on intelligence**

The corpus (~50 staff cases) and the grader (`gradeTurn`, `scoreEvalRun`) exist. Add a
**nightly (not per-PR) live run** on a seeded fixture clinic against the certified route,
publishing tool-selection accuracy, refusal correctness, clarification rate, and citation
compliance, with a regression threshold. Gate prompt and tool-description changes on it.

Files: `lib/ai/eval/*` (runner only), a CI workflow, a seed fixture. **~120 LOC + CI.**

### 12.6 — Two one-line policy fixes (found while measuring)

- `staff_clinical_summary.maxSteps: 8 → 12` (T2 measured at 5–6 steps with no headroom for a
  clarification or a schema miss). `lib/ai/platform/registry.ts`.
- Add an `activeTools` narrowing in `prepareStep` once intent is known — e.g. a turn routed
  operational does not need `preview_document` mounted in the model's face. Optional; measure
  before shipping, since the current permissiveness is deliberate and pinned by a test.

---

## 13. Target architecture (unchanged layers explicitly marked)

```
┌──────────────────────────────────────────────────────────────────────────┐
│ UI — assistant-chat.tsx, launcher, capability panel     ★ UNCHANGED      │
│      (+ two new renderers: plan artifact, replayed tool part)            │
├──────────────────────────────────────────────────────────────────────────┤
│ L1 TRANSPORT/TURN — app/api/agent/chat/route.ts         ★ UNCHANGED      │
│      auth · rate limit · deterministic router · budget · persistence     │
│      (+ bounded tool-part replay in history assembly)                    │
├──────────────────────────────────────────────────────────────────────────┤
│ L2 MODEL LOOP — lib/ai/staff-agent.ts                    ◆ EXTENDED      │
│      ToolLoopAgent (ai@6)  ← stays; NOT replaced by any framework        │
│      + experimental_repairToolCall   + experimental_telemetry            │
│      + optional activeTools narrowing in prepareStep                     │
├──────────────────────────────────────────────────────────────────────────┤
│ L3 TOOLS — 22 registered, deny-by-default               ★ UNCHANGED      │
│      + propose_plan (read-only, advisory)                                │
│      harden(): sanitize · provenance · denial→result · audit  ★ UNCHANGED│
├──────────────────────────────────────────────────────────────────────────┤
│ L4 AUTHORIZATION + DOMAIN                               ★ UNCHANGED      │
│      89 actions · 13 resources · preview→HMAC token→confirm              │
│      assertActionAccess re-run at confirm · receipts · redacted audit    │
├──────────────────────────────────────────────────────────────────────────┤
│ L5 RLS / RPC / POSTGRES                                 ★ UNCHANGED      │
└──────────────────────────────────────────────────────────────────────────┘

Framework replaces: NOTHING.
Deferred seam (only if §11 triggers): L2 ToolLoopAgent → WorkflowAgent. L1/L3/L4/L5 unchanged.
```

### 13.1 Phased plan

| Phase | Work | Effort | Incremental? | Rollback |
|---|---|---|---|---|
| **S1** | Scored staff eval gate (12.5) + baseline measurement | 3–4 d | Yes | Delete CI job |
| **S2** | Staff tool-call repair (12.2) + `maxSteps` 8→12 (12.6) | 2 d | Yes | Remove one option; revert one constant |
| **S3** | Cross-turn tool memory (12.1) | 3–5 d | Yes | Feature flag → original filter |
| **S4** | Plan artifact (12.3) | 3–4 d | Yes | Unmount tool (registry entry removal) |
| **S5** | OTel step tracing (12.4) | 2–3 d + infra | Yes | Unset telemetry option |
| **S6** | Re-measure against S1 baseline; decide on `activeTools` | 2 d | Yes | — |

**Total: ~3–4 engineer-weeks**, versus 6–10 for a LangGraph migration that improves none of
T1–T8. Every phase ships independently and behind its own switch.

### 13.2 Rollback strategy

Each primitive is additive and independently revertible: S2/S5 are single agent options,
S3 is one function behind a flag, S4 is one registry entry (unmounting a tool removes it
from the model's world entirely — the deny-by-default property works in reverse too),
S1 is a CI job. **No migration, no schema change, no data backfill, therefore no rollback
window.**

### 13.3 Migration risk

**Low.** The only change touching model context semantics is S3 (tool-part replay), and its
risk is bounded by replaying only already-sanitized, already-persisted, already-RLS-scoped
data to the same authenticated user, under an allow-list, with an explicit test that
`execute_action` previews can never be replayed.

### 13.4 Files/modules affected

`lib/ai/staff-agent.ts` · `lib/ai/conversation-parts.ts` · `app/api/agent/chat/route.ts` ·
`lib/ai/tools/registry.ts` · new `lib/ai/tools/propose-plan.ts` · new
`lib/ai/staff-tool-call-repair.ts` · `lib/ai/prompts/staff.ts` (one clause, S4 only) ·
`lib/ai/platform/registry.ts` (one constant) · `lib/ai/eval/` (runner only) ·
`components/assistant/assistant-chat.tsx` (two renderers) · one CI workflow.
**~11 files. Zero migrations. Zero new runtime dependencies.**

### 13.5 Tests / evals required

- `modelSafeHistory` replay: allow-list enforced; `tool-execute_action` never replayed;
  byte caps honoured; unsanitized payload rejected.
- Repair: unknown tool name resolves or drops; invalid args subtract only; never lands on
  `execute_action`; never fabricates an id; every repair audited.
- `propose_plan`: reads no clinic data; mounted only for the intended classes; grants nothing.
- Authorization invariants **re-run unchanged** — `action-routing-authorization.test.ts`,
  `final-b2-action-reachability.test.ts`, `phase7-superset-coverage.test.ts`, and the RLS
  integration suites must pass untouched. If any of them needs editing, the change is wrong.
- Injection corpus (136 cases) must pass with replay enabled — replayed tool parts are a new
  path for stored injection to re-enter context, so this is the gate that matters most.
- Nightly live eval: tool-selection accuracy, refusal correctness, clarification rate,
  citation compliance.

### 13.6 Measurable acceptance criteria

| Metric | Baseline (measure in S1) | Target |
|---|---|---|
| Staff eval tool-selection accuracy | TBD | ≥ baseline + 10 pts after S3+S4 |
| Redundant re-query rate on turn 2 of a multi-turn task | TBD | −50% after S3 |
| Turns ending in `tool-output-error` with no recovery | TBD | −70% after S2 |
| `staff_clinical_summary` turns hitting the step cap | TBD | < 1% after S2 |
| Median model steps per composite turn | TBD | no regression (±1) |
| Median turn latency | TBD | no regression >10% |
| Injection corpus pass rate | 100% | 100% (hard gate) |
| Authorization/RLS suites | pass | pass, unmodified (hard gate) |

### 13.7 Effort per phase

S1 3–4 d · S2 2 d · S3 3–5 d · S4 3–4 d (incl. UI) · S5 2–3 d + infra · S6 2 d.
**≈ 15–20 engineer-days.**

### 13.8 Can it be introduced incrementally?

Yes — that is the point. Six independent phases, each behind its own switch, each shippable
alone, none blocking another.

### 13.9 Should patient booking remain completely outside it?

**Yes — completely.** Different persona, different model tier (Haiku 4.5 vs Sonnet 4.5),
different task policies, different authorization root (`authorizePatientConversation` +
`resolvePatientAiContext` + DOB verification + the 5-failure/30-minute lock), different
state (`ai_collected_data` / `ai_pending_clarification` / `bookingStage`), different HITL
model (staff takeover + `ai_patient_intakes` approval, reviewed hours later), different
failure mode (degrade to a human), and a different threat model (untrusted counterparty).
The typed booking state machine
(`docs/reviews/AI_ASSISTANT_TYPED_BOOKING_STATE_IMPLEMENTATION.md`) is the correct answer
there and is unaffected by everything in this study. The two assistants share only
`lib/ai/platform/*`, the audit layer, and the untrusted-text neutraliser — and that sharing
should stay exactly as narrow as it is.

---

## 14. WHAT WOULD ACTUALLY MAKE THE ASSISTANT SMARTER?

Ranked by real expected impact on ClinicFlow specifically. **This is the section that answers
the question you actually asked.**

### 1. Model quality — HIGH impact, near-zero effort
Staff turns run **Claude Sonnet 4.5**. The single largest determinant of whether the
assistant picks the right tool, decomposes a request correctly, and reasons over returned
rows is the model. The certification registry (`lib/ai/platform/registry.ts`) is built for
exactly this: add a route alias, run the eval suite, flip `primaryModelAlias`, keep
`rollbackAlias`. **Upgrading the certified staff route will do more for perceived
intelligence than every framework in this study combined.** It requires S1 (the scored eval
gate) first, so the upgrade is evidence-based rather than vibes-based.

### 2. Prompts & context — HIGH impact, low effort
The current gap is **not size** (~8.5k of 192k). It is *what is in context*:
- Cross-turn tool memory (12.1) — the model currently reasons over its own prose summary of
  what it found last turn.
- Zero few-shot examples of good multi-step decomposition. One worked example per composite
  shape costs ~400 tokens and is the cheapest accuracy purchase available.
- The suppression-scope clause is ~1,900 characters — over a third of the English prompt —
  fixing one historical misgeneralisation. Worth revisiting once evals can measure whether a
  shorter version holds.

### 3. Tool design — HIGH impact, medium effort
The best result in the whole system is `compare_revenue_periods`: T3 answers in **one step**
because the tool was designed to answer the *question*, not to expose a *table*. That is the
generalisable lesson. Concretely: make `check_availability` return gap durations and adjacent
bookings so T5 has something to reason over; return richer denial context; inline the top-N
filter names for the hottest resources so the discovery round-trip disappears.
**Tool design is orchestration — done in the right layer.**

### 4. Retrieval — MEDIUM impact
`lib/ai/help/search.ts` serves product knowledge; there is no semantic retrieval over
*clinical* content. `docs/AI_ASSISTANT_RAG_AUDIT_AND_PLAN.md` covers this. Real value for
"what did we discuss with this patient in March", genuinely orthogonal to orchestration,
and a large separate project with its own PHI-embedding considerations.

### 5. Orchestration — LOW-MEDIUM impact
Only two orchestration gaps are real: the plan artifact (12.3) and tool-call repair (12.2).
Both are ~130 lines. Everything else labelled "orchestration" in framework marketing —
graphs, supervisors, handoffs, checkpoints — addresses problems ClinicFlow has already
solved differently and better.

### 6. Memory — MEDIUM impact
`active_context` handles single-entity continuity well. The gaps are the working-set problem
(one patient slot, N-patient tasks) and tool amnesia (12.1). **No framework's memory
abstraction is compatible with RLS-scoped, server-derived-only entity state**, so this stays
in-house regardless.

### 7. Framework choice — **NEGLIGIBLE impact on intelligence**
A framework changes the *shape of the control flow around* the model. It does not change
which tool the model picks, how well it reads a result, or how it writes an answer. Not one
of T1–T8 gets a better answer from a graph runtime.

> **Direct answer to the question posed: yes — adopting an agent framework here would be
> solving an intelligence problem with an orchestration tool that does not improve
> intelligence.** The levers that do are, in order: the model, what is in context, and how
> the tools are shaped. All three are fully available inside the current architecture, and
> two of them are blocked on the same missing thing: a scored eval loop that can tell you
> whether a change helped.

---

## 15. DO NOT MIGRATE YET IF… (measurable thresholds)

Do **not** adopt any framework while **all** of the following hold. Re-open this decision
only when **three or more** are false.

| # | Threshold | Current measured value | Status |
|---|---|---|---|
| 1 | Static tool schema < 25% of the class input budget | ~8.5k / 192k = **4.4%** | ✅ hold |
| 2 | Static model-facing tools ≤ 30 | **22** | ✅ hold |
| 3 | Composite turns rarely hit the step cap | cap 25; T1–T8 measured 1–7 | ✅ hold |
| 4 | No requirement to survive a restart *mid-turn* | none; turn = one ≤60s request | ✅ hold |
| 5 | No genuine multi-agent decomposition required | 22 tools, one auth pass | ✅ hold |
| 6 | HITL fully covered by preview→confirm | HMAC, single-use, digest-bound, re-authorized | ✅ hold |
| 7 | Framework state would not duplicate `active_context` | it would (§8.1) | ✅ hold |
| 8 | Orchestration code stays small | `staff-agent.ts` = **93 LOC**; router = policy selection only | ✅ hold |
| 9 | Tool-selection accuracy is not the top defect | **unmeasured — S1 must establish this** | ⚠️ unknown |
| 10 | No self-hosted PHI-safe trace store makes framework observability free | none exists yet | ✅ hold |

**9 of 10 thresholds hold. #9 is unknown, which is itself the finding: build the eval gate
(S1) before making any further architecture decision about this assistant.**

Additional hard triggers, any one of which forces a re-read:
- A staff workflow must pause **mid-execution** for more than the function timeout → evaluate
  **Vercel WorkflowAgent** (not LangGraph).
- The in-house orchestration modules (agent + repair + plan + replay) exceed **~1,500 LOC
  combined** — at that point it *is* a framework, and a maintained one is the better trade.
- A second, structurally different staff assistant surface appears that cannot share one
  tool mount.
- Microsoft Agent Framework ships **official** first-class TypeScript support **and** a
  self-hostable story — currently .NET/Python/Go only, with no roadmap.

---

## 16. What must remain untouched, under every option

If any proposal requires changing an item on this list, the proposal is wrong.

- **The four-layer authorization stack.** `authorizeStaffAssistant` → `resolveToolMount`
  (role × feature × user permission × task class) → per-tool `execute` re-assertion →
  `assertActionAccess` at both preview and confirm → RLS.
- **`ACTION_CAPABLE_ROLES` derived, never listed.** Deriving it from `AI_ACTION_REGISTRY` is
  what makes the Phase-3-era drift bug structurally impossible. Never hand-maintain it.
- **The confirmation pipeline.** HMAC-SHA256 token bound to
  `{actionId, inputDigest, userId, clinicId, conversationId, nonce, exp}`; withheld from
  model context by `toModelOutput`; single-use with replay detection; re-authorized at
  confirm; step-up for privileged; `ai_action_receipts`.
- **`harden()` at the mount boundary.** `sanitizeUntrustedDeep` + `withProvenance` +
  denial→result conversion + denial/clarification/error auditing. Any re-registration of
  tools must reproduce this exactly, and the 136-case injection corpus is the proof.
- **Server-derived ids only.** `active_context` slots accept ids solely from `resolution`,
  `user_choice`, or `page_context`; `display_label` never reaches the model.
- **The certified execution layer.** `prepareAiExecution` → certified route → ZDR/no-training
  policy → worst-case reservation → per-step `observeStep` → `reconcileAiBudget`. Model
  changes go through the certification registry with a `rollbackAlias`.
- **Deterministic routing that selects policy, never authority** — including the conjunctive
  guard 3 and the `staff_help` containment property.
- **Audit.** `logAgentTool` → `toolAuditSummary` redaction → `audit_logs` with
  `actor_type='ai'`.
- **The patient booking assistant**, entirely.

---

## 17. VERDICT

> ## VERDICT: **IMPROVE CURRENT**
>
> ## EXPECTED REAL-WORLD IMPROVEMENT: **MODERATE**

**Explanation.** ClinicFlow's Staff Assistant is not a prompt with tools; it is a four-layer
system in which the orchestrator is 93 lines and owns nothing, and every capability a
framework would sell — declarative registry, dynamic permission-filtered discovery,
digest-bound human approval, durable server-owned entity state, per-invocation redacted
audit, per-step budget metering, injection neutralisation, and a bilingual eval corpus — is
already built, and several are built to a standard no surveyed framework matches. The
measured surface (22 static tools, ~8.5k tokens against a 192k budget, 89 actions and 13
resources behind deferred disclosure) is nowhere near the pressure point that justifies a
graph runtime, and 9 of 10 "do not migrate" thresholds hold today.

Adopting LangGraph.js, LangChain agents, Deep Agents, or Mastra would cost 6–10 engineer-weeks,
add 3–5 runtime dependencies, rewrite the streaming contract a 1,518-line UI depends on,
introduce a second state store outside RLS, and improve **zero of the eight** representative
tasks. Microsoft Agent Framework is disqualified outright: it officially supports .NET,
Python, and Go, with no first-class TypeScript and no published roadmap — and it must not be
confused with the Microsoft 365 Agents SDK, which does ship TS but is a Teams/Copilot bot
framework solving a different problem. Vercel's WorkflowAgent is the one genuinely
compatible option and the right seam **if** a durable-execution requirement ever appears; it
has not.

The improvement is **MODERATE rather than HIGH** because the largest remaining lever is
model quality and context content, not control flow — and the honest position is that
tool-selection accuracy is currently **unmeasured**. Build the eval gate first; then the
model upgrade, the cross-turn tool memory, and the plan artifact can be justified with
numbers instead of intuition. That sequence delivers more real capability in ~3–4 weeks than
a framework migration would in ten.

---

## 18. Top 3 concrete improvements

1. **Scored staff eval gate in CI (S1).** The corpus and grader already exist; CI grades
   rubric consistency, not answers. Until tool-selection accuracy is measured, every further
   architecture decision — including a model upgrade — is guesswork.
2. **Cross-turn tool memory (S3).** `modelSafeHistory` strips every tool part from history,
   so multi-turn tasks reason over prose summaries instead of results. A bounded, sanitized,
   allow-listed replay of the last two turns is ~80 lines and is the largest single
   capability gain available.
3. **Staff tool-call repair + `staff_clinical_summary.maxSteps` 8 → 12 (S2).** The repair
   primitive is already written for the patient agent and is one line to mount; the step cap
   leaves T2-shaped clinical tasks with no headroom for a clarification. Two days, two
   defects removed.

---

## Verification

- No production code, prompt, tool, test, dependency, migration, or configuration was
  modified. `git status` shows exactly one added file: this document.
- All quantities in §2 were produced by executing the project's real registries and prompt
  builders through its own Vitest resolver in a throwaway spec that was run and deleted.
- External framework claims were verified against official sources on 2026-08-24:
  Microsoft Agent Framework language support (`github.com/microsoft/agent-framework`
  discussion #6181 — .NET/Python/Go, no official TS), Microsoft 365 Agents SDK JS reference
  (learn.microsoft.com), LangGraph.js parity and TS release lag, LangChain v1 `createAgent`
  + `humanInTheLoopMiddleware` (docs.langchain.com), Deep Agents JS
  (`langchain-ai/deepagentsjs`, docs.langchain.com), Mastra v1.0 (mastra.ai), OpenAI Agents
  SDK TS (openai.github.io/openai-agents-js), Vercel Workflow DevKit (vercel.com/docs/workflows)
  and AI SDK `WorkflowAgent` + loop control (ai-sdk.dev).
