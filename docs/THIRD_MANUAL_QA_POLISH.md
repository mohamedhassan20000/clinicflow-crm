# Third manual-QA polish pass — Patient AI V2 + Settings/Patients data model

**Status:** implemented, tested, **not committed, not pushed, not deployed.**
**Migration written and NOT applied:** `supabase/migrations/20260918120000_bilingual_patient_names_and_package_service.sql`.
No writes were made to Production. The only Production access in this pass was
read-only `select` against `information_schema`, `pg_proc`, `conversations`,
`inbound_messages`, `outbound_messages` and `audit_logs`, to trace the QA
session and to read the current schema and function bodies before designing the
migration.

---

## 1. Root cause, per QA issue

### 1.1 «تقدر تساعدني في ايه؟» was answered with a greeting

The message has no representable reading. `answer_question` had no topic about
*the assistant*, so the interpreter's two best options were `small_talk` (the
greeting the live session produced) and `clinic_other` — and `clinic_other` is
answered from the clinic's FAQ, which has no row about the assistant, so the
honest empty answer fell through to the generic opening. The defect is a missing
topic, not weak copy.

**Fix:** a `capabilities` topic in the command contract, a fixed server-authored
answer behind it, and a deterministic reconciliation (`reconcileCapabilityQuestion`)
so the reading does not depend on the model. Every line of the answer names a
flow or topic that actually exists.

### 1.2 «لا عايز بعد التاريخ دا» was «معلش، ما قدرتش أحدد اللي تقصده»

`parseDateLowerBound` matched the `بعد` marker and then had nothing to resolve:
no full date, no day-of-month, no weekday. It returned null, so
`reconcileDayRefinement` did not fire, the turn fell through to the day step's
resolver, and «لا عايز بعد التاريخ دا» matched no offered day.

**Fix:** a contextual lower bound. When the phrase is demonstrative («بعد
التاريخ ده», «اللي بعدهم», "after these dates") the boundary is the latest date
in the **currently open** day offer. See §9 for the semantics.

### 1.3 «الساعة 9وربع» and «2» re-showed the same twenty-line list

Not a parsing failure. `normalizeSpokenTime("الساعة 9وربع")` already returned
`09:15`, and `resolveOfferIndex` already resolved `2` against a live offer — but
both live on the `set_slot` path, and the interpreter had emitted
`affirm_offer`. A bare affirmation of a list with no primary option is ambiguous
by construction, so `applyCommand` answered with the very list that had just
been shown. Confirmed by reproduction: `affirm_offer` → `affirm_needs_choice` →
`clarify.which_one`; `set_slot` → `slot_offer_index` → committed.

**Fix:** `reconcileOfferSelection` — for exactly the offer shape whose
affirmation the engine already refuses (more than one option, no
`primaryOptionId`), the turn text is re-read through the *same* two mechanisms
an ordinary answer goes through, and the affirmation is rewritten into the
`set_slot` it was **only if one of them reads it**. A genuine bare «اه» still
gets "which one?".

A second, smaller time defect was found and fixed: «واحدة إلا ربع» borrowed the
hour *before* the meridiem expansion, so one o'clock became midnight and the
afternoon reading (12:45) was unreachable. The fractional offset is now carried
separately and applied to each reading.

### 1.4 The `2.4.2003` loop — the exact root cause

Two independent causes, both required to produce the loop:

1. **Duplicate candidate generation.** `normalizeSpokenDate` returns every
   reading the digits support, by design, and `resolveIntakeField` offered both
   for a date of birth. `2.4.2003` is not two things a patient might have meant
   — it is one date written in this clinic's own convention — so the question
   asked the patient to choose between their convention and a foreign one.
2. **Offer acceptance.** Selecting one *did not advance* because of exactly the
   defect in §1.3: `1` arrived as `affirm_offer`, and a two-option offer with no
   primary re-rendered itself. The patient answered correctly four times.

Neither the intake resolver, the normalized slot write, nor the canonical
answer reconciliation was at fault.

**Fix:** `normalizeSpokenDate` gained a `{ order: "day_first" }` option that the
date-of-birth branch uses; month-first survives only as the fallback for digits
day-first cannot read (`12/25/1990`). Offer matching still gets both readings,
because matching against seven offered days is a filter and wants every reading.
Plus the §1.3 fix, so a genuinely ambiguous offer can now be answered by
selecting from it.

A future date of birth is now also refused at the flow (it was only refused by
the staging RPC, where the refusal is a hard error and therefore a handoff).

### 1.5 The handoff banner — finding

**Finding B: a new escalation event, fired once, on the last turn.** Not
historical state, not a UI clearing bug, and **not** the weak-beneficiary
false-positive path, which is intact.

Evidence (read-only):

- `conversations.ai_escalated_at = 2026-09-06 14:45:32.775+00`,
  `ai_escalation_reason = 'human_requested'`.
- `audit_logs`: `agent_tool:patient_escalation`,
  `{"mode":"auto","sent":true,"reason":"human_requested","source":"v2_engine"}`
  at `14:45:33` — `source: v2_engine` means the **interpreter emitted
  `request_handoff`**, not the deterministic pre-model detector.
- The message immediately before it (`14:45:26`) was
  «انا بجاوبك بقالي كتير انت مصمم على التكرار» — frustration at the DOB loop.
- Every prior turn in the session was `agent_tool:patient_v2_turn`, so the AI
  was answering normally right up to that message.

The banner reads as "throughout the conversation" because it is a
conversation-level latch rendered above the whole thread
(`components/inbox/inbox-shell.tsx` renders it on `selected.escalatedAt` with no
time anchor), not because it fired repeatedly.

**No escalation code was changed.** The frustration that triggered it was caused
by the DOB loop, which is fixed. Strong human-request detection is untouched and
is pinned by tests in both directions.

---

## 2. Existing behaviour reused vs changed

### Reused, extended at its existing seam — no new system

| Requirement | Seam extended |
| --- | --- |
| Contextual "after these dates" | `parseDateLowerBound`, `reconcileDayRefinement`, the day step's existing `collects: ["date_lower_bound"]` |
| Numeric / spoken selection against a live offer | `resolveOfferIndex` + the step's own `resolveValue`, reached through a third reconciliation shaped exactly like the two that already exist |
| Date formats | `normalizeSpokenDate` (one option added; no second parser) |
| Arabic clock | the existing `FRACTIONS` / `MERIDIEM` / `ARABIC_HOURS` tables |
| Capability answer | `answer_question` topic + `COPY` entry |
| English-name confirmation | `proposeLatinName` + the registration flow's existing `full_name_latin` step, now shared with the booking intake |
| Bilingual names on writes/reads | `stripBlankDisplayNames` / `selectWithOptional` (`lib/settings/display-names.ts`) |
| Package↔service | `PackageEntry` + `renderPackageDetail` |

### Deliberately changed behaviour

1. **A date of birth is committed day-first instead of offered as two
   candidates.** This is the change the brief asks for. `normalizeSpokenDate`'s
   default is unchanged; only the DOB branch opts in.
2. **The booking intake now asks for the English spelling**, right after the
   name. Consequently a file staged from the booking flow carries
   `full_name = <confirmed Latin>` and `full_name_original = <Arabic>` — the
   existing P10 shape, which until now only the registration flow reached.
3. **An Arabic name is always confirmed**, even when every part had a curated
   transliteration. Previously `needsConfirmation === false` filed it silently.
   A curated reading is still this system's choice of spelling for somebody's
   name.
4. **`advance` no longer marks a step "seen" after a `fill`.** A `fill` commits
   a slot, so the step it re-enters is looking at a different frame; marking it
   seen turned "derive the Latin spelling of a name already in English" into
   `flow_stuck`. The depth bound (`MAX_SILENT_STEPS`) still catches a runaway.
5. **A future date of birth is refused** at the flow.

### Explicitly preserved (pinned by the new tests)

Beneficiary-first; numbered lists; numeric replies against live offers; Arabic
doctor resolution; existing date refinements; side questions resuming the
booking; staged intake continuing into booking; summary before mutation;
correction invalidating the confirmation; "this is a request awaiting clinic
confirmation"; post-booking conversation; package/insurance behaviour; blood
type; weak beneficiary phrases not escalating; explicit «عايز أكلم موظف» still
escalating; identity/provenance firewall; I-1 and I-2.

---

## 3. Files changed

**Patient AI V2**
- `lib/ai/v2/normalize.ts` — time offset/meridiem fix; `DateReadingOptions`;
  `DateLowerBoundOptions` + `CONTEXTUAL_AFTER_MARKER`.
- `lib/ai/v2/engine.ts` — `reconcileCapabilityQuestion`,
  `reconcileOfferSelection`, `liveOfferedDates`, the `seen`/`fill` fix.
- `lib/ai/v2/flows.ts` — `latinNameOutcome`, `arabicNameOrNull`, Latin-name
  resolver, DOB day-first + future guard, `capabilities` branch, contextual
  bound wired into the day step, `intakeFieldsFor` order, bilingual names passed
  to staging.
- `lib/ai/v2/commands.ts` — `capabilities` topic.
- `lib/ai/v2/interpreter.ts` — the topic and one rule in the prompt.
- `lib/ai/v2/composer.ts` — `info.capabilities`; bilingual name copy (+ `.other`).
- `lib/ai/v2/catalog.ts`, `lib/ai/v2/present.ts`, `lib/ai/v2/tools.ts` —
  package↔service fields; `readPatientDisplayName`.
- `lib/ai/v2/assemble.ts` — `canonicalName` prefers the conversation's language.
- `lib/supabase/admin.ts` — bilingual staging args with a `PGRST202` fallback.

**Settings / Patients**
- `lib/settings/display-names.ts` — `PATIENT_DISPLAY_COLUMNS`, two new keys.
- `lib/validations/patient.ts`, `lib/validations/package-template.ts`
- `lib/patients/mutations.ts`, `lib/billing/mutations.ts`
- `actions/patients.ts`, `actions/package-templates.ts`
- `app/(protected)/patients/page.tsx`, `.../[id]/page.tsx`, `.../[id]/edit/page.tsx`
- `app/(protected)/settings/packages/page.tsx`
- `components/patients/patient-form.tsx`, `components/patients/ai-intake-review-section.tsx`
- `components/settings/packages/{package-template-form,package-template-row-actions,add-package-template-dialog}.tsx`
- `types/database.ts`
- `messages/{en,ar}.json`, `messages/action-errors/{en,ar}.json`

**Migration (not applied)**
- `supabase/migrations/20260918120000_bilingual_patient_names_and_package_service.sql`

**Tests** — new: `tests/unit/ai/v2/p3-qa-polish.test.ts`,
`tests/unit/components/p3-package-template-service.test.tsx`,
`tests/unit/components/p3-patient-bilingual-names.test.tsx`,
`tests/unit/db/bilingual-patient-names-and-package-service-migration.test.ts`.
Updated: `qa-defects`, `blood-type-intake`, `booking-policy-and-ownership`,
`assemble`, `packages-insurance-and-confirmation`,
`ai-intake-blood-type-review`, `p10-inbox-dashboard-notifications`.

---

## 4. Schema, before → after

| Table | Before | After (proposed) |
| --- | --- | --- |
| `patients` | `full_name text not null` and no display names | `+ full_name_ar text null`, `+ full_name_en text null`, `+ patients_display_name_length` check (2..100 each) |
| `ai_patient_intakes` | `full_name`, `full_name_original` | `+ full_name_ar text null`, `+ full_name_en text null`, `+ ai_patient_intakes_display_name_length` check |
| `package_templates` | `department_id uuid not null`, no service link | `+ service_id uuid null`, `+ package_templates_service_fk (clinic_id, service_id) → services(clinic_id, id) on delete set null`, partial index on `service_id` |
| `services` | pk on `id` | `+ unique index services_clinic_id_id_key (clinic_id, id)` — exists only so the package FK can carry `clinic_id` |

Nothing renamed, nothing dropped, no backfill, no policy touched.

---

## 5. The proposed migration — and yes, it contains function changes

`supabase/migrations/20260918120000_bilingual_patient_names_and_package_service.sql`
**contains two `security definer` function replacements.** This is the part that
needs your explicit approval.

### 5.1 `stage_patient_intake_from_conversation` — signature change

**Why it must change:** the assistant collects both names during intake and they
have to survive staging → review → approval. Writing them to
`ai_patient_intakes` requires the function to accept them; there is no other
path, because the table is only written by this RPC under `service_role`.

**Why a DROP is required:** adding two `default null` arguments changes the
signature, so `create or replace` would leave a *second overload* and PostgREST
could not choose between them. The migration drops the old twelve-argument
signature and immediately creates the fourteen-argument one, in the same
transaction.

**SQL diff (semantic):**
- `+ p_full_name_ar text default null`, `+ p_full_name_en text default null`
- `+ v_name_ar` / `v_name_en` locals, trimmed, length-bounded 2..100, and
  **dropped rather than raised** when unusable — the same treatment
  `p_blood_type` already gets. Losing a display name must not lose an intake.
- `+ full_name_ar, full_name_en` in the `insert`, and
  `full_name_ar = coalesce(excluded.full_name_ar, ai_patient_intakes.full_name_ar)`
  (and the same for `_en`) in the `on conflict do update`, so a later re-stage
  cannot erase a name an earlier turn collected.
- **Everything else is byte-identical to the deployed body**, including every
  identity check, the `service_role` gate, the phone/id duplicate arithmetic and
  the lock ordering.

**Security implications:** none intended and none found.
- Still `security definer`, still `set search_path to ''`.
- Still `raise exception 'PATIENT_AI_SERVICE_ROLE_REQUIRED'` for any caller that
  is not `service_role`.
- Grants are restated exactly as deployed: `revoke all … from public`,
  `grant execute … to service_role`. **Never `authenticated`** — asserted by a
  test.
- The identity comparison still folds `full_name`. Neither display name appears
  in any comparison — asserted by a test.

### 5.2 `approve_ai_patient_intake` — body change, signature unchanged

Plain `create or replace` on `(uuid, uuid)`. The single semantic difference is
`full_name_ar, full_name_en` added to the `insert into public.patients`, taking
`v_intake.full_name_ar` / `v_intake.full_name_en`.

The `matched_patient_id` branch is deliberately untouched: an intake that
continues an existing file writes nothing to it, because overwriting a name a
person at the clinic curated with one a conversation produced is not something
an approval should do silently.

Guards unchanged: `p_actor_id = auth.uid()`, admin/manager/receptionist,
`INTAKE_MATCHED_PATIENT_REVIEW_REQUIRED` re-proof, the advisory locks, the
one-active-AI-booking invariant, the audit row. Grants restated as deployed
(`authenticated` + `service_role`).

### 5.3 Application behaviour before the migration is applied

- Patient reads use `selectWithOptional` and retry without the columns.
- Patient writes use `stripBlankDisplayNames`, which drops a blank key entirely,
  so a clinic that authors nothing sends byte-for-byte the payload it sent
  before.
- `stagePatientIntakeFromConversation` calls the wide RPC once and falls back to
  the pre-migration argument list on `PGRST202`. **An intake is still staged**,
  without the two display names.
- The package catalog read carries `service_id` in the *optional* column list,
  so the whole package answer survives.
- The one thing that genuinely needs the migration: **saving a package template
  with a service selected** (the write names a column that must exist) and
  **saving a patient with a bilingual name typed in**.

---

## 6. Bilingual patient-name data path

```
patient types «علي الزهراني»
  → slot full_name              (spoken, resolved by resolveIntakeField)
  → latinNameOutcome(typed)     -> offer, one option, primary set
        Arabic      -> offer "Ali Alzahrani", confirm
        already Latin -> fill, no question
        unreadable  -> ask outright
  → «اه» / «لا خليه Ali Al Zahrani» / «Ali Al Zahrani»
  → slot full_name_latin        (affirmed | spoken; the resolver keeps only the
                                 Latin words, so «لا خليه» never reaches a name)
  → tools.stageIntake({
        fullName:         full_name_latin ?? full_name    (canonical, P10)
        fullNameOriginal: full_name                       (P10)
        fullNameAr:       arabicNameOrNull(full_name)     (null if not Arabic)
        fullNameEn:       full_name_latin
    })
  → stage_patient_intake_from_conversation
        → ai_patient_intakes.full_name / full_name_original / full_name_ar / full_name_en
  → Patients screen → AI intake review dialog shows both, each in its own
    direction, an em dash for a language the patient did not give
  → staff approve → approve_ai_patient_intake
        → patients.full_name_ar / full_name_en (new file only)
  → display:
        staff  — patient header shows both under the canonical name; the
                 create/edit form has an RTL Arabic field and an LTR English one
        patient — durable.canonicalName() → tools.readPatientDisplayName():
                 Arabic conversation prefers full_name_ar, English prefers
                 full_name_en, both fall back to full_name, all of it still
                 behind the unchanged `verified` gate
  → search: unchanged. `search_name` is still derived from `full_name`, so every
    existing patient is found exactly as before.
```

**Identity firewall:** a bilingual name is never an argument to
`find_clinic_patient_by_identity`, never folded, never compared. `resolveIdentity`
is still called with `{ nationalId, fullName }` and nothing else — asserted by a
test.

---

## 7. Package service data path

```
Settings → Packages → Add/Edit
  department select (controlled)
    → services filtered to that department, active only
    → changing the department clears an incompatible service
  service select (optional, default "no specific service")
    → on pick: price_per_session := service.price      (a default, not a link)
    → the service's own price is never written; the form has no control for it
  total_sessions / price_per_session
    → total_price := sessions × price_per_session, one-way
    → typing in total_price stops the derivation (an intentional discount
      survives); clearing it resumes the derivation
  submit
    → createPackageTemplateMutation / updatePackageTemplateMutation
       validateTemplateDepartment  (unchanged)
       validateTemplateService     (clinic + department + active; null is fine)
       stripAbsentService(stripBlankDisplayNames(payload))
    → package_templates.service_id   (FK carries clinic_id)
  Patient AI
    → readPublicPackages reads service_id in the optional column list and joins
      the active service catalog
    → PackageEntry.serviceName / serviceRegularPrice
    → renderPackageDetail prints: name, department, service, regular service
      price, sessions, package price, price per session, the clinic's note
    → no computed saving, ever. A package without a service renders byte-for-byte
      as it does today.
```

---

## 8. Contextual "after these dates" — the semantics

- Fires only on a **demonstrative** phrase: «بعد التاريخ ده/دا», «بعد دول»,
  «اللي بعدهم», «وريني اللي بعد كده», «مواعيد بعد التواريخ دي», "after these /
  those / that dates", "later dates". A bare «بعد» matches nothing.
- The anchor is `frame.offer` — the **live**, server-minted day offer. A
  withdrawn, answered, parked or corrected offer is not on the frame, so it
  contributes no dates and the phrase resolves to **nothing** rather than to a
  boundary out of the transcript (I-2). Never a durable fact, never another
  frame's list.
- The boundary is the **latest displayed date**, and it is **exclusive** —
  the same contract `readAvailableDays(after: …)` already has.
- It only runs while a booking/reschedule frame is active and `day` is still
  empty. A committed day makes this a *correction*, which keeps its own cascade.
- Everything downstream is unchanged: the lead-time floor, holidays and
  non-working days, and the requirement that a day be one the clinic actually
  offered before it can be committed.

---

## 9. Test results

| Scope | Result |
| --- | --- |
| `tests/unit/ai/v2/p3-qa-polish.test.ts` (new) | **87 passed** |
| `tests/unit/components/p3-package-template-service.test.tsx` (new) | **13 passed** |
| `tests/unit/components/p3-patient-bilingual-names.test.tsx` (new) | **8 passed** |
| `tests/unit/db/…-package-service-migration.test.ts` (new) | **18 passed** |
| `tests/unit/ai/v2` | 490 passed |
| `tests/unit/ai` | 3312 passed, 3 skipped |
| `tests/unit/components` | 853 passed (113 files) |
| `tests/unit/db` + `lib` + `actions` + `config` + `security` | 2219 passed (280 files) |
| `tests/unit/app` + `api` + `pages` + root | 177 passed (22 files) |
| **All four buckets together** | **6561 passed, 3 skipped — every non-integration file, green** |
| `vitest run --exclude integration --maxWorkers=4` | **589 files, 6565 passed, 3 skipped, 0 failed** (223s) |
| `tsc --noEmit` | clean |
| `eslint` on every touched file | clean (two pre-existing `label` warnings in `lib/validations/package-template.ts`) |
| `check-messages.mjs missing` | clean |
| `check-i18n-strings.mjs` | clean |
| `check-logical-properties.mjs` | clean |
| Integration tests | **not run** — they target Production |

Coverage of the requested list: A,B ✓ · C ✓ · D ✓ · E ✓ · F ✓ · G ✓ · H ✓ ·
I ✓ · J ✓ · K ✓ · L ✓ · M ✓ · N ✓ · O ✓ · P ✓ · Q ✓ · R ✓ · S ✓ · T ✓ · U ✓ ·
V ✓ · W ✓.

**A note on how to run the suite on this machine.** The whole suite in one
invocation is green — **589 files, 6565 passed, 3 skipped, 0 failed** — *provided
the worker count is capped* (`--maxWorkers=4`). Left uncapped it oversubscribes
and produces spurious failures that are pure contention: two consecutive runs of
the identical uncapped command gave 41 and 45 failures in **different** files,
every one of which passes in isolation, and the
`db+lib+actions+config+security` bucket gave 17 failures on one run and **0 on
an immediate re-run of the identical command**. Capping is also four times
faster (223s vs ~1,100s), because the failures were the machine thrashing.
Worth considering for the `test` script.

---

## 10. Remaining risks and gaps

1. **The migration is unapplied**, so package↔service saving and bilingual
   patient-name saving will fail until it runs. Every read path degrades
   gracefully; those two writes do not, by design (see §5.3).
2. **The package↔service department match is application-enforced.** The FK
   guarantees the clinic; it cannot guarantee the department or the active flag.
   `validateTemplateService` checks both on every create and update. A service
   later moved to another department, or deactivated, leaves an existing package
   pointing at it — the patient-facing read then treats the package as
   department-only rather than quoting something the clinic no longer sells.
3. **`patients.full_name` for an assistant-opened file is the Latin spelling.**
   That is the existing P10 shape, now reached by the booking flow too. Identity
   discovery folds the Arabic `full_name` slot while staging writes the Latin
   one as canonical — a pre-existing asymmetry this pass did not touch.
4. **The interpreter can still read frustration as a request for a person.** The
   §1.5 escalation was that. Nothing was weakened to hide it; the loop that
   caused the frustration is fixed. If you want that reading suppressed it is a
   separate, deliberate decision.
5. **The capability lexicon is deterministic and narrow.** A phrasing outside it
   still depends on the model reaching for the new topic, which the prompt now
   names.
6. **`readPatientDisplayName` adds one row read** per verified turn that needs
   the patient's name. It is memoized per turn by `once`.

---

## 11. Migrations requiring your approval

Exactly one:

```
supabase/migrations/20260918120000_bilingual_patient_names_and_package_service.sql
```

It contains **two `security definer` function replacements** (§5), one of which
requires a `drop function` on the old signature. Nothing in it has been applied.

---

## 12. Manual QA script, in order

Run against a fresh WhatsApp episode. Steps 12–15 need the migration applied.

1. «السلام عليكم» → greeting only, no flow starts.
2. «تقدر تساعدني في ايه؟» → the nine-line capability list, ending with
   «تحب أساعدك في إيه؟». **No booking starts.**
3. "what can you help me with?" in an English thread → the English list.
4. «عايز أحجز لحد تاني» → beneficiary recorded, **no handoff**.
5. «الجلديه» → department. Pick a doctor by number.
6. On the day list: «لا عايز بعد التاريخ دا» → a **new** list of days strictly
   after the last date shown, still respecting the lead-time floor.
7. Repeat with «اللي بعدهم» and "show me later dates".
8. On the time list: «3» → the **third** time shown. Then correct it with
   «الساعة 9 وربع» → 09:15 if it is on the list.
9. «واحدة إلا ربع» when a 12:45 slot exists → 12:45, not 00:45.
10. Name: «علي الزهراني» → the reply shows the Arabic name **and** a proposed
    English spelling, and asks whether it is right.
11. Reply «لا خليه Ali Al Zahrani» → stored as `Ali Al Zahrani` (no Arabic
    prefix) and the **next** question is the national ID.
12. National ID, then date of birth as `2.4.2003` → accepted **once**, no
    "which one?", and the next question is the email.
13. Repeat with `2-4-2003`, `2/4/2003`, `2 أبريل 2003`, `٢ أبريل ٢٠٠٣`,
    `2 Apr 2003` in fresh sessions — each accepted once.
14. Finish the booking → confirmation summary **before** any write, then
    «اه» → the reply says it is a **request awaiting clinic confirmation**.
15. Keep talking after the booking → the conversation continues.
16. Patients screen → the pending intake's Review dialog shows the Arabic and
    English names, each in its own direction.
17. Approve it → the new patient's header shows both names; search by the old
    canonical name still finds them.
18. Edit an **existing** patient created before this pass → both fields render
    empty, saving with them empty changes nothing.
19. Settings → Packages → Add: pick a department → the Service dropdown lists
    **only** that department's active services.
20. Pick a service → Price/session fills from the service's current price and
    the service's own regular price is shown beside it.
21. Sessions = 10 → Total = 10 × price. Change price/session to 90 → Total 900.
22. Type 850 into Total, then change Sessions → Total stays 850.
23. Change the department → the service selection clears.
24. Save with **no** service → succeeds, and the package behaves exactly as
    before.
25. Settings → Services → confirm the service's own price is **unchanged**.
26. Ask the assistant «باكيدج <name> بكام؟» → the package names its service and
    the service's regular price, with **no** invented saving.
27. «عايز أكلم موظف» → hands off. «عايز أعمل ملف لشخص تاني» → does **not**.
