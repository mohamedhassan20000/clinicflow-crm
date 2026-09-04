# P11I — Clinic directory vs booking state fix

**Date:** 2026-08-28

**Conversation:** `763b1c6b-c388-4f36-b8ca-965f71f20f86`

**Clinic:** `caf2711f-97cb-4474-a103-f9505f467087`

**Scope:** general department questions during an existing booking

**Verdict:** **SAFE TO PUSH** (after the P11I-R adversarial re-review in §6bis,
which found and fixed a phrase-bound safety boundary. The original §6 fix alone
was **not** safe.)

Nothing was pushed or deployed. No remote write was performed. No migration was
added. The hosted project was read only; database-writing tests used only the
local Supabase/Postgres stack at `127.0.0.1` and removed their fixtures.

---

## 1. Evidence boundary

The two exact messages were not in local Postgres. This checkout's active
`.env.local` points the localhost app at hosted project
`ayzetxywrqouqpurbjuv`; the local override remains renamed to
`.env.development.local.off`. The local stack was running, but querying it for
the two messages returned `[]`.

The runtime evidence below therefore comes from read-only hosted selects over:

- `inbound_messages`;
- `ai_suggested_replies` and `outbound_messages`;
- `audit_logs`;
- `conversations`;
- `departments`, `profiles`, and `doctor_unavailability`.

No RPC or mutation was invoked against the hosted project.

One visibility limit is intentional: P11H keeps raw tool receipts only in the
in-memory `GroundingLedger` for the lifetime of a turn. Audit rows retain closed
outcome labels/counts, and booking state retains offers, but arguments and the
whole raw JSON result are not persisted. The report distinguishes the exact
recoverable result from fields that cannot be recovered after the turn.

---

## 2. Exact runtime trace

### Turn 53 — `ايه الاقسام الموجودة؟`

Inbound:

```text
id:         17f67032-e726-4841-8157-a33fcd7b4197
created_at: 2026-08-28T12:48:25.673687Z
body:       ايه الاقسام الموجودة؟
```

Execution:

| UTC | Evidence |
|---|---|
| 12:48:27.232 | stage opened: `intake_collecting → intake_collecting`, turn 53, `tool_called=none` |
| 12:48:29.404 | `agent_tool:check_availability`, `outcome=success`, `count=31`, doctor specified, no service |
| 12:48:29.561 | stage trace: `tool_called=check_availability`, `tool_outcome=success` |
| 12:48:31.292 | second stage observation before the next tool |
| 12:48:31.618 | stage changed `intake_collecting → selecting_doctor`, `tool_called=prepare_booking`, `tool_outcome=roster` |
| 12:48:33.287 | authority: `booking_step=time`, `needs_slots`, expected `check_availability`, forced/requested/executed; two tools requested and executed in the turn |
| 12:48:33.791 | outbound row written |
| 12:48:34.492 | suggestion recorded as sent |

Exact patient-visible reply:

```text
القسم الموجود حاليًا هو **Physical Therapy**، والأطباء الموجودين:

1. Dr. Haneen Samir
2. Dr. Youssef Adel

تحب الموعد مع مين منهم؟
```

### Turn 54 — explicit challenge

Inbound:

```text
id:         62b1f09d-727e-4e76-8899-7f04ca9f8d4b
created_at: 2026-08-28T12:49:03.212816Z
body:       مفيش اقسام تانية ؟
            جلدية وقلب؟
```

Execution:

| UTC | Evidence |
|---|---|
| 12:49:05.059 | stage opened: `selecting_doctor → selecting_doctor`, turn 54, no tool |
| 12:49:07.142 | grounding accepted on retry source `state_backed` |
| 12:49:07.231 | authority: `booking_step=doctor`, `requirement=none`, `reason=committed_roster`, no tool requested/executed |
| 12:49:07.823 | outbound row written |
| 12:49:08.537 | suggestion recorded as sent |

Exact patient-visible reply:

```text
لا، القسم الوحيد النشط حاليًا هو **Physical Therapy**. الأقسام التانية غير متاحة دلوقتي.

تحب تحجز موعد لصديقك في **Physical Therapy** مع **Dr. Haneen Samir** أو **Dr. Youssef Adel**؟
```

---

## 3. Which tools executed, and their authoritative results

### Turn 53

Two tools executed, in this order:

1. `check_availability` — forced by P11G because persisted booking facts made
   `nextBookingStep()` return `time`;
2. `prepare_booking` — subsequently selected by the model.

#### `check_availability`

The exact recoverable authoritative result is:

```json
{
  "ok": true,
  "doctorId": "73326bbc-143a-4870-a952-cbaeeeb149b8",
  "doctorName": "Dr. Youssef Adel",
  "date": "2026-08-31",
  "availableSlots": [
    "09:00", "09:15", "09:30", "09:45",
    "10:00", "10:15", "10:30", "10:45",
    "11:00", "11:15", "11:30", "11:45",
    "12:00", "12:15", "12:30", "12:45",
    "13:00", "13:15", "13:30", "13:45",
    "14:00", "14:15", "14:30", "14:45",
    "15:00", "15:15", "15:30", "15:45",
    "16:00", "16:15", "16:30"
  ],
  "department": {
    "id": "794c4460-5ead-430b-8c1a-cdaa3db62fb6",
    "name": "Physical Therapy "
  }
}
```

Proof: the audit records `success/count=31`; the server-owned
`offeredSlots` snapshot contains exactly the 31 corresponding
`2026-08-31T…` values; the preceding committed doctor is Dr. Youssef Adel; and
the availability tool's fixed return contract adds the resolved department.

The raw receipt's `availabilityReason`, `workingHours`, duplicate
`doctor_name`, and guidance sentence were turn-local and are not recoverable
from the post-turn tables. They are not guessed here.

This result was authoritative but irrelevant to the patient's question.

#### `prepare_booking`

The exact result branch was `roster`, evidenced by the stage row and the state
it committed. Its authoritative entity payload was:

```json
{
  "department": {
    "id": "794c4460-5ead-430b-8c1a-cdaa3db62fb6",
    "name": "Physical Therapy "
  },
  "doctors": [
    {
      "id": "e7989c16-a116-45f3-a752-d48e73d6425f",
      "name": "Dr. Haneen Samir"
    },
    {
      "id": "73326bbc-143a-4870-a952-cbaeeeb149b8",
      "name": "Dr. Youssef Adel"
    }
  ],
  "doctor_count": 2,
  "only_one_available": false,
  "needs_selection": true,
  "field": "doctor"
}
```

Its fixed guidance tells the model to list every doctor in `doctors` and ask
which one the patient wants. The raw tool arguments and guidance string are not
persisted. The branch, department, complete two-doctor roster, ids, count, and
offer are persisted and exact.

Critically, this branch did **not** return the clinic's complete department
list. It returned one selected department and that department's doctors.

### Turn 54

No tool executed. The exact authority result was:

```json
{
  "booking_step": "doctor",
  "expected_authority": "none",
  "authority_reason": "committed_roster",
  "authority_satisfied": true,
  "expected_operation": "none",
  "tool_forced": false,
  "tool_requested": false,
  "tool_executed": false,
  "tool_request_count": 0,
  "tool_execute_count": 0
}
```

There was therefore no fresh clinic-wide authoritative result on the explicit
challenge.

---

## 4. Live clinic facts vs persisted booking facts

The live hosted directory at the time of investigation had exactly three
active, non-deleted departments:

| id | stored name |
|---|---|
| `f9bce151-70e3-45e7-84ca-c2a3abf1a703` | ` Dermatology` |
| `310e28bd-3a56-444d-b7c9-ec6a21dd62ab` | `Cardiology` |
| `794c4460-5ead-430b-8c1a-cdaa3db62fb6` | `Physical Therapy ` |

The conversation's booking state after turn 53 held:

- selected booking department: Physical Therapy;
- offered doctors: Haneen Samir and Youssef Adel;
- `bookingForOther=true`;
- stage `selecting_doctor`;
- the 31 server-offered slots retained in stage state;
- no selected doctor after `prepare_booking` re-opened doctor selection.

Those facts are valid for the booking. They say nothing about whether the
clinic has other departments.

---

## 5. Exact root cause

This was one scope-collapse defect expressed through four layers.

### 5.1 Authority considered booking progress, not the current question

`openBookingStageTurn` passed the patient text only to closing detection. It
computed authority from `nextBookingStep()` and persisted offers. On turn 53,
stale booking progress said `time`, so P11G structurally forced
`check_availability` even though the message was a general directory question.

`bookingAuthority` did force a booking-specific operation. `nextBookingStep`
itself was correct about booking progress; it was incorrectly treated as the
only scope relevant to the turn.

### 5.2 `prepare_booking` correctly honored the wrong scope

The model next called `prepare_booking`. That tool is deliberately monotonic:
when a department is already established, an argument-less/continuation call
uses it rather than restarting at departments. It therefore returned Physical
Therapy's roster, not all departments.

That P11D behavior is correct for booking continuation and wrong as an answer
to a clinic-directory question. The defect was not in its roster query.

### 5.3 Tool guidance caused the unsolicited doctor list

The `roster` result's contract explicitly says to list every doctor and ask the
patient to choose. The first reply listed doctors because the turn had entered
the selected-department booking operation; the model followed that result.

The patient had not selected or asked about a department on this turn, and the
booking did not genuinely need doctor selection. The wrong operation made
doctor selection look required.

### 5.4 Grounding validated membership, not clinic-directory completeness

On turn 53, the ledger contained the selected department and its two doctors,
so those names were grounded.

On turn 54, the turn ledger was empty. The first doctor check failed, then P11F
loaded `offeredDoctorIds` from persisted state and accepted both doctor names as
`state_backed`. That is correct for a later booking sentence about previously
offered doctors.

No check represented the proposition "these are all active departments".
Grounding allowed a real department name and had no detector for exclusivity
words such as "only". It therefore validated the doctor membership while the
clinic-wide department-count claim was false.

### 5.5 Why the challenge did not recover

Turn 53's `prepare_booking` committed a selected-department roster. Turn 54 then
derived `doctor`; `offeredDoctorIds.length > 0` made authority return
`none/committed_roster`. The authority instruction told the model that server
data for the step was already in front of it and not to call again.

The previous wrong reply was also in prose-only history. With no server-side
classifier for a clinic-wide department challenge, neither the new words nor
the explicit correction outranked the booking ladder. No fresh lookup ran.

---

## 6. Fix

### 6.1 A distinct clinic-directory intent

New pure `isClinicDirectoryQuestion` detects Arabic and English complete-list
and explicit-other/challenge shapes. It contains generic concepts only
(`department` / `specialty`); no clinic, department, or alias is hard-coded.

Examples now classified as clinic-wide:

- `ايه الاقسام الموجودة؟`;
- `مفيش اقسام تانية؟`;
- `هل فيه أقسام أخرى؟`;
- `What departments do you have?`;
- `Are there other departments?`.

A selection such as `عايز احجز في القسم الأول` and a doctor-roster question do
not widen into this scope.

### 6.2 A dedicated read-only authoritative operation

New `list_clinic_departments`:

- is stage-independent and available to both booking and FAQ patient tasks;
- accepts no department argument;
- reads all active, non-deleted departments with stable PostgREST pagination;
- returns no doctors;
- writes no conversation/booking state;
- returns a validated receipt:

```json
{
  "scope": "clinic_directory",
  "complete": true,
  "departments": [{ "id": "…", "name": "…" }],
  "department_count": 3
}
```

`loadDoctorDirectory` and the P11C clinic-vocabulary read now share the complete
department loader, removing the previous 50-row directory cap. Doctor roster
membership filters are unchanged.

### 6.3 Message scope outranks the booking ladder

`resolveBookingAuthority` now checks `clinicDirectoryQuery` after a closing and
before booking terminal/progress handling. A directory question resolves to:

```text
requirement = read_authority
operation   = list_clinic_departments
reason      = needs_clinic_directory
```

The original ladder step is still audited; it is not cleared or rewritten.

### 6.4 Directory turns cannot mutate booking progress

For the whole model turn, `activeTools` is narrowed to exactly
`list_clinic_departments`. This is the same P11G rule—stage/turn orchestration
may narrow a registered mount and may never widen it.

Consequently, a later model step cannot call `prepare_booking`, a calendar
tool, registration, or a write after reading the directory. Asking a general
question mid-booking leaves department, doctor, day, time, third-party latch,
intake state, and every committed offer untouched.

### 6.5 The complete receipt owns final copy

`enforceClinicDirectoryReply` runs before doctor grounding. On a directory
turn, it validates `scope`, `complete`, unique ids, every `{id,name}`, and exact
`department_count`, then builds the answer from every returned department.

It never lists doctors. A missing/partial/malformed receipt produces an honest
temporary-unavailable sentence rather than a partial or selected-department
claim. For the reproduced clinic, the Arabic result is:

```text
الأقسام النشطة الموجودة في العيادة هي: الجلدية، القلب، العلاج الطبيعي.
```

The new audit lines contain labels/counts only:

- `agent_tool:list_clinic_departments`;
- `agent_tool:patient_clinic_directory`;
- the existing `patient_booking_authority` row naming the directory operation.

---

## 6bis. Adversarial self-review (P11I-R) — findings and second fix

**Date:** 2026-08-28. Requested scope: prove that clinic-wide department intent
works for arbitrary natural-language wording that was never encoded in
production code or copied from a test.

It did not. The review found and fixed a real architectural weakness. Nothing
was pushed, deployed, or written to the hosted database; the only database used
was the local stack at `127.0.0.1`.

### 6bis.1 Finding 1 — intent detection was phrase-bound (critical)

`isClinicDirectoryQuestion` was a table of eleven regexes over a hand-written
Arabic/English lexicon (`ايه`, `الموجودة`, `تانية`, `what/which departments`,
…). The section 6.1 claim that it "contains generic concepts only" was true
about *specialty names* and false about *question wording*: the wording itself
was the lexicon.

A 45-message probe was run against the shipped classifier. Every one of the four
shapes §6.1 lists as examples matched. Of 40 novel paraphrases, **7 matched and
33 did not**:

| Category | Probe | Shipped classifier |
|---|---|---|
| formal Arabic | `أرجو إفادتي بالأقسام الطبية المتوفرة لديكم.` | miss |
| formal Arabic | `نرجو تزويدنا بقائمة الأقسام العاملة حاليًا.` | miss |
| Egyptian | `هو ده كل اللي عندكو؟` | miss |
| Egyptian | `طب انتو بتشتغلوا في ايه تاني غير العلاج الطبيعي؟` | miss |
| English | `Is physiotherapy the only thing you offer?` | miss |
| English | `Give me the full list of your medical units.` | miss |
| mixed | `عندكو dermatology ولا بس physical therapy؟` | miss |
| typo | `ايه الاقسم الموجوده عندكو` | miss |
| transliteration | `eh el a2sam el mawgoda?` | miss |
| typo | `wht departmnts do u have` | miss |
| existence, one specialty | `عندكم قسم جلدية؟` | miss |
| count | `كام قسم عندكو؟` | miss |
| enumeration | `عددوا لي الأقسام واحد واحد` | miss |
| challenge | `متأكد؟ ده كل اللي عندكو؟` | miss |
| challenge | `أكيد فيه غير ده` | miss |
| encoded example | `ايه الاقسام الموجودة؟` | match |
| encoded example | `مفيش اقسام تانية ؟` | match |

The full dump is reproducible from the corpus now committed in the test file.

### 6bis.2 Finding 2 — the safety boundary was attached to the miss (critical)

The miss rate alone would only have been a missed optimisation, because
`list_clinic_departments` is in `STAGE_INDEPENDENT_TOOLS` and is therefore
mounted and active at every booking stage: the model can always read the
directory, whatever the wording. The defect was that **the two guarantees the
patient depends on were both gated on the classifier**:

1. `enforceClinicDirectoryReply` returned `passthrough` immediately unless
   `isClinicDirectoryQuestion` matched. Requirement 6 — *no directory answer may
   claim completeness without a complete authoritative receipt* — was therefore
   unenforced for all 33 unrecognised paraphrases. The exact production sentence
   this phase exists to prevent, `لا، القسم الوحيد النشط حاليًا هو Physical
   Therapy. الأقسام التانية غير متاحة دلوقتي.`, shipped unmodified with an empty
   ledger when the challenge was worded `متأكد؟ ده كل اللي عندكو؟` instead of
   `مفيش اقسام تانية؟`. **The original P11I defect was fully reproducible by
   rephrasing.**
2. The §6.4 no-mutation guarantee (`activeTools` narrowed to the directory read)
   was likewise keyed on `authority.reason === "needs_clinic_directory"`, so on
   an unrecognised paraphrase a later step could still call `prepare_booking`.

### 6bis.3 Finding 3 — the committed-step instruction suppressed recovery

`bookingAuthorityInstruction` for a satisfied step said, unscoped: "The server
data for this step is already in front of you and still valid. Answer from it
and **do not call a tool again**." That is the exact instruction turn 54
received. It steers the model away from the read-only tool that would answer a
side question, which is the model-side half of why the challenge never
recovered.

### 6bis.4 Fix — the guarantees no longer depend on recognising the wording

The classifier was **not** widened. No paraphrase from the probe or from the
tests was added to production code; a test asserts this directly.

**(a) The model is the intent classifier; the receipt is the trigger.**
`enforceClinicDirectoryReply` no longer begins with a phrase test. It now
resolves three wording-independent rules in order:

1. A complete receipt in the turn ledger owns the department list, whenever the
   directory read was the turn's only tool, or the shape was proven, or the
   draft closes the department list. The trigger is the model's own semantic
   decision to call `list_clinic_departments`, so it fires for dialect, formal
   register, code-switching, transliteration and typos alike.
2. A turn whose shape *was* proven but which produced no valid receipt is
   answered honestly, as before.
3. Otherwise the draft passes through — unless it closes the department list
   with no receipt, which is refused.

**(b) `assertsClosedDepartmentList` is requirement 6, stated directly.**
Allow-by-default and sentence-scoped: it fires only where a generic concept word
(`قسم/أقسام/تخصص/تخصصات/عيادات`, `department(s)`, `specialty/specialties`) shares
a sentence with an exclusivity marker (`الوحيد`, `فقط`, `مفيش غير`, `لا يوجد`,
`غير متاحة`, `only`, `no other`, `nothing else`, `not available`, …) or with an
adjacent totaliser (`كل/جميع الأقسام`, `all departments`).

This is an **output guard on a claim we are about to make**, not intent routing.
It never decides what the patient meant; its default is to allow. Ambiguous
high-frequency words are deliberately excluded — Egyptian `بس` is usually "but",
and a bare `كل` only counts when it attaches to the concept — so ordinary
booking sentences such as `الدكتور الوحيد المتاح بكرة هو …` and `The only time
left tomorrow is 4:30 PM` pass through untouched, verified over the corpus.

**(c) The no-mutation guarantee is keyed on the read, not on the phrase.**
`prepareStep` now narrows the remaining steps of any turn in which
`list_clinic_departments` has actually executed to `STAGE_INDEPENDENT_TOOLS`.
It reuses the existing invariant rather than inventing a second list, and it
intersects whatever set was already active, so it can only ever subtract.
`prepare_booking`, `list_doctors`, `check_availability`, `list_available_days`,
`register_patient` and `create_preliminary_booking` are all unreachable after a
directory read, on any wording.

**(d) The committed-step instruction is scoped to the booking step.** It now
says not to call *that booking tool* again, and explicitly permits the read-only
tool for a different question. No lexicon; it names no department or specialty.

### 6bis.5 Semantic boundaries, re-verified

| # | Boundary | Status |
|---|---|---|
| 1 | clinic-wide question → complete live directory authority | Holds on all 24 corpus paraphrases via the receipt trigger, independent of the classifier |
| 2 | current-booking department question → booking state | Unchanged; no directory receipt, no directory enforcement |
| 3 | doctor-roster question → selected department roster | Unchanged; P11B membership untouched, and the directory tool returns no doctors |
| 4 | a mid-booking directory question must not mutate booking state | Now holds on any wording — 6bis.4(c). Enforcement itself is a pure function, asserted by a ledger-identity test |
| 5 | the booking continues from exactly where it was | Holds: no workflow tool runs on a directory turn, so department, doctor, day, time, third-party latch and offers are untouched. Verified byte-identical on `ai_collected_data` / `ai_booking_stage` by the local-Postgres test |
| 6 | no completeness claim without a complete receipt | Now holds unconditionally — 6bis.4(b). Previously held only for the 7/40 recognised shapes |

### 6bis.6 What the classifier is now for

`isClinicDirectoryQuestion` survives, unwidened, with a demoted job: it lets the
server *force* the read on the first step for shapes it can prove, which saves a
round trip and removes reliance on model choice where reliance is avoidable. It
is documented in-module as an optimisation and explicitly not the safety
boundary, and its doc comment states that a `false` means "not provable here",
not "not a directory question". A miss now degrades to rules 1 and 3, which are
wording-independent.

### 6bis.7 Considered and rejected

Loading the complete department directory into every patient turn's ledger
would make requirement 6 vacuously true and remove the guard entirely. It was
rejected for this phase: it adds a query to every turn including the majority
that never mention departments, and it changes grounding semantics for doctors
and services that P11B/P11F own. It is recorded here as the next structural step,
not as a gap in this one.

### 6bis.8 Files changed by P11I-R

| File | Change |
|---|---|
| `lib/ai/clinic-directory.ts` | receipt-triggered enforcement; `assertsClosedDepartmentList`; new `unfounded_claim` outcome; module header documenting where intent actually comes from |
| `lib/ai/patient-agent.ts` | post-directory-read narrowing to `STAGE_INDEPENDENT_TOOLS`, intersecting the existing active set |
| `lib/ai/booking-authority.ts` | committed-step instruction scoped to the booking step |
| `tests/unit/ai/p11i-clinic-directory-vs-booking-state.test.ts` | 24-paraphrase adversarial corpus, 10 unfounded claims, 6 innocent replies; 7 new cases; corrected one fixture that asserted "ordinary mid-booking" while holding a directory receipt |
| `tests/unit/ai/p11g-booking-tool-authority.test.ts` | post-read narrowing test; instruction assertion updated to the scoped contract |

No migration. No production dependency added. No specialty, clinic, doctor or
patient name introduced anywhere.

### 6bis.9 Keeping the tests from becoming the lexicon

`does not become the production lexicon` reads `lib/ai/clinic-directory.ts` and
asserts that no corpus phrase appears in it. The corpus assertions are stated
*regardless* of what the classifier returns, so pasting a phrase into
`DIRECTORY_QUESTION_PATTERNS` to make a test pass is both unnecessary and caught.

---

## 7. Preserved invariants

- P11B doctor membership remains closed-world and department-scoped.
- P11C third-party sender/subject isolation is unchanged.
- P11D/P11F booking progress remains monotonic; the directory turn performs no
  target write and no sanctioned backward transition.
- P11G authority still pins only an already-mounted tool and narrows the active
  set for the whole directory turn.
- P11H write receipts and pending-entity visibility are untouched.
- Offered doctor/day/slot guards are unchanged.
- Human takeover, escalation, tenant authorization, entitlements, RLS, and
  identity re-resolution remain below the tool.
- No specialty name, clinic alias, doctor, patient, date, or slot is hard-coded
  in production logic.

---

## 8. Tests and validation

### New regression coverage

`tests/unit/ai/p11i-clinic-directory-vs-booking-state.test.ts` covers:

- Arabic and English directory intent;
- the exact general question and explicit-other challenge shapes;
- a selected department plus a `time` booking step being overridden by the
  directory read;
- a committed doctor roster not satisfying a department challenge;
- stage-independent mount at every booking stage;
- 3, 20, and 100 complete departments;
- authoritative receipt vs `selectedDepartmentId`;
- no automatic doctor listing;
- malformed/partial receipt failure;
- ordinary mid-booking conversation passing through unchanged.

`tests/unit/integration/p11i-clinic-directory-vs-booking-state.test.ts` uses real
local Postgres and covers:

- 3, 20, and 100 live active department rows;
- inactive and soft-deleted rows excluded;
- exact complete tool result;
- selected booking department not narrowing the directory;
- byte-identical `ai_collected_data` and `ai_booking_stage` before/after the
  read-only tool;
- Arabic mid-booking authority routing while collected state survives.

The P11G provider-request suite additionally proves a directory turn exposes
exactly one active tool for every model step.

### Gate results

| Gate | Result |
|---|---|
| all AI unit tests | **99 files, 1,851 passed, 2 skipped** |
| full non-integration suite | **429 files, 4,055 passed, 2 skipped** |
| full real local-Postgres integration | **65 files passed, 1 skipped; 650 passed, 3 skipped** |
| P11B/P11I real local Postgres, focused | **2 files, 21 passed** |
| adversarial/injection | **136 passed** |
| `pnpm typecheck` | clean |
| `pnpm lint` | 0 errors, 28 pre-existing warnings |
| i18n strings | pass, 455 files / 41 documented exceptions |
| RTL | pass, 750 files / 17 documented exceptions |
| production build | **exit 0** |
| `git diff --check` | clean |

All figures above are the post-P11I-R re-run. The earlier `p8b-inbox-composer`
timing failure noted below did not recur: the full non-integration suite is now
green in a single run.

The full non-integration run ended with 4,045 passing, 2 skipped, and one
unrelated `p8b-inbox-composer` timing failure (`findByRole("alert")`). The same
component file immediately passed in isolation: 23/23. No P11I or AI test
failed in that run.

---

## 9. Migration and remote status

No P11I migration exists or is needed. The fix uses existing tables and
in-memory tool receipts. The pre-existing P11H migration is not modified.

- Hosted database: read-only evidence queries only.
- Local database: isolated integration fixtures only, cleaned by `afterAll`.
- Push: none.
- Deploy: none.

---

## 10. Remaining limitations

1. Superseded by §6bis. The classifier's coverage is no longer a correctness
   limit, because no guarantee depends on it: an unrecognised paraphrase is
   answered from the receipt the model's own read produced, and a receipt-free
   completeness claim is refused whatever the question looked like. What remains
   is a latency/reliability limit — an unproven shape is not force-read on step
   one, so it relies on the model choosing to call an always-available
   read-only tool.
1b. The §6bis.4(b) output guard recognises exclusivity in Arabic and English.
   A completeness claim phrased with neither a concept word nor any exclusivity
   marker in the same sentence would not be caught. Ambiguous words were
   excluded on purpose to keep ordinary booking sentences untouched; §6bis.7
   records the structural change that would retire the guard entirely.
2. Raw tool arguments and complete raw results remain turn-local by P11H
   design. Counts/outcomes and server-owned offers are recoverable; uncommitted
   presentation fields are not. This protects audit privacy but limits post-hoc
   reconstruction.
3. A very large directory with many maximum-length names can exceed a messaging
   provider's one-message text limit. The read is complete and the 100-row
   regression passes, but multi-message deterministic pagination is not part of
   this phase.
4. Department labels outside the existing Arabic concept table are presented
   exactly as stored, preserving P11F's no-invented-translation rule.

---

## 11. Verdict

**SAFE TO PUSH.**

The scope distinction is structural at four boundaries, and — after §6bis — none
of them depends on recognising how the patient phrased the question:

1. A complete directory receipt in the turn ledger owns the department list in
   the reply, triggered by the model's own decision to read the directory.
2. No reply may close the clinic's department list without such a receipt,
   whatever the question looked like.
3. Once the directory has been read, every booking workflow tool is gone for the
   rest of the turn, so a side question cannot move department, doctor, day,
   time, the third-party latch, the intake, or any committed offer — and the
   booking resumes from exactly where it was.
4. The proven-shape classifier still force-reads early where it can, as an
   optimisation that no guarantee rests on.

A selected booking department remains valid state and can never serve as
evidence that it is the clinic's only department — no longer only for the five
phrasings someone thought to encode.

The §6 fix as originally shipped did **not** meet that bar: it was reproducibly
defeated by rewording the same challenge, and this review says so rather than
ratifying it.

No push, deploy, remote write, or P11I migration was performed. The hosted
project was not written to at any point; the only database exercised was the
local stack at `127.0.0.1`, whose fixtures are removed by `afterAll`.
