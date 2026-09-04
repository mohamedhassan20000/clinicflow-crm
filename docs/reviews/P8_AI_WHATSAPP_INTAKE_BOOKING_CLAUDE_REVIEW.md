# P8 — AI WhatsApp Patient Intake + Appointment Booking · Independent Review (Claude)

Reviewed: 2026-08-22
Branch: `feat/p7-manual-qa-polish` (feature is uncommitted in the working tree)
Migration under review: `supabase/migrations/20260822120000_ai_patient_intake_booking_upgrade.sql`

Method: read the migration, the AI tool layer, the domain/mutation layer, the review
surfaces, and the pre-existing non-AI patient/appointment flows; replayed the migration
and every new RPC against the **local** Supabase stack inside a rolled-back transaction,
with real `service_role` and `authenticated` JWT claims; ran the unit suite, typecheck,
eslint, i18n parity and the RTL gate.

**Verdict: NOT safe to proceed with the migration.** The staging half works. The human
approval half — `approve_ai_patient_intake` — **fails 100% of the time** for every real
staff caller and has never been executed by any test. Four distinct pre-existing triggers
reject it. Details in B1–B4, all reproduced against a real database.

---

## Test / gate results

| Gate | Result |
|---|---|
| `npm test` (3350 tests) | 3349 pass, **1 fail** — `tests/unit/ai/phase3-action-foundation.test.ts:400`, flaky, unrelated (see B7) |
| Targeted intake/booking tests (139) | pass |
| `npm run typecheck` | clean |
| `npm run lint` | 0 errors, 28 pre-existing warnings |
| `npm run i18n:missing` | clean (4239 leaf messages) |
| `npm run lint:rtl` | clean |
| Migration replay on local Postgres | applies cleanly, no errors |
| **Behavioural replay of `approve_ai_patient_intake`** | **fails in every configuration** |

---

## 1. PASS items

**P1 — No automated actor ever writes `public.patients`.** `stage_patient_intake_from_conversation`
([mig:249-415](supabase/migrations/20260822120000_ai_patient_intake_booking_upgrade.sql#L249-L415))
only inserts into `ai_patient_intakes`. Verified by replay: staging returns
`status='staged'` and `public.patients` stays empty.

**P2 — New-patient data completeness matches the real New Patient form.** `patientSchema`
([lib/validations/patient.ts:7-42](lib/validations/patient.ts#L7-L42)) requires
`full_name, national_id, date_of_birth, phone, email`; `blood_type`,
`department_id`, `assigned_doctor_id`, `insurance_provider_id` are optional. The intake
collects all five required fields plus department and doctor. Approval re-validates through
the *same* `patientCreateSchema` before the RPC
([lib/patients/mutations.ts:87-102](lib/patients/mutations.ts#L87-L102)) — no second,
divergent patient schema. (Caveat: `blood_type`/`insurance_provider_id` cannot be filled at
review time — see M1.)

**P3 — Identity matching is exact; no fuzzy resolver participates.** The auto-link branch
requires *all four* of: exact `patients.phone = conversations.participant_address`, exact
`date_of_birth`, exact `fold_national_id`, exact `fold_patient_name`
([mig:328-345](…#L328-L345)). `fold_*` are deterministic normalizers (Arabic alef/ya/ta-marbuta
variants, digits, case, separators) — **not** distance or phonetic matching. The Levenshtein/
phonetic/transliteration resolver in [lib/ai/entity-resolution.ts](lib/ai/entity-resolution.ts)
is imported **only** by `prepare-booking.ts` (departments and doctors), never by any identity
path. Confirmed by grep: no identity file imports `resolveNamedEntity`.

**P4 — Phone, patient id and clinic are structurally out of the model's reach.**
`register_patient`'s `inputSchema` has no phone and no patient id
([lib/ai/tools/register-patient.ts:57-73](lib/ai/tools/register-patient.ts#L57-L73)); the
RPC derives the phone from `conversations.participant_address`
([mig:311](…#L311)). Clinic comes from verified channel routing via
`authorizePatientConversation`.

**P5 — Non-disclosing failure wording.** `duplicate_review` and `identity_mismatch` collapse
into one identical `needs_staff_review` message
([register-patient.ts:216-226](lib/ai/tools/register-patient.ts#L216-L226)), so the assistant
is not an existence oracle for national ids. Failed attempts increment
`identity_verification_failures` and lock at 5 for 30 minutes ([mig:346-360](…#L346-L360)).

**P6 — Department → doctor selection is DB-constrained end to end.** `prepare_booking` lists
only `is_active`/non-deleted departments, then only `role='doctor'` profiles **in that
department** ([prepare-booking.ts:128-140](lib/ai/tools/prepare-booking.ts#L128-L140)); a
department correction wipes the previously collected doctor ([lines 111-124](lib/ai/tools/prepare-booking.ts#L111-L124));
and staging **re-validates** `p.department_id = p_department_id` server-side
([mig:319-327](…#L319-L327)). A model-invented pairing cannot survive.

**P7 — Existing patient's treating doctor is offered first.** [prepare-booking.ts:44-83](lib/ai/tools/prepare-booking.ts#L44-L83)
returns `assigned_doctor` only when it is active/non-deleted, and the prompt scripts the
exact sentence in both languages ([lib/ai/prompts/patient.ts:45,88](lib/ai/prompts/patient.ts#L45)).

**P8 — Arabic/English input handling is deterministic and refuses to guess.**
[lib/ai/human-input.ts](lib/ai/human-input.ts) folds Arabic-Indic and Extended Arabic-Indic
digits, strips tatweel/diacritics/bidi marks, accepts MSA + Egyptian + Levantine month names,
resolves `12/9/2000` by clinic country (`dateOrderForCountry`) while still reporting the
alternative reading, and returns `ambiguous` rather than picking one. Times accept `5pm`,
`5 م`, `الساعة ٥ العصر`, `٣ ونص`. Names are **not** transliterated or case-folded
(`parseHumanName`). Relative days resolve in the clinic's timezone, not the server's.
Crucially, an unparseable value is refused **before** the rate-limited RPC
([lib/ai/patient-input.ts:60-80](lib/ai/patient-input.ts#L60-L80)), so our own parse failure
can never consume a verification attempt.

**P9 — Tenant isolation.** New tables carry `clinic_id` with composite FKs to
`(id, clinic_id)` on conversations, departments, profiles, patients and appointments — the
companion unique index for `departments` is created by this migration
([mig:44-46](…#L44-L46)); I verified the other four already exist. RLS is enabled with
**select-only** policies gated on `auth_clinic_id()` + role; there is no insert/update policy,
so `authenticated` cannot write these tables directly. All tool-side reads go through
`createClinicScopedAdminClient`, which auto-injects `.eq("clinic_id", …)` for every table
touched here. `authorizePatientConversation` re-checks the clinic/conversation pair after the
RPC returns ([lib/ai/patient-authorization.ts:122-129](lib/ai/patient-authorization.ts#L122-L129)).

**P10 — Availability parity with the staff booking form.** `ai_requested_slot_is_available`
([mig:172-247](…#L172-L247)) blocks on the same status set (`confirmed/arrived/in_session`)
and the same ±15-minute buffer as `computeAvailability`
([lib/booking/availability.ts:57,290-300](lib/booking/availability.ts#L290-L300)), and applies
`doctor_schedules` validity windows, `clinic_working_hours` shifts and `doctor_unavailability`.
Day-of-week derivation matches (`extract(dow)` vs `format "i" % 7`). The application still
re-runs the *full* `computeAvailability` and verifies every 15-minute sub-slot of the requested
duration before calling the RPC ([lib/booking/patient.ts:167-190](lib/booking/patient.ts#L167-L190)).

**P11 — Race-condition revalidation and idempotency on the staging side.**
`create_provisional_ai_appointment_request` takes a clinic-wide advisory lock, then re-checks
availability inside the same transaction ([mig:468-473](…#L468-L473)). `stage_…` takes
`for update` on the conversation and uses `on conflict (clinic_id, conversation_id) do update
… where review_status = 'pending_review'` ([mig:375-397](…#L375-L397)), so a patient correcting
their details restages rather than duplicating. `approve_ai_patient_intake` short-circuits to
`already_processed=true` on a second call ([mig:568-576](…#L568-L576)).

**P12 — AI attribution without a fake user.** `audit_logs.actor_type`/`source` plus the
`classify_audit_actor` trigger ([mig:20-43](…#L20-L43)) record AI events as
`actor_id NULL, actor_type='ai'`, and the human approval as the real profile id with
`source='ai_assistant_review'`. Appointments carry `created_by = NULL` +
`ai_patient_conversation_id`, which both review surfaces render as "AI assistant".

**P13 — Human takeover blocks the assistant.** `refuseIfPaused: true` is set on
`register_patient`, `prepare_booking` and `create_preliminary_booking` (and correctly *not*
on read-only `check_availability`); both new RPCs re-check `ai_paused_at` at the DB boundary,
closing the check-then-write race.

**P14 — Existing non-AI flows are unchanged.** `block_paused_ai_booking_insert` returns
immediately when `ai_patient_conversation_id is null`, so the staff appointment form is
untouched. `createPatientMutation`, the New Patient form, and
`create_patient_preliminary_booking` are not modified. The file-number allocator in the new
approval path takes the *same* `':patient-file-number'` advisory lock as
[lib/patients/mutations.ts:166-190](lib/patients/mutations.ts#L166-L190), so a receptionist and
an approval cannot compute the same `CF-####`.

---

## 2. Bugs / regressions

### B1 — BLOCKER: `approve_ai_patient_intake` always fails. The human approval path has never worked.

The RPC is `security definer`, but `auth.role()` is derived from the **JWT**, not from the
function owner. It therefore runs as `authenticated`, and every pre-existing server-only guard
fires. Reproduced against the local database with a real receptionist claim, in a fresh
transaction, on the happy path (thread open, not paused):

```
### approval as a real staff user, thread NOT paused, status open
ERROR:  PATIENT_AI_IDENTITY_STATE_SERVER_ONLY
CONTEXT: PL/pgSQL function public.protect_patient_ai_identity_state() line 26
SQL statement "update public.conversations c
  set identity_verified_at = clock_timestamp(), …"
PL/pgSQL function public.approve_ai_patient_intake(uuid,uuid) line 89
```

[mig:639-642](…#L639-L642) sets `identity_verified_at` to a non-null value.
`protect_patient_ai_identity_state`
([20260727180000_p5a_patient_tools_booking.sql:45-79](supabase/migrations/20260727180000_p5a_patient_tools_booking.sql#L45-L79))
rejects that for `anon`/`authenticated`; its only escape hatch requires
`new.identity_verified_at is null`. This statement is unconditional and runs **before** any
appointment handling, so approval fails even for an intake with no booking attached. No
patient row is ever created — the whole transaction rolls back.

With that trigger disabled to expose what lies behind it, the appointment insert
([mig:663-671](…#L663-L671)) fails next:

```
### HAPPY PATH: open, not paused
ERROR:  AI_BOOKING_METADATA_SERVER_ONLY
CONTEXT: PL/pgSQL function public.protect_ai_booking_metadata() line 8
```

`protect_ai_booking_metadata`
([20260727200000_p5a_review_fixes.sql:4-20](supabase/migrations/20260727200000_p5a_review_fixes.sql#L4-L20))
forbids an `authenticated` caller from inserting an appointment with
`ai_patient_conversation_id` (or `expires_at`) set.

So there are **two** independent hard stops on the single happy path, plus B2 and B3 below.

### B2 — BLOCKER: taking the thread over makes the intake unapprovable.

`block_paused_ai_booking_insert` ([mig:524-540](…#L524-L540)) rejects *any* appointment insert
carrying `ai_patient_conversation_id` while `ai_paused_at` is set — including the one issued by
`approve_ai_patient_intake` on behalf of a human receptionist. Reproduced:

```
### staff took the thread over, then approves
ERROR:  HUMAN_TAKEOVER_ACTIVE
CONTEXT: PL/pgSQL function public.block_paused_ai_booking_insert() line 7
… PL/pgSQL function public.approve_ai_patient_intake(uuid,uuid) line 113
```

Taking the conversation over is the *normal* thing a receptionist does before reviewing an
intake, and the review dialog links straight to `/inbox?conversation=…`. The guard is correct
for the AI path and wrong for the approval path; it needs to distinguish them.

### B3 — BLOCKER: closing/resolving the thread makes the intake unapprovable.

`enforce_ai_pending_booking_policy`
([20260727180000_p5a_patient_tools_booking.sql:233-246](supabase/migrations/20260727180000_p5a_patient_tools_booking.sql#L233-L246))
requires `conversations.status = 'open'` for any appointment with `ai_patient_conversation_id`.
Reproduced:

```
### thread resolved/closed by staff, not paused
ERROR:  AI_BOOKING_CONVERSATION_IDENTITY_MISMATCH
CONTEXT: PL/pgSQL function public.enforce_ai_pending_booking_policy() line 19
```

The same trigger also enforces `v_patient_pending >= 1` — so if the phone-matched existing
patient already has one active AI pending appointment, approval aborts **entirely** instead of
skipping just the appointment.

### B4 — HIGH: an expired appointment request permanently bricks re-booking.

Nothing ever transitions an expired `ai_appointment_requests` row out of `status='pending'` —
there is no sweeper, no cron, and `lib/ai/retention.ts` does not mention these tables. The
guard at [mig:477-482](…#L477-L482) only counts rows with `expires_at > now()`, so it passes;
the insert then hits the partial unique index
`ai_appointment_requests_one_active_intake` ([mig:139-141](…#L139-L141)). Reproduced:

```
### force the request to be expired, then try to book again
ERROR:  duplicate key value violates unique constraint "ai_appointment_requests_one_active_intake"
DETAIL:  Key (clinic_id, intake_id)=(…) already exists.
```

The raw 23505 falls through `bookingFailure`
([lib/booking/patient.ts:120-143](lib/booking/patient.ts#L120-L143)) to `create_failed`, and the
assistant tells the patient "the slot could not be booked" forever. The dashboard also filters
on `expires_at > now()` ([ai-pending-appointments-section.tsx:33](components/dashboard/ai-pending-appointments-section.tsx#L33)),
so the blocking row is invisible to staff.

### B5 — MEDIUM: approval lowercases and strips the national id.

`stage_…` stores `public.fold_national_id(p_national_id)` in `ai_patient_intakes.national_id`
([mig:387](…#L387)), and `approve_…` copies that value straight into `patients.national_id`
([mig:625-632](…#L625-L632)). Verified: `ABC123456` → `abc123456`. The New Patient form and the
legacy `register_patient_from_conversation` both store what was typed. National ids appear on
printed documents; this is a silent fidelity loss unique to the AI path. The folded value
belongs in a separate comparison column, not in the stored one.

### B6 — LOW: `duration_minutes` crossing midnight is mis-evaluated.

[mig:214-217](…#L214-L217) compares `(v_local + make_interval(mins => p_duration_minutes))::time`
against `s.end_time`. Casting to `time` wraps past midnight, so a 23:45 + 30 min request yields
`00:15`, which compares as *earlier* than `end_time`. Practically unreachable (no clinic
schedules to midnight), but the check should be done in minutes-from-midnight.

### B7 — LOW, pre-existing, unrelated: flaky forged-token test.

[tests/unit/ai/phase3-action-foundation.test.ts:393](tests/unit/ai/phase3-action-foundation.test.ts#L393)
forges a token as `token.slice(0, -1) + "A"`. When the real token already ends in `A` the
"forged" token *is* the real token and the action executes. Failed once in the full run, passed
3/3 on re-run. Not caused by this feature; worth fixing while nearby.

---

## 3. Security / data-integrity issues

### S1 — HIGH: the legacy auto-registration RPC is still live and still granted.

`public.register_patient_from_conversation`
([20260818120000:1266-1580](supabase/migrations/20260818120000_p8_whatsapp_history_takeover_attachments.sql#L1266))
creates a real `public.patients` row with **no human review** and is still
`grant execute … to service_role`. This migration does not drop it, and
[lib/supabase/admin.ts:1251-1267](lib/supabase/admin.ts#L1251-L1267) still exports
`registerPatientFromConversation` (now unreferenced outside tests). The headline invariant —
"no automated actor inserts into `public.patients`" — is currently enforced only by the
convention that nobody calls it.

### S2 — MEDIUM: the new RPCs skip the entitlement check their sibling performs.

`create_patient_preliminary_booking` verifies `effective_ai_feature(ai_assistant /
ai.patient_suggest / ai.scheduling)` at the DB boundary
([20260727180000:528-534](supabase/migrations/20260727180000_p5a_patient_tools_booking.sql#L528-L534)).
Neither `stage_patient_intake_from_conversation` nor
`create_provisional_ai_appointment_request` does. Entitlement is enforced only in
`authorizePatientConversation`. Same trust boundary, weaker guarantee — an asymmetry a future
caller will trip over.

### S3 — MEDIUM: `ai_appointment_requests.service_id` has no foreign key.

[mig:105](…#L105) declares `service_id uuid` with no FK and no tenant-composite constraint —
the only other nullable-reference column in either new table without one. Validity is checked
once inside the RPC ([mig:459-465](…#L459-L465)); a service deleted afterwards leaves a dangling
id that is copied verbatim into `appointments.service_id` at approval.

### S4 — LOW: approval failures are indistinguishable to staff.

`approveAiPatientIntake` collapses every RPC error into `aiIntakeReviewFailed`
([actions/ai-patient-intakes.ts:24-26](actions/ai-patient-intakes.ts#L24-L26)). `INTAKE_
DUPLICATE_REVIEW_REQUIRED`, `INTAKE_ASSIGNMENT_STALE`, `HUMAN_TAKEOVER_ACTIVE` and the B1–B3
errors all render the same toast. A receptionist cannot tell "this is a duplicate, check it"
from "the doctor was deactivated" from "this is broken".

### S5 — LOW: a rejected intake permanently bars re-registration on that thread.

`ai_patient_intakes_conversation_unique` is unconditional ([mig:93-94](…#L93-L94)) while the
`on conflict do update` is guarded by `review_status = 'pending_review'`
([mig:396](…#L396)). After a rejection the same sender can never stage again on that
conversation — even if the rejection was a mistake — and the tool tells the model
`registration_failed / do not retry`. If intentional, it needs a staff escape hatch.

### S6 — LOW: `date_of_birth` upper bound uses server `current_date`.

[mig:315](…#L315) bounds the DOB with `current_date` (database UTC) rather than the clinic
timezone; `parseDateOfBirth` uses UTC too. Off-by-one-day at the boundary for clinics east of UTC.

---

## 4. Missing requirements

**M1 — The reviewer cannot correct or complete the intake before approving.**
[components/patients/ai-intake-review-section.tsx](components/patients/ai-intake-review-section.tsx)
is read-only: view, approve, reject. A typo in the name, a wrong department, or the optional
`blood_type` / `insurance_provider_id` from the New Patient form cannot be set at review time,
and — per S5 — rejecting to re-collect bricks the thread. This is the single largest gap versus
"provisional AI patient staging and human approval".

**M2 — No expiry sweeper for `ai_appointment_requests`.** Root cause of B4. `expired` is a
declared status ([mig:110](…#L110)) that only `approve_…` ever writes. There is no cron under
`app/api/cron/` and no coverage in `lib/ai/retention.ts`.

**M3 — No behavioural test for any new RPC.**
`tests/unit/db/ai-patient-intake-booking-upgrade-migration.test.ts` is pure substring matching
on the migration text — it asserts `migration.toContain("function public.approve_ai_patient_intake")`
and never executes it. That is why B1–B4 shipped through a green suite. There is no
`tests/unit/integration/*-rls.test.ts` for this feature, unlike every prior phase.

**M4 — `dismissed` is unreachable.** `ai_patient_intakes.review_status` allows `'dismissed'`
([mig:63](…#L63)) but nothing writes it.

**M5 — Stale doc reference.** [lib/ai/tools/register-patient.ts:39](lib/ai/tools/register-patient.ts#L39)
still says the identity rules "live in `register_patient_from_conversation`". They live in
`stage_patient_intake_from_conversation`.

**M6 — Dashboard row degrades silently for managers/assistants.**
`ai_appointment_requests` is readable by `manager` and `assistant`
([mig:157-169](…#L157-L169)) but `ai_patient_intakes` is not
([mig:145-153](…#L145-L153)), so the `intake:…(full_name)` join returns null and the row renders
`unknownPatient`. Either widen the intake read policy to name-only, or hide provisional rows
from roles that cannot resolve them.

---

## 5. Exact fixes required

Ordered. **1–4 are release blockers.**

1. **Make `approve_ai_patient_intake` executable by staff.** (B1)
   In `supabase/migrations/20260822120000_…sql`, the definer function must present as a
   server actor for the duration of its guarded writes. Wrap the body's guarded statements in
   `set local request.jwt.claims` restoration, or — cleaner and consistent with the codebase —
   add an explicit bypass to both guards:
   - `protect_patient_ai_identity_state()` (`20260727180000:45-79`): allow the transition when
     a session-local marker such as `current_setting('clinicflow.intake_approval', true) = 'on'`
     is set, and set/reset that marker around [mig:635-646].
   - `protect_ai_booking_metadata()` (`20260727200000:4-20`): same bypass around the insert at
     [mig:663-671].
   Re-verify with the replay in this review: approval must return
   `(patient_id, appointment_id, false)` for an `authenticated` receptionist claim.

2. **Let the approval path through the takeover guard.** (B2)
   `block_paused_ai_booking_insert()` at [mig:524-540] must not fire for the human approval
   insert. Gate it on the same marker as fix 1, or on `auth.role() = 'service_role'` — the guard
   exists to stop the *assistant*, and the assistant is the only service-role writer.

3. **Do not require an open conversation to approve.** (B3)
   `enforce_ai_pending_booking_policy()` (`20260727180000:233-246`) — relax the
   `status = 'open'` requirement (and the `v_patient_pending >= 1` cap) for the approval marker.
   Alternatively, make [mig:650-676] degrade instead of abort: on any appointment-insert
   failure, mark the request `expired` and still approve the patient. The patient file must
   never be lost because the appointment could not be created.

4. **Sweep or re-use expired requests.** (B4)
   Either add `and r.status = 'pending'` handling at [mig:477-482] that first flips stale rows —
   `update public.ai_appointment_requests set status='expired', updated_at=clock_timestamp()
   where clinic_id=p_clinic_id and intake_id=v_intake.id and status='pending'
   and expires_at <= clock_timestamp();` immediately before the insert — or change the partial
   index at [mig:139-141] to also require non-expiry (needs an immutable predicate, so the
   in-function sweep is the practical fix). Add a cron sweeper for the dashboard's benefit (M2).

5. **Preserve the national id as typed.** (B5)
   At [mig:387] store `btrim(p_national_id)` in `ai_patient_intakes.national_id` and add a
   separate `national_id_folded` column (or a generated column) for the comparisons at
   [mig:334-336] and [mig:600-606]. `approve_…` at [mig:625-632] must insert the unfolded value.

6. **Drop the superseded auto-registration path.** (S1)
   Add `drop function if exists public.register_patient_from_conversation(uuid, uuid, text, text,
   date, text);` to the new migration; delete `registerPatientFromConversation` from
   `lib/supabase/admin.ts:1251-1267`; migrate or delete the ~12 call sites in
   `tests/unit/integration/p8-whatsapp-history-attachments.test.ts:865-1160`.

7. **Add the DB-boundary entitlement check.** (S2)
   Copy the three `effective_ai_feature` checks from `20260727180000:528-534` into
   `stage_patient_intake_from_conversation` [mig:284] and
   `create_provisional_ai_appointment_request` [mig:444].

8. **Constrain `service_id`.** (S3)
   At [mig:105] add
   `constraint ai_appointment_requests_service_clinic_fkey foreign key (service_id, clinic_id)
   references public.services(id, clinic_id) on delete restrict` (verify the companion unique
   index on `services` first).

9. **Surface real approval failures.** (S4)
   Map the RPC error strings in `actions/ai-patient-intakes.ts:24-26` and
   `lib/patients/mutations.ts:113-121` to distinct message keys; add them to `messages/*.json`.

10. **Add an editable review step.** (M1)
    Extend `components/patients/ai-intake-review-section.tsx` to prefill the existing patient
    form fields (including `blood_type` and `insurance_provider_id`) and pass corrected values
    to `approveAiPatientIntakeMutation`, which already validates through `patientCreateSchema`.
    Pair with an intake-reopen path so a rejection is recoverable (S5).

11. **Write behavioural tests.** (M3)
    Add `tests/unit/integration/p8-ai-intake-booking-rls.test.ts` covering, against a real
    database: staging as `service_role`; the four exact-match identity outcomes; approval by a
    receptionist on an open thread, a paused thread and a closed thread; re-booking after
    request expiry; approval idempotency; and cross-tenant read denial. Any one of these would
    have caught B1–B4.

12. **Minor.** Fix the midnight cast at [mig:214-217] (B6); de-flake
    `tests/unit/ai/phase3-action-foundation.test.ts:393` by regenerating the forged token until
    it differs (B7); correct the comment at `lib/ai/tools/register-patient.ts:39` (M5); remove
    or use `'dismissed'` at [mig:63] (M4); handle the manager/assistant join at
    `components/dashboard/ai-pending-appointments-section.tsx:28-35` (M6); use the clinic
    timezone for the DOB bound at [mig:315] (S6).

---

## Recommendation

**Do not apply this migration yet.** The staging half (P1–P14) is well built and the security
posture of the AI-facing side is sound — exact identity matching, no fuzzy resolution, no
patient row without a human, correct tenant scoping, real availability. But the human approval
half is non-functional: `approve_ai_patient_intake` cannot complete for any staff user, so
every staged intake would accumulate unapprovable and every provisional appointment would
expire unbooked. Ship after fixes 1–4, with the behavioural tests from fix 11 proving them.

---

## FIXED — 2026-08-22

This section records the local fix and supersedes the original verdict above. No migration was
applied remotely and nothing was deployed. The WhatsApp connection, media, and history stack
was not changed.

### Root cause and exact fix for each release blocker

#### B1 — authenticated staff approval hit server-only identity and booking-metadata guards

**Root cause.** `approve_ai_patient_intake` correctly authenticated the receptionist/admin at
entry, but `SECURITY DEFINER` does not change `auth.role()`: the guarded statements still saw
the caller's `authenticated` JWT. `protect_patient_ai_identity_state()` rejected the identity
stamp and, after that was bypassed during reproduction, `protect_ai_booking_metadata()`
rejected the AI conversation/expiry metadata on the pending appointment.

**Fix.** The migration now establishes a transaction-local approval capability only after the
RPC has verified `p_actor_id = auth.uid()`, the actor's admin/receptionist role, the actor's
clinic, and a locked pending intake. `ai_intake_approval_context_matches()` accepts that
capability only when all of the following agree:

- the current statement executes as the owner of `approve_ai_patient_intake`;
- the local intake and actor markers parse as UUIDs;
- the marker actor is the JWT user and is still an active, non-deleted admin/receptionist;
- the marker intake is still pending and owns the exact clinic/conversation being written.

The approval ID/actor markers are transaction-local and restored before the intake is marked
approved. The identity and booking-metadata triggers keep their original errors for every
ordinary caller and allow only this owner-bound reviewed transaction. The booking guard
override preserves the later Phase 4 `ai_action_receipt_id` protections and receipt validation;
the existing action-booking integration suite proves that provenance surface was not regressed.

#### B2 — takeover/AI pause blocked the human reviewer

**Root cause.** `block_paused_ai_booking_insert()` treated every appointment carrying
`ai_patient_conversation_id` as an automated write, including the appointment inserted by a
real receptionist after taking over the thread.

**Fix.** The trigger still raises `HUMAN_TAKEOVER_ACTIVE` for the assistant and every normal
writer. It permits only the exact approval capability above. Approval does not clear
`ai_paused_at`, resume AI, or otherwise alter takeover state.

#### B3 — closed conversations and the existing-patient cap rolled back approval

**Root cause.** `enforce_ai_pending_booking_policy()` unconditionally required an open
conversation for every conversation-attributed AI appointment. Its patient pending cap also
raised inside the same approval transaction, rolling back the already reviewed patient and
conversation work.

**Fix.** The open-conversation predicate is relaxed only for the owner-bound approval context;
the conversation must still exist in the same clinic, be linked to the same patient, and use
`created_by = NULL`. Approval never reopens the thread. The one-active-AI-pending-booking cap
is not weakened: approval takes the existing P5A advisory lock and checks all three current AI
origins (`ai_patient_conversation_id`, legacy workflow provenance, and `ai_action_receipt_id`).
If the patient already has an active AI pending booking, only the provisional request becomes
`dismissed`; patient creation/promotion and conversation/intake linkage still commit. A slot
claimed after staging is handled the same way for unique/exclusion conflicts rather than
rolling back the patient.

#### B4 — expired request remained `pending` and held the partial unique index forever

**Root cause.** Booking visibility and cap queries treated `expires_at <= now()` as inactive,
but `ai_appointment_requests_one_active_intake` keys only on `status = 'pending'`. No code
transitioned the stale row before the next insert, so the invisible row still caused SQLSTATE
23505.

**Fix.** While holding the intake-booking advisory lock,
`create_provisional_ai_appointment_request` now transitions the intake's stale pending request
to `expired` before availability/cap checks and before the replacement insert. A bounded,
`FOR UPDATE SKIP LOCKED`, service-role-only `expire_ai_appointment_requests` RPC provides the
maintenance path. The existing daily booking-expiry job now runs both appointment expiry and
provisional-request expiry. Dashboard and booking code agree on the active definition:
`status = 'pending' AND expires_at > now()`.

### Other required invariant fixes

#### Superseded auto-registration RPC

`register_patient_from_conversation(uuid, uuid, text, text, date, text)` is dropped by the new
migration. Its service wrapper was removed from `lib/supabase/admin.ts`, its generated RPC type
was removed, the old integration callers were replaced, and live PostgREST coverage asserts
`PGRST202`. The rule "AI never creates a normal patient without staff review" is therefore a
database/API invariant rather than a convention.

#### National ID fidelity

`ai_patient_intakes.national_id` now stores `btrim(p_national_id)` without lowercasing or
separator folding. `national_id_folded` is a stored generated comparison key and is used only
for matching. Approval copies the original intake value into `patients.national_id`. The live
happy path proves `AbC123456` remains exactly `AbC123456` in both rows.

### Tests proving the real happy path and regressions

`tests/unit/integration/p8-ai-intake-booking-rls.test.ts` runs against the real local Supabase
API with real signed-in users and proves:

- a real authenticated receptionist approves a staged intake after staff takeover and after
  the conversation is closed;
- the patient is created once with the reviewed department, assigned doctor, original national
  ID, real receptionist `created_by`, and conversation-derived phone;
- one pending appointment is created with `created_by = NULL`, linked to the request and
  conversation, and attributed to the selected department/doctor;
- the conversation is manually linked while `status = 'closed'` and the original
  `ai_paused_at` value remain unchanged;
- the intake becomes approved with the real reviewer and patient;
- repeated approval returns the same patient/appointment with `already_processed = true` and
  creates no duplicate patient;
- a real authenticated admin claim can also approve;
- forced expiry followed by rebooking changes the first request to `expired`, creates a new
  visible pending request, and never emits the partial-index error;
- the maintenance RPC expires stale requests and the dashboard-equivalent query hides them;
- ordinary authenticated callers cannot mutate identity state; and
- the obsolete auto-registration RPC is unreachable.

Verification completed locally:

| Gate | Result after fix |
|---|---|
| Full migration replay inside `BEGIN` / `ROLLBACK` | pass |
| New real approval/expiry/obsolete-RPC integration suite | **5/5 pass** |
| Intake + action-receipt booking suites together | **10/10 pass** |
| Relevant DB/RPC, patient/appointment, WhatsApp regression, and RLS/security suites | **77 pass, 3 intentional skips** |
| Expanded focused migration/AI/patient/appointment/security unit set | **109/109 pass** |
| Full non-integration `pnpm test` | pass |
| `pnpm typecheck` | pass |
| `pnpm lint` | **0 errors, 28 pre-existing warnings** |
| `pnpm i18n:missing` | pass — 4,239 message leaves |
| `pnpm lint:rtl` | pass — 713 files, 17 documented exceptions |
| `pnpm build` | pass — production `BUILD_ID` generated |

The four original raw errors — `PATIENT_AI_IDENTITY_STATE_SERVER_ONLY`,
`AI_BOOKING_METADATA_SERVER_ONLY`, `HUMAN_TAKEOVER_ACTIVE`, and
`AI_BOOKING_CONVERSATION_IDENTITY_MISMATCH` — do not occur on the real paused/closed approval
path.

### Remaining risks (not release blockers for this fix)

- The review UI is still read-only; correcting optional/incorrect intake fields before approval
  remains M1.
- The DB-boundary entitlement asymmetry (S2), composite `service_id` constraint (S3), detailed
  staff-facing error mapping (S4), rejected-intake reopen behavior (S5), clinic-local DOB date
  boundary (S6), manager/assistant provisional-name policy mismatch (M6), and the low-risk
  midnight duration calculation (B6) remain unchanged.
- The daily expiry path is bounded to 500 rows per call. `SKIP LOCKED` makes concurrent runs
  safe, but a backlog larger than one batch relies on subsequent scheduled runs.
- Verification was local only by instruction. No remote migration or deployment validation was
  performed.

### Final verdict

**SAFE TO PUSH.** The reproduced approval, takeover, closed-thread, booking-metadata, expiry,
obsolete-RPC, and national-ID blockers are fixed with scoped capabilities and live database
coverage. Existing identity/provenance guards and the action-receipt booking path remain intact.
