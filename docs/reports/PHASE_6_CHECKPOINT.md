# ClinicFlow Phase 6 Checkpoint

Date: 2026-07-27  
Scope: Phase 6 only — replaced appointment workflow, replacement chains, and
replacement KPIs

## Executive summary

Phase 6 is complete and ready for product review. ClinicFlow now has a first-class
`replaced` appointment status and a dedicated, atomic Replace workflow. A
replacement creates a new confirmed appointment, preserves the original as a
terminal historical row, and links every generation into an ordered A → B → C
chain.

Authorization is enforced independently in both the server action and a narrowly
scoped database RPC. Doctors may replace only their own appointments without
transferring the appointment to another doctor. Assistants may act only across
their current supervised-doctor union. Admins, receptionists, and managers may
select an eligible doctor in the clinic. No broad appointment-write permission
was granted to doctors or assistants.

Replacement events are excluded from cancellation, completion, no-show, booking,
and revenue statistics. Reports and AI analytics expose replacement count and
replacement rate as separate KPIs. The final validation is green: typecheck,
unit, integration, Phase 6 database integration, ESLint, RTL, i18n, database lint,
and whitespace checks all pass.

Phase 7 was not started.

## Implemented functionality

- Added the terminal `replaced` appointment status.
- Added immediate predecessor, immediate successor, and stable-root chain links.
- Added a dedicated Replace dialog with date, time, and an authorization-filtered
  optional doctor selector.
- Added an atomic workflow that:
  - locks the original appointment to serialize concurrent replacement attempts;
  - accepts only non-deleted, future `pending` or `confirmed` appointments;
  - validates clinic, patient, doctor, department, duration, and slot rules;
  - creates a new `confirmed` appointment;
  - marks the original `replaced`;
  - writes reciprocal chain links;
  - leaves the original appointment intact.
- Added arbitrary-length replacement history with linked traversal in true chain
  order, including doctor, status, date/time, current-active, and viewed markers.
- Made the original slot reusable by excluding `replaced` rows from active patient
  slot uniqueness and conflict checks.
- Treated `replaced` as terminal in appointment actions, calendars, lists, status
  filters, badges, and same-day patient checks.
- Preserved the existing notification model: the original is no longer eligible
  for confirmed-appointment reminders, while the new confirmed appointment is
  notified and becomes reminder-eligible.
- Reused the existing appointment audit trigger so the replacement INSERT and
  original UPDATE are both recorded.

## Database migrations

### `20260727130000_appointment_replaced_status_enum.sql`

- Adds `replaced` to `appointment_status` in a standalone enum migration.

### `20260727131000_appointment_replace_workflow.sql`

- Adds `replaces_appointment_id`, `replaced_by_appointment_id`, and
  `original_appointment_id`.
- Adds chain indexes and column documentation.
- Updates patient active-slot uniqueness so a replaced original frees its slot.
- Extends the lifecycle guard only for `pending|confirmed → replaced`.
- Introduces the transactional replacement and chain-reading RPCs.

### `20260727132000_replaced_status_report_kpis.sql`

- Adds replacement count/rate to cancellation and no-show reports.
- Excludes replaced originals from cancellation/no-show denominators.

### `20260727133000_replaced_status_ai_stats.sql`

- Adds replacement KPIs to AI appointment analytics.
- Excludes replaced originals from active appointment totals and status rates.

### `20260727134000_replacement_workflow_hardening.sql`

- Adds unique partial indexes so a row has at most one immediate predecessor and
  one immediate successor.
- Adds a self-link constraint.
- Adds a deferred chain-integrity constraint trigger for reciprocal links,
  clinic/patient continuity, terminal predecessor status, and stable-root
  integrity.
- Serializes replacement with `SELECT … FOR UPDATE`.
- Revalidates authorization and the 15-minute scheduling buffer inside Postgres.
- Rebuilds chain reading as recursive linked traversal rather than date sorting.

### `20260727135000_replaced_status_remaining_analytics.sql`

- Excludes replaced originals from doctor and receptionist performance RPCs.
- Corrects overall and grouped AI appointment statistics.
- Keeps replacement count/rate separate in every grouping.

All six Phase 6 migrations are applied to the local Supabase database.

## RPC changes

### `replace_appointment`

The final RPC is deliberately narrow and `SECURITY DEFINER`. It does not trust
caller-supplied clinic or role data: it derives the authenticated user, clinic,
role, and assistant scope from database auth helpers. Execute permission is
limited to `authenticated`.

The RPC enforces:

- allowed roles: admin, receptionist, manager, doctor, assistant;
- the original belongs to the caller's clinic and is visible to the authorized
  role/scope;
- doctor callers own the original and keep themselves as target doctor;
- assistant callers have both the original and target doctors in
  `auth_supervised_doctor_ids()`;
- original state is future, non-deleted, pending/confirmed, and not already
  replaced;
- target doctor is active, same-clinic, and department-compatible;
- duration is one of the canonical appointment durations;
- target slot respects the existing 15-minute doctor buffer;
- one concurrent caller wins and the other cannot create a second successor.

### `get_appointment_replacement_chain`

- Remains `SECURITY INVOKER`, so appointment SELECT RLS scopes the result.
- Starts at the stable root and follows successor links recursively.
- Returns ordered position, status, scheduled time, doctor ID/name, and reciprocal
  link IDs.

### Analytics/report RPCs

- `get_cancellation_report`
- `get_no_show_report`
- `get_doctor_performance_report`
- `get_receptionist_performance_report`
- `ai_get_appointment_stats`

These RPCs exclude replaced originals from unrelated totals/rates and expose
replacement KPIs where required.

## RLS changes

No appointment RLS policy was weakened or broadened.

- Chain reads use the existing appointment SELECT policies through a
  `SECURITY INVOKER` RPC.
- Doctor and assistant Replace access is provided only through the narrowly
  scoped replacement RPC; it does not grant general INSERT or UPDATE access.
- Assistant scope is resolved at execution time. Removing an assistant-doctor
  assignment immediately revokes replacement access.
- The UI doctor-options action is presentation filtering only. The database RPC
  independently validates the selected target doctor.

## Server Action changes

`actions/appointments.ts` now provides:

- `replaceAppointment` — validates the request, user role, RLS-visible original,
  future time, working hours, and application-level slot availability before
  calling the atomic RPC; then sends the existing best-effort creation
  notification and revalidates appointments.
- `getReplacementDoctorOptions` — returns only doctor choices permitted for the
  current role and appointment.
- `getAppointmentReplacementChain` — returns the RLS-scoped ordered history.
- `validateAppointmentSlot(..., excludeAppointmentId)` — allows the original row
  to be excluded while validating a replacement.

The same-day-patient check also excludes terminal replaced originals.

## UI changes

- Replace action for admin, receptionist, manager, doctor, and assistant when the
  appointment is future and open.
- Localized replacement dialog with new date/time, loading/error states, and
  role-filtered doctor selection.
- `replaced` status badge and filter.
- Terminal-state behavior in appointment action menus and calendar/list surfaces.
- Replacement history in appointment detail, displaying the full linked chain
  rather than identifiers.
- Replacement count and rate cards in cancellation and no-show reports.
- English and Arabic labels, descriptions, loading states, validation errors, and
  chain terminology.
- RTL-safe vertical chain iconography.

## AI changes

- Appointment listing understands `replaced`.
- Appointment statistics return replacement count and replacement rate.
- Active totals and cancellation/no-show/completion rates exclude replaced
  originals.
- Grouped status/doctor/department analytics preserve the same separation.
- Report-tool output includes replacement KPIs.
- Page context and action-error status handling recognize `replaced`.

## Files changed for Phase 6

### Added

- `components/appointments/replace-appointment-dialog.tsx`
- `components/appointments/replacement-chain.tsx`
- `supabase/migrations/20260727130000_appointment_replaced_status_enum.sql`
- `supabase/migrations/20260727131000_appointment_replace_workflow.sql`
- `supabase/migrations/20260727132000_replaced_status_report_kpis.sql`
- `supabase/migrations/20260727133000_replaced_status_ai_stats.sql`
- `supabase/migrations/20260727134000_replacement_workflow_hardening.sql`
- `supabase/migrations/20260727135000_replaced_status_remaining_analytics.sql`
- `tests/unit/db/appointment-replacement-workflow.test.ts`
- `tests/unit/integration/appointment-replacement-workflow.test.ts`
- `docs/reports/PHASE_6_CHECKPOINT.md`

### Modified

- `actions/appointments.ts`
- `actions/doctor-dashboard.ts`
- `actions/manager-dashboard.ts`
- `app/(protected)/appointments/page.tsx`
- `components/appointments/appointment-actions.tsx`
- `components/appointments/appointment-detail-dialog.tsx`
- `components/appointments/day-calendar.tsx`
- `components/appointments/filter-bar.tsx`
- `components/appointments/hour-appointments-dialog.tsx`
- `components/appointments/status-badge.tsx`
- `components/appointments/week-calendar.tsx`
- `components/reports/cancellation-report.tsx`
- `components/reports/no-show-report.tsx`
- `lib/ai/page-context.ts`
- `lib/ai/tools/get-appointment-stats.ts`
- `lib/ai/tools/list-appointments.ts`
- `lib/ai/tools/run-clinic-report.ts`
- `lib/i18n/action-errors.ts`
- `lib/reports/data.ts`
- `lib/validations/appointment.ts`
- `messages/action-errors/ar.json`
- `messages/action-errors/en.json`
- `messages/ar.json`
- `messages/en.json`
- `tests/unit/actions/appointment-validation-conflicts.test.ts`
- `types/database.ts`
- `types/reports.ts`
- `docs/ROLES_REPORTS_ASSISTANT_EXTENSION_PLAN.md`

The repository already contained uncommitted work for earlier approved phases.
That work was preserved; this list identifies the Phase 6 implementation surface.

## Validation results

| Validation | Result |
| --- | --- |
| `pnpm typecheck` | Passed |
| `pnpm lint` | Passed with 0 errors and 25 pre-existing warnings |
| `pnpm lint:rtl` | Passed — 441 files checked, 10 registered exceptions |
| `pnpm lint:i18n` | Passed — 310 files checked, 14 registered exceptions |
| `pnpm i18n:missing` | Passed — 2,915 base leaf messages |
| `pnpm exec supabase db lint --local --level error` | Passed |
| `git diff --check` | Passed |

An initial full unit run detected one RTL icon-direction violation in the new
chain component. The component was corrected to use a direction-neutral vertical
arrow, and all final validation runs passed.

## Test results

| Test run | Result |
| --- | --- |
| Full unit suite (`pnpm test --reporter=dot`) | 221 files passed; 1,606 tests passed |
| Full integration suite against local Supabase | 28 files passed; 297 tests passed |
| Focused Phase 6 action/database tests | 2 files passed; 33 tests passed |
| Live Phase 6 database integration | 1 file passed; 6 tests passed |

The live Phase 6 tests cover:

- doctor ownership and doctor-transfer denial;
- A → B → C chain order when dates move backward;
- assistant scope and immediate revocation after unassignment;
- original-slot reuse and INSERT/UPDATE audit rows;
- concurrent replacement with exactly one successful successor;
- replacement KPI separation from cancellations and no-shows.

## Implementation decisions requiring product confirmation

No decision blocks Phase 6 approval. The implementation follows the approved
architecture. The following choices are called out for explicit product
awareness:

1. A new replacement is created directly as `confirmed`, matching the approved
   workflow and ensuring reminder eligibility.
2. Doctors may reschedule only their own appointment and may not transfer it to a
   different doctor. Admins, receptionists, and managers may choose another
   eligible clinic doctor; assistants may choose only within their assigned-doctor
   union.
3. Replacement rate is `replaced / (active-statistical appointments + replaced)`.
   Cancellation and no-show rates use only non-replaced appointments as their
   denominator.
4. Notification hand-off uses the existing status-based reminder pipeline rather
   than introducing replacement-specific reminder records.

## Intentionally deferred

- No Phase 6 functionality is intentionally deferred.
- Phase 7 consolidated testing/documentation/final report work was not started.
- Phase 8 doctor-focused reporting and unified operational activity tracking
  remains deferred exactly as documented in the plan.
- No commit, merge, rebase, reset, or branch operation was performed.

