# ClinicFlow CRM — Reports Page + Patient Session Packages
## Full Implementation Plan

---

## Context

ClinicFlow is a multi-tenant medical clinic CRM on Next.js App Router + TypeScript + Supabase. The system already has appointments (status: pending/confirmed/completed/cancelled/no_show), patients, follow-ups (outcome: all_fine/has_problem/no_response), revenue, deposits, invoices, and a role-based page-visibility customization system.

Two features are being added:

1. A new **Reports page** with 6 analytical reports, shared date-range filters, and print support.
2. A **Patient Session Packages** system that links appointment bookings to pre-purchased session bundles.

Neither feature is implemented yet. No existing logic, RLS, tests, or workflows should break.

---

## Current System Findings

### App Structure

```
app/(protected)/
├── dashboard/
├── patients/
│   └── [id]/
│       ├── appointments-report/
│       ├── followups-report/
│       └── medical-notes-report/
├── appointments/
│   └── new/
├── followups/
├── revenue/
└── settings/
    ├── staff/
    ├── departments/
    ├── services/
    ├── insurance/
    ├── clinic/
    └── customize/       ← page-visibility customizer (primary admin only)
```

### Roles & Access Control

- Roles: `"admin" | "receptionist" | "manager" | "doctor"` (enum in `types/database.ts`)
- All checks are **server-side** via `requireUser()` / `requireRole()` in `lib/rbac.ts`
- No client-side role hooks exist
- `AuthedUser`: `{ id, email, role, fullName, avatarUrl, clinicId, departmentId, mustChangePassword }`

### Page Slug / Visibility System

- `PageSlug` type in `lib/page-permissions.ts`:
  `"dashboard" | "patients" | "appointments" | "followups" | "revenue" | "settings"`
- `ROLE_PAGE_SLUGS` controls which slugs each role can access
- `getPageSlugFromPath(pathname)` maps URL path → slug
- `user_page_permissions` table: `(clinic_id, user_id, page_slug, is_visible, created_at, updated_at)`
- Primary admin toggles per-staff visibility in `/settings/customize` via `saveUserPageVisibilityChanges()` server action
- Middleware reads visibility from DB, caches in `cf_page_visibility` cookie
- `PROTECTED_PREFIXES` in `lib/supabase/middleware.ts`:
  `/dashboard`, `/patients`, `/appointments`, `/followups`, `/revenue`, `/settings`, `/profile`
- Sidebar: `buildNav(role, visiblePages)` → `getRolePages(role)` filtered by `visiblePages`
- The Customize UI dynamically renders toggles for all pages in `PAGE_DEFINITIONS` for a given role — adding a new entry there is sufficient for it to appear in the customizer automatically

### Print System

- `PrintHeader` component: reusable clinic letterhead (logo, name, address, phone, timestamp)
- `window.print()` called via double `requestAnimationFrame` for DOM readiness
- CSS classes for selective hiding (`print:hidden` Tailwind variants + custom `data-printing` body attribute)
- Full working example: `components/revenue/revenue-report.tsx` (886 lines)

### Existing Reusable RPCs

- `get_revenue_summary(p_start, p_end, doctor_id?, department_id?, patient_ids?)` → JSON (gross totals + method breakdown + transaction list)
- `get_followups_dashboard(p_start, p_end, outcome?, pending_limit?, done_limit?, ...)` → JSON with `summary.completedCount`, `summary.allFineCount`, `summary.hasProblemCount`, `summary.noResponseCount`

### Appointment Statuses

`pending | confirmed | completed | cancelled | no_show`

Relevant columns: `scheduled_at`, `status`, `doctor_id`, `department_id`, `patient_id`, `total_amount`, `paid_amount`, `secondary_amount`, `insurance_amount`, `created_by`, `cancelled_at`, `no_showed_at`, `deleted_at`

### Follow-up Outcomes

`all_fine | has_problem | no_response` — tracked via `recorded_at`, `recorded_by`

### Key Existing Tables

`appointments`, `patients`, `profiles`, `departments`, `follow_ups`, `patient_deposits`, `outstanding_settlements`, `services`, `insurance_providers`, `user_page_permissions`, `audit_logs`

### No Packages Table Exists

No `patient_packages` or session-tracking table exists yet.

---

## Existing Reusable Logic / Components

| Item | Location | Reuse For |
|------|----------|-----------|
| `PrintHeader` component | `components/revenue/revenue-report.tsx` (inline) | All report print headers — extract to `components/shared/print-header.tsx` if not already standalone |
| `get_revenue_summary` RPC | Supabase DB function | Revenue report section in Reports page |
| `get_followups_dashboard` RPC | Supabase DB function | Follow-ups report (summary fields only, pass `p_done_limit: 0`) |
| `requireRole()` / `requireUser()` | `lib/rbac.ts` | Reports page access gate |
| `getVisiblePageSlugs()` | `lib/server-page-permissions.ts` | Automatic — works once slug is added to PAGE_DEFINITIONS |
| `saveUserPageVisibilityChanges()` | `actions/page-permissions.ts` | Automatic — works once slug is registered |
| `PAGE_DEFINITIONS` array | `lib/page-permissions.ts` | Auto-adds to customizer once new entry is added |
| `listStaffPagePermissions()` | `actions/page-permissions.ts` | Auto-surfaces in the customize UI |
| Date helpers (`resolveRange`, timezone logic) | `app/(protected)/revenue/page.tsx` | Extract to shared `lib/date-range.ts` |
| Skeleton / loading patterns | Various `loading.tsx` files | Reports `loading.tsx` |
| Zod validation schemas | `lib/validations/appointment.ts` | Extend for `package_id` field |
| `appointment-payment-row.tsx` | `components/patients/` | Extend to show package chip/badge |

---

## Proposed Database Changes

### Migration 1: `supabase/migrations/20260518000000_patient_packages.sql`

```sql
-- New table
CREATE TABLE IF NOT EXISTS public.patient_packages (
  id                uuid          DEFAULT gen_random_uuid() PRIMARY KEY,
  clinic_id         uuid          NOT NULL REFERENCES public.clinics(id) ON DELETE CASCADE,
  patient_id        uuid          NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,
  service_id        uuid          REFERENCES public.services(id) ON DELETE SET NULL,
  department_id     uuid          REFERENCES public.departments(id) ON DELETE SET NULL,
  name              text          NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  total_sessions    integer       NOT NULL CHECK (total_sessions > 0),
  used_sessions     integer       NOT NULL DEFAULT 0 CHECK (used_sessions >= 0),
  price_per_session numeric(12,2) CHECK (price_per_session >= 0),
  notes             text          CHECK (char_length(notes) <= 500),
  is_active         boolean       NOT NULL DEFAULT true,
  created_by        uuid          REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at        timestamptz   NOT NULL DEFAULT now(),
  updated_at        timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT used_le_total CHECK (used_sessions <= total_sessions)
);

-- Indexes
CREATE INDEX idx_patient_packages_patient ON public.patient_packages (patient_id);
CREATE INDEX idx_patient_packages_clinic  ON public.patient_packages (clinic_id);

-- updated_at trigger (reuses existing set_updated_at function)
CREATE TRIGGER touch_patient_packages_updated_at
  BEFORE UPDATE ON public.patient_packages
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- FK columns on appointments (nullable, backwards-compatible)
ALTER TABLE public.appointments
  ADD COLUMN IF NOT EXISTS package_id             uuid    REFERENCES public.patient_packages(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS package_session_number integer CHECK (package_session_number > 0);

CREATE INDEX idx_appointments_package_id ON public.appointments (package_id)
  WHERE package_id IS NOT NULL;

-- Trigger: sync used_sessions when appointment status changes to/from completed
CREATE OR REPLACE FUNCTION public.sync_package_session_on_appt_status()
RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
BEGIN
  -- completed transition → increment
  IF NEW.status = 'completed' AND OLD.status <> 'completed' AND NEW.package_id IS NOT NULL THEN
    UPDATE public.patient_packages
    SET used_sessions = used_sessions + 1, updated_at = now()
    WHERE id = NEW.package_id AND used_sessions < total_sessions;
  END IF;
  -- undo completion → decrement
  IF OLD.status = 'completed' AND NEW.status <> 'completed' AND NEW.package_id IS NOT NULL THEN
    UPDATE public.patient_packages
    SET used_sessions = GREATEST(0, used_sessions - 1), updated_at = now()
    WHERE id = NEW.package_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_package_session_on_appt_status ON public.appointments;
CREATE TRIGGER trg_package_session_on_appt_status
  AFTER UPDATE OF status ON public.appointments
  FOR EACH ROW EXECUTE FUNCTION public.sync_package_session_on_appt_status();
```

### Migration 2: `supabase/migrations/20260518001000_patient_packages_rls.sql`

```sql
ALTER TABLE public.patient_packages ENABLE ROW LEVEL SECURITY;

-- All clinic members can read packages for their clinic
CREATE POLICY "clinic_members_read_packages"
  ON public.patient_packages FOR SELECT
  USING (clinic_id = public.auth_clinic_id());

-- Admin + receptionist can insert
CREATE POLICY "admin_receptionist_insert_packages"
  ON public.patient_packages FOR INSERT
  WITH CHECK (
    clinic_id = public.auth_clinic_id()
    AND public.auth_role() IN ('admin', 'receptionist')
  );

-- Admin + receptionist can update
CREATE POLICY "admin_receptionist_update_packages"
  ON public.patient_packages FOR UPDATE
  USING (
    clinic_id = public.auth_clinic_id()
    AND public.auth_role() IN ('admin', 'receptionist')
  )
  WITH CHECK (clinic_id = public.auth_clinic_id());

-- Admin can hard-delete (soft-deactivate is the preferred path)
CREATE POLICY "admin_delete_packages"
  ON public.patient_packages FOR DELETE
  USING (
    clinic_id = public.auth_clinic_id()
    AND public.auth_role() = 'admin'
  );

GRANT ALL ON public.patient_packages TO authenticated, service_role;
```

### Migration 3: `supabase/migrations/20260518002000_reports_rpcs.sql`

All four RPCs use `SECURITY INVOKER` so table RLS stays in force. They also enforce role checks internally as a second layer of defence.

```sql
-- Performance indexes for report queries
CREATE INDEX IF NOT EXISTS idx_appt_clinic_scheduled_status_doctor
  ON public.appointments (clinic_id, scheduled_at, status, doctor_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_followups_clinic_recorded_outcome
  ON public.follow_ups (clinic_id, recorded_at, outcome);

-- ── RPC 1: Cancellation Report ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_cancellation_report(
  p_start timestamptz,
  p_end   timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER
SET search_path = public, pg_temp AS $$
DECLARE
  v_clinic uuid            := public.auth_clinic_id();
  v_role   public.user_role := public.auth_role();
BEGIN
  IF auth.uid() IS NULL OR v_clinic IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;
  IF v_role = 'doctor' THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;

  RETURN (
    WITH base AS (
      SELECT id, status, cancellation_reason, doctor_id, patient_id
      FROM public.appointments
      WHERE clinic_id = v_clinic AND deleted_at IS NULL
        AND scheduled_at >= p_start AND scheduled_at <= p_end
    ),
    totals AS (
      SELECT COUNT(*)                                      AS total_appointments,
             COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled_count
      FROM base
    ),
    by_doctor AS (
      SELECT a.doctor_id,
             pr.full_name                                      AS doctor_name,
             COUNT(*)                                          AS total,
             COUNT(*) FILTER (WHERE a.status = 'cancelled')   AS cancelled
      FROM base a
      JOIN public.profiles pr ON pr.id = a.doctor_id
      GROUP BY a.doctor_id, pr.full_name
    ),
    by_reason AS (
      SELECT cancellation_reason AS reason, COUNT(*) AS cnt
      FROM base WHERE status = 'cancelled' AND cancellation_reason IS NOT NULL
      GROUP BY cancellation_reason ORDER BY cnt DESC LIMIT 10
    )
    SELECT jsonb_build_object(
      'totalAppointments', t.total_appointments,
      'cancelledCount',    t.cancelled_count,
      'cancellationRate',
        CASE WHEN t.total_appointments = 0 THEN 0
             ELSE ROUND((t.cancelled_count::numeric / t.total_appointments) * 100, 1)
        END,
      'byDoctor', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'doctorId',   d.doctor_id,
          'doctorName', d.doctor_name,
          'total',      d.total,
          'cancelled',  d.cancelled,
          'rate', CASE WHEN d.total = 0 THEN 0
                       ELSE ROUND((d.cancelled::numeric / d.total) * 100, 1) END
        ) ORDER BY d.cancelled DESC) FROM by_doctor d
      ), '[]'::jsonb),
      'byReason', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('reason', r.reason, 'count', r.cnt))
        FROM by_reason r
      ), '[]'::jsonb)
    ) FROM totals t
  );
END;
$$;

-- ── RPC 2: No-Show Report ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_no_show_report(
  p_start timestamptz,
  p_end   timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER
SET search_path = public, pg_temp AS $$
DECLARE
  v_clinic uuid            := public.auth_clinic_id();
  v_role   public.user_role := public.auth_role();
BEGIN
  IF auth.uid() IS NULL OR v_clinic IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;
  IF v_role = 'doctor' THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;

  RETURN (
    WITH base AS (
      SELECT id, status, no_show_reason, doctor_id, patient_id
      FROM public.appointments
      WHERE clinic_id = v_clinic AND deleted_at IS NULL
        AND scheduled_at >= p_start AND scheduled_at <= p_end
    ),
    totals AS (
      SELECT COUNT(*)                                      AS total_appointments,
             COUNT(*) FILTER (WHERE status = 'no_show')   AS no_show_count
      FROM base
    ),
    by_doctor AS (
      SELECT a.doctor_id,
             pr.full_name                                     AS doctor_name,
             COUNT(*)                                         AS total,
             COUNT(*) FILTER (WHERE a.status = 'no_show')    AS no_show
      FROM base a
      JOIN public.profiles pr ON pr.id = a.doctor_id
      GROUP BY a.doctor_id, pr.full_name
    )
    SELECT jsonb_build_object(
      'totalAppointments', t.total_appointments,
      'noShowCount',       t.no_show_count,
      'noShowRate',
        CASE WHEN t.total_appointments = 0 THEN 0
             ELSE ROUND((t.no_show_count::numeric / t.total_appointments) * 100, 1)
        END,
      'byDoctor', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'doctorId',   d.doctor_id,
          'doctorName', d.doctor_name,
          'total',      d.total,
          'noShow',     d.no_show,
          'rate', CASE WHEN d.total = 0 THEN 0
                       ELSE ROUND((d.no_show::numeric / d.total) * 100, 1) END
        ) ORDER BY d.no_show DESC) FROM by_doctor d
      ), '[]'::jsonb)
    ) FROM totals t
  );
END;
$$;

-- ── RPC 3: Doctor Performance Report ──────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_doctor_performance_report(
  p_start timestamptz,
  p_end   timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER
SET search_path = public, pg_temp AS $$
DECLARE
  v_clinic uuid            := public.auth_clinic_id();
  v_role   public.user_role := public.auth_role();
BEGIN
  IF v_role NOT IN ('admin', 'manager') THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;

  RETURN (
    WITH appt AS (
      SELECT a.doctor_id, a.patient_id, a.department_id, a.status,
             COALESCE(a.paid_amount, 0)
               + COALESCE(a.secondary_amount, 0)
               + COALESCE(a.insurance_amount, 0) AS collected
      FROM public.appointments a
      WHERE a.clinic_id = v_clinic AND a.deleted_at IS NULL
        AND a.scheduled_at >= p_start AND a.scheduled_at <= p_end
    ),
    clinic_totals AS (
      SELECT COUNT(DISTINCT patient_id)    AS clinic_patients,
             COALESCE(SUM(collected), 0)   AS clinic_revenue
      FROM appt WHERE status = 'completed'
    ),
    per_doctor AS (
      SELECT a.doctor_id,
             pr.full_name,
             pr.department_id                                              AS dept_id,
             COUNT(*)                                                      AS sessions,
             COUNT(*) FILTER (WHERE status = 'completed')                 AS completed,
             COUNT(*) FILTER (WHERE status = 'cancelled')                 AS cancelled,
             COUNT(*) FILTER (WHERE status = 'no_show')                   AS no_show,
             COUNT(DISTINCT patient_id) FILTER (WHERE status='completed') AS unique_patients,
             COALESCE(SUM(collected) FILTER (WHERE status='completed'), 0) AS revenue
      FROM appt a
      JOIN public.profiles pr ON pr.id = a.doctor_id
      GROUP BY a.doctor_id, pr.full_name, pr.department_id
    ),
    dept_totals AS (
      SELECT dept_id,
             COALESCE(SUM(unique_patients), 0) AS dept_patients,
             COALESCE(SUM(revenue), 0)          AS dept_revenue
      FROM per_doctor
      WHERE dept_id IS NOT NULL
      GROUP BY dept_id
    )
    SELECT jsonb_build_object(
      'doctors', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'doctorId',       d.doctor_id,
          'doctorName',     d.full_name,
          'departmentId',   d.dept_id,
          'sessions',       d.sessions,
          'completed',      d.completed,
          'cancelled',      d.cancelled,
          'noShow',         d.no_show,
          'uniquePatients', d.unique_patients,
          'revenue',        d.revenue,
          'completionRate',
            CASE WHEN d.sessions = 0 THEN 0
                 ELSE ROUND((d.completed::numeric / d.sessions) * 100, 1) END,
          'cancellationRate',
            CASE WHEN d.sessions = 0 THEN 0
                 ELSE ROUND((d.cancelled::numeric / d.sessions) * 100, 1) END,
          'noShowRate',
            CASE WHEN d.sessions = 0 THEN 0
                 ELSE ROUND((d.no_show::numeric / d.sessions) * 100, 1) END,
          'deptPatientShare',
            CASE WHEN dt.dept_patients = 0 THEN 0
                 ELSE ROUND((d.unique_patients::numeric / dt.dept_patients) * 100, 1) END,
          'clinicPatientShare',
            CASE WHEN ct.clinic_patients = 0 THEN 0
                 ELSE ROUND((d.unique_patients::numeric / ct.clinic_patients) * 100, 1) END,
          'deptRevenueShare',
            CASE WHEN dt.dept_revenue = 0 THEN 0
                 ELSE ROUND((d.revenue::numeric / dt.dept_revenue) * 100, 1) END,
          'clinicRevenueShare',
            CASE WHEN ct.clinic_revenue = 0 THEN 0
                 ELSE ROUND((d.revenue::numeric / ct.clinic_revenue) * 100, 1) END
        ) ORDER BY d.revenue DESC)
        FROM per_doctor d
        LEFT JOIN dept_totals dt ON dt.dept_id = d.dept_id
        CROSS JOIN clinic_totals ct
      ), '[]'::jsonb)
    ) FROM clinic_totals ct
  );
END;
$$;

-- ── RPC 4: Receptionist Performance Report ─────────────────────────────
CREATE OR REPLACE FUNCTION public.get_receptionist_performance_report(
  p_start timestamptz,
  p_end   timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER
SET search_path = public, pg_temp AS $$
DECLARE
  v_clinic uuid            := public.auth_clinic_id();
  v_role   public.user_role := public.auth_role();
BEGIN
  IF v_role NOT IN ('admin', 'manager') THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;

  RETURN (
    WITH appt_by_creator AS (
      SELECT created_by, COUNT(*) AS booked
      FROM public.appointments
      WHERE clinic_id = v_clinic AND deleted_at IS NULL
        AND created_at >= p_start AND created_at <= p_end
      GROUP BY created_by
    ),
    clinic_appt_total AS (
      SELECT GREATEST(COUNT(*), 1) AS total
      FROM public.appointments
      WHERE clinic_id = v_clinic AND deleted_at IS NULL
        AND created_at >= p_start AND created_at <= p_end
    ),
    fu_by_recorder AS (
      SELECT recorded_by, COUNT(*) AS handled
      FROM public.follow_ups
      WHERE clinic_id = v_clinic
        AND recorded_at >= p_start AND recorded_at <= p_end
      GROUP BY recorded_by
    ),
    clinic_fu_total AS (
      SELECT GREATEST(COUNT(*), 1) AS total
      FROM public.follow_ups
      WHERE clinic_id = v_clinic
        AND recorded_at >= p_start AND recorded_at <= p_end
    ),
    receptionists AS (
      SELECT id, full_name FROM public.profiles
      WHERE clinic_id = v_clinic AND role = 'receptionist'
        AND is_active = true AND is_deleted = false AND deleted_at IS NULL
    )
    SELECT jsonb_build_object(
      'receptionists', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'id',                 r.id,
          'name',               r.full_name,
          'appointmentsBooked', COALESCE(ab.booked, 0),
          'appointmentShare',   ROUND((COALESCE(ab.booked, 0)::numeric / ct.total) * 100, 1),
          'followupsHandled',   COALESCE(fc.handled, 0),
          'followupShare',      ROUND((COALESCE(fc.handled, 0)::numeric / ft.total) * 100, 1)
        ) ORDER BY COALESCE(ab.booked, 0) DESC)
        FROM receptionists r
        LEFT JOIN appt_by_creator ab ON ab.created_by = r.id
        LEFT JOIN fu_by_recorder  fc ON fc.recorded_by = r.id
        CROSS JOIN clinic_appt_total ct
        CROSS JOIN clinic_fu_total   ft
      ), '[]'::jsonb)
    ) FROM clinic_appt_total, clinic_fu_total
  );
END;
$$;

-- Grant all new RPCs to authenticated and service_role; revoke from public
REVOKE EXECUTE ON FUNCTION public.get_cancellation_report(timestamptz, timestamptz) FROM public;
REVOKE EXECUTE ON FUNCTION public.get_no_show_report(timestamptz, timestamptz) FROM public;
REVOKE EXECUTE ON FUNCTION public.get_doctor_performance_report(timestamptz, timestamptz) FROM public;
REVOKE EXECUTE ON FUNCTION public.get_receptionist_performance_report(timestamptz, timestamptz) FROM public;

GRANT EXECUTE ON FUNCTION public.get_cancellation_report(timestamptz, timestamptz) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_no_show_report(timestamptz, timestamptz) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_doctor_performance_report(timestamptz, timestamptz) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_receptionist_performance_report(timestamptz, timestamptz) TO authenticated, service_role;
```

---

## Report Calculation Formulas

### Cancellation Report

```
cancellationRate   = (cancelledCount / totalAppointments) × 100
byDoctorRate       = (doctor.cancelled / doctor.total) × 100
```

- Denominator = **all** appointments with `scheduled_at` in range (not just non-cancelled)
- If `totalAppointments = 0` → rate = 0 (guarded by SQL `CASE`)

### No-Show Report

```
noShowRate         = (noShowCount / totalAppointments) × 100
byDoctorRate       = (doctor.noShow / doctor.total) × 100
```

Same denominator and zero-guard logic as Cancellation Report.

### Follow-ups Report (uses `get_followups_dashboard` summary fields)

```
allFineRate        = (allFineCount / totalCompleted) × 100
hasProblemRate     = (hasProblemCount / totalCompleted) × 100
noResponseRate     = 100 − allFineRate − hasProblemRate   ← avoids floating-point drift
```

If `totalCompleted = 0` → all rates = 0.

### Doctor Performance Report

```
completionRate     = (completed / sessions) × 100
cancellationRate   = (cancelled / sessions) × 100
noShowRate         = (noShow / sessions) × 100
revenue            = SUM(paid_amount + secondary_amount + insurance_amount)
                     for completed appointments only

deptPatientShare   = (doctor.uniquePatients / dept.uniquePatients) × 100
clinicPatientShare = (doctor.uniquePatients / clinic.uniquePatients) × 100
deptRevenueShare   = (doctor.revenue / dept.revenue) × 100
clinicRevenueShare = (doctor.revenue / clinic.revenue) × 100
```

All denominators guarded: if denominator = 0 → share = 0.

### Receptionist Performance Report

```
appointmentShare   = (bookedByReceptionist / totalBookedInRange) × 100
followupShare      = (handledByReceptionist / totalFollowupsInRange) × 100
```

- Bookings use `created_at` (when the booking was made), not `scheduled_at`
- Follow-ups use `recorded_at`
- Denominators clamped to `GREATEST(total, 1)` in SQL

---

## Proposed UI Changes

### New Page: `app/(protected)/reports/page.tsx`

- Server component
- Calls `requireUser()` → redirects doctor role to `/dashboard`
- Computes `canSeePerformanceReports = role === 'admin' || role === 'manager'`
- Resolves date range from URL search params (reuses `lib/date-range.ts` helpers)
- Runs all RPCs in parallel via `Promise.all`; skips performance RPCs if `canSeePerformanceReports = false`
- Renders `<ReportsPageClient>` passing data + `canSeePerformanceReports`

### New Component: `components/reports/reports-date-filter.tsx`

- Client component
- 4 preset buttons: **Today / This Week / This Month / Custom Range**
- Custom range: two date inputs (from / to)
- Updates URL search params via `router.push` — all reports re-fetch on navigation
- Shared across the entire page; one filter controls all 6 reports simultaneously

### Report Section Components (all client components)

Each follows the same structure: `Card > header (title + print button) > data table > footer`.

| Component | Section |
|-----------|---------|
| `components/reports/cancellation-report.tsx` | Summary card + by-doctor table + by-reason list |
| `components/reports/no-show-report.tsx` | Summary card + by-doctor table |
| `components/reports/revenue-summary-report.tsx` | Totals + method breakdown (no transaction list) |
| `components/reports/followups-report.tsx` | 3-row outcome table: count + % + visual bar |
| `components/reports/doctor-performance-report.tsx` | Wide table, 13 columns; admin/manager only |
| `components/reports/receptionist-performance-report.tsx` | 5-column table; admin/manager only |

### New Component: `components/reports/print-all-button.tsx`

- Client component
- Sets `document.body.setAttribute("data-printing", "all")` before `window.print()`
- Removes attribute on `afterprint` event
- Per-section print buttons set `data-printing` to their section ID, print, then restore

### Patient Profile Changes

**`app/(protected)/patients/[id]/page.tsx`**

- New **Session Packages** section added between appointments and deposits sections
- Lists active packages: name, total/used/remaining sessions, price/session, department badge, status
- "Add Package" button (admin/receptionist only)
- Edit + Deactivate actions per row

### Appointment Form Changes

**`components/appointments/appointment-form.tsx`**

- Optional **Package** select dropdown, appears after a patient is selected
- Filters: `is_active = true AND used_sessions < total_sessions` for the chosen patient
- Option label: `{package.name} — {remaining}/{total} sessions remaining`
- Auto-displays read-only: "This will be session #N" (computed as `used_sessions + 1`)

### Appointment Detail / Billing Changes

- Appointment detail dialog: if `package_id` is set, show callout "Package: {name} — Session #{session_number} of {total}"
- Billing dialog: show package callout + pre-fill `total_amount` from `price_per_session` if set
- `appointment-payment-row.tsx`: add package chip badge when `package_id` is present
- Invoice/print: add "Package" row showing name + session# + remaining

### Add Deposit Dialog Change

- If the patient has any active package with `price_per_session` set, show a read-only hint:
  `"This deposit covers ~{floor(deposit / price_per_session)} session(s)"`
- Pure client-side calculation — no DB change needed

---

## Proposed Route / Page Structure

```
app/(protected)/
└── reports/
    ├── page.tsx          ← Server component: data fetching, access gate
    └── loading.tsx       ← Skeleton loading state
```

All 6 reports live on a single scrollable page separated by Card sections. No sub-routes.

---

## Proposed Permissions / Access-Control Changes

### Updates to `lib/page-permissions.ts`

```typescript
// 1. Add "reports" to PageSlug union
export type PageSlug =
  | "dashboard" | "patients" | "appointments" | "followups"
  | "revenue" | "settings" | "reports";   // ← NEW

// 2. Add to PAGE_DEFINITIONS array
{ slug: "reports", href: "/reports", label: "Reports" }

// 3. Update ROLE_PAGE_SLUGS
admin:        [...existing, "reports"],
manager:      [...existing, "reports"],
receptionist: [...existing, "reports"],
doctor:       // unchanged — no "reports"

// 4. Update getPageSlugFromPath
if (pathname.startsWith("/reports")) return "reports";
```

### Updates to `lib/supabase/middleware.ts`

```typescript
const PROTECTED_PREFIXES = [
  // ...existing...
  "/reports",   // ← ADD
];
```

### Sub-Report Access (within the page — two layers)

1. **Server component** computes `canSeePerformanceReports` and conditionally renders sections
2. **RPCs** enforce `auth_role() IN ('admin', 'manager')` internally — raises `42501` on unauthorized calls

### Customization Integration

Adding `"reports"` to `PAGE_DEFINITIONS` is the only change needed. The existing `page-visibility-customizer.tsx` dynamically renders toggles for all entries in a staff member's role — no customizer code needs modification.

---

## Proposed Print / Report Architecture

### Per-Section Print Pattern

```typescript
function printSection(sectionId: string) {
  document.body.setAttribute("data-printing", sectionId);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    window.print();
    window.addEventListener("afterprint", () => {
      document.body.removeAttribute("data-printing");
    }, { once: true });
  }));
}
```

Each report section div carries `data-report-section="{sectionId}"`.

### CSS Additions in `app/globals.css`

```css
@media print {
  /* Hide UI chrome */
  .print-hidden { display: none !important; }

  /* When printing a specific section, hide all other report sections */
  body[data-printing] [data-report-section] { display: none !important; }
  body[data-printing="all"] [data-report-section] { display: block !important; }
  body[data-printing="cancellation"] [data-report-section="cancellation"] { display: block !important; }
  body[data-printing="no-show"] [data-report-section="no-show"] { display: block !important; }
  body[data-printing="revenue"] [data-report-section="revenue"] { display: block !important; }
  body[data-printing="followups"] [data-report-section="followups"] { display: block !important; }
  body[data-printing="doctor-performance"] [data-report-section="doctor-performance"] { display: block !important; }
  body[data-printing="receptionist-performance"] [data-report-section="receptionist-performance"] { display: block !important; }

  /* Clean B&W tables */
  table { border-collapse: collapse; width: 100%; font-size: 11pt; }
  th, td { border: 1px solid #000; padding: 4px 8px; }
  th { background: #f0f0f0 !important; font-weight: bold; }
}
```

### Print Header

Reuse the existing `PrintHeader` component (or the inline version from `revenue-report.tsx`). Each report's print output begins with: clinic logo + name + address + phone + "Reports" document type + selected date range.

---

## Patient Package Lifecycle

```
1. Staff creates package on patient profile
   patient_packages: { total_sessions: 10, used_sessions: 0, is_active: true }

2. Staff books appointment and selects package
   appointments: {
     package_id: pkg.id,
     package_session_number: used_sessions + 1  ← computed in server action at INSERT time
   }

3. Appointment marked completed → DB trigger fires automatically
   patient_packages: { used_sessions: 1 }   (remaining = 9)

4. Next appointment booked against same package
   package_session_number = current used_sessions + 1 = 2

5. After 10 completions:
   patient_packages: { used_sessions: 10, remaining: 0 }
   → Staff deactivates manually (or trigger can auto-set is_active = false)

6. Deposit added → UI shows session coverage (client-side only)
   sessions_covered = floor(deposit_amount / price_per_session)
   (shown as a hint; no DB write)

7. Appointment undo (completed → pending/confirmed)
   DB trigger fires: used_sessions decrements by 1
```

---

## Exact Files to Create

| File | Phase |
|------|-------|
| `supabase/migrations/20260518000000_patient_packages.sql` | 1 |
| `supabase/migrations/20260518001000_patient_packages_rls.sql` | 1 |
| `supabase/migrations/20260518002000_reports_rpcs.sql` | 1 |
| `types/reports.ts` | 2 |
| `lib/date-range.ts` | 2 |
| `app/(protected)/reports/page.tsx` | 3 |
| `app/(protected)/reports/loading.tsx` | 3 |
| `components/reports/reports-date-filter.tsx` | 3 |
| `components/reports/reports-page-client.tsx` | 3 |
| `components/reports/cancellation-report.tsx` | 3 |
| `components/reports/no-show-report.tsx` | 3 |
| `components/reports/revenue-summary-report.tsx` | 3 |
| `components/reports/followups-report.tsx` | 3 |
| `components/reports/doctor-performance-report.tsx` | 3 |
| `components/reports/receptionist-performance-report.tsx` | 3 |
| `components/reports/print-all-button.tsx` | 3 |
| `actions/patient-packages.ts` | 4 |
| `lib/validations/patient-package.ts` | 4 |
| `components/patients/patient-packages-section.tsx` | 4 |
| `components/patients/add-package-dialog.tsx` | 4 |
| `components/patients/edit-package-dialog.tsx` | 4 |

---

## Exact Files to Modify

| File | Change | Phase |
|------|--------|-------|
| `lib/page-permissions.ts` | Add `"reports"` to PageSlug, ROLE_PAGE_SLUGS, PAGE_DEFINITIONS, getPageSlugFromPath | 2 |
| `lib/supabase/middleware.ts` | Add `"/reports"` to PROTECTED_PREFIXES | 2 |
| `components/layout/sidebar.tsx` | Add `BarChart3` (lucide) icon + `reports` entry to ICONS record | 2 |
| `types/database.ts` | Add interim `PatientPackageRow` type block; replace with generated types after `supabase gen types` | 2 |
| `app/(protected)/revenue/page.tsx` | Import date helpers from new `lib/date-range.ts` | 3 |
| `app/globals.css` | Add print media queries for `data-report-section` + `data-printing` pattern | 3 |
| `app/(protected)/patients/[id]/page.tsx` | Add packages fetch in `Promise.all` + render `<PatientPackagesSection>` | 4 |
| `lib/validations/appointment.ts` | Add optional `package_id: z.string().uuid().nullable()` field | 5 |
| `actions/appointments.ts` | Validate package belongs to patient + compute `package_session_number` on create | 5 |
| `components/appointments/appointment-form.tsx` | Add optional package select dropdown | 5 |
| `components/appointments/appointment-detail-dialog.tsx` | Show package info callout when `package_id` is set | 5 |
| `components/appointments/billing-dialog.tsx` | Show package callout + pre-fill from `price_per_session` | 5 |
| `components/patients/appointment-payment-row.tsx` | Add package chip/badge | 5 |
| `app/(protected)/patients/[id]/appointments-report/page.tsx` | Fetch `package_id`, `package_session_number` per appointment | 6 |
| `components/patients/appointments-report-list.tsx` | Add package column to print report layout | 6 |

---

## Risks and Edge Cases

### Reports

1. **Zero-data ranges** — All RPCs return `0` counts and `0` rates. Every UI component must show an explicit "No data for selected period" empty state, not blank or NaN.

2. **Doctor blocked from Reports** — Doctor role is absent from `ROLE_PAGE_SLUGS.doctor`. Middleware blocks them at URL level. Server component redirects as a second guard. Sidebar never shows the link. Three independent layers.

3. **Receptionist accessing performance sub-reports** — Receptionist can reach the page but `canSeePerformanceReports = false` means components are never rendered and RPCs never called. RPCs themselves also raise `42501` for receptionist — dual protection.

4. **Follow-ups RPC over-fetching** — `get_followups_dashboard` returns full row-level data. Call it with `p_done_limit: 0` (or equivalent zero-limit param) so only the summary counters are returned — avoid fetching hundreds of rows unnecessarily.

5. **Large date ranges** — A year-long range on a large clinic could be slow. The composite index on `(clinic_id, scheduled_at, status, doctor_id)` added in Migration 3 mitigates this. Monitor query plan; escalate to a dedicated API route with streaming if needed.

6. **`get_revenue_summary` returns transaction list** — The Reports page needs only summary totals. Extract `gross_total` and `method_breakdown` from the returned JSON; ignore the `transactions` array entirely.

7. **Customizer auto-exposes "reports"** — Adding to `PAGE_DEFINITIONS` makes the Reports toggle immediately visible in the staff customizer. This is intended. No guard needed.

### Patient Packages

8. **Trigger vs. billing RPC interaction** — The existing `complete_appointment_billing` RPC sets `status = 'completed'`. The new trigger fires `AFTER UPDATE OF status`. Since `AFTER` triggers fire after the statement commits, this is safe. Verify the billing RPC does not disable triggers (`SET session_replication_role = replica` pattern).

9. **`undo_appointment_status` RPC** — When undoing a completed appointment back to `pending` or `confirmed`, the trigger handles the reversal and decrements `used_sessions`. Verify the undo RPC does not separately manipulate `used_sessions` (it does not — it only changes `status`).

10. **Package session number drift** — `package_session_number` is assigned at booking time as `used_sessions + 1`. If the appointment is later cancelled without completing, `used_sessions` does not increment, so the session number is "wasted" — a gap appears in the sequence. This is expected. Document as "intended session number, not guaranteed sequence."

11. **Race condition on concurrent bookings** — Two staff booking against the same package simultaneously when only 1 session remains. The trigger's `WHERE used_sessions < total_sessions` guard ensures only the first `UPDATE` succeeds. To prevent the wrong `package_session_number` being written for the second booking, wrap the package validation + appointment INSERT in a transaction with `SELECT ... FOR UPDATE` on the package row in `actions/appointments.ts`.

12. **Package with no `price_per_session`** — The deposit session-coverage hint shows `floor(deposit / price_per_session)`. If `price_per_session` is null, hide the hint entirely. Never divide by null or zero.

13. **Soft-deleted patient + packages** — Soft delete does not fire FK CASCADE. Packages persist but the patient appears in trash. If the patient is hard-deleted (permanent), `ON DELETE CASCADE` removes all packages. `appointments.package_id` is `ON DELETE SET NULL`, so appointment records survive with `package_id = null`.

14. **Supabase type regeneration** — After applying Migration 1, run `supabase gen types typescript --project-id <ref> > types/database.ts` to regenerate the types file. The interim `PatientPackageRow` type added manually in Phase 2 must be removed after regeneration to avoid duplication.

---

## RLS / Security Risks

| Risk | Mitigation |
|------|-----------|
| Receptionist calling performance RPCs directly (e.g., via Supabase client) | RPC enforces `auth_role() IN ('admin','manager')` — raises `42501` |
| Doctor navigating to `/reports` directly via URL | Middleware blocks (not in `ROLE_PAGE_SLUGS.doctor`) + server component redirects |
| Cross-clinic package access | RLS policy: `clinic_id = auth_clinic_id()` on all SELECT/INSERT/UPDATE/DELETE |
| Staff manually incrementing `used_sessions` | Only admin/receptionist can UPDATE; the `used_le_total` constraint prevents values > `total_sessions`; trigger is the only intended path for session counting |
| Trigger bypassing RLS | Trigger function runs with invoking user context by default; if it cannot UPDATE `patient_packages` due to RLS (unlikely since RLS allows admin/receptionist), add `SECURITY DEFINER` to the trigger function — test explicitly |
| Audit log gap | Add audit triggers on `patient_packages` INSERT/UPDATE following the same pattern as other audited tables |
| Package data in print output | Print output is client-side HTML — no additional server security needed; existing Supabase RLS already ensures only authorized data is fetched |

---

## Testing Plan

### Unit Tests (Vitest)

- `lib/date-range.ts`: test `resolveRange()` for all 4 presets + custom range + reversed dates + same-day
- Report formulas: rate = 0 when total = 0; rate = 100% when all cancelled; outcome rates sum to 100%
- `patientPackageSchema` (Zod): 0 sessions fails; negative price fails; name at max length passes
- `getPageSlugFromPath("/reports")` → `"reports"`

### Integration Tests (Vitest + Supabase test DB)

- Create package → assert `used_sessions = 0`, `remaining = total_sessions`
- Create appointment with package → mark completed → assert `used_sessions = 1`
- Undo completion → assert `used_sessions = 0`
- Attempt UPDATE to set `used_sessions > total_sessions` → constraint violation
- Doctor calls `get_cancellation_report` → `42501`
- Receptionist calls `get_doctor_performance_report` → `42501`
- Admin calls all 4 RPCs with empty date range → success with zero values
- Cross-clinic package read → empty result (RLS filters)

### E2E Tests (Playwright)

- Admin → `/reports` → sees all 6 sections → print each section → print all
- Manager → `/reports` → sees all 6 sections
- Receptionist → `/reports` → sees 4 sections; Doctor Performance and Receptionist Performance absent
- Doctor → navigates to `/reports` → redirected to `/dashboard`
- Admin hides Reports from a receptionist in `/settings/customize` → receptionist no longer sees Reports in sidebar
- Admin creates package on patient profile → visible in package list with correct remaining count
- Book appointment → package dropdown shows only active packages for that patient with remaining sessions
- Complete appointment → package remaining sessions decrements by 1
- Add deposit → session coverage hint appears (when `price_per_session` is set)

### Manual QA Checklist

- All 6 report sections render with real clinic data (no NaN, no blank, no missing rows)
- Empty date range → each section shows "No data" state without errors
- Large date range (1 year) → acceptable response time
- Print each report section individually → clean B&W with PrintHeader
- Print All → all 6 sections in one job, sidebar/filter hidden
- Package: deactivate → no longer appears in appointment form dropdown
- Package: all sessions used (remaining = 0) → no longer in dropdown
- Invoice with package → shows package name, session#, remaining

---

## Migration Plan

```
Step 1  Apply: 20260518000000_patient_packages.sql     (new table, FK columns, trigger)
Step 2  Apply: 20260518001000_patient_packages_rls.sql (RLS policies)
Step 3  Apply: 20260518002000_reports_rpcs.sql         (4 RPCs + performance indexes)
Step 4  Run:   supabase gen types typescript --project-id <ref> > types/database.ts
               → Remove interim PatientPackageRow after generation confirms table is present
```

All migrations are **additive** — new table, nullable columns with defaults, new functions. No existing table structures are altered destructively. Fully backwards-compatible with all existing queries (existing queries that do not select `package_id` / `package_session_number` are unaffected).

---

## Recommended Phased Implementation Plan

### Phase 1 — Database First (Safe Foundation)

**What**: All three SQL migrations applied and verified in Supabase.

**Why first**: Every subsequent phase depends on the schema and RPCs existing. Running migrations before any application code prevents type errors and runtime failures.

**Validation**:
- Run each RPC from Supabase SQL editor with test timestamps → verify JSON shape
- INSERT a package, UPDATE appointment status to `completed` → verify `used_sessions` increments
- UPDATE back to `pending` → verify `used_sessions` decrements
- Attempt cross-clinic READ → verify empty result

**Files created**:
- `supabase/migrations/20260518000000_patient_packages.sql`
- `supabase/migrations/20260518001000_patient_packages_rls.sql`
- `supabase/migrations/20260518002000_reports_rpcs.sql`

---

### Phase 2 — Type System + Page Permission Infrastructure

**What**: TypeScript types for packages and reports; plug `"reports"` into the existing page-slug system; add sidebar icon; regenerate Supabase types.

**Why second**: The Reports page won't compile without the slug registered. The type layer must exist before any component references new shapes.

**Validation**:
- `tsc --noEmit` passes
- Sidebar shows Reports link for admin/manager/receptionist; hidden for doctor
- Middleware blocks doctor from `/reports` URL directly
- Reports appears in `/settings/customize` customizer toggle list

**Files modified**:
- `lib/page-permissions.ts`
- `lib/supabase/middleware.ts`
- `components/layout/sidebar.tsx`
- `types/database.ts`

**Files created**:
- `types/reports.ts`
- `lib/date-range.ts`

---

### Phase 3 — Reports Page (Read-Only, Zero Write Risk)

**What**: Full `/reports` page with all 6 report sections, date filter, role-based sub-report visibility, and per-section + print-all support.

**Why third**: Purely additive and read-only — zero risk to existing write workflows. Builds directly on Phase 1 RPCs and Phase 2 types.

**Validation**:
- All 6 sections render with data
- Date filter updates all sections simultaneously
- Receptionist cannot see performance sections
- Per-section print works; Print All works
- `revenue/page.tsx` still works correctly after date-range extraction

**Files created**: 13 new files in `app/(protected)/reports/` and `components/reports/`

**Files modified**:
- `app/(protected)/revenue/page.tsx` (import from `lib/date-range.ts`)
- `app/globals.css`

---

### Phase 4 — Patient Packages Core (Profile UI + CRUD)

**What**: Package management on patient profile — list, add, edit, deactivate. Server actions, Zod validation, and CRUD components.

**Why fourth**: Self-contained. Only the patient profile page is touched. No existing appointment flows are modified yet. Safe to validate independently.

**Validation**:
- Admin/receptionist can create a 10-session package for a patient
- `used_sessions` starts at 0
- Edit dialog pre-populates; deactivate sets `is_active = false`
- Packages section renders on patient profile without breaking existing sections

**Files created**: `actions/patient-packages.ts`, `lib/validations/patient-package.ts`, 3 components

**Files modified**:
- `app/(protected)/patients/[id]/page.tsx`

---

### Phase 5 — Appointment Integration (Highest Touch Risk)

**What**: Package selection in the appointment form; package info in appointment details, billing dialog, and payment row; server-side package validation and `package_session_number` computation.

**Why fifth**: This phase touches the most sensitive existing flows (appointment creation and billing). Must be done after Phase 4 actions exist and isolated tests pass.

**Validation**:
- Package dropdown appears only after a patient is selected in the form
- Only active packages with remaining sessions appear
- Completing an appointment decrements the package session count via trigger
- Undoing completion reverses the decrement
- Invoice shows package info row
- Existing appointments without packages load without errors or regressions

**Files modified**: `lib/validations/appointment.ts`, `actions/appointments.ts`, `appointment-form.tsx`, `appointment-detail-dialog.tsx`, `billing-dialog.tsx`, `appointment-payment-row.tsx`

---

### Phase 6 — Print Finalization + Invoice Package Display (Polish)

**What**: Package info in patient appointment print reports; CSS finalization for the full print system; any UX polish.

**Why last**: Purely additive display additions to existing print flows — no logic changes.

**Validation**:
- Patient appointment report shows package column with name and session#
- Print All on Reports page prints all 6 sections cleanly with PrintHeader
- B&W output has no color artifacts, no UI chrome
- All existing print reports unaffected

**Files modified**: `appointments-report/page.tsx`, `appointments-report-list.tsx`, final `globals.css` cleanup

---

## Recommendations

### Performance
- Consider adding an optional `p_doctor_id` filter to `get_doctor_performance_report` so admins can drill into a single doctor without aggregating the full clinic.
- Use `unstable_cache` from Next.js on the reports page if reports become frequently accessed — the data does not need to be real-time.

### UX
- Show "No data for selected period" per-section, not as a global message.
- Wrap the Doctor Performance table (13 columns) in a horizontal scroll container on mobile.
- Add a visual progress bar on each package card: `used_sessions / total_sessions`.
- Auto-deactivate packages when `used_sessions = total_sessions` via the trigger instead of requiring manual action.

### Maintainability
- `lib/date-range.ts` extraction prevents date-preset logic drift between Revenue and Reports pages.
- All 4 new RPCs follow the existing JSONB return pattern — consistent for future additions.
- Centralizing report types in `types/reports.ts` makes future report additions straightforward.

### Future
- Export to CSV per report section (download button alongside print).
- Trend line charts (e.g., cancellation rate over time) — the data structure already supports daily buckets.
- Clinic-level package templates (pre-defined name/session count) to speed up package creation.
- Package auto-renewal notification when remaining sessions fall below a configurable threshold.

---

## Implementation Rules for Codex

1. Implement one phase at a time only.
2. Do not touch unrelated files.
3. Do not refactor existing logic unless required by the plan.
4. Preserve existing appointment, revenue, deposit, invoice, follow-up, RLS, and printing logic.
5. Run lint, typecheck, tests, and build after each phase.
6. Summarize changed files, risks, and verification results after each phase.
7. Stop after each phase and wait for review.
