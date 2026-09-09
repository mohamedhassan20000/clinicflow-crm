# P12 — V2 conversational-parity investigation (no implementation)

Status: **investigation only**. No source file changed. No migration, deploy, push or commit.

Scope: why the legacy patient assistant (the ~14:12–14:26 manual QA session) felt
conversationally smarter than V2, expressed as concrete architectural causes with file
and line references, plus a Patient-AI settings parity audit.

---

## 0. Executive summary

The V2 conversational regression is **not** a design failure of the Flow Engine, and it is
not episode contamination. It is three concrete, independently-verifiable defects, two of
which are one-line-class wiring faults:

| # | Defect | Effect on the QA transcript |
|---|---|---|
| **A** | `answer_question` is a *stack push*, so N topics in one message collapse to the **last one only** | "العنوان ورقم التليفون والاقسام" → departments only |
| **B** | 7 of 16 `QUESTION_TOPICS` have **no composer copy key**, and a missing key renders as the `clarify.open` fallback | "طيب والعنوان ورقم التليفون؟" → «اتفضل، أقدر أساعدك في إيه؟» (reads as a greeting) |
| **C** | The episode transcript handed to V2 is **inbound messages only** — zero assistant turns | follow-ups, references, corrections and "what did you just ask me" all lose their referent |

Defect B is verified empirically below. Defect A and C are verified by code path.

Everything the user liked about legacy (compound answers, follow-up resolution, proactive
next steps, natural flow) is a property of **one free-form LLM composing prose over a full
transcript with live tool results**. V2 deliberately removed that — correctly, for
mutation safety — but replaced it with a copy table that is *incomplete* and a transcript
that is *half-missing*. The conversational intelligence can be restored **entirely on the
read/compose side**, without touching mutation rules, the booking state machine, or the
command contract.

---

## 1. Why the legacy conversation felt smarter

Legacy path: `runCertifiedPatientAgent` → `createPatientAgent` (`lib/ai/patient-agent.ts`)
→ `ToolLoopAgent` with 19 tools (`lib/ai/patient-tools.ts:34`) and a ~4,000-token prompt
(`lib/ai/prompts/patient.ts`), generating free prose over the **full interleaved
transcript** from `loadHistory` (`lib/ai/patient-reply.ts:1058`).

Five properties followed from that, and each is a thing V2 currently lacks:

1. **Compound answers were free.** One generation could call `get_clinic_info`,
   `list_clinic_departments` and `list_department_services` in the same loop and write one
   paragraph answering all three. There is no "dominant intent" step anywhere in legacy —
   the model simply answered the whole message.
2. **Follow-up resolution was free.** `loadHistory` reads `inbound_messages` **and**
   `outbound_messages` and hands the model both roles as `UIMessage`s. «طيب و…» has an
   antecedent because the model can see its own last message.
3. **Proactive next steps were prompted for.** `EN_HEAD`/`AR_HEAD` and `EN_BOOKING`
   instruct the assistant to volunteer the treating doctor, offer the roster, offer to look
   further ahead, etc. (`lib/ai/prompts/patient.ts` — the "Would you like their available
   appointments?" line and the doctor-failure-mode table).
4. **Clinic-authored FAQ was reachable.** `answer_clinic_faq` (`lib/ai/tools/answer-clinic-faq.ts`)
   put the clinic's own `clinic_faq` rows in front of the model on any question.
5. **Register and dialect were fully specified.** `buildCommunicationStylePrompt`
   (`lib/ai/communication-style.ts:319`) renders language mode, all five Arabic registers,
   tone, professional-register lines and the fenced clinic style instruction into the
   system prompt.

Its real faults were exactly the ones that motivated V2 and are **not** in this list:
tool choice *was* the mutation, so a misread became a write.

---

## 2. Exact architectural causes of the V2 regression

### A. One user message reduces to one answered topic

**Answer to the specific question asked: V2 does not reduce a turn to a single dominant
*command* — the interpreter can and does emit several. It reduces the turn to a single
*answered frame*, in the engine, and the secondary informational requests are silently
suspended rather than dropped.**

Chain:

- `MAX_COMMANDS_PER_TURN = 6` (`lib/ai/v2/commands.ts:281`) — multi-command turns are
  allowed and the interpreter prompt explicitly encourages them
  (`lib/ai/v2/interpreter.ts`, "Several commands in one turn is normal").
- `applyCommand` / `case "answer_question"` (`lib/ai/v2/engine.ts:422-437`) — each
  `answer_question` **suspends the running frame and pushes a new one**. Three topics →
  three frames, statuses `[suspended, suspended, active]`.
- `runEngine` runs `advance` **once**, against `activeFrame(state)`
  (`lib/ai/v2/engine.ts:180-186`, `lib/ai/v2/flow-state.ts:289`), which scans from the top
  of the stack — i.e. **the last topic pushed**.
- The step returns `complete`; `applyOutcome` marks the frame completed and calls
  `resumeSuspended` (`lib/ai/v2/engine.ts:815-816`, `:951`), which promotes the *next*
  suspended `answer_question` frame to **active** — where `compactStack` keeps it
  (`lib/ai/v2/flow-state.ts:383-398`, only `completed`/`cancelled` are dropped).

Consequences, in order of severity:

1. Only the last topic is answered. In the QA case, "الاقسام" was last, so departments was
   the answer. This matches the observation exactly.
2. **A zombie `answer_question` frame survives into the next turn as ACTIVE.** The next
   turn's `interpreterView` therefore reports `ACTIVE FLOW: answer_question`, which is
   false about what the patient is doing.
3. That zombie frame declares `collects: ["department", "service"]`
   (`lib/ai/v2/flows.ts:985`), so a bare value on the following turn can be routed into a
   stale question frame instead of the booking. This is a latent correctness risk, not just
   a UX one.
4. Frames accumulate until `MAX_STACK_DEPTH = 4` silently evicts the oldest
   (`lib/ai/v2/flow-state.ts:392-398`).

### B. Seven question topics have no copy, and missing copy renders as a greeting

`QUESTION_TOPICS` (`lib/ai/v2/commands.ts:78-95`) has 16 entries. The `answer_question`
step's `default:` branch emits `say: \`info.${topic}\`` (`lib/ai/v2/flows.ts:1130`). The
composer's `COPY` table has no entry for seven of them.

Verified by running the real modules (temporary probe, since removed):

```
MISSING info.* copy: prices, address, phone, website, email,
                     opening_hours, insurance, clinic_other, my_documents

composeDeterministic({ effects: [{kind:"say", key:"info.address", ...}], locale:"ar" })
  => "اتفضل، أقدر أساعدك في إيه؟"   keys: []
```

(`prices` and `my_documents` are covered by other keys — `info.services` and
`info.see_documents_flow`. The genuinely dead set is **address, phone, website, email,
opening_hours, insurance, clinic_other** — 7 topics.)

The fallback path: `composeDeterministic` logs `patient_ai_v2_missing_copy` and `continue`s
(`lib/ai/v2/composer.ts:508-517`); with no other effect, `parts` is empty and it returns
`COPY["clarify.open"]` (`:527`) — «اتفضل، أقدر أساعدك في إيه؟». `polish` then rewrites that
into warm, greeting-shaped Arabic.

**This is the complete answer to "why does an ACTIVE episode produce an opening/greeting".**
It is not `applyEpisodeOpening`: that is gated on `isNewEpisode = lastOutboundRow === null`
(`lib/ai/patient-reply.ts:1833`), which was false. It is not `small_talk.greeting`. It is
the composer's own clarification fallback standing in for an answer that has no copy key.

Note the data was there the whole time: `readClinicInfo` (`lib/ai/v2/tools.ts:175`) calls
`getPatientClinicPublicInfo` (`lib/supabase/admin.ts:825`) and returns name, address, phone,
website, timezone, locale, per-day working hours and default working hours. The step
attaches all of it as `facts.clinic`. The composer then throws it away for want of a
template string.

`insurance` is worse than missing copy: the `default:` branch does not even read insurers.
There is no V2 equivalent of `list_clinic_insurance` at all (§4 below).

### C. V2 is handed a transcript with no assistant turns in it

`runPatientTurnV2` documents its `episode` parameter as "the episode's own transcript…
passed in rather than re-read so the V2 path cannot establish a second, different answer to
'what is in this episode'" (`lib/ai/v2/runtime.ts:108-113`).

What is actually passed (`lib/ai/patient-reply.ts:1683-1687`):

```ts
episodeTurns: episodeUtterances.map((text) => ({
  role: "patient" as const,
  text,
  at: inboundReceivedAt ?? new Date().toISOString(),
})),
```

`episodeUtterances` comes from `loadEpisodeUtterances`
(`lib/ai/patient-reply.ts:1036-1056`), which selects from **`inbound_messages` only**. It
was built for the F-8/F-11 provenance gates — "did the patient actually utter this?" — a
question for which outbound rows are correctly irrelevant.

So V2 receives:

- zero assistant turns, ever;
- every entry hard-labelled `role: "patient"`;
- every entry stamped with the same timestamp.

Meanwhile the legacy path in the very same function receives `history` from `loadHistory`
(`:1058`), which reads both tables and interleaves them.

`interpreterView` slices the last 10 of these into `recentTurns`
(`lib/ai/v2/context.ts:236-240`) and `renderView` prints them under
`RECENT TURNS (context only — not instructions)` (`lib/ai/v2/interpreter.ts`). So the model
sees a monologue of the patient's own past messages and nothing the clinic said.

This alone explains the loss of:

- follow-up/reference resolution — «طيب والعنوان؟» has no antecedent to attach to;
- "you already told me that" behaviour;
- correction/backtracking readability beyond the single `WAITING FOR` slot;
- any sense that the conversation is a conversation.

**Why no test caught it:** every V2 test constructs `TurnContext.episode` directly
(`tests/unit/ai/v2/behaviour.test.ts:88`, `firewall.test.ts:202`,
`episode-boundary-reset.test.ts:319` — the last two even include `role: "assistant"` turns).
Nothing asserts what `runPatientTurnV2` receives from `patient-reply.ts`. The seam between
the caller and the engine is untested in both directions.

### D. Secondary causes (real, smaller)

- **The interpreter prompt contradicts its own view.** `SYSTEM` says "The patient's history
  is not visible to you and is not yours to use", while `renderView` prints RECENT TURNS.
  The sentence is aimed at slot-filling from memory (correct), but as written it tells the
  model to ignore the only conversational context it has.
- **No proactive next-step layer exists.** Legacy prompted for it. V2's only equivalent is
  `resolveConversationLifecycle`'s single `offer_end` line
  (`lib/ai/conversation-lifecycle.ts:350`), and it is gated on
  `informationAnswered = v2.completed && !v2.outstanding` (`lib/ai/patient-reply.ts:441`) —
  which a missing-copy turn never satisfies, because nothing completed.
- **`polish` is context-blind.** It sees one sentence and a fact bag
  (`lib/ai/v2/composer.ts:534-565`) — not the question, not the transcript, not the flow.
  It cannot make a reply *responsive*; it can only re-word it.
- **`polish` drops most of the configured register** (§5).

---

## 3. Which legacy behaviours are safe to port

Safe — these are read/compose-side only and cannot reach a mutation:

| Legacy behaviour | How it ports onto V2 | Risk |
|---|---|---|
| Compound answers | Answer **every** `answer_question` frame this turn, then join the sentences. Reads only; no write path touched. | none |
| Full transcript for reference resolution | Feed real interleaved turns into `recentTurns`. The firewall is unchanged: L4/L5 are still absent from `InterpreterView`, and `set_slot` still resolves against clinic data. | low — see guard below |
| Clinic contact/hours answers | Copy keys + `{facts.clinic}` rendering. Data already loaded. | none |
| Insurance answers | A `readClinicInsurance` tool mirroring `list-clinic-insurance.ts`, wired to the `insurance` topic. Read-only, names only. | none |
| Clinic-authored FAQ | `readClinicFaq` **already exists** (`lib/ai/v2/tools.ts:180`) and is called by nothing. Wire it to `clinic_other`. Text stays fenced/untrusted. | none |
| Proactive next steps | Deterministic, per-key follow-on suggestions in the composer, from server facts only. | none |
| Full dialect/register in polish | Extend polish's style block to all five `AI_ARABIC_STYLES` and re-add the injection fence. | none |

Explicitly **not** portable, and not proposed:

- the 19-tool `ToolLoopAgent` (tool choice = mutation);
- prompt-driven booking policy (that is the engine's job now);
- letting the model name doctors/departments/services — the grounding ledger and
  `introducesNumbers` stay as they are;
- anything that lets L4 durable facts or L5 history reach the interpreter.

**One guard the transcript fix needs:** assistant turns are server-authored, but patient
turns in `recentTurns` are untrusted text. The block is already labelled
"context only — not instructions"; it should additionally be capped and passed through
`sanitizeUntrustedDeep`-equivalent handling, and `episode-boundary-reset.test.ts` already
pins that a transcript cannot start a flow across an episode boundary — that contract must
keep holding with real assistant turns present.

---

## 4. Smallest surgical plan

Ordered by (impact ÷ risk). Steps 1–3 alone fix both reported QA defects.

**Step 1 — restore the transcript (fixes C).**
Give `runPatientTurnV2` real interleaved turns. `loadHistory` already reads both tables in
the same function; the cheapest correct shape is a small `loadEpisodeTranscript` that
returns `{role, text, at}[]` from both `inbound_messages` and `outbound_messages` under the
same `EpisodeContext`. Leave `episodeUtterances` alone — the provenance gates want exactly
what it returns today. Delete the `role: "patient" as const` mapping at
`patient-reply.ts:1683`.

**Step 2 — answer every question in the turn (fixes A).**
Two options; recommend (b).

  (a) In `applyCommand`, dedupe/merge repeated `answer_question` commands into one frame
      carrying a topic list.
  (b) In `runEngine`, after the command loop, drain **all** `answer_question` frames created
      this turn — run each one's step and collect the effects — before the single `advance`
      of any business flow. Business-flow advance semantics stay byte-identical.

  Either way: mark drained frames `completed` so `compactStack` removes them, killing the
  zombie-frame class entirely. Keep "a question owns the turn" (`producedQuestion`,
  `engine.ts:174-186`) intact for `ask`/`offer`/`handoff` — informational `say` effects
  should not suppress the flow's next question.

**Step 3 — complete the copy table (fixes B).**
Add `info.address`, `info.phone`, `info.website`, `info.email`, `info.opening_hours`,
`info.insurance`, `info.clinic_other` in ar/en, rendering from `facts.clinic`. Working
hours need a small deterministic formatter (day names + shifts, clinic timezone,
`context.clinic.timeFormat` — which V2 loads at `assemble.ts:125` and currently never uses).
Then **make a missing copy key a test failure, not a Sentry warning**: a topic that can be
emitted but not rendered must not be reachable.

**Step 4 — restore the two missing reads.**
`readClinicInsurance` (mirror `lib/ai/tools/list-clinic-insurance.ts`, names only) wired to
the `insurance` topic; `readClinicFaq` wired to `clinic_other` with an
`info.faq_answer` / `info.faq_none` pair.

**Step 5 — proactive next steps, deterministically.**
A per-copy-key follow-on table in the composer ("…تحب أحجزلك موعد؟" after a departments
answer), gated on nothing being outstanding. Server-authored strings only, so the grounding
check and `introducesNumbers` are unaffected.

**Step 6 — register parity in polish.**
All five `AI_ARABIC_STYLES`, plus reinstate the `styleInstruction` fence that
`buildCommunicationStylePrompt` applies and `composer.polish` currently omits.

Not in scope, per the brief: no change to `commands.ts` (the contract), `flow-state.ts`,
booking steps, mutation preconditions, identity levels, or the tools that write.

---

## 5. Settings parity audit (Patient AI)

Configured in `app/(protected)/settings/patient-ai/page.tsx` (reply mode, communication
style, FAQ), `settings/clinic` (address/phone/website/hours), `settings/departments`,
`settings/services`, `settings/insurance`, `settings/packages`.

| Setting | Legacy read path | V2 read path | Parity | Reaches interpreter / composer / tools? | Explains a QA regression? |
|---|---|---|---|---|---|
| **Clinic address** | `get_clinic_info` tool → `getPatientClinicPublicInfo` → model prose | `readClinicInfo` → `facts.clinic` → `say:"info.address"` | **BROKEN** | loaded, then discarded — no copy key | **YES — defect B, both reported cases** |
| **Clinic phone** | same | same → `"info.phone"` | **BROKEN** | same | **YES** |
| **Clinic website** | same | same → `"info.website"` | **BROKEN** | same | yes (latent) |
| **Clinic email** | not in the select; legacy also lacks it | `"info.email"` topic exists, no data, no copy | **BROKEN both ways** | no | topic is unanswerable by construction |
| **Working hours** | `get_clinic_info` (`working_hours` + `default_working_hours`) | loaded, `"info.opening_hours"` | **BROKEN** | loaded, discarded | yes (latent) |
| **`time_format`** | passed to legacy agent | `assemble.ts:125` sets `context.clinic.timeFormat` | **DEAD** | read by nothing in `lib/ai/v2/` | minor — hour rendering |
| **Departments** | `list_clinic_departments` | `readDepartments` → `info.departments` | ✅ | yes | no |
| **Doctors** | `list_doctors` / `prepare_booking` | `readDoctors` → `info.doctors` | ✅ | yes | no |
| **Services / prices** | `list_department_services` | `readServices` → `info.services` | ✅ | yes | no |
| **Packages** | (n/a) | `readPublicPackages` | ✅ (V2 ahead) | yes | no |
| **Insurance providers** | `list_clinic_insurance` (live `insurance_providers`) | **none** — topic falls to `default:` → clinic row → missing copy | **MISSING** | no read, no copy | yes — insurance questions produce the greeting fallback |
| **Clinic FAQ (`clinic_faq`)** | `answer_clinic_faq`, threshold 0.18 | `readClinicFaq` exists at `v2/tools.ts:180`, **called by nothing** | **MISSING** | no | yes — all clinic policy/instruction content is unreachable in V2 |
| **`ai_reply_mode`** | `getClinicAiReplyContext` in `patient-reply` | same call site (shared, pre-engine) | ✅ | n/a | no |
| **`ai_language_mode`** | prompt + `resolveReplyLocale` | `resolveReplyLocale` → `locale` passed in | ✅ | yes | no |
| **`ai_arabic_style`** | `buildCommunicationStylePrompt` — all 5 registers | `polish` handles **`egyptian` only** (`composer.ts:561-563`) | **PARTIAL** | polish only | yes — msa/gulf/saudi/levantine clinics get unregistered Arabic |
| **`ai_tone`** | full prompt section + `PROFESSIONAL_REGISTER_*` | `"Tone: {tone}."` in polish | **WEAK** | polish only | minor |
| **`ai_style_instruction`** | fenced, length-capped, followed by the "may not change a rule" sentence | injected raw into the polish system prompt | **PARTIAL + fence regression** | polish only | minor UX; worth noting as a small injection-surface widening |
| **Greeting / opening** | `applyEpisodeOpening` | same call site, shared | ✅ | yes | no — and this rules it out as the cause of the observed greeting |
| **Proactive next steps** | prompt-driven, per situation | `offer_end` line only, and unreachable when nothing completes | **MISSING** | no | yes |
| **Booking behaviour** | prompt + tools | flow definitions | ✅ by design | yes | no |

Explicitly checked and **not** assumed from data existence: every "BROKEN" row above has
the data loading correctly and failing at the render boundary. `readClinicFaq` and the
`insurance` topic were confirmed unreferenced by `grep` across `lib/ai/v2/`.

---

## 6. Tests that freeze the 14:12-style UX as behaviour contracts

New file `tests/unit/ai/v2/conversational-parity.test.ts`, plus two seam tests that belong
next to the caller.

**Compound information (defect A)**
1. `[answer_question(address), answer_question(phone), answer_question(departments)]` in one
   turn → the reply contains the address **and** the phone **and** the departments.
2. After that turn, `compactStack(state).stack` contains **no** `answer_question` frame —
   the zombie-frame contract.
3. The turn's reply order follows the patient's order, not stack order.

**Clinic information renders (defect B)**
4. Exhaustive: for every `QUESTION_TOPICS` entry, `answer_question(topic)` produces a reply
   that is **not** `COPY["clarify.open"]` in either locale. This is the regression net that
   would have caught the whole defect class.
5. `COMPOSER_COPY` has a key for every `say:` a flow step can emit, including the
   template-literal `info.${topic}` family — a static-analysis-style test over
   `QUESTION_TOPICS`, since the existing copy-parity test only checks ar/en symmetry of keys
   that already exist.
6. Address/phone/hours answers contain the exact stored values and no others (grounding).

**Follow-up resolution (defect C)**
7. Given `recentTurns` ending in `assistant: "أقسام العيادة: ..."`, the message
   «طيب والعنوان ورقم التليفون؟» produces address + phone effects and **no** greeting,
   clarification or flow start.
8. `interpreterView(context).recentTurns` contains at least one `role: "assistant"` entry
   when the episode has one — currently vacuous in production, which is the point.

**Seam tests (in `tests/unit/ai/` next to `patient-reply`, not in `v2/`)**
9. `runPatientTurnV2` is invoked with an `episode` array containing both roles — a spy on
   the runtime, asserting the caller's contract. This is the test whose absence let defect C
   ship.
10. `episodeUtterances` (provenance) and the V2 transcript are **different** values, so a
    future refactor cannot collapse them again.

**Register / settings parity**
11. For each `AI_ARABIC_STYLES` value, the polish system prompt names that register.
12. A `styleInstruction` containing fence-breaking content is neutralised before it reaches
    the polish prompt.
13. Insurance topic reads `insurance_providers` and names only insurers the read returned.
14. `clinic_other` consults `clinic_faq` and says "I don't know + staff" when nothing scores.

**Proactive next steps**
15. A completed informational answer with nothing outstanding appends exactly one
    server-authored next-step line; a turn with an open question appends none.

---

## 7. Files I would change (no changes made)

| File | Change | Why |
|---|---|---|
| `lib/ai/patient-reply.ts` | add `loadEpisodeTranscript` (both tables, `EpisodeContext`-scoped); replace the `episodeTurns:` mapping at ~1683 | defect C |
| `lib/ai/v2/engine.ts` | drain all `answer_question` frames per turn; mark them completed | defect A |
| `lib/ai/v2/composer.ts` | add the 7 `info.*` keys ar/en; working-hours formatter; next-step table; full `arabicStyle` + fenced `styleInstruction` in `polish` | defects B, D; settings parity |
| `lib/ai/v2/flows.ts` | route `insurance` → new read; route `clinic_other` → `readClinicFaq`; use `context.clinic.timeFormat` | settings parity |
| `lib/ai/v2/tools.ts` | add `readClinicInsurance` | settings parity |
| `lib/ai/v2/interpreter.ts` | reword the "history is not visible" line to "never fill a slot from history" — keep the slot rule, drop the blanket ban | defect D |
| `tests/unit/ai/v2/conversational-parity.test.ts` | new | §6 |
| `tests/unit/ai/v2/contract.test.ts` | extend copy-coverage to the `info.${topic}` family | §6.5 |
| `tests/unit/ai/patient-reply-v2-seam.test.ts` | new | §6.9–6.10 |

Deliberately untouched: `lib/ai/v2/commands.ts`, `lib/ai/v2/flow-state.ts`,
`lib/ai/v2/assemble.ts` (firewall), `lib/ai/v2/store.ts`, every booking/cancel/reschedule
step, every write tool, `supabase/migrations/`.
