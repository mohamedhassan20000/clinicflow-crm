# ClinicFlow — System Overview

> **Status:** Production-ready

---

## Project Overview

ClinicFlow is a **staff-only** web-based management system for small-to-medium private clinics in Turkey. It replaces paper appointment books, phone-based scheduling, and Excel patient records with a single integrated digital platform.

Patients are data records only — they have no accounts, do not log in, and do not interact with the system in any way. All data entry and scheduling is performed exclusively by clinic staff.

The system covers six core operations:

- Patient record management with soft-delete and file tracking
- Appointment scheduling with conflict detection, in-visit status tracking, and billing
- Patient session packages with reusable per-department package templates
- Role-scoped dashboards with clinic KPIs and operational reports
- Insurance provider tracking and settlement workflows
- Staff access management with per-user page visibility overrides

---

## Architecture

### Technology Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 16.2.6 (App Router) |
| Runtime | React 19.2.4 |
| Database | Supabase Postgres |
| Auth | Supabase Auth |
| Access Control | Supabase RLS + RBAC middleware |
| File Storage | Supabase Storage |
| Styling | Tailwind CSS + shadcn/ui |
| Forms | React Hook Form + Zod v4 |
| Tables | TanStack Table v8 |
| Charts | Recharts |
| Error Tracking | Sentry (optional — no-op without `NEXT_PUBLIC_SENTRY_DSN`) |
| Email | Resend |
| Date Handling | date-fns-tz |
| URL State | nuqs |
| Testing | Vitest v4 + Playwright 1.59 |
| Deployment | Vercel |
| Language | TypeScript (strict mode) |

### Route Structure

All routes live under two App Router route groups:

```
app/
├── (auth)/            ← Public, unauthenticated
│   ├── login/
│   ├── forgot-password/
│   ├── reset-password/
│   └── change-password/
├── (protected)/       ← Requires valid session; role-enforced per page
│   ├── dashboard/
│   ├── appointments/
│   │   └── new/
│   ├── patients/
│   │   ├── [id]/
│   │   │   └── edit/
│   │   └── new/
│   ├── followups/
│   ├── revenue/
│   ├── reports/
│   │   ├── cancellations/
│   │   ├── no-shows/
│   │   ├── doctors/
│   │   ├── receptionists/
│   │   ├── follow-ups/
│   │   └── revenue/
│   ├── profile/
│   └── settings/
│       ├── staff/
│       ├── departments/
│       ├── insurance/
│       ├── services/
│       ├── packages/
│       ├── clinic/
│       └── customize/
├── auth/confirm/      ← Supabase email confirmation callback
└── page.tsx           ← Redirects to /login
```

### Server Actions Pattern

All data mutations are implemented as Next.js Server Actions in `actions/`. There are no API route handlers for writes. Every action begins with a `requireRole()` call that validates the session and returns the authenticated user with their clinic scope.

```
actions/
├── appointments.ts          ← Scheduling, status transitions, billing, trash
├── auth.ts                  ← Login, logout, password reset
├── doctor-dashboard.ts      ← Doctor-specific KPI and queue queries
├── followups.ts             ← Follow-up management
├── manager-dashboard.ts     ← Manager KPI queries
├── medical-note-attachments.ts
├── package-templates.ts     ← Per-department reusable package templates
├── page-permissions.ts      ← Per-user page visibility overrides
├── patient-avatar.ts        ← Avatar upload/delete
├── patient-documents.ts     ← Document upload/delete
├── patient-packages.ts      ← Patient session packages
├── patients.ts              ← Patient CRUD, file numbers, soft delete/restore
├── profile.ts               ← Profile updates, avatar
├── receptionist-dashboard.ts ← Receptionist KPI and in-session board queries
├── settings.ts              ← Staff, departments, insurance, services, clinic
├── staff-files.ts           ← Staff document management
├── theme.ts                 ← UI theme preference
└── time-slots.ts            ← Doctor availability and working-hour slot queries
```

---

## Authentication & RBAC

### Authentication Flow

1. User submits credentials on `/login`
2. Supabase Auth validates and sets an httpOnly session cookie via `@supabase/ssr`
3. Middleware (`middleware.ts`) runs on every protected route, refreshes the session token, and checks page visibility
4. A `cf_page_visibility` cookie (httpOnly, secure, 1h TTL) caches the user's accessible page slugs to avoid a DB round-trip on every navigation
5. Server components call `requireRole()` or `requireUser()` from `lib/rbac.ts` as the final authorization check

### User Roles

| Role | Dashboard | Patients | Appointments | Medical Notes | Revenue | Reports | Settings |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| `admin` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `receptionist` | ✓ | ✓ | ✓ | read-only | — | ✓ | — |
| `doctor` | ✓ | ✓ | ✓ | ✓ | — | — | — |
| `manager` | ✓ | — | — | — | ✓ | ✓ | ✓ |

Receptionists can read and print medical notes for active patients in their clinic (enforced by RLS in `medical_notes_select_role_scoped`); creation, edit, and delete remain admin/doctor only. Doctors see medical notes for patients they authored, are assigned to, or who share their department.

Admins can grant per-user page visibility overrides through Settings → Staff, allowing a receptionist to see revenue pages without a full role change.

### RBAC Implementation

`lib/rbac.ts` exports:

- `getAuthedUser()` — returns `AuthedUser | null`; returns null for deactivated or deleted profiles
- `requireUser()` — throws a redirect to `/login` if no valid session
- `requireRole(roles)` — throws a redirect to `/dashboard` if the user's role is not in the allowed set; also validates the profile is active

`lib/page-permissions.ts` defines `ROLE_PAGE_SLUGS`, mapping each role to the set of page slugs they can access by default.

---

## Database

### Schema

50 migrations under `supabase/migrations/`. The schema contains 23 public tables:

| Table | Purpose |
|---|---|
| `clinics` | Clinic settings and branding |
| `clinic_working_hours` | Weekly clinic opening intervals — when the clinic is open (non-overlapping) |
| `staff_shift_templates` | Reusable named staff shifts (Morning, Evening, …) — may overlap |
| `doctor_schedules` | Per-staff concrete working intervals, one or more per weekday |
| `profiles` | User accounts linked to Supabase Auth |
| `patients` | Patient demographic records |
| `appointments` | Appointment scheduling and billing |
| `appointment_services` | Line items per appointment |
| `services` | Clinic service catalog |
| `departments` | Clinic departments with color coding |
| `insurance_providers` | Insurance company records |
| `medical_notes` | Doctor-authored clinical notes |
| `medical_note_attachments` | File attachments per medical note |
| `feedback` | Appointment feedback records |
| `follow_ups` | Post-appointment follow-up scheduling |
| `outstanding_settlements` | Insurance settlement tracking |
| `patient_deposits` | Pre-paid deposit balances |
| `patient_documents` | General patient file uploads |
| `patient_packages` | Patient-purchased session packages |
| `package_templates` | Reusable per-department package definitions |
| `audit_logs` | Immutable log of all sensitive operations |
| `staff_invitations` | Pending staff invite tokens |
| `user_customizations` | Per-user UI preferences |
| `user_page_permissions` | Per-user page visibility overrides |

Every core table carries a `clinic_id` column for multi-tenant data isolation, enforced at the RLS layer.

### RLS Philosophy

Row-Level Security is the **primary** access control mechanism. Middleware and server-side RBAC are secondary. Even if application code were bypassed, RLS policies prevent cross-clinic data access.

Core Postgres helper functions (all `SECURITY DEFINER`, called only in RLS policies):

- `auth_profile()` — returns the calling user's profile row
- `auth_role()` — returns the calling user's role string
- `auth_clinic_id()` — returns the calling user's clinic UUID

### Appointment Status Machine

Transitions are enforced by a database-level trigger (`enforce_appointment_transition`):

```
pending ──► confirmed ──► arrived ──► in_session ──► completed
   │            │            │             │
   │            ├────────────┴─────────────┴──► cancelled
   │            │            │             │
   │            └────────────┴─────────────┴──► no_show
   │
   └──► cancelled
```

In addition, `pending` may transition directly to `completed` when reception charges a walk-in or same-day booking. `arrived` and `in_session` can also step back (`arrived → confirmed`, `in_session → arrived`) via the `undo_appointment_status` RPC, which preserves slot constraints. Terminal states (`completed`, `cancelled`, `no_show`) have no outgoing transitions.

Invalid transitions (e.g. `completed → pending`) are rejected at the database level before any application logic runs.

### Key Database Functions / RPCs

| Function | Purpose |
|---|---|
| `soft_delete_patient(p_patient_id)` | Soft-deletes a patient and writes to audit_log |
| `complete_appointment_billing(...)` | Transactional billing: marks appointment paid, records services, writes audit |
| `complete_appointment_billing_with_previous_settlement(...)` | Billing variant that closes an outstanding insurance settlement |
| `undo_appointment_billing(...)` | Reverses a completed billing in a single transaction |
| `undo_appointment_billing_with_previous_settlement(...)` | Undo variant for settlement-linked appointments |
| `undo_appointment_status(...)` | Steps an appointment back to a prior non-terminal status while preserving slot constraints |
| `get_cancellation_report(...)` | Aggregates cancellation counts, reasons, and ratios for a date range |
| `get_no_show_report(...)` | Aggregates no-show counts and rates per doctor for a date range |
| `get_doctor_performance_report(...)` | Doctor throughput, completion, and cancellation metrics for a date range |
| `get_receptionist_performance_report(...)` | Receptionist booking and confirmation metrics for a date range |

---

## Appointment Lifecycle

### Scheduling

1. Receptionist or admin opens `/appointments/new`
2. Form validates time slot conflicts against existing appointments for the same doctor
3. On submit, `createAppointment` server action writes the record with `status = "pending"`

### Status Transitions

Staff update status via the `AppointmentActions` component. The allowed graph is defined in `STATUS_TRANSITIONS` (`lib/validations/appointment.ts`) and enforced again by the database trigger:

- `pending → confirmed | completed | cancelled`
- `confirmed → arrived | completed | cancelled | no_show`
- `arrived → in_session | completed | confirmed | cancelled | no_show`
- `in_session → completed | arrived | cancelled | no_show`

Receptionists and admins can drive the workflow through all of these states; completing an appointment opens the billing dialog. Backwards steps (`arrived → confirmed`, `in_session → arrived`) route through `undo_appointment_status` so slot uniqueness is preserved. Appointments in `arrived` or `in_session` are protected from deletion at the database level (`protect_in_visit_appointment_deletion`).

### Billing & Settlement

Appointment billing is handled by Postgres RPCs for atomicity:

- **Direct payment**: `complete_appointment_billing` — sets `paid_at`, records `appointment_services` line items, debits any deposit, writes audit log
- **Insurance settlement**: `complete_appointment_billing_with_previous_settlement` — same as above but also marks an outstanding settlement as resolved
- **Undo**: `undo_appointment_billing` / `undo_appointment_billing_with_previous_settlement` — reverses all changes in one transaction

### Deletion Guard

`softDeleteAppointment` enforces a hard block before soft-deleting:

```
blocked if: status IN ("completed", "arrived", "in_session")
         OR paid_at IS NOT NULL
         OR paid_amount > 0
         OR total_amount > 0
```

Any appointment that has been billed, or that is currently in the visit workflow (`arrived` or `in_session`), cannot be trashed. The same guard is mirrored at the database level by `protect_in_visit_appointment_deletion`. This prevents audit trail gaps and accidental loss of in-progress visits.

---

## Patient Management

### File Numbers

Every new patient is assigned an auto-incremented file number in `CF-NNNN` format (e.g. `CF-0001`). The number is generated in the `createPatient` action by querying the highest existing file number and incrementing it.

### Soft Delete

Patients use an `is_deleted` boolean flag rather than a `deleted_at` timestamp. The `soft_delete_patient` Postgres RPC handles deletion and writes to `audit_logs`. Restoration sets `is_deleted = false` and revalidates the patient page.

### Attachments & Documents

- **Medical note attachments** — uploaded to Supabase Storage; tracked in the `medical_notes` relation; note authors can manage their own attachments; admins can manage all
- **Patient documents** — general file uploads per patient, managed via `patient-documents.ts`
- **Patient avatars** — uploaded to Storage; managed via `patient-avatar.ts`
- **Staff files** — staff profile documents, separate storage path

---

## Patient Packages

Patients may purchase multi-session packages (e.g. a 10-session physiotherapy plan), tracked in the `patient_packages` table with `total_sessions`, `used_sessions`, and an optional `price_per_session`. A check constraint guarantees `used_sessions <= total_sessions`.

- **Package templates** (`package_templates`, managed via `actions/package-templates.ts` and `/settings/packages`) define reusable per-department defaults — name, session count, and pricing — that admins/managers can re-apply when creating new patient packages.
- **Appointment linkage** — `appointments.package_id` and `appointments.package_session_number` attach a scheduled visit to a specific package and session index.
- **RLS** — all package access is scoped by `clinic_id`; mutation policies follow the same role rules as the rest of the schema and are covered by `patient_packages_rls` and `package_templates_rls` migrations.

---

## Reports Module

A read-only operational reporting module is exposed under `/reports`, accessible to `admin`, `manager`, and `receptionist`. Doctor-facing performance reports (`/reports/doctors`, `/reports/receptionists`) are restricted to `admin` and `manager` via `canSeePerformanceReports` (`types/reports.ts`).

| Route | Backing RPC | Purpose |
|---|---|---|
| `/reports/cancellations` | `get_cancellation_report` | Cancellation counts, top reasons, per-doctor breakdown |
| `/reports/no-shows` | `get_no_show_report` | No-show counts and rates per doctor |
| `/reports/doctors` | `get_doctor_performance_report` | Doctor throughput, completion, cancellation metrics |
| `/reports/receptionists` | `get_receptionist_performance_report` | Receptionist booking and confirmation metrics |
| `/reports/follow-ups` | `followups` dashboard query | Follow-up outcomes and pending workload |
| `/reports/revenue` | `revenue_summary` RPC | Revenue, payments by method, and settlements |

All report RPCs run with `security invoker`, derive `clinic_id` from `auth_clinic_id()`, and reject doctor callers explicitly.

---

## Trash & Soft-Delete Architecture

The system uses a **recycle bin** model for appointments, departments, insurance providers, services, and staff records. Patients use a separate `is_deleted` flag.

### Appointments Trash

- `softDeleteAppointment` — sets `deleted_at = now()` on the appointment (subject to deletion guard)
- `restoreAppointment` — clears `deleted_at`
- `permanentDeleteAppointment` — hard-deletes a single trashed appointment after cleaning dependents
- `emptyAppointmentsTrash` — batch hard-delete of all trashed appointments using `.in()` queries across all dependent tables:
  1. Fetch all trashed appointment IDs for the clinic
  2. Batch delete `appointment_services` where `appointment_id IN (ids)`
  3. Batch delete `feedback` where `appointment_id IN (ids)`
  4. Batch delete `follow_ups` where `appointment_id IN (ids)`
  5. Batch delete `outstanding_settlements` where `appointment_id IN (ids)`
  6. Batch delete `appointments` where `id IN (ids)`

This is O(5) queries regardless of trash size, not O(n×4).

### UI Pattern

All destructive actions in the UI are wrapped in shadcn/ui `AlertDialog` confirmation dialogs. Toast notifications include an **Undo** action (15-second window for medical notes, 10 seconds for appointments) that calls the corresponding restore action client-side.

---

## Security Hardening

### HTTP Security Headers

Set globally in `next.config.ts` via `async headers()` matching `(.*)`:

| Header | Value |
|---|---|
| `X-Frame-Options` | `DENY` |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains; preload` |
| `Content-Security-Policy` | `default-src 'self'`; restricted script/style/connect to Supabase and Sentry |
| `frame-ancestors` | `'none'` |

### Audit Logging

All sensitive operations (patient deletions, billing, staff changes) write immutable records to the `audit_logs` table. Audit writes happen inside database transactions or RPCs so they cannot succeed without the primary operation.

### Session Security

- Sessions managed by `@supabase/ssr` with httpOnly cookies
- `cf_page_visibility` cookie: httpOnly, Secure, SameSite=Lax, 1h TTL
- Admin-level operations use a separate service-role client (`createAdminClient`) that never touches the browser

### Input Validation

All server actions validate input with Zod schemas before any database call. Invalid inputs return field-level errors without reaching the database.

---

## Testing Architecture

### Test Infrastructure

```
tests/
├── unit/
│   ├── helpers/
│   │   └── server-action-mocks.ts   ← QueryBuilder mock infrastructure
│   ├── mocks/
│   │   └── server-only.ts
│   ├── setup.ts
│   └── actions/                     ← 14 server-action test files
│       ├── appointment-deletion-safety.test.ts
│       ├── appointment-form-autofill.test.tsx
│       ├── appointment-validation-conflicts.test.ts
│       ├── auth-staff-boundaries.test.ts
│       ├── billing-settlement-actions.test.ts
│       ├── medical-note-attachments.test.ts
│       ├── patient-avatar-pages.test.ts
│       ├── patient-avatar.test.ts
│       ├── patient-crud.test.ts
│       ├── patient-documents.test.ts
│       ├── patient-note-access.test.ts
│       ├── patient-trash.test.ts
│       ├── profile-avatar.test.ts
│       └── staff-files.test.ts
└── e2e/                             ← Playwright specs (require live Supabase)

Total suite: 46 test files, 270 passing tests (Vitest v4).
```

### Mock Architecture

`createServerActionMocks()` provides a `QueryBuilder` class that:
- Intercepts all Supabase table operations and logs them to `state.queryLog`
- Supports `state.tableResults["table.operation"]` to return fixture data (supports Array sequences for multiple calls to the same key)
- Mocks `revalidatePath`, `redirect`, `requireRole`, and `rpc` calls
- Allows tests to `vi.doMock` the Supabase clients before dynamically importing server actions

### Test Coverage Focus

- Appointment deletion guard (all 4 block conditions)
- Batch trash empty operation
- Patient CRUD with file number generation
- Billing and settlement RPCs
- Role boundary enforcement
- Form validation before DB hits
- Medical note and attachment access control

### Running Tests

```bash
pnpm test          # Unit tests (single run)
pnpm test:watch    # Unit tests (watch mode)
pnpm test:e2e      # E2E tests (requires local Supabase running)
```

---

## Deployment Architecture

### Vercel

The project deploys to Vercel as a Next.js App Router application. Configuration is in `.vercel/project.json`. GitHub Actions CI runs on push to `main`.

### Environment Variables

| Variable | Required | Purpose |
|---|:---:|---|
| `NEXT_PUBLIC_SUPABASE_URL` | ✓ | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | ✓ | Supabase public anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | ✓ | Service role key (server-only, never exposed to browser) |
| `NEXT_PUBLIC_SENTRY_DSN` | — | Sentry DSN; Sentry is a no-op if omitted |
| `SENTRY_AUTH_TOKEN` | — | Required only to upload source maps during build |
| `RESEND_API_KEY` | — | Required for transactional email |

### Supabase Setup

1. Create a project in the Supabase Dashboard
2. Run all migrations: `supabase db push` (or apply via Dashboard SQL editor)
3. Enable email auth in Authentication → Providers
4. Create a storage bucket named `clinic-files` with appropriate RLS policies
5. Set `SUPABASE_SERVICE_ROLE_KEY` in environment (never commit to git)

---

## Folder Structure

```
clinicflow-crm/
├── app/                    ← Next.js App Router
│   ├── (auth)/             ← Login, password reset
│   ├── (protected)/        ← All authenticated pages
│   └── auth/confirm/       ← Email confirmation callback
├── actions/                ← Server Actions (18 files)
├── components/
│   ├── appointments/       ← Calendar views, booking form, status controls
│   ├── patients/           ← Patient list, detail, forms, medical notes
│   ├── dashboard/          ← Role-specific dashboard widgets
│   ├── settings/           ← Staff, departments, insurance, services forms
│   ├── ui/                 ← shadcn/ui primitives
│   └── ...
├── lib/
│   ├── rbac.ts             ← Authentication & role enforcement
│   ├── page-permissions.ts ← Role → page slug mapping
│   ├── supabase/
│   │   ├── server.ts       ← RLS-scoped client (Server Components / Actions)
│   │   ├── admin.ts        ← Service-role client (privileged operations only)
│   │   ├── client.ts       ← Browser client (read-only data fetching)
│   │   └── middleware.ts   ← Session refresh + page visibility check
│   └── ...
├── supabase/
│   └── migrations/         ← 50 migration files
├── tests/
│   ├── unit/               ← 270 tests across 46 test files
│   └── e2e/                ← Playwright specs
├── types/
│   └── database.ts         ← Generated Supabase types
├── middleware.ts            ← Next.js middleware entry point
└── next.config.ts          ← Security headers + Sentry config
```

---

## Known Limitations

- **Single clinic per deployment** — the `clinic_id` column and multi-tenant schema exist, but the UI assumes a single clinic. Clinic-switching is not implemented.
- **No real-time updates** — appointment and patient lists refresh on navigation; Supabase Realtime subscriptions are not currently wired up.
- **Email delivery** — transactional email via Resend is wired for auth flows; appointment reminders and patient notifications are not implemented.
- **CSV export** — infrastructure exists; UI-level export triggers are partially implemented.
- **Mobile** — the UI is responsive but optimized for desktop clinic workstations; the week calendar requires horizontal scroll on small screens.
- **Audit log viewer** — audit records are written but there is no in-app UI to browse them; requires direct database access.

---

## Production Readiness Summary

| Area | Status |
|---|---|
| Authentication & session security | Complete |
| Role-based access control | Complete |
| RLS policies on all 23 tables | Complete |
| HTTP security headers (CSP, HSTS, X-Frame-Options) | Complete |
| Input validation (Zod) on all server actions | Complete |
| Audit logging for sensitive operations | Complete |
| Soft-delete with recycle bin UI | Complete |
| Billing deletion guard | Complete |
| Confirmation dialogs on all destructive actions | Complete |
| 270 passing unit tests | Complete |
| Sentry error tracking (optional) | Complete |
| Vercel deployment config | Complete |
| Database migrations (50 total) | Complete |
