# P11H — Booking write commit and operational visibility fix

**Date:** 2026-08-27  
**Scope:** patient-reply → booking authority → intake staging → preliminary booking → database entity → staff queues → notification/audit  
**Status:** fixed and validated locally  
**Verdict:** **SAFE TO PUSH** (do not deploy until the additive migration is applied in the normal release sequence)

Nothing was pushed or deployed. No remote database write was performed. The new migration was applied only to the local Supabase/Postgres stack.

---

## 1. Executive finding

The reported symptom was real and was not one UI bug. It was one missing commit-truth boundary plus two independent downstream visibility gaps:

1. `register_patient` and `create_preliminary_booking` returned structured results, but the final assistant sentence was only checked for doctor-name grounding. It was never checked against the intake/booking write result. A model could therefore say “created/booked/sent” after a skipped or failed write.
2. The P11G authority contract classified the intake rung as conversational and did not force `register_patient`. That is incomplete: collecting values is conversational; staging them is an authoritative write. In the third-party flow, the safe identity-isolation design intentionally does not persist the child/friend’s personal fields into the sender’s `ai_collected_data`, so a missed staging call left no intake row and no later server latch that could move the flow to a real booking commit.
3. Third-party/new-patient booking correctly creates `ai_appointment_requests`, not `appointments`, but the dashboard card queried only `appointments`. A successful provisional write was invisible there.
4. Both booking RPCs wrote audit events but neither path created an in-app staff notification. Notification absence was independent of whether the entity write succeeded.

The fix makes the entity returned by the authoritative server write the only source of patient-facing success copy, forces intake staging at its ladder rung without requiring the model to fabricate missing arguments, makes both pending entity types visible, and transactionally notifies active admins/receptionists after either booking entity is inserted.

---

## 2. Evidence available for the manually tested run

The local Supabase stack was initially stopped. After starting it, the newest booking audit metadata in the local database was dated 2026-08-24 and belonged to test fixtures, not the 2026-08-27 manual localhost conversation. The checkout’s ordinary application URL is configured to a non-local Supabase project while separate `LOCAL_SUPABASE_*` values point at the local test stack. Remote private audit access was not authorized, so the exact manual conversation row/tool payload could not be read without crossing the requested local-only evidence boundary.

Consequently, this report does **not** invent a per-conversation tool result for the manual run. It distinguishes:

- what the manual symptom proves operationally;
- what the source made reachable;
- what was reproduced and proved against real local Postgres after the fix.

The local audit trail did prove the intended third-party path can produce, when actually executed, this sequence:

`AI_PATIENT_INTAKE_STAGED` → `agent_tool:register_patient outcome=staged` → `AI_APPOINTMENT_REQUEST_STAGED` → booking stage `submitted`.

That older fixture evidence does not prove the manual run followed it; the missing manual UI state strongly indicates that it did not complete the same commit sequence.

---

## 3. Exact pre-fix execution path

### 3.1 Patient reply and authority

`runCertifiedPatientAgent` opened the booking turn, created one `GroundingLedger`, ran the model/tool loop, then passed only the final text through `enforcePatientReplyGrounding`.

The ledger recorded tool names and roster entities. It did **not** retain the write result for later success verification. `enforcePatientReplyGrounding` enforced doctor membership only. A booking-success sentence containing a valid previously selected doctor was therefore “grounded” even when no booking entity existed.

P11G correctly forced `create_preliminary_booking` at `confirm`, but it did not verify that:

- the forced tool reached `execute`;
- the returned result had `created: true`;
- an `appointment_id` or `request_id` was returned;
- the final text represented that exact result rather than the model’s preferred outcome.

### 3.2 Intake staging

Before P11H, `resolveBookingAuthority(step="intake")` returned:

```text
requirement = none
operation   = null
reason      = conversational
```

That conflated two acts:

- collecting patient-supplied fields — conversational;
- committing a proposed intake row — an authoritative server write.

`register_patient` also had schema-required name, national ID, date of birth, and email inputs. Forcing it before all values existed would have pressured a tool call to satisfy a schema it could not honestly satisfy, which is why P11G avoided the pin. The missing design was a partial, non-writing result: accept omitted fields at the model boundary, validate below it, and return the exact missing fields without calling the staging RPC.

For third-party identity isolation, `resolveThirdPartyInput` reads and writes no sender conversation memory. This remains correct: a child’s name or DOB must never overwrite the sender’s. The consequence is that a missed `register_patient` call has no safe surrogate persistence. There is no `ai_patient_intakes` row, `intakeStaged` remains false, and `create_preliminary_booking(for_someone_else=true)` correctly returns:

```json
{
  "created": false,
  "reason": "intake_required",
  "needs_intake": true
}
```

Pre-fix, the model could ignore that result—or never call either tool—and still produce success prose.

### 3.3 Booking write and identity

`createPatientPendingBooking` has two authoritative branches:

| Booking subject | Authoritative entity | Identity/status |
|---|---|---|
| linked patient booking for self | `appointments` | real `patient_id`, `status='pending'`, `ai_patient_conversation_id` set |
| unlinked new patient or linked sender booking for another person | `ai_appointment_requests` | `intake_id`, `conversation_id`, `status='pending'`; no patient identity is borrowed |

For a third-party request, the absence of an `appointments` row is therefore expected and required. The appointment is not allowed to be filed under the sender. Operational success is one pending `ai_appointment_requests` row tied to the pending third-party intake.

If intake staging was absent, `createPatientPendingBooking` could not create either entity and returned `intake_required`/`create_failed` through the tool. The bug was that this non-success result did not own the final sentence.

### 3.4 Dashboard and Patients UI

The Patients page already queried:

```text
ai_patient_intakes
  clinic_id = current clinic
  review_status = pending_review
```

and rendered `AiIntakeReviewSection` for authorized reviewers. That surface was not fabricating the absence. If a staged row exists and RLS permits the staff role, it is visible. The real local authenticated-admin test now proves this.

The dashboard appointment card queried only:

```text
appointments
  status = pending
  ai_patient_conversation_id is not null
```

It never queried `ai_appointment_requests`. This was a genuine independent UI/data-source bug for all new-patient and third-party provisional requests.

### 3.5 Notification and event

Both authoritative RPCs already insert durable audit events:

- self booking: `AI_TOOL_CREATE_PRELIMINARY_BOOKING` on `appointments`;
- provisional booking: `AI_APPOINTMENT_REQUEST_STAGED` on `ai_appointment_requests`.

No trigger or application call created a `notifications` row for either entity. The notification absence was therefore not diagnostic of write failure; it was an unimplemented downstream behavior.

---

## 4. Answers to the nine investigation questions

### 1. Did `register_patient` execute and what did it persist?

For the specific manual run, exact tool audit metadata was not available in the local database and remote private audit access was not used. The reported absence from the correctly wired intake-review query means no visible `pending_review` intake existed for that staff viewer. Source analysis shows two reachable explanations: the tool was skipped, or it returned a non-success such as `assignment_required`, `unreadable_fields`, `registration_failed`, or `needs_staff_review` and the model continued in prose.

When successful, it persists one `ai_patient_intakes` row, never a normal `patients` row. P11H now returns that entity as `intake_id` plus `intake: { id, status: 'pending_review', entity: 'ai_patient_intake' }`.

### 2. Did `create_preliminary_booking` execute after confirmation?

The exact manual call cannot be asserted without its audit row. Pre-fix it was structurally possible for final success prose to be emitted without a successful call. If third-party staging was missing, an executed call could only return `created:false, reason:'intake_required'`; it could not create a request under another identity.

P11H makes both intake and confirmation authoritative forced-write rungs and makes their returned result own the final text.

### 3. What was the exact tool/server result?

The exact manual payload is unavailable and is not guessed. The source-defined server outcomes relevant to the observed state are:

- registration skipped: no result/no row;
- registration attempted too early: `registered:false, reason:'assignment_required'`;
- booking without staged third-party intake: `created:false, reason:'intake_required'`;
- successful staging after P11H: returned pending intake entity with `intake_id`;
- successful booking after P11H: returned pending `appointment_id` or `request_id`, expiry, status, scheduled time, and created entity type.

### 4. Was an appointment row created, and with what status/identity?

For third-party booking, a normal appointment row must **not** be created. Success is a pending `ai_appointment_requests` row owned by the staged intake. For self-booking by a linked patient, success is a pending `appointments` row owned by the linked patient. The real local integration suite proves both branches and proves no third-party appointment lands on the sender.

### 5. Could the AI emit success without authoritative write success?

**Yes, before P11H.** The only final-text enforcement was roster grounding. P11G forced calls but treated call execution as sufficient observability and did not bind copy to a validated returned entity.

**No on the fixed write rungs.** P11H retains the raw in-memory tool result, validates the returned entity ID/status/expiry, and replaces all write-turn text deterministically. A skipped, failed, malformed, or entity-less result produces non-success recovery copy. Premature bilingual success claims before a write rung are also rejected.

### 6. Why was the patient/intake record absent from the expected UI?

The normal Patients table never contains a staged AI intake by design. The intake-review section does. Its query was correct. The absence is consistent with no committed `ai_patient_intakes` row (tool skipped or non-success), not with a need to fabricate a normal patient row. P11H forces the staging attempt at the correct rung and requires its returned intake entity before saying it was saved.

### 7. Why was the pending booking absent from the dashboard?

Two reasons could stack:

1. without staged intake, no provisional request could be created;
2. even with a successful provisional request, the dashboard ignored `ai_appointment_requests` and showed only `appointments`.

The dashboard now counts and previews active, unexpired pending rows from both tables. Provisional rows link directly to intake review; normal pending appointments retain their calendar deep link.

### 8. Why was no system notification emitted?

There was no emitter on either patient-assistant booking entity insert. Audit events existed; staff notifications did not. The new local migration installs transaction-level insert triggers for AI pending appointments and provisional requests, fan-out to active non-deleted admins/receptionists, and unread-dedupes by entity.

### 9. One root cause or multiple independent failures?

**Multiple failures:**

- primary integrity failure: success copy was not bound to a returned write entity;
- orchestration failure: intake staging was not an authoritative forced rung;
- dashboard data-source failure: provisional requests were excluded;
- notification gap: no booking-commit notification existed.

The first two explain a nonexistent commit presented as success. The latter two could hide/under-report a genuinely successful provisional commit and therefore required independent fixes.

---

## 5. Fix

### 5.1 Authoritative write receipt

`GroundingLedger` now retains the last raw result for each tool only for the lifetime of the turn. It is not written to audit logs.

New `lib/ai/patient-write-commit.ts` runs before doctor grounding and enforces:

- staged-intake success requires `intake_staged=true` and a returned UUID `intake_id`;
- booking success requires `created=true`, `status='pending'`, an expiry, and a returned UUID `request_id` or `appointment_id`;
- success copy is deterministic and explicitly says pending/staff confirmation;
- staged-intake copy explicitly says the appointment request is **not created yet**;
- every known booking failure maps to accurate non-success copy;
- a missing/malformed receipt maps to non-success copy;
- premature Arabic/English file/booking success claims are rejected before `done`.

The model no longer authors commit success wording. It may understand the patient’s intent; the server result decides what exists.

### 5.2 Intake as a write rung

`resolveBookingAuthority(step='intake')` now returns:

```text
requirement = write_authority
operation   = register_patient
reason      = needs_intake
```

The input schema accepts omitted required personal fields at the model boundary. Validation is unchanged below it; incomplete input returns missing fields and performs no staging RPC. This makes the forced call safe without weakening identity or validation.

After a staged intake, deterministic reply asks for explicit confirmation. The next turn derives `confirm` and forces `create_preliminary_booking`. This deliberately uses two turns because the stage mount is resolved once per inbound turn and must not widen mid-loop.

### 5.3 Returned created entities

Successful registration returns the staged intake entity. Successful preliminary booking returns `created_entity` with ID, entity kind (`appointment` or `ai_appointment_request`), pending status, scheduled instant, and expiry while retaining the existing compatibility fields.

### 5.4 Dashboard visibility

`AiPendingAppointmentsSection` now queries in parallel:

- active unexpired patient-AI `appointments`;
- active unexpired `ai_appointment_requests` with their intake name.

Counts are summed; previews are merged and sorted by scheduled time. A provisional row links to the Patients intake-review target because there is no appointment detail page yet, which is correct for an entity awaiting patient-file approval.

### 5.5 Transactional staff notification

Migration `20260827120000_p11h_booking_commit_visibility_notifications.sql` adds one search-path-pinned `SECURITY DEFINER` trigger function and two narrow insert triggers:

- pending `appointments` carrying `ai_patient_conversation_id`;
- pending `ai_appointment_requests`.

They insert `ai_booking_request` notifications for active, non-deleted clinic admins/receptionists in the same transaction as the booking entity. The existing recipient/clinic composite FK and unread dedupe index remain the enforcement boundaries. The notification contains only source and record ID and uses internal paths.

---

## 6. Preserved invariants

- P11B closed-world department doctor roster remains unchanged; its full suite passes.
- P11C third-party identity remains isolated: the sender appears only as requester, no child/friend data enters the sender’s patient row, and no appointment is filed under the sender.
- P11D/P11F monotonic department → doctor → day → time → intake → confirm ladder remains intact.
- P11G stage-scoped mounts still only narrow; the authority pin cannot mount an unauthorized tool.
- Offered-day and offered-slot guards are unchanged.
- `createPatientPendingBooking` still revalidates live availability, minimum notice, service/doctor validity, pending caps, and identity immediately before the RPC.
- Human takeover, entitlement checks, service-role RPC checks, RLS, tenant isolation, and conversation identity re-resolution remain in place.
- No department, doctor, patient, clinic, date, or slot is hard-coded.
- Automated intake still stages for staff review; it does not create a normal patient.

---

## 7. Regression and integration proof

### New/updated focused coverage

- `tests/unit/ai/p11h-booking-write-commit.test.ts`
  - intake is write authority;
  - staged intake requires returned entity ID;
  - self and third-party pending success require returned entity ID;
  - a success boolean without an entity is failure;
  - failed/skipped writes cannot produce success copy;
  - premature Arabic/English success claims are rejected.
- `tests/unit/integration/p11c-third-party-booking-continuation.test.ts`
  - real registration result returns the real intake ID;
  - authenticated admin RLS sees the pending intake;
  - real provisional result returns the real request ID/entity;
  - persisted pending request equals the returned ID and never uses sender identity;
  - authenticated dashboard-equivalent query sees it;
  - both active staff recipients receive `ai_booking_request` notifications;
  - authenticated recipient RLS sees only its notification;
  - `AI_APPOINTMENT_REQUEST_STAGED` audit event exists for the same entity.
- `tests/unit/integration/p5a-patient-tools-booking.test.ts`
  - real self-booking returns a pending appointment;
  - authenticated dashboard-equivalent query sees it;
  - authenticated recipient sees the transactionally emitted notification.
- dashboard/notification component regression verifies the provisional query/link and localized notification rendering.

### Gate results

| Gate | Result |
|---|---|
| focused P11H/P11G/dashboard unit set | **55 passed** |
| P11B authoritative roster | **27 passed** |
| full non-integration unit suite | **428 files · 4,024 passed · 2 skipped · 0 failed** |
| focused real local Postgres self + third-party | **2 files · 16 passed** |
| full real local Supabase/Postgres integration | **64 files passed · 1 skipped · 646 passed · 3 skipped · 0 failed** |
| adversarial/injection | **136 passed** |
| `pnpm typecheck` | clean |
| `pnpm lint` | 0 errors, 28 pre-existing warnings; none in P11H files |
| `pnpm run lint:i18n` | pass, 455 files |
| `pnpm run lint:rtl` | pass, 748 files |
| `pnpm run i18n:missing` | pass, 4,257 message leaves |
| local `supabase db lint` | no P11H issue; pre-existing warnings plus existing `search_patient_clinic_faq` lint error remain |
| `pnpm build` | production build passed; pre-existing middleware/NFT trace warnings remain |
| `git diff --check` | clean |

One P11B unit fixture used an “on leave now” interval ending 2026-08-26 while one tool-level path uses the real clock. It became false on 2026-08-27. The fixture end was moved forward so both the fixed fixture clock and real clock describe the doctor as currently away; production roster code was not changed.

---

## 8. Migration and release ordering

The migration is additive. It does not alter booking tables, RLS policies, RPC signatures, or existing notification constraints.

Release order:

1. apply `20260827120000_p11h_booking_commit_visibility_notifications.sql`;
2. deploy application code;
3. manually test one self and one third-party booking and verify returned reply, entity ID, dashboard queue, notification, and audit event.

Rollback is dropping the two triggers and trigger function, then reverting application code. Existing booking entities and audit events remain valid.

---

## 9. Remaining limitations

1. The exact 2026-08-27 manual conversation’s audit/tool payload was not available in the local database, and remote private audit access was not used. A post-fix manual replay is still required to attach live-model evidence to this exact conversation shape.
2. A third-party provisional request has no calendar appointment detail because no `appointments` row exists yet. Its dashboard/notification link correctly lands on intake review. Staff approval later creates/promotes the real patient/appointment under the existing P8 workflow.
3. Notification fan-out intentionally targets active admins and receptionists. Managers/doctors are not added because they are not the intake/booking review roles today.
4. Notifications are now transactional with the entity insert; patient-channel appointment messages remain a separate post-approval concern. No premature “confirmed appointment” message is sent for a pending request.
5. The local database linter continues to report pre-existing schema warnings and a pre-existing `search_patient_clinic_faq` extension-resolution error. None reference the P11H function or triggers.

---

## 10. Verdict

**SAFE TO PUSH.**

The critical invariant is now implemented at the final response boundary: a patient/intake or booking success sentence is derived only from a validated authoritative tool result that contains the entity returned by the server. Failure, omission, and malformed success shapes are deterministic non-success paths. Both correct booking entity types are operationally visible under authenticated RLS, and both emit staff notifications and durable audit events. Full unit, local Postgres integration, adversarial, typecheck, lint, i18n/RTL, and production build gates pass.

Nothing was pushed, deployed, or written to a remote database.
