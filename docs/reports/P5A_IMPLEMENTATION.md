# P5A — Patient Tools & Booking Hardening

**Date:** 2026-07-27  
**Branch:** `feat/p5a-patient-tools-booking`  
**Status:** Implemented and validated. P5B remains unstarted.  
**Roadmap:** `docs/AI_AGENT_PLAN.md` — P5, P5A, §5.4, §6.3, §9.1, §9.4, and §12 HP1.

---

## 1. Scope delivered

P5A adds the patient-side AI tool and authorization foundation without connecting it to inbound WhatsApp processing or automatic replies:

- race-safe hardening for every active AI-created pending booking;
- clinic-configurable pending TTL and per-slot cap;
- one active AI-created pending booking per patient;
- daily terminal expiry through the existing P3D cron;
- conversation-bound patient identity with DOB verification and lockout;
- a strict patient-persona agent and allow-listed patient tool mount;
- availability, preliminary booking, own-appointment list/cancel, and clinic FAQ tools;
- service-only RPCs, tenant binding, RLS preservation, server-owned security metadata, and content-minimized auditing;
- patient-surface authorization through the existing P4.5 commercial reservation, usage, and immutable cost ledger;
- deterministic unit, migration, cron, entitlement, RLS, concurrency, expiry, audit, and billing tests.

No P5B behavior, WhatsApp inbox/agent wiring, automatic reply path, FAQ management UI, or unrelated refactor was added.

## 2. Booking-core hardening

`lib/booking/patient.ts` reuses the canonical scheduling/availability core and a tenant-scoped admin wrapper to:

- resolve only active doctors and services in the conversation's clinic;
- enforce doctor/service department compatibility;
- reject past, closed, unavailable, off-grid, or non-contiguous requested periods;
- create only a `pending` appointment through the service-only database boundary;
- return explicit cap/unavailable failures without confirming an appointment.

The migration adds content-free appointment provenance through `ai_patient_conversation_id` and `expires_at`. AI patient bookings use `created_by = null`; the conversation id is the authoritative creator/identity binding. A same-clinic composite foreign key, exclusive-origin constraint, creator-attribution constraint, and pending-expiry constraint prevent ambiguous or orphaned provenance.

The database trigger applies to both P5A patient bookings and existing P4.11 staff-workflow AI bookings. It takes a clinic-local transaction advisory lock before counting, so concurrent requests cannot bypass:

- one active, unexpired AI pending per patient;
- the configurable exact doctor/time slot cap, default `2`;
- the configurable TTL, default `1,440` minutes (24 hours).

Normal staff confirmation, cancellation, and displacement behavior remains compatible. Authenticated clients cannot forge AI provenance or alter an AI booking's TTL; those metadata columns are server-owned.

## 3. Pending expiry

`expire_ai_pending_bookings` is service-role-only and uses `FOR UPDATE SKIP LOCKED` to claim due rows safely across retries. It moves each due pending appointment to the existing terminal `cancelled` state, records the expiry reason, and writes `AI_PENDING_BOOKING_EXPIRED` in the same transaction.

`runAiPendingBookingExpiry` is an independent sub-job of the existing CRON-secret-protected P3D daily route. Reminder, invoice-follow-up, and booking-expiry failures are isolated; the route returns a total failure only when all three sub-jobs fail.

## 4. Patient identity gating

Patient identity is derived from the trusted `(clinic_id, conversation_id)` channel context. No patient tool accepts a `patient_id`.

The conversation stores:

- `identity_verified_at`;
- a bounded failure counter;
- a temporary verification lock.

Availability, preliminary booking, and clinic-authored FAQ lookup do not require DOB verification. Listing or cancelling appointment details requires a successful DOB match for the linked patient. Five failed attempts create a 15-minute lock. Success/failure audit rows do not store the DOB. Relinking a conversation clears prior verification state automatically.

The verification state is owned by the service-only DOB RPC. Existing RLS blocks ordinary conversation writes, and a trigger provides defense in depth so future policy widening cannot let an authenticated client manufacture verification or preserve it across a patient relink.

## 5. Patient agent and strict tool mount

`createPatientAgent` accepts only certified `patient_booking` or `patient_faq` executions and uses the existing P4.5 provider/budget lifecycle. The patient prompt exists in English and Arabic and enforces:

- pending-only booking language and mandatory staff confirmation;
- DOB gating before appointment disclosure;
- conversation-derived identity and no internal-id disclosure;
- pending-only cancellation;
- clinic-authored FAQ retrieval only;
- no medical advice, diagnosis, treatment, medication, clinical notes, balances, prompt disclosure, or cross-patient access;
- untrusted treatment of patient text and tool results.

The booking mount is exactly:

- `verify_patient_identity`;
- `check_availability`;
- `create_preliminary_booking`;
- `list_my_appointments`;
- `cancel_my_appointment`;
- `answer_clinic_faq`.

The FAQ task mounts only `answer_clinic_faq`. No staff, report, finance, clinical-summary, workflow, navigation, or arbitrary tool can enter the patient mount. Tool outputs receive the existing untrusted-data sanitization and provenance wrapper.

## 6. Authorization, tenant isolation, RLS, and auditing

Every patient invocation rechecks the active subscription, `ai_assistant`, `ai.patient_suggest`, and—where applicable—`ai.scheduling`. The database repeats the feature checks at the mutation/read boundary.

All patient RPCs:

- require `service_role`;
- bind every query and mutation to the exact clinic/conversation pair;
- derive the patient from that conversation;
- preserve the existing tenant RLS surface for authenticated staff;
- expose only bounded patient-facing appointment/FAQ fields;
- revoke execution from `public`, `anon`, and `authenticated`.

Reads record content-minimized tool audits. DOB verification, booking creation, cancellation, and expiry write their audit row atomically with the protected state change. Audit payloads omit DOB, message content, patient names, prompts, and completions.

## 7. Billing and usage

`prepareAiExecution` now distinguishes staff and patient surfaces:

- `patient_messaging` requires the patient persona and a patient task;
- patient tasks require `ai.patient_suggest`;
- patient booking additionally requires `ai.scheduling`;
- staff surfaces retain `ai.staff_assistant`;
- mixed surface/persona/task combinations fail closed.

The Pro + AI catalog enables suggestion and scheduling while retaining `ai.patient_auto = false`.

Patient turns reserve and reconcile against the existing P4.5 shared commercial budget and immutable usage ledger. The conversation UUID is the content-free patient actor key, avoiding a model-visible or persisted patient id. Usage events retain clinic, surface, persona, task, route, token/cost, and billing disposition metadata without prompts, completions, DOB, or message content. Hybrid fallback audit rows leave the profile-backed `audit_logs.actor_id` null for patient turns while retaining reservation and surface attribution.

## 8. Database migration

`supabase/migrations/20260727180000_p5a_patient_tools_booking.sql`:

- adds conversation verification/lock state;
- adds clinic TTL and per-slot-cap settings;
- adds patient-conversation appointment provenance and expiry;
- backfills active P4.11 AI pending bookings with TTL;
- adds race-safe pending-policy and server-owned metadata guards;
- adds service-only identity, booking, own-list, own-cancel, FAQ, and expiry RPCs;
- broadens the shared commercial-limit resolver from staff-only to the AI umbrella while leaving surface-specific authorization in the application and patient RPCs;
- adapts hybrid fallback audit attribution for conversation actors;
- enables `ai.patient_suggest` and `ai.scheduling` on Pro + AI while preserving `ai.patient_auto = false`.

The complete migration stack was rebuilt successfully from an empty local database.

## 9. Files added or modified

### Added

- `docs/reports/P5A_IMPLEMENTATION.md`
- `lib/ai/patient-agent.ts`
- `lib/ai/patient-authorization.ts`
- `lib/ai/patient-tools.ts`
- `lib/ai/prompts/patient.ts`
- `lib/ai/tools/answer-clinic-faq.ts`
- `lib/ai/tools/cancel-my-appointment.ts`
- `lib/ai/tools/check-patient-availability.ts`
- `lib/ai/tools/create-preliminary-booking.ts`
- `lib/ai/tools/list-my-appointments.ts`
- `lib/ai/tools/verify-patient-identity.ts`
- `lib/booking/expiry.ts`
- `lib/booking/patient.ts`
- `supabase/migrations/20260727180000_p5a_patient_tools_booking.sql`
- `tests/unit/ai/p5a-patient-tools.test.ts`
- `tests/unit/db/p5a-patient-tools-booking-migration.test.ts`
- `tests/unit/integration/p5a-patient-tools-booking.test.ts`
- `tests/unit/lib/p5a-booking-expiry.test.ts`

### Modified

- `app/api/cron/reminders/route.ts`
- `lib/ai/platform/execution.ts`
- `lib/ai/platform/registry.ts`
- `lib/supabase/admin.ts`
- `tests/unit/ai/p45a-platform.test.ts`
- `tests/unit/api/p3d-cron-routes.test.ts`
- `tests/unit/lib/entitlements.test.ts`
- `types/database.ts`

## 10. Test coverage

Coverage includes:

- exact patient tool allow-list and FAQ-only sub-mount;
- no model-visible patient id;
- identity-required denials and verification lock behavior;
- patient/staff surface, persona, task, entitlement, and scheduling gates;
- tenant-scoped availability and preliminary-booking delegation;
- service-only RPC execution and cross-tenant conversation denial;
- RLS isolation and authenticated verification/TTL-forgery resistance;
- concurrent one-pending-per-patient enforcement;
- two same-slot pendings allowed and a third rejected;
- staff confirm/displace compatibility;
- pending-only own cancellation and cross-patient non-disclosure;
- terminal TTL expiry and tenant audit;
- patient reservation/reconciliation, usage counter consumption, and immutable patient-surface ledger attribution;
- cron sub-job isolation and all-failed behavior;
- migration and generated database-type surface assertions.

## 11. Validation results

| Check | Result |
|---|---|
| Clean local migration-stack rebuild | Pass — all migrations applied, including P5A |
| Focused P5A live security/migration suite | Pass — 2 files, 12 tests |
| Focused P5A/platform/cron/entitlement suite | Pass — 6 files, 47 tests |
| Full unit suite (excludes live integration) | Pass — 231 files, 1,679 tests |
| Full integration/RLS suite | Pass — 33 files, 346 tests |
| `pnpm typecheck` | Pass |
| `pnpm lint` | Pass — 0 errors; 24 pre-existing warnings in unrelated files |
| `pnpm lint:i18n` | Pass — 317 files; 14 documented exceptions |
| `pnpm i18n:missing` | Pass — 2,975 base leaf messages; locale variants valid |
| `pnpm i18n:unused` | Pass — no unreferenced keys |
| `pnpm lint:rtl` | Pass — 460 files; 10 documented exceptions |
| Fresh local database type generation | Pass — P5A tables/columns/RPCs present |
| `pnpm build` | Pass — production build; 69 pages generated |
| `git diff --check` | Pass |

## 12. Explicit P5B boundary

P5A deliberately stops before live messaging behavior. It adds no:

- inbound WhatsApp-to-agent execution;
- inbox suggestion card or approval UX;
- automatic patient reply or send;
- `ai.patient_auto` enablement;
- auto-reply policy, quiet-hours behavior, or reply rate limiting;
- FAQ management UI;
- patient rescheduling negotiation;
- P5B migration, route, webhook, or background worker.
