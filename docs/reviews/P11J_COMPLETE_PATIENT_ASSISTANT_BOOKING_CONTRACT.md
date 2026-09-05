# P11J — Complete Patient Assistant Booking Contract

Date: 2026-08-28

Scope: patient/WhatsApp assistant, patient booking, intake review, appointment lookup, patient-facing clinic facts, and staff visibility

Remote policy: hosted data was inspected read-only; no remote write, push, deployment, or remote migration was performed.

## Executive result

The patient assistant now has a server-owned, forward-only booking path from subject selection through a receipt-validated pending write. The manual Arabic time failure was fixed at the commit boundary rather than by special-casing `9 الصبح`. Patient-facing clinic lists are rendered from current tool receipts, booking identity remains separate from clinical identity, third-party intake remains isolated from the sender, and provisional intake/booking records have exact staff review links.

The contract is structural:

- Clinic facts originate in clinic-scoped live reads, not prompt constants.
- A doctor, department, service, price, day, or time can be presented only from the current server receipt or the server-owned offer state derived from it.
- A valid offered selection is persisted before the next authority decision.
- Success copy is replaced by deterministic copy from a validated persisted-entity receipt.
- Every AI booking remains `pending` and explicitly awaits human confirmation.
- Existing patient matching links the existing file; it does not create a duplicate.
- New and third-party patients are staged in `ai_patient_intakes` for human review.

## 1. Exact root causes found

### Read-only production trace

The reported conversation was traced read-only in the hosted project before code changes. The decisive turn contained the exact input `الساعه ٩ الصبح` after a real slot list had been offered.

Observed state and audit facts:

- The latest offered slots belonged to 2026-08-31 and contained the intended 09:00 slot.
- The legacy collected appointment date still contained 2026-08-23, showing that different state layers had diverged.
- No selected appointment time was committed.
- The following authority continued to choose `check_availability`.
- There was no successful `register_patient` or `create_preliminary_booking` write receipt.
- The booking stage never reached `submitted`.
- Repeated availability reads therefore reproduced the time question instead of progressing.

No hosted row was changed during this investigation.

### Root cause A — selected time was not committed before authority

The deterministic continuation path resolved the natural reply, but authority for the turn had already been derived from the previous state. A uniquely resolved slot could therefore be known locally while the next operation still saw the `time` rung as incomplete.

### Root cause B — incompatible time representation

One path attempted to persist `"09:00"`, while the closed collected-state parser accepts appointment time as integer clinic-local minutes. The value was discarded on the next parse, so the booking appeared to move forward for part of a turn and then moved backward.

### Root cause C — persistence failure was treated as best effort

Several state writes did not stop advancement when the server rejected or failed the update. That allowed the reply layer and the next-step layer to disagree about which facts actually existed.

### Root cause D — booking identity gates still followed clinical identity in key tools

The weaker, booking-only identity architecture already existed, but booking entry tools still depended on the older linked/verified assumptions. This could request date of birth for a pending booking even though name confirmation, or exact name plus national ID from another number, is the intended booking boundary.

### Root cause E — third-party intake was isolated but not durably accumulated

Third-party values were intentionally excluded from the sender's ordinary collected data, but that left multi-message intake dependent on model transcript memory. It also allowed the linked sender's phone to become an unsafe fallback where the actual patient schema requires the other person's phone.

### Root cause F — read presentation was model-shaped

The tools returned authoritative arrays, but the final model could collapse doctors, departments, services, days, and times into horizontal prose, omit prices, or allow a read result to displace a write result from the same turn.

### Root cause G — staff links stopped at a generic review surface

Pending appointments had staff visibility, but provisional intake-backed requests linked to the Patients page generally rather than the actual intake row. Intake creation also lacked its own staff notification trigger.

## 2. Current booking architecture after the fix

The current path is:

1. A verified channel route supplies `clinicId` and `conversationId`; the model never supplies a patient ID.
2. `authorizePatientConversation` resolves the clinic-scoped patient context, booking stage, collected state, booking identity, communication style, and human-takeover state.
3. The server derives the current booking stage and the one authoritative operation for the turn.
4. The selected tool performs a clinic-scoped live read or certified pending write.
5. Every read/write result is recorded in the per-turn grounding ledger.
6. A valid offered doctor/day/time is committed to closed server-owned state before authority is re-derived.
7. `enforcePatientFactReply` owns complete factual list presentation.
8. `enforcePatientWriteReply` owns intake and booking success/failure copy.
9. Audit records store outcomes and entity scope without copying patient-entered identity fields into logs.

The model remains responsible for natural conversation and intent selection. It is not the owner of clinic facts, selected offers, authorization, or write success.

## 3. Existing-patient path

### Linked WhatsApp number

- The assistant asks naturally whether the sender is the stored patient name.
- `confirm_booking_identity` with no personal arguments confirms booking-only identity.
- Availability and pending booking can proceed.
- Date-of-birth verification is not set and clinical/record disclosure remains locked.

### Different phone

- The assistant asks only for full name and national/civil ID.
- `identify_patient_for_booking` performs normalized exact server matching within the clinic.
- All failures use the same `no_match` response; neither name nor ID existence is disclosed.
- One live match attaches the existing patient for booking and skips registration fields.
- The booking-only attempt counter and lockout remain enforced.

### Duplicate prevention

`register_patient` still checks the existing-patient route before any intake creation. Exact existing matches reuse the existing record, linked senders cannot register themselves again, and integration tests prove no second patient row is created.

## 4. New-patient path

- Department and doctor are resolved from live clinic records.
- Intake fields follow the current patient-create validation path rather than a prompt-only schema.
- Natural Arabic/English date input, Arabic digits, punctuation variants, and clinic-country ambiguity rules flow through the existing human-input parsers.
- A pending clarification retains the proposed parsed value; a yes/no confirmation commits that value instead of asking the field again.
- Optional blood type is carried into the approval mutation instead of being dropped.
- Arabic original names remain preserved; uncertain Latin spelling still requires explicit confirmation.
- The result is an `ai_patient_intakes` row with `pending_review`, not an silently finalized normal patient.
- Once the intake is staged, the preserved booking target can continue to the pending appointment-request write.

## 5. Third-party path

The booking-for-other latch is established at booking opening and is never inferred from the sender's patient record.

The closed booking-stage JSON now contains an isolated `thirdPartyIntake` draft:

- full name
- national ID
- date of birth
- email
- the third party's own phone
- blood type
- name-spelling confirmation

This draft is accumulated across messages, parsed against a closed shape, and never merged into the sender's general collected patient data. The sender's stored fields and phone cannot satisfy the third-party draft. The draft is cleared after a successful staged intake. Certified booking then targets the staged intake, never the sender's patient ID.

## 6. Services and prices

`list_department_services` reads active live departments and all configured service rows with clinic scope. It supports:

- no department: returns the live department choice and the Arabic question `تحب تعرف خدمات أنهي قسم؟`;
- one department: returns that department's complete service list;
- `all_departments`: returns every live department with its services;
- pagination beyond the former 80-row ceiling;
- service name and configured price together;
- localized “price unavailable/contact clinic” text when no price exists.

`enforcePatientFactReply` creates one `service — price currency` line per service and a separate block per department. The same newline text is sent to WhatsApp and stored/rendered by the ClinicFlow Inbox.

## 7. Directory, contact, and insurance sources

- Departments: `list_clinic_departments` / the live clinic directory; current booking selection cannot narrow the answer.
- Doctors: live `profiles` with doctor role, correct department, active/not deleted, and current leave/unavailability filtering.
- Contact: `get_clinic_info` reads clinic name, address, phone, website, and clinic working-hours configuration.
- Insurance: `list_clinic_insurance` reads configured insurance providers and returns no coverage/co-pay guess.
- Services/prices: live `services`, department-scoped.

Directory, insurance, and service reads are available as side questions at every booking stage. They do not mutate booking state. Complete receipt-backed lists replace model-shaped lists.

## 8. Booking state ownership

The conversation row is the durable owner of booking progress:

- `collected_data`: closed normalized facts such as selected department, doctor, date, and time-in-minutes;
- `booking_stage`: stage latches, offered doctor roster, offered days, offered slots, appointment lookup draft, and isolated third-party draft.

Offer lists are server facts, not model memory. Ordinal, first-name, day-number, and natural-time resolution all prefer the exact roster/day/slot last offered. State writes are checked; a rejected write cannot advance authority. Explicit changes clear only the downstream facts they invalidate.

## 9. Time and date resolution

- Natural time replies such as `9`, `9 الصبح`, `الساعة 9`, `09:00`, `تسعة ونص`, and `3 العصر` resolve against the offered slot set first.
- A unique match is committed as integer minutes, for example 09:00 → `540`.
- The commit happens before the next authority operation is selected.
- A failed commit returns controlled recovery and does not advance.
- Unrelated text or a side question is never interpreted as time.
- Day numbers resolve against the offered dates; relative dates use the clinic timezone.
- Dates are rendered with stable ISO plus localized weekday/month text.
- Times are rendered with stable 24-hour value plus localized 12-hour period text.

The exact manual phrase now advances from time selection to the intake/write operation without another availability call.

## 10. Pending-write receipt contract

`create_preliminary_booking` now returns a receipt that identifies:

- the persisted entity and ID;
- `pending` status;
- booking-subject kind and subject ID;
- doctor ID and name;
- department ID and name;
- clinic-local date and time;
- canonical timestamp and expiry.

`enforcePatientWriteReply` accepts success only when the outer result and nested entity agree on those fields. Missing IDs, non-pending status, mismatched subject, missing doctor/department, invalid local datetime, or missing expiry produces failure/recovery copy. A model success sentence without this receipt is replaced. A read receipt can never replace a write receipt on the same turn.

The final copy always says the request is pending human confirmation. No AI path creates or claims a confirmed appointment.

## 11. Intake, dashboard, and notification visibility

- Pending intakes remain visible in the Patients AI-intake review table.
- The dashboard provisional request query now includes the related intake ID.
- Dashboard intake links use `/patients?review=1&intake=<intake-id>#ai-intakes`.
- The Patients page scrolls to the exact row, focuses it, and opens its controlled review dialog.
- Existing real pending appointment links continue to target the exact appointment/calendar record.
- A new `ai_patient_intake` notification is emitted to active, non-deleted admin/manager/receptionist reviewers.
- Provisional booking notifications point at the exact related intake row.
- Existing notification click behavior marks the notification read before navigation.
- Database triggers run only after a successful authoritative insert; failed/skipped writes emit nothing.

The React review pass kept URL-derived dialog initialization out of effects; the effect only synchronizes DOM scroll/focus, avoiding a cascading render and preserving keyboard focus behavior.

## 12. Formatting

The receipt-owned renderer guarantees vertical presentation:

- departments: one item per line;
- doctors: one numbered doctor per line;
- services/prices: one pair per line;
- days: one localized date per line;
- times: one localized time per line.

Fallback grounding text was also changed from comma-separated lists to newline lists. Clinic-configured language/register/tone continues to apply to conversational copy.

## 13. Appointment lookup

Appointment lookup is separate from registration and clinical verification:

- inputs are only full name and national ID;
- either half may arrive first and is held in isolated server appointment-lookup state;
- the sender's linked patient ID is never a fallback;
- one exact live match returns appointment date, time, doctor, department/service, and status;
- date/time are clinic-local and patient-readable;
- no match uses one generic response;
- lookup does not set clinical identity and cannot unlock clinical fields, cancellation, or record data.

## 14. Loop-prevention invariant

Booking progress is monotonic over the settled facts:

`subject → identity → department → doctor → day → time → intake/write → submitted`

A valid persisted answer moves forward. A step can move backward only when:

- the patient explicitly changes an upstream choice;
- the chosen doctor is no longer eligible;
- the chosen slot is no longer available or violates the 24-hour rule;
- the server rejects persistence;
- a real ambiguity requires one clarification.

Even then, only invalid downstream state is cleared. Side questions and closing acknowledgements never restart booking. Bare closings require no booking tool, and a completed closing does not reopen intake.

## 15. Files changed for P11J

### Booking, identity, state, and presentation

- `lib/ai/patient-authorization.ts`
- `lib/ai/patient-tools.ts`
- `lib/ai/booking-stage-store.ts`
- `lib/ai/booking-stage.ts`
- `lib/ai/patient-roster-continuation.ts`
- `lib/ai/patient-fact-reply.ts` (new)
- `lib/ai/patient-grounding.ts`
- `lib/ai/patient-reply.ts`
- `lib/ai/patient-write-commit.ts`
- `lib/ai/clinic-directory.ts`
- `lib/ai/turn-briefing.ts`
- `lib/ai/prompts/patient.ts`
- `lib/ai/tools/prepare-booking.ts`
- `lib/ai/tools/list-available-days.ts`
- `lib/ai/tools/create-preliminary-booking.ts`
- `lib/ai/tools/list-department-services.ts`
- `lib/ai/tools/lookup-appointment.ts`
- `lib/ai/tools/register-patient.ts`
- `lib/patients/mutations.ts`

### Staff visibility

- `lib/navigation/ai-review-targets.ts`
- `components/dashboard/ai-pending-appointments-section.tsx`
- `components/patients/ai-intake-review-section.tsx`
- `components/notifications/notifications-list.tsx`
- `lib/notifications/emit.ts`
- `messages/en.json`
- `messages/ar.json`

### Migration

- `supabase/migrations/20260828120000_p11j_exact_ai_review_notifications.sql` (new)

### Principal regression coverage

- `tests/unit/ai/p11j-booking-time-precommit.test.ts` (new)
- P9/P10/P11 booking, identity, intake, grounding, and write-commit suites updated where the contract changed.
- `tests/unit/components/p10-inbox-dashboard-notifications.test.tsx`
- `tests/unit/db/p11j-exact-ai-review-notifications-migration.test.ts` (new)
- P9/P11 local-Postgres integration fixtures updated for required third-party phone, localized lookup fields, and exact links.

No WhatsApp QR, linked-device session, provider, media, voice, or history-transport implementation was changed for P11J.

## 16. Migration status

`20260828120000_p11j_exact_ai_review_notifications.sql` is additive and local only. It was genuinely required because the existing provisional booking notification had no exact intake-row target and intake creation had no notification of its own.

The migration:

- replaces the existing booking-notification function with exact links;
- adds a security-definer intake-notification function;
- adds an after-insert trigger for `pending_review` intakes;
- limits recipients to active, non-deleted authorized roles;
- uses dedupe keys and the existing unread uniqueness rule;
- revokes function execution from public client roles.

It was applied successfully to the local Supabase database and exercised by the full integration suite. It was not applied to the hosted database.

## 17. Test and validation results

| Gate | Result |
|---|---:|
| Exact booking/intake regressions | 165 passed |
| P11/P11B–P11I unit lineage | 361 passed |
| Full patient/staff AI unit directory | 1,862 passed, 2 declared skips |
| Focused UI + P11J migration contract | 20 passed |
| Adversarial/injection suite | 136 passed |
| Full real local Postgres integration | 650 passed, 3 declared skips; 65 files passed, 1 skipped |
| TypeScript | passed |
| ESLint | passed with 0 errors and 28 pre-existing warnings |
| i18n gate | passed; 455 files scanned |
| RTL logical-property gate | passed; 751 files scanned |
| Production Next.js build | passed; 84 static pages generated |
| `git diff --check` | passed |

Expected non-failing diagnostics:

- Integration/unit fixtures log Supabase's multiple-GoTrueClient browser-context warning.
- The production build warns about the existing middleware-to-proxy deprecation and an existing broad NFT trace under document PDF fonts.
- ESLint reports 28 existing warnings outside this change, with zero errors.

## 18. Thirty-case regression matrix

| # | Contract case | Structural/test evidence |
|---:|---|---|
| 1 | Existing patient self booking | booking-only identity plus pending booking in P8/P9/P11 integration |
| 2 | Existing patient from different phone | exact name+ID `confirm_booking_identity`; generic no-match and clinical isolation tests |
| 3 | New patient booking | registration/intake unit path and P9 real-Postgres pending flow |
| 4 | Third-party/child booking | P9C/P11C isolated draft and real-Postgres target assertions |
| 5 | Department side question mid-booking | P11I directory authority preserves booking state |
| 6 | Insurance side question mid-booking | P10 live-settings insurance tests and stage-independent read mounting |
| 7 | Services/prices mid-booking | P10/P11 generic services continuation and P11J receipt renderer |
| 8 | Arabic dates including `24,3,2001` | human-input/collected-state date parser variants |
| 9 | Yes/no carries proposed DOB | pending-clarification/collected-state confirmation tests |
| 10 | Doctor by first name | P11D unit and P11 generic real-Postgres first-name resolution |
| 11 | Doctor ordinal | offered-order unit coverage and real-Postgres ordinal resolution |
| 12 | Day number | offered-day guard and P9 real-Postgres bare-day continuation |
| 13 | Natural time | exact `الساعه ٩ الصبح` replay plus Arabic natural-time parser tests |
| 14 | 24-hour rejection | no-write/stored-phone test and P11F controlled time-rung recovery |
| 15 | Doctor unavailable mid-flow | P11D/P11F revalidation and controlled doctor reselection |
| 16 | Slot unavailable mid-flow | P11F drops exactly to day/time re-selection, not doctor/department |
| 17 | Write failure cannot produce success | P11H missing/failed/malformed receipt enforcement |
| 18 | Intake visible in review UI | component exact-row/dialog test plus authenticated P11C integration query |
| 19 | Pending appointment visible in dashboard | P11H/P11C dashboard-equivalent pending query and component test |
| 20 | Notification created | migration unit test and P11C transactional notification integration |
| 21 | Lookup with name+national ID only | P11 lookup unit and real-Postgres identity-isolation suite |
| 22 | Closing does not reopen | P10 closure corpus and P11G no-authority-on-closing tests |
| 23 | 3 / 20 / 100 departments | P11I unit and real-Postgres complete-directory cardinality tests |
| 24 | Newly added department/doctor/service | P11/P11C live row creation/rename/move/service tests with no source edit |
| 25 | Services/prices line formatting | P11J deterministic renderer snapshots/assertions |
| 26 | Days/times line formatting | P11J localized vertical renderer assertions |
| 27 | No phantom doctor/service/price/time | P11 grounding, offered-set guards, and live-directory integration |
| 28 | No duplicate existing patient | registration match tests and P11C/P9 integration row-count assertions |
| 29 | No re-asking established fields | P11D/P11F forward-progress and missing-only intake tests |
| 30 | No backward transition without reason | P11F monotonicity corpus plus rejected-persistence regression |

## 19. Remaining limitations

- No hosted write, migration, deployment, or live WhatsApp send was performed; production behavior therefore still requires the normal reviewed deployment/migration process.
- The repository already contains a very large unrelated dirty worktree. P11J files are not isolated in a clean commit, so a push of the entire working tree cannot be reviewed as one coherent change.
- The full browser E2E suite was not part of the requested gate list. Exact-link behavior is covered at component level and against real local Postgres, but not through a launched browser session.
- Existing ESLint/build warnings described above were not widened into unrelated cleanup.

## 20. Push verdict

**NOT SAFE TO PUSH AS THE CURRENT WHOLE WORKTREE.**

This is not a booking-contract failure: P11J's structural boundaries and requested gates pass. The operational blocker is change isolation. The shared worktree contains hundreds of pre-existing modified and untracked files unrelated to this task, so pushing it wholesale would mix P11J with unreviewed work and violate the requested no-push boundary.

Before a future push, isolate and review the P11J file set, include the additive migration in the deployment plan, and rerun the same gates from that clean commit. No remote action was taken here.

---

# P11J-2 — New Patient Intake Contract (raw field-name leakage)

Date: 2026-08-28

Scope: new-patient intake inside the patient/WhatsApp booking flow — the field contract, the patient-facing language layer, DOB parsing, duplicate prevention, and the no-loop invariant.

Remote policy: hosted data was inspected read-only. No remote write, push, deployment, or remote migration was performed.

## 1. Exact root cause

The leak was **not** the model. It was deterministic server copy.

`enforcePatientWriteReply` (`lib/ai/patient-write-commit.ts`) is the P11H write boundary: on any turn whose authority rung is a write, it *replaces* the model's sentence with copy derived from the tool receipt. Its registration-failure branch read the `fields` array returned by `register_patient` — a machine-facing list of schema keys — and joined it straight into the patient's message:

```ts
const fieldText = fields.length > 0 ? ` (${fields.join(", ")})` : "";
// → "أحتاج تصحيح أو استكمال البيانات التالية فقط (national_id, date_of_birth, phone)."
```

That single line explains both halves of the reported failure:

1. **The identifiers.** `national_id`, `date_of_birth` and `phone` were printed verbatim because nothing translated them.
2. **The repetition.** Because this copy is the *enforced* boundary reply, it overwrote whatever the model wrote on every write-rung turn. The patient therefore saw the same inventory each time instead of a question they could answer, and the model's own (correct) phrasing never reached them.

Two contributing weaknesses were found alongside it and fixed:

- `turn-briefing.ts` kept a **second** field-label map, whose fallback was `?? field` — the raw identifier — for any field it had no entry for, and which had already drifted from the patient-facing wording (`الرقم القومي` vs `رقم الهوية`).
- `describeCollectedData` in `collected-state.ts` wrote raw keys (`national_id: …`) into the model's own prompt on every turn. Model-facing, so not the leak itself, but every raw identifier put in front of a model is one it can echo.

## 2. The actual New Patient form/schema

Authoritative sources, both inspected rather than assumed:

- `lib/validations/patient.ts` → `patientSchema`, which `lib/patients/mutations.ts` wraps as `patientCreateSchema`. This is the exact schema the ClinicFlow New Patient form and the human intake-approval path use.
- `supabase/migrations/20260822120000_ai_patient_intake_booking_upgrade.sql` → the `ai_patient_intakes` staging table the AI writes to.

| Field | `patientCreateSchema` | `ai_patient_intakes` |
|---|---|---|
| `full_name` | required, 2–100 chars | `not null`, 2–100 |
| `national_id` | required, 5–32, alphanumeric | `not null` |
| `date_of_birth` | required, `YYYY-MM-DD`, 1900 → today | `not null`, `>= 1900-01-01` |
| `email` | **required**, must be a valid address | **`not null`** |
| `phone` | **required**, must normalize to E.164 | **`not null`** |
| `blood_type` | optional, nullable, 8-value enum | nullable |
| `department_id` | optional, nullable uuid | **`not null`** |
| `assigned_doctor_id` / `doctor_id` | optional, nullable uuid | **`not null`** |
| `insurance_provider_id` | optional, nullable uuid | not collected by AI |

### Differences from the brief, explained rather than silently applied

The brief asked for full name, national id, date of birth, department and doctor as required, with phone and blood type optional. The live schema differs in two places, and in both the schema was followed:

- **`email` is genuinely required** and was not in the brief. It is `.email()` with no `.optional()` on `patientCreateSchema` *and* `not null` on the staging table. Dropping it would fail the write, so it is collected. Making it optional is a schema/migration decision, not an assistant one, and was not taken.
- **`phone` is genuinely required**, contradicting "optional" in the brief. The reconciliation is that it is required *and never asked of the sender*: the staging RPC takes the sender's number from the verified WhatsApp conversation participant, so the assistant has no reason to ask and asking would invite an unproved number. For a **third party** there is no channel to take it from, so it is asked and required. The contract models this as two separate properties — `isRequiredIntakeField` and `isAskableIntakeField` — rather than mislabelling a required column "optional".
- **Department and doctor** are optional on the patient record but `not null` on the staging row, so they are required for this flow. They are already chosen during booking and are read from conversation state, never asked twice.

Net patient-facing contract:

- **Required:** full name, national ID, date of birth, email, department, doctor (+ phone for a third party).
- **Optional and skippable:** blood type.
- **Required but never asked:** the sender's own phone.

## 3. Required vs optional, derived rather than declared

`lib/ai/patient-intake-contract.ts` is the new single source of truth. It does **not** restate the field list:

```ts
export function requiredByPatientSchema(field: IntakeField): boolean {
  const shape = patientSchema.shape as Record<string, { isOptional(): boolean }>;
  const entry = shape[PATIENT_SCHEMA_KEY[field]];
  return entry ? !entry.isOptional() : false;
}

export function isRequiredIntakeField(field: IntakeField): boolean {
  return requiredByPatientSchema(field) || requiredByIntakeStaging(field);
}
```

If someone makes `email` optional on the New Patient form tomorrow, the assistant stops requiring it with no edit to this module. A unit test asserts the derivation matches the union rather than a hand-written list, and a second test parses `patientCreateSchema` directly to confirm an email-less payload is still rejected.

## 4. Intake question flow

`buildIntakeQuestion(fields, locale, { subject })` reorders the outstanding fields into asking order (identity → contact → assignment → optional), drops anything not askable for that subject, and emits **one natural question covering at most two items**. Three at once is a form.

| Field | Arabic | English |
|---|---|---|
| Full name | ممكن الاسم الكامل؟ | Could I have the full name, please? |
| National ID | تمام، ورقم الهوية؟ | And the National ID, please? |
| Date of birth | تاريخ الميلاد كام؟ | What is the date of birth? |
| Email | وإيه الإيميل؟ | And what is the email address? |
| Department | تحب الملف يكون تابع لأنهي قسم؟ | Which department should the file be under? |
| Doctor | ومن دكاترة القسم، تحب تختار مين؟ | And which of the department's doctors would you like? |
| Phone (third party) | وإيه رقم الموبايل بتاعه؟ | And what is their phone number? |
| Blood type (optional) | فصيلة الدم لو تعرفها؟ ودي اختيارية. | Your blood type, if you know it? That one is optional. |

Optional fields say so out loud, so `مش عارف` / `تخطي` / `skip` is obviously allowed. Skipping cannot block: `blood_type` is resolved separately in `register-patient.ts`, an unreadable value is dropped rather than reported missing, and it never appears in the unreadable-fields gate.

Department and doctor are read from `identity.collectedData` and are never re-asked once the booking flow has set them; the `assignment_required` branch only fires when neither has been chosen, and now asks as a question. Values collected earlier survive department → doctor → day → time → intake → pending request through `ai_collected_data` (sender) and the isolated `thirdPartyIntake` stage draft (third party).

## 5. Raw-field leakage prevention

Four layers, in order:

1. **Deterministic copy no longer builds identifier lists.** `patient-write-commit.ts` calls `buildIntakeQuestion` for a missing-data outcome and `patientFacingFieldList` for a contradiction. `fields.join(", ")` is gone.
2. **The tool carries the safe wording.** `register_patient` now returns `patient_question` (already localized, already identifier-free) and `patient_facing_details` alongside the internal `fields`, with guidance stating that `fields` are schema identifiers and must never be written to a patient.
3. **One label layer.** `patient-intake-contract.ts` owns the only Arabic/English field-name map. `turn-briefing.ts` delegates to it, and the fallback for an unlabelled field is a neutral phrase (`the required detail` / `البيان المطلوب`) — never the identifier. `describeCollectedData` now uses labels too.
4. **An outbound scrubber, as a last resort.** `scrubInternalFieldNames` runs in `patient-reply.ts` on every generated, regenerated and server-composed reply, immediately before the register check. Any snake_case identifier is replaced with its label or removed with its parenthetical; bare `phone`/`email`/`gender` count as leaks in Arabic copy or when they appear beside another identifier, so correct English prose such as "your phone number" is untouched. Every sanitization emits one `patient_field_language` audit line carrying identifier names only.

The prompt was also given an explicit rule, in both languages: never write an internal field name; never list what is missing — ask for it.

## 6. DOB parsing

Already flexible, and verified rather than assumed. `parseDateOfBirth` → `parseHumanDate` (`lib/ai/human-input.ts`) accepts `,` `/` `-` `.` and the Arabic comma as separators, Arabic-Indic digits, and Arabic/English month names on either side of the number. Confirmed by test for `24,3,2001`, `24/3/2001`, `24-3-2001`, `24.3.2001`, `24 مارس 2001`, `٢٤/٣/٢٠٠١`, `March 24 2001` and `2001-03-24`, all normalizing to `2001-03-24` before the write.

Confirmation is handled by `collected-state.ts`: with a value already established, a bare affirmation (`اه`, `ايوه`, `صح`, `تمام`, `yes`, …) resolves to that value rather than re-opening the question. Tested for all four of the forms named in the brief. Nothing re-asks a committed date.

## 7. Duplicate-patient prevention

Unchanged, and confirmed still exact rather than fuzzy. Identity is decided inside `stage_patient_intake_from_conversation` in one transaction — not in TypeScript, and not by the model:

- `linked_existing` → the conversation is linked to the existing record; nothing is staged and no intake questions are asked.
- `duplicate_review` / `identity_mismatch` / `duplicate_ambiguous` → nothing is created and the decision goes to staff. The patient-facing wording for all three is deliberately identical and names no field, so the assistant cannot be used as an existence oracle for a national ID.
- No fuzzy entity resolver participates. `national_id_folded` is a deterministic generated column, not a similarity match.

## 8. No-loop invariant

New: `BookingStageState.intakeAsk` — the sorted, comma-joined signature of the last intake question and a consecutive-repeat counter. Field keys only; nothing the patient wrote, so no PHI enters the stage column, and the parser rejects any signature that is not `[a-z_]+(,[a-z_]+)*`.

On each unreadable-fields outcome the signature is compared with the previous turn's. The third identical ask returns `intake_repeated_question` instead: the assistant stops asking, says in one sentence that clinic staff will finish the file, and names no field. Any readable answer clears the latch, so a valid answer always either commits and moves on, asks one sharper clarification, or completes.

## 9. Tests and results

New:

- `tests/unit/ai/p11j2-new-patient-intake-contract.test.ts` — 35 tests. Schema-derived requirements (including both brief mismatches), the askable/skippable split, question generation in both languages, the single label layer, the exact leaked sentence reproduced and scrubbed, the four DOB confirmation forms, all eight DOB input formats, and the `intakeAsk` round trip.
- `tests/unit/ai/p11j2-new-patient-intake-flow.test.ts` — 18 tests (9 × Arabic and English). The full failing conversation: booking details already selected → intake needed → question not list → department/doctor never re-asked → `24,3,2001` normalized to `2001-03-24` → blood type skipped without a loop → staged only on the server's returned `intake_id` → pending request created against the same doctor/day/time → loop guard hands off → existing patient linked instead of duplicated → no field named on a staff-review outcome.

Both suites assert directly that patient-visible output contains none of `national_id`, `date_of_birth`, `phone`, `blood_type`, `department_id`, `doctor_id`, `missing_fields`, nor any snake_case identifier at all.

Updated: `tests/unit/ai/p10-whatsapp-device-regressions.test.ts` — the briefing's English labels are now the consolidated patient-facing ones (`National ID, Email address`), which is the intended consequence of removing the duplicate label map.

Results:

```
npx tsc --noEmit                              clean
npx eslint <changed files>                    clean
npx vitest run --exclude tests/unit/integration/**
  Test Files  433 passed (433)
  Tests       4124 passed | 2 skipped (4126)
```

The 68 `tests/unit/integration/**` files remain env-gated on a local Supabase (`LOCAL_SUPABASE_*` unset here) and were not run. That gating is pre-existing and unrelated to this change.

P11B–P11J behaviour is preserved: authoritative clinic data, generic departments/doctors, monotonic booking, write receipts, human review, dashboard visibility, notifications, no phantom doctors, no invented availability and third-party isolation all pass unchanged.

## 10. Migration status

**No migration.** None was necessary and none was written.

`intakeAsk` is a new key inside the existing `conversations.ai_booking_stage` `jsonb` column, whose only constraint is `jsonb_typeof(...) = 'object' and pg_column_size(...) <= 4096`. There is no key whitelist, the signature is capped at 160 characters, and the addition is a few dozen bytes against a 4 KB bound. Old rows without the key parse to `intakeAsk: null`, and rows written by this code are read correctly by the previous version, which ignores the key. Forward- and backward-compatible.

No change to `patients`, `ai_patient_intakes`, `patientCreateSchema`, or any RPC.

## 11. Push verdict

**NOT SAFE TO PUSH AS THE CURRENT WHOLE WORKTREE** — unchanged from P11J §20, and for the same reason.

The P11J-2 change itself is complete and green: typecheck clean, lint clean, 4124 unit tests passing, no migration, no remote write, no deploy. The blocker remains change isolation — the shared worktree still contains hundreds of pre-existing modified and untracked files unrelated to this task, so a wholesale push would mix this work with unreviewed changes.

The P11J-2 file set, safe to review and push as an isolated commit:

```
lib/ai/patient-intake-contract.ts            (new)
lib/ai/patient-write-commit.ts
lib/ai/patient-reply.ts
lib/ai/tools/register-patient.ts
lib/ai/turn-briefing.ts
lib/ai/collected-state.ts
lib/ai/booking-stage.ts
lib/ai/booking-stage-store.ts
lib/ai/prompts/patient.ts
tests/unit/ai/p11j2-new-patient-intake-contract.test.ts   (new)
tests/unit/ai/p11j2-new-patient-intake-flow.test.ts       (new)
tests/unit/ai/p10-whatsapp-device-regressions.test.ts
docs/reviews/P11J_COMPLETE_PATIENT_ASSISTANT_BOOKING_CONTRACT.md
```

No remote action was taken.
