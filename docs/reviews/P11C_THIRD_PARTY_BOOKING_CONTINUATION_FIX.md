# P11C — "عايز احجز لابني علاج طبيعي": the pre-model escalation that ate the booking

Branch: `feat/p7-manual-qa-polish` · Local only. Nothing pushed, nothing
deployed, **no write of any kind to the remote database** — the hosted project
was read over the REST API with the service key and nothing else.

---

## 0. The evidence

Recovered from the hosted project (`ayzetxywrqouqpurbjuv`) that `.env.local`
points `next dev` at. Four rows, and they are the whole answer.

**`inbound_messages`, the turn under test:**

```
id         fec34ef8-cf58-4b11-a09a-ec99b44854b2
conv       763b1c6b-c388-4f36-b8ca-965f71f20f86
created_at 2026-08-24T14:44:26.948766+00:00
body       "بقولك يمعلم نكمل؟ انا عايز احجز لابني علاج طبيعي"
```

**`audit_logs` for that turn — two rows, and only two:**

```
14:44:29.311  agent_tool:patient_escalation
              {"mode":"auto","sent":true,"reason":"medical"}
14:44:29.622  agent_tool:patient_booking_stage
              {"turn":27,"changed":false,"stage_after":"escalated",
               "tool_called":"patient_escalation","stage_before":"escalated",
               "tool_outcome":"escalated","legal_transition":true}
```

**`conversations` after the turn:**

```json
{"ai_escalated_at": "2026-08-24T14:44:28.632+00:00",
 "ai_escalation_reason": "medical",
 "ai_collected_data": {"appointment_date": "2026-08-23"},
 "ai_booking_stage": {"stage":"escalated","escalated":true,"bookingForOther":true,
   "turnCount":27,"stageEnteredAt":"2026-08-23T17:14:34.957Z","offeredDoctorIds":[],
   "lastToolOutcome":{"at":"2026-08-24T14:44:29.390Z","tool":"patient_escalation",
                      "outcome":"escalated"}}}
```

**Every deterministic escalation this clinic has ever produced:**

```
2026-08-24T14:44:29  {"reason":"medical"}   ← the reported turn
2026-08-23T17:14:34  {"reason":"medical"}
2026-08-23T13:39:12  {"reason":"medical"}
2026-08-21T16:18:12  {"reason":"low_confidence"}   (post-model, unrelated)
```

The messages that produced the three `medical` rows, from `inbound_messages`:

| at | message | preceding message |
|---|---|---|
| 13:39:10 on 08-23 | `علاج طبيعي` | `عايزه احجز موعد` |
| 17:14:32 on 08-23 | `علاج طبيعي` | `ايه الاقسام المتاحة` |
| 14:44:26 on 08-24 | `بقولك يمعلم نكمل؟ انا عايز احجز لابني علاج طبيعي` | — |

**Three for three.** Every pre-model escalation this clinic has ever fired was a
patient naming a department, on a turn that was unambiguously a booking. The
false-positive rate of the `medical` class in production is 100%.

---

## 1. Exact production root cause

**`MEDICAL_PATTERNS` in `lib/ai/patient-escalation.ts` contained the bare noun
`علاج`, and `علاج` is half of what this clinic calls a department.**

```ts
const MEDICAL_PATTERNS: readonly RegExp[] = [
  …
  /(تشخيص|شخص\s*حالتي|وصفة|جرعة|دواء|أعراض|اعراض|علاج|هل\s*(هذا|هي)\s*خطير)/,
  …
];
```

`علاج` is "treatment". `علاج طبيعي` is physiotherapy — the name of an active
`departments` row of clinic `caf2711f`. There is no word boundary and no
context requirement, so the pattern matches the department name, the definite
form `العلاج`, and every sentence either appears in.

`detectPatientEscalation` runs in `runPatientInboundAiReply` **before the agent
exists**. It is not a guardrail around the model; it is a branch that returns
instead of calling it. So the turn produced the canned handoff copy, stamped
`ai_escalated_at`, latched `ai_booking_stage.escalated`, and stopped.

### Why this is also the origin of P11B

`stageEnteredAt: 2026-08-23T17:14:34.957Z` in the stage record is the exact
millisecond of the second row in the table above. The `escalated` latch that
P11B traced the phantom doctors to was set by **this same defect**, on the
message `علاج طبيعي`. P11B fixed what the stuck latch did — an empty tool mount,
a model with no roster, two invented Turkish names. P11C fixes what set it.

That is why P11B's four detectors and closed-world roster check were all
correct and the conversation still broke again the next day: they were
downstream of a decision made before any of them ran.

### A second defect, found while verifying the first

`HUMAN_REQUEST_PATTERNS` had the same shape of error:

```ts
/(أريد|ابغى|أبغى|بدي|عايز|عاوز|ممكن)\s*.{0,20}(موظف|شخص|إنسان|انسان|بشري|أحد|احد|حد)/
```

`عايز احجز لشخص تاني` — *"I want to book for another person"* — matches, through
the bare noun `شخص`. `لشخص تاني` is one of the exact continuation phrases the
brief lists as required third-party booking language. Not observed in production
only because nobody had typed it yet.

---

## 2. Exact runtime trace of this turn

```
inbound "بقولك يمعلم نكمل؟ انا عايز احجز لابني علاج طبيعي"   14:44:26.948
  → webhook → runPatientInboundAiReply
      getEntitlements                                → pro_ai, ai.patient_auto
      getClinicAiReplyContext                        → ai_reply_mode = auto
      conversations.ai_escalated_at                  → NULL  → does NOT skip
      conversations.ai_paused_at                     → NULL  → no takeover
      resolveReplyLocale                             → ar
  → detectPatientEscalation(message)
      EMERGENCY_PATTERNS        no match
      HUMAN_REQUEST_PATTERNS    no match
      MEDICAL_PATTERNS[2]       *** MATCH on `علاج` ***
      → { escalate: true, reason: "medical", emergency: false }
  ***  RETURNS HERE. THE AGENT IS NEVER CONSTRUCTED.  ***
  → patientEscalationCopy("handoff", ar)
        "سأطلب من أحد موظفي Health Care Pro متابعة سؤالك قريباً..."
  → sendPatientText(...)                             14:44:28
  → escalateConversation  → ai_escalated_at = 14:44:28.632, reason = medical
  → recordSuggestion(status "sent", escalate true)
  → logAgentTool patient_escalation                  14:44:29.311
  → markBookingStageEscalated
      recordStageTurn({escalated:true, tool:"patient_escalation"})
      trace: escalated → escalated, turn 27          14:44:29.622
  → return { status: "escalated", reason: "medical" }
```

Everything after `detectPatientEscalation` in `runPatientInboundAiReply` —
`openBookingStageTurn`, `runCertifiedPatientAgent`, `createPatientAgent`,
`buildPatientTools`, `allowedToolsForStage`, the grounding enforcement — is on
the other side of that return and did not execute.

**The negative evidence confirms it.** Every ordinary turn on this conversation
writes *two* `patient_booking_stage` rows or one plus a `patient_reply_auto`
row. This turn has exactly one stage row and its `tool_called` is
`patient_escalation`, not `none`. The turn-opening trace that
`openBookingStageTurn` emits on every agent turn — visible on turns 9 through 27
in the same table — is **absent**. There is no `agent_tool:patient_reply_auto`
row either. The agent did not run.

---

## 3. Why it escalated — the ten questions, answered

| # | Question | Answer |
|---|---|---|
| 1 | Why did this message escalate? | `MEDICAL_PATTERNS` matched the bare noun `علاج`, which is the clinic's department name. |
| 2 | Which code path generated it? | `lib/ai/patient-reply.ts:620` → `detectPatientEscalation` → the `detection.escalate` branch, pre-model. |
| 3 | Model or server? | **Server.** Deterministic keyword match, no LLM in the loop. `audit_logs` `new_data` has `{"mode":"auto","sent":true,"reason":"medical"}` — the shape written by `runPatientInboundAiReply`, not by a tool call. |
| 4 | Booking stage before? | `escalated`, `turnCount` 26 → 27, `stageEnteredAt` 2026-08-23T17:14:34.957Z, `bookingForOther` already `true`, `collected` = `{appointment_date:"2026-08-23"}`. |
| 5 | Did the P11B self-heal occur? | **No — and it was unreachable.** The self-heal lives in `openBookingStageTurn`, which the escalation branch returns before. P11B's fix is correct and its own integration tests still pass; it has simply never had a turn to run on, because every turn since it shipped was pre-empted. |
| 6 | Was `for_someone_else` detected? | **No.** It is a model-supplied tool argument (P9C), and no model ran. The conversation already carried `bookingForOther: true` from an earlier session, so the state was right and nothing consumed it. |
| 7 | Did `علاج طبيعي` resolve to the live department? | **It was never asked.** `prepare_booking` was not called. Verified afterwards that it *does* resolve: `resolveNamedEntity` maps both `علاج طبيعي` and `Physical Therapy` onto concept `physicaltherapy`, and the live row `794c4460…` has exactly one eligible doctor. |
| 8 | Which tools were mounted? | **None.** `buildPatientTools` was never called. |
| 9 | Why did `prepare_booking` / `list_doctors` not execute? | They were never mounted, on a turn where no model existed to call them. |
| 10 | Did P10/P11/P11B break P9C? | **No.** P9C's third-party path is intact and is proven end-to-end against real Postgres in §10. What P10 stage-scoping did was make the *consequence* of a false escalation permanent rather than transient — see §4. |

---

## 4. Why a false escalation is not a recoverable error

The module comment on `patient-escalation.ts` used to say: *"getting it wrong is
safe in one direction … a missed keyword still runs the ordinary agent, which
refuses and can be escalated on low confidence."* That was true of a missed
keyword and false of a spurious one, and the asymmetry runs the other way from
what the comment assumed:

* **A missed pre-model escalation still meets the agent.** The patient prompt
  refuses clinical advice, `patient_escalation` is available to the model, and
  the `low_confidence` path escalates. Several independent recoveries.
* **A spurious pre-model escalation ends the conversation.**
  `runPatientInboundAiReply` returns `already_escalated` for every subsequent
  message until a staff member presses "return to AI" in the inbox. And since
  P10 made the mount stage-scoped, the `escalated` stage's workflow tool list is
  `[]`, so even after staff hand it back the thread had nothing to book with —
  which is the P11B failure. One mistake, no automatic recovery, and it
  compounds.

Pre-model detection is **fail-fast with an irreversible consequence**. The model
layer is **fail-safe**. So the classifier must fire only on signals that are
unambiguous *without* knowing anything about the clinic. That sentence is the
design rule the fix implements.

---

## 5. What changed

Four production files. No migration, no schema change, no prompt change, no
model change, no new dependency.

### 5.1 `lib/ai/patient-escalation.ts` — the medical class, in three parts

`MEDICAL_PATTERNS` is gone. In its place:

* **`CLINICAL_JUDGMENT_PATTERNS`** — requests for a *decision about the
  patient's body*. `diagnose me`, `should I take/stop/use`, `what's wrong with
  me`, `is it serious`, `شخص حالتي`, `هل آخذ`, `هل أتوقف`, `ايش فيني`,
  `هل ده خطير`. These fire on the raw text, in any context, and are suppressed
  by nothing.
* **`CLINICAL_TOPIC_PATTERNS`** — *nouns*. `treatment`, `medication`, `symptom`,
  `dose`, `prescription`, `علاج`, `دواء`, `أعراض`, `جرعة`, `وصفة`. A topic alone
  is never an escalation.
* **`ADVICE_FRAME_PATTERNS`** — the patient is asking for something to be
  decided, or reporting their own condition. Interrogatives and deontics
  (`what/which/why/how/should`, `ايه/ايش/هل/ليه/ازاي`), first-person condition
  reports (`I have/I feel`, `عندي/بعاني/حاسس/تعبان`). **There is not one
  clinical word, department, specialty or service name in this list.**
* **`LOGISTICS_FRAME_PATTERNS`** — the message is about arranging or pricing a
  visit. `book/appointment/schedule/price/how much/opening hours`,
  `احجز/حجز/موعد/سعر/بكام/متاح/نكمل`.

The rule:

```
medical  ⟺  CLINICAL_JUDGMENT
        ∨  (CLINICAL_TOPIC ∧ ADVICE_FRAME ∧ ¬LOGISTICS_FRAME)
```

A logistics frame can never demote a judgment request — `"عايز احجز موعد، وكمان
هل أتوقف عن الدواء؟"` still escalates, and there is a test for it.

`HUMAN_REQUEST_PATTERNS` got the same treatment: the unambiguous shapes (a verb
of contact aimed at a person, a noun that can only mean staff, a person as the
*subject* of a contact verb — `حد يرد عليا`) stay unconditional; the one
ambiguous shape, `عايز … شخص`, moved to `HUMAN_REQUEST_WEAK_PATTERNS` and defers
to the logistics frame.

Emergency and complaint patterns are **byte-for-byte unchanged.**

### 5.2 `lib/ai/entity-resolution.ts` — clinic vocabulary

Three new pure functions, built on the existing `entityWords` / `stripArticle` /
`conceptKeys` machinery that department resolution already uses:

* `buildClinicVocabulary(names)` — the lookup keys a set of names occupies:
  every normalized literal word, plus every concept the lexicon maps them onto.
* `isClinicVocabularyWord(word, vocabulary)`
* `maskClinicVocabulary(text, vocabulary)` — blanks those words out with spaces,
  character for character, so offsets and lengths are preserved.

### 5.3 `lib/ai/doctor-directory.ts` — one small live read

`loadClinicDepartmentNames(clinicId)` — the same `departments` predicate
`loadDoctorDirectory` uses (`is_active`, `deleted_at is null`), one round trip,
names only. Returns `[]` on any failure, which can only make the classifier
*more* eager, never less.

### 5.4 `lib/ai/patient-reply.ts` — the wiring

```ts
const clinicDepartmentNames = await loadClinicDepartmentNames(input.clinicId);
const detection = detectPatientEscalation(message, { clinicDepartmentNames });
```

Placed after the `disabled` / `conversation_unavailable` / `already_escalated` /
`empty_message` early returns, so no skipped turn pays for the query.

---

## 6. The structural invariant

Not "we removed a bad keyword". Three statements, each of which independently
rejects the production message:

> **I. A clinical noun is a topic. Escalation is about the ask.**
> Naming a subject is what a patient does when choosing a department, asking a
> price, or booking. Only a request for a *judgment* is a medical escalation on
> its own. This is a property of the pattern tables, checked by a test that
> asserts the retired regex still matches the message — so the fix cannot be
> mistaken for a coincidence.

> **II. A word this clinic uses to name one of its own departments is not
> evidence of anything.** The classifier reads the live `departments` rows and
> subtracts them before the topic test. It never adds a signal, only withholds
> one, and only for the topic-derived tier.

> **III. The safety classes are read from the raw text, before any masking
> exists.** Emergency and human-request are matched and returned *above* the
> line where the vocabulary is even constructed. A clinic that names a
> department "Emergency", "طوارئ" or "Customer Service" cannot blind them. This
> is enforced by ordering in the function body, not by a convention, and there
> is a test with a deliberately hostile department list.

Why this prevents the regression rather than patching it: the failure mode was
*a clinic's own configuration being read as a clinical intent*. (II) makes that
impossible by construction — the clinic's vocabulary is subtracted, not
consulted. (I) makes it impossible even for a clinic with no departments
configured, because the sentence has no advice frame and does have a logistics
frame. (III) makes sure (II) can never be turned against the one class where a
false negative is dangerous. Any single one of the three fixes the reported
turn; all three have to be removed for it to come back.

---

## 7. How third-party booking works for arbitrary departments

The engine is unchanged. It was always department-agnostic; it was simply never
reached. What P11C changes is that it now is.

```
patient names a department in their own words, any script, any name
  → detectPatientEscalation  → not an escalation          (P11C)
  → openBookingStageTurn     → releases a stale escalated latch  (P11B)
  → stage = selecting_department, mount = prepare_booking + list_doctors
  → prepare_booking(department: "<the patient's words>")
      loadDoctorDirectory     → live `departments`, `profiles`, leave
      resolveNamedEntity      → literal + concept + phonetic, over live rows
      availableDoctorsInDepartment(directory, id)
          department_id equality, role='doctor', active, not deleted,
          not on leave in force now                        ← the only list
      assertRosterAuthority   → throws if an offered doctor is outside it
  → patient picks a doctor  → list_available_days → check_availability
  → third party has no file → stage = intake_collecting, register_patient
  → create_preliminary_booking(for_someone_else: true)
      → provisional path, filed against the staged intake
```

Nothing on that path branches on a department name. `assertRosterAuthority`
*throws* rather than filtering, so a dropped `.eq("department_id", …)` fails a
test instead of returning a longer list.

**Proved, not asserted.** The mocked suite runs the whole path over 3, 20 and
100 generated departments (`Unit 0` … `Unit 99` — names in no lexicon), and
asserts for each that naming it is a booking and that its roster is exactly its
own members. The integration suite creates a department **mid-suite**, after the
clinic is running, and books against it with no code change. Every department
name in both suites is generated per run except the Arabic phrase from the
incident itself, which appears as a *department name in the fixture* precisely
so that what is being tested is "patient words → live row".

---

## 8. State and identity isolation

Asserted by reading rows after a real booking, not by trusting return values.
The fixture: sender is a registered, identity-verified patient; the third party
is their child; **no field of one equals a field of the other**.

| Claim | How it is proved |
|---|---|
| The child's file carries the child's details | `ai_patient_intakes` row: `full_name`, `national_id`, `email` all equal the child's, and each is asserted `not.toBe` the sender's |
| The sender's DOB is not reused | `date_of_birth` asserted `not.toBe(SENDER.dob)` |
| The sender appears only as the requester | `requested_by_patient_id === senderPatientId`, and in no field describing the subject |
| Nothing becomes a patient | `review_status = 'pending_review'`, `approved_patient_id = null`, and `patients` for the clinic contains exactly one row — the sender |
| The sender's record is untouched | re-read after the booking, all four columns byte-identical |
| The appointment is not the sender's | `appointments where patient_id = sender` is `[]`; the booking is one `ai_appointment_requests` row on the provisional path |
| Booking before staging is refused | `create_preliminary_booking(for_someone_else)` with no staged intake returns `{created:false, reason:"intake_required"}` and writes nothing |
| Sender verification is not the child's | the child is staged for review regardless; identity verification gates the *sender's* access to their own file and confers nothing on the third party |

The mechanism behind the last row is unchanged from P9C: in
`createPatientPendingBooking`, a pending third-party intake forces the
provisional branch even for a linked, verified sender, so the "book it under
whoever holds the phone" path is unreachable.

---

## 9. Files changed

**Production (4):**

| File | Change |
|---|---|
| `lib/ai/patient-escalation.ts` | Medical class split into judgment / topic / advice-frame / logistics-frame; weak human-request shape separated; `PatientEscalationContext` added; masking applied to the topic tier only, below the safety classes |
| `lib/ai/entity-resolution.ts` | `buildClinicVocabulary`, `isClinicVocabularyWord`, `maskClinicVocabulary` (append-only; nothing existing touched, no lexicon entry added or removed) |
| `lib/ai/doctor-directory.ts` | `loadClinicDepartmentNames` |
| `lib/ai/patient-reply.ts` | Loads the live department names and passes them to the classifier |

**Tests (3):**

| File | Change |
|---|---|
| `tests/unit/ai/p11c-third-party-booking-continuation.test.ts` | **New.** 63 tests, 8 sections |
| `tests/unit/integration/p11c-third-party-booking-continuation.test.ts` | **New.** 10 tests against real Postgres |
| `tests/unit/ai/p5b-patient-reply.test.ts` | Orchestrator-level reproduction: 5 tests, plus a `departments` table in the harness |

**Doc (1):** this file.

Nothing in `lib/ai/prompts/`, `lib/ai/patient-tools.ts`, `lib/ai/booking-stage.ts`,
`lib/ai/booking-stage-store.ts`, `lib/ai/patient-grounding.ts` or any tool was
changed. No prompt wording was altered anywhere.

---

## 10. Migration status

**None.** No new migration, no altered migration, no schema change, no RPC
change, no `types/database.ts` regeneration. `supabase/migrations/` is untouched
by this work — `git status` shows only the pre-existing uncommitted files from
earlier phases on this branch.

The remote database was read and never written. The fixture writes in the
integration suite go to the local stack at `127.0.0.1:54321` and are torn down
in `afterAll`.

---

## 11. Test results

| Suite | Command | Result |
|---|---|---|
| P11C regression (mocked) | `vitest run tests/unit/ai/p11c-…` | **63 passed** |
| P11C regression (real Postgres) | `vitest run tests/unit/integration/p11c-…` | **10 passed** |
| Patient reply orchestrator | `vitest run tests/unit/ai/p5b-patient-reply.test.ts` | **20 passed** |
| Escalation detection (pre-existing) | `vitest run tests/unit/ai/p5b-patient-escalation.test.ts` | **9 passed**, unmodified |
| All AI unit tests | `vitest run tests/unit/ai` | **1654 passed, 2 skipped** (91 files) |
| Full unit suite | `npm run test` | **3856 passed, 2 skipped** (421 files) |
| Integration, real Postgres | `npm run test:integration` | **640 passed, 3 skipped** (64 files, 1 skipped) |
| Adversarial / injection | `npm run test:ai-adversarial` | **136 passed** |
| Staff eval gate | `npm run test:ai-staff-gate` | **76 passed** |
| Typecheck | `npx tsc --noEmit` | **clean** |
| ESLint | `npm run lint` | **0 errors** (28 pre-existing warnings, none in changed files) |
| Build | `npm run build` | **succeeded** |
| Whitespace | `git diff --check` | **clean** |

### What the regression test actually asserts

Not "the message does not escalate" alone. Eight sections:

1. **The reproduced turn** — the exact bytes, with the clinic's live department
   names; *and* with no vocabulary at all, so the two protections are shown to
   be independent; *and* the bare `علاج طبيعي` that set the latch on 08-23; *and*
   that the retired regex still matches both, so the fix is not accidental.
2. **Continuation language** — `لابني`, `لبنتي`, `لابويا`, `لوالدتي`, `لاخويا`,
   `لمراتي`, `لجوزي`, `لصاحبي`, `لشخص تاني`, each bare and each with the
   department, plus nine real messages from the production transcript.
3. **Nothing weakened** — 4 emergencies, 5 human requests, 10 clinical-judgment
   requests, complaints, and a judgment request inside a booking message.
4. **Hostile clinic vocabulary** — departments named `Emergency`, `طوارئ`,
   `إسعاف`, `Chest Pain Unit`, `Customer Service`, `Human`; emergency and
   human-request still fire. Masking is proved to be length-preserving and
   subtraction-only, character by character.
5. **Department is data** — the live row is resolved from the patient's Arabic;
   only eligible doctors are offered (the department's receptionist and its
   on-leave doctor are both excluded); an invented doctor throws; a department
   created after boot works; and the whole thing holds over 3, 20 and 100
   generated departments.
6. **The booking continues** — the stage walk `selecting_department →
   selecting_doctor → intake_collecting → selecting_day → selecting_time →
   confirming`, asserting at each step that the tool that step needs is in
   `allowedToolsForStage`, with `bookingForOther: true` throughout.
7. **The escalated latch** — all fifteen in-turn events still leave it latched;
   only `de_escalated` releases it.
8. **The fix names nothing** — the classifier source contains no specialty, no
   department, no doctor; no regex in it contains `طبيعي`; and no file under
   `lib`, `actions`, `app` or `components` names any person from this
   reproduction.

The integration suite adds what only real rows can settle: that
`loadClinicDepartmentNames` really filters `is_active` and `deleted_at` (a
deactivated and a soft-deleted department are planted and must not appear), and
the full third-party booking with the row-level isolation assertions of §8.

### On the previously reproduced conversation

`763b1c6b` cannot be re-run here — it is remote, this work is read-only, and its
`ai_escalated_at` is currently stamped, so the assistant will not answer it
until staff press "return to AI". What was verified instead, against the exact
stored bytes: **all three** messages that ever produced a `medical` escalation in
that clinic classify as `{escalate: false}` under this fix, using the clinic's
real department names read from the hosted project.

---

## 12. Remaining limitations, stated plainly

1. **A clinical question that shares a word with a department name is no longer
   caught pre-model, at that clinic.** `"ايه العلاج المناسب؟"` escalates at a
   clinic with no physiotherapy department and does not at one that has it. This
   is the deliberate trade of §4 and it has its own test, asserted in both
   directions, with the reasoning written next to it. The agent answers instead;
   its prompt refuses clinical advice and can still escalate. I take a
   recoverable miss over an unrecoverable false positive, and the production
   record — 3 false positives, 0 observed misses — says which one is actually
   happening.

2. **`bookingForOther` is a latch with no release.** Once true it stays true for
   the life of the conversation, so a sender who books for their child will be
   sent to `intake_collecting` on their *next* booking too, and asked for the
   subject's details. Conversation `763b1c6b` carries it right now. This is
   fail-safe (it over-asks, it never mis-files) and it is out of P11C's scope,
   but it is real and it will look like a bug to a patient. Fixing it needs a
   decision about when a booking is "over", which is a design question, not a
   patch.

3. **A linked sender who has not verified their date of birth reaches
   `identifying`, whose workflow mount is empty.** Third-party booking therefore
   begins with the sender proving who they are. That is the intended P10
   security property, not a regression, but it is a step the brief's expected
   flow does not mention.

4. **The advice-frame patterns are still keyword lists.** They contain no
   clinical or clinic-specific vocabulary — that is what makes them
   department-agnostic — but they are Arabic and English only, and a dialect
   interrogative outside them will not trigger the topic tier. The failure
   direction is a miss, which the model layer recovers.

5. **`detectPatientEscalation` now performs one database read per inbound
   message** (`departments`, names only, after the early returns). Small, but it
   is a new dependency of a path that was previously pure, and a failure
   degrades to `[]` rather than to an error.

---

## 13. Verdict

**SAFE TO PUSH.**

Nothing pushed, nothing deployed, nothing written to the remote database, as
instructed. No migration, so there is no deployment ordering to get right and no
rollback beyond reverting the commit. `AI_PATIENT_STAGE_ORCHESTRATION` is
untouched and remains `on` by default.

I am not claiming this from the tests. The tests say the code does what I
intended; the reason to believe the regression is closed is §6 — the clinic's
own configuration is now subtracted from the classifier's input rather than
consulted by it, and the sentence is rejected independently by the topic/ask
split even when that subtraction is switched off entirely. The specific worry
that remains is limitation 1, which is a deliberate, tested, documented trade
and not an oversight.

The one thing this fix cannot do is un-escalate conversation `763b1c6b`. A staff
member has to press "return to AI" in the inbox; P11B's self-heal will then
release the stage latch on the next inbound message, and — with P11C in place —
that message will finally reach the agent.
