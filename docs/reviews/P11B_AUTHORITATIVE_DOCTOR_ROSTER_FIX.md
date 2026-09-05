# P11B — Authoritative doctor roster: the phantom-doctor root cause and fix

Branch: `feat/p7-manual-qa-polish` · Local only. Nothing pushed, nothing
deployed, **no write of any kind to the remote database** — the hosted project
was read over the REST API and nothing else.

---

## 0. The evidence this is built on

Not reconstructed from the code. The reproduced turn was recovered from the
hosted project (`ayzetxywrqouqpurbjuv`) that `.env.local` points `next dev` at.

The message the patient received, `ai_suggested_replies`
`0f798e81-3acd-4a2d-a6da-bc83f3416979`, `mode=auto`, `status=sent`,
`2026-08-23T22:46:09.635Z`:

```
تمام! 👍

**الدكاترة المتاحين في قسم العلاج الطبيعي:**

1. **Dr. Mehmet Yilmaz**
2. **Dr. Ayşe Demir**

**عايز يحجز مع مين منهم؟** وبعدين نشوف المواعيد المتاحة.
```

The patient's message on that turn, `inbound_messages`, 22:46:06:

```
فصيلة الدم ab+ | ومش عايز الموعد يوم ٢٣ عايز اعرف مين الدكاترة المتاحين الاول
```

The stage trace for the same turn, `audit_logs`, 22:46:07.001:

```json
{"turn": 25, "changed": false, "stage_after": "escalated", "tool_called": "none",
 "stage_before": "escalated", "tool_outcome": "none", "legal_transition": true,
 "missing_required_fields": 0, "illegal_transitions_total": 0}
```

And the conversation row, `763b1c6b-c388-4f36-b8ca-965f71f20f86`:

```json
{"ai_escalated_at": null, "ai_paused_at": null,
 "ai_collected_data": {"appointment_date": "2026-08-23"},
 "ai_booking_stage": {"stage": "escalated", "escalated": true, "turnCount": 27,
   "stageEnteredAt": "2026-08-23T17:14:34.957Z", "offeredDoctorIds": [],
   "lastToolOutcome": {"tool": "patient_escalation", "outcome": "escalated"}}}
```

Those four rows are the whole answer. Turns 22, 23, 24 and 25 all read
`tool_called: "none"`, `stage: escalated`, and every one of them was
auto-replied.

---

## 1. Exact root cause

**`escalated` was an absorbing state of the booking-stage machine, and staff
could clear the conversation-level escalation without clearing it.**

Three facts, none of which is a defect on its own:

1. `LEGAL_EDGES.escalated` was `["escalated"]` — one self-edge, no way out.
   `nextStage` returned `"escalated"` for every event once the latch was set.
2. `STAGE_WORKFLOW_TOOLS.escalated` is `[]`. Correct, given (1): a conversation
   that has genuinely gone to a human should have no booking tools.
3. `clearConversationEscalation` (`actions/messaging.ts`, the inbox's "return to
   AI" button) set `conversations.ai_escalated_at = null` **and nothing else.**

Together they are the defect. Staff handed the thread back; `ai_escalated_at`
became null so `runPatientInboundAiReply` stopped returning `already_escalated`
and the assistant resumed replying — while `ai_booking_stage.escalated` stayed
`true` forever, because nothing in the machine could clear it and no other code
path tried.

`AI_PATIENT_STAGE_ORCHESTRATION` is `on` (see §5), so the mount **is** scoped to
the stage. From 17:14:34 on 2026-08-23 onward, that conversation ran every turn
with `allowedToolsForStage("escalated", …)` — the stage-independent tools only.
`prepare_booking` and `list_doctors` were not mounted. At 22:46 a patient asked
who the available doctors were, and the model had no way to find out.

So it made two up.

A second, independent defect let the invention through the last gate: **the
grounding check could not see an English `Dr.`**. `DOCTOR_TITLE` was
`/\bdrs?\.?\b/` — there is no word boundary between `.` and a space, so the
pattern backtracked to the bare `Dr` and left the `.` as the first character of
the "rest". The span reader split on sentence punctuation, hit that `.`
immediately, and produced an empty span. Measured against the live code before
the fix:

| reply | `titledMentions` | `grounded` |
|---|---|---|
| `- Dr. Mehmet Yilmaz` | `[]` | **true** |
| `1. Dr Mehmet Yilmaz` | `["Mehmet Yilmaz"]` | false |

The single most common shape for an English doctor's name was invisible to the
detector whose entire job was catching invented doctors' names. Markdown
compounded it: `**Dr. Mehmet Yilmaz**` was tokenized with the asterisks
attached.

---

## 2. Exact runtime path of the reproduced turn

```
inbound "…عايز اعرف مين الدكاترة المتاحين الاول"  22:46:06
  → runPatientInboundAiReply
      reads conversations: ai_paused_at null, ai_escalated_at NULL  → does NOT skip
  → mode = auto → runCertifiedPatientAgent
  → openBookingStageTurn
      recordStageTurn({countTurn:true})
      persisted stage read as escalated:true  → derived stage = "escalated"
      audit_logs 22:46:07.001  {stage_before: escalated, stage_after: escalated,
                                tool_called: "none", turn: 25}
      stageScopedMountEnabled() === true  → returns stage "escalated"
  → createPatientAgent(bookingStage: "escalated")
      buildPatientTools → 14 tools
      allowedToolsForStage("escalated", …) → STAGE_INDEPENDENT_TOOLS only
      ***  prepare_booking and list_doctors NOT MOUNTED  ***
  → agent.generate()
      model calls NO tool                                (tool_called: "none")
      writes "1. **Dr. Mehmet Yilmaz** 2. **Dr. Ayşe Demir**"
  → grounding ledger: EMPTY — no tool ran, so nothing was recorded
  → enforcePatientReplyGrounding
      loadDoctorDirectory(clinic)  ← succeeded; real staff loaded
      detector 1 (real staff not offered): no real staff name in the text  → no hit
      detector 2 (titled mention):  "Dr." + period → empty span → NO MENTIONS
      → grounded = true, NO patient_reply_grounding audit row written
  → recordSuggestion(status "sent") 22:46:09.635
  → sendMessage → WhatsApp                                22:46:09.781
```

The absence of an `agent_tool:patient_reply_grounding` row in `audit_logs` for
that turn is the positive confirmation: the enforcement ran and returned
`grounded`. It logs only on violation.

---

## 3. Where "Dr. Mehmet Yilmaz" / "Dr. Ayşe Demir" originated

**The model's pre-training. Nowhere else.**

* They are in no table of that clinic. `profiles` has no such rows.
* They are in no table of any clinic — no `full_name` in the hosted project
  matches either.
* They are nowhere in this repository: no prompt, no fixture, no seed, no
  lexicon. `grep -rF` over `lib actions app components` is empty for `Mehmet`,
  `Yilmaz`, `Ayşe`, `Ayse` and `Demir`, and there is now a test that asserts it
  (`no production code names any of the people in this reproduction`).
* No tool ran on the turn, so nothing was returned that could have carried them.

They are two ordinary Turkish names, produced by a language model asked to list
doctors with no doctors in front of it. That is the expected behaviour of a
model in that position, and it is why the fix is structural rather than a
prompt rule.

The Arabic department heading in the same message — "قسم العلاج الطبيعي" — came
from sixteen messages of history: the patient had typed "علاج طبيعي" at 17:14
the previous session. The department was recalled from the transcript, and the
roster was invented to go with it, because the transcript had a department in it
and no roster.

---

## 4. Why P11 grounding failed

P11 §5 built the right shape and P11 §11 named the gap honestly. Both detectors
missed this reply, for different reasons:

* **Detector 1 (exact, every real staff name in the clinic)** is the strong one
  and it worked exactly as designed — it just has nothing to say about people
  who do not exist. Its scope is "a real person the server did not offer",
  which was the *previously* reported failure ("Dr. Fatima Khalil"), and it is
  structurally unable to catch invention.
* **Detector 2 (titled mentions)** was the one meant to catch invention, and it
  was broken by the regex described in §1. It was not conservative here — it
  was blind. `Dr.` produced no mention at all.

There was also no third thing to fall back on, because the check was framed as
*"does this reply name somebody wrong?"* — a search for bad names. On a turn
where the server returned no roster at all, the correct question is not whether
a name is wrong. It is whether the reply is entitled to name anyone. It was not,
and nothing asked.

---

## 5. Was stage orchestration actually on?

**Yes — `on`, by default, unoverridden.** Verified at runtime rather than
assumed:

```
raw=undefined  mode=on  scopedMount=true
```

`AI_PATIENT_STAGE_ORCHESTRATION` is set in **no** environment file
(`.env.local`, `.env.example`, `.env.development.local.bak`,
`.env.development.local.off`), in no CI workflow, and in no `vercel.json`, so
`stageOrchestrationMode()` falls to its `on` default and
`stageScopedMountEnabled()` returns true.

**No environment value overrides it.** And this matters in the opposite
direction from what one might hope: orchestration being `on` is what made the
`escalated` stage narrow the mount to nothing. In `shadow` the flat mount would
have kept `list_doctors` available and this particular reply would probably not
have happened — which is not an argument for `shadow`, because the stage table
is right and the missing edge was the bug.

For the record, the runtime that served the turn was `next dev` reading
`.env.local`, whose `NEXT_PUBLIC_SUPABASE_URL` is the hosted project. The local
override file is present but renamed to `.env.development.local.off`, so it is
not loaded. That is why a manual test hit remote data.

---

## 6. How the new invariant makes phantom doctors impossible

Four layers, of which the first three are structural and only the last is a
detector.

### 6.1 The mount can no longer be silently empty

`LEGAL_EDGES.escalated` now has an edge to every stage, reachable only by the
new `de_escalated` event, and `nextStage("escalated", {type:"de_escalated"})`
returns `"idle"` so the stage is rebuilt from the collected facts.

Nothing inside a turn can produce that event. It comes from exactly two places,
both of which have read the conversation's own `ai_escalated_at`:

* `clearConversationEscalation` — the staff action — now also calls
  `clearBookingStageEscalation`, so the latch drops at the moment of handing
  back;
* `runCertifiedPatientAgent` passes `conversationEscalated: false` to
  `openBookingStageTurn`, which is sound because reaching that function at all
  proves `ai_escalated_at` is null. This is the self-heal: every conversation
  already carrying a stale latch — including the reproduced one — repairs itself
  on its next inbound message with no migration and no backfill.

The unit test that previously asserted "escapable from nowhere" now asserts the
two halves separately: no patient message and no model tool call lifts an
escalation (unchanged, still enforced over every in-turn event), and staff can.

### 6.2 The turn knows whether it is making a membership claim

`lib/ai/roster-intent.ts` (new) decides, server-side, whether doctor membership
is the subject of this turn, from three ORed signals:

* a roster tool returned a doctor this turn (`ledger.sawDoctors()`);
* the patient's own message is a roster question — reusing
  `isOtherDoctorsRequest` for the follow-up shape and adding the opening shape,
  with Unicode boundaries rather than `\b` so the Arabic patterns actually
  match;
* the draft reply itself uses a doctor title.

It names no department, no specialty, no doctor and no clinic. It reads
question and reply *shape*.

### 6.3 On such a turn, membership is a closed world

`checkDoctorGrounding` gains a third rule, active only when the turn is
roster-bearing:

* **with no server-returned roster**, every name-shaped span in the reply is a
  violation. The check does not have to decide whether a name is wrong. There is
  no true way to name anybody, so naming anybody is the violation. This alone
  rejects the reproduced message.
* **with a server-returned roster**, every name-shaped span must be *in it* —
  titled mentions, enumerated list items, and capitalized multi-word runs
  mid-sentence.

That is the answer to P11 §11. An invented name no longer has to be recognised
*as* invented; it has to be recognised as **offered**, and it cannot be. The
`INVENTED = "Zephyrine Quillbottom"` cases in both suites are exactly this: a
name in no table anywhere, rejected in three different sentence positions.

### 6.4 The repair is the roster, not a second guess

When a roster-bearing turn has no authoritative roster, the model is **not asked
again**. The repair pass is deliberately tool-free — a truthfulness check must
never be able to write to the database — so it has no way to obtain the list it
is missing, and asking it to "name only the permitted doctors" when the
permitted set is empty invites a second invention. `enforcePatientReplyGrounding`
goes straight to `buildDeterministicRosterReply`, composed from
`availableDoctorsInDepartment` over the directory it has already loaded. It is
true by construction.

The department for that reply is the one the conversation settled, or — new in
P11B — the one the patient just named, resolved against live `departments`
rows. Resolution chooses *which* department; it never chooses who is in it.

### 6.5 The detectors themselves are no longer fooled by formatting

* The title patterns consume their own abbreviating punctuation and separator,
  so `match[0].length` always lands on the first character of the name. `Dr.`,
  `Dr`, `د.`, `الدكتورة`, `الدكاترة` and `Prof.` all read correctly now.
* Markdown emphasis, list markers and bidi/zero-width controls are stripped
  before anything is read.
* Capitalized runs use `[ \t]` rather than `\s`, so a run cannot span the
  newline between two list items and turn two names into one span that matches
  neither.
* A titled span that opens with prose is re-read after a copula, which closes
  the exact shape P11 §11 documented as uncatchable: "الدكتور المتاح كمان **هو**
  نادية شوقي" and "The doctor available in Gamma Unit **is** Rana Wasfy" both
  now yield the name.
* Departments and services the server returned are exempt from the closed-world
  sweep, so "available in Gamma Unit is <a real doctor>" is not rejected for
  naming the department.

### 6.6 What is still not deterministic, stated plainly

The model still writes the sentence. What P11B removes is its ability to decide
*who is in it*: on a roster-bearing turn the doctor set either equals the
server's or the reply is replaced wholesale by a server-composed one. Prose
around the list stays conversational, which is the point.

One residual: a bare invented Arabic name, mid-sentence, with no title, no list
marker and no copula, on a turn where a *correct* roster was also returned. The
capitalized-run sweep is Latin-script only, because Arabic has no case to key
on. Detector 1 still catches every real staff name in that position, and the
unbacked case — which is the one that actually occurred — is caught regardless
of shape. Closing the last sliver would require an Arabic name-shape heuristic
aggressive enough to misfire on ordinary prose, and on a *backed* turn a
misfire replaces a correct answer with a canned one. I did not take that trade.
It is narrower than the P11 §11 gap by the whole unbacked class and by every
titled, listed and copula shape.

---

## 7. How arbitrary and new departments are supported with zero code changes

The engine reads the clinic's own rows on every turn and branches on no name.

* `loadDoctorDirectory` reads `departments` and `profiles` live, clinic-scoped
  through `createClinicScopedAdminClient`.
* `availableDoctorsInDepartment(directory, departmentId)` is the only list any
  caller may present: `department_id` equality, `role = 'doctor'`, active, not
  soft-deleted, not on leave in force now.
* `assertRosterAuthority` throws — not filters — if an offered doctor is outside
  it, so a dropped predicate fails a test instead of returning a longer list.
* Nothing in the new code paths mentions a department. `roster-intent.ts`
  matches question shapes; `patient-grounding.ts` matches name shapes.

Proved rather than asserted: the mocked suite runs the *whole* directory path
over 3, 20 and 100 generated departments (`Unit 7` / `وحدة 7` — names in no
lexicon), asserting for each that its roster is exactly the doctors carrying its
id and that no department's doctor appears in another. The integration suite
creates a department **mid-suite**, after the clinic is already running, adds a
doctor to it, and books against it with no code change.

**On the concept lexicon.** `lib/ai/entity-resolution.ts` holds a cross-language
concept table that predates this phase and includes physiotherapy synonyms. I
added nothing to it and removed nothing from it. It is not
"department-specific code" in the sense that matters here, and P11B proves why
with two tests: it contains no person's name, so it can never contribute a
doctor; and renaming a department to a word no lexicon has ever seen
(`Qorvex Wing`) returns a byte-identical roster, because membership is the
`department_id` column and nothing else. Fuzzy matching can pick the wrong
*department* — visibly, correctably — and can never change a single member of
one.

---

## 8. Appointment-lookup behaviour

`lookup_appointment` is stage-independent and asks for a full name and a
national id, and nothing else. P11B changes one thing: **the two halves may
arrive on different turns.**

* Both schema fields are now optional. The **server** decides whether it has
  enough, by merging the call with what it is holding for this conversation.
* Whichever half arrives first is held in
  `ai_booking_stage.appointmentLookup` — a closed-shape, length-capped slot,
  service-role-write-only, read by this tool and nothing else.
* It is deliberately **not** in `ai_collected_data`. That object is the booking
  and registration state: a name written there is a name `register_patient`
  opens a file with and `prepare_booking` reads as the person being booked. A
  value supplied to *identify an existing record* must not be able to become one
  used to *create* one. `set_conversation_ai_state` merges `collected` and
  replaces `stage`; the lookup writes only the second, and a test asserts the
  payload carries no `collected` key at all.
* The held value is erased the moment the lookup resolves — success, `no_match`,
  `no_upcoming` or `locked` — asserted for each.
* A value supplied *this* turn always beats the held one, so correcting a digit
  is answered on the correction.
* `needs_identity` names only what is missing and instructs the model never to
  re-ask for what the server holds, never to ask for date of birth, phone,
  email or blood type, and never to start a registration. A test walks every
  sentence of that guidance and requires any mention of those fields to be a
  prohibition.
* The rate-limited RPC is not reached while a half is missing, so no attempt is
  spent — the anti-enumeration counter is untouched.

`unreadable` was folded into `needs_identity`. From the patient's side the two
are the same event, and collapsing them removes one more way to infer what the
server did or did not recognise. Everything that made the old branch safe is
unchanged and still asserted.

Unchanged and re-asserted: the RPC never reads `conversations.patient_id`; every
failure is the same `no_match`; nothing here writes `identity_verified_at`,
`patient_id` or `booking_identity_confirmed_at`; a linked, DOB-verified thread
supplying somebody else's details still gets that person's appointments or
nothing, and its own patient id is not in the query's scope at all.

---

## 9. Files changed

| file | change |
|---|---|
| `lib/ai/roster-intent.ts` | **new** — server-side, department-agnostic decision of when a turn makes a doctor-membership claim |
| `lib/ai/patient-grounding.ts` | title regex fixed (`Dr.`), markdown/bidi stripping, copula fallback, `personNameCandidates`, closed-world rules, department/service exemption |
| `lib/ai/patient-reply-grounding.ts` | roster-bearing enforcement, straight-to-deterministic on an unbacked roster, department resolved from the patient's own message, `rosterBearing` in the result and the audit |
| `lib/ai/patient-reply.ts` | threads `latestPatientText` into grounding; passes `conversationEscalated: false` |
| `lib/ai/booking-stage.ts` | `de_escalated` event, edges out of `escalated`, `appointmentLookup` slot (type, parse, serialize) |
| `lib/ai/booking-stage-store.ts` | `unescalated` and `appointmentLookup` patches, `conversationEscalated` turn option, `clearBookingStageEscalation` |
| `lib/ai/tools/lookup-appointment.ts` | optional halves, server-held partial identity, erase on resolve |
| `actions/messaging.ts` | `clearConversationEscalation` also clears the stage latch |
| `tests/unit/ai/p11b-authoritative-doctor-roster.test.ts` | **new**, 27 tests |
| `tests/unit/integration/p11b-authoritative-doctor-roster.test.ts` | **new**, 17 tests, real Postgres |
| `tests/unit/ai/p9-booking-stage.test.ts` | escalation invariant restated as its two halves |
| `tests/unit/ai/p11-appointment-lookup.test.ts` | 9 new cross-turn tests; `needs_identity` contract |

---

## 10. Migration status

**No migration was created and none is needed.**

`appointmentLookup` is an additive key inside the existing
`conversations.ai_booking_stage` jsonb column. That column already exists
(`20260823120000_ai_booking_stage_state.sql`), is written only by
`set_conversation_ai_state`, is checked as an object under 4 KB, and is cleared
by the existing `clear_conversation_identity_on_patient_change` trigger when the
thread is re-pointed at another patient — which is the right lifecycle for a
held identity. The shape is enforced in TypeScript by `parseBookingStageState`,
which rebuilds against a closed shape and drops anything it does not recognise,
so old rows read correctly and new rows are readable by old code.

The escalation fix needs no schema change either: it is a state-machine edge
plus a write through the existing RPC, and stale rows self-heal on their next
inbound turn.

The remote database was **read only** — four `GET` requests against the REST
API. Nothing was written, altered or deleted there.

---

## 11. Test results

| suite | result |
|---|---|
| `npx vitest run --exclude tests/unit/integration/**` (417 files) | **3712 passed, 2 skipped, 0 failed** |
| `vitest run tests/unit/integration` — real Postgres (64 files) | **630 passed, 3 skipped, 1 file skipped, 0 failed** |
| `npm run test:ai-adversarial` | **136 passed** |
| `p11b-authoritative-doctor-roster` (filter-faithful mocks) | **27 passed** |
| `p11b-authoritative-doctor-roster` (real Postgres) | **17 passed** |
| `p11-appointment-lookup` | **21 passed** (12 existing + 9 new) |
| `p9-booking-stage` | **61 passed** |
| `tsc --noEmit` | clean, 0 errors |
| `eslint` | 0 errors, 28 warnings (all pre-existing, unchanged from P11 §10) |
| `check-i18n-strings` | clean — 455 files, 41 documented exceptions |
| `check-logical-properties` (RTL) | clean — 737 files, 17 documented exceptions |
| `npm run build` | succeeded |

On the discipline the brief asked for: no test asserts a name it planted in a
fixture and then read back. Roster expectations are computed from the fixture's
own eligibility predicates, so adding a row moves both sides at once while
dropping a filter in `lib/` moves only one. `Mehmet Yilmaz` and `Ayşe Demir`
appear **only** as inputs pushed into the presentation layer, never as
exclusions — and `no production code names any of the people in this
reproduction` fails if a fix ever tries to work by naming them.

Coverage of the specific cases requested: receptionists in a department (both
suites, and by name in the integration suite), inactive, soft-deleted, on leave
in force now (and *not* excluded when the leave is over), another department's
doctors, reassignment in both directions, deactivation while running, a
department created mid-flight, a doctor created after boot, Arabic and English
department names, 3/20/100 departments, and fuzzy matching proved unable to
change a roster.

---

## 12. Verdict

**SAFE TO PUSH.**

Every gate is green, the change is additive, and the two mechanisms that matter
degrade safely: a grounding check that cannot load the directory leaves the
model's reply alone (pre-P11 behaviour, never invents a violation), and a stage
write that fails is re-derived on the next turn. The escalation edge is
reachable only from callers that have read `ai_escalated_at`, and the property
that no patient message and no model tool call can lift an escalation is
unchanged and still tested exhaustively.

Two things this report does **not** claim. It does not claim the issue is fixed
because tests pass — §6 is the architectural argument, and the load-bearing part
of it is that on a roster-bearing turn the doctor set in the patient-visible
text either equals `availableDoctorsInDepartment` over live rows or the text is
replaced by one composed from that function. And it does not claim the residual
in §6.6 is closed; it is narrowed to a bare, untitled, unlisted Arabic name on a
turn that also carried a correct roster, and that trade is stated rather than
buried.

Not pushed. Not deployed. Remote database untouched.

The outstanding manual check is unchanged in kind from P11 §11 and much cheaper
now: one real WhatsApp session per configured department, plus one
"عايز أعرف ميعادي" split across two messages against a real file. The
reproduced conversation itself is the best first target — it will self-heal its
stale latch on the next inbound message, which is directly observable in
`audit_logs` as `tool_called` becoming something other than `"none"`.
