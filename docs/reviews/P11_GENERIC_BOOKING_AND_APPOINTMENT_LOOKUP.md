# P11 — Generic booking engine, grounded presentation, appointment lookup

Branch: `feat/p7-manual-qa-polish` · Local only. Nothing deployed, nothing pushed,
remote database untouched.

---

## 1. Why arbitrary departments could fail to enter the flow

Two independent causes, both in `lib/ai/entity-resolution.ts`, and both a
consequence of the same design decision: the concept-alias pass **substituted**
the normalized text instead of adding to it.

**Collision.** Two real departments whose names map to one concept became
mutually unresolvable *by their own literal names*. A clinic with
`General Medicine`, `Internal Medicine` and `Family Medicine` — an ordinary
configuration — collapsed all three onto `generalmedicine`, so typing
"Internal Medicine" exactly returned `ambiguous`, forever. Same for
`Nutrition` beside `Diet Clinic`, and `Physical Therapy` beside
`Rehabilitation` (where "علاج طبيعي" silently resolved to Rehabilitation).

**Erasure.** A department name the table did not cover, addressed by a word the
table did cover, was rewritten *away from itself*. A department stored as
`الأسنان` normalized to `alasnan`; the patient's `اسنان` was rewritten to
`dentistry`; the two no longer resembled each other at all → `not_found`, for
an exact Arabic match. The definite article was stripped for the alias lookup
but not for the stored token, so the two sides normalized differently.

A third, structural cause sat above both:
`AI_PATIENT_STAGE_ORCHESTRATION` defaulted to `shadow`, so
`openBookingStageTurn` derived, persisted and traced the stage and then handed
the agent `null`. The model therefore ran with a flat tool mount and the whole
~4,000-token prompt, and every rule about *what happens next in a booking* was
a sentence competing for attention rather than a tool that was absent. A
department could resolve correctly and the conversation still not move on to
that department's roster, because nothing structural required it to.

Measured before the fix (real resolver, no mocks):

| clinic departments | patient typed | result |
|---|---|---|
| General / Internal / Family Medicine | `internal medicine` | ambiguous (all three, score 1.0) |
| Nutrition, Diet Clinic | `nutrition` | ambiguous |
| Physical Therapy, Rehabilitation | `علاج طبيعي` | **Rehabilitation** |
| الجلدية, العلاج الطبيعي, الأسنان, الباطنة | `اسنان` | not_found |

All four are correct after the change.

## 2. Where "Dr. Fatima Khalil" came from

Traced through the whole path: incoming message → intent → state → mounted tool
→ tool args → query → tool result → model response.

The **queries are not the source.** `loadDoctorDirectory` is clinic-scoped
through `createClinicScopedAdminClient` (which injects `clinic_id` on every
select), filters `role = 'doctor'`, and `availableDoctorsInDepartment` filters
to one `department_id`, `state === "available"` (active, not soft-deleted, not
on leave *in force now*). The mocked suite is filter-faithful and the
integration suite runs the same code against real Postgres; both agree. That
name is not in the repository either — no prompt, no fixture, no seed.

That leaves two real channels, and both are now closed:

1. **The model wrote it.** Nothing between `agent.generate()` and
   `sendMessage()` compared the reply against the tool results. Removing doctor
   names from the certified prompt in P10 removed one source of plausible names
   and left every other one — sixteen messages of history, the model's own
   pre-training, and the pull of a list that "should" have more than one entry.
   A prompt rule is a request; there was no check.

2. **The tool handed it over.** `resolveDoctorName` widens to the *whole clinic*
   when nothing in the chosen department matches, and its ambiguous-with-one-
   candidate branch promoted a score as low as 0.58 into a definite
   `other_department` doctor, whose name then travelled in the tool result
   beside the roster. Non-name strings reached that resolver routinely, because
   `isOtherDoctorsRequest`'s Arabic patterns were written with `\b` — which
   never matches between Arabic letters — so "في دكاترة غيره؟", "مين تاني؟" and
   "الدكاترة المتاحين" were scored against real doctor names instead of being
   recognised as requests for the roster.

## 3. Why the P10 fix did not prevent it

P10 addressed *supply* (no names in the prompt) and not *containment*. The
final patient-visible string was still unconstrained free text, and the failure
mode is additive: the model does not need a name from the prompt to produce
one. §16 of this phase is that containment.

## 4. How any current or future department now works

The engine reads the clinic's own rows on every turn and branches on no name:

- **Resolution is literal-first.** `resolveNamedEntity` scores each candidate
  twice — `literalScore` (the name as stored, plus an article-stripped variant,
  plus a phonetic skeleton and a fuzzy token-containment rule so "قسم جاما"
  reaches "Gamma Suite") and `conceptScore` (a Jaccard over cross-language
  concept keys). The result is the **maximum**, and the literal score is the
  tie-break. The lexicon can lift a pair the letters cannot connect; it can
  never rewrite, veto, or shadow a clinic's real name.
- **Stage-scoped orchestration is on by default**, so `selecting_department`
  mounts `prepare_booking`/`list_doctors` and the department-selection prompt,
  and the transition to the roster is structural. `shadow` and `off` remain,
  unchanged, as rollbacks.
- Department change now clears the doctor **and** the day and time, so a new
  booking cannot inherit half of a completed one.
- `list_department_services` records the department it resolved when the
  conversation had not settled one, so "ايه الخدمات؟ → جلدية → عايز احجز" does
  not ask again — and does *not* move a booking that had already settled one.

## 5. How the roster is made authoritative

- `assertRosterAuthority(directory, departmentId, offered)` throws if any
  offered doctor is outside `availableDoctorsInDepartment`. It runs inside
  `departmentDoctorsPayload`, which every patient-facing roster goes through.
  It is a throw, not a filter, so a dropped `.eq("department_id", …)` fails a
  test instead of silently returning a bigger list.
- The wide name search no longer promotes a single weak out-of-department match
  into a named doctor; it returns `unknown` and costs one clarifying question.
- `isOtherDoctorsRequest` now uses Unicode-letter boundaries, so Arabic roster
  requests never reach the name resolver.
- **The presentation contract** (`lib/ai/patient-grounding.ts` +
  `lib/ai/patient-reply-grounding.ts`): every tool result is walked into a
  per-turn ledger of server-returned entities; after generation the reply is
  checked by two detectors — every *real* staff name in the clinic that was not
  offered (exact, catches a bare "1. Fatima Khalil"), and any name written
  after a doctor title that matches nothing offered (catches pure invention).
  A violation regenerates once, **tool-free**, with the true roster in the
  instruction; a second failure sends a sentence composed from the roster
  itself. Conversational style is preserved; entity membership is not
  negotiable.

## 6. Appointment lookup

`lookup_appointment` (stage-independent) asks for **full name + national id and
nothing else**, and calls the new
`lookup_patient_appointments_by_identity(clinic, conversation, name, id)`:

- folds both values with the same `fold_patient_name` / `fold_national_id` the
  booking identification uses; both must select **one** live patient;
- **never reads `conversations.patient_id`** — there is no such branch — so a
  fallback to the sender, to a previous booking target, or to a previous result
  is impossible rather than merely discouraged;
- returns date, time, doctor, department, service, status. Nothing else;
- every failure is the same `no_match`: unknown name, unknown id, an id
  belonging to somebody else, a name with a different id, two matches;
- rate-limited on the same counter as the DOB check; five failures lock for 30
  minutes; unreadable input costs no attempt;
- **links nothing and verifies nothing** — no `patient_id`, no
  `patient_link_status`, no `booking_identity_confirmed_at`, no
  `identity_verified_at`. On success it resets the attempt counter and writes
  nothing else.

## 7. Security boundary

Unchanged and re-asserted by test. `authorizePatientConversation({ requireVerified: true })`
reads `identity_verified_at` and only that; nothing in this phase writes it.
A successful appointment lookup therefore leaves `list_my_appointments`,
`cancel_my_appointment` and every clinical path exactly as denied as before —
proved directly in `p11-appointment-lookup-identity.test.ts`.

## 8. Files changed

| file | change |
|---|---|
| `lib/ai/entity-resolution.ts` | literal + concept scoring, literal tie-break, article variant, phonetic `j→g`, soft token containment |
| `lib/ai/doctor-directory.ts` | Unicode word boundaries, `assertRosterAuthority`, stricter widening |
| `lib/ai/patient-grounding.ts` | **new** — ledger, detectors, correction, deterministic reply |
| `lib/ai/patient-reply-grounding.ts` | **new** — server-side enforcement and repair loop |
| `lib/ai/patient-reply.ts` | ledger creation, tool-free repair generation |
| `lib/ai/patient-agent.ts`, `lib/ai/patient-tools.ts`, `lib/ai/patient-authorization.ts` | thread the ledger through the tool context |
| `lib/ai/booking-stage-store.ts` | default orchestration `on` |
| `lib/ai/booking-stage.ts` | `lookup_appointment` stage-independent |
| `lib/ai/tools/prepare-booking.ts` | clear day/time on department change |
| `lib/ai/tools/list-department-services.ts` | record a first-time department |
| `lib/ai/tools/lookup-appointment.ts` | **new** |
| `lib/ai/prompts/patient.ts` | appointment-lookup + grounding sections (EN/AR), inside `HEAD` so every stage carries them |
| `lib/supabase/admin.ts`, `types/database.ts` | RPC wrapper and types |

## 9. Migration

`supabase/migrations/20260825120000_p11_appointment_lookup_by_identity.sql` —
additive: one new function, no drops, no signature changes, no narrowing.
Compatible with the applied chain through `20260824120000`. Applied to the
local database only (`supabase db reset --local`, clean).

## 10. Results

| suite | result |
|---|---|
| `npm test` (415 files) | 3669 passed, 2 skipped |
| `npm run test:integration` (63 files, real Postgres) | 613 passed, 3 skipped |
| `npm run test:ai-adversarial` | 136 passed |
| `p11-generic-multi-department-booking` (real Postgres) | 17 passed |
| `p11-appointment-lookup-identity` (real Postgres) | 18 passed |
| `p11-generic-department-booking` (filter-faithful mocks) | 21 passed |
| `p11-grounded-presentation` / `p11-grounding-enforcement` | 18 / 7 passed |
| `p11-appointment-lookup` | 12 passed |
| typecheck · eslint · i18n · RTL · build | clean (28 pre-existing warnings, 0 errors) |

## 11. Remaining limitation

The grounding check's second detector is deliberately conservative: a titled
span containing an ordinary word is treated as prose, so a fully invented name
buried mid-sentence ("الدكتور المتاح كمان هو نادية شوقي") is not caught by it.
The exact detector still catches every *real* staff name, which is the reported
failure. Tuning that trade-off wants live traffic — one real WhatsApp session
per configured department, plus one "عايز أعرف ميعادي" against a real file, is
the outstanding manual check.
