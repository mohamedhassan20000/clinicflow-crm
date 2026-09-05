# P11G — Patient booking tool execution architecture

**Branch:** `feat/p7-manual-qa-polish` · **Date:** 2026-08-24 · **Status:** implemented, validated locally, **SAFE TO PUSH**

---

## 1. Why turns 32–42 produced `tool_called: "none"`

Two causes, both in ClinicFlow, neither in the model's tool-calling ability. A third factor (the audit line itself) is why they went undiagnosed for three phases.

### Cause A — the reconstructed history contains no tool evidence

`loadHistory` ([lib/ai/patient-reply.ts:463-528](../../lib/ai/patient-reply.ts#L463-L528)) rebuilds the model's context from two tables — `inbound_messages` and `outbound_messages` — and nothing else. There is no tool-call part and no tool-result part anywhere in it.

That was harmless before P11D. It stopped being harmless the moment the deterministic continuation started composing patient-facing replies, because those replies are written to `outbound_messages` and come back on the next turn **as the assistant's own prior words**. By turn 32 the model's context was a transcript in which an assistant persona had repeatedly named doctors, listed days and listed times fluently, in Arabic, with no tool call anywhere. The strongest in-context pattern available to a 0.2-temperature Haiku was *"in this conversation, the assistant answers booking questions from prose."*

This is self-reinforcing, and the loop is closed:

```
model answers in prose  →  grounding check fires  →  deterministic continuation rescues
        ↑                                                        │
        └──────── prose-only assistant turn enters history ←──────┘
```

Turns 32–42 are that loop latched. P11D–P11F made the rescue *good*, which removed the symptom and strengthened the cause.

### Cause B — the stage banner contradicted the ladder for the whole window

`deriveStage` ([lib/ai/booking-stage.ts](../../lib/ai/booking-stage.ts)) puts intake **before** the calendar:

```ts
if ((!facts.linked || facts.bookingForOther) && !facts.intakeStaged) return "intake_collecting";
if (!has(facts.collected, "appointment_date")) return "selecting_day";
```

So a new patient or a third-party booking enters `intake_collecting` the moment a doctor is chosen and stays there through the day *and* the time. `nextBookingStep` — the ladder every deterministic reply already trusts — says `day` then `time` for exactly that state. The two disagree, and the prompt was reading the wrong one:

> **`EN_STAGE_BANNER.intake_collecting` (before this phase):** "Current step: opening a file. … Collect **only** the missing personal details, then call `register_patient`."

The production trace shows `stage_before`/`stage_after` = `intake_collecting` on turns 40–42 while the patient was choosing a day ("31") and a time ("الساعه ٩ الصبح"). For eleven consecutive turns the most specific instruction in a 10.6 KB prompt told the model to ask for an email address. It did not call `list_available_days` because the prompt told it that was not this step.

`STAGE_WORKFLOW_TOOLS.intake_collecting` had already been widened in P11F to *mount* `list_available_days` and `check_availability` for this window. The tools were there. Nothing told the model to use them.

### Cause C (diagnostic, not behavioural) — the audit line could not tell the two paths apart

`patient_booking_stage` emits `tool_called: "none"` from `openBookingStageTurn` at the top of every turn, and a second row naming the tool only if one runs. A turn the model skipped a tool on and a turn the server rescued produced **the same** observable. That is why eleven turns of a dead primary path read as a working booking.

---

## 2. Were the expected tools actually present in the final model request?

**Yes.** Proved by instrumenting the real `createPatientAgent` with a `MockLanguageModelV3` recorder and reading `options.tools` / `options.toolChoice` / the system message off the *provider call*, not off `STAGE_WORKFLOW_TOOLS`. This is now a permanent regression test: [`tests/unit/ai/p11g-booking-tool-authority.test.ts` §2](../../tests/unit/ai/p11g-booking-tool-authority.test.ts).

Findings:

- Every stage's tool set in the provider request equals `allowedToolsForStage(stage, PATIENT_TOOL_NAMES)` exactly — `prepareStep`'s `activeTools` override works as documented in AI SDK 6.0.230.
- `toolChoice` was `{ type: "auto" }` on every stage. No middleware strips tools; no schema is rejected; no structured output is configured; `experimental_repairToolCall` is mounted and functioning; `stopWhen: stepCountIs(6)` is not an early stop.
- The system message is a single, correct, stage-scoped Arabic/English prompt with the banner appended last.

**The mount, the SDK configuration and the tool schemas are not the defect.** Ruling this out was the point of the exercise.

## 3. Stage → mounted tools (from the final provider request, not the table)

Always-on (`STAGE_INDEPENDENT_TOOLS`, present in every row below): `get_clinic_info`, `answer_clinic_faq`, `list_clinic_insurance`, `list_department_services`, `verify_patient_identity`, `confirm_booking_identity`, `list_my_appointments`, `lookup_appointment`, `cancel_my_appointment`.

| Stage | Workflow tools in the provider request | Authoritative op this stage can need |
|---|---|---|
| `idle` | `prepare_booking` | — |
| `identifying` | *(none)* | — |
| `intake_collecting` | `register_patient`, `list_available_days`, `check_availability`, `prepare_booking`, `list_doctors` | `list_available_days` / `check_availability` |
| `selecting_department` | `prepare_booking`, `list_doctors` | `prepare_booking` |
| `selecting_doctor` | `prepare_booking`, `list_doctors` | `list_doctors` |
| `selecting_day` | `list_available_days`, `check_availability`, `prepare_booking`, `list_doctors` | `list_available_days` |
| `selecting_time` | `check_availability`, `list_available_days`, `create_preliminary_booking`, `prepare_booking`, `list_doctors` | `check_availability` |
| `confirming` | `create_preliminary_booking`, `check_availability`, `list_available_days`, `prepare_booking`, `list_doctors` | `create_preliminary_booking` |
| `submitted` | `prepare_booking` | — |
| `escalated` | *(none)* | — |

## 4. Actual `toolChoice` / step behaviour

**Before:** `toolChoice` unset → `auto` on every step of every turn. `maxSteps: 6`, `temperature: 0.2`, model `anthropic/claude-haiku-4.5` via the managed AI Gateway. `prepareStep` narrowed `activeTools` and `system`; it set no `toolChoice`.

**After:** identical, except that on **step 0 only**, of a turn the server has determined needs a specific authoritative operation that is *not already satisfied* and *is already mounted*, `toolChoice` is pinned to that one tool. Everything else stays `auto`. `toolChoice: "required"` is never used, globally or otherwise.

## 5. Prompt / tool-contract findings

The certified prompt does say the right things — "Every one of those comes from a tool result on this turn", "Always check real availability with the tools before offering anything". Those sentences were not the problem.

What was missing is that none of them is **turn-specific**. A rule that holds always competes for attention with 10 KB of other rules that also hold always; a sentence that says *"this turn, call `list_available_days`"* does not. And in the one window where a turn-specific sentence did exist — the `intake_collecting` banner — it named the wrong operation.

The fix is one line per turn, not a bigger prompt. Total prompt growth: **one sentence**, emitted only when there is something to say, and `null` otherwise ([`bookingAuthorityInstruction`](../../lib/ai/booking-authority.ts)).

## 6. Root cause classification

**Multiple causes, all orchestration/prompt, none model-capability and none SDK:**

| Cause | Layer | Evidence |
|---|---|---|
| A — tool-free history reinforces prose | orchestration (`loadHistory`) | source; the P11D→P11F feedback loop |
| B — banner names the wrong step for 11 turns | prompt (stage↔ladder disagreement) | `deriveStage` vs `nextBookingStep`; trace `stage_*` = `intake_collecting` on turns 40–42 |
| C — audit cannot separate the two paths | observability | one `tool_called` field for two distinct outcomes |

Explicitly **not** causes, each ruled out by the §2 recorder: tool mount, `activeTools`, tool schemas, `toolChoice`, `maxSteps`/`stopWhen`, `prepareStep`, middleware, repair, structured output, provider/model tool support, prompt caching.

## 7. Booking operation ownership

| Transition | Owner | Mechanism |
|---|---|---|
| Understand what the patient means | **model** | conversation |
| Resolve a named department/doctor to an id | **server** | `resolveNamedEntity` against the live directory; the model passes the patient's words through |
| Department list | **server (read authority)** | `prepare_booking` |
| Doctor roster | **server (read authority)** | `list_doctors` / `prepare_booking`; closed-world per P11B |
| Available days | **server (read authority)** | `list_available_days` |
| Available times | **server (read authority)** | `check_availability` |
| Commit department / doctor / date / time | **server** | `set_conversation_ai_state` from inside the tool or the continuation; never a model assertion |
| Offered-roster / offered-slot record | **server** | `booking_stage` jsonb; no model-writable path |
| Create the pending appointment | **server (write authority)** | `createPatientPendingBooking` |
| Intake field values | **model → server validation** | the patient supplies them; `register_patient` validates and stages |
| Explanation, clarification, register, language | **model** | conversation |

The model decides **what the patient means**. It never decides **what exists**.

## 8. Exact fix implemented

**New: `lib/ai/booking-authority.ts`** — a pure, I/O-free tool-necessity contract. `resolveBookingAuthority(facts) → { requirement: none | read_authority | write_authority, operation, reason, satisfied, step }`, computed from `nextBookingStep` (the ladder) rather than from `deriveStage` (the mount), plus the server-owned offered lists.

Wired into three places, each narrow:

1. **`openBookingStageTurn`** ([lib/ai/booking-stage-store.ts](../../lib/ai/booking-stage-store.ts)) computes the authority once per turn from the same authorized identity it already resolves, and returns it on `PatientTurnContext`. No extra round trip.
2. **`createPatientAgent`** ([lib/ai/patient-agent.ts](../../lib/ai/patient-agent.ts)) appends one localized sentence naming the operation to the stage prompt, and — on step 0 only, when the requirement is unmet and the operation is already in the callable set — pins `toolChoice` to it. `shouldForceAuthority` refuses to name a tool `allowedToolsForStage` has hidden, so **the stage table remains the only thing that can widen a mount**.
3. **`patient-reply.ts`** emits one `patient_booking_authority` audit row per booking turn (§14).

**Corrected: the `intake_collecting` banner** (ar + en) no longer says "collect **only** the missing personal details". It states the file still needs opening *and* that the calendar tools remain in play, leaving *this turn's* operation to the authority line. This is the direct repair of Cause B.

**Extended: `GroundingLedger.toolsSeen()`** — the ledger is already the single point every patient tool result passes through, so it is the only honest answer to "did the required operation actually execute?" without a second interception point that could drift.

## 9. Why this does not create unnecessary tool calls

The contract **subtracts** as readily as it adds:

- `doctor` step with a committed `offeredDoctorIds` → `requirement: none`, `satisfied: true`, and the prompt line becomes *"the server data is already in front of you — do not call a tool again."*
- Same for `offeredDays` at the `day` step and `offeredSlots` at the `time` step.
- Offered slots are matched **against the committed date** (`slot.startsWith(date + "T")`), so a slot list for the 28th never satisfies a turn about the 31st — the same substitution `checkOfferedSlot` refuses.
- `intake` → `none` (`conversational`): the fields come from the patient, not clinic state.
- A bare closing ("شكراً", "thanks, bye") → `none` at **every** step, checked before the ladder. `شكراً` cannot trigger a tool.
- `submitted` / `escalated` / `done` → `none`.
- The pin fires on **step 0 only**, so the loop always terminates.

## 10. How the fallback now relates to the primary path

Unchanged in code, changed in role. The deterministic continuation is still reached only through `enforcePatientReplyGrounding`, still commits what it offers, still never invents. What is new is that it is no longer *invisible*: `patient_booking_authority` records `fallback_used` and `fallback_reason` next to `tool_requested` / `tool_executed`, so a turn the model carried and a turn the server rescued are two different rows. If the model path regresses again, it will show as a rising `fallback_used` rate on turns whose `expected_authority` was `read_authority`, rather than as a booking that quietly still works.

## 11. `create_preliminary_booking` — ownership decision

**Decision: the write stays a certified server boundary, `createPatientPendingBooking`, reachable from both the model tool and the deterministic continuation. The model tool is retained; the model is not the authority.**

Rationale, from the existing architecture rather than preference:

- `createPatientPendingBooking` ([lib/booking/patient.ts:250](../../lib/booking/patient.ts#L250)) already performs the 24-hour notice check, re-runs `getPatientAvailableSlots` and re-validates the slot **regardless of caller**. `answerConfirmStep` in the continuation already calls it directly and already handles `intake_required`, `slot_unavailable` and `minimum_notice`. The server-triggered path (option B) therefore **already exists and is already exercised** — this phase did not need to build it.
- Removing the model-called tool would remove nothing from the security model (the RPC, the offered-slot guard and the identity re-resolution are all below it) but would remove the model's ability to say *what it is doing* in the same turn it does it, which is what makes a pending-booking reply coherent.
- So the boundary is unchanged. What changed is that at the `confirm` step the authority contract now classifies the turn as `write_authority` and pins the tool, so "all prerequisites satisfied but nobody called it" is no longer reachable through inattention. No semantic decision is delegated: by the time the ladder says `confirm`, department, doctor, day, time and intake are all established and server-validated.

**Security implication of the pin:** it can only name a tool `allowedToolsForStage` already mounted, `create_preliminary_booking` is mounted only from `selecting_time`, its arguments are validated server-side, and `checkOfferedSlot` still refuses a time the patient was never shown. The pin changes *when the model is asked*, never *what the server will accept*.

## 12. Self vs third-party

Covered by the existing P11C/P11F suites, which remain green, plus the §5 block of the new suite.

- The `intake_collecting` window is exactly the third-party window (`bookingForOther` forces it via `deriveStage`), so the Cause-B repair is disproportionately a third-party fix: this is the state in which department/doctor/day/time were being preserved correctly by the server while the prompt told the model to ignore all four.
- The authority contract reads `bookingForOther` only through `nextBookingStep` and never clears it. Nothing in `booking-authority.ts` can touch `selectedDepartmentId`, `selectedDoctorId`, `selectedDate`, `selectedTime`, the offered lists, the third-party latch or the booking target — it has no write path at all.
- Calendar reads during intake remain mounted (P11F) and are now also *instructed*, which is the behaviour §10 asks for.

## 13. Genericity (3 / 20 / 100 departments)

Asserted structurally rather than by fixture size, because the contract takes **ids and counts and never names**: `resolveBookingAuthority` has no string comparison against any clinic datum. §11 of the new suite runs the ladder and the contract over generated department sets of 3, 20 and 100 with synthetic ids and asserts an identical result, and greps `booking-authority.ts` for banned specialty names. The pre-existing `p11-generic-department-booking` and `p11-generic-multi-department-booking` suites (unit + integration against local Postgres) remain green unchanged; a department created after the suite starts is covered by those, since every lookup is a live directory read.

No prompt edit, alias edit, source edit or hard-coded name is required for a new department or doctor.

## 14. Failure modes

| Scenario | Behaviour | Where |
|---|---|---|
| Required tool not mounted for the stage | no pin; turn proceeds on `auto`; deterministic continuation still available | `shouldForceAuthority` (tested) |
| Tool throws | `protectPatientTool` → Sentry + `buildPatientTechnicalFallback` with the clinic's stored phone; model keeps the turn | unchanged, P9C |
| Malformed model tool call | `experimental_repairToolCall` subtracts to a valid call | unchanged, P9C |
| Model refuses / answers in prose anyway | grounding check → deterministic continuation; now recorded as `fallback_used: true` against a known `expected_authority` | P11B/D/F + new audit |
| Doctor becomes unavailable between turns | continuation re-offers the roster, doctor only | `patient-roster-continuation.ts` branch (b) |
| Slot lost between turns | `appointment_time` cleared, times re-offered; ladder drops exactly one rung | `answerConfirmStep` |
| Availability changed since the offer | `createPatientPendingBooking` re-validates on every write | `lib/booking/patient.ts` |
| Stage store unavailable | `openBookingStageTurn` returns `EMPTY_TURN_CONTEXT`; `authority: null`; agent behaves exactly as pre-P11G | tested by the null-authority cases |

Never reachable: invented availability, invented doctor, or a claimed-successful booking — all three still sit behind the closed-world directory, the offered-slot guard and the RPC.

## 15. Files changed

| File | Change |
|---|---|
| `lib/ai/booking-authority.ts` | **new** — pure tool-necessity contract |
| `lib/ai/booking-stage-store.ts` | resolves the authority per turn; `PatientTurnContext.authority` |
| `lib/ai/patient-agent.ts` | authority line in the prompt; step-0 `toolChoice` pin; `AuthorityObserver` |
| `lib/ai/patient-reply.ts` | threads authority + observer; emits `patient_booking_authority` |
| `lib/ai/patient-grounding.ts` | `GroundingLedger.toolsSeen()` |
| `lib/ai/prompts/patient.ts` | `intake_collecting` banner corrected (ar + en) |
| `tests/unit/ai/p11g-booking-tool-authority.test.ts` | **new** — 31 tests |

## 16. Migration status

**No migration.** Nothing here adds a column, a table, an RPC or an enum value. The audit row uses the existing `logAgentTool` → `audit_logs` path with an existing shape. No remote write of any kind was performed.

## 17. Validation results

| Gate | Result |
|---|---|
| `tests/unit/ai/p11g-booking-tool-authority.test.ts` | **31 passed** |
| `tests/unit/ai` (P11, P11B–P11F, P9 booking-stage, patient tools, orchestration metrics) | **97 files · 1809 passed · 2 skipped** |
| `tests/unit/integration` (real local Postgres, `supabase status` keys) | **64 files · 646 passed · 3 skipped** |
| Full `tests/unit` | **491 files · 4659 passed · 5 skipped · 0 failed** |
| `npm run test:ai-adversarial` | **136 passed** |
| `npm run typecheck` | clean |
| `npm run lint` | 0 errors (28 pre-existing warnings, none in changed files) |
| `npm run lint:i18n` | ✓ 455 files |
| `npm run lint:rtl` | ✓ 747 files |
| `npm run build` | ✓ production build succeeded |
| `git diff --check` | clean |
| Remote DB writes | **none** |

## 18. Remaining limitations

1. **No deterministic test can prove a live model chooses to call an offered tool.** Stated plainly, as §15 of the brief requires. Every assertion in the new suite is about what *ClinicFlow sent* — the tool set, the `toolChoice`, the prompt — recorded off the provider call. No test here fakes a tool call and claims the model behaviour is fixed. The step-0 pin is what makes the required call structural rather than hoped-for; the residual question is only whether the model uses the result well, which needs the live harness.
2. **The live eval was not run.** `AI_EVAL_LIVE=1 … p9-booking-live-eval.test.ts` spends real gateway budget and was left for an explicit decision. Running it (baseline vs. this branch) is the recommended next step and would put a number on the `fallback_used` rate.
3. **Cause A is counteracted, not removed.** History is still reconstructed without tool parts, so a turn where the requirement resolves to `none` still shows the model a prose-only transcript. Persisting tool-call/tool-result parts for replay is a schema change and a larger phase; it is the right long-term fix and is deliberately out of scope here.
4. **`prepare_booking` at the `department` step never resolves to `satisfied`.** There is no `offeredDepartmentIds` record in `booking_stage` to check against, so a department turn always requires the read. Correct but slightly conservative; adding that record would be a small follow-up.
5. **e2e (Playwright) was not run** — this phase touches no UI surface.

## 19. Verdict

**SAFE TO PUSH.**

Every change is additive and degrades to pre-P11G behaviour on any failure (`authority: null` → the agent is byte-identical to before). No P11B–P11F invariant is weakened: the closed-world roster, the offered-slot guard, the monotonic ladder, the third-party target, the identity rules and the language/register protections are all untouched and all still green. `AI_PATIENT_STAGE_ORCHESTRATION=shadow`/`off` remain intact as the rollback, and the pin is disabled under both because it can only name a tool from the callable set.

Nothing was pushed, deployed, or written to a remote database.
