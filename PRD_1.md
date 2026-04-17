# PRD — CRM System for Clinics

> **Version:** 2.0 | **Date:** April 2026 | **Status:** Active
> **University:** Üsküdar University — Faculty of Engineering and Natural Sciences, Software Engineering Dept.
> **Supervisor:** Dr. Faezeh Rohani
> **Team:** Mohamed Ibrahim · 210209956 (Lead Frontend) · Osama Ali · 220209367 (Lead Backend) · Mohamed Seif · 220209307 (UI/UX)
> **Notion (live version):** https://www.notion.so/34563497ff8e81c48cfeeaf41b2928dd

---

# 1. Executive Summary

Clinic CRM is a **staff-only** web-based system designed for small-to-medium private clinics in Turkey. It replaces fragmented manual workflows — paper appointment books, phone-based scheduling, Excel patient records — with a single integrated digital platform.

The system is **100% staff-facing**. Patients are data records only — they do not have accounts, do not log in, and do not interact with the system in any way. All data entry and scheduling is performed exclusively by clinic staff.

The product covers five core operations: patient record management, appointment scheduling with conflict detection, role-based dashboards, insurance provider tracking, and staff access management.

**Target outcomes within 8 weeks of deployment:**
- Appointment conflicts ↓ 20%
- Average booking time ↓ 30%
- No-show rate reduced via operational visibility on dashboards

---

# 2. Core Principles

- **Staff-only system** — no patient login, no patient portal, no patient-facing pages of any kind
- **Patients are records** — a patient exists in the database as structured data, managed entirely by staff
- **Admin is the access authority** — the Clinic Admin creates accounts, assigns roles, and revokes access
- **No landing page** — the application root (`/`) redirects immediately to `/login`
- **MVP first, extensible architecture** — `clinic_id` is present on all core tables from day one, Phase 1 UI supports a single clinic only

---

# 3. Goals & Non-Goals

## Goals

- Centralize patient records, appointments, and staff communications in one platform
- Enforce role-based access so each staff role sees only what they need
- Provide a role-scoped dashboard for every staff member on login
- Track insurance coverage per appointment with an admin-managed provider list
- Ensure full compliance with KVKK (Turkish Personal Data Protection Law)

## Non-Goals (Phase 1)

- **No patient-facing features of any kind** — no patient login, portal, booking, or email
- No automated emails or reminders (deferred to Phase 2)
- No billing or invoice generation
- No e-prescriptions
- No SMS or push notifications
- No AI-based scheduling
- No national health system integration (SGK, e-Nabız)
- No mobile native app (web-responsive only)
- No multi-clinic UI

---

# 4. Tech Stack

| Layer | Technology | Reason |
|---|---|---|
| Framework | Next.js 15 (App Router) | Server Components + Server Actions = minimal API boilerplate |
| Database + Auth | Supabase (Postgres + Auth + RLS + Storage) | Managed Postgres with row-level security built in |
| Styling | Tailwind CSS + shadcn/ui | Fast, consistent, accessible UI out of the box |
| Forms | React Hook Form + Zod | Type-safe validation with zero overhead |
| Tables | TanStack Table v8 | Server-side pagination, sorting, filtering |
| Email (Phase 2) | Resend | Developer-friendly transactional email |
| Error tracking | Sentry | Full-stack error capture from day one |
| Language | TypeScript (strict mode) | Type safety across the entire codebase |

---

# 5. User Roles

| Role | Key Responsibilities |
|---|---|
| **Admin / Doctor** | Patient records, medical notes, appointments, staff management, all settings |
| **Receptionist** | Appointment booking and scheduling, patient record creation and view |
| **Clinic Manager** | Read-only access to all data; full dashboard with KPIs and metrics |

> ⚠️ **Patients are records, not users.** There is no Patient role. Patients do not log in and do not interact with the system.

---

# 6. Functional Requirements

## Module 1 — Authentication & RBAC

- Staff log in with email and password
- Admin creates staff accounts directly (no email invitation in Phase 1)
- Admin assigns roles: `admin`, `receptionist`, `manager`
- Password reset via secure email link
- All auth events logged in `audit_logs`
- First-login password change enforced

**Acceptance criteria:**
- Unauthenticated requests redirect to `/login`
- `/` redirects to `/login` — no landing page
- Role changes take effect on next page load
- Password reset tokens expire after 60 minutes
- Failed login attempts rate-limited at 5 per 15 minutes per IP

---

## Module 2 — Role-Scoped Dashboards

Every role sees a different dashboard after login.

### Admin / Doctor Dashboard
- Today's appointments (my patients for Doctor; all for Admin)
- Upcoming appointments next 7 days
- Quick-action buttons: New Appointment, New Patient
- My appointment count this month vs. last month

### Receptionist Dashboard
- Today's full schedule (all doctors, all departments)
- Appointments pending confirmation today
- Quick-action buttons: New Appointment, Check-in Patient
- Patients arriving in the next 2 hours

### Clinic Manager Dashboard
- Total appointments: today / this week / this month
- No-show rate and cancellation rate as percentages
- Appointments-per-day chart (last 30 days)
- Appointment breakdown by insurance provider vs. self-pay
- Top doctors by appointment count this month

---

## Module 3 — Patient Record Management

- Admin and Receptionist can create patient records (name, DOB, phone, email, blood type)
- Admin and Doctor can view and edit full profile including medical notes
- Receptionist can view basic profile and appointment history — no medical notes
- Soft delete only — `is_deleted = true`
- All edits recorded in `audit_logs`
- Search by name or phone (case-insensitive, partial match)

---

## Module 4 — Appointment Scheduling

- Book by selecting patient, doctor, department, date, time slot, optional insurance provider
- System detects and rejects double bookings (same doctor + time slot)
- Duration fixed at 30 minutes
- Status state machine:

```
pending → confirmed → completed
pending → cancelled
confirmed → cancelled
confirmed → no_show
```

- Daily and weekly calendar view
- Receptionist can check in a patient (confirms appointment on arrival)

**Appointment statuses:** `pending` | `confirmed` | `cancelled` | `completed` | `no_show`

---

## Module 5 — Insurance Provider Management

- Admin can add, edit, and deactivate insurance providers (name, optional notes)
- Receptionist sees only active providers in booking form + "Self-pay / No insurance" option
- Manager dashboard shows appointment counts by insurance provider
- Deactivating a provider does not affect existing appointments

---

## Module 6 — Settings & Access Management

### Staff Account Management
- Admin creates staff accounts: full name, email, password, role
- Admin can edit role or deactivate any staff account
- Deactivated accounts cannot log in but data is retained

### Department Management
- Admin creates departments with name and color
- Admin assigns doctors to a department
- Receptionist sees departments in booking form to filter doctors

### Clinic Settings
- Admin configures clinic name, phone, address, and logo

---

## Module 7 — Search & Filter

- Search patients by name or phone — results in under 500ms
- Filter appointments by date range, doctor, department, and status (combinable)
- Manager can export filtered appointments as CSV
- CSV excludes KVKK-restricted fields

---

# 7. Data Model

## `profiles`
One row per staff member. Extends Supabase Auth user.

| Field | Type | Notes |
|---|---|---|
| `id` | `uuid` | FK → `auth.users.id` |
| `full_name` | `text` | |
| `role` | `enum` | `admin` \| `receptionist` \| `manager` |
| `phone` | `text` | nullable |
| `avatar_url` | `text` | nullable |
| `clinic_id` | `uuid` | FK → `clinics.id` |
| `department_id` | `uuid` | FK → `departments.id`, nullable |
| `is_active` | `bool` | |
| `must_change_password` | `bool` | |
| `created_at` | `timestamptz` | |
| `updated_at` | `timestamptz` | |

## `clinics`
Single row in Phase 1.

| Field | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK |
| `name` | `text` | |
| `phone` | `text` | nullable |
| `address` | `text` | nullable |
| `logo_url` | `text` | nullable |
| `created_at` | `timestamptz` | |
| `updated_at` | `timestamptz` | |

## `departments`

| Field | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK |
| `clinic_id` | `uuid` | FK → `clinics.id` |
| `name` | `text` | |
| `color` | `text` | Hex color |
| `is_active` | `bool` | |
| `created_at` | `timestamptz` | |
| `created_by` | `uuid` | FK → `profiles.id` |

## `insurance_providers`

| Field | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK |
| `clinic_id` | `uuid` | FK → `clinics.id` |
| `name` | `text` | Unique per clinic |
| `notes` | `text` | nullable |
| `is_active` | `bool` | Default: true |
| `created_at` | `timestamptz` | |
| `created_by` | `uuid` | FK → `profiles.id` |

## `patients`
Pure data records. No auth link. No login.

| Field | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK |
| `clinic_id` | `uuid` | FK → `clinics.id` |
| `full_name` | `text` | |
| `date_of_birth` | `date` | |
| `phone` | `text` | |
| `email` | `text` | nullable |
| `blood_type` | `text` | nullable |
| `is_deleted` | `bool` | Soft delete |
| `created_at` | `timestamptz` | |
| `updated_at` | `timestamptz` | |
| `created_by` | `uuid` | FK → `profiles.id` |
| `updated_by` | `uuid` | FK → `profiles.id` |

## `appointments`

| Field | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK |
| `patient_id` | `uuid` | FK → `patients.id` |
| `doctor_id` | `uuid` | FK → `profiles.id` |
| `department_id` | `uuid` | FK → `departments.id` |
| `insurance_provider_id` | `uuid` | FK → `insurance_providers.id`, nullable |
| `clinic_id` | `uuid` | FK → `clinics.id` |
| `scheduled_at` | `timestamptz` | |
| `duration_minutes` | `int` | Default: 30 |
| `status` | `enum` | `pending` \| `confirmed` \| `cancelled` \| `completed` \| `no_show` |
| `notes` | `text` | nullable |
| `created_at` | `timestamptz` | |
| `updated_at` | `timestamptz` | |
| `created_by` | `uuid` | FK → `profiles.id` |
| `updated_by` | `uuid` | FK → `profiles.id` |

**Unique constraint:** `(doctor_id, scheduled_at)` — DB-level conflict detection

## `medical_notes`
Append-only. New note per consultation. Never edited.

| Field | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK |
| `patient_id` | `uuid` | FK → `patients.id` |
| `doctor_id` | `uuid` | FK → `profiles.id` |
| `note` | `text` | |
| `created_at` | `timestamptz` | |
| `created_by` | `uuid` | FK → `profiles.id` |

## `audit_logs`
Immutable. Written via DB triggers using service role. Never updated or deleted.

| Field | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK |
| `actor_id` | `uuid` | FK → `profiles.id` |
| `action` | `text` | e.g. `patient.create` |
| `table_name` | `text` | |
| `record_id` | `uuid` | |
| `old_data` | `jsonb` | nullable |
| `new_data` | `jsonb` | nullable |
| `ip_address` | `text` | nullable |
| `created_at` | `timestamptz` | |

---

# 8. RLS Policy Summary

| Table | Admin / Doctor | Receptionist | Clinic Manager |
|---|---|---|---|
| `clinics` | Read + Update | Read | Read |
| `departments` | Full CRUD | Read | Read |
| `insurance_providers` | Full CRUD | Read (active only) | Read |
| `profiles` | Full CRUD (own clinic) | Read own + all staff | Read all |
| `patients` | Full CRUD | Full CRUD | Read (aggregate) |
| `medical_notes` | Full CRUD | No access | No access |
| `appointments` | Full CRUD | Full CRUD | Read only |
| `audit_logs` | No access | No access | No access |

---

# 9. Page Map

| Page | Route | Roles |
|---|---|---|
| Login | `/login` | All |
| Dashboard | `/dashboard` | All (role-scoped) |
| Patients list | `/patients` | Admin, Receptionist |
| Patient detail | `/patients/[id]` | Admin, Receptionist |
| Appointments calendar | `/appointments` | Admin, Receptionist |
| New appointment | `/appointments/new` | Admin, Receptionist |
| Settings — Staff | `/settings/staff` | Admin |
| Settings — Departments | `/settings/departments` | Admin |
| Settings — Insurance | `/settings/insurance` | Admin |
| Settings — Clinic | `/settings/clinic` | Admin |

> No public or patient-facing routes exist in Phase 1.

---

# 10. Implementation Phases

| Phase | Scope |
|---|---|
| 0 | Scaffolding — Next.js 15 + Supabase + shadcn/ui + Tailwind + Sentry |
| 1 | Auth & Middleware — Login, Supabase Auth, RBAC middleware, role redirect |
| 2 | Database Schema & RLS — All migrations, RLS policies, seed data |
| 3 | Patient Management — List, detail, create/edit, medical notes, search |
| 4 | Appointment Scheduling — Booking, conflict detection, insurance, calendar |
| 5 | Role-Scoped Dashboards — Admin, Receptionist, Manager dashboards |
| 6 | Settings & Access Management — Staff, departments, insurance, clinic |
| 7 | Polish & Testing — Skeletons, toasts, CSV export, responsive audit |

---

*End of PRD v2.0*
*Stack: Next.js 15 · Supabase · shadcn/ui · Tailwind · React Hook Form · Zod · TanStack Table · Sentry*
