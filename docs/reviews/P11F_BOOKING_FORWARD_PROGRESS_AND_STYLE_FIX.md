# P11F — Booking forward progress, language consistency, and professional register

**Branch:** `feat/p7-manual-qa-polish`
**Date:** 2026-08-24
**Scope:** three manual-QA regressions found after P11D, traced to their exact turns in the
hosted audit trail (read-only), fixed generically, and pinned by tests.

**Evidence base.** Hosted project `ayzetxywrqouqpurbjuv`, conversation
`763b1c6b-c388-4f36-b8ca-965f71f20f86`, turns 32–42 (2026-08-24 17:07:31 → 17:10:37 UTC).
Read-only: `conversations`, `inbound_messages`, `outbound_messages`, `audit_logs`. No write,
no migration, no deploy.

---

## 0. The trace, as it actually happened

| # | turn | patient | assistant | stage_before → after | tool_called | grounding |
|---|------|---------|-----------|----------------------|-------------|-----------|
| 32 | 17:07:31 | السلام عليكم | greeting (ar) | selecting_department → same | none | — |
| 33 | 17:07:46 | عايز احجز لابني علاج طبيعي | asks for child's name/ID (ar) | selecting_department → same | none | — |
| 34 | 17:08:15 | name + national id | **"تمام يا عم!"** + asks DOB/email | selecting_department → same | none | — |
| 35 | 17:08:39 | `2,12,2015 / Omar@clinic.com / Ab+` | **"The departments we have are: Dermatology, Cardiology, Physical Therapy."** | selecting_department → same | none | violation → deterministic (`unbacked_roster`) |
| 36 | 17:09:02 | عربي؟ | Arabic, but department names still English | selecting_department → same | none | — |
| 37 | 17:09:13 | صح | department list again (English labels) | selecting_department → same | none | violation → deterministic |
| 38 | 17:09:24 | علاج طبيعي | roster, "الدكاترة المتاحين في Physical Therapy" | selecting_department → **selecting_doctor** | deterministic_continuation | violation → deterministic |
| 39 | 17:09:35 | حنين | doctor committed, "مفيش مواعيد متاحة معاه" | selecting_doctor → **intake_collecting** | deterministic_continuation | violation → deterministic |
| 40 | 17:09:49 | يوسف | doctor changed, 13 real days offered | intake_collecting → same | deterministic_continuation | violation → deterministic |
| 41 | 17:10:13 | 31 | **model prose**: "تمام، 2026-08-31. الأوقات المتاحة: 09:00 … 18:30" | intake_collecting → same | none | *no grounding row* |
| 42 | 17:10:31 | الساعه ٩ الصبح | **"الدكاترة المتاحين في Physical Therapy: …"** ← the regression | intake_collecting → same | deterministic_continuation | violation → deterministic (`unbacked_roster`) |

Two facts dominate everything below:

* **`tool_called: "none"` on every single turn.** The model never called a booking tool once
  in the entire conversation. The deterministic continuation *was* the booking flow.
* **`illegalTransitions: 0` throughout.** The stage machine was never wrong. What went
  backwards was the *presentation*, and nothing in the system had an opinion about that.

Final persisted state confirms the damage: `offeredSlots: []` (the 20-slot time grid on turn
41 was invented and never recorded as an offer), `appointment_date: "2026-08-23"` (stale, from
an earlier session — turn 41 persisted nothing), no `appointment_time`, and
`lastToolOutcome: {tool: deterministic_continuation, outcome: roster_offered}`.

---

## 1. Exact source of the English leakage

Two independent defects, both real.

**(a) The whole reply flipped language — turn 35.**
`resolveReplyLocale` in `auto` mode read the script of *the newest message only*
(`lib/ai/patient-reply.ts`, the `patientText: message` argument). Turn 35 was
`2,12,2015 / Omar@clinic.com / Ab+` — an intake answer in which every letter is Latin. The
turn resolved to `en`, the deterministic roster reply rendered its English branch, and the
patient's next message was "عربي؟". Intake answers are *the* place a patient types Latin
characters into an Arabic thread, which makes that the worst possible moment to re-read the
language from one message.

**(b) The labels stayed English — turns 36, 37, 38, 42.**
`buildDeterministicRosterReply` interpolated `departments.name` verbatim into Arabic
sentences (`${input.departmentName}`). `departments.name` is a single column holding whatever
an administrator typed into a settings form; a reply that interpolates it inherits that
script. The trailing space in the stored value `"Physical Therapy "` is also why the reply
read `في Physical Therapy :`.

**Fix.**
* `scriptEvidence()` (new, `lib/ai/communication-style.ts`) grades a message `strong` /
  `weak` / `none`. Emails, URLs and any token containing a digit are stripped before
  judging; Latin then needs a surviving token of ≥3 letters. `Ab+`, `Omar@clinic.com`,
  `2,12,2015`, `REF7741` are all `weak`.
* `resolveReplyLocale` gained `conversationScript`: `auto` switches only on **strong**
  evidence, otherwise it keeps the language the thread has been speaking, and only falls back
  to the clinic locale on a genuinely fresh thread. A configured `ar`/`en` still wins
  outright, unchanged.
* `lib/ai/entity-labels.ts` (new) turns a *stored* label into a *presented* one:
  1. contains Arabic → left exactly alone;
  2. otherwise looked up in the concept lexicon `entity-resolution.ts` already uses to
     *understand* patient text, read backwards → the ordinary Arabic specialty name;
  3. lexicon says nothing (a brand, an invented name) → **presented unchanged**. That is the
     "genuinely intended to remain untranslated" case.
  Person names are never rewritten — only the leading title (`Dr.` ↔ `د.`), because the name
  is what every grounding check compares against and renaming a real doctor would be
  indistinguishable from inventing one.
* Every server-composed patient sentence now routes labels through it, and the model is told
  the same rule in both style prompts.

## 2. Exact source of "يا عم"

Turn 34, `17:08:19`, model-generated (`tool_called: none`, no grounding row — the text went
out as written). The clinic's tone is `friendly`, and the entire instruction the model had was
`- اجعل أسلوبك ودّي ودافئ دون مبالغة، وأجب باختصار.` Nothing anywhere said where warm stops,
so the model supplied the most colloquial Egyptian reading of "warm" it had.

**Fix, in two layers.**
* **The request.** `PROFESSIONAL_REGISTER_AR/EN` are appended to the style block for **every**
  tone (`friendly`, `neutral`, `formal`) and every Arabic register. They name the prohibited
  forms explicitly (يا عم، يا معلم، يا باشا، يا بيه، حبيبي، يا كبير، يا زعيم / bro, mate,
  buddy, dude, pal) *and* name the wanted warmth (تمام، حاضر، أكيد، تحت أمرك، خلينا نكمل)
  plus "لا تكن آليًا", so it does not read as "be cold".
* **The check.** `lib/ai/reply-register.ts` (new) is a pure predicate over the finished
  string, applied in `patient-reply.ts` to *every* outbound sentence — model, regenerated, or
  server-composed — for the same reason the grounding check is: a deterministic reply and a
  generated one must not differ on how they address a patient. The remedy is excision, not
  refusal and not a second model round trip: every listed form is a vocative that carries no
  information, so `"تمام يا عم!"` → `"تمام!"`. A sanitisation emits one audit line carrying
  labels from a closed set and never the sentence.
* **The one override, with no migration:** `clinicPermitsInformalAddress` allows exactly the
  forms a clinic has itself typed into `ai_style_instruction`. Absence of a setting is not
  consent.

## 3. Exact state regression after time selection

Turn 42. Sequence inside the turn:

1. Model wrote a forward-progress reply naming the doctor already chosen on turn 40.
2. `isRosterBearingTurn` → true (the reply names a doctor).
3. The grounding ledger held **nothing**: it records *this turn's* tool results and no tool
   ran. `checkDoctorGrounding` → violation, `sources: clinic_directory`,
   `offered_doctor_count: 0`.
4. `unbacked_roster` branch → `continuePatientBookingFromRoster`.
5. That function's only ladder was department → doctor. It found the department settled, ran
   `resolveOfferedDoctor("الساعه ٩ الصبح")` against the offered roster, got `no_match`, and
   fell through to **re-offering the department's roster** — `outcome: roster_offered`.

So the first point at which the state moves backward is **step 3**, and the first point at
which the *patient sees* it is step 5. Nothing was lost from `ai_collected_data` — the
department, doctor and (stale) date all survived. What went backwards was the sentence.

A second, deeper cause explains turn 41: for a third-party booking `deriveStage` returns
`intake_collecting` from the moment a doctor is chosen and stays there through the day and
time sub-flow, and `STAGE_WORKFLOW_TOOLS.intake_collecting` did not include
`list_available_days` or `check_availability`. With the calendar unmounted for that entire
window the model had no truthful way to answer "which times?" — and answered anyway, with an
invented 09:00–18:30 grid that was never recorded as an offer.

## 4. Model, tool, or fallback?

**The fallback**, on both counts.

* The backward jump on turn 42 was produced entirely by
  `patient-reply-grounding.ts` → `patient-roster-continuation.ts`. The model's own reply for
  that turn was forward-progressing and was discarded.
* The model contributed the *trigger* (it named a doctor without calling a tool) and the
  invented time grid on turn 41 — but it was given no calendar tool to call.
* No tool misbehaved. `create_preliminary_booking` was never reached, and on turn 42 it was
  not even mounted (see §5).

## 5. How booking monotonicity is now enforced

`nextBookingStep()` in `lib/ai/booking-stage.ts` — pure, derived, never stored, never
model-influenced:

```
department → doctor → day → time → intake → confirm → done
```

It reads the same `ai_collected_data` the tools write, so it is monotonic in the collected
facts: a step is reachable only by collecting the field before it.

It is deliberately **not** `deriveStage`. `deriveStage` decides tool mounts and puts intake
before the calendar, which is correct (`register_patient` refuses without a department and a
doctor). That ordering is wrong for *presentation*, and the gap between the two is exactly
where the regression lived — three consecutive turns all reporting `intake_collecting` while
the conversation moved from doctor to day to time.

`continuePatientBookingFromRoster` is now a switch on that step. Every rung has its own
sentence (`buildDeterministicTimesReply`, `buildDeterministicTimeChoiceReply`,
`buildDeterministicIntakeReply`, `buildDeterministicPendingBookingReply`,
`buildDeterministicRevalidationReply`), and a miss at any rung re-offers *that* rung, never an
earlier one. Backward movement is possible only through four named branches, each with its own
audit outcome label:

| reason | outcome | what it clears |
|---|---|---|
| patient explicitly changes department | `department_changed` | doctor, date, time |
| patient explicitly changes doctor / asks for alternatives | `doctor_changed` | date, time |
| doctor no longer `available` in the live directory | `doctor_unavailable` | doctor, date, time |
| slot fails revalidation at booking time (`slot_unavailable`, `minimum_notice`) | `booking_blocked` | time only |

Naming the doctor already chosen is a confirmation, not a change.

Supporting pieces:

* `resolveOfferedTime` / `candidateClockTimes` resolve "الساعه ٩ الصبح", "٩ ونص", "4 العصر",
  "9:30" against the slots this conversation was *actually shown* — the same device
  `resolveOfferedDay` uses for "31". A reading matching two offered slots is asked about as a
  *time*; it can never return a slot that was not offered, which is what `checkOfferedSlot`
  depends on one step later.
* **The grounding ledger was widened** (`patient-reply-grounding.ts`). A doctor in
  `ai_collected_data.doctor_id` or in `offeredDoctorIds` was put in front of this patient by
  the server on an earlier turn; both are server-owned and unwritable by the model, so a name
  backed by either is grounded. Read only *after* the first check fails, so the happy path
  pays nothing. This alone would have left turn 42's forward reply intact.
* `intake_collecting` now mounts `list_available_days` and `check_availability` — read-only,
  and only because a doctor is by definition already established in that stage.
  `create_preliminary_booking` deliberately stays out: no appointment for a patient with no
  file. `tests/unit/ai/p9-booking-stage.test.ts` was corrected accordingly (it had grouped
  `intake_collecting` with the pre-doctor stages, which is the one stage in that list where a
  doctor does exist) and a new assertion pins the booking tool's continued absence.

## 6. How third-party intake preserves the booking target

Booking **subject** (`bookingForOther`, a stage latch) and booking **target**
(`department_id`, `doctor_id`, `appointment_date`, `appointment_time` in
`ai_collected_data`) were already separate columns; the fix enforces the separation at the
one place that was violating it.

* The intake rung (`intakeAsk`) **writes nothing at all** — no `setConversationAiState`, no
  stage patch — so there is no code path through which it can clear a target field. Pinned by
  a test asserting `setState` was never called.
* Its sentence is *built from* the target: "تمام، حجزنا مع {doctor} يوم {date} الساعة {time}.
  قبل ما أبعت الطلب محتاج بيانات المريض: {missing fields}". The target cannot be silently lost
  without the sentence visibly losing it.
* Only the missing fields are asked for (`missingIntakeFields`).
* `bookingForOther` is never written by this module — pinned, as in P11D.
* Once the intake is staged, the confirm rung books with the preserved
  doctor/date/time through the same `createPatientPendingBooking` the tool uses (same 24-hour
  rule, same availability revalidation, same pending caps). No second booking path exists.
* Audited: no trigger, RPC or tool clears `department_id`, `doctor_id`, `appointment_date` or
  `appointment_time` during a patient-intake update. The only clears in the deterministic path
  are the four sanctioned backward branches in §5.

## 7. Language and style behaviour after the fix

| situation | before | after |
|---|---|---|
| Arabic thread, intake answer (`2,12,2015 / …@… / Ab+`) | flips to English | stays Arabic |
| Arabic thread, patient writes "can we continue in English" | English | English |
| English thread, patient writes "ممكن نكمل بالعربي" | Arabic | Arabic |
| `language = ar`, patient writes English | Arabic | Arabic (unchanged) |
| `language = en`, patient writes Arabic | English | English (unchanged) |
| department stored `"Physical Therapy "`, Arabic reply | `Physical Therapy ` | `العلاج الطبيعي` |
| department stored `"الأسنان"` | `الأسنان` | `الأسنان` |
| department stored `"Gamma Unit"` (a brand) | `Gamma Unit` | `Gamma Unit` |
| doctor `"Dr. X"` in an Arabic reply | `Dr. X` | `د. X` |
| `"تمام يا عم!"` | sent | `"تمام!"`, one audit line |
| `"تمام، حاضر، أكيد، تحت أمرك"` | sent | sent, byte-identical |
| clinic style instruction says "قول حبيبي" | — | `حبيبي` allowed |

## 8. Files changed

**New (4 source, 4 test):**
```
lib/ai/entity-labels.ts                              presented label ≠ stored label
lib/ai/reply-register.ts                             the professional-register check
tests/unit/ai/p11f-language-consistency.test.ts      28 tests
tests/unit/ai/p11f-professional-tone.test.ts         41 tests
tests/unit/ai/p11f-booking-forward-progress.test.ts  21 tests
tests/unit/ai/p11f-grounding-state-backed.test.ts     6 tests
```

**Modified:**
```
lib/ai/booking-stage.ts              nextBookingStep, resolveOfferedTime, candidateClockTimes,
                                     bookingStepRank; calendar tools mounted in intake_collecting
lib/ai/communication-style.ts        scriptEvidence, conversationScript, sticky auto locale,
                                     professional-register + label-language prompt rules
lib/ai/entity-resolution.ts          conceptKeys exported (read backwards by entity-labels)
lib/ai/patient-grounding.ts          all deterministic replies localize labels/titles;
                                     five new ladder reply builders
lib/ai/patient-reply-grounding.ts    allowed names widened with server-committed/offered doctors
lib/ai/patient-reply.ts              conversation-sticky locale; register enforced on every
                                     outbound sentence
lib/ai/patient-roster-continuation.ts   rewritten as the stage-aware monotonic ladder
tests/unit/ai/p9-booking-stage.test.ts  mount invariant corrected + new assertion
```

Nothing named a department, a doctor or a clinic. The P11B/P11C source-tree guards
("no production file names any person from this reproduction") pass.

## 9. Migration status

**No migration.** No schema change, no new column, no new RPC, no trigger touched. The clinic
override for informal address deliberately reuses the existing `ai_style_instruction` column
rather than adding one. Remote database was read-only throughout.

## 10. Test results

| suite | result |
|---|---|
| `vitest run tests/unit --exclude tests/unit/integration/**` | **426 files, 3982 passed**, 2 skipped |
| `vitest run tests/unit/ai` (P9/P10/P11/P11B/P11C/P11D/P11F, booking-stage) | 96 files, 1780 passed, 2 skipped |
| `npm run test:integration` (real local Postgres) | 64 files, **646 passed**, 3 skipped |
| `npm run test:ai-adversarial` (P6A injection + eval set) | 136 passed |
| new P11F suites | 96 passed |
| `npm run typecheck` | clean |
| `npx eslint lib/ai tests/unit/ai` | clean (1 pre-existing warning in `conversation-context.ts`, untouched) |
| `npm run lint:rtl` | ✓ 746 files, no undocumented physical-direction styles |
| `npm run lint:i18n` | ✓ 455 files, no hardcoded user-facing strings |
| `npm run i18n:missing` | ✓ 4255 base leaf messages, locale variants valid |
| `npm run build` | ✓ (see §12) |
| `git diff --check` | clean |

E2E (Playwright) was not run: these changes are server-side WhatsApp reply-path only and the
E2E suite covers browser flows.

## 11. Remaining limitations

1. **The model still does not call booking tools on this clinic's WhatsApp path.** Every one
   of the 11 turns examined had `tool_called: "none"`. This phase makes the deterministic
   path able to complete a booking end to end, and §5 mounts the calendar tools that were
   missing during `intake_collecting` — but *why* the model prefers prose over
   `prepare_booking` is not diagnosed here and remains the largest open item. It is now
   survivable rather than fatal.
2. **Doctor names are not transliterated.** An Arabic reply says `د. Youssef Adel`, not
   `د. يوسف عادل`. Deliberate: the stored Latin name is what the grounding check compares
   against, and a transliterated rendering would be indistinguishable from an invented one.
   Closing this needs the grounding checker to accept curated transliterations as the same
   entity.
3. **The Arabic specialty table covers 21 concepts.** A department outside it is presented as
   stored — correct behaviour for a brand, a silent miss for an unusual specialty. Extending
   the table is one line and non-destructive.
4. **The deterministic intake rung asks but does not capture.** It lists the missing fields
   and does not parse the patient's answer into `ai_collected_data`; `register_patient` is
   still the only writer. If the model never calls that tool either, the same fields are asked
   for again. Capture in the fallback was considered and rejected for this phase — mis-parsing
   a national ID onto a medical file is worse than a repeated question.
5. **`appointment_date: "2026-08-23"` in the live conversation is stale** (pre-existing, from
   an earlier session, and in the past). It was left as-is — the remote database is read-only
   for this phase. The next real turn on that thread will now resolve the day rung against
   the offered days and overwrite it.
6. **The register list is closed and Egyptian/Gulf-weighted.** A Levantine or Maghrebi slang
   vocative not on the list passes the check (the prompt rule still applies). Extending it is
   additive.
7. `enforceReplyRegister` leaves a reply that is *only* a vocative untouched, because sending
   nothing is worse than sending it casually.

## 12. Verdict

**SAFE TO PUSH** — with the standing constraint that this phase performs no deployment.

Reasoning: no schema change and no migration; the remote database was read only; every change
is either additive (two new pure modules, five new reply builders, four new test files) or a
narrowing of a code path that was already producing a wrong answer; the one mount relaxation
is read-only and keeps `create_preliminary_booking` out of `intake_collecting`; the P11B
closed-world roster guarantee is intact and its source-tree guards pass; the full unit suite,
the real-Postgres integration suite and the adversarial injection corpus are green; typecheck,
eslint, RTL, i18n and `git diff --check` are clean.

Nothing has been pushed and nothing has been deployed.
