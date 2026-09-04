# ClinicFlow — WhatsApp Patient Assistant: LangGraph / Agent-Framework Architecture Study

Study date: 2026-08-22
Branch: `feat/p7-manual-qa-polish`
Scope: **architecture study only.** No production code, prompt, tool, dependency or
migration was modified. Nothing was deployed.

Sources read for this study: `lib/ai/patient-agent.ts`, `lib/ai/patient-tools.ts`,
`lib/ai/patient-reply.ts`, `lib/ai/patient-authorization.ts`, `lib/ai/collected-state.ts`,
`lib/ai/patient-input.ts`, `lib/ai/doctor-directory.ts`, `lib/ai/entity-resolution.ts`,
`lib/ai/prompts/patient.ts`, `lib/ai/platform/registry.ts`, `lib/ai/platform/execution.ts`,
`lib/ai/audit.ts`, `lib/ai/eval/*`, all eleven patient tools under `lib/ai/tools/`,
`lib/messaging/webhooks.ts`, `lib/supabase/admin.ts` (`set_conversation_ai_state`,
`resolvePatientAiContext`), and the P8/P8B review reports
(`P8_AI_WHATSAPP_INTAKE_BOOKING_CLAUDE_REVIEW.md`,
`P8_WHATSAPP_HUMAN_INPUT_FULL_INBOX_MEDIA.md`, `P8_WHATSAPP_INBOX_UPGRADE*.md`,
`P8_WHATSAPP_START_LOGOUT_RACE_FIX.md`).

---

## 0. Executive answer

**No. LangGraph is not better than the current implementation for ClinicFlow, and a
migration is not justified now.**

The reason is not that LangGraph is a bad framework. It is that ClinicFlow has already
built — under different names — the three things a migration to LangGraph would buy:

| What LangGraph sells | What ClinicFlow already has |
| --- | --- |
| Durable typed graph state | `conversations.ai_collected_data` + `ai_pending_clarification`, written only by `set_conversation_ai_state`, rebuilt field-by-field by `parseCollectedData` |
| Interrupt / human-in-the-loop | `ai_paused_at` takeover + `ai_patient_intakes` staff approval + `ai_suggested_replies` — modelled as durable rows reviewed hours or days later, not as a paused in-process graph |
| Checkpoint / resume after restart | Turn-per-inbound-message with all state in Postgres; a restart costs at most one reply, and the next inbound message reconstructs the full context from `loadHistory` + collected state |

What ClinicFlow is genuinely missing is **one specific, small thing**: an explicit,
server-owned `bookingStage` and a server-side legality check on what the model is allowed
to do next in that stage. Today that state machine exists only as English and Arabic prose
inside a ~4,000-token system prompt, executed by **Claude Haiku with `maxSteps: 6`**
(`lib/ai/platform/registry.ts:183-194`). That mismatch — a multi-stage workflow encoded in
prose and handed to the smallest model in the fleet with a six-step budget — is the actual
root cause of the conversational bug class in question.

Fixing that costs an estimated **300–600 lines of typed TypeScript** in
`lib/ai/collected-state.ts` and `lib/ai/patient-tools.ts` plus one migration column. It does
not cost a framework, a new runtime, or a rewrite of the certified execution layer in
`lib/ai/platform/`.

**Recommendation: Option 4 — build a small typed state machine in-house (Section 9).**
Option 3 (hybrid LangGraph) is a defensible runner-up and is analysed honestly below;
Option 2 (full LangGraph) is rejected. Revisit LangGraph only if the triggers in
Section 13 fire.

---

## 1. What the current architecture actually is

The system is **not** "a prompt with tools". It is already a four-layer architecture with a
hard security boundary, and it is important to describe it accurately before comparing.

```
WhatsApp inbound (worker / provider webhook)
  └─ lib/messaging/webhooks.ts:493   best-effort, never fails the webhook
      └─ runPatientInboundAiReply()  lib/ai/patient-reply.ts:430
          ├─ entitlement + reply-mode resolution (off / suggest / auto)
          ├─ conversation gate: status=open, not escalated, not empty
          ├─ DETERMINISTIC escalation detection  (detectPatientEscalation)  ← pre-LLM
          ├─ loadHistory()  — last 16 turns + bounded attachment parts
          ├─ prepareAiExecution()  — certified route, budget ledger, ZDR policy
          │   └─ createPatientAgent()  lib/ai/patient-agent.ts
          │       └─ ToolLoopAgent (AI SDK v6), Haiku, maxSteps 6, temp 0.2
          │           └─ 11 patient tools, each wrapped by protectPatientTool()
          ├─ claimAutoSend()  — conditional UPDATE closing the takeover race
          └─ recordSuggestion() / sendMessage() / escalateConversation()
```

### 1.1 The layers, and who owns what

**L1 — Transport and turn orchestration** (`patient-reply.ts`). Owns: reply mode,
escalation, human takeover, the auto-send claim, suggestion recording, notification
emission, degradation-to-human on every failure. Deterministic. No LLM involvement in any
of these decisions. `runAgent` is injectable, which is why the whole orchestration is unit
tested against a mocked model (`tests/unit/ai/p5b-patient-reply.test.ts`).

**L2 — Model loop** (`patient-agent.ts` + `prompts/patient.ts`). A single `ToolLoopAgent`
with one flat tool set and one monolithic bilingual system prompt. This is the only layer
that is genuinely "prompt + tools", and it is the only layer under discussion for
replacement.

**L3 — Narrow domain tools** (`lib/ai/tools/*`, 11 mounted for `patient_booking`, 2 for
`patient_faq`). Every tool:
- calls `authorizePatientConversation()` first (entitlement → subscription → RPC
  `resolvePatientAiContext` → clinic/conversation pair re-check → pause → link → verify);
- is wrapped by `protectPatientTool()` (`patient-tools.ts:44`), which sanitises every result
  through `sanitizeUntrustedDeep` + `withProvenance`, converts `PatientIdentityError` /
  `AiToolAuthorizationError` into non-escalating guidance, audits denials, and degrades any
  unexpected throw into `buildPatientTechnicalFallback` carrying the clinic's *stored* phone;
- never receives a `patientId`, a `clinicId` from the model, or a phone number.

**L4 — Secure application / RPC / DB.** `stage_patient_intake_from_conversation`,
`create_provisional_ai_appointment_request`, `verify_patient_conversation_dob`,
`set_conversation_ai_state`, `computeAvailability` / `lib/booking/patient.ts`, RLS, the
`protect_*` triggers, `audit_logs.actor_type='ai'`.

### 1.2 The state that already exists

Two jsonb columns on `conversations`, written **only** by the service-role RPC
`set_conversation_ai_state` and read only through `parseCollectedData` /
`parsePendingClarification`:

- `ai_collected_data` — 12 whitelisted fields (`SLOT_FIELDS`, `collected-state.ts:80-93`):
  `date_of_birth, appointment_date, appointment_time, full_name, phone, national_id, email,
  gender, department_id, department_name, doctor_id, doctor_name`. Canonical values only
  (ISO dates, minutes-past-midnight, E.164). Merged with `||`, never replaced. 8 KB cap.
- `ai_pending_clarification` — exactly one outstanding question, with its competing
  canonical readings. 4 KB cap.

`resolveField()` (`collected-state.ts:319`) is a **pure function** implementing a four-branch
resolution order: complete answer wins → answer the outstanding question → confirm what is
established → give up with a named reason. It handles the exact cases in the brief:
`"سبتمبر"` after an ambiguous `12/9/2000`, `"نعم 2000"` as confirmation, `"لا قصدي الخميس"`
as a correction (`resolveSimple` takes the new value; dates route to `conflict` so the
patient is asked once rather than silently overwritten).

`isOtherDoctorsRequest()` (`doctor-directory.ts:78`) recognises `"مين غيره؟"`, `"who else"`,
`"عايز دكتور تاني"` etc. **before** they reach the fuzzy name resolver, and `list_doctors`
exists specifically as a read-only move that answers the follow-up **without rewriting
collected state**.

**This is already a state machine.** It is a *field-level* one. What it is not is a
*stage-level* one.

---

## 2. The real defect taxonomy — what actually went wrong recently

Reading P8 and P8B against the code, the recent bugs fall into four disjoint classes. Only
one of them is an orchestration-topology problem.

### Class A — Missing conversational state (**already fixed**, P8B §1)

*Symptom:* "the assistant re-asked for information it already had"
(P8B §1.1). *Root cause, quoted verbatim from the review:* "each tool call started from
nothing… this is not a date-parsing bug and a date-specific patch would not have fixed it.
It is the absence of conversational state."

This is the class LangGraph is marketed to solve, and ClinicFlow solved it in P8B with
~740 lines of pure TypeScript plus two jsonb columns. **A LangGraph migration would be
re-solving a solved problem.**

### Class B — Database / trigger / RPC defects (**LangGraph-irrelevant**)

From the P8 review, all reproduced against a real database:
- **B1** `approve_ai_patient_intake` fails 100% of the time — `auth.role()` comes from the
  JWT not the definer owner, so `protect_patient_ai_identity_state` and
  `protect_ai_booking_metadata` both fire.
- **B2** human takeover makes an intake unapprovable (`block_paused_ai_booking_insert`).
- **B3** a closed/resolved thread makes an intake unapprovable
  (`enforce_ai_pending_booking_policy`).
- **B4** an expired `ai_appointment_requests` row permanently bricks re-booking via the
  partial unique index; the raw 23505 surfaces to the patient as "the slot could not be
  booked", forever.
- **S1** the superseded `register_patient_from_conversation` is still granted to
  `service_role`.
- **S3** `ai_appointment_requests.service_id` has no FK.
- **M2** no expiry sweeper. **M3** no behavioural test for any new RPC — "that is why B1–B4
  shipped through a green suite."

**Every single one of these is invisible to the orchestration layer.** No graph engine
prevents, detects, or mitigates any of them. B4 in particular presents to the patient
exactly like a "conversation bug" and is not one.

### Class C — Prose-encoded workflow executed by a small model (**the real orchestration gap**)

`buildPatientSystemPrompt` is one ~4,000-token bilingual block that encodes a five-stage
workflow (`department → doctor → day → time → pending booking`), plus new-patient intake,
plus identity verification, plus six named doctor-resolution failure modes, plus attachment
rules, plus hard refusals — as prose. It is executed by:

```
patient_booking:  primaryModelAlias "patient-haiku-bootstrap-v1"
                  maxSteps 6, maxInputTokensPerStep 16_000, maxOutputTokens 800
```
(`lib/ai/platform/registry.ts:183-194`)

Every tool is mounted on every turn regardless of stage. The prompt's rules
("Do not ask for a day before a doctor is resolved", "keep the department already chosen",
"never restart the flow") are **advisory to the model**, not enforced by the server. When
Haiku drops one of them, the observed symptom is exactly the reported bug list: repeated
questions, "other doctors" restarting the flow, day offered before a doctor exists.

Note that the team has already been *patching this class structurally rather than by prompt
wording* — and it worked. `prepare-booking.ts:96-100` replaced "the treating-doctor shortcut
fires whenever there are no arguments" with an explicit `isBookingOpening` guard gated on
`!establishedDepartmentId && !wantsAlternatives`; the comment says so directly: "returning
the one treating doctor again is what made 'في دكاترة غيره؟' unanswerable." That is a
hand-rolled stage guard. There are currently **three** such ad-hoc stage guards scattered
across `prepare-booking.ts`, `list-doctors.ts` and `list-available-days.ts`, each
reimplementing "what stage are we in" from the collected fields. Consolidating them is the
genuine architectural improvement available.

### Class D — Race conditions and distributed-system edges (**partially solved, LangGraph-neutral**)

`claimAutoSend()` (conditional UPDATE), `EMERGENCY_TAKEOVER_GRACE_MS`, the advisory lock in
`create_provisional_ai_appointment_request`, the `on conflict … where review_status =
'pending_review'` restaging. These are correct and were solved at the database boundary,
which is the only place they *can* be solved. LangGraph's checkpointer operates one layer
too high to help.

**Verdict on the taxonomy: of the four classes, Class A is done, Classes B and D are
out of scope for any orchestration framework, and Class C is real — but is a
50-line-of-types problem wearing a framework-shaped costume.**

---

## 3. Option A — Current architecture, assessed honestly

### Strengths
1. **The security boundary is real and structural**, not conventional. The model never sees
   a `patient_id`, a phone, or a `clinic_id` it can influence. `register_patient`'s
   `inputSchema` has no phone field; the RPC derives it from
   `conversations.participant_address`. This was independently verified in P8/P4.
2. **Every failure degrades to a human.** A denied tool becomes guidance, not a refusal. An
   unexpected throw becomes one apology carrying the clinic's stored phone. A failed agent
   run becomes `low_confidence` escalation. A failed send becomes `agent_error` escalation
   with the draft preserved for staff.
3. **Deterministic-where-it-matters.** Escalation detection, date/time/name/phone parsing,
   availability, identity matching (exact folds, never fuzzy), and doctor/department
   resolution (fuzzy but bounded and read-only) all run outside the model.
4. **Testable.** `runAgent` injection means the full suggest/auto/escalate/takeover
   orchestration is exercised with a mocked LLM. `resolveField` is pure and has 62 tests.
   The eval harness (`lib/ai/eval/`) grades ~100 bilingual cases against the real
   authorization oracle offline, with an opt-in live mode.
5. **Cheap.** One Haiku call per inbound message, ≤6 steps, ≤16k input tokens.

### Weaknesses
1. **No explicit stage.** `bookingStage` exists nowhere. It is re-derived ad hoc in at
   least three tools from `collectedData.department_id` / `doctor_id` presence.
2. **Flat tool mount.** All 11 tools are callable at every stage. Nothing structurally
   prevents `create_preliminary_booking` from being attempted before `check_availability`;
   only the tool's own `doctor_required` guard and the prompt stand in the way.
3. **The prompt is the specification.** Changing workflow behaviour means editing two
   parallel natural-language documents (EN + AR) and hoping a small model complies. There is
   an i18n parity gate for UI messages; there is no equivalent semantic parity gate for the
   two prompt variants.
4. **`maxSteps: 6` is tight** for a turn that must do `prepare_booking` →
   `list_available_days` → answer. A turn that needs `verify_patient_identity` →
   `prepare_booking` → `get_clinic_info` → `list_available_days` is at the ceiling.
5. **No per-turn trace artefact.** `audit_logs` records tool name + outcome (redacted).
   Sentry records exceptions. There is no single object saying "on turn N the state was X,
   the model called Y, and the state became Z" — which is precisely what makes Class C bugs
   expensive to reproduce.
6. **The escalation reason `low_confidence` is overloaded** — it covers empty text, provider
   failure, budget denial and genuine no-answer.

---

## 4. Option B — LangGraph

### 4.1 What it would actually be here

LangGraph.js (`@langchain/langgraph`) would replace **L2 only** in the desired architecture:

```
LLM → LangGraph StateGraph → existing ClinicFlow tools → existing RPC/DB
```

Nodes: `classify_intent`, `verify_identity`, `select_department`, `select_doctor`,
`select_day`, `select_time`, `confirm_booking`, `intake_collect`, `intake_stage`,
`escalate`. Edges conditional on typed state. A Postgres checkpointer persists state.

### 4.2 What LangGraph would genuinely solve

| ClinicFlow problem | Solved? | How |
| --- | --- | --- |
| Losing selected department/doctor | **Partially** — already solved by P8B state; LangGraph adds compiler-checked reducers so a node *cannot* silently drop a field | Typed channel reducers |
| Treating-doctor short-circuit swallowing follow-ups | **Yes, structurally** | The shortcut becomes an edge from `START` only, unreachable once `selectedDepartmentId` is set |
| "Other doctors" restarting the flow | **Yes, structurally** | A self-loop on `select_doctor`; there is no edge back to `select_department` |
| Repeated questions | **Partially** | Node prompts see only their slice of state, so "already known" is not competing with 4,000 tokens of other rules |
| Tool calls without enough context | **Yes** | A node's tool set is its own; `list_available_days` is not mounted before `select_doctor` completes |
| Unclear workflow state → "technical failure" | **Yes** | Illegal transitions are graph errors, not model improvisation |
| Tool loops | **Partially** | Graph recursion limits are equivalent to today's `maxSteps`; the real win is a smaller decision space per node |

### 4.3 What LangGraph would **not** solve — explicitly

- **B1/B2/B3**: `security definer` vs `auth.role()`, and three triggers rejecting the human
  approval path. Untouched.
- **B4**: the expired-request unique-index brick. Untouched — the graph would faithfully
  reach `confirm_booking` and receive the same 23505.
- **M2**: no expiry sweeper. Untouched.
- **S1**: `register_patient_from_conversation` still granted to `service_role`. Untouched.
- **S3**: missing FK on `service_id`. Untouched.
- **B5**: national id folded on approval. Untouched.
- **B6**: `duration_minutes` midnight wrap in `ai_requested_slot_is_available`. Untouched.
- **Wrong provider data / doctor directory correctness.** Untouched.
- **Availability query correctness** (`computeAvailability`, `doctor_schedules`,
  `clinic_working_hours`, `doctor_unavailability`, the ±15-minute buffer). Untouched.
- **Every security property** — RLS, entitlements, the `protect_*` triggers, exact identity
  folds, the no-existence-oracle wording, injection resistance. Untouched at best; **at
  risk** if the migration is done carelessly (Section 4.5).
- **Arabic/English understanding, spelling, transliteration.** This lives entirely in
  `human-input.ts` + `entity-resolution.ts` + `collected-state.ts`. A graph does not parse
  `"١٢/٩/٢٠٠٠"` or fold `ا/أ/إ`. **Zero improvement.**
- **Fragmented answers across messages.** Same — that is `resolveField`'s pending/collected
  machinery, already durable. LangGraph's state would *hold* the same values; it would not
  understand them better.
- **Corrections ("لا قصدي الخميس").** Same. `resolveSimple`/`resolveDate` decide this today.
- **Latency and token usage.** See 4.4 — likely *worse*, not better.

### 4.4 Costs specific to ClinicFlow

**C1 — It collides with the certified execution platform.** `prepareAiExecution()`
(`lib/ai/platform/execution.ts`) is not a thin wrapper. It resolves a certified model route
by alias, enforces `allowedCredentialModes` (managed / byok_strict / hybrid), stamps a
`privacyPolicyVersion` (`patient-zdr-no-training-v1`), reserves budget, and returns a handle
whose `beginStep` / `observeStep` / `finalize` implement the per-step token assertion
(`assertAiInputWithinPolicy`) and the usage ledger. `patient-agent.ts` wires all of that into
the AI SDK's `prepareStep` / `onStepFinish` hooks. LangGraph.js expects LangChain model
objects. Either the Anthropic provider is re-wrapped for LangChain (losing the AI SDK hooks
the platform depends on) or a bespoke adapter is written and maintained. **This is the single
largest hidden cost and it is not visible from a LangGraph tutorial.**

**C2 — Latency and tokens increase, they do not decrease.** Today: one model call sequence
per inbound message. A node-per-stage graph makes at least one LLM call per node traversed;
a turn that classifies intent, then selects a doctor, then answers is 2–3 calls where there
was one. Per-node prompts are smaller, so per-call tokens drop — but WhatsApp patients feel
wall-clock latency, and each extra round trip adds provider RTT. Realistic estimate:
**+30–60% p50 latency, roughly token-neutral to +20%** depending on how aggressively the
graph is collapsed. A single-node graph avoids this but then the graph is doing nothing the
current `ToolLoopAgent` does not.

**C3 — Checkpointing is the wrong granularity.** LangGraph's flagship durability feature
checkpoints an in-flight graph so it can resume mid-execution. ClinicFlow's human-in-the-loop
pauses are **not mid-execution**: `ai_patient_intakes` approval happens hours or days later,
by a different actor, in a different process, through a Next.js server action, and it may be
*rejected*. `ai_paused_at` takeover can last days. Modelling those as graph interrupts would
put multi-day business state in a checkpointer instead of in `ai_patient_intakes` /
`conversations`, where it is queryable, RLS-protected, auditable and visible on the dashboard.
That would be a regression in every one of those properties.

**C4 — Observability's real value is LangSmith, which is a hosted third party.** The honest
reason teams like LangGraph's debuggability is LangSmith traces. Sending patient WhatsApp
conversation state — Arabic free text, dates of birth, national ids in flight — to a hosted
tracing service contradicts `patient-zdr-no-training-v1` and the whole `lib/ai/redact.ts` /
`toolAuditSummary` posture. Self-hosting is possible and is another system to run. Without
LangSmith, LangGraph's observability advantage over "log the typed state transition to
`audit_logs`" is close to zero.

**C5 — Dependency and supply-chain surface.** The app currently ships **zero** LangChain
packages and a deliberately small dependency list (`ai`, `@ai-sdk/anthropic`, `zod`, and
domain libraries). `@langchain/langgraph` + `@langchain/core` + a Postgres checkpointer is a
large transitive tree in a healthcare product with a security review process. The brief
explicitly forbids adding dependencies for this study; it is worth noting that the
*permanent* version of that cost is real.

**C6 — Ecosystem asymmetry.** LangGraph's centre of gravity is Python. The JS port is real
and maintained but consistently trails on features, docs and examples. This is a Next.js 16 /
React 19 / TypeScript codebase; there is no Python runtime in the deployment (Vercel + a
Railway Node worker). Introducing one is out of the question; staying on the JS port means
accepting the trailing edge.

### 4.5 The security risk of migrating

The brief's constraint — "the framework must NEVER get direct unrestricted database access"
— is satisfiable and would be satisfied by a hybrid design. But two subtler risks deserve
naming:

1. **Graph state is not an authorization input, and must never become one.** The current
   design is emphatic about this: `parseCollectedData` rebuilds the jsonb key-by-key against
   a fixed field list precisely so a `patient_id` or `identity_verified` key "cannot survive
   a read even if one were written" (P8B §3.3, with a test asserting it). A LangGraph state
   object is a plain typed record with no such re-derivation discipline. `verifiedPatientId`
   sitting in graph state is *exactly* the field that must never be trusted by a tool —
   `authorizePatientConversation` must keep re-deriving it from `resolvePatientAiContext` on
   every call. This is easy to get wrong and would be a severe, silent regression.
2. **Tool wrapping must not be lost.** `protectPatientTool` is the single choke point for
   result sanitisation (`sanitizeUntrustedDeep`), provenance framing (`withProvenance`),
   denial auditing and technical-fallback degradation. If tools are re-registered as
   LangChain tools, that wrapper must be reproduced exactly. The injection corpus
   (`lib/ai/eval/injection-corpus.ts`, 136 adversarial tests) is the gate that would catch a
   miss — it must be run against the new mount, not the old one.

---

## 5. Option C — Microsoft Agent Framework and other alternatives

Assessed for material relevance, not popularity.

**Microsoft Agent Framework (the Semantic Kernel + AutoGen successor).** .NET-first with a
Python SDK; the JS/TS story is not the primary target. Its differentiators — multi-agent
group chat, Azure AI Foundry integration, enterprise identity — map onto problems ClinicFlow
does not have. ClinicFlow needs *one* assistant to follow *one* workflow reliably, not
several agents negotiating. Azure coupling is a poor fit for a Vercel + Supabase + direct
Anthropic stack. **Not materially relevant. Rejected.**

**Vercel AI SDK v6 native primitives (already a dependency).** Worth naming because it is
the cheapest real option and is already installed. `ToolLoopAgent` supports `prepareStep`,
which can return a *different* `tools` set, `activeTools`, `system` prompt and `toolChoice`
per step. That is a stage machine — it can narrow the tool mount and the prompt to the
current stage, using state the server already owns, with **no new dependency and no change
to `lib/ai/platform/`**. `patient-agent.ts:41-48` already uses `prepareStep`; it currently
returns `{}`. This is the mechanism Option 4 would use.

**Vercel Workflow DevKit (WDK).** Durable step-based execution with pause/resume on Vercel.
Genuinely good at the problem LangGraph's checkpointer targets — but ClinicFlow's WhatsApp
turn is short-lived and its long pauses are already durable DB rows. Also note the assistant
runs from a webhook that may originate on the Railway worker, not only on Vercel. **Not
justified for this problem.** Worth reconsidering only if a genuine long-running, multi-hour
agentic flow appears.

**Mastra / VoltAgent / Inngest AgentKit.** TypeScript-native agent frameworks with lighter
footprints than LangChain. Better ecosystem fit than LangGraph.js, but all of them are less
mature, and every argument in Section 2 applies: they solve Class A, which is done. If the
team ever decides a framework is required, **Mastra or Inngest AgentKit deserve evaluation
ahead of LangGraph.js**, purely on TypeScript-nativeness and dependency weight.

**XState.** Not an agent framework — a mature, tiny, typed state-machine library. If Option 4
grows beyond hand-rolled discriminated unions, XState is the natural escalation: it gives
statecharts, guards, visualisation and exhaustive transition testing with none of the LLM
opinions. **This is the more relevant "framework" for ClinicFlow's actual gap than LangGraph
is.**

---

## 6. Point-by-point evaluation against ClinicFlow's stated problems

Legend: **A** = current architecture, **B** = LangGraph, **D** = own typed state machine
(Option 4). Score = how much the *architecture choice* moves the needle.

| Problem | A (today) | B (LangGraph) | D (own SM) | Who actually owns it |
| --- | --- | --- | --- | --- |
| Arabic + English natural conversation | Good | Same | Same | Prompt + model choice. **No architecture effect.** |
| Spelling / transliteration | Good | Same | Same | `entity-resolution.ts` (Levenshtein + phonetic + transliteration), `fold_*` SQL |
| Fragmented answers across messages | **Solved (P8B)** | Same | Same | `collected-state.ts` `pending` + `collected` |
| "مين غيره؟ / who else?" | Fixed but fragile — 3 ad-hoc guards | **Structurally fixed** | **Structurally fixed** | Stage machine + `isOtherDoctorsRequest` |
| Corrections ("لا قصدي الخميس") | **Solved** | Same | Same | `resolveSimple` / `resolveDate` conflict branch |
| Remembering department/doctor/day | Solved (durable) | Same + typed reducers | Same + typed reducers | `ai_collected_data` |
| Existing vs new patient branching | Prose + `isBookingOpening` | Graph edges | Explicit `patientStatus` | Stage machine |
| Treating-doctor recommendation | Prose + guard | Edge from START only | Stage guard | Stage machine |
| department→doctor→day→time→pending | **Prose only** | Explicit | Explicit | **The real gap** |
| Provisional intake + human approval | DB rows + server action | Should stay DB rows | DB rows | `ai_patient_intakes` — **do not move** |
| Pause AI / human takeover | Solved (`claimAutoSend` + RPC recheck) | Same | Same | DB conditional write |
| Retries after tool failures | Fallback + hold turn | Node-level retry policy — mild win | Same as B if implemented | Tool wrapper |
| Resuming after worker/app restart | **Already fine** (turn-per-message) | Checkpointer — no added value | Same | Postgres |
| Avoiding repeated questions | Prompt + collected state | Smaller per-node prompt — real win | Same win | Stage-scoped prompt |
| Avoiding tool loops | `maxSteps: 6` | Recursion limit + narrow mounts | Narrow mounts | Tool mount scoping |
| Deterministic sensitive actions | **Excellent** (already outside LLM) | Same | Same | L1 + L4. Do not touch. |
| Auditability | Good (`audit_logs`, actor_type='ai') | Same unless LangSmith (PHI risk) | **Better** — log state transitions | `audit_logs` |
| Observability / debugging | Weak: no per-turn state trace | Good *with LangSmith* (PHI risk) | **Good** — typed transitions in one column | New work either way |
| Testing | Good (mockable runner, pure resolver, eval set) | Node-level tests, but harder E2E | **Best** — transitions are pure functions | — |
| Latency | Best (1 call chain) | **Worse** (+30–60% p50) | Same as A | — |
| Token usage | Good | Neutral to +20% | **Better** (smaller per-stage prompt) | — |
| Engineering complexity | Moderate | **High** (+adapter, +deps, +runtime) | **Low** (300–600 LOC) | — |

**Reading the table: LangGraph wins in exactly four rows, and Option 4 wins or ties in all
four of them at a fraction of the cost.**

---

## 7. Would LangGraph materially reduce the recently-seen bugs?

Taking each named bug from the brief:

**"Losing selected department/doctor state"** — *No material improvement.* This was fixed in
P8B by making the state durable in Postgres. LangGraph adds compile-time reducer safety,
which is nice; the same safety is available from a `readonly` typed record and a single
`applyTransition()` function.

**"Treating-doctor short-circuit swallowing follow-ups"** — *Yes, materially.* But it is
already fixed (`isBookingOpening`, `prepare-booking.ts:96-100`) and the fix is a hand-written
stage guard. LangGraph would make the guard a graph edge instead of an `if`. Same semantics,
same test surface.

**"Repeated questions"** — *Partially.* The mechanism is real: a node prompt of 400 tokens
containing only "you are choosing a doctor; here is the roster; here is what is already
known" gets far better compliance from Haiku than 4,000 tokens containing that plus twelve
other topics. This is a genuine argument for stage-scoped prompts — obtainable through
`prepareStep` without LangGraph.

**"Tool calls without enough context"** — *Yes.* Stage-scoped tool mounts prevent
`list_available_days` from being callable before a doctor exists. Also obtainable through
`prepareStep`'s `activeTools`.

**"'Other doctors' restarting the flow"** — *Yes, structurally* — see above. Already fixed
behaviourally by `list_doctors` + `isOtherDoctorsRequest`; a stage machine makes the fix
non-regressible.

**"Technical failures caused by unclear workflow state"** — *Partially.* A material share of
observed "technical error" replies trace to **B4** (the expired-request 23505 falling through
`bookingFailure` to `create_failed`) and to unmapped RPC errors — Class B, not Class C. A
graph would report the same failure at the same node.

**Net: LangGraph would materially reduce two of six, partially reduce three, and the sixth is
mostly a database bug. An in-house stage machine achieves the same two-of-six and three
partials.**

---

## 8. What LangGraph would categorically NOT solve — stated plainly

Copied out as its own section because it is the most important negative finding.

1. **Broken SQL / RPCs.** B1 (`auth.role()` vs `security definer`), B2, B3 —
   `approve_ai_patient_intake` fails for every real staff caller. A graph cannot see this.
2. **Missing allow-list tables.** `createClinicScopedAdminClient` throws for any table not in
   its clinic-scoped allow-list. Framework-agnostic.
3. **Wrong provider data.** Doctor directory state, `doctor_unavailability` windows, stale
   `assigned_doctor_id`. Framework-agnostic.
4. **Incorrect availability queries.** `computeAvailability`, the ±15-minute buffer,
   `extract(dow)` alignment, B6's midnight wrap. Framework-agnostic.
5. **Security bugs.** RLS gaps, S1's still-granted legacy RPC, S3's missing FK, existence
   oracles, injection resistance. A framework *adds* surface here; it removes none.
6. **Bad tool implementations.** A tool that returns the wrong roster returns the wrong
   roster from any orchestrator.
7. **Language understanding.** Arabic dialect, transliteration, spelling, digit folding,
   month names. Entirely `human-input.ts` / `entity-resolution.ts`.
8. **Model capability.** If Haiku is the wrong model for a five-stage bilingual workflow,
   changing the orchestrator does not change the model. **Upgrading
   `patient-haiku-bootstrap-v1` to a Sonnet-class route for `patient_booking` is likely a
   larger single reliability win than any orchestration change in this document, and costs
   one line in `lib/ai/platform/registry.ts` plus a certification pass.** That should be
   A/B-tested before any migration is contemplated.
9. **Missing tests.** M3 — "no behavioural test for any new RPC… that is why B1–B4 shipped
   through a green suite." A framework does not write tests.
10. **Operational gaps.** M2's absent expiry sweeper; retention policy for two attachment
    buckets.

---

## 9. Migration strategies compared

Effort in engineer-days assumes one engineer familiar with this codebase, including tests,
review, and the existing gates (`npm test`, `test:integration`, `test:ai-adversarial`,
typecheck, lint, i18n, RTL).

### Option 1 — Keep current architecture (do nothing structural)

| Dimension | Assessment |
| --- | --- |
| Effort | 0 d |
| Migration risk | None |
| Reliability improvement | **Negative over time** — the three ad-hoc stage guards will keep multiplying and drifting |
| Maintainability | Degrading — workflow lives in two natural-language prompts |
| Testability | Good for tools, poor for workflow (no stage to assert) |
| Operational complexity | Lowest |

**Verdict:** not acceptable as a final answer, but correct as the *baseline* against which
the Class B database blockers must be fixed first. **B1–B4 must be fixed regardless of any
architecture decision, and they outrank every option here.**

### Option 2 — Full migration to LangGraph

| Dimension | Assessment |
| --- | --- |
| Effort | **25–40 d** (graph design 5, AI-SDK↔LangChain adapter for `prepareAiExecution` 6–10, re-register + re-wrap 11 tools 4, checkpointer + migration 3, re-run/port 136 adversarial + ~100 eval cases + the p5b orchestration suite 6, observability 3, rollout 3) |
| Migration risk | **High.** Touches the certified execution path, the tool wrapper, and the security choke point simultaneously |
| Reliability improvement | **Moderate** on Class C; **zero** on Classes B and D |
| Maintainability | Mixed — better workflow legibility, worse dependency and adapter surface |
| Testability | Node-level good; end-to-end harder than today's mockable `runAgent` |
| Operational complexity | **High** — new deps, checkpointer schema, LangSmith-or-nothing observability |

**Verdict: rejected.** The cost is dominated by the adapter to `lib/ai/platform/`, which
buys no user-visible value.

### Option 3 — Hybrid LangGraph (orchestration only; tools/security/domain untouched)

| Dimension | Assessment |
| --- | --- |
| Effort | **12–20 d** |
| Migration risk | **Medium** — still needs the model adapter (C1); still must reproduce `protectPatientTool` exactly |
| Reliability improvement | **Moderate** on Class C |
| Maintainability | Good workflow legibility; permanent LangChain dependency |
| Testability | Good |
| Operational complexity | Medium-high |

**Verdict: the only defensible LangGraph shape**, and the right one *if* a framework is
mandated. Not recommended now, because Option 4 delivers the same Class-C improvement for
roughly a quarter of the effort and none of C1/C4/C5/C6.

### Option 4 — Own small typed state machine (**recommended**)

Built on `prepareStep` in the existing `ToolLoopAgent`, plus one new persisted column, plus
one pure `nextStage()` / `allowedToolsForStage()` module.

| Dimension | Assessment |
| --- | --- |
| Effort | **4–7 d** (types + pure transition module 1.5, migration column + `set_conversation_ai_state` extension 0.5, `prepareStep` wiring 1, per-stage prompt fragments EN/AR 1.5, tests + eval re-run 1.5, shadow rollout 1) |
| Migration risk | **Low** — additive; shadow mode first; a feature flag reverts to today's flat mount instantly |
| Reliability improvement | **Moderate-to-high** on Class C, equal to LangGraph's realistic ceiling here |
| Maintainability | **Best** — the workflow is one typed file, reviewable in a single sitting, in the same language and idiom as the rest of `lib/ai` |
| Testability | **Best** — `nextStage()` is pure, exhaustively testable per transition, and composes with the existing eval corpus |
| Operational complexity | **Lowest of the three change options** — no new dependency, no new runtime, no new trace store |

**Verdict: recommended.** It is also the correct *precondition* for a later LangGraph
migration: once stages are explicit and typed, porting them to a graph — if that ever proves
necessary — becomes mechanical rather than exploratory.

---

## 10. Proposed state shape (design only — deliberately NOT implemented)

Shown as the state a LangGraph channel set *or* an in-house machine would carry. It is a
**design artefact**; no code was written. Field-level notes matter more than the field list.

```
PatientConversationState {
  // ---- identity of the exchange (server-owned, never model-writable) ----
  conversationId        : uuid            // from verified channel routing
  clinicId              : uuid            // from verified channel routing
  locale                : "ar" | "en"
  clinicTimezone        : string
  clinicCountry         : string          // decides how 12/9 is read

  // ---- who we are talking to ----
  patientStatus         : "unknown" | "unlinked" | "linked_unverified"
                        | "linked_verified" | "intake_staged"
  verifiedPatientId     : uuid | null     // ADVISORY MIRROR ONLY — see note 1
  intakeId              : uuid | null     // ai_patient_intakes.id, advisory mirror

  // ---- booking selection ----
  selectedDepartmentId  : uuid | null
  selectedDepartmentName: string | null   // display only, never an authz input
  selectedDoctorId      : uuid | null
  selectedDoctorName    : string | null
  treatingDoctorId      : uuid | null     // recommendation, never a default booking
  selectedDate          : "YYYY-MM-DD" | null
  selectedSlot          : minutes-past-midnight | null
  offeredSlots          : readonly string[]   // note 3

  // ---- intake fields (already exist as SLOT_FIELDS) ----
  fullName | nationalId | dateOfBirth | email | gender | phone : canonical | null

  // ---- conversation control ----
  bookingStage          : "idle" | "identifying" | "intake_collecting"
                        | "selecting_department" | "selecting_doctor"
                        | "selecting_day" | "selecting_time"
                        | "confirming" | "submitted" | "escalated"
  missingFields         : readonly SlotField[]        // derived, never stored
  unresolvedAmbiguity   : PendingClarification | null // exactly one, as today
  humanTakeover         : boolean         // MIRROR of conversations.ai_paused_at
  lastToolOutcome       : { tool, outcome, at } | null
  turnCount             : number
  stageEnteredAt        : ISO instant
}
```

**Note 1 — `verifiedPatientId` and `humanTakeover` must be treated as advisory mirrors, not
as truth.** This is the single most important design constraint. Both are re-derived on
**every** tool call by `authorizePatientConversation()` → `resolvePatientAiContext` →
clinic/conversation pair re-check. If any tool ever reads `state.verifiedPatientId` in place
of calling that function, the entire identity model collapses. The safest implementation
omits `verifiedPatientId` from the persisted state entirely and keeps only
`patientStatus` — which is not an authorization input.

**Note 2 — persistence.** `bookingStage`, `stageEnteredAt` and `turnCount` belong in a new
narrow column (e.g. `conversations.ai_booking_stage`), written **only** by an extended
`set_conversation_ai_state`, and parsed by a `parseBookingStage()` that rejects anything
outside the literal union — mirroring `parseCollectedData`'s discipline exactly. Everything
else already lives in `ai_collected_data` and needs no schema change.

**Note 3 — `offeredSlots`** closes a real hole: today nothing structurally prevents
`create_preliminary_booking` from being called with a time the assistant hallucinated rather
than one `check_availability` returned. `resolveOptionIndex` covers the "first one" case only.
Recording what was actually offered lets `create_preliminary_booking` reject a slot that was
never presented, at the server, with no model cooperation required.

**Note 4 — `missingFields` should be derived, never stored.** Storing it creates a second
source of truth that can disagree with `collected`. Compute it from
`(requiredForStage(bookingStage) minus keys(collected))`.

---

## 11. Recommended phased plan, with rollback

Everything below is additive and independently revertable. **Phase 0 is mandatory and
outranks every other phase.**

### Phase 0 — Fix the database blockers first (prerequisite, not optional)
Fix P8 **B1, B2, B3, B4**, add the **M2** sweeper, drop the **S1** legacy RPC, and add the
**M3** behavioural RPC tests. No orchestration change is meaningful while
`approve_ai_patient_intake` fails 100% of the time and an expired request bricks re-booking
forever. *Rollback: standard migration revert.*

### Phase 0.5 — Test the cheapest hypothesis before building anything
Run the existing live eval (`AI_EVAL_LIVE=1`) with `patient_booking` pointed at a
Sonnet-class certified route instead of `patient-haiku-bootstrap-v1`, and with
`maxSteps` raised from 6 to 10. Measure the Section 12 metrics. **If a model/step change
recovers most of the Class-C failures, the architecture question largely dissolves and the
remaining work is Phase 1 only.** *Rollback: one-line registry revert.*

### Phase 1 — Shadow stage tracking (no behaviour change)
Derive `bookingStage` server-side from existing collected state on every turn and record it
to `audit_logs` alongside the tool outcome. Change nothing about prompts or tool mounts.
This delivers the observability gap immediately and produces the dataset needed to justify
(or refute) Phase 2. *Rollback: stop writing the field.*

### Phase 2 — Persist the stage and enforce transitions server-side
Add the column, extend `set_conversation_ai_state`, add pure `nextStage()`. Tools begin
*reporting* illegal transitions to Sentry without blocking them. *Rollback: ignore the
column.*

### Phase 3 — Stage-scoped tool mounts and prompt fragments (behind a flag)
Use `prepareStep` to return `activeTools` and a stage-specific `system` fragment appended to
a slimmed base prompt. Ship behind a per-clinic flag; roll out to one pilot clinic first.
Re-run the full adversarial corpus (136) and the eval set (~100) against the **new** mount —
this is the gate that protects the security posture. *Rollback: flag off returns the flat
mount and the full prompt on the next inbound message; no state migration needed, because
the stage column is additive and ignorable.*

### Phase 4 — Consolidate the ad-hoc guards
Replace the hand-rolled stage logic in `prepare-booking.ts` (`isBookingOpening`),
`list-doctors.ts` (implied department) and `list-available-days.ts` (implied doctor) with
calls into the one transition module. *Rollback: git revert; behaviour is equivalent by
construction, so this must be a pure refactor with unchanged tests.*

### Phase 5 (conditional) — Only if Phase 3 proves insufficient
Re-evaluate a framework, with the Section 13 triggers as the decision criteria, and with
Mastra / Inngest AgentKit / XState evaluated alongside LangGraph.js rather than assuming
LangGraph.

**Rollback posture throughout:** the assistant already degrades to a human on every failure
(`escalateConversation`, `suggested_paused`, `buildPatientTechnicalFallback`). Any phase that
misbehaves produces a staff suggestion instead of a bad patient message — the blast radius is
bounded by design and must stay that way.

---

## 12. Measurable acceptance criteria

A change is only "better" if these move. Baselines must be captured during Phase 1's shadow
period **before** any behavioural change ships.

### Conversation quality (primary)
| Metric | Definition | Target |
| --- | --- | --- |
| Repeated-question rate | Turns asking for a field already present in `ai_collected_data` / booking-flow conversations | **≥ 60% reduction** |
| Flow-restart rate | Conversations returning to `selecting_department` after `selectedDoctorId` was set | **≥ 80% reduction** (target: near zero — a stage machine makes it structural) |
| "Other doctors" success | Conversations containing an `isOtherDoctorsRequest` match that receive a roster without re-asking the department | **≥ 95%** |
| Booking completion rate | Conversations reaching `bookingStage = submitted` / conversations reaching `selecting_department` | **+15 pp or better** |
| Turns to booking | Median inbound messages from first booking intent to `submitted` | **≤ current − 2** |
| Technical-fallback rate | Turns returning `buildPatientTechnicalFallback` | **≥ 70% reduction** (most of this is Phase 0, not Phase 3) |
| Unnecessary escalation rate | `low_confidence` escalations on conversations that had a resolvable stage | **≥ 50% reduction** |

### Safety and correctness (gates — must not regress at all)
| Gate | Requirement |
| --- | --- |
| `npm run test:ai-adversarial` | **136/136 pass against the new mount.** Any regression blocks the change outright. |
| Eval consistency score | ≥ `EVAL_PASS_THRESHOLD`, offline mode, unchanged corpus |
| Live eval (`AI_EVAL_LIVE=1`) | Patient cases: tool-choice accuracy **≥ baseline**, forbidden-tool calls **= 0** |
| Identity path | Zero fuzzy resolver imports in any identity file (grep gate, as P8/P3 verified) |
| Automated `public.patients` writes | **0** — assert by count, as P8/P1 did |
| Cross-tenant | Integration RLS suite green |
| `npm test` / `test:integration` / typecheck / lint / i18n / RTL | All green |

### Operational
| Metric | Target |
| --- | --- |
| p50 / p95 reply latency | **No worse than baseline.** A framework that adds a round trip must pay for it in quality — if p50 rises >20% without hitting the quality targets, revert. |
| Tokens per conversation | ≤ baseline (stage-scoped prompts should reduce this) |
| Cost per completed booking | **≤ baseline** |
| Sentry `patient-ai-tool` exception rate | ≥ 50% reduction (mostly Phase 0) |
| Mean time to reproduce a reported conversation bug | **≥ 70% reduction** — this is what Phase 1's stage trace is for, and it is the most honest measure of the observability claim |

**Decision rule:** if Phase 3 does not deliver the primary conversation-quality targets while
holding every safety gate and the latency budget, **do not escalate to a framework** —
re-examine the model choice (Phase 0.5) and the prompt instead, because the failure would be
evidence that the bottleneck was never orchestration topology.

---

## 13. When to revisit LangGraph

Re-open this decision if **two or more** of the following become true:

1. The workflow grows past roughly ten stages, or acquires genuine parallel branches
   (e.g. simultaneous multi-doctor availability negotiation).
2. A real multi-agent decomposition is needed (a triage agent handing to a booking agent
   handing to a billing agent) rather than one assistant with more tools.
3. A genuinely long-running agentic flow appears that must survive process restarts
   *mid-execution*, not merely between turns.
4. A self-hostable, PHI-safe trace store is stood up, making LangSmith-class observability
   available without a third-party data flow.
5. The in-house transition module exceeds ~1,500 lines or starts growing its own scheduler,
   retry policy and interrupt semantics — at which point it is a framework, and using a
   maintained one is the better trade.
6. LangGraph.js reaches feature parity with the Python implementation and ships a
   first-class Vercel AI SDK model adapter, eliminating cost C1.

---

## 14. What must remain untouched, under every option

Non-negotiable. If any migration proposal requires changing an item on this list, that
proposal is wrong.

- **Patient identity rules.** `authorizePatientConversation`, `resolvePatientAiContext`,
  `verify_patient_conversation_dob`, `stage_patient_intake_from_conversation`, the exact
  `fold_*` matching, the 5-failure / 30-minute lock, the "a refusal is free" property
  (resolution runs strictly before any rate-limited RPC).
- **Authorization / RLS / entitlements.** `getEntitlements` + `hasFeature`, the clinic/
  conversation pair re-check, `createClinicScopedAdminClient`'s allow-list, every RLS policy
  and `protect_*` trigger.
- **The appointment availability engine.** `computeAvailability`, `lib/booking/patient.ts`,
  `ai_requested_slot_is_available`, the ±15-minute buffer, `doctor_schedules` /
  `clinic_working_hours` / `doctor_unavailability`.
- **Booking rules.** The 24-hour minimum notice, `patient_pending_cap`, `slot_pending_cap`,
  pending-and-expiring semantics, "never say confirmed".
- **Provisional patient approval.** `ai_patient_intakes`, `approve_ai_patient_intake`, the
  review UI. This stays as durable, RLS-protected, dashboard-visible rows — **never** as
  framework checkpoint state.
- **Audit.** `logAgentTool` → `toolAuditSummary` redaction → `audit_logs` with
  `actor_type='ai'`, `actor_id NULL`, and `source='ai_assistant_review'` on human approval.
- **Provider / WhatsApp connection logic.** The worker, `classifyJid`, the H2 delivery spool,
  the HMAC callback, encrypted auth state, `persist_whatsapp_inbound`, echo mirroring.
- **The deterministic layers.** `human-input.ts`, `collected-state.ts`'s pure resolver,
  `patient-escalation.ts`, `entity-resolution.ts` (fuzzy for doctors/departments **only**).
- **The safety choke point.** `protectPatientTool` — sanitisation, provenance, denial
  auditing, technical-fallback degradation. Any re-registration of tools must reproduce it
  exactly, and the 136-case injection corpus is the gate that proves it did.
- **Degradation to human.** Every failure path ending in `escalateConversation`,
  `suggested_paused`, or a staff suggestion.

---

## 15. Final answers to the eight questions

**1. Is LangGraph actually better than the current implementation for ClinicFlow?**
No. It is better than the *L2 model loop* in isolation on two axes — explicit workflow
topology and stage-scoped tool mounting — and worse or neutral on latency, dependency
weight, observability-without-a-third-party, integration with the certified execution
platform, and fit with ClinicFlow's DB-resident human-in-the-loop model. The current
architecture's real weakness is that its five-stage workflow lives in prose executed by
Haiku with a six-step budget; that is fixable without a framework.

**2. What exact problems would it solve?**
Four, structurally: (a) the treating-doctor short-circuit swallowing follow-ups; (b) "other
doctors" restarting the flow; (c) tools being callable with insufficient context; (d)
repeated questions caused by an over-long single prompt. Plus one soft win: per-turn
workflow traceability.

**3. What problems would remain exactly the same?**
Everything in Section 8: broken SQL/RPCs (B1–B4), missing allow-list tables, wrong provider
data, incorrect availability queries, all security bugs, bad tool implementations, Arabic/
English understanding, spelling and transliteration, fragmented-answer resolution,
corrections, model capability, missing tests, and the absent expiry sweeper. Also latency,
which gets worse.

**4. Is the expected benefit large enough to justify migration now?**
No. The four problems LangGraph solves are all solvable by an explicit typed stage machine
built on `prepareStep`, which the codebase already calls, at roughly 4–7 engineer-days versus
12–20 (hybrid) or 25–40 (full). And a material share of the currently-visible pain is
Class B database defects that **must** be fixed first and will change the picture once they
are.

**5. If yes, full or hybrid LangGraph?**
If a framework is mandated despite the above: **hybrid only** — LangGraph owns conversational
orchestration and state; every ClinicFlow tool, RPC, security check, availability
computation, approval flow and audit path stays exactly where it is, and graph state is never
an authorization input. Full migration is rejected outright.

**6. What parts of the current code should remain untouched?**
Section 14 in full — identity, authorization/RLS/entitlements, availability engine, booking
rules, provisional approval, audit, WhatsApp/provider logic, the deterministic parsing and
escalation layers, `protectPatientTool`, and every degrade-to-human path.

**7. What is the safest phased migration plan with rollback?**
Section 11: **Phase 0** fix B1–B4 + M2 + S1 + M3 (prerequisite) → **Phase 0.5** test a
Sonnet-class route and `maxSteps` 10 first, because it may dissolve the problem for one line
of config → **Phase 1** shadow stage tracking (observability, zero behaviour change) →
**Phase 2** persist the stage, report illegal transitions without blocking → **Phase 3**
stage-scoped tool mounts and prompt fragments behind a per-clinic flag, gated on the full
adversarial and eval corpora → **Phase 4** consolidate the three ad-hoc guards → **Phase 5**
re-evaluate a framework only if Phase 3 falls short. Every phase is additive; rollback is a
flag flip or an ignored column, and the assistant's existing degrade-to-human behaviour
bounds the blast radius throughout.

**8. What measurable acceptance criteria would prove the migration is better?**
Section 12: ≥60% fewer repeated questions, ≥80% fewer flow restarts, ≥95% "other doctors"
success, +15pp booking completion, ≥2 fewer median turns to booking, ≥70% fewer technical
fallbacks, ≥50% fewer unnecessary escalations, ≥70% faster bug reproduction — while holding
**136/136 adversarial**, zero forbidden-tool calls, zero automated `public.patients` writes,
green RLS/i18n/RTL/typecheck/lint, and p50 latency within 20% of baseline. If those quality
targets are not met, the bottleneck was not orchestration topology, and the correct response
is to change the model and the prompt, not the framework.

---

*Study only. No production code, prompt, tool, dependency, migration or deployment was
changed in producing this document.*

---

## Appendix A — implementation status (added 2026-08-23)

Option 4 was implemented. See
[`AI_ASSISTANT_TYPED_BOOKING_STATE_IMPLEMENTATION.md`](./AI_ASSISTANT_TYPED_BOOKING_STATE_IMPLEMENTATION.md)
for the full report: stage model, transition rules, stage-scoped tool map, prompt scoping,
files changed, the migration, tests and measured results.

Deltas worth reading back into this document:

* **Section 11, Phase 0** — B1–B4, S1 and M2 were already fixed by
  `20260822120000_ai_patient_intake_booking_upgrade.sql` and
  `20260822190000_ai_patient_intake_booking_followup.sql`. Verified, not re-fixed.
* **Section 11, Phase 0.5** — the harness exists and runs on one command, but the live
  Haiku-vs-Sonnet comparison **did not execute**: the AI Gateway account in this
  environment is free-tier and rate-limited. No model change was made, because the
  decision rule in Section 12 forbids one without a measured result. `patient_booking`
  still points at `patient-haiku-bootstrap-v1` with `maxSteps: 6`, and
  `lib/ai/platform/registry.ts` was not touched.
* **Section 10, Note 3 (`offeredSlots`)** — implemented and enforced server-side in
  `create_preliminary_booking`, covering both the natural date/time path and the
  `scheduled_at` path.
* **Section 12** — the study's acceptance criteria split into judgement metrics (need a
  live model; blocked) and structural metrics (properties of the orchestration; measured
  deterministically with a scripted non-compliant model). The structural results are in
  §3.3 of the implementation report.
* **Correction to the implied tool map.** Holding `create_preliminary_booking` back to
  `confirming`, and `check_availability` back to `selecting_time`, are both **deadlocks**:
  those tools are the only writers of `appointment_time` and `appointment_date`
  respectively. The shipped table mounts `check_availability` from `selecting_day` and
  `create_preliminary_booking` from `selecting_time`; the remaining gap is closed by the
  offered-options guard rather than by the mount.
