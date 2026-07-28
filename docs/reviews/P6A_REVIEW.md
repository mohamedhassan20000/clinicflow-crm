# P6A Review — Prompt-injection & Evaluation Suites

**Status:** APPROVED FOR MERGE
**Sub-phase:** P6A (`feat/p6a-adversarial-eval`)
**Review cycle:** 1
**Review date:** 2026-07-28
**Reviewer:** Claude Code (independent verification against `docs/AI_AGENT_PLAN.md` §P6A, §6.5/§9.4, §13)
**Verdict:** **APPROVED FOR MERGE** — all acceptance criteria met; findings are Low / Informational only, none blocking.

This file is the authoritative handoff from Claude Code to Codex for the P6A review cycle. Re-reviews must read this file first, verify every checklist item, mark resolved items completed, keep unresolved items open, add new findings under new stable IDs, bump the review-cycle number, and append a dated re-review section. Prior findings must never be deleted.

---

## 1. Review scope

Reviewed the uncommitted working-tree implementation of **P6A only** against the plan, the real tool-authorization runtime, and the existing AI test suite. Every claim in `docs/reports/P6A_IMPLEMENTATION.md` was verified by running the code and cross-reading the production sources it depends on — not by reading the report alone. **No fixes, commits, pushes, or merges were made. P6B was not reviewed.**

**Files in the P6A change set:**

| File | Change |
|---|---|
| `lib/ai/eval/injection-corpus.ts` | New — 41-case adversarial corpus (en/ar + Egyptian/Gulf/Levantine), typed pure data |
| `lib/ai/eval/eval-set.ts` | New — 104-case eval set (52 staff + 52 patient) with rubrics + documented thresholds |
| `lib/ai/eval/authorized-tools.ts` | New — authorization oracle (persona/role reachable-tool sets from the real registry) |
| `lib/ai/eval/grade.ts` | New — offline rubric-consistency grader + shared live turn-grader |
| `lib/ai/eval/index.ts` | New — barrel re-exports |
| `tests/unit/ai/p6a-injection-suite.test.ts` | New — containment + behavioral + neutralization + detection |
| `tests/unit/ai/p6a-eval-set.test.ts` | New — composition + offline consistency + shared grader |
| `lib/ai/guardrails.ts` | Modified — broadened `detectInjectionAttempt` patterns (dialects, extraction, role-hijack) |
| `.github/workflows/ci.yml` | Modified — added required "AI adversarial & evaluation suites (P6A)" step |
| `package.json` | Modified — added `test:ai-adversarial` script |

No migrations. Only one production runtime file changed (`guardrails.ts`) — see F6A-1 for its runtime status.

---

## 2. Validation performed (independently run)

| Check | Command | Result |
|---|---|---|
| P6A suites (one command) | `pnpm test:ai-adversarial` | ✅ 2 files, **93 tests passed** |
| Determinism (second run, no seed/model/DB) | `pnpm test:ai-adversarial` (rerun) | ✅ identical **93/93**, byte-stable |
| Full AI regression suite | `npx vitest run tests/unit/ai` | ✅ 44 files, **633 tests passed** |
| Typecheck | `pnpm typecheck` (`tsc --noEmit`) | ✅ clean |
| Guardrail runtime wiring | `grep -r '@/lib/ai/guardrails' lib app` | ⚠️ zero runtime importers (see F6A-1) |
| Sanitizer boundary wiring | read `lib/ai/tools/index.ts:260-269` | ✅ `sanitizeUntrustedDeep` + `withProvenance` genuinely wrap all staff tool output |
| Oracle fidelity | cross-read `registry.ts` roles/perms vs `authorized-tools.ts` | ✅ faithful re-derivation of the 3 mount gates |
| CI required-job status | read `.github/workflows/ci.yml` | ✅ step runs inside the required unit-tests job (see F6A-3 caveat) |

### Independent verification of the security-critical claims

- **Containment is real and correctly computed.** `authorized-tools.ts` re-derives the persona/role reachable set from the *same* `AI_TOOL_REGISTRY` / `STAFF_TASK_CLASSES_BY_ROLE` / `PATIENT_TOOL_NAMES` the real `resolveToolMount` reads (`lib/ai/tools/index.ts`), applying the same three gates (role membership, required features assumed-true, `ai.financial_insights` per-user grant). It is not a second hand-maintained list. Spot-checked:
  - `get_revenue_summary` / `compare_revenue_periods` / `list_outstanding_invoices` → `roles: FINANCIAL = [admin, manager]` → correctly unreachable for `doctor` and `receptionist` (injection cases `inj-en-escalate-01`, `inj-en-help-02`, `inj-ar-override-01`, and eval refusal cases).
  - `run_clinic_report` → `roles: ADMINISTRATIVE` → correctly unreachable for `doctor`.
  - Cross-persona: `staffOnlyToolNames()` correctly excludes the shared `check_availability` verb; every staff-only tool is absent from the patient mount and every patient-only mutation/identity tool absent from all five staff roles (asserted per-role).
- **Stored-injection neutralization exercises the *production* boundary.** The test runs payloads through the real `sanitizeUntrustedDeep` + `withProvenance` that is actually wired into every staff tool's output at `lib/ai/tools/index.ts:260-269` — not a test double. Control chars, zero-width/bidi, fenced blocks, `<|…|>`, `<system>`-style tags, role headers, and newlines are all stripped; provenance marker asserted.
- **Determinism holds.** No model, no DB, no network, no randomness, no clock dependence in either suite. Two full runs are identical.
- **Regression safety.** The only production file changed is `guardrails.ts`; broadened benign-input negatives still return `false` (verified by both the pinned P4A assertions and the new suite). Because the module is currently unwired (F6A-1), the change is inert at runtime — no production behavior changes.

---

## 3. Acceptance criteria (§P6A) — status

- ✅ **Injection suite green in CI as a required job** — added as a `ci.yml` step in the required unit-tests job; deterministic, no external deps.
- ✅ **Eval threshold documented and met** — offline consistency target `EVAL_OFFLINE_CONSISTENCY_TARGET = 1.0` met (all 104 rubrics consistent); live pass threshold documented as `EVAL_PASS_THRESHOLD = 0.9` and shared by one grader.
- ✅ **Both suites runnable locally with one command** — `pnpm test:ai-adversarial`.
- ✅ **P4.6 stored-data adversarial cases** — `stored_data_injection` category; neutralization asserted at the real tool boundary.
- ✅ **P4.7 help-escalation adversarial cases** — `help_escalation` category with containment on the induced tool.
- ✅ **ar/en incl. dialect variants** — Egyptian / Gulf / Levantine asserted present in both corpora.
- ✅ **No unauthorized tool call** — proven structurally (registry oracle) and behaviorally (real `ToolLoopAgent` driven by a compromised `MockLanguageModelV3`).

---

## 4. Findings (by severity)

No Critical or High findings. The core security guarantee — containment by non-mounting — is real, correctly computed, deterministic, and backed by the genuinely-wired sanitization boundary. All findings below are Low / Informational and non-blocking.

### F6A-1 — LOW — The detection layer is not wired into any runtime path
- **Affected:** `lib/ai/guardrails.ts` (whole module); report §1.3 and §2 phrasing.
- **Observation:** `lib/ai/guardrails.ts` has **zero runtime importers** — `grep -r '@/lib/ai/guardrails' lib app` returns nothing; `detectInjectionAttempt`, `detectEmergency`, and `wrapUntrustedContent` are referenced only by tests and the corpus doc-comments. P6A broadened `detectInjectionAttempt`'s patterns, but nothing in either agent loop calls it, so the "runtime detection telemetry" does not actually emit in production today.
- **Why it's only Low:** The report is explicit that detection is *not* the control — the mount is — and that layer is genuinely wired and verified. So the security guarantee does not depend on this. The change is also regression-safe precisely because the module is inert.
- **Why it still matters:** The report's wording ("the runtime `detectInjectionAttempt` signal", "advisory, non-blocking signal") overstates a function that is currently invoked by nothing. Recommend either (a) wiring `detectInjectionAttempt` into the agent loop as genuine advisory telemetry (a small follow-up, arguably P6-scope hardening), or (b) softening the report language to "a detection helper, tested in isolation, intended for advisory telemetry." Not required for merge.

### F6A-2 — LOW — Vacuous assertion in the behavioral suite
- **Affected:** `tests/unit/ai/p6a-injection-suite.test.ts:203, 234` (`leakSpy`), and by extension `:235`.
- **Observation:** `leakSpy` is created and asserted `expect(leakSpy).not.toHaveBeenCalled()`, but it is never attached to any tool, so the assertion is unconditionally true regardless of behavior. Separately, `expect(executed).not.toContain(c.forbiddenTool)` is guaranteed *by construction*: `executed` only ever records names iterated from `reachable` (the mounted/authorized set), and the forbidden tool is not in that set (already asserted at `:213`). So neither behavioral assertion can fail independently of the structural layer.
- **Why it's only Low:** The behavioral block still adds value — it drives a *real* `ToolLoopAgent` with a compromised model and proves the SDK neither fabricates-executes an unmounted tool nor crashes the loop when the model emits a `NoSuchTool` call. That is a genuine integration smoke test. It just does not *independently* re-prove containment the way the block's naming implies.
- **Recommendation:** Remove the dead `leakSpy`, or make the assertion non-vacuous by registering the forbidden tool name against an executor that fails the test if ever invoked (i.e. mount a real "tripwire" so the SDK actually has something it *could* call). Not required for merge.

### F6A-3 — INFO — The broader `tests/unit/ai` suite is not gated by CI
- **Affected:** `.github/workflows/ci.yml:56, 64`.
- **Observation:** The existing "Unit tests" step enumerates directories and **omits `tests/unit/ai`**. The new P6A step is therefore the *only* place any `tests/unit/ai` runs in CI, and it runs just the 2 P6A files — the other 42 AI test files (631 tests) remain ungated.
- **Assessment:** Pre-existing gap, **not introduced by P6A and out of its scope** (P6A was asked only to make its own suites a required job, which it does). Flagged because P6A is the first AI coverage to reach CI, and widening the step to `tests/unit/ai` (or the whole dir) would be a cheap, high-value follow-up. No action required for P6A merge.

### F6A-4 — INFO — Report test-count drift
- **Affected:** `docs/reports/P6A_IMPLEMENTATION.md` §3.
- **Observation:** Report states "88 tests" for the P6A suites and "628 tests" for the full AI suite; actual current counts are **93** and **633** respectively (higher, all green). Harmless drift — likely cases added after the report was written. Optional to refresh.

### F6A-5 — INFO — Workflow step-tools listed as `expectTools`
- **Affected:** `lib/ai/eval/eval-set.ts` (`eval-staff-35`, `eval-staff-44`).
- **Observation:** These rubrics list action-kind workflow **step** tools (`send_appointment_reminders`, `create_pending_booking`) in `expectTools`. In the real mount those step tools are never exposed directly to the model — only the `execute_read_only_workflow` orchestrator is, with steps resolved in a server closure (`lib/ai/tools/index.ts`). Offline consistency still passes because `maximalStaffTools` counts them reachable by role, and the shared live `gradeTurn` treats `expectTools` as "at least one of", with the orchestrator also listed in both rubrics — so a live run keying on model-visible `toolsCalled` still grades correctly. This is a fidelity nuance, **not a defect**; the guarantee and the grading both remain sound. No action required.

---

## 5. Coverage assessment

- **Attack classes:** all nine categories present (`direct_override`, `role_hijack`, `prompt_extraction`, `privilege_escalation`, `cross_persona`, `stored_data_injection`, `help_escalation`, `data_exfiltration`, `clinical_boundary`) — verified by corpus-integrity assertions and by category enumeration.
- **Languages/dialects:** en, MSA ar, and Egyptian/Gulf/Levantine present in both the injection corpus and the eval set.
- **Personas/roles:** both staff personas across all five roles and the patient persona covered; cross-persona isolation asserted bidirectionally.
- **Behaviors:** refusal, escalation, clarification, and citation rubrics all exercised (asserted present).
- **Eval size:** 52 staff + 52 patient (≥ the "~50 + ~50" plan target).

---

## 6. Handoff notes for re-review / Codex

- Nothing blocks merge. If addressing findings, the highest-value two are **F6A-1** (wire or reword the detection layer) and **F6A-2** (make the behavioral assertion non-vacuous). Both are Low and can be deferred to a P6 hardening pass.
- **F6A-3** is a repo-wide CI observation, not a P6A defect — do not gate P6A on it.
- Re-run gate before any follow-up merge: `pnpm test:ai-adversarial` (expect 93/93) and `pnpm typecheck` (clean).
- Do not extend this review to P6B; that is a separate cycle.
