# Package Templates + Arrived & In-Session Workflow + Doctor/Reception Dashboards — Implementation Plan

> Status: **Planning document only** — no code, schema, or migrations have been changed.
> Scope (additive, must not break billing/invoices/deposits/reports/`patient_packages.used_sessions` trigger/conflict detection/undo behavior):
>   1. Package Templates in **Settings**.
>   2. New appointment statuses **`arrived`** and **`in_session`** + dashboard surfaces + reception read-only access to medical notes.
>
> **Workflow change vs. earlier draft:** the previous draft used `pending → confirmed → arrived → completed`. This is **replaced** by `pending → confirmed → arrived → in_session → completed`. All sections below reflect the new flow; legacy "arrived-only" requirements have been expanded or replaced as noted.

---

## 1. Context & Goals

ClinicFlow already supports:
- Patient packages CRUD on the patient profile (manual Add Package dialog).
- A completed reports system (revenue, deposits, package usage, etc.).
- Appointment statuses: `pending → confirmed → completed | cancelled | no_show`.
- 10-second toast-based undo for status transitions.
- A DB trigger that increments/decrements `patient_packages.used_sessions` strictly on the `completed` transition.
- Billing & invoicing on completion via the `complete_appointment_billing` RPC.

We are adding:

**Feature 1 — Package Templates in Settings.** Admin defines reusable presets per department. The patient-profile Add Package dialog becomes template-driven (auto-select department from patient, filter dropdown by department, auto-fill fields), while preserving a manual-create fallback.

**Feature 2 — Arrived & In-Session statuses + dashboards.** Insert two new statuses between `confirmed` and `completed`:
- `arrived` — reception/admin marks the patient as physically present.
- `in_session` — the assigned doctor starts the visit and is auto-redirected to the patient's Medical Notes page.
- `completed` happens only after the patient returns to reception, where reception/admin closes the visit through the existing billing flow.

Doctor dashboard surfaces in-session/arrived/confirmed queues. Reception dashboard adds an in-session board grouped by department. Reception also gains read-only + print access to medical notes.

---

## 2. Current System Findings

### 2.1 Packages
| Concern | Location |
|---|---|
| `patient_packages` schema + triggers | `supabase/migrations/20260518000000_patient_packages.sql` |
| `patient_packages` RLS | `supabase/migrations/20260518001000_patient_packages_rls.sql` |
| Server actions (create/update/deactivate) | `actions/patient-packages.ts` |
| Zod schemas | `lib/validations/patient-package.ts` |
| Add dialog (manual) | `components/patients/add-package-dialog.tsx` |
| Edit dialog | `components/patients/edit-package-dialog.tsx` |
| Patient list section | `components/patients/patient-packages-section.tsx` |

Key columns on `patient_packages`: `clinic_id, patient_id, department_id, service_id, name, total_sessions, used_sessions, price_per_session, notes, is_active, created_by, created_at, updated_at`. Constraint `used_sessions <= total_sessions`. No `package_templates` table exists today. Patients table already carries a nullable `department_id`.

### 2.2 Settings
- Layout: `app/(protected)/settings/layout.tsx` gated by `requireRole(["admin","manager"])`.
- Nav: `components/settings/settings-nav.tsx` (staff / departments / services / insurance / clinic / customize, with `adminOnly` flag).
- Closest mirror page: `app/(protected)/settings/services/page.tsx` (grouped by department, add dialog, soft-delete via trash section).
- Settings server actions: `actions/settings.ts`; validations: `lib/validations/settings.ts`.

### 2.3 Appointment status & transitions
- Enum `public.appointment_status` (`pending, confirmed, completed, cancelled, no_show`) at `supabase/migrations/20260504000000_baseline_schema.sql:15-21`.
- Transition guard `enforce_appointment_transition()` at same file lines 73-93: `pending → confirmed | cancelled`, `confirmed → completed | cancelled | no_show`.
- TS union: `types/database.ts:1753-1759`.
- Status badge palette: `components/appointments/status-badge.tsx`.
- Action buttons + 10s undo toasts: `components/appointments/appointment-actions.tsx` (`runComplete` ~L261, `runNoShow`, `runCancel`).
- Server actions: `actions/appointments.ts` — `updateAppointmentStatus`, `cancelAppointment`, `undoAppointmentStatus`, `undoInvoiceCompletion`.
- Undo for non-completed transitions RPC: `supabase/migrations/20260517000000_undo_appointment_status_rpc.sql` — currently accepts only `'pending'|'confirmed'`.
- Completion billing RPC: `supabase/migrations/20260506050000_transactional_billing_and_settlement_rpcs.sql` (`complete_appointment_billing`).
- `patient_packages.used_sessions` sync trigger: `supabase/migrations/20260518000000_patient_packages.sql:86-185` — **keyed strictly on `'completed'`**. `arrived` and `in_session` will be inert by construction provided we never branch on them.
- Slot/conflict triggers to audit:
  - `supabase/migrations/20260512130000_fix_doctor_slot_cancelled_noshow.sql`
  - `supabase/migrations/20260514150033_allow_pending_same_slot.sql`
  - `supabase/migrations/20260516000000_allow_pending_same_slot.sql`
- Conflict detection in TS: `getConflictingPendingAppointments` / `checkSameDayPatient` in `actions/appointments.ts`.

### 2.4 Doctor dashboard
- Page: `app/(protected)/dashboard/page.tsx` (role-routes to doctor variant ~L537-560).
- Component: `components/dashboard/doctor-dashboard.tsx` (filter modes today/week/month/custom, KPI cards) + dynamic `doctor-dashboard-charts`.
- Stats action: `actions/doctor-dashboard.ts` (`fetchDoctorDashboardStats`).
- Doctor-scoped appointment RLS: `supabase/migrations/20260505220000_scope_patient_and_appointment_rls_for_doctors.sql`.

### 2.5 Medical notes (to confirm during implementation)
- Locate the medical-notes feature surface (likely under `app/(protected)/patients/[id]/medical-notes` or `app/(protected)/medical-notes/...`).
- Confirm the current RLS on `medical_notes` / equivalent — historically receptionist has had no read access. Phase 7 will widen read+print to receptionist, gated by RLS + UI hiding of mutation controls.

---

## 3. Database Changes (Required Migrations)

Use the existing `YYYYMMDDHHMMSS_description.sql` naming, with timestamps **after** `20260518002000_reports_rpcs.sql`.

### Migration A — `20260519000000_package_templates.sql`
```sql
create table public.package_templates (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  department_id uuid not null references public.departments(id) on delete restrict,
  name text not null check (char_length(name) between 1 and 120),
  total_sessions int not null check (total_sessions > 0 and total_sessions <= 10000),
  price_per_session numeric(12,2) check (price_per_session is null or price_per_session >= 0),
  total_price numeric(12,2) check (total_price is null or total_price >= 0),
  notes text check (notes is null or char_length(notes) <= 500),
  is_active boolean not null default true,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_package_templates_clinic_dept_active
  on public.package_templates(clinic_id, department_id) where is_active;

create trigger trg_package_templates_updated_at
  before update on public.package_templates
  for each row execute function public.set_updated_at();
```
Decisions:
- `department_id` is **required** (drives the patient-profile dialog filter).
- Keep both `price_per_session` and `total_price` nullable; admins fill the one that maps to their pricing model.
- **Do not** add a `template_id` FK on `patient_packages` in v1 — keeps the change reversible.

### Migration B — `20260519001000_package_templates_rls.sql`
- `read`: any authenticated user where `clinic_id = public.auth_clinic_id()`.
- `insert/update`: `admin` only.
- `delete`: `admin` only (UI prefers soft-delete via `is_active = false`).

### Migration C-1 — `20260519002000_add_in_visit_statuses.sql`
`ALTER TYPE … ADD VALUE` cannot run inside a transaction → kept alone:
```sql
alter type public.appointment_status add value if not exists 'arrived'    after 'confirmed';
alter type public.appointment_status add value if not exists 'in_session' after 'arrived';
```

### Migration C-2 — `20260519002500_in_visit_transitions_and_undo.sql`
Recreate `enforce_appointment_transition()` to allow exactly:
- `pending → confirmed | cancelled`
- `confirmed → arrived | completed | cancelled | no_show`
- `arrived → in_session | completed | confirmed | cancelled | no_show`
- `in_session → completed | arrived | cancelled | no_show`

Widen RPCs:
- `public.undo_appointment_status(uuid, text)` — whitelist becomes `{'pending','confirmed','arrived','in_session'}`.
- `public.undo_appointment_billing(uuid, text)` — whitelist must accept `{'confirmed','arrived','in_session'}` as rollback targets (today: only `pending|confirmed`).

Patch slot/conflict triggers so any predicate matching "active" statuses includes both `'arrived'` and `'in_session'` alongside `'confirmed'`. Files to audit: `20260512130000_fix_doctor_slot_cancelled_noshow.sql`, both `allow_pending_same_slot` migrations.

Optional helper column: add `in_session_started_at timestamptz` to `appointments` (nullable). Set/cleared by the trigger when status enters/leaves `in_session`, enabling the reception "elapsed in-session duration" without timestamp gymnastics.

### Migration C-3 — `20260519003000_delete_restrictions.sql`
Add a `BEFORE DELETE` trigger on `appointments` that raises if `status in ('arrived','in_session','completed')`. (`completed` already non-deletable in practice; this codifies it.) Pending/confirmed deletion paths are unchanged.

### Migration D — `20260519004000_doctor_today_queue_rpc.sql` (recommended)
RPC `public.doctor_today_queue(p_doctor_id uuid, p_tz text default 'Europe/Istanbul')` returning four buckets in one round trip:
1. `in_session` (today)
2. `arrived` (today)
3. `confirmed` (today)
4. `confirmed` (tomorrow)

`security invoker` so existing doctor RLS still applies.

### Migration E — `20260519005000_reception_in_session_rpc.sql` (recommended)
RPC `public.reception_in_session_board(p_tz text default 'Europe/Istanbul')` returning all `arrived` + `in_session` appointments for the clinic grouped by department. `security invoker`.

### Migration F — `20260519006000_medical_notes_reception_read.sql`
- Extend `medical_notes` (and any sub-tables/attachments) RLS to grant `select` to receptionists within the same clinic.
- **Must not** grant `insert/update/delete` to receptionists.
- Confirm exact table/policy names during implementation; this migration's shape is conditional on what's there today.

---

## 4. UI Changes

### 4.1 Settings → Packages
- New route: `app/(protected)/settings/packages/page.tsx` (mirror `app/(protected)/settings/services/page.tsx`).
- New components:
  - `components/settings/packages/packages-list.tsx`
  - `components/settings/packages/add-package-template-dialog.tsx`
  - `components/settings/packages/edit-package-template-dialog.tsx`
  - `components/settings/packages/package-template-row.tsx`
- Nav entry in `components/settings/settings-nav.tsx` (after Services), `adminOnly: true`.
- Group templates by department; soft-delete via `is_active = false`; trash section mirrors departments/services.

### 4.2 Patient profile Add Package dialog (rewrite)
- File: `components/patients/add-package-dialog.tsx`.
- Template-first flow:
  1. **Department select** — defaults to `patient.department_id` if present, locked when set.
  2. **Template select** — filtered by department + `is_active`.
  3. **Auto-fill** on template choice: `name`, `total_sessions`, `price_per_session` (or `total_price`), `notes`, `department_id`.
  4. **Locked fields** when template chosen: `total_sessions`, `department_id`.
  5. **Editable**: `price_per_session`, `notes`.
  6. **"Create custom"** link toggles back to the manual form (preserves current behavior).
- Submission still calls `createPatientPackage` — no payload change.
- Edit dialog is **not** modified.

### 4.3 Status badge & per-role action buttons

`components/appointments/status-badge.tsx`: add `arrived` (sky) and `in_session` (violet/purple, distinct from completed-emerald). Arrived rows on dashboards get a stronger visual treatment (left-border accent + subtle background) to be "prominent."

`components/appointments/appointment-actions.tsx` becomes role-aware:

| Role | Allowed buttons |
|---|---|
| Receptionist / Admin | Confirm (from pending), Arrive (from confirmed), Complete (from arrived OR in_session) + 10s undo, Cancel, No-show |
| Doctor | **Only** "Start Session" (visible only when `effectiveStatus === "arrived"` AND `appointment.doctor_id === currentUser.id`) |

Doctor "Start Session" handler:
1. Optimistically sets status to `in_session`.
2. Calls `startAppointmentSession(id)` server action.
3. On success, `router.push("/patients/{patientId}/medical-notes")` (exact route confirmed during impl).
4. On failure, rollback optimistic state + toast error; **do not** redirect.
5. Toast offers 10s undo → `undoAppointmentStatus(id, "arrived")`; if undo is clicked, also `router.back()` if still on the medical notes page.

`runComplete` is widened: `undoTarget = prevStatus === "in_session" ? "in_session" : prevStatus === "arrived" ? "arrived" : "confirmed"`. The Arrive button continues to use the standard 10s undo toast pattern that calls `undoAppointmentStatus(id, "confirmed")`.

### 4.4 Optional arrival sound (Doctor dashboard)
- New small client hook `useArrivalChime()` in `components/dashboard/doctor-today-queue.tsx`.
- Plays a short audio cue from `public/sounds/arrival.mp3` (asset to be added by ops) when the queue detects a newly arrived appointment vs. previous poll.
- **Browser autoplay-safe**:
  - Only plays after the user has interacted with the page at least once (track via a `pointerdown` listener that sets a `userInteracted` ref).
  - Wrap `audio.play()` in `try/catch` and silently swallow `NotAllowedError`.
  - Off by default. A small toggle ("🔔 Notify on arrival") in the queue header persists to `localStorage`.
  - Respect `prefers-reduced-motion`/silent mode where detectable; never block the UI on the audio.

### 4.5 Doctor dashboard queue
- New: `components/dashboard/doctor-today-queue.tsx` rendered **above** existing KPI strip in `components/dashboard/doctor-dashboard.tsx`. Existing widgets remain unchanged.
- Four buckets in priority order (top to bottom on mobile, two-column on `lg+`):
  1. **In session** (highest priority, violet accent, optional running timer).
  2. **Arrived** (sky accent, prominent — visual treatment from §4.3).
  3. **Today — Confirmed** (default).
  4. **Tomorrow — Confirmed** (separate card).
- Row content: scheduled time, patient name, service, status badge, quick link.
- Refresh: short-interval `router.refresh()` (e.g., every 30s when tab visible) so arrivals appear without manual reload; also refresh on focus and after the doctor's own status mutations.

### 4.6 Reception in-session board
- New: `components/dashboard/reception-in-session-board.tsx` rendered on the reception/admin dashboard (page TBD during impl, but in the same dashboard route family).
- Lists all currently `arrived` + `in_session` appointments for the clinic, **grouped by department**.
- Per row: patient name, doctor (formatted), service, scheduled time, current status badge, elapsed in-session duration when status = `in_session` (uses `in_session_started_at` from Migration C-2; client-side ticker updates the "Xm Ys" display each second).
- Existing reception KPIs/widgets remain unchanged.

### 4.7 Reception read-only medical notes + print
- Add a reception-friendly route `app/(protected)/patients/[id]/medical-notes/page.tsx` (or extend the existing one with a role-aware variant) that:
  - Renders the same content as the doctor's view.
  - **Hides** all mutation UI (new note button, edit/delete, sign, attach, etc.) when `user.role === "receptionist"`.
  - Provides a **Print** button (uses `window.print()` against a print-friendly stylesheet — reuses existing print stylesheet if present).
- Reception cannot reach mutation server actions even if a stale URL is opened — server actions already call `requireRole(["doctor","admin"])` (verify during impl; add the guard if missing).

---

## 5. Server Actions / RPC Changes

| File | Change |
|---|---|
| New `actions/package-templates.ts` | `createPackageTemplate`, `updatePackageTemplate`, `deactivatePackageTemplate`, `restorePackageTemplate`. Admin only. |
| New `lib/validations/package-template.ts` | Zod schemas. |
| `actions/appointments.ts` | Add `arriveAppointment(id)` (admin/receptionist). Add `startAppointmentSession(id)` — guards that the caller is the assigned doctor (`appointment.doctor_id === user.id`) AND `user.role === "doctor"`; returns the medical-notes redirect target. Extend `updateAppointmentStatus` switch to accept `"arrived"`, `"in_session"`. Extend `undoAppointmentStatus` action to accept those targets. |
| `actions/doctor-dashboard.ts` | Add `fetchDoctorTodayQueue(doctorId)` → `{ inSession, arrived, todayConfirmed, tomorrowConfirmed }`. |
| New `actions/reception-dashboard.ts` (or extend existing) | `fetchReceptionInSessionBoard()` → rows grouped by department. |
| `actions/medical-notes.ts` (file name TBC) | Audit all mutation actions: ensure `requireRole(["doctor","admin"])` is present so receptionist read access does not bleed into writes. |
| `types/database.ts` | Regenerate after each enum/RPC migration; in the meantime add `"arrived"` and `"in_session"` to the union to keep TS green. |

---

## 6. Validation Rules

### Package template
- `name`: 1-120 chars; `department_id`: required UUID in caller's clinic; `total_sessions`: 1-10000; `price_per_session`/`total_price`: optional decimals ≥ 0; `notes`: optional ≤ 500; `is_active`: boolean.

### Add Package (from template)
- Re-runs `createPatientPackageSchema`. Client guard: dept select read-only when template chosen.

### Status actions (server + DB)
- DB guard updated as in Migration C-2; server wrappers reject unsupported transitions before hitting DB.
- `arriveAppointment`: role `admin|receptionist`.
- `startAppointmentSession`: role `doctor` AND `appointment.doctor_id = user.id`.
- `complete` (existing path) usable from `arrived` or `in_session` by `admin|receptionist`.

### Delete (codified)
- Server `deleteAppointment` action + DB `BEFORE DELETE` trigger (Migration C-3) reject deletes when `status in ('arrived','in_session','completed')`.

---

## 7. Status Transition Design (post-change)
```
pending     → confirmed | cancelled
confirmed   → arrived | completed | cancelled | no_show
arrived     → in_session | completed | confirmed | cancelled | no_show
in_session  → completed | arrived | cancelled | no_show
completed   → (terminal; undo via undo_appointment_billing → confirmed | arrived | in_session)
cancelled   → (undo via undo_appointment_status → pending | confirmed | arrived | in_session)
no_show     → (undo via undo_appointment_status → confirmed | arrived | in_session)
```

> **Replacement note:** This supersedes the earlier draft's `pending → confirmed → arrived → completed`. The `arrived → completed` direct transition is retained (so reception can still close out a patient who never started a session) but is expected to be rare.

---

## 8. Undo Behavior Design

Same toast UX (`duration: 10000`) as all existing undos.

| Action | Server call | Notes |
|---|---|---|
| Arrive → Undo | `undoAppointmentStatus(id, "confirmed")` | RPC widened. |
| Start Session → Undo | `undoAppointmentStatus(id, "arrived")` | RPC widened. If the doctor has already navigated to medical notes, also `router.back()`. |
| Complete (from in_session) → Undo | `undoInvoiceCompletion(id, "in_session")` | RPC widened. |
| Complete (from arrived) → Undo | `undoInvoiceCompletion(id, "arrived")` | RPC widened. |
| Complete (from confirmed) → Undo | `undoInvoiceCompletion(id, "confirmed")` | Existing. |
| Cancel/No-show undo | Unchanged | Existing RPCs; rollback target = `confirmed` (or `arrived`/`in_session` if widened later). |

---

## 9. Doctor Dashboard Behavior

- New section above existing KPIs; existing widgets and filter chips untouched.
- Four buckets stacked in priority order: `in_session`, `arrived`, `confirmed today`, `tomorrow confirmed` (separate card).
- Doctor sees only their own rows (RLS-enforced).
- Optional arrival chime (see §4.4). Off by default; persisted per browser.
- Auto-refresh: visibility-aware 30s poll + on focus + after own mutations.
- Empty buckets render a small muted "Nothing here yet" line.

---

## 10. Reception Dashboard Behavior

- New "In-session board" section added to the reception/admin dashboard.
- Source: `fetchReceptionInSessionBoard()` (RPC `reception_in_session_board` if Migration E used).
- Grouped by **department**; within group sorted by start time.
- Per row: patient name, doctor, service, scheduled time, status badge, elapsed in-session duration (live ticker).
- Existing reception widgets untouched.

---

## 11. Medical Notes Permissions

| Role | Capabilities |
|---|---|
| Doctor | View, create, edit, delete, sign — unchanged. |
| Admin | Unchanged. |
| Receptionist | **View** + **Print** only. No create/edit/delete/sign UI. No mutation server-action access. |
| Other roles | Unchanged. |

Implementation:
- RLS: receptionist `select` on `medical_notes` and related tables within the same clinic (Migration F).
- UI: hide mutation controls when `user.role === "receptionist"`. Render a `Print` button that uses `window.print()` + a print stylesheet.
- Server actions: explicit `requireRole(["doctor","admin"])` guard on every mutation action (audit + add if missing).

---

## 12. Package Template Lifecycle

1. **Create** — admin in Settings → Packages → Add template (department required).
2. **Edit** — admin updates name, sessions, price, notes. Does **not** retroactively touch `patient_packages` rows already created from it.
3. **Deactivate (soft)** — `is_active = false`. Hidden from Add Package dialog but kept for audit.
4. **Restore** — back to `is_active = true`.
5. **Hard delete** — admin only via trash section.

---

## 13. RLS / Security Considerations

- `package_templates`: read = clinic members; insert/update/delete = admin only.
- New enum values `arrived` and `in_session` are automatically covered by existing doctor-scoped appointment RLS — no policy edits needed for `appointments`.
- `startAppointmentSession` enforces `auth.uid() = appointments.doctor_id` server-side (defense in depth in addition to RLS).
- `reception_in_session_board` and `doctor_today_queue` RPCs are `security invoker` to inherit RLS.
- Medical notes (Migration F): widen receptionist read; never widen write. Add a regression test that asserts receptionist cannot insert/update/delete (RLS denial).
- Grep audit before merge: any RLS or trigger predicate hardcoding the status set must be widened for `'arrived'` and `'in_session'`.

---

## 14. Conflict Detection Audit

Both `'arrived'` and `'in_session'` must count as **active occupied** alongside `'confirmed'` in every conflict surface:
- DB triggers in `20260512130000_fix_doctor_slot_cancelled_noshow.sql` and the `allow_pending_same_slot` family — widen status predicates.
- TS helpers `getConflictingPendingAppointments` / `checkSameDayPatient` in `actions/appointments.ts` — widen status predicates.
- Any other booking validation paths discovered during impl (grep `status` near appointment scheduling).

Missing this is the **highest-risk omission** — allows double-booking after a patient has already arrived/started a session.

---

## 15. Reports Considerations

- `arrived` and `in_session` are **never** "completed" — they must not contribute to revenue / completion / billing rollups.
- Revenue remains tied to the completed/billing flow only.
- Cancellation / no-show denominator rules: keep existing behavior unless audit reveals a status set that omits arrived/in_session and would distort ratios; in that case widen the denominator to include them and document the change. Default: do **not** touch report logic.
- Add a regression test that runs the full suite of reports against fixture appointments cycling through arrived/in_session and confirms totals are unchanged.

---

## 16. Delete Restrictions (explicit business rules)

- `pending`, `confirmed`: delete and cancel paths unchanged (existing UI + actions).
- `arrived`, `in_session`: **cannot be deleted** after the undo toast expires. Enforced both in UI (delete button hidden / disabled with tooltip) and at DB level (Migration C-3 trigger).
- `completed`: remains non-deletable as currently implemented (codified by the same trigger so behavior is uniform).
- The only way to remove an `arrived`/`in_session` appointment is to first undo it back to `confirmed` (within 10s) or `cancel` it.

---

## 17. Edge Cases

- `ALTER TYPE … ADD VALUE` cannot run in a transaction → Migration C-1 isolated.
- Slot conflict predicates not widened → double-booking risk (Phase 3 explicit step).
- `undo_appointment_billing` not extended → silent state loss on undo of complete-from-in_session/arrived.
- "Start Session" race: doctor double-clicks while the previous request is in flight — disable the button while pending; idempotency key on the server action (or guard via `WHERE status = 'arrived'`).
- "Start Session" redirect race: status update succeeds but redirect throws (popup blocker, route 404) → keep status `in_session`, log the error, surface a "Open medical notes" link in the toast.
- Optimistic UI roll-back after a failed network request must not strand the doctor on the medical-notes page if the status didn't actually flip.
- Browser autoplay restrictions (see §4.4) — never throw, never block.
- Reception in-session timer drift: compute `now - in_session_started_at` on each tick rather than incrementing a counter, so tab-throttling doesn't desync.
- Template prefill clashing with dirty user edits → confirm dialog before overwriting.
- Repeated status flips between `confirmed ↔ arrived ↔ in_session ↔ completed` must not leak `used_sessions`. Trigger keys on `completed` only; add a regression test.
- Receptionist with a stale tab whose RLS hasn't refreshed — server actions still reject mutations via `requireRole` (defense in depth).
- Timezone drift around midnight: today/tomorrow boundaries computed in clinic TZ.

---

## 18. Testing Strategy

1. **Migrations** — `supabase db reset` locally; verify enums, transition guard, RPCs, package_templates table + RLS, delete trigger, medical_notes RLS.
2. **Templates CRUD** — admin can create/edit/deactivate/restore; manager cannot mutate; cross-clinic read denied.
3. **Add Package dialog** — patient with dept auto-selects; dropdown filtered; prefill works; locked fields enforced; "Create custom" fallback works.
4. **Status flow** — full happy path `pending → confirmed → arrived → in_session → completed`; each undo restores the prior state; `arrived → completed` direct path still works; `arrived → no_show/cancel` works; `in_session → no_show/cancel` works.
5. **`used_sessions` invariance** — assert before/after SQL: `arrived` and `in_session` transitions do not change `used_sessions`; only completed boundaries do.
6. **Conflict detection** — booking against an `arrived` or `in_session` slot is rejected.
7. **Doctor "Start Session" guard** — another doctor / receptionist / admin cannot call `startAppointmentSession` for an appointment they're not the assigned doctor on.
8. **Doctor dashboard** — fixtures producing rows in all four buckets; ordering and visibility correct; second doctor's data not visible; optional chime plays only after user interaction.
9. **Reception in-session board** — grouped by department, elapsed timer ticks, doctor name formatted.
10. **Reception medical notes** — can view + print; cannot see mutation controls; mutation server actions reject receptionist token even when called directly (RLS + `requireRole`).
11. **Delete restrictions** — UI hides delete for arrived/in_session/completed; DB trigger raises on direct deletes.
12. **Reports regression** — run all reports against fixtures cycling through arrived/in_session; totals unchanged.
13. **Playwright smoke** — receptionist confirms → arrives → doctor starts session → redirected to medical notes → receptionist completes with payment → invoice created.
14. **Types** — `supabase gen types typescript` after each enum/RPC migration; `pnpm tsc --noEmit` clean.

---

## 19. Migration / Rollout Order

1. Templates table + RLS (Migrations A, B).
2. Settings → Packages page + actions (Phase 1).
3. Refactor Add Package dialog (Phase 2).
4. Status DB layer: Migrations C-1, C-2, C-3 + conflict-trigger patches (Phase 3).
5. Arrived/In-session UI actions + role-aware buttons + Start Session redirect (Phase 4).
6. Doctor dashboard queues + optional chime (Phase 5).
7. Reception in-session board (Phase 6).
8. Reception read-only medical notes + print + Migration F (Phase 7).
9. Regenerate `types/database.ts` after each enum/RPC migration.

Each step is independently revertable; rollback in reverse order.

---

## 20. Risk Summary

| Risk | Severity | Mitigation |
|---|---|---|
| Slot conflict triggers ignore new statuses → double-booking | **High** | Grep audit + extend predicates in Migration C-2. |
| `undo_appointment_billing` not widened → silent state loss on undo | High | Extend in Migration C-2; covered by §18.4. |
| `ALTER TYPE ADD VALUE` in a transaction → migration fails | Medium | Isolated in Migration C-1. |
| `patient_packages.used_sessions` drift | High | Trigger is `completed`-only; regression test in §18.5. |
| Browser autoplay blocks sound / throws | Low–Medium | Gate on user interaction; try/catch; off by default; localStorage opt-in. |
| Start Session redirect race / popup blocker | Medium | Status update first; redirect after success; fallback link in toast on redirect failure. |
| Undo timing edge cases (double-click, network jitter) | Medium | Disable buttons while pending; idempotent server actions; guard via current-status filter. |
| Medical-note permission leakage (write surfaces exposed to receptionist) | **High** | RLS grants only `select`; mutation server actions keep `requireRole(["doctor","admin"])`; regression test attempts mutation as receptionist and asserts denial. |
| Reports inadvertently include arrived/in_session as billable | Medium | Audit report SQL; rerun report tests in §18.12. |
| Delete trigger blocks legitimate housekeeping | Low | Pending/confirmed delete still allowed; cancel path remains for arrived/in_session via existing cancel action. |
| Doctor sees other doctors' rows | Medium | RPC is `security invoker`; tested with two doctor accounts. |
| Template prefill overwrites user edits | Low | Confirm dialog on dirty form. |

---

## 21. Phased Implementation

### Phase 1 — Package Templates foundation *(already completed)*
**Rollback risk:** Low.
- **Create:**
  - `supabase/migrations/20260519000000_package_templates.sql`
  - `supabase/migrations/20260519001000_package_templates_rls.sql`
  - `actions/package-templates.ts`
  - `lib/validations/package-template.ts`
  - `app/(protected)/settings/packages/page.tsx`
  - `components/settings/packages/{packages-list,add-package-template-dialog,edit-package-template-dialog,package-template-row}.tsx`
- **Modify:** `components/settings/settings-nav.tsx`; regenerate `types/database.ts`.
- **DB changes:** new table `package_templates` + RLS only.
- **RLS/security:** admin-only mutation; clinic-scoped read.
- **Verification:** `supabase db reset && supabase db lint`; `pnpm tsc --noEmit`; manual admin CRUD; manager read-only; cross-clinic denied.
- **Edge cases:** dept FK on delete restrict — confirm cascade behavior when a department is removed.

### Phase 2 — Template-first Add Package dialog redesign
**Rollback risk:** Low.
- **Create:** none.
- **Modify:** `components/patients/add-package-dialog.tsx`.
- **DB changes:** none.
- **RLS/security:** unchanged.
- **Verification:** `pnpm tsc --noEmit && pnpm lint`; manual flow for patient with/without dept; custom fallback still creates a manual package.
- **Edge cases:** prefill vs dirty edits (confirm dialog); patient with no department; template that lacks price.

### Phase 3 — Status DB layer (arrived + in_session + transitions + undo RPCs + slot trigger updates)
**Rollback risk:** Medium–High (touches enum, transition guard, undo RPCs, slot conflict triggers, delete trigger).
- **Create:**
  - `supabase/migrations/20260519002000_add_in_visit_statuses.sql`
  - `supabase/migrations/20260519002500_in_visit_transitions_and_undo.sql`
  - `supabase/migrations/20260519003000_delete_restrictions.sql`
- **Modify:** `types/database.ts` (regenerate). Audit + edit slot/conflict triggers in existing migrations (only by adding a new migration that re-creates the functions — never edit historical files).
- **DB changes:** enum values, transition function, undo RPCs, slot conflict triggers, delete trigger, optional `in_session_started_at` column.
- **RLS/security:** new enum values inherit existing RLS; no policy edits needed for appointments. Add regression test that arrived/in_session rows are visible only to authorized roles.
- **Verification:**
  - `supabase db reset && supabase db lint`
  - SQL cycle full transition + undo matrix, asserting `used_sessions` deltas only on completed boundaries.
  - SQL: confirm slot conflict blocks bookings overlapping `arrived` or `in_session`.
  - SQL: direct `DELETE` on arrived/in_session/completed raises.
- **Edge cases:** transaction boundary on `ADD VALUE`; backward compatibility with existing pending/confirmed flows; `in_session_started_at` is null for historical rows.

### Phase 4 — Arrived/In-session UI actions
**Rollback risk:** Medium (touches appointment action paths and routing).
- **Create:** none.
- **Modify:**
  - `components/appointments/status-badge.tsx`
  - `components/appointments/appointment-actions.tsx`
  - `actions/appointments.ts` (add `arriveAppointment`, `startAppointmentSession`; widen `updateAppointmentStatus`, `undoAppointmentStatus`).
- **DB changes:** none.
- **RLS/security:** server-side guard that only the assigned doctor can `startAppointmentSession`.
- **Verification:** `pnpm tsc --noEmit && pnpm lint`; manual full happy path + undo at every step + same-status double-click test.
- **Edge cases:** redirect race; doctor undoing after navigation; receptionist not seeing the Start Session button; admin seeing receptionist controls but not the doctor-only Start Session button.

### Phase 5 — Doctor dashboard queues + optional sound notifications
**Rollback risk:** Low (additive UI + new RPC).
- **Create:**
  - `supabase/migrations/20260519004000_doctor_today_queue_rpc.sql`
  - `components/dashboard/doctor-today-queue.tsx`
  - `public/sounds/arrival.mp3` (asset added separately by ops)
- **Modify:** `actions/doctor-dashboard.ts` (add `fetchDoctorTodayQueue`); `components/dashboard/doctor-dashboard.tsx` (render queue above KPIs).
- **DB changes:** new RPC only.
- **RLS/security:** RPC is `security invoker`.
- **Verification:** `pnpm tsc --noEmit && pnpm lint`; two-doctor isolation test; chime plays only after first user interaction; chime toggle persists.
- **Edge cases:** browser autoplay; tab-throttled polling missing arrivals (use `visibilitychange` to force refresh on focus); offline/network failure during poll.

### Phase 6 — Reception dashboard in-session board
**Rollback risk:** Low (additive UI + optional new RPC).
- **Create:**
  - `supabase/migrations/20260519005000_reception_in_session_rpc.sql`
  - `components/dashboard/reception-in-session-board.tsx`
- **Modify:** `actions/reception-dashboard.ts` (or extend equivalent); reception dashboard page to render the new section.
- **DB changes:** new RPC only.
- **RLS/security:** RPC `security invoker`; admin/receptionist scope inherits.
- **Verification:** `pnpm tsc --noEmit && pnpm lint`; live elapsed timer ticks; grouping by department; cross-clinic isolation.
- **Edge cases:** zero in-session rows (empty state); clock drift between client/server; very long sessions (>1h) format correctly.

### Phase 7 — Reception read-only medical notes access + print
**Rollback risk:** Medium (touches RLS on a sensitive table; UI must hide mutation surfaces).
- **Create:**
  - `supabase/migrations/20260519006000_medical_notes_reception_read.sql`
  - Print stylesheet (if not already present): `app/(protected)/patients/[id]/medical-notes/print.css` or equivalent.
- **Modify:**
  - The medical-notes page component to render a read-only variant for receptionist role and to expose a Print button.
  - Audit `actions/medical-notes.ts` (or equivalent) and ensure every mutation has `requireRole(["doctor","admin"])`.
- **DB changes:** widen `select` policy to receptionist only.
- **RLS/security:** **never** widen write. Regression test that receptionist cannot insert/update/delete via SQL or server action.
- **Verification:** `pnpm tsc --noEmit && pnpm lint`; manual receptionist view + print; mutation attempts denied; doctor/admin behavior unchanged.
- **Edge cases:** attachments / file-storage RLS may also need a read grant; signed notes must remain immutable from any role; print stylesheet renders confidential watermark if existing UX requires it.

---

## 22. Preservation Notes (must not break)

- **Billing**: `complete_appointment_billing` is **not** modified. Phase 4 only changes the *origin* status (`arrived` or `in_session` allowed) — payload and downstream logic unchanged.
- **Invoices**: created via the same RPC path on `completed`. Untouched.
- **Deposits**: deposit fields (`deposit_amount`, `outstanding_amount`) untouched.
- **Reports**: only `completed` rows roll into revenue/completion metrics. `arrived` and `in_session` remain non-billable. Phase 3 verification + Phase-5/6/7 sanity checks confirm.
- **`patient_packages.used_sessions` trigger**: keyed strictly on `'completed'`. `arrived` and `in_session` are inert. Regression test required in Phase 3.
- **Conflict detection**: extend any slot/conflict predicates filtering by status to include `'arrived'` and `'in_session'`. Highest-risk omission — gated by Phase 3 verification.
- **Undo behavior**: same toast pattern, same 10-second duration. Three RPCs (`undo_appointment_status`, `undo_appointment_billing`, and any cancel/no_show undo path) gain new valid targets — no new client patterns.
- **Existing manual package CRUD**: Add Package dialog keeps a "Create custom" escape hatch; Edit dialog is not touched.
- **Existing dashboards**: doctor and reception KPI strips, filter chips, charts unchanged. New sections are rendered above.
- **Medical notes mutation surfaces**: unchanged for doctor/admin; receptionist gains only `select` + print.
- **Delete/cancel for pending/confirmed**: unchanged. Only arrived/in_session/completed deletion is newly restricted.

---

## 23. Recommendations / Alternatives

- **Defer `template_id` FK on `patient_packages`** to a future migration.
- **Keep both `price_per_session` and `total_price`** nullable.
- **Grant managers read access** to Settings → Packages (no mutation).
- For the doctor queue, the **RPC in Phase 5 is optional**; two RLS-scoped Supabase queries from the server action are acceptable at current scale.
- Consider an "Auto-arrive on check-in" clinic setting — out of scope.
- Consider exposing `in_session_started_at` in reports as an average-session-duration metric — out of scope for v1, but the column lays the groundwork.
- Sound notifications are best implemented as a small, dependency-free module so it can be unit-tested and reused on the reception board later if desired.

---

## 24. Out of Scope (explicit non-goals)

- Changing the billing RPC signature or payment flow.
- Adding new payment methods or invoice statuses.
- Refactoring the existing edit-package dialog.
- Introducing a `template_id` FK on `patient_packages`.
- Auto-cancelling `arrived` or `in_session` rows that never reach `completed`.
- Mobile push notifications for arrival events.
- Receptionist medical-note editing of any kind.
- Doctor-side billing controls.
