# ClinicFlow CRM

![Status](https://img.shields.io/badge/status-production-success)
![License](https://img.shields.io/badge/license-MIT-blue)
![Next.js](https://img.shields.io/badge/Next.js-15-black?logo=next.js)
![Tests](https://img.shields.io/badge/tests-270%20passing-brightgreen)

A **staff-only** clinic management system for small-to-medium private clinics. Built as a graduation project at Üsküdar University and deployed to production on Vercel + Supabase.

Replaces paper appointment books, phone scheduling, and Excel patient records with a single integrated platform — covering appointments, billing, patient records, follow-ups, medical notes, and role-scoped analytics.

> Patients are data records only. They have no accounts and do not interact with the system. All operations are performed exclusively by clinic staff.

---

## Table of Contents

- [Features](#features)
- [Screenshots](#screenshots)
- [Tech Stack](#tech-stack)
- [Architecture Overview](#architecture-overview)
- [User Roles](#user-roles)
- [Core Modules](#core-modules)
- [Reports & Printing](#reports--printing)
- [Security](#security)
- [Testing](#testing)
- [Local Development](#local-development)
- [Deployment](#deployment)
- [Future Improvements](#future-improvements)
- [Author](#author)

---

## Features

**Patient Management**
- Create, edit, and soft-delete patient records with auto-assigned file numbers (`CF-0001`, `CF-0002`, …)
- Patient profile with full appointment history, medical notes, and billing records
- Recycle bin with restore and permanent-delete

**Appointment Scheduling**
- Day, week, and month calendar views
- Conflict handling for confirmed appointments with pending overlap and displacement support
- Database-enforced appointment status state machine (`pending → confirmed → completed / cancelled / no-show`)
- Appointment detail modal with inline status transitions

**Billing & Revenue**
- Service line items per appointment
- Insurance settlement workflows with outstanding settlement tracking
- Transactional Postgres RPCs — billing cannot partially succeed
- Undo billing within a grace window
- Revenue dashboard with transaction history

**Follow-ups**
- Post-appointment follow-up scheduling
- Pending and completed follow-up views
- Quick-record follow-up modal from any appointment

**Medical Notes**
- Doctor-authored clinical notes per patient
- File attachments per note
- Author and role-scoped access control

**Role-Scoped Dashboards**
- Admin, Receptionist, Doctor, and Manager each have a tailored dashboard with relevant KPIs
- Charts powered by Recharts

**Settings & Staff Management**
- Staff management with role assignment and per-user page visibility overrides
- Departments with color coding
- Insurance provider catalog
- Service catalog with pricing
- Clinic profile and branding
- Per-user UI customization

**UX & Reliability**
- Dark and light mode
- Responsive layout (optimized for desktop clinic workstations)
- Confirmation dialogs on all destructive actions
- Toast notifications with Undo actions (10–15 second window)
- Audit logging for all sensitive operations

---

## Screenshots

### Login

| Light | Dark |
|---|---|
| ![Login](docs/screenshots/auth/login.png) | ![Login Dark](docs/screenshots/auth/login-2.png) |

---

### Dashboard

**Admin Dashboard**

| Light | Dark |
|---|---|
| ![Dashboard](docs/screenshots/dashboard/dashboard.png) | ![Dashboard Dark](docs/screenshots/dashboard/dashboard-dark.png) |

**Admin Analytics**

| Light | Dark |
|---|---|
| ![Analytics](docs/screenshots/dashboard/dashboard-analytics.png) | ![Analytics Dark](docs/screenshots/dashboard/dashboard-analytics-dark.png) |

**Doctor Dashboard**

| Light | Dark |
|---|---|
| ![Doctor Dashboard](docs/screenshots/dashboard/doctor-dashboard.png) | ![Doctor Dashboard Dark](docs/screenshots/dashboard/doctor-dashboard-dark.png) |

**Manager Analytics**

| Light | Dark |
|---|---|
| ![Manager Analytics](docs/screenshots/dashboard/manager-analytics.png) | ![Manager Analytics Dark](docs/screenshots/dashboard/manager-analytics-dark.png) |

**Receptionist Dashboard**

![Receptionist Dashboard](docs/screenshots/dashboard/receptionist-dashboard.png)

---

### Appointment Calendar

**Week View**

![Appointments Week View](docs/screenshots/appointments/appointments-week-view.png)

**Day View**

| Light | Dark |
|---|---|
| ![Day View](docs/screenshots/appointments/appointments-day-view.png) | ![Day View Dark](docs/screenshots/appointments/appointments-day-view-dark.png) |

**Month View**

| Light | Dark |
|---|---|
| ![Month View](docs/screenshots/appointments/appointments-month-view.png) | ![Month View Dark](docs/screenshots/appointments/appointments-month-view-dark.png) |

---

### Appointment Details & Actions

**Appointment Detail — Pending**

| Light | Dark |
|---|---|
| ![Appointment Detail](docs/screenshots/appointments/appointment-detail-pending.png) | ![Appointment Detail Dark](docs/screenshots/appointments/appointment-detail-pending-dark.png) |

**Appointment Detail — Completed**

![Appointment Completed Dark](docs/screenshots/appointments/appointment-detail-completed-dark.png)

**Appointment Card Popup**

![Appointment Card Popup](docs/screenshots/appointments/appointment-card-popup.png)

**Status Actions**

![Appointment Actions Dark](docs/screenshots/appointments/appointment-actions-dark.png)

**New Appointment Form**

| Light | Dark |
|---|---|
| ![New Appointment](docs/screenshots/appointments/new-appointment-form.png) | ![New Appointment Dark](docs/screenshots/appointments/new-appointment-form-dark.png) |

**Cancel & No-Show Modals**

| Cancel | No-Show |
|---|---|
| ![Cancel Modal Dark](docs/screenshots/appointments/cancel-appointment-modal-dark.png) | ![No-Show Modal Dark](docs/screenshots/appointments/noshow-modal-dark.png) |

---

### Patient Management

**Patient List**

| Light | Dark |
|---|---|
| ![Patients List](docs/screenshots/patients/patients-list.png) | ![Patients List Dark](docs/screenshots/patients/patients-list-dark.png) |

**Patient Profile**

| Light | Dark |
|---|---|
| ![Patient Profile](docs/screenshots/patients/patient-profile.png) | ![Patient Profile Dark](docs/screenshots/patients/patient-profile-dark.png) |

**Patient Profile with Medical Records**

![Patient Profile with Records](docs/screenshots/patients/patient-profile-with-records.png)

**New Patient Form**

![New Patient Form Dark](docs/screenshots/patients/new-patient-form-dark.png)

**Patient Appointments Section**

![Patient Appointments Dark](docs/screenshots/patients/patient-appointments-section-dark.png)

**Patient Invoice Detail**

| Collapsed | Full Detail |
|---|---|
| ![Invoice Collapsed](docs/screenshots/patients/patient-appointment-invoice-dark.png) | ![Invoice Detail](docs/screenshots/patients/patient-appointment-invoice-detail.png) |

**Medical Notes**

![Medical Notes Dark](docs/screenshots/patients/medical-notes-dark.png)

---

### Billing & Revenue

**Billing Invoice Modal**

![Billing Invoice Modal](docs/screenshots/billing/billing-invoice-modal.png)

**Revenue & Transactions**

| Light | Dark |
|---|---|
| ![Revenue](docs/screenshots/billing/revenue-transactions.png) | ![Revenue Dark](docs/screenshots/billing/revenue-transactions-dark.png) |

---

### Follow-ups

**Pending Follow-ups**

| Light | Dark |
|---|---|
| ![Follow-ups](docs/screenshots/followups/followups.png) | ![Follow-ups Dark](docs/screenshots/followups/followups-dark.png) |

**Completed Follow-ups**

| Light | Dark |
|---|---|
| ![Completed Follow-ups](docs/screenshots/followups/completed-followups.png) | ![Completed Follow-ups Dark](docs/screenshots/followups/completed-followups-dark.png) |

**Record Follow-up Modal**

| Light | Dark |
|---|---|
| ![Record Follow-up](docs/screenshots/followups/record-followup-modal.png) | ![Record Follow-up Dark](docs/screenshots/followups/record-followup-modal-dark.png) |

---

### Reports & Printing

**Appointments Report**

![Appointments Report](docs/screenshots/reports/appointments-report.png)

**Expanded Report View**

![Appointments Report Expanded](docs/screenshots/reports/appointments-report-expanded.png)

**Print Preview**

![Print Preview](docs/screenshots/reports/print-preview-report.png)

---

### Staff Management

**Staff Settings**

| Light | Dark |
|---|---|
| ![Staff Settings](docs/screenshots/settings/settings-staff.png) | ![Staff Settings Dark](docs/screenshots/settings/settings-staff-dark.png) |

**Staff Member Profile**

| Light | Dark |
|---|---|
| ![Staff Profile](docs/screenshots/staff/staff-member-profile.png) | ![Staff Profile Dark](docs/screenshots/staff/staff-member-profile-dark.png) |

**Staff Member Documents**

| Light | Dark |
|---|---|
| ![Staff Documents](docs/screenshots/staff/staff-member-documents.png) | ![Staff Documents Dark](docs/screenshots/staff/staff-member-documents-dark.png) |

---

### Settings

**Departments**

| Light | Dark |
|---|---|
| ![Departments](docs/screenshots/settings/settings-departments.png) | ![Departments Dark](docs/screenshots/settings/settings-departments-dark.png) |

**Insurance Providers**

| Light | Dark |
|---|---|
| ![Insurance](docs/screenshots/settings/settings-insurance.png) | ![Insurance Dark](docs/screenshots/settings/settings-insurance-dark.png) |

**Services Catalog**

| Light | Dark |
|---|---|
| ![Services](docs/screenshots/settings/settings-services.png) | ![Services Dark](docs/screenshots/settings/settings-services-dark.png) |

**Clinic Profile**

| Light | Dark |
|---|---|
| ![Clinic Settings](docs/screenshots/settings/settings-clinic.png) | ![Clinic Settings Dark](docs/screenshots/settings/settings-clinic-dark.png) |

**UI Customization**

| Light | Dark |
|---|---|
| ![Customize](docs/screenshots/settings/settings-customize.png) | ![Customize Dark](docs/screenshots/settings/settings-customize-dark.png) |

---

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 16 (App Router) |
| Language | TypeScript — strict mode |
| Database | Supabase Postgres |
| Auth | Supabase Auth + `@supabase/ssr` |
| Storage | Supabase Storage |
| Styling | Tailwind CSS + shadcn/ui |
| Forms | React Hook Form + Zod v4 |
| Tables | TanStack Table v8 |
| Charts | Recharts |
| Error Tracking | Sentry (optional) |
| Email | Resend |
| Testing | Vitest v4 + Playwright 1.59 |
| Deployment | Vercel |

---

## Architecture Overview

```
Browser
  │
  ├── Next.js Middleware (middleware.ts)
  │     ├── Session refresh via @supabase/ssr
  │     └── Page visibility guard (cf_page_visibility cookie)
  │
  ├── App Router Route Groups
  │     ├── (auth)/     — Login, password reset
  │     └── (protected)/ — All authenticated pages
  │
  ├── Server Components
  │     └── requireRole() / requireUser() — final auth check
  │
  └── Server Actions (actions/)
        ├── Zod validation → reject invalid input before DB
        ├── Supabase RLS-scoped client for normal operations
        └── Postgres RPCs for transactional billing operations
```

**Key design points:**

- **RLS as primary guard** — Row-Level Security on all 16 tables is the outermost security layer. Middleware and server-side RBAC are secondary.
- **Server Actions only** — all mutations go through Next.js Server Actions. No writable API routes exist.
- **Session caching** — a `cf_page_visibility` cookie (httpOnly, 1h TTL) caches accessible page slugs to avoid a DB round-trip on every navigation.
- **Postgres-native billing** — billing RPCs are `SECURITY DEFINER` functions so they are atomic and cannot partially succeed.
- **Audit trail** — patient deletions, billing events, and staff changes write immutable records to `audit_logs` inside the same transaction.

---

## User Roles

| Role | Dashboard | Patients | Appointments | Medical Notes | Revenue | Settings |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| `admin` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `receptionist` | ✓ | ✓ | ✓ | — | — | — |
| `doctor` | ✓ | ✓ | ✓ | ✓ | — | — |
| `manager` | ✓ | — | — | — | ✓ | — |

Admins can grant **per-user page visibility overrides** through Settings → Staff — allowing, for example, a receptionist to access revenue pages without a full role change.

---

## Core Modules

### Appointments

The appointment lifecycle is enforced by a database-level trigger:

```
pending ──► confirmed ──► completed
   │             │
   └──► cancelled ◄──► no_show
```

Invalid status transitions are rejected at the database level. Appointments with any billing data (`paid_at`, `paid_amount`, `total_amount`) cannot be soft-deleted — preventing audit trail gaps.

### Billing

Billing operations are handled by Postgres RPCs for atomicity:

| RPC | Purpose |
|---|---|
| `complete_appointment_billing` | Direct payment — sets paid fields, records services, debits deposits, writes audit |
| `complete_appointment_billing_with_previous_settlement` | Same as above + closes an outstanding insurance settlement |
| `undo_appointment_billing` | Full reversal in a single transaction |
| `undo_appointment_billing_with_previous_settlement` | Undo variant for settlement-linked appointments |

### Follow-ups

Scheduled after appointments. Displayed in pending and completed views. Staff can record outcomes inline via a quick modal without leaving the follow-ups page.

### Medical Notes

Doctor-authored notes attached to patient records. Each note can carry file attachments stored in Supabase Storage. Access is scoped to the note author and admin users.

### Patient Management

Every patient receives an auto-assigned file number (`CF-NNNN`). Soft-deleted patients go to a recycle bin with restore capability. The patient profile aggregates appointments, billing history, medical notes, and documents in a single view.

### Staff Management

Staff are invited via email tokens. Admins can assign roles, set department membership, manage per-user page visibility, upload documents, and deactivate accounts.

---

## Reports & Printing

The reports module provides filterable appointment reports with expandable detail rows. Reports can be printed or exported — the print preview renders a clean, clinic-branded layout stripped of navigation chrome.

Available filters:
- Date range
- Doctor
- Status (`pending`, `confirmed`, `completed`, `cancelled`, `no_show`)
- Patient

The print preview is triggered directly from the report view. Printed output includes clinic branding, patient name, service breakdown, and billing totals.

---

## Security

- **RLS on all 16 tables** — `clinic_id` column on every core table, enforced by Row-Level Security. Cross-clinic data leakage is impossible at the database layer.
- **HTTP security headers** — CSP, HSTS (`max-age=63072000; includeSubDomains; preload`), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Permissions-Policy` — set globally in `next.config.ts`.
- **Server Actions only** — no writable API routes. All mutations require a valid server-side session.
- **Input validation** — Zod schemas validate all server action inputs before any database call. Invalid input returns field-level errors without touching the database.
- **Audit logging** — patient deletions, billing events, and staff changes write immutable records to `audit_logs` inside the same transaction.
- **Service role isolation** — `SUPABASE_SERVICE_ROLE_KEY` is used only in `createAdminClient()` on the server and is never exposed to the browser.
- **Session security** — httpOnly cookies via `@supabase/ssr`; page visibility cache cookie is httpOnly, Secure, SameSite=Lax, 1h TTL.
- **Billing deletion guard** — appointments with any billing data cannot be soft-deleted. Enforced server-side before any DB write.

---

## Testing

**270 unit tests across 46 test files.** Tests use a `QueryBuilder` mock that intercepts all Supabase operations and logs them to a `queryLog` for assertion — no live database required.

Coverage includes:

- Appointment deletion guard (all 4 billing block conditions)
- Batch trash empty with `.in()` verification across all dependent tables
- Patient CRUD with file number generation sequences
- Billing and settlement RPCs
- Role boundary enforcement
- Form validation short-circuits (invalid input never reaches DB)
- Medical note and attachment access control

```bash
pnpm test          # unit tests (single run)
pnpm test:watch    # unit tests (watch mode)
pnpm test:e2e      # Playwright E2E (requires local Supabase)
pnpm tsc --noEmit  # TypeScript type check
pnpm lint          # ESLint
pnpm build         # production build
```

---

## Local Development

### Prerequisites

- Node.js 20+
- pnpm 9+ (`npm install -g pnpm`)
- A [Supabase](https://supabase.com) project
- [Supabase CLI](https://supabase.com/docs/guides/cli)

### Setup

```bash
git clone <repo-url>
cd clinicflow-crm
pnpm install
cp .env.example .env.local   # fill in your Supabase credentials
```

**Apply migrations:**

```bash
supabase link --project-ref <your-project-ref>
supabase db push
```

**Create the storage bucket** (Supabase Dashboard → SQL editor):

```sql
INSERT INTO storage.buckets (id, name, public)
VALUES ('clinic-files', 'clinic-files', false);
```

**Seed an admin account:**

Create a user in Supabase Dashboard → Authentication → Users, then promote them:

```sql
UPDATE profiles
SET role = 'admin', is_active = true, clinic_id = '<clinic-uuid>'
WHERE id = '<user-uuid>';
```

**Start the dev server:**

```bash
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000) — the root redirects to `/login`.

### Environment Variables

| Variable | Required | Purpose |
|---|:---:|---|
| `NEXT_PUBLIC_SUPABASE_URL` | ✓ | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | ✓ | Supabase public anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | ✓ | Service role key — server-only, never expose to browser |
| `NEXT_PUBLIC_SENTRY_DSN` | — | Sentry DSN; Sentry is a no-op if omitted |
| `SENTRY_AUTH_TOKEN` | — | Source map upload during build (optional) |
| `RESEND_API_KEY` | — | Transactional email |

---

## Deployment

The project deploys to **Vercel** as a Next.js App Router application. Vercel auto-detects the framework and runs `next build`.

1. Push to GitHub and import the project in the [Vercel Dashboard](https://vercel.com)
2. Set the environment variables listed above under Project → Settings → Environment Variables
3. Deploy

**Supabase setup checklist:**

- [ ] All 41 migrations applied (`supabase db push`)
- [ ] Email auth enabled in Authentication → Providers
- [ ] Storage bucket `clinic-files` created with RLS policies
- [ ] Admin account seeded
- [ ] `SUPABASE_SERVICE_ROLE_KEY` not committed to git

**Full pre-deploy checklist:** [docs/deployment-checklist.md](docs/deployment-checklist.md)

---

## Project Structure

```
clinicflow-crm/
├── app/
│   ├── (auth)/             ← Login, password reset, email confirmation
│   └── (protected)/        ← All authenticated pages (role-gated)
├── actions/                ← Server Actions — all mutations live here (14 files)
├── components/             ← React components organized by domain
├── lib/
│   ├── rbac.ts             ← Session validation & role enforcement
│   ├── page-permissions.ts ← Role → accessible page slug mapping
│   └── supabase/           ← Client factory functions (server / admin / client / middleware)
├── supabase/
│   └── migrations/         ← 41 SQL migration files
├── tests/
│   ├── unit/               ← Vitest — 270 tests, 46 files
│   └── e2e/                ← Playwright specs
├── types/
│   └── database.ts         ← Generated Supabase TypeScript types
├── docs/
│   ├── screenshots/        ← Organized UI screenshots by module
│   ├── raw-screenshots/    ← Original unorganized screenshots
│   └── deployment-checklist.md
├── middleware.ts            ← Session refresh + page visibility guard
└── next.config.ts          ← Security headers, Sentry config
```

---

## Future Improvements

- **Real-time updates** — Supabase Realtime subscriptions for live appointment board updates
- **Appointment reminders** — automated SMS/email reminders via Resend before scheduled appointments
- **Audit log viewer** — in-app UI to browse `audit_logs` (records are written; no viewer exists yet)
- **CSV/PDF export** — infrastructure exists; UI-level export triggers are partially implemented
- **Multi-clinic support** — the schema supports `clinic_id` multi-tenancy; clinic-switching UI is not implemented
- **Mobile optimization** — the week calendar requires horizontal scroll on small screens; a dedicated mobile calendar view would improve the experience
- **Patient portal** — read-only portal for patients to view their appointment history (out of scope for v1)

---

## Author

**Mohamed Hassan Mohamed Ibrahim**  
Senior Software Engineering Student  
Üsküdar University — Istanbul, Türkiye

---

## License

[MIT](./LICENSE)
