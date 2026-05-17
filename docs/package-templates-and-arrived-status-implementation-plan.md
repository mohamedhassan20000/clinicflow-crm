# Package Templates + Arrived Status + Doctor Dashboard Queue — Implementation Plan

> Status: **Planning document only** — no code, schema, or migrations have been changed.
> Scope: two additive features to ClinicFlow CRM.
>   1. Package Templates in **Settings**.
>   2. New **Arrived** appointment status + **Doctor dashboard queue** (today arrived/confirmed, tomorrow confirmed).
> Hard constraint: must not break billing, invoices, deposits, reports, the `patient_packages.used_sessions` trigger, appointment conflict detection, status undo behavior, or existing manual package CRUD.

---

## 1. Context & Goals

ClinicFlow already supports:
- Patient packages CRUD on the patient profile (manual Add Package dialog).
- A completed reports system (revenue, deposits, package usage, etc.).
- Appointment statuses: `pending → confirmed → completed | cancelled | no_show`.
- 10-second toast-based undo for status transitions.
- A DB trigger that increments/decrements `patient_packages.used_sessions` strictly on the `completed` transition.
- Billing & invoicing on completion via the `complete_appointment_billing` RPC.

We want to add:

**Feature 1 — Package Templates in Settings.** Admin defines reusable presets per department. The patient-profile Add Package dialog becomes template-driven (auto-select department from patient, filter dropdown by department, auto-fill fields), while preserving a manual-create fallback. Existing rows in `patient_packages` continue to work unchanged.

**Feature 2 — Arrived status + Doctor queue.** Insert an `arrived` status between `confirmed` and `completed`, with the same 10-second undo pattern. Add a doctor-dashboard section that shows today's arrived (top) + confirmed appointments and tomorrow's confirmed appointments, scoped to that doctor.

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

Key columns on `patient_packages`: `clinic_id, patient_id, department_id, service_id, name, total_sessions, used_sessions, price_per_session, notes, is_active, created_by, created_at, updated_at`. Constraint `used_sessions <= total_sessions`. No `package_templates` table exists today.

Patients table already carries a nullable `department_id` (baseline migration), suitable for auto-selecting the template department.

### 2.2 Settings
- Layout: `app/(protected)/settings/layout.tsx` gated by `requireRole(["admin","manager"])`.
- Nav: `components/settings/settings-nav.tsx` (staff / departments / services / insurance / clinic / customize, with `adminOnly` flag support).
- Closest mirror page: `app/(protected)/settings/services/page.tsx` (grouped by department, add dialog, soft-delete via trash section).
- Settings server actions: `actions/settings.ts`; validations: `lib/validations/settings.ts`.

### 2.3 Appointment status & transitions
- Enum `public.appointment_status` (`pending, confirmed, completed, cancelled, no_show`) defined at `supabase/migrations/20260504000000_baseline_schema.sql:15-21`.
- Transition guard `enforce_appointment_transition()` at same file lines 73-93:
  - `pending → confirmed | cancelled`
  - `confirmed → completed | cancelled | no_show`
- TypeScript status union mirrored at `types/database.ts:1753-1759`.
- Status badge palette: `components/appointments/status-badge.tsx`.
- Action buttons + 10s undo toasts: `components/appointments/appointment-actions.tsx` (`runComplete` ~L261, `runNoShow`, `runCancel`).
- Server actions: `actions/appointments.ts` — `updateAppointmentStatus`, `cancelAppointment`, `undoAppointmentStatus` (wraps RPC), `undoInvoiceCompletion` (wraps `undo_appointment_billing`).
- Undo for non-completed transitions: `supabase/migrations/20260517000000_undo_appointment_status_rpc.sql` — currently accepts only `'pending'|'confirmed'` as target.
- Completion billing RPC: `supabase/migrations/20260506050000_transactional_billing_and_settlement_rpcs.sql` (`complete_appointment_billing`).
- `patient_packages.used_sessions` sync trigger: `supabase/migrations/20260518000000_patient_packages.sql:86-185`. **It only mutates when entering or leaving `'completed'`** — `arrived` is inert by construction, provided we never accidentally branch on it.
- Slot/conflict triggers to audit for the `arrived` value:
  - `supabase/migrations/20260512130000_fix_doctor_slot_cancelled_noshow.sql`
  - `supabase/migrations/20260514150033_allow_pending_same_slot.sql`
  - `supabase/migrations/20260516000000_allow_pending_same_slot.sql`
- Conflict detection in TS: `getConflictingPendingAppointments` / `checkSameDayPatient` in `actions/appointments.ts`.

### 2.4 Doctor dashboard
- Page: `app/(protected)/dashboard/page.tsx` (role-routes to doctor variant ~L537-560).
- Component: `components/dashboard/doctor-dashboard.tsx` (filter modes today/week/month/custom, KPI cards) + dynamic `doctor-dashboard-charts`.
- Stats action: `actions/doctor-dashboard.ts` (`fetchDoctorDashboardStats`).
- Doctor-scoped appointment RLS: `supabase/migrations/20260505220000_scope_patient_and_appointment_rls_for_doctors.sql`.

---

## 3. Database Changes (Required Migrations)

Use the existing naming convention `YYYYMMDDHHMMSS_description.sql`, with timestamps **after** the last existing migration (`20260518002000_reports_rpcs.sql`).

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

-- Optional audit trigger mirroring patient_packages
```
Decision notes:
- `department_id` is **required** (drives the patient-profile dialog filter).
- Keep both `price_per_session` and `total_price` as nullable; admins fill the one that maps to how they price.
- **Do not** add a `template_id` FK on `patient_packages` in v1 — keeps the change reversible. Add later if analytics need it.

### Migration B — `20260519001000_package_templates_rls.sql`
- `read`: any authenticated user where `clinic_id = public.auth_clinic_id()`.
- `insert/update`: `admin` only.
- `delete`: `admin` only (UI prefers soft-delete via `is_active = false`).

### Migration C — `20260519002000_add_arrived_status.sql`
Postgres requires `ALTER TYPE … ADD VALUE` to run **outside a transaction**. Therefore split as:
- `20260519002000_add_arrived_status.sql` — only `alter type public.appointment_status add value if not exists 'arrived' after 'confirmed';`
- `20260519002500_arrived_status_transitions.sql` — recreate `enforce_appointment_transition()` to allow:
  - `confirmed → arrived | completed | cancelled | no_show`
  - `arrived → completed | confirmed | cancelled | no_show`
- Extend `public.undo_appointment_status(uuid, text)` so its target-status whitelist includes `'arrived'`.
- Extend `public.undo_appointment_billing(uuid, text)` so its target-status whitelist includes `'arrived'` (verify exact arg name in current RPC during impl).
- Audit and patch slot/conflict triggers in `20260512130000_fix_doctor_slot_cancelled_noshow.sql` and the `allow_pending_same_slot` family — wherever a `status in ('confirmed',…)` predicate exists, add `'arrived'` so an arrived slot still blocks double-booking.

### Migration D — `20260519003000_doctor_today_queue_rpc.sql` (recommended, optional)
RPC `public.doctor_today_queue(p_doctor_id uuid, p_tz text default 'Europe/Istanbul')` returning today's arrived + confirmed and tomorrow's confirmed in a single round trip. Use `security invoker` so existing doctor RLS still applies.

---

## 4. UI Changes

### 4.1 Settings → Packages
- New route: `app/(protected)/settings/packages/page.tsx` (mirror `app/(protected)/settings/services/page.tsx`).
- New components:
  - `components/settings/packages/packages-list.tsx`
  - `components/settings/packages/add-package-template-dialog.tsx`
  - `components/settings/packages/edit-package-template-dialog.tsx`
  - `components/settings/packages/package-template-row.tsx`
- Nav entry added to `components/settings/settings-nav.tsx` (after Services), `adminOnly: true`.
- Group templates by department; soft-delete via `is_active = false`; trash section mirrors departments/services.

### 4.2 Patient profile Add Package dialog (rewrite)
- File: `components/patients/add-package-dialog.tsx`.
- Template-first flow:
  1. **Department select** — defaults to `patient.department_id` if present, locked when patient has a department.
  2. **Template select** — filtered by selected department and `is_active = true`.
  3. **Auto-fill** on template choice: `name`, `total_sessions`, `price_per_session` (or `total_price`), `notes`, `department_id`.
  4. **Locked fields** when a template is chosen: `total_sessions`, `department_id`. (Recommendation — keeps reports consistent.)
  5. **Editable fields** even after template choice: `price_per_session`, `notes`.
  6. **"Create custom"** link toggles back to the existing manual form (preserves current behavior).
- Submission keeps calling `createPatientPackage`; **no payload shape change**.
- Edit dialog (`edit-package-dialog.tsx`) is **not** modified — existing patient packages continue to render and edit normally.

### 4.3 Status badge & appointment action buttons
- `components/appointments/status-badge.tsx`: add `arrived` with sky/indigo palette (distinct from `confirmed` blue and `completed` emerald).
- `components/appointments/appointment-actions.tsx`:
  - Add `showArrive = effectiveStatus === "confirmed"`.
  - Add `"Arrive"` button → `runArrive` (mirrors `runNoShow` — optimistic + 10s undo toast that calls `undoAppointmentStatus(id, "confirmed")`).
  - Change `showComplete` to `effectiveStatus === "confirmed" || effectiveStatus === "arrived"`.
  - In `runComplete`, set `undoTarget = prevStatus === "arrived" ? "arrived" : "confirmed"`.
  - In `runCancel`/`runNoShow`, allow these from `arrived` too (just include `arrived` in `showCancel`/`showNoShow` conditions).

### 4.4 Doctor dashboard queue
- New: `components/dashboard/doctor-today-queue.tsx` rendered **above** the existing KPI strip in `components/dashboard/doctor-dashboard.tsx`. Existing widgets remain unchanged.
- Layout: two-column on `lg+`, stacked on mobile.
  - **Today** — arrived rows first (sky highlight) sorted by arrival time, then confirmed sorted by scheduled time.
  - **Tomorrow — Confirmed** — sorted by scheduled time.
- Row: scheduled time, patient name, service, status badge, quick link to appointment.
- Empty states: muted "No appointments" text.
- Refresh: on focus + after any status mutation (`router.refresh()` or invalidate the cached fetcher).

---

## 5. Server Actions / RPC Changes

| File | Change |
|---|---|
| New `actions/package-templates.ts` | `createPackageTemplate`, `updatePackageTemplate`, `deactivatePackageTemplate`, `restorePackageTemplate`. Admin only. |
| New `lib/validations/package-template.ts` | Zod schemas mirroring patient-package validators (preprocess `emptyToNull`, share `positiveInteger`). |
| `actions/appointments.ts` | Add `arriveAppointment(id)` wrapping `updateAppointmentStatus(id, "arrived")`. Extend `updateAppointmentStatus` switch to accept `"arrived"`. Extend `undoAppointmentStatus` action to accept `"arrived"` target. |
| `actions/doctor-dashboard.ts` | Add `fetchDoctorTodayQueue(doctorId)` → `{ todayArrived, todayConfirmed, tomorrowConfirmed }`. May call new RPC or run two RLS-scoped queries. |
| `types/database.ts` | Regenerate via `supabase gen types`; in the meantime add `"arrived"` manually to keep TS green. |

---

## 6. Validation Rules

### Package template
- `name`: string 1-120.
- `department_id`: required UUID, must belong to caller's clinic.
- `total_sessions`: integer 1-10000.
- `price_per_session`: optional decimal ≥ 0 (max 99_999_999.99).
- `total_price`: optional decimal ≥ 0 (max 99_999_999.99).
- `notes`: optional, ≤ 500 chars.
- `is_active`: boolean (defaults true).
- Either `price_per_session` or `total_price` may be null; UI shows whichever is set.

### Add Package (from template)
- Re-runs the existing `createPatientPackageSchema` — no new server-side validation.
- Client guard: when a template is chosen, the dept select is read-only and equals the template's department.

### Status transitions (server + DB)
- DB guard updated as in §3 Migration C; server-side wrappers reject unsupported transitions before hitting DB.
- `arriveAppointment` requires role `admin` or `receptionist` (mirrors current confirm/complete actions).

---

## 7. Status Transition Design (post-change)
```
pending     → confirmed | cancelled
confirmed   → arrived | completed | cancelled | no_show
arrived     → completed | confirmed (undo) | cancelled | no_show
completed   → (terminal; undo via undo_appointment_billing → confirmed or arrived)
cancelled   → (undo via undo_appointment_status → pending|confirmed)
no_show     → (undo via undo_appointment_status → confirmed)
```

---

## 8. Undo Behavior Design

Same toast UX (`duration: 10000`) as all existing undos; no new timing constants.

| Action | Server call | Notes |
|---|---|---|
| Arrive → Undo | `undoAppointmentStatus(id, "confirmed")` | Requires `undo_appointment_status` RPC widened to accept `"arrived"` rollback (target `"confirmed"`). |
| Complete (from arrived) → Undo | `undoInvoiceCompletion(id, "arrived")` | Requires `undo_appointment_billing` RPC widened to accept `"arrived"` target. |
| Complete (from confirmed) → Undo | `undoInvoiceCompletion(id, "confirmed")` | Existing flow, unchanged. |
| Cancel / No-show from arrived | Same RPCs as today | Rollback target = `"confirmed"` (no need to land on `"arrived"`). |

---

## 9. Doctor Dashboard Behavior

- Section heading **"My queue"** above existing KPIs.
- Two cards:
  - **Today** — arrived rows first (sky highlight), then confirmed (default).
  - **Tomorrow — Confirmed** — confirmed only.
- Scope: doctor sees only their own rows (RLS-enforced — no client-side trust).
- Timezone: reuse the `Europe/Istanbul` constant already in `doctor-dashboard.tsx` (or wire to clinic timezone if available).
- Auto-refresh on focus + after `Arrive`/`Complete` actions.
- Empty card → "No appointments today/tomorrow".
- **Existing KPI strip, filter chips, and charts remain untouched.**

---

## 10. Package Template Lifecycle

1. **Create** — admin in Settings → Packages → Add template (department required).
2. **Edit** — admin updates name, sessions, price, notes. Editing a template does **not** retroactively touch `patient_packages` rows already created from it.
3. **Deactivate (soft)** — toggle `is_active = false`. Hidden from Add Package dialog but kept for audit; appears in trash/inactive section.
4. **Restore** — flip back to `is_active = true`.
5. **Hard delete** — admin only via trash section (RLS allows admin delete). Use sparingly; reports may reference template by name not FK in v1.

---

## 11. RLS / Security Considerations

- `package_templates`: read = clinic members; insert/update/delete = admin only.
- Doctors will be able to **read** templates (RLS allows), but they have no UI surface to mutate; the patient-profile Add Package dialog remains gated to admin/receptionist by `requireRole`.
- `arrived` enum value is automatically covered by existing doctor-scoped appointment RLS — no policy edits needed for that table.
- New RPC `doctor_today_queue` uses `security invoker` to inherit RLS; never `security definer`.
- **Grep audit before merge**: any RLS or trigger predicate hardcoding `status in ('pending','confirmed','completed','cancelled','no_show')` must be widened to include `'arrived'`.

---

## 12. Edge Cases

- `ALTER TYPE … ADD VALUE` cannot run inside a transaction → split into its own migration (Migration C-1).
- Slot conflict triggers must treat `'arrived'` as "active" — top risk; missing this lets double-booking at arrival.
- `undo_appointment_billing` not extended for `'arrived'` → undo of complete-from-arrived silently lands on `'confirmed'`, losing state.
- Template prefill clashing with dirty user edits → if the user has modified fields and reselects another template, show a confirm dialog before overwriting.
- Repeated status flips between `confirmed ↔ arrived ↔ completed` must not leak `used_sessions`. Trigger guards on `'completed'` only, but regression test is required.
- Reports must continue to treat only `completed` as billable — verify no report query buckets `arrived` into completion totals.
- Patient with no `department_id` → Add Package dialog falls back to manual department choice.
- Template with both `price_per_session` and `total_price` set → UI prefers `price_per_session` and shows the derived total as a hint; document precedence.
- Existing `patient_packages` rows without a department continue to render normally.
- Timezone drift around midnight: compute today/tomorrow boundaries in clinic TZ, not server TZ.

---

## 13. Testing Strategy

1. **Migrations** — `supabase db reset` locally; verify enum has `'arrived'`, transition guard updated, RPCs accept `'arrived'`, package_templates table + RLS present.
2. **Templates CRUD** — admin can create/edit/deactivate/restore; manager cannot mutate; cross-clinic read denied (RLS smoke).
3. **Add Package dialog** — patient with dept auto-selects; dropdown filtered; prefill works; locked fields enforced; "Create custom" fallback creates a manual package; submission writes to `patient_packages`.
4. **Status flow** — `confirmed → arrived` button works; undo within 10s reverts; `arrived → completed` runs billing; undo restores `arrived`; cancel/no_show from arrived works; assert `used_sessions` only changes on `completed` transitions (SQL before/after).
5. **Conflict detection** — booking against an `arrived` slot is rejected exactly like an `arrived/confirmed` slot.
6. **Doctor dashboard** — fixture with 2 confirmed today + 1 arrived today + 2 confirmed tomorrow → ordering and visibility correct; second doctor's data not visible.
7. **Reports** — re-run revenue / package / completion reports; totals unchanged (arrived is not billable).
8. **Playwright smoke** — login as receptionist, confirm → arrive → complete → assert invoice; login as doctor, confirm queue contents.
9. **Type regen** — `supabase gen types typescript` after each enum/RPC migration; `pnpm tsc --noEmit` clean.

---

## 14. Migration / Rollout Order
1. Templates table + RLS (Migrations A, B).
2. Settings → Packages page + actions.
3. Refactor Add Package dialog to template-first with custom fallback.
4. Enum value migration (C-1) and transition/undo RPC widening (C-2). Audit + patch slot conflict triggers.
5. Status badge + appointment-actions updates (Arrive button + completion undo target).
6. Doctor queue RPC (Migration D) + UI component.
7. Regenerate `types/database.ts` after each enum/RPC migration.

Each step is independently revertable; rollback in reverse order.

---

## 15. Risks Summary

| Risk | Severity | Mitigation |
|---|---|---|
| Slot conflict triggers ignore `'arrived'` → double-booking | **High** | Grep audit + extend predicates in dedicated migration. Tested in §13.5. |
| `undo_appointment_billing` not widened → silent state loss on undo | High | Extend RPC in Migration C-2; covered by §13.4. |
| `ALTER TYPE ADD VALUE` in transaction → migration fails | Medium | Split into its own migration. |
| Template prefill overwrites user edits | Low | Confirm dialog on dirty form. |
| Reports inadvertently include `arrived` as billable | Medium | Audit report SQL; rerun report tests in §13.7. |
| `patient_packages.used_sessions` drift | High | Trigger is `completed`-only; add regression test cycling statuses. |
| Doctor sees other doctors' rows | Medium | RPC is `security invoker`; tested with two doctor accounts. |

---

## 16. Phased Implementation

Each phase is independently shippable. Verification commands are illustrative (`pnpm` is the package manager in this repo).

### Phase 1 — Package Templates foundation
**Rollback risk:** Low.
- **Create:**
  - `supabase/migrations/20260519000000_package_templates.sql`
  - `supabase/migrations/20260519001000_package_templates_rls.sql`
  - `actions/package-templates.ts`
  - `lib/validations/package-template.ts`
  - `app/(protected)/settings/packages/page.tsx`
  - `components/settings/packages/packages-list.tsx`
  - `components/settings/packages/add-package-template-dialog.tsx`
  - `components/settings/packages/edit-package-template-dialog.tsx`
  - `components/settings/packages/package-template-row.tsx`
- **Modify:**
  - `components/settings/settings-nav.tsx` — add Packages entry.
  - `types/database.ts` — regenerate.
- **DB changes:** new table `package_templates` + RLS only. Nothing else touched.
- **Verification:**
  - `supabase db reset && supabase db lint`
  - `pnpm tsc --noEmit`
  - Manual: admin can CRUD; manager read-only; cross-clinic denied.

### Phase 2 — Add Package dialog redesign
**Rollback risk:** Low (single dialog component; manual fallback preserved).
- **Create:** none.
- **Modify:**
  - `components/patients/add-package-dialog.tsx` — template-first flow + custom fallback.
- **DB changes:** none.
- **Verification:**
  - `pnpm tsc --noEmit && pnpm lint`
  - Manual: patient with dept → auto-selects; dropdown filtered; prefill & locked fields work; custom fallback still creates a package.
  - Existing edit dialog unchanged; existing rows render normally.

### Phase 3 — Arrived status DB layer
**Rollback risk:** Medium (touches enum + transition guard + RPCs).
- **Create:**
  - `supabase/migrations/20260519002000_add_arrived_status.sql` (only `ALTER TYPE ADD VALUE`).
  - `supabase/migrations/20260519002500_arrived_status_transitions.sql` (replace `enforce_appointment_transition`; widen `undo_appointment_status` + `undo_appointment_billing`; patch slot conflict triggers).
- **Modify:**
  - `types/database.ts` — regenerate.
- **DB changes:** enum + transition function + undo RPCs + slot conflict triggers.
- **Verification:**
  - `supabase db reset && supabase db lint`
  - SQL: cycle `pending → confirmed → arrived → completed → undo → arrived → completed`, asserting `used_sessions` deltas only on completed boundaries.
  - SQL: confirm slot conflict blocks bookings overlapping `arrived` rows.

### Phase 4 — Arrived status UI
**Rollback risk:** Low–Medium (touches appointment action paths).
- **Create:** none.
- **Modify:**
  - `components/appointments/status-badge.tsx` — add `arrived` palette.
  - `components/appointments/appointment-actions.tsx` — add Arrive button, `runArrive`, update `runComplete` `undoTarget`, broaden cancel/no-show conditions.
  - `actions/appointments.ts` — add `arriveAppointment`, accept `"arrived"` in `updateAppointmentStatus` + `undoAppointmentStatus`.
- **DB changes:** none.
- **Verification:**
  - `pnpm tsc --noEmit && pnpm lint`
  - Manual: confirm → arrive → undo → re-arrive → complete → undo (lands on arrived) → complete → cancel from arrived works.

### Phase 5 — Doctor dashboard queue
**Rollback risk:** Low (purely additive UI).
- **Create:**
  - `supabase/migrations/20260519003000_doctor_today_queue_rpc.sql` (optional RPC).
  - `components/dashboard/doctor-today-queue.tsx`.
- **Modify:**
  - `actions/doctor-dashboard.ts` — add `fetchDoctorTodayQueue`.
  - `components/dashboard/doctor-dashboard.tsx` — render queue above KPI strip; keep all existing widgets.
- **DB changes:** optional RPC only.
- **Verification:**
  - `pnpm tsc --noEmit && pnpm lint`
  - Manual: two doctors with overlapping schedules — each sees only their own; arrived rows on top of today's; tomorrow card populated correctly.
  - Refresh on focus + after Arrive/Complete actions confirmed.

---

## 17. Preservation Notes (must not break)

- **Billing**: `complete_appointment_billing` is **not** modified. Phase 4 only changes the *origin* status (`arrived` allowed) — payload and downstream logic unchanged.
- **Invoices**: created via the same RPC path on `completed`. Untouched.
- **Deposits**: deposit fields (`deposit_amount`, `outstanding_amount`) are not touched in any of the new code paths.
- **Reports**: only `completed` rows roll into revenue/completion metrics. `arrived` must remain non-billable. Phase 3 verification + Phase-5 sanity check both confirm.
- **`patient_packages.used_sessions` trigger**: keyed strictly on `'completed'`. `arrived` is inert. Add a regression test in Phase 3.
- **Conflict detection**: extend any slot/conflict predicates that filter by status to include `'arrived'`. This is the highest-risk omission — gated by Phase 3 verification SQL.
- **Undo behavior**: same toast pattern, same 10-second duration. Two RPCs (`undo_appointment_status`, `undo_appointment_billing`) gain `'arrived'` as a valid target — no new client patterns.
- **Existing manual package CRUD**: Add Package dialog keeps a "Create custom" escape hatch; Edit dialog is not touched.
- **Existing doctor dashboard**: KPI strip, filter chips, charts unchanged. Queue is rendered above them.

---

## 18. Recommendations / Alternatives

- **Defer `template_id` FK on `patient_packages`** to a future migration. Keeps Phase 1 trivially reversible.
- **Keep both `price_per_session` and `total_price`** nullable rather than picking one — admins price differently across departments.
- **Grant managers read access** to Settings → Packages (no mutation), matching their tier elsewhere.
- For the doctor queue, the **RPC in Phase 5 is optional**; two RLS-scoped Supabase queries from the server action are acceptable at current scale. Promote to RPC if the page renders > 2 round trips' worth of latency.
- After Phase 5 stabilizes, consider an "Auto-arrive on check-in" toggle in clinic settings — out of scope here.

---

## 19. Out of Scope (explicit non-goals)

- Changing the billing RPC signature or payment flow.
- Adding new payment methods or invoice statuses.
- Refactoring the existing edit-package dialog.
- Introducing a `template_id` FK on `patient_packages`.
- Auto-cancelling `arrived` rows that never reach `completed`.
- Mobile push notifications for arrival events.
