# ClinicFlow — Typed Booking-Stage Orchestration: Implementation Report

Implementation date: 2026-08-23
Branch: `feat/p7-manual-qa-polish`
Implements: `docs/reviews/AI_ASSISTANT_LANGGRAPH_ARCHITECTURE_STUDY.md`, Option 4
(Sections 9–12), Phases 0.5 → 4.

**No framework was introduced.** No LangGraph, no LangChain, no Mastra, no XState, no
new runtime dependency of any kind — this work adds nothing to `package.json`. The system remains a
Vercel AI SDK `ToolLoopAgent` on the certified `lib/ai/platform/` execution path, and the
stage machine is wired through the `prepareStep` hook that `patient-agent.ts` already
called and previously returned `{}` from.

**Nothing was deployed and no migration was pushed remotely.** The one new migration is
additive, was applied to the local Supabase container only, and its version row was
recorded locally so `supabase db push` remains the operator's decision.

---

## 0. Executive summary

| | |
| --- | --- |
| **Phase 0 (DB blockers B1–B4, S1, M2)** | **Already fixed** in `20260822120000` + `20260822190000`. Verified against the migration bodies, not assumed. Not re-fixed. |
| **Phase 0.5 (Sonnet-class route, `maxSteps` 10)** | Harness built and wired to a certified Sonnet route through the real managed gateway. **The live comparison did not run**: the Vercel AI Gateway account attached to this environment is on the free tier and every request is rate-limited (exact error in §3.2). No Haiku-vs-Sonnet numbers are reported, because none were measured. |
| **Phases 1–4 (typed stage, transitions, `prepareStep`, guard consolidation)** | **Implemented.** |
| **Offered-options guard** | **Implemented**, server-side, in the tool. |
| **Stage observability** | **Implemented**, privacy-safe, into `audit_logs`. |
| **Rollback** | One environment variable, three values, default `shadow`. |
| **Model recommendation** | **Stay on Haiku.** Not because Sonnet lost — because it was never measured, and the study's own decision rule forbids a permanent switch without a measured result. §13. |
| **Safety gates** | All green. §11. |

The single most useful thing this work produced was not a metric. It was three bugs in
its own first draft, each caught by a test before it could reach a patient, and each
recorded here rather than quietly fixed:

* two **deadlocks in the stage/tool table** — `check_availability` gated behind an
  appointment date that only `check_availability` writes, and `create_preliminary_booking`
  gated behind an appointment time that only `create_preliminary_booking` writes (§4.3);
* a **rollback bug**: `shadow` mode silently behaved like `on`, because
  `openBookingStageTurn` returned a stage whenever *tracking* was enabled and the agent
  narrows whenever it is handed one (§9).

A stage machine whose table is wrong is worse than no stage machine, and a rollback that
does not roll back is worse than no flag. All three are now pinned by tests.

---

## 1. What was verified before anything was changed

The brief warned that the study's Class-B database blockers were fixed in later P8/P9
work and must not be re-fixed. Each was checked against the current migration bodies:

| Study finding | Status now | Evidence |
| --- | --- | --- |
| **B1** `approve_ai_patient_intake` fails for every staff caller (`auth.role()` vs definer) | Fixed | `20260822120000` §`ai_intake_approval_context_matches` + the rewritten `protect_patient_ai_identity_state`, which returns early for the matching approval transaction and only guards `anon`/`authenticated`. |
| **B2** takeover makes an intake unapprovable | Fixed | Same approval-context escape hatch, applied in `block_paused_ai_booking_insert`. |
| **B3** closed thread makes an intake unapprovable | Fixed | `enforce_ai_pending_booking_policy` rewritten in `20260822190000`. |
| **B4** expired request bricks re-booking (23505) | Fixed | `20260822190000:462` expires stale rows under lock before the partial unique index is consulted; `:720` re-expires inside the approval path. |
| **S1** legacy `register_patient_from_conversation` still granted | Fixed | `20260822190000:1007` drops it; the header states the remote catalog already agrees. |
| **M2** no expiry sweeper | Fixed | The expiry sweep is now inline in the request path rather than a separate job. |

**No change was made to any of them.** The only thing this work does to that layer is
one additive column and two `create or replace` bodies (§5).

---

## 2. The stage model

Ten stages, exactly as the study specified, in `lib/ai/booking-stage.ts`.

```
idle → identifying → intake_collecting → selecting_department → selecting_doctor
     → selecting_day → selecting_time → confirming → submitted
                                                   ↘ escalated (from anywhere)
```

### 2.1 The stage is derived, never read

This is the design decision everything else follows from, and it is what makes the
persisted record safe.

`deriveStage()` is a pure function of *this turn's* facts. It reads the collected fields
and the identity values `authorizePatientConversation()` resolved from
`resolve_patient_ai_context` **on this call**. The persisted record contributes only what
cannot be derived: three latches, two counters, and the record of what was offered.

```
1. escalated latch                          → escalated
2. submitted latch                          → submitted
3. linked && !identityVerified              → identifying
4. no booking intent yet                    → idle
5. no department_id                         → selecting_department
6. no doctor_id                             → selecting_doctor
7. !linked && !intakeStaged                 → intake_collecting
8. no appointment_date                      → selecting_day
9. no appointment_time                      → selecting_time
10. everything established                  → confirming
```

Consequence: **a stale, corrupt or hostile stage value cannot unlock a tool.** The worst
it can do is disagree with the derived stage, which increments
`illegalTransitions` and appears in the trace. This is the property the study's Note 1
demanded, obtained structurally rather than by convention.

Intake sits *after* the doctor, not before, because that is the order
`register_patient` itself enforces — it refuses with `assignment_required` unless a
department and a doctor are already collected.

### 2.2 The persisted record

`conversations.ai_booking_stage`, one jsonb object, 4 KB capped, written only by
`set_conversation_ai_state` (service-role only):

```ts
{ stage, stageEnteredAt, turnCount,
  intakeStaged, submitted, escalated,          // latches — the only non-derivable state
  offeredDoctorIds, offeredDays, offeredSlots, // what the patient was actually shown
  lastToolOutcome: { tool, outcome, at } | null,
  illegalTransitions }
```

There is **no** `patientId`, no `clinicId`, no `verified` flag, and no place to put one.
`parseBookingStageState` rebuilds the object key by key against that closed shape —
the same discipline as `parseCollectedData`, for the same reason. A test asserts by
absence that `patient_id`, `identity_verified` and `clinic_id` cannot survive a read
(`p9-booking-stage.test.ts` · "drops an unknown key rather than carrying it").

Offer records are validated on the way in *and* out: a `YYYY-MM-DD`-shaped string that is
not a real calendar day (`2026-13-01`) is discarded, because an offer record that compares
unequal to everything forever is a guard that has quietly stopped guarding.

---

## 3. Phase 0.5 — the model comparison

### 3.1 What was built

`lib/ai/eval/booking-harness.ts` + `lib/ai/eval/booking-scenarios.ts` +
`tests/unit/ai/p9-booking-live-eval.test.ts`.

It reuses the existing eval infrastructure — `EvalCase`, `gradeTurn`, `scoreEvalRun`,
`EVAL_PASS_THRESHOLD`, `patientEvalCases()`, the `AI_EVAL_LIVE=1` opt-in convention that
`eval-set.ts` documents — and adds the axis the P6A corpus structurally cannot cover:
the corpus is one turn per case, and *every* metric the study asks for (repeated
questions, flow restarts, "other doctors") is a failure of the **second** turn
contradicting the first.

Eight bilingual multi-turn scenarios, four variants:

| Variant | Route | maxSteps | Mount |
| --- | --- | --- | --- |
| `haiku-6-flat` | `patient-haiku-bootstrap-v1` (Haiku 4.5) | 6 | flat — **production baseline** |
| `haiku-6-staged` | same | 6 | stage-scoped |
| `sonnet-10-flat` | `patient-sonnet-candidate-v1` (Sonnet 4.5) | 10 | flat |
| `sonnet-10-staged` | same | 10 | stage-scoped |

The Sonnet candidate route is defined **in the harness, not in
`lib/ai/platform/registry.ts`**. `registry.ts` was not touched by this work. The
reasoning: adding an alias to the certification registry is precisely the decision the
measurement exists to inform, so making it a precondition of measuring would invert the
process. The route is nonetheless typed as `CertifiedModelRoute` and prepared through the
real `managedGatewayProvider.prepare()`, so it carries the identical ZDR enforcement, the
same `only: ["anthropic"]` provider pin and the same tags the product uses. It is the same
certified model tier as the already-approved `staff-sonnet-bootstrap-v1`; what it lacks is
a *patient-side* alias, privacy-policy version and certification record — which is exactly
what a permanent switch would have to add.

Tools are simulated by `BookingSimulator` against a fixture clinic, with the real tool
names, the real Zod schemas, the real result shapes and the real `guidance` strings —
and with the **real** `booking-stage.ts` machine driving the state, so a scenario measures
the logic that ships rather than a copy of it. The simulator also reproduces the
production availability recheck inside `createPatientPendingBooking`, so the
offered-options guard is measured for what it adds *on top of* that check rather than
being credited with its work.

This is an L2 measurement: prompt, model, tool schemas, step budget, stage scoping.
`authorizePatientConversation`, RLS, the entitlement checks, the identity RPCs and the
real availability engine are not in the loop and are covered by their own suites. That
boundary is stated in the module header, not in a footnote.

### 3.2 What happened when it was run

```
$ AI_EVAL_LIVE=1 AI_EVAL_VARIANTS=haiku-6-flat \
    node --env-file=.env.local node_modules/vitest/vitest.mjs run \
    tests/unit/ai/p9-booking-live-eval.test.ts

AI_RetryError: Failed after 3 attempts. Last error: Free tier requests on this
model are rate-limited. Upgrade to paid credits …
```

Every turn of every scenario failed the same way, on the baseline variant, before Sonnet
was ever attempted. The gateway account in `.env.local` has no paid credits.

**So there are no Haiku-vs-Sonnet numbers in this report, and none are invented.** The
harness is committed, runs on one command, and will produce the full table the moment
credits exist. What it needs:

```bash
AI_EVAL_LIVE=1 node --env-file=.env.local node_modules/vitest/vitest.mjs \
  run tests/unit/ai/p9-booking-live-eval.test.ts --testTimeout=1800000
# writes docs/reviews/artifacts/p9-booking-eval.{json,md}
```

### 3.3 What was measured instead

The study's acceptance criteria split in two, and conflating them is how an orchestration
change gets credited with a model's good day:

* **Judgement metrics** — *will this model remember the department?* Needs a live model.
  Blocked.
* **Structural metrics** — *can the workflow be violated at all?* These are properties of
  the orchestration, not of the model, and the honest way to measure them is to hold
  model competence at a constant of zero and see what the server still refuses.

`tests/unit/ai/p9-booking-orchestration-metrics.test.ts` does the second, deterministically,
offline, at no cost. A scripted **non-compliant model** — one that ignores the prompt
entirely and plays out the exact move sequence the study attributes to a small model
losing the thread — is pointed at both mounts. Its behaviour is byte-identical in both
columns, so every difference is the orchestration and nothing else.

Results (`docs/reviews/artifacts/p9-structural-metrics.json`, 8 scenarios):

| Tool the non-compliant model tried to call | Attempts | Reached it · flat mount (today) | Reached it · stage-scoped |
| --- | --- | --- | --- |
| `create_preliminary_booking` (out of order) | 32 | **32** | **0** |
| `list_available_days` (before a doctor) | 8 | **8** | **0** |
| `check_availability` (before a day) | 8 | **8** | **0** |

| Metric | flat mount | stage-scoped |
| --- | --- | --- |
| Bookings completed by a non-compliant model | **0** | **0** |
| Attempts that reached the offered-slot guard | 16 | 0 |
| Slots actually booked that were never offered | **0** | **0** |
| Illegal stage transitions recorded | 8 | 8 |

Reading it: on today's flat mount a confused model reaches the booking tool **every single
time**, and the only things between it and a wrong appointment are the server-side guards —
the availability recheck and, now, the offered-options guard, which together refuse all 16.
Under stage scoping those calls are not refused, they are **not callable**: the tool is
absent from the step's `activeTools` because the stage the turn opened in does not include
it.

Two honest caveats on that second column. First, it is that clean partly *because* the
stage is fixed for the whole turn (§4.4) — a scripted model that never lets the
conversation legitimately advance never sees the later stages open. Second, and more
important: **the zero in "reached the offered-slot guard" is not a better result than 16.**
It means the scoping got there first in this particular script. The guard is what protects
the case scoping cannot see — a *legitimately* staged conversation whose model names a time
nobody offered — which is why it lives in the tool, is enforced in `shadow` as well as `on`,
and is tested separately against the real tool (§6).

The row that matters most is the same in both columns: **zero bookings**. A model that
ignores every rule in the prompt does not produce an appointment, with or without the
scoping.

### 3.4 Prompt budget (deterministic, measured)

| Stage | EN prompt | vs. full | AR prompt | vs. full |
| --- | --- | --- | --- | --- |
| full (today) | 8 383 ch | — | 7 024 ch | — |
| `idle` / `identifying` / `escalated` | 3 714 | **−56%** | 3 141 | **−55%** |
| `selecting_department` | 4 354 | −48% | 3 655 | −48% |
| `intake_collecting` | 4 793 | −43% | 4 038 | −43% |
| `selecting_day` / `_time` / `confirming` / `submitted` | 4 885 | −42% | 4 170 | −41% |
| `selecting_doctor` | 6 133 | −27% | 5 098 | −27% |

Every stage prompt is a strict subset of the certified text plus a one-sentence banner.
Nothing is reworded.

---

## 4. The transition module

`lib/ai/booking-stage.ts` — 929 lines including its documentation, pure, no `server-only`,
no I/O, no clock it is not handed. 57 tests in `tests/unit/ai/p9-booking-stage.test.ts`.

### 4.1 Surface

| Function | What it answers |
| --- | --- |
| `deriveStage(facts)` | Where are we, from facts alone. Total over every fact combination (tested exhaustively). |
| `nextStage(stage, event)` | Where one event takes us. Total: every (stage, event) pair has an answer and none throws. A state machine that can throw inside a model loop turns a conversational oddity into a "technical problem" reply. |
| `isLegalTransition(from, to)` / `legalNextStages(from)` | The adjacency table, written out in full so a reviewer can disagree with it. |
| `classifyTransition(from, to)` | Names a move without performing one. |
| `advanceStage(state, derived, {at, countTurn})` | Moves the record; keeps `stageEnteredAt` stable when the stage is; **records an illegal jump and then accepts it**, because the derived stage is the truth and refusing to follow it would leave the record describing a conversation that is not happening. |
| `allowedToolsForStage(stage, mounted)` | Always a subset of `mounted`. Can hide a tool; can never conjure one. |
| `requiredFieldsForStage` / `missingFieldsForStage` | A stage's preconditions, derived and never stored (study Note 4). |
| `checkOfferedSlot(state, date, time)` | §6. |
| `establishedDepartmentId` / `establishedDoctorId` / `isBookingOpening` | §7. |

### 4.2 Two properties the table exists to guarantee

**Escalation is reachable from everywhere and escapable from nowhere.** Every stage has an
edge to `escalated`; `escalated` has exactly one edge, to itself. Asserted for all ten
stages and all seventeen events.

**`selecting_doctor` has no edge back to `selecting_department` except through an explicit
`department_cleared`.** That single omission is the structural fix for "'other doctors'
restarts the flow": the restart is not discouraged, it is unreachable. A test walks all
seventeen events from `selecting_doctor` and asserts none of them lands on
`selecting_department`.

### 4.3 Two deadlocks the harness caught — and the honest consequence

The first draft of the stage/tool table was stricter and **wrong**:

1. `check_availability` was mounted only from `selecting_time`, which requires
   `appointment_date`. But `check_availability` is the only tool that *writes*
   `appointment_date` (via `resolvePatientDate`). A conversation could reach
   `selecting_day`, list days, and then have no legal move at all.
2. `create_preliminary_booking` was mounted only at `confirming`, which requires
   `appointment_time`. But `create_preliminary_booking` is the only tool that writes
   `appointment_time`. `confirming` was unreachable.

Both were found by the deterministic harness, before any live run and before any patient.
The table now reads:

| Stage | Workflow tools |
| --- | --- |
| `idle` | `prepare_booking` |
| `identifying` | *(none)* |
| `intake_collecting` | `register_patient`, `prepare_booking`, `list_doctors` |
| `selecting_department` | `prepare_booking`, `list_doctors` |
| `selecting_doctor` | `prepare_booking`, `list_doctors` |
| `selecting_day` | `list_available_days`, `check_availability`, `prepare_booking`, `list_doctors` |
| `selecting_time` | `check_availability`, `list_available_days`, **`create_preliminary_booking`**, `prepare_booking`, `list_doctors` |
| `confirming` | `create_preliminary_booking`, `check_availability`, `list_available_days`, `prepare_booking`, `list_doctors` |
| `submitted` | `prepare_booking` |
| `escalated` | *(none)* |

**The weakened claim, stated plainly:** `create_preliminary_booking` is unreachable until
the department, the doctor *and a day* are established — not until a *time* is. Holding it
to `confirming` would be a deadlock, not a guard. The remaining gap — a time the patient
was never shown — is closed by `checkOfferedSlot` server-side (§6), which is a better
place for it anyway, because it also covers the `scheduled_at` path that no mount can see
into.

### 4.4 The one cost of stage scoping, stated plainly

The stage is resolved **once, at the top of the turn**, and held constant for every step
within it. That is deliberate: recomputing it inside the model loop would mean an extra
`resolve_patient_ai_context` round trip per step and — worse — would make the mount depend
on state the tools were mutating mid-loop, which is a race with a security-shaped failure
mode.

The cost is real and worth naming before anyone reads the eval table. On the flat mount,
"book me tomorrow with Dr Ahmed, the first available slot" can in principle be resolved in
a single turn, because every tool is callable at every step. Under `on`, that turn can
advance the *state* as far as the stage allows and then must hand back to the patient,
because a tool that becomes appropriate mid-turn is not mounted until the next inbound
message. A WhatsApp conversation is turn-per-message anyway, and the prompt already asks
for the step-by-step shape ("offer the days, ask which one"), so this mostly costs nothing
— but it can plausibly *raise* **turns to booking**, which is one of the study's own
acceptance metrics.

**This is the first thing the live comparison should look at**, and the reason the harness
reports `haiku-6-staged` and `sonnet-10-staged` as separate columns rather than folding
scoping in with the model change. If `on` improves repeated questions and flow restarts
but costs a turn, that is a trade to decide with numbers, not a regression to hide.

### 4.5 Tools that are never scoped away

`get_clinic_info`, `answer_clinic_faq`, `verify_patient_identity`, `list_my_appointments`,
`cancel_my_appointment`.

The scoping exists to stop the model running the *booking* steps out of order. It does not
exist to make "where are you?" unanswerable because the thread happens to be mid-booking,
or to strand a patient who wants to cancel something else. Each of these is independently
guarded server-side — identity verification, entitlement, pause — so leaving them mounted
costs nothing and removing them would create a new class of dead end. `identifying` is the
one exception: it mounts *no* workflow tool, so an unverified linked patient cannot be
walked into a booking by any amount of insistence.

---

## 5. Migration

**`supabase/migrations/20260823120000_ai_booking_stage_state.sql`** — new, additive, 228
lines. No already-applied migration was edited.

1. `conversations.ai_booking_stage jsonb` (nullable) + a `jsonb_typeof = 'object' and
   pg_column_size ≤ 4096` check, mirroring the P8B columns.
2. `clear_conversation_identity_on_patient_change` also clears it — stage belongs to the
   person the thread is about, on the same edge that already clears collected state.
3. `set_conversation_ai_state` gains `p_stage jsonb`. The 5-argument signature is
   **dropped** rather than overloaded: PostgREST resolves by argument names and an
   overload set would make a 5-argument call ambiguous. `p_stage` is a whole-object
   *replace*, unlike `p_collected`'s merge, because the record is one internally
   consistent snapshot and merging two partials could produce a state that was never true.
4. `resolve_patient_ai_context` gains `booking_stage jsonb` in its `returns table`. Body
   otherwise identical to the one deployed by `20260822190000` (soft-deleted patients read
   back as unlinked); `returns table` is not alterable in place, hence the full restatement.

Local verification only:

```
$ docker exec -i supabase_db_clinic-crm psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
    < supabase/migrations/20260823120000_ai_booking_stage_state.sql
ALTER TABLE … CREATE FUNCTION … DROP FUNCTION … CREATE FUNCTION … REVOKE … GRANT

$ … "select column_name, data_type from information_schema.columns
      where table_name='conversations' and column_name='ai_booking_stage';"
ai_booking_stage|jsonb

$ … pg_get_function_identity_arguments
set_conversation_ai_state|p_clinic_id uuid, p_conversation_id uuid, p_collected jsonb,
                          p_pending jsonb, p_clear_pending boolean, p_stage jsonb
```

`supabase_migrations.schema_migrations` was updated locally so the container's history
stays coherent. **Nothing was pushed remotely.**

`types/database.ts` was hand-patched surgically (the conversations Row/Insert/Update rows
and the two RPC signatures) rather than regenerated — a full local regen drifts ~1 184
lines from the committed remote-generated file.

---

## 6. The offered-options guard

`checkOfferedSlot` (pure) + `checkConversationOfferedSlot` (flag-aware) +
enforcement in `lib/ai/tools/create-preliminary-booking.ts`.

**The hole.** `ai_requested_slot_is_available` already refuses a slot the clinic cannot
serve, so a *nonexistent* time is caught. What was never caught is a time that happens to
be free but was never **offered** — the model volunteering "how about 4pm?" and booking it
because 4pm was open. That produces a real appointment the patient never chose, and no
prompt wording prevents it, because a prompt is advice.

**The mechanism.** `check_availability` is the only tool whose output is a list of bookable
times, so it is the only place the offer record is written — server-side, from the
availability engine's own result, with no argument the model can influence.
`create_preliminary_booking` then checks the requested local date and time against that
record. Both input paths converge on the check: the natural `date`/`time` path and the
`scheduled_at` timestamp path, deliberately, because the direct-timestamp path is the
easier one to hallucinate into.

**Enforcement is conditional**, and this is the part that keeps it from becoming a new
failure mode: it applies only once the conversation has recorded at least one real offer.
A conversation with no offers falls through untouched, so the guard can never invent a dead
end on a path the availability flow did not run. It only ever holds the model to what the
flow already said out loud.

On rejection the tool returns `reason: "slot_not_offered"` with `available_times` — the
real slots for that day — so the assistant's next move is to offer them, not to apologise.

Two suites cover it. The deterministic harness includes the case the availability recheck
alone does not catch — booking 11:00 on the 8th, a genuinely bookable slot, when
availability was only ever checked for the 7th. On the flat mount that request reaches the
guard 16 times across the corpus and is refused every time; zero never-offered bookings in
either mount (§3.3). `tests/unit/ai/p9-offered-slot-guard.test.ts` then exercises the real
`createPreliminaryBookingTool`, asserting that a never-offered time is refused on the
natural date/time path *and* on the `scheduled_at` path (16:00 Africa/Cairo arriving as
`13:00Z` is converted back to clinic-local time before comparison, so a UTC timestamp
cannot slip past a record written in local time), that `createPatientPendingBooking` is
never reached in either case, that an offered time still books, and that the guard goes
inert when `AI_PATIENT_STAGE_ORCHESTRATION=off`.

---

## 7. Consolidating the three ad-hoc guards

The study counted three hand-rolled "what stage are we in?" derivations. All three now
call the same functions.

| File | Before | After |
| --- | --- | --- |
| `prepare-booking.ts` | `const isBookingOpening = !department && !doctorQuery && !wantsAlternatives && !establishedDepartmentId` | `isBookingOpening(collected, {hasExplicitDepartment, hasDoctorQuery, wantsAlternatives})`, whose body is `missingFieldsForStage("selecting_doctor", collected).includes("department_id")` |
| `list-doctors.ts` | inline `typeof collectedData.department_id === "string" ? … : null` | `establishedDepartmentId(collected)` |
| `list-available-days.ts` | inline `typeof collectedData.doctor_id === "string" ? … : null` + inline "no doctor" refusal | `establishedDoctorId(collected)` + `missingFieldsForStage("selecting_day", …)` |
| `check-patient-availability.ts` | inline doctor read | `establishedDoctorId(collected)` |
| `create-preliminary-booking.ts` | inline doctor read | `establishedDoctorId(collected)` |

**This is a pure refactor.** The predicates are the same predicates; what changed is that
there is one implementation instead of five, and that adding a precondition to a stage no
longer means remembering to edit four files. Behaviour is unchanged with the flag off *and*
on, and the pre-existing suites that cover these tools
(`whatsapp-doctor-selection.test.ts`, `p8-patient-registration-and-input.test.ts`,
`p5a-patient-tools.test.ts`) pass untouched.

Each of the five tools additionally calls `recordStageTurn(...)` with a
`collectedOverride` naming the fields it just wrote — without it the derived stage would
lag one write behind the collected state it is derived from, and every tool would record
the stage it was *leaving*.

---

## 8. Observability

One line per stage movement, into `audit_logs` under the existing `actor_type='ai'`
provenance, next to the tool calls it explains:

```
tool: "patient_booking_stage"
params: { stage_before, stage_after, changed, tool_called, tool_outcome,
          legal_transition, turn, missing_required_fields, illegal_transitions_total }
```

Two stage names from a ten-value union, a tool name from an eleven-value union, an outcome
label, four integers, two booleans. **No** patient, conversation body, phone number, id,
date, tool argument or tool result. `toolAuditSummary` would strip a leaked email or long
digit run anyway; nothing here has one to strip. Tool and outcome labels are additionally
validated against `/^[a-z0-9_]{1,48}$/` before they are stored or logged, and a label that
fails becomes `"unknown"` rather than travelling.

This is the artefact the study named as its most expensive gap: there was nowhere that
said "on turn N the state was X, the model called Y, and the state became Z". There is now.

---

## 9. Rollback

One environment variable, `AI_PATIENT_STAGE_ORCHESTRATION`, three values:

| Value | Behaviour |
| --- | --- |
| `off` | Nothing. Flat mount, whole certified prompt, no stage derivation, no writes, no telemetry, offered-guard inert. Byte-for-byte the pre-P9 assistant. |
| `shadow` (**default**) | Stage derived, persisted and traced; consolidated guards read it; offered-slot guard enforced. The model's view of the world is unchanged — same mount, same prompt. |
| `on` | Additionally scopes `activeTools` and the system prompt to the stage. |

`shadow` is the default because it carries the observability and the server-side guards —
both strict improvements — while leaving the model-facing surface identical to the
certified baseline. Turning the mount and prompt scoping on is a deliberate act, and the
study's Phase 3 asks for a pilot clinic first.

**A bug found here, and the test that pins it.** In the first cut, `shadow` behaved like
`on`: `openBookingStageTurn` returned the derived stage whenever *tracking* was enabled,
and `createPatientAgent` narrows whenever it is handed one, so the default mode was
silently scoping the mount and the prompt. The fix is one guard —
`if (!stageScopedMountEnabled()) return null` — placed *after* the turn is counted,
persisted and traced, so `shadow` keeps everything it is supposed to keep and withholds
the one thing it is supposed to withhold. `tests/unit/ai/p9-offered-slot-guard.test.ts`
("the three orchestration modes") now asserts the full matrix: what each of the seven
accepted env values resolves to, that `shadow` returns no stage but still writes, that
`on` returns the stage, that `off` writes nothing at all, and that a `patient_faq` turn is
never scoped in any mode. The difference between the three modes *is* the rollback, so it
is the thing most worth a test.

The rollback is a flag flip that takes effect on the next inbound message. No state
migration is needed: the column is additive and an ignored column is a no-op. Every write
in `booking-stage-store.ts` is best-effort inside a `try/catch` that returns `null` — a
failed stage write cannot fail a turn, and the next turn re-derives the same stage from the
collected fields, which is exactly the pre-P9 behaviour.

The pre-existing degrade-to-human posture is untouched throughout: every failure still ends
in `escalateConversation`, `suggested_paused`, or `buildPatientTechnicalFallback`.

---

## 10. What was deliberately not touched

Verified by reading, and by the fact that the suites covering them pass unchanged:

`authorizePatientConversation` · `resolvePatientAiContext` · `protectPatientTool` ·
`sanitizeUntrustedDeep` / `withProvenance` · RLS and every `protect_*` trigger ·
`getEntitlements` / `hasFeature` · `createClinicScopedAdminClient`'s allow-list ·
`verify_patient_conversation_dob` and the 5-failure / 30-minute lock ·
`stage_patient_intake_from_conversation` and the exact `fold_*` identity matching ·
`computeAvailability` / `lib/booking/patient.ts` / `ai_requested_slot_is_available` ·
the 24-hour rule, `patient_pending_cap`, `slot_pending_cap` · `ai_patient_intakes` and
`approve_ai_patient_intake` · `claimAutoSend` and `ai_paused_at` takeover ·
`logAgentTool` → `toolAuditSummary` → `audit_logs` · every WhatsApp provider, worker,
session, media and history path · `human-input.ts`, `collected-state.ts`'s resolver,
`patient-escalation.ts`, `entity-resolution.ts` · `lib/ai/platform/registry.ts`
and `package.json` (both carry pre-existing uncommitted branch work — staff task
policies and a seed script — but **nothing from this work**; the `patient_booking` and
`patient_faq` policies and the dependency list are untouched, and no dependency was
added).

`buildPatientTools` still mounts all eleven tools for `patient_booking`. Stage scoping is
`activeTools`, a *narrowing* of an unchanged mount, which is what keeps the P6A containment
claim — an unauthorized tool is never in the object at all — exactly as strong as it was.

---

## 11. Gate results

| Gate | Result |
| --- | --- |
| `npm run test:ai-adversarial` | **136/136 pass** |
| Eval corpus consistency (offline) | `scoreOfflineConsistency` ≥ `EVAL_PASS_THRESHOLD`, unchanged corpus |
| Forbidden tool calls | **0** — `allowedToolsForStage` proven a subset of `mounted` for all ten stages; asserted also against a two-tool FAQ mount |
| Automated `public.patients` writes | **0** — no code path added; `register_patient` still stages for human review |
| `npx tsc --noEmit` | **clean** |
| `npm run lint` | **0 errors** (28 pre-existing warnings, none in new files) |
| `npm run lint:i18n` | **pass** — 455 files, no hardcoded user-facing strings |
| `npm run lint:rtl` | **pass** — 722 files, no undocumented physical-direction styles |
| `npx vitest run tests/unit/ai` (serial) | **1282/1282 pass** |
| New P9 suites | **76 pass** — 57 stage machine, 8 structural metrics, 11 offered-slot guard + rollback-mode matrix against the real tool — plus 4 offline eval preconditions |
| `npm test` (full unit suite) | **407 files / 3476 tests pass**, 2 skipped by design (§11.1) |
| `npm run test:integration` (RLS/tenant isolation) | **59 files / 565 tests pass** against the local DB with the migration applied (§11.1) |
| `npm run build` | **succeeds**, exit 0 (§11.1) |

A note on the suite: running `tests/unit/ai` with file parallelism produced three 30-second
timeouts in `phase7-*` and `post-plan-*` — files this work does not touch. Re-run with
`--no-file-parallelism` they pass, along with everything else. The failures are machine
load, not regressions.

### 11.1 Long-running gates

**Integration / RLS / tenant isolation** —
`node --env-file=.env.local … run tests/unit/integration --no-file-parallelism`, against
the local Supabase container with the new migration applied:

```
Test Files  59 passed | 1 skipped (60)
Tests      565 passed | 3 skipped (568)
```

Includes `p5a-patient-tools-booking`, `p8-ai-intake-booking-rls`,
`p8-whatsapp-doctor-selection`, `p4a-ai-tools-rls`, `assistant-scope-rls`, `rls-security`
and `p1a-saas-platform-rls`. The widened `resolve_patient_ai_context` and
`set_conversation_ai_state` signatures are exercised by these, not merely compiled against.

**Production build** — `npm run build`: **succeeded**, exit 0, all routes compiled.

**Full unit suite** — `npm test -- --no-file-parallelism`, run after the last code change
rather than before it:

```
Test Files  407 passed (407)
Tests      3476 passed | 2 skipped (3478)
```

The two skips are the `AI_EVAL_LIVE` cases in `p9-booking-live-eval.test.ts`, skipped by
design out of CI. Nothing else is skipped and nothing failed.

---

## 12. Files changed

**New**

| File | Lines | Purpose |
| --- | --- | --- |
| `lib/ai/booking-stage.ts` | 929 | The pure machine: stages, derivation, transitions, tool map, required fields, offer guard, record parsing. |
| `lib/ai/booking-stage-store.ts` | 409 | The durable half: the switch, persistence, telemetry, turn boundaries. The only writer of the column. |
| `lib/ai/eval/booking-scenarios.ts` | 850 | Eight bilingual multi-turn scenarios + the fixture-clinic simulator. |
| `lib/ai/eval/booking-harness.ts` | 619 | Candidate routes, the simulated eleven-tool mount, the runner, the detectors, the metrics. |
| `supabase/migrations/20260823120000_ai_booking_stage_state.sql` | 228 | The additive migration. |
| `tests/unit/ai/p9-booking-stage.test.ts` | 796 | 57 tests over the machine and the prompt invariants. |
| `tests/unit/ai/p9-booking-orchestration-metrics.test.ts` | 314 | The deterministic structural measurement. |
| `tests/unit/ai/p9-booking-live-eval.test.ts` | 247 | The `AI_EVAL_LIVE=1` model comparison. |
| `tests/unit/ai/p9-offered-slot-guard.test.ts` | 280 | The offered-options guard exercised against `createPreliminaryBookingTool` itself, on both input paths, plus the three-mode rollback matrix. |

**Modified**

| File | Change |
| --- | --- |
| `lib/ai/prompts/patient.ts` | Split into six ordered sections per language. `HEAD + INTAKE + BOOKING + DOCTOR + SCHED + TAIL` reassembles the certified prompt **byte-for-byte** (verified programmatically, and asserted by ordering markers in the tests). Adds `buildPatientStagePrompt` and ten bilingual stage banners. |
| `lib/ai/patient-agent.ts` | `prepareStep` now returns `activeTools` + a stage `system` when a stage is supplied; `{}` otherwise. The mount is unchanged. |
| `lib/ai/patient-reply.ts` | Opens each turn with `openBookingStageTurn`; latches `escalated` on both escalation paths. |
| `lib/ai/patient-authorization.ts` | `ResolvedPatientAiContext` gains `bookingStage`, parsed through `parseBookingStageState`. |
| `lib/supabase/admin.ts` | `setConversationAiState` gains `stage`. |
| `types/database.ts` | Column + two RPC signatures, hand-patched. |
| `lib/ai/tools/prepare-booking.ts` · `list-doctors.ts` · `list-available-days.ts` · `check-patient-availability.ts` · `create-preliminary-booking.ts` · `register-patient.ts` | Consolidated guards, stage recording, offer recording, and the offered-options guard. |
| `tests/unit/ai/whatsapp-patient-availability-scope.test.ts` · `tests/unit/lib/p8-ai-booking-availability.test.ts` | Fixtures gain `bookingStage: EMPTY_BOOKING_STAGE_STATE`. |

**Not changed by this work:** `package.json` (no dependency added),
`lib/ai/platform/registry.ts` (the `patient_booking` policy still reads
`primaryModelAlias: "patient-haiku-bootstrap-v1"`, `maxSteps: 6`),
`lib/ai/patient-tools.ts`, every file in §10. Both of the first two carry unrelated
pre-existing uncommitted branch changes; neither came from here.

---

## 13. Final recommendation

### On the model: stay on Haiku, for now

`patient_booking` still points at `patient-haiku-bootstrap-v1` with `maxSteps: 6`. Nothing
in the registry moved.

This is not a finding that Sonnet is worse. It is the honest consequence of the study's own
decision rule — *"do not permanently switch models unless the measured result is clearly
better"* — meeting a measurement that could not be taken. There is no measured result, so
there is no basis for a switch. A switch made on expectation would be exactly the failure
mode the study's Phase 0.5 was designed to prevent.

What is now true that was not before: the switch is **one line plus a certification pass**,
and the evidence for or against it is **one command away** rather than a research project.
When the gateway account has credits, run §3.2's command and the four-variant table decides
it. The three things that decision must also weigh, and which no eval produces:

* **Cost.** Sonnet is 3× input and 3× output per token. The harness reports cost per
  completed booking, which is the number that actually matters — a model that books in
  three turns instead of five can be cheaper at 3× the token price.
* **Latency.** WhatsApp patients feel wall-clock time. The harness reports p50/p95.
* **Certification.** A patient-side Sonnet alias needs its own entry, its own
  `patient-zdr-no-training-v1` stamp, and its own certification record. The candidate route
  in the harness is deliberately *not* that.

### On the architecture: the study's Option 4 was right, and it is now done

Phases 1 through 4 are implemented, behind a flag, with the guards consolidated and the
observability gap closed, at zero new dependencies and zero change to the certified
execution path. The deterministic measurement shows the structural claims hold: a model
that ignores every rule in the prompt cannot reach the booking tool out of order and cannot
book a slot nobody offered.

What remains genuinely unproven is the *judgement* half — whether a smaller, stage-scoped
prompt makes Haiku stop repeating itself. The harness measures it; the measurement needs
credits. Until then `shadow` is the right default: it ships every part of this work whose
value does not depend on the model's behaviour, and holds back the only part that does.

**Do not escalate to a framework.** Nothing encountered in the implementation argued for
one. The transition module came in at 929 lines including its documentation — well under
the study's ~1 500-line trigger — it grew no scheduler, no retry policy and no interrupt
semantics, and the two real bugs it surfaced were table errors that a graph engine would
have encoded just as faithfully.

---

*Implementation only. Nothing was deployed. No migration was pushed to a remote database.*
