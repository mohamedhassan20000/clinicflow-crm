# ClinicFlow — Staff/User AI Assistant: current-architecture improvements

Implementation date: 2026-08-24
Branch: `feat/p7-manual-qa-polish`
Input: `docs/reviews/AI_STAFF_ASSISTANT_OPEN_SOURCE_ARCHITECTURE_STUDY.md` (2026-08-24)

Scope: the study's Option B — improve the architecture that exists. **No agent or
orchestration framework was introduced.** No LangGraph, no Deep Agents, no Microsoft Agent
Framework, no Mastra, no OpenAI Agents SDK, no `WorkflowAgent`. Zero new runtime
dependencies. Zero migrations. The Patient/WhatsApp booking assistant is untouched.

The Staff Assistant still runs exactly the mandated shape:

```
LLM → ToolLoopAgent (ai@6) → ClinicFlow tools/actions/resources
    → authorization + domain logic → RLS / RPC / Postgres
```

---

## 1. Exact limitations found in the current code

Each was verified by reading the code on this branch, not taken from the study on trust.

### L1 — Cross-turn tool amnesia (confirmed, as described)

`lib/ai/conversation-parts.ts:20-25` filtered every non-text part out of history:

```ts
export function modelSafeHistory(messages: UIMessage[]): UIMessage[] {
  return messages.map((message) => ({
    ...message,
    parts: message.parts.filter((part) => part.type === "text"),
  }));
}
```

So every prior turn reached the model as prose only. The UI kept the tool cards
(`boundedAssistantParts`); the model did not. A two-turn task — "list today's
appointments, find the unconfirmed ones" then "prepare follow-ups for those three" —
reasoned in turn 2 over the assistant's own summary of turn 1. `active_context` holds at
most one entity per type, so an N-patient working set had nowhere to live.

### L2 — No staff tool-call repair (confirmed)

`lib/ai/patient-agent.ts` mounts `experimental_repairToolCall`; `lib/ai/staff-agent.ts`
mounted nothing. A malformed staff tool call never reaches `execute`, therefore never
reaches `harden()` — so it was **not sanitized, not audited, and not converted into a
recoverable result**. It surfaced as a `tool-output-error` part carrying a raw validator
string.

### L2a — A latent gap in the existing repair primitive (new finding)

While adapting the patient repair I found that its argument-subtraction loop reads only
`issue.path[0]`. Zod reports a `.strict()` violation as `unrecognized_keys` with an
**empty path** and the offending names in `issue.keys`. An extra argument on a strict
schema — the single most common malformation — was therefore unrepairable by subtraction
and fell through to the blanket fallback. The staff implementation handles both shapes;
measured effect is in §5. `lib/ai/tool-call-repair.ts` (patient) still has the original
behaviour and was deliberately **not** changed — see §8.

### L3 — `staff_clinical_summary` had no step headroom (confirmed and quantified)

`maxSteps: 8`. The representative doctor task measures at 6 model steps (resolve patient →
appointments → prescriptions → notes → `describe_action` → preview). One clarification
round-trip costs 2 steps and one mis-emitted filter costs 1, so the realistic worst case
was 9 against a budget of 8. Every other certified staff class had margin
(administrative 20, operational 20, composite 25, help 4).

### L4 — No loop or dead-end detection (confirmed)

`stopWhen` was `stepCountIs(maxSteps)` alone. Nothing detected a model repeating one
identical call or failing the same schema repeatedly; the only stop was exhaustion of the
budget.

### L5 — CI measured rubric consistency, not answer quality (confirmed)

`pnpm test:ai-adversarial` asserts that every eval rubric is *expressible* inside the
authorization model — "is every expected tool reachable for this persona?" It does not
measure tool selection, action/resource selection, forbidden-capability containment,
hallucinated capability, unnecessary refusal or escalation, multi-step completion, policy
adherence, or role-specific authorization behaviour. A change that made the assistant pick
the wrong tool 30% more often passed CI.

### L6 — The AI unit suites were not in the required CI job (new finding, not fixed here)

The `Unit tests` step runs `tests/unit/{actions,components,db,lib,pages,security}` plus
`sanity.test.ts`. **`tests/unit/ai` and `tests/unit/api` are not in that list**; only the
two P6A files reached CI, through `test:ai-adversarial`. The scored gate added here is
wired as its own required step for the same reason, but the broader omission is a CI
configuration question outside this study's recommendations and is left flagged rather
than silently widened. See §8.

### L7 — A genuinely flaky security test (new finding, fixed)

`tests/unit/ai/phase3-action-foundation.test.ts` forged a confirm token by replacing its
last character with `"A"`. The signature is base64url of 32 bytes, so its final character
carries only two significant bits and is always one of `A/Q/g/w` — about a quarter of runs
"forged" a token identical to the original, the execution legitimately succeeded, and the
assertion failed. Reproduced at 2 failures in 8 runs before the fix, 0 in 10 after.

---

## 2. What was implemented

### 2.1 Scored staff eval gate (required, deterministic)

`lib/ai/eval/staff-scenarios.ts` — 28 representative scenarios, ≥5 per role across Admin,
Manager, Receptionist, Doctor and Assistant, EN and AR, each carrying the tools, actions,
resources, task class, expected step cost, policy dimensions and (where relevant) a
dependent second turn that an ideal answer involves.

`lib/ai/eval/staff-scorecard.ts` — a twelve-dimension scorer covering every measurement the
brief asked for:

| Requested measurement | Dimension |
|---|---|
| correct tool selection | `toolSelection` |
| correct action/resource selection | `actionResourceSelection` |
| forbidden tool/action rate | `forbiddenContainment` (residual = 1 − score) |
| hallucinated capability rate | `hallucinatedCapability` |
| unnecessary refusal rate | `unnecessaryRefusal` |
| unnecessary escalation rate | `unnecessaryEscalation` |
| multi-step staff task completion | `stepBudgetFit`, `stepHeadroom` |
| clinical/privacy policy adherence | `policyAdherence` |
| role-specific authorization behaviour | `roleAuthorization` |
| (added) routing correctness | `taskRouting` |
| (added) cross-turn memory coverage | `crossTurnMemory` |

**Why deterministic.** Every number is computed from the product's own artifacts — the tool,
action and resource registries, the deterministic router, the certified task policies, and
the real system prompt — with no model, no network and no database. That is what makes it
safe to mark **required** in CI. The brief's constraint was explicit, and it is honoured:
the flaky, credential-dependent, spend-dependent half is *not* mandatory. The same scorer
also exposes `gradeObservedStaffTurn` / `scoreStaffObservedRun`, which grade real observed
turns on the same twelve dimensions plus latency, token, failed-call and repaired-call
rates. That live path is opt-in; its scoring logic is unit-tested in CI against synthetic
observations so the two can never fork.

Regression policy: `docs/reviews/artifacts/staff-eval-baseline.json` holds a committed
baseline per dimension with a per-dimension tolerance. Tolerance is **0** for the
security-relevant dimensions (hallucinated capability, forbidden containment, unnecessary
refusal/escalation, role authorization, tool and action/resource selection, policy
adherence, step-budget fit, cross-turn memory) — a regression there is a defect, not a dip —
and **0.05** for the two quality dimensions (`taskRouting`, `stepHeadroom`), which is one
scenario of movement in a 28-scenario corpus. The corpus is also asserted not to shrink, so
a score cannot improve by deleting a hard case.

### 2.2 Safe cross-turn tool memory

`lib/ai/staff-tool-memory.ts` (new, pure module — no `server-only`, no I/O, no registry
imports) projects a bounded, sanitized, allow-listed recall of recent read-tool results and
injects it as an explicitly labelled assistant message.

Five containment rules, each tested:

1. **Tool allow-list.** 21 read/describe tools, declared with their replayable output
   fields. `execute_action` is excluded from the allow-list *and* named in a second
   `NEVER_REPLAYABLE_TOOLS` set, so a careless future edit still fails.
2. **Live-mount gate.** A part is replayed only if its tool is mounted for *this* turn. A
   permission revoked between turns unmounts the tool, and the memory goes with it.
3. **Field allow-list.** Only the declared top-level output keys of that tool are projected.
   A key a future tool adds is dropped, not kept.
4. **Sensitive/internal-key scrub.** Credentials and capability handles (`*token*`,
   `*password*`, `*secret*`, `*signature*`, `*hmac*`, `*api_key*`, `*nonce*`, `*digest*`,
   `national_id`, …) and internal plumbing ids (`clinic_id`, `user_id`, `auth_user_id`,
   `created_by`, `conversation_id`, …) are removed at any depth. Entity ids the next turn
   genuinely needs — `id`, `patient_id`, `appointment_id`, `invoice_id`, `doctor_id`,
   `department_id` — are kept, because they *are* the working set the feature exists for.
5. **Bounds.** Last 2 assistant turns · ≤6 parts · ≤10 rows per result (with an explicit
   `…N more omitted` marker rather than a silent truncation) · ≤12 items per other array ·
   ≤240 chars per string · depth ≤4 · ≤4 KB per part · ≤12 KB total. An oversized
   projection is dropped whole rather than clipped.

Two further exclusions: a `permission_denied` result is never replayed (a permission
verdict must never be cached), and only `state: "output-available"` parts are eligible
(never an errored or still-streaming part).

**Memory is context, never authorization.** The recall block says so in the text the model
reads, and structurally: nothing about it is consulted by any authorization check, and every
tool call made on the strength of a recalled row runs the full role → entitlement →
per-user-permission → RLS stack on that call. Contents were already sanitized by
`sanitizeUntrustedDeep` at the mount boundary and redacted by `boundedAssistantParts` before
persistence, and are read back from an RLS-scoped row belonging to the same user in the same
conversation — so replay puts back in front of the model only what this user already saw
here.

Placement: injected via `prepareStep` as an assistant message immediately before the last
user message. Deliberately **not** the system prompt — recalled content is tenant data, and
tenant data does not get system-level authority even after sanitisation. Storage and audit
behaviour is unchanged: `persistedAssistantState`, `boundedAssistantParts`,
`pendingConfirmations` and `modelSafeHistory` itself are byte-for-byte as they were.

### 2.3 Staff tool-call repair

`lib/ai/staff-tool-call-repair.ts` (new), adapted from the proven patient primitive
(`lib/ai/tool-call-repair.ts`), with a staff-shaped policy that **only ever subtracts**:

1. match the tool name case-, punctuation- and namespace-insensitively against the
   **mounted** tools;
2. drop arguments that fail validation, one offending key at a time — handling both
   `path[0]` errors and `unrecognized_keys` (§L2a);
3. otherwise fall back to a mounted, argument-free discovery tool
   (`describe_capabilities` → `describe_action` → `list_my_capabilities`);
4. otherwise return `null` and let the original error reach the model.

Never: invents an id (there is no code path that writes a value — only `delete`), invents a
permission (the target comes from the mount, resolved from the authenticated caller before
the model ran), fabricates a required identity field (subtraction cannot add one; a call
needing a uuid it did not carry lands on discovery), or turns a denied operation into an
allowed one (`execute_action` is barred as a repair *target*, so a malformed write is never
rewritten into a valid write — the model must re-emit it, and the full preview → signed-token
→ human-confirm pipeline runs unchanged).

Every repair is audited through the existing redacted `logAgentTool` path as
`staff_tool_call_repaired`, carrying enumerated labels only: the requested tool, the repaired
tool, whether the name matched, the dropped argument **names**, and the outcome. Never a
value — a dropped filter value is very often a patient's name. Pinned by a test.

### 2.4 Multi-step headroom, with guards

`staff_clinical_summary.maxSteps: 8 → 12`, and **only** there. Version bumped to
`p7s-staff-clinical-summary-policy-v2`. The administrative (20), operational (20), composite
(25) and help (4) classes are unchanged — none of them was measured tight, and a global
raise would buy an unproductive model more budget to spend.

`lib/ai/staff-loop-guard.ts` (new, pure module) adds two **recoverable** stop conditions
beside the step cap:

- **`repeated_tool_call`** — the same tool with the same arguments three times in one turn.
  Threshold 3, not 2, because the second call is a legitimate retry that the document
  tool's own description prescribes. Argument comparison is key-order-insensitive.
- **`repeated_tool_failure`** — four failed tool calls in one turn.

Both end the tool loop rather than aborting: the model produces its final message from what
it has, the turn is persisted, the ledger reconciles it as the success it is, and no error
surface changes.

### 2.5 Not implemented, and why

The study lists five primitives. Two are outside this brief and were left alone: the
**plan artifact** (§12.3) and **OTel step tracing** (§12.4), which the brief did not ask
for and which would have added UI surface and infrastructure respectively. `activeTools`
narrowing (§12.6, second half) is explicitly marked "measure before shipping" in the study
and the mount permissiveness is pinned by an existing invariant test; it was not touched.

---

## 3. Files changed

**New (8)**

| File | Lines | Purpose |
|---|---|---|
| `lib/ai/staff-tool-memory.ts` | 397 | Bounded, sanitized, allow-listed cross-turn tool memory |
| `lib/ai/staff-tool-call-repair.ts` | 318 | Staff tool-call repair policy + audit |
| `lib/ai/staff-loop-guard.ts` | 104 | Repeated-call and repeated-failure stop conditions |
| `lib/ai/eval/staff-scenarios.ts` | 442 | 28 representative role-specific staff scenarios |
| `lib/ai/eval/staff-scorecard.ts` | 814 | Twelve-dimension offline scorer + live scorer |
| `tests/unit/ai/staff-eval-gate.test.ts` | 244 | The scored gate (34 assertions) |
| `tests/unit/ai/staff-tool-memory.test.ts` | 316 | Memory usefulness + containment + bounds (19) |
| `tests/unit/ai/staff-tool-call-repair.test.ts` | 343 | Repair invariants, coverage, loop guard (23) |
| `docs/reviews/artifacts/staff-eval-baseline.json` | — | Committed regression baseline |

**Modified (7)**

| File | Change |
|---|---|
| `lib/ai/staff-agent.ts` | Mounts the repair function, projects tool memory against the live mount, injects it in `prepareStep`, adds the two loop-guard stop conditions, accepts an optional `history` |
| `app/api/agent/chat/route.ts` | Passes the unfiltered `uiMessages` to the agent as `history` (8 lines). `modelSafeHistory` is still applied to the messages themselves |
| `lib/ai/platform/registry.ts` | `staff_clinical_summary.maxSteps` 8 → 12, version bumped, rationale documented |
| `tests/unit/ai/p45a-platform.test.ts` | Worst-case reservation 1,620,000 → 2,430,000 µ$ and derived budget limit — arithmetic consequences of the step change (§7) |
| `tests/unit/ai/phase3-action-foundation.test.ts` | Forged-token fix for the pre-existing flake (§L7) |
| `package.json` | `test:ai-staff-gate` script |
| `.github/workflows/ci.yml` | New required `Scored staff eval gate` step |

`lib/ai/conversation-parts.ts` was **not** modified. The study proposed changing
`modelSafeHistory`; putting the projection in the agent instead is what makes the live-mount
gate (rule 2) possible, and it leaves the existing persistence/audit contract and its test
suite untouched.

Total orchestration-side code (`staff-agent` + memory + repair + loop guard) is **~940
lines including comments**, against the study's ~1,500-line "at that point it *is* a
framework" threshold in §15. Still under, and worth re-checking before the next addition.

---

## 4. Feature flags and configuration

| Env var | Default | Effect when set to `off` / `0` / `false` |
|---|---|---|
| `AI_STAFF_TOOL_MEMORY` | on | No recall block is built or injected. History reaches the model as text only — the exact pre-change behaviour. |
| `AI_STAFF_TOOL_CALL_REPAIR` | on | No repair function is mounted. A malformed call becomes a `tool-output-error` part again — the exact pre-change behaviour. |

Both are read at agent-construction time, are independent of each other and of everything
else, and require no deploy coordination, no data change and no migration to flip. Both
defaults are asserted by test.

Not flagged, because reverting them is a one-line change with no state:

- `staff_clinical_summary.maxSteps` — revert the constant in `lib/ai/platform/registry.ts`.
- The loop guards — remove the second entry from `stopWhen`.
- The eval gate — delete the CI step.

---

## 5. Before / after measurements

### 5.1 Deterministic scorecard (28 scenarios, 5 roles, EN + AR)

Both columns are real runs of the same corpus through the same scorer: "before" is the tree
with `maxSteps: 8` and no tool-memory module, "after" is this tree.

| Dimension | Before | After | Δ |
|---|---|---|---|
| `toolSelection` | 1.000 (40/40) | 1.000 (40/40) | — |
| `actionResourceSelection` | 1.000 (18/18) | 1.000 (18/18) | — |
| `forbiddenContainment` | 1.000 (20/20) | 1.000 (20/20) | — |
| `hallucinatedCapability` | 1.000 (78/78) | 1.000 (78/78) | — |
| `taskRouting` | 0.889 (8/9) | 0.889 (8/9) | — |
| `unnecessaryRefusal` | 1.000 (21/21) | 1.000 (21/21) | — |
| `unnecessaryEscalation` | 1.000 (20/20) | 1.000 (20/20) | — |
| `stepBudgetFit` | 1.000 (28/28) | 1.000 (28/28) | — |
| **`stepHeadroom`** | **0.962 (25/26)** | **1.000 (26/26)** | **+0.038** |
| `policyAdherence` | 1.000 (12/12) | 1.000 (12/12) | — |
| `roleAuthorization` | 1.000 (28/28) | 1.000 (28/28) | — |
| **`crossTurnMemory`** | **0.000 (0/2)** | **1.000 (2/2)** | **+1.000** |
| **Overall** | **0.904** | **0.991** | **+0.087** |

Per role, after: admin 0.977 · manager 1.000 · receptionist 1.000 · doctor 1.000 ·
assistant 1.000. **No regression for any role.** Mean expected steps across the corpus: 2.36.

`crossTurnMemory` was 0 *by construction* before, not by measurement accident: history
reached the model as text only, so no turn-1 field could survive into turn 2.

### 5.2 Tool-call repair coverage

Measured over a 12-case corpus of the malformations models actually emit (camelCase,
kebab-case and namespaced tool names, wrong-typed and unknown arguments, filters as a
string, stringified JSON input, unparseable input, a non-uuid record id, an unknown tool, a
malformed write):

| Metric | Before | After |
|---|---|---|
| Malformed calls recovered into a valid call on a mounted tool | 0/12 (0%) | **12/12 (100%)** |
| Recovered *on the tool the model was reaching for* | 0/8 (0%) | **8/8 (100%)** |
| Recoveries landing on `execute_action` | — | **0** (barred) |
| Recoveries inventing an argument | — | **0** (subtraction-only, asserted per key) |

"Before" is 0 by construction: with no repair function mounted, a call the SDK cannot parse
never reaches a tool at all.

The `unrecognized_keys` handling (§L2a) is what moves on-target from 7/8 to 8/8 — without
it, an extra argument on a `.strict()` schema falls through to discovery.

### 5.3 Step budget

| Class | Before | After |
|---|---|---|
| `staff_clinical_summary` | 8 | **12** |
| `staff_administrative` | 20 | 20 |
| `staff_operational_query` | 20 | 20 |
| `staff_composite` | 25 | 25 |
| `staff_help` | 4 | 4 |

Worst-case turn *reservation* for the clinical class rises from 1,620,000 to 2,430,000 µ$
(×1.5, tracking the step count). Actual spend is unaffected: the reservation is worst-case
and is reconciled against real usage when the turn finalizes. The derived
`budgetLimitMicros` scales with it, so the number of turns a clinic may take is unchanged.

### 5.4 What was *not* measured, and why

**Live tool-selection accuracy, task completion rate, average observed steps, failed
tool-call rate in production, latency, and token/context size are not reported, because no
live run was performed.** Running the corpus against the certified model route needs API
credentials, clinic spend, and a seeded fixture clinic; the brief explicitly said not to
make model/network-dependent CI mandatory, and I am not going to quote numbers I did not
produce. The scorer's live half (`scoreStaffObservedRun`) computes every one of those
metrics and is unit-tested, so the harness is ready — the measurement is not done.

Concretely: **this work is not claimed to have improved live tool-selection accuracy.** What
is measured is that a turn-2 dependency can now be satisfied at all (it could not before),
that 12/12 malformed calls now recover (0/12 before), and that the clinical class now has
recovery headroom it did not have. Whether those translate into better answers is exactly
what the gate exists to find out, and finding out requires the live run.

---

## 6. Tests and results

| Suite | Command | Result |
|---|---|---|
| Focused Staff Assistant | `pnpm test:ai-staff-gate` | **76 passed** (3 files) |
| Full unit suite (AI, API, actions, components, db, lib, pages, security) | `npx vitest run --exclude "tests/unit/integration/**"` | **420 files, 3,787 passed, 2 skipped, 0 failed** |
| AI adversarial + P6A evals | `pnpm test:ai-adversarial` | **136 passed** (136-case injection corpus + eval-set) |
| Integration / RLS | `pnpm test:integration` | **64 files, 630 passed, 3 skipped, 0 failed** (local Supabase) |
| Typecheck | `pnpm typecheck` | clean |
| ESLint | `pnpm lint` | 0 errors; new files contribute 0 warnings |
| RTL gate | `pnpm lint:rtl` | clean (742 files) |
| i18n source gate | `pnpm lint:i18n` | clean (455 files) |
| i18n catalog parity | `pnpm i18n:missing` | clean (4,255 messages) |
| i18n unused keys | `pnpm i18n:unused` | clean |
| Production build | `pnpm build` | **succeeded** (exit 0, full route table emitted) |
| Whitespace | `git diff --check` | clean |

New test coverage, by requirement:

**Cross-turn memory (19 assertions)** — turn 2 can use turn 1's result (rows, totals and
file numbers survive); the recall block frames itself as data and not authority; insertion
position is correct and non-destructive; `execute_action` previews and confirm tokens are
never replayed; a tool no longer mounted contributes nothing; a permission denial is never
replayed; non-completed parts are ignored; an unlisted (including future) tool is never
replayed; credential-shaped and internal-plumbing keys are scrubbed at depth; out-of-
allow-list output fields are dropped; every bound (turns, parts, rows, string length, per-
part bytes, total bytes) is enforced, with oversized projections dropped whole and the
newest findings surviving the cap; the flag defaults on and turns off.

**Repair (23 assertions)** — recovers the four name-formatting classes; refuses to fuzzily
attach an unknown name; drops invalid optional args and keeps the rest; repairs name and
args in one pass; handles stringified and unparseable input; falls back to discovery;
abandons rather than inventing a landing place; never lands on `execute_action`; never
rewrites a malformed write into a valid one; **never adds a key the model did not emit**
(asserted key-by-key across three inputs); never fabricates a required identity field; only
ever targets a mounted tool; terminates rather than looping; audits with no argument values;
flag defaults on and turns off. Plus the coverage measurement in §5.2, and 8 loop-guard
assertions (healthy turn not stopped, one retry tolerated, third identical call stops,
key-order-insensitive, failure threshold, unserializable argument survived, empty trace).

**Eval gate (34 assertions)** — corpus composition (5+ scenarios per role, bilingual, unique
ids, non-shrinking, every dimension exercised, refusal/clarify/cite/multi-step/cross-turn
present); one regression assertion per dimension against the committed baseline; overall and
per-role regression; four hard security invariants asserted as absolutes; a role-surface
divergence check; and six live-grader assertions against synthetic turns.

Authorization invariants re-ran **unmodified and green**, as the study requires:
`action-routing-authorization.test.ts`, `action-routing.test.ts`,
`final-b2-action-reachability.test.ts`, `phase7-superset-coverage.test.ts`,
`phase4-conversation-parts.test.ts`, `p4a-authorization.test.ts`,
`phase3-action-foundation.test.ts` (apart from the flake fix in §L7, which changes an
assertion's *input*, not its claim), and the RLS integration suites.

The 136-case injection corpus passes **with replay enabled** — the gate that matters most,
since replayed tool parts are a new path for stored injection to re-enter context.

---

## 7. Security invariants preserved

Nothing on the study's §16 "must remain untouched" list was changed. Specifically:

- **The four-layer authorization stack** — `authorizeStaffAssistant` → `resolveToolMount`
  (role × feature × user permission × task class) → per-tool `execute` re-assertion →
  `assertActionAccess` at both preview and confirm → RLS. Not one line changed.
- **`ACTION_CAPABLE_ROLES` still derived from `AI_ACTION_REGISTRY`**, never listed.
- **The confirmation pipeline** — HMAC-SHA256 token bound to
  `{actionId, inputDigest, userId, clinicId, conversationId, nonce, exp}`, withheld from
  model context by `toModelOutput`, single-use with replay detection, re-authorized at
  confirm, step-up for privileged, `ai_action_receipts`. Untouched, and now defended twice
  more: repair may not target `execute_action`, and memory may not replay its previews.
- **`harden()` at the mount boundary** — `sanitizeUntrustedDeep` + `withProvenance` +
  denial→result conversion + denial/clarification/error auditing. Untouched. Repaired calls
  enter it exactly like any other call; that is the point of repairing *into a mounted tool*
  rather than around one.
- **Server-derived ids only** — `active_context` still accepts ids solely from `resolution`,
  `user_choice` or `page_context`, and `display_label` still never reaches the model. Tool
  memory adds no id source: it replays ids the server already returned to this user, and
  they are advisory exactly as a user-typed id is.
- **The certified execution layer** — `prepareAiExecution` → certified route → ZDR/no-training
  policy → worst-case reservation → per-step `observeStep` → `reconcileAiBudget`. The only
  change is one policy constant, versioned, with the reservation arithmetic following it.
  `assertAiInputWithinPolicy` now runs on the messages *actually sent*, so recall counts
  against the same certified per-step input budget as everything else.
- **Deterministic routing that selects policy, never authority** — untouched, including
  guard 3 and the `staff_help` containment property.
- **Audit** — `logAgentTool` → `toolAuditSummary` redaction → `audit_logs` with
  `actor_type='ai'`. Extended by one new event type, through the same redaction path.
- **Tenant isolation and RLS** — no new store, no checkpoint table, no cache. Tool memory is
  derived, in-process, per-turn, from rows the caller's own RLS client already read.
- **The patient booking assistant** — entirely untouched, including its repair primitive,
  its prompts, its stage machine and its tools.

Explicit non-goals honoured: no framework, no new runtime dependency, no migration, no
schema change, no data backfill, nothing deployed, nothing pushed, nothing committed.

---

## 8. Remaining limitations

1. **No live measurement.** §5.4. The gate measures structure; answer quality against a real
   model is unmeasured. This is the study's own §15 threshold #9 and it remains open. Running
   `scoreStaffObservedRun` against a seeded fixture clinic is the next step and needs
   credentials and a budget decision.
2. **`taskRouting` sits at 8/9.** The composite scenario *"Find tomorrow's schedule gaps,
   check who has an open follow-up, and prepare a document summarising it"* routes to
   `staff_operational_query`, not `staff_composite`. Consequence is budget only (20 steps vs
   25, same model, same mount), and the scenario needs 6 — so no capability is lost. The
   router was **not** changed: widening `WORKFLOW_INTENT_RE` is a change to a
   security-adjacent deterministic component and belongs in its own reviewed change with its
   own pinning tests. Recorded in the baseline so it cannot silently get worse.
3. **`tests/unit/ai` and `tests/unit/api` are still absent from the CI `Unit tests` step**
   (§L6). The scored gate and the P6A suites run as their own steps, but ~100 AI test files
   still do not gate a PR. Fixing this is a CI configuration change, not a study
   recommendation, and widening it could surface unrelated pre-existing failures — so it is
   flagged, not done.
4. **The patient repair still has the `unrecognized_keys` gap** (§L2a). Fixing it would
   change patient booking behaviour, which the brief put out of scope. It is a real,
   low-risk improvement and should be its own change.
5. **Tool memory does not summarise, only projects.** A 40-row result replays 10 rows plus an
   omission marker; it does not produce a semantic digest. That is deliberate — summarisation
   would put a model in the sanitisation path — but it means very wide working sets still
   need a re-query.
6. **The recall block is injected on every step**, because `prepareStep`'s messages apply to
   one step only. Cost is bounded by the 12 KB cap and counted against the per-step input
   budget, but it is not free on a long composite turn.
7. **No plan artifact and no OTel step tracing** (study §12.3/§12.4). Out of this brief's
   scope; still the study's remaining recommendations.
8. **`activeTools` narrowing** is untouched, per the study's own "measure before shipping".

---

## 9. Verdict

> ## SAFE TO PUSH

Reasoning, stated against what could make it unsafe:

- **No migration, no schema change, no data backfill, no deploy.** Nothing was pushed
  remotely and nothing was committed.
- **No authorization surface moved.** Every gate, every re-assertion, every RLS policy, and
  the entire confirmation pipeline are unchanged, and their suites pass unmodified.
- **The two behavioural changes are flag-reversible in one env var each**, with no state to
  unwind.
- **The one policy change** (`maxSteps` 8 → 12) is a single versioned constant, bounded by
  two new loop guards, with its commercial arithmetic consequence identified, tested and
  documented.
- **The full validation set is green**: 3,787 unit tests, the 136-case injection corpus with
  replay enabled, typecheck, ESLint, RTL, all four i18n gates, `git diff --check`, plus 630
  integration/RLS tests against local Supabase and a clean production build.
- **The one red found during validation was pre-existing and is fixed** (§L7), and its fix
  strengthens the assertion rather than weakening it.

The honest caveat, restated so it is not buried: **no live model run was performed, so no
claim is made about improved answer quality.** The improvements delivered are structural and
measured as such.
