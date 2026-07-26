# P4.11A — Read-Only Workflow Engine and Run Ledger

**Date:** 2026-07-26  
**Branch:** `feat/p411a-workflow-foundation`  
**Status:** Implemented; P4.11B remains unstarted.  
**Roadmap:** `docs/AI_AGENT_PLAN.md` §8 — P4.11A.  
**Baseline:** Approved P4.10 (`docs/reviews/P4.10_FINAL_APPROVAL.md`).

---

## 1. Scope delivered

P4.11A adds bounded, server-authoritative, read-only multi-step execution over the existing typed AI tool registry:

- versioned, strict workflow plans with ordered steps, explicit dependencies, and typed references to prior results;
- whole-plan validation against the caller's resolved tool mount;
- a dedicated `staff_workflow` certified task class and provider-cost reservation;
- one registry-mounted `execute_read_only_workflow` orchestrator;
- sequential read-tool execution with dependent-step halting and independent-step continuation;
- content-free dry-run previews and SHA-256 preview hashes;
- per-run step-count, serialized-plan, dependency/reference, schema, and deterministic cost-unit caps;
- honest `succeeded`, `partially_failed`, `failed`, and `previewed` outcomes;
- an additive `ai_workflow_runs` run/step ledger;
- the namespaced `ai.workflows` entitlement, true only for `pro_ai`;
- behavioral, authorization, tenant-isolation, RLS, migration, routing, i18n, and regression coverage.

There are no action steps and no workflow-specific UI.

## 2. Execution architecture

### Dedicated task and model mount

Explicit sequencing intent routes an entitled request to `staff_workflow`. `prepareAiExecution` rechecks `ai.workflows` before reserving the certified worst-case provider cost through the existing AI budget/concurrency/usage boundary.

The workflow task exposes exactly one model-visible tool: `execute_read_only_workflow`. The candidate step tools are resolved separately from the same declarative registry as a hidden server closure:

- ordinary standalone/capability mounts do not acquire the orchestrator;
- a workflow model cannot bypass validation and the ledger by calling nested tools as peers;
- the hidden step mount still applies role, every required feature, task compatibility, and per-user permission;
- the orchestrator itself is registry-declared as `kind: orchestrator` and is not valid step vocabulary.

### Plan validation

The server rejects the complete plan before creating a run or executing a prefix when it contains:

- malformed/oversized JSON;
- more than six steps;
- duplicate step ids;
- a dependency or reference to the same/future/unknown step;
- a reference not declared as a dependency;
- an unknown, unmounted, non-executable, or non-read tool;
- an orchestrator/future action tool as a P4.11A step;
- literal inputs that fail the selected tool's own schema;
- more than 12 server-owned cost units.

Referenced inputs are resolved only from successful prior outputs and then validated by the destination tool's own schema immediately before invocation.

### Sequential execution and partial failures

Every step calls the existing mounted `Tool.execute` wrapper. The engine does not call database/report/help cores directly and does not duplicate their authorization logic.

- Successful output can feed a later declared dependent through a bounded typed path reference.
- A structured authorization denial becomes a `denied` step with its safe reason.
- A clarification result becomes `needs_clarification`.
- An unexpected tool failure becomes `failed` with the generic `tool_error` code.
- Dependents become `skipped / dependency_failed`.
- Independent later steps may continue, so completed work is reported honestly.
- Tool outputs are returned for the current model turn but never written to `ai_workflow_runs`.

## 3. Security and trust-boundary decisions

### Existing tool boundary remains authoritative

Each nested step passes through the existing `harden()` wrapper and therefore preserves:

- per-invocation role, subscription, Assistant visibility, feature entitlement, and per-user permission checks;
- authenticated RLS reads and existing doctor/entity scope;
- existing `logAgentTool` audit behavior for success, denial, clarification, and error;
- untrusted tenant-text neutralization and provenance marking;
- bounded allow-listed result shapes and each tool's existing PHI minimization.

The workflow envelope is additive. It grants no data authority and never treats a previous step's result as authorization for the next step.

### Server-derived identity

The browser/model supplies neither `clinic_id`, `user_id`, ledger state, cost metadata, nor confirmation identity. The authenticated `AuthedUser`, current AI request id, registry mount, plan summary, step states, and hashes are all captured or derived server-side.

### Content-free durable ledger

`ai_workflow_runs.plan` contains only:

- plan version;
- step ids and tool names;
- dependency ids;
- parameter names, structural shapes, and reference source step ids;
- step/cost totals.

It excludes runtime parameter values, referenced values, outputs, patient ids/names, prompts, completions, notes, message bodies, and provider credentials. `step_states` contains status, timestamps, duration, and bounded safe error codes only.

### Owner-readable, server-write-only RLS

Authenticated users can select a run only when both `clinic_id = auth_clinic_id()` and `user_id = auth.uid()`. They receive no insert/update/delete grant or write policy. All mutations pass through `createClinicScopedAdminClient`, which injects and checks the clinic scope; updates additionally match run id and requesting user. Composite foreign keys prevent a run or future confirmation actor from crossing clinics.

### P4.10 context remains advisory

Nested tools receive the same active-context snapshot as a standalone tool in that turn. Each effective entity id is re-read and re-authorized by the destination tool. Workflow references do not promote model/client ids into conversational context or relax the P4.10 `use_active_*` intent rules.

## 4. Database migration

`20260726120000_p411a_read_only_workflows.sql` adds:

- `ai_workflow_runs`;
- owner read RLS;
- server-role-only writes;
- owner/time/state/mode/hash/count/cost constraints;
- tenant-integrity foreign keys;
- owner/time index and `updated_at` trigger;
- nullable `confirmed_by` / `confirmed_at` columns required by the approved P4.11 ledger shape but unused in P4.11A;
- `ai.workflows` plan-catalog seed (`pro_ai = true`, `basic/pro = false`).

The migration adds no RPC, action table, message dispatch, appointment mutation, report mutation, or confirmation function.

## 5. Files added or modified

### Added

- `lib/ai/workflows/types.ts`
- `lib/ai/workflows/plan.ts`
- `lib/ai/workflows/ledger.ts`
- `lib/ai/workflows/executor.ts`
- `lib/ai/workflows/tool.ts`
- `lib/ai/workflows/index.ts`
- `supabase/migrations/20260726120000_p411a_read_only_workflows.sql`
- `tests/unit/ai/p411a-workflow-engine.test.ts`
- `tests/unit/ai/p411a-workflow-mount.test.ts`
- `tests/unit/db/p411a-read-only-workflows-migration.test.ts`
- `tests/unit/integration/p411a-workflow-runs-rls.test.ts`
- `docs/reports/P4_11A_IMPLEMENTATION.md`

### Modified

- `app/api/agent/chat/route.ts`
- `lib/ai/authorization.ts`
- `lib/ai/commercial-policy.ts`
- `lib/ai/platform/execution.ts`
- `lib/ai/platform/registry.ts`
- `lib/ai/platform/types.ts`
- `lib/ai/staff-agent.ts`
- `lib/ai/tool-presentation.ts`
- `lib/ai/tools/context.ts`
- `lib/ai/tools/index.ts`
- `lib/ai/tools/registry.ts`
- `lib/supabase/admin.ts`
- `messages/en.json`
- `messages/ar.json`
- `types/database.ts`
- `tests/unit/ai/p4a-authorization.test.ts`
- `tests/unit/ai/p45a-platform.test.ts`
- `tests/unit/ai/p49b-scope-and-patient-launcher.test.ts`
- `tests/unit/api/p4b-chat-route.test.ts`
- `tests/unit/api/p49a-placement-api-behavior.test.ts`
- `docs/AI_AGENT_PLAN.md`

## 6. Test coverage

- **Plan contract:** strict version/shape, size and step caps, unique ids, prior-only dependencies, explicit reference dependencies, tool schema validation, recursive-orchestrator denial, unknown/unmounted denial, and cost cap.
- **Execution:** dry-run performs no reads; sequential order; prior-output references; successful completion; structured authorization denial; clarification/error classification; dependent skip; independent continuation; content-free preview/ledger summaries.
- **Mount and budget:** only the orchestrator is model-visible in `staff_workflow`; the hidden registry mount remains usable by the server; ordinary/capability mounts do not expose the orchestrator; explicit en/ar sequencing detection; dedicated task policy; entitlement denial before provider reservation.
- **Authorization:** `ai.workflows` is additive to the complete staff-assistant spine and is rechecked before run execution.
- **Live RLS:** owner read; same-clinic colleague denial; cross-clinic denial; authenticated insert/update/delete denial; service update; composite user/clinic integrity.
- **Regression:** P4.10 context phase boundary now expects the P4.11A ledger while continuing to assert that P4.11B action objects do not exist; existing registry/presentation/API tests remain green.

## 7. i18n, RTL, and accessibility

P4.11A adds no workflow-specific component, dialog, preview/confirmation screen, focus behavior, or physical-direction styling. The existing generic tool-activity surface receives one bilingual label for the orchestrator. English/Arabic message parity, unused-key, hardcoded-string, and RTL logical-property gates pass.

Workflow-specific preview/confirmation accessibility and RTL UI belong to P4.11B and were not started.

## 8. Validation results

| Check | Result |
|---|---|
| Focused P4.11A + touched authorization/platform/API/presentation regression set | Pass — 7 files, 87 tests |
| Focused live P4.11A RLS/tenant-isolation integration | Pass — 1 file, 5 tests |
| Full unit suite (excludes live integration) | Pass — 212 files, 1,559 tests |
| Full integration/RLS suite | Pass — 26 files, 272 tests |
| `pnpm typecheck` | Pass |
| `pnpm lint` | Pass — 0 errors; 25 pre-existing warnings |
| `pnpm lint:i18n` | Pass — 306 files; 14 documented exceptions |
| `pnpm i18n:missing` | Pass — 2,843 base leaf messages; locale variants valid |
| `pnpm i18n:unused` | Pass — no unreferenced keys |
| `pnpm lint:rtl` | Pass — 432 files; 10 documented exceptions |
| Generated database-type parity | Pass — checked-in `ai_workflow_runs` Row/Insert/Update/Relationships block exactly matches fresh local generation (87 lines) |
| `pnpm build` | Pass — production build; 67 pages generated |
| `git diff --check` | Pass |

The installed local Supabase CLI (`v2.98.1`) emits a newer-version notice. Its full-file type output also reorders unrelated tables and incorrectly narrows several pre-existing nullable RPC parameters; the checked-in type change therefore preserves the approved baseline and adds only the exact locally generated `ai_workflow_runs` table shape. Final parity compares that table block directly against fresh local generation.

## 9. Explicit P4.11B boundary

P4.11B and later phases were not started. There is:

- no action-step registry entry;
- no message draft/send/dispatch step;
- no booking or report write step;
- no confirmation mutation, token, replay protection, or resume API;
- no `message_dispatches` workflow integration;
- no workflow preview/confirmation component or page;
- no suggested-workflow prompt;
- no unattended/scheduled or patient-facing workflow.

The confirmation columns are nullable migration scaffolding explicitly required in the approved P4.11A ledger definition; no code writes or consumes them.
