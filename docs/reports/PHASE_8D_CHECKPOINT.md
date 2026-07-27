# ClinicFlow Phase 8D Checkpoint

Date: 2026-07-27
Scope: Phase 8D only — Unified Activity Timeline / Audit Trail
Status: Complete; awaiting product approval

## Executive summary

Phase 8D is complete. It delivers the durable, append-only, actor-level activity
trail defined in `docs/ROLES_REPORTS_ASSISTANT_EXTENSION_PLAN.md` §8D — the
foundation the plan requires before the doctor-facing "My Performance" (8B) and
"My Assistant Performance" (8C) reports can be built.

The trail is a purpose-built `activity_events` table written **only** by a
spoof-proof `SECURITY DEFINER` trigger that stamps the actor from `auth.uid()`,
is append-only for all authenticated roles, and is read under RLS that mirrors
each caller's existing entity visibility. A localized timeline UI surfaces it on
the appointment detail dialog and the patient page.

Phases 8A, 8B, and 8C were **not** started. No Git operations were performed.

## What was implemented

### Database — `20260727140000_p8d_activity_events.sql`

- **`activity_events` table.** `id`, `clinic_id`, `actor_id` (nullable →
  system), `actor_role`, `is_system`, `action` (semantic), `entity_type`,
  `entity_id`, `patient_id`, `doctor_id` (both denormalized for scope and to
  survive entity deletion), `previous_state`/`new_state` (curated jsonb),
  `metadata` jsonb, `occurred_at`.
- **Indexes.** `(clinic_id, entity_type, entity_id, occurred_at desc)`,
  `(clinic_id, actor_id, occurred_at desc)`, `(clinic_id, doctor_id,
  occurred_at desc)`, `(clinic_id, patient_id, occurred_at desc)`.
- **Write boundary.** One `record_activity_event()` `SECURITY DEFINER` trigger on
  `appointments` and `follow_ups` (AFTER INSERT/UPDATE/DELETE). It derives the
  semantic action from the row transition, stamps `actor_id = auth.uid()` and the
  actor's role, sets `is_system = true` when there is no authenticated user, and
  records a curated before/after snapshot. Clients can never supply the actor.
- **Semantic vocabulary.** `appointment.created/confirmed/checked_in/
  session_started/completed/cancelled/no_show/replaced/rescheduled/
  status_changed/trashed/restored/updated/deleted`; `follow_up.recorded/
  outcome_changed/updated/deleted`.
- **Append-only + spoof-proof.** `revoke all … from anon, authenticated`, then
  `grant select … to authenticated`; a single `activity_events_select_scoped`
  policy and **no** INSERT/UPDATE/DELETE policy, so authenticated writes are
  denied outright and history can never be rewritten.
- **Scoped reads.** Clinic-isolated; admins/managers/receptionists clinic-wide;
  doctors see events for their own appointments or their assigned/department
  patients; assistants see events only within their supervised-doctor union
  (`auth_supervised_doctor_ids()`), never another assistant's or an unrelated
  doctor's.

### Types

- Hand-added the `activity_events` `Row`/`Insert`/`Update`/`Relationships` block
  to `types/database.ts`, per the minimal hand-addition policy (no wholesale
  local regeneration). No new RPC signatures were introduced.

### Application

- `lib/activity/events.ts` — action/entity vocabulary mirrored from the trigger,
  tone map, and the dotted-action → camelCase message-key helper.
- `actions/activity.ts` — `getActivityTimeline`, a read-only, RLS-scoped,
  keyset-paginated, filterable query that enriches events with the actor's name.
  It fails closed to an empty timeline rather than throwing.
- `components/activity/activity-timeline.tsx` — localized timeline with actor
  attribution, per-action tone, relative ordering, empty/loading/failed states,
  and "load more".
- Embedded on the appointment detail dialog (entity-scoped) and the patient
  detail page (patient-scoped).
- English/Arabic copy under the `activity` namespace + `protected.patientActivity`.

### Product decisions

1. **Begin-from-now cutover.** The trigger captures events going forward; there
   is no synthetic backfill of pre-existing rows. Entity tables remain
   authoritative for present state and business totals; `activity_events` is
   authoritative only for actor-level history.
2. **Distinct from `audit_logs`.** The pre-existing generic table-diff
   `audit_logs` (admin/manager-only) is retained unchanged; `activity_events` is
   the semantic, role-aware, scoped trail intended for accountability and KPIs.
3. **Covered entities.** `appointments` and `follow_ups` — the entities that
   exist in the schema and that the approved 8B/8C KPIs need. There is no
   separate invoices table (billing lives on appointments and is captured through
   appointment payment-state snapshots).
4. **PHII minimization.** Snapshots store curated business fields (status,
   schedule, doctor, duration, payment totals; follow-up outcome), not free-text
   notes, and reads are already scoped to callers who may see the entity.

## Validation results

| Validation | Result |
| --- | --- |
| `pnpm typecheck` | Passed |
| Production build | Passed; 67 routes |
| ESLint (changed files) | Passed; 0 errors |
| `pnpm lint:rtl` | Passed; 443 files, 10 exceptions |
| `pnpm lint:i18n` | Passed; 312 files, 14 exceptions |
| `pnpm i18n:missing` | Passed; 2,942 base leaf messages |
| `pnpm i18n:unused` | Passed; no unused messages |
| Database lint | No new findings; the same four known warning sites remain (`record_activity_event` adds none) |
| Clean local migration replay | Passed from an empty local database through `20260727140000` |
| `git diff --check` | Passed |

## Test results

| Test run | Result |
| --- | --- |
| Complete non-integration unit suite | 225 files; 1,631 tests passed |
| Complete live integration catalog | 29 files; 314 tests passed |
| New Phase 8D static migration contract | 6 tests passed |
| New Phase 8D unit catalog / i18n parity | 6 tests passed |
| New Phase 8D live RLS suite | 8 tests passed |

The live Phase 8D suite proves: the human actor and role are stamped across a
create → confirm → cancel lifecycle; service-role writes are attributed to the
system actor; `follow_up.recorded` is emitted with a derived owning doctor;
client-forged inserts and any update/delete of existing events are denied
(append-only, spoof-proof); and reads are scoped — assistant sees only its
supervised doctor, a doctor sees only its own, and admins are clinic-isolated.

## Files added

- `supabase/migrations/20260727140000_p8d_activity_events.sql`
- `lib/activity/events.ts`
- `actions/activity.ts`
- `components/activity/activity-timeline.tsx`
- `tests/unit/db/p8d-activity-events-migration.test.ts`
- `tests/unit/lib/p8d-activity-events.test.ts`
- `tests/unit/integration/p8d-activity-events-rls.test.ts`
- `docs/reports/PHASE_8D_CHECKPOINT.md`

## Files modified

- `types/database.ts` — added the `activity_events` table types.
- `components/appointments/appointment-detail-dialog.tsx` — embedded the
  entity-scoped timeline.
- `app/(protected)/patients/[id]/page.tsx` — added the patient-scoped timeline.
- `messages/en.json`, `messages/ar.json` — `activity` namespace +
  `protected.patientActivity`.
- `docs/ROLES_REPORTS_ASSISTANT_EXTENSION_PLAN.md` — marked 8D as checkpointed.

## How this feeds the deferred sub-phases

- **8B (My Performance).** Doctor-scoped operational KPIs (appointments,
  completions, cancellations, no-shows, reschedules/replacements, follow-up
  completion) can be computed from `activity_events` filtered by `doctor_id`
  within the caller's scope, keeping replacement distinct from cancellation.
- **8C (My Assistant Performance).** Assistant actor-level KPIs come from
  `activity_events.actor_id` joined to the assignment table so a doctor sees only
  the assistants assigned to that doctor; multi-assignment isolation is preserved
  by the same scope predicate used here.

## Known limitations

- Begin-from-now: rows created before this migration have no historical events by
  design.
- Coverage is `appointments` and `follow_ups`; extending to further entities is a
  single additional trigger following the same pattern.
- The four pre-existing database-lint warning sites remain (unchanged by 8D).
- Local migration verified locally; production migration/deployment is out of
  this session's scope.

## Intentionally deferred

- Phases 8A (My Revenue), 8B (My Performance), and 8C (My Assistant Performance)
  were not started.
- No Git commit, push, merge, rebase, reset, or branch operation was performed.
