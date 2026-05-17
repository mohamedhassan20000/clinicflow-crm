# ClinicFlow CRM

![Status](https://img.shields.io/badge/status-production-success)
![License](https://img.shields.io/badge/license-MIT-blue)
![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=next.js)
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
- Database-enforced appointment status state machine (`pending → confirmed → arrived → in_session → completed`, with `cancelled` / `no_show` exits and reception walk-in shortcut `pending → completed`)
- In-visit tracking (`arrived`, `in_session`) with safe back-steps via `undo_appointment_status`
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
- Role-scoped access (doctors see notes for patients they authored, are assigned to, or share a department with; receptionists have read/print access; admins see all)

**Patient Packages**

- Multi-session packages tracked per patient with used/total session counts
- Reusable per-department package templates under `Settings → Packages`
- Appointments link to a specific package and session number

**Operational Reports**

- Cancellations, no-shows, doctor performance, receptionist performance, follow-ups, and revenue summary
- Backed by `security invoker` Postgres RPCs scoped to the caller's clinic
- Print-ready layouts with clinic branding

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

<details>
<summary>Authentication</summary>

| Light                                                | Dark                                                           |
| ---------------------------------------------------- | -------------------------------------------------------------- |
| ![Login](public/screenshots/00_Login/login_page.png) | ![Login Dark](public/screenshots/00_Login/login_Dark_page.png) |

</details>

<details>
<summary>Navigation — Sidebar</summary>

| Expanded Light                                                                         | Expanded Dark                                                                              |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| ![Sidebar Expanded](public/screenshots/01_Admin/02_Sidebar/sidebar_expanded_light.png) | ![Sidebar Expanded Dark](public/screenshots/01_Admin/02_Sidebar/sidebar_expanded_dark.png) |

| Collapsed Light                                                                          | Collapsed Dark                                                                               |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| ![Sidebar Collapsed](public/screenshots/01_Admin/02_Sidebar/sidebar_collapsed_light.png) | ![Sidebar Collapsed Dark](public/screenshots/01_Admin/02_Sidebar/sidebar_collapsed_dark.png) |

</details>

<details>
<summary>Dashboards</summary>

**Admin Dashboard**

| Light                                                                                  | Dark                                                                                       |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| ![Admin Dashboard](public/screenshots/01_Admin/01_Dashboard/admin_dashboard_light.png) | ![Admin Dashboard Dark](public/screenshots/01_Admin/01_Dashboard/admin_dashboard_dark.png) |

**Admin Analytics**

| Light                                                                                  | Dark                                                                                       |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| ![Admin Analytics](public/screenshots/01_Admin/01_Dashboard/admin_analytics_light.png) | ![Admin Analytics Dark](public/screenshots/01_Admin/01_Dashboard/admin_analytics_dark.png) |

**Manager Analytics**

| Light                                                                                        | Dark                                                                                             |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| ![Manager Analytics](public/screenshots/02_Manager/01_Dashboard/manager_analytics_light.png) | ![Manager Analytics Dark](public/screenshots/02_Manager/01_Dashboard/manager_analytics_dark.png) |

**Receptionist Dashboard**

| Light                                                                                              | Dark                                                                                                   |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| ![Reception Dashboard](public/screenshots/03_Reception/01_Dashboard/reception_dashboard_light.png) | ![Reception Dashboard Dark](public/screenshots/03_Reception/01_Dashboard/reception_dashboard_dark.png) |

**Doctor Dashboard**

| Light                                                                                     | Dark                                                                                          |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| ![Doctor Dashboard](public/screenshots/04_Doctor/01_Dashboard/doctor_dashboard_light.png) | ![Doctor Dashboard Dark](public/screenshots/04_Doctor/01_Dashboard/doctor_dashboard_dark.png) |

</details>

<details>
<summary>Appointment Calendar</summary>

**Week View**

![Calendar Week Dark](public/screenshots/01_Admin/03_Appointments/calendar_week_dark.png)

**Month View**

| Light                                                                                   | Dark                                                                                        |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| ![Calendar Month](public/screenshots/01_Admin/03_Appointments/calendar_month_light.png) | ![Calendar Month Dark](public/screenshots/01_Admin/03_Appointments/calendar_month_dark.png) |

**Timeslot Popup**

| Light                                                                                   | Dark                                                                                        |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| ![Timeslot Popup](public/screenshots/01_Admin/03_Appointments/timeslot_popup_light.png) | ![Timeslot Popup Dark](public/screenshots/01_Admin/03_Appointments/timeslot_popup_dark.png) |

</details>

<details>
<summary>Appointment Cards by Status</summary>

**Confirmed**

| Light                                                                              | Dark                                                                                   |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| ![Confirmed](public/screenshots/01_Admin/03_Appointments/card_confirmed_light.png) | ![Confirmed Dark](public/screenshots/01_Admin/03_Appointments/card_confirmed_dark.png) |

**Completed**

| Light                                                                              | Dark                                                                                   |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| ![Completed](public/screenshots/01_Admin/03_Appointments/card_completed_light.png) | ![Completed Dark](public/screenshots/01_Admin/03_Appointments/card_completed_dark.png) |

**Cancelled**

| Light                                                                              | Dark                                                                                   |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| ![Cancelled](public/screenshots/01_Admin/03_Appointments/card_cancelled_light.png) | ![Cancelled Dark](public/screenshots/01_Admin/03_Appointments/card_cancelled_dark.png) |

**No-Show**

| Light                                                                         | Dark                                                                              |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| ![No-Show](public/screenshots/01_Admin/03_Appointments/card_noshow_light.png) | ![No-Show Dark](public/screenshots/01_Admin/03_Appointments/card_noshow_dark.png) |

</details>

<details>
<summary>Appointment Actions & Modals</summary>

**New Appointment Form**

| Light                                                                                          | Dark                                                                                               |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| ![New Appointment](public/screenshots/01_Admin/03_Appointments/new_appointment_form_light.png) | ![New Appointment Dark](public/screenshots/01_Admin/03_Appointments/new_appointment_form_dark.png) |

**Displaced Appointments**

| Light                                                                                      | Dark                                                                                           |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| ![Displaced](public/screenshots/01_Admin/03_Appointments/displaced_appointments_light.png) | ![Displaced Dark](public/screenshots/01_Admin/03_Appointments/displaced_appointments_dark.png) |

**Cancel Modal**

| Light                                                                               | Dark                                                                                    |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| ![Cancel Modal](public/screenshots/01_Admin/03_Appointments/cancel_modal_light.png) | ![Cancel Modal Dark](public/screenshots/01_Admin/03_Appointments/cancel_modal_dark.png) |

**No-Show Modal**

| Light                                                                                | Dark                                                                                     |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| ![No-Show Modal](public/screenshots/01_Admin/03_Appointments/noshow_modal_light.png) | ![No-Show Modal Dark](public/screenshots/01_Admin/03_Appointments/noshow_modal_dark.png) |

**Billing Invoice Modal**

| Light                                                                                 | Dark                                                                                      |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| ![Invoice Modal](public/screenshots/01_Admin/03_Appointments/invoice_modal_light.png) | ![Invoice Modal Dark](public/screenshots/01_Admin/03_Appointments/invoice_modal_dark.png) |

**Appointment Recycle Bin**

| Light                                                                             | Dark                                                                                  |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| ![Recycle Bin](public/screenshots/01_Admin/03_Appointments/recycle_bin_light.png) | ![Recycle Bin Dark](public/screenshots/01_Admin/03_Appointments/recycle_bin_dark.png) |

</details>

<details>
<summary>Patient Management</summary>

**Patient List**

| Light                                                                             | Dark                                                                                  |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| ![Patients List](public/screenshots/01_Admin/04_Patients/patients_list_light.png) | ![Patients List Dark](public/screenshots/01_Admin/04_Patients/patients_list_dark.png) |

**Archive & Trash**

| Archive (Dark)                                                                | Trash Light                                                                | Trash Dark                                                                     |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| ![Archive](public/screenshots/01_Admin/04_Patients/patients_archive_dark.png) | ![Trash](public/screenshots/01_Admin/04_Patients/patients_trash_light.png) | ![Trash Dark](public/screenshots/01_Admin/04_Patients/patients_trash_dark.png) |

**Patient Profile**

![Patient Profile](public/screenshots/01_Admin/04_Patients/patient_profile_light.png)

**New Patient Form**

| Light                                                                              | Dark                                                                                   |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| ![New Patient](public/screenshots/01_Admin/04_Patients/new_patient_form_light.png) | ![New Patient Dark](public/screenshots/01_Admin/04_Patients/new_patient_form_dark.png) |

**Patient Appointments Report**

| Light                                                                                                 | Dark                                                                                                      |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| ![Appointments Report](public/screenshots/01_Admin/04_Patients/patient_appointments_report_light.png) | ![Appointments Report Dark](public/screenshots/01_Admin/04_Patients/patient_appointments_report_dark.png) |

**Patient Follow-up Report**

| Light                                                                                          | Dark                                                                                               |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| ![Follow-up Report](public/screenshots/01_Admin/04_Patients/patient_followup_report_light.png) | ![Follow-up Report Dark](public/screenshots/01_Admin/04_Patients/patient_followup_report_dark.png) |

**Medical Notes**

| Light                                                                                     | Dark                                                                                          |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| ![Medical Notes](public/screenshots/01_Admin/04_Patients/patient_medical_notes_light.png) | ![Medical Notes Dark](public/screenshots/01_Admin/04_Patients/patient_medical_notes_dark.png) |

**Add Deposit Modal**

| Light                                                                               | Dark                                                                                    |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| ![Add Deposit](public/screenshots/01_Admin/04_Patients/add_deposit_modal_light.png) | ![Add Deposit Dark](public/screenshots/01_Admin/04_Patients/add_deposit_modal_dark.png) |

</details>

<details>
<summary>Follow-ups</summary>

**Follow-ups Page**

| Light                                                                            | Dark                                                                                 |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| ![Follow-ups](public/screenshots/01_Admin/05_Followups/followups_page_light.png) | ![Follow-ups Dark](public/screenshots/01_Admin/05_Followups/followups_page_dark.png) |

**Edit Follow-up Modal**

| Light                                                                                     | Dark                                                                                          |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| ![Edit Follow-up](public/screenshots/01_Admin/05_Followups/edit_followup_modal_light.png) | ![Edit Follow-up Dark](public/screenshots/01_Admin/05_Followups/edit_followup_modal_dark.png) |

</details>

<details>
<summary>Revenue</summary>

![Revenue Transactions](public/screenshots/01_Admin/06_Revenue/revenue_transactions_dark.png)

</details>

<details>
<summary>Settings — Staff</summary>

**Staff List**

| Light                                                                       | Dark                                                                            |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| ![Staff List](public/screenshots/01_Admin/07_Settings/staff_list_light.png) | ![Staff List Dark](public/screenshots/01_Admin/07_Settings/staff_list_dark.png) |

**Staff Profile**

| Light                                                                                   | Dark                                                                                        |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| ![Staff Profile](public/screenshots/01_Admin/07_Settings/staff_profile_admin_light.png) | ![Staff Profile Dark](public/screenshots/01_Admin/07_Settings/staff_profile_admin_dark.png) |

**Staff Documents**

| Light                                                                                       | Dark                                                                                            |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| ![Staff Documents](public/screenshots/01_Admin/07_Settings/staff_documents_admin_light.png) | ![Staff Documents Dark](public/screenshots/01_Admin/07_Settings/staff_documents_admin_dark.png) |

**Staff Schedule**

| Light                                                                                      | Dark                                                                                           |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| ![Staff Schedule](public/screenshots/01_Admin/07_Settings/staff_schedule_doctor_light.png) | ![Staff Schedule Dark](public/screenshots/01_Admin/07_Settings/staff_schedule_doctor_dark.png) |

</details>

<details>
<summary>Settings — Clinic Configuration</summary>

**Departments**

| Light                                                                         | Dark                                                                              |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| ![Departments](public/screenshots/01_Admin/07_Settings/departments_light.png) | ![Departments Dark](public/screenshots/01_Admin/07_Settings/departments_dark.png) |

**Insurance Providers**

| Light                                                                               | Dark                                                                                    |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| ![Insurance](public/screenshots/01_Admin/07_Settings/insurance_providers_light.png) | ![Insurance Dark](public/screenshots/01_Admin/07_Settings/insurance_providers_dark.png) |

**Services & Pricing**

| Light                                                                           | Dark                                                                                |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| ![Services](public/screenshots/01_Admin/07_Settings/services_pricing_light.png) | ![Services Dark](public/screenshots/01_Admin/07_Settings/services_pricing_dark.png) |

**Clinic Info**

| Light                                                                         | Dark                                                                              |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| ![Clinic Info](public/screenshots/01_Admin/07_Settings/clinic_info_light.png) | ![Clinic Info Dark](public/screenshots/01_Admin/07_Settings/clinic_info_dark.png) |

**Page Visibility Customization**

| Light                                                                                | Dark                                                                                     |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| ![Customize](public/screenshots/01_Admin/07_Settings/customize_visibility_light.png) | ![Customize Dark](public/screenshots/01_Admin/07_Settings/customize_visibility_dark.png) |

</details>

<details>
<summary>My Profile</summary>

| Light                                                                         | Dark                                                                              |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| ![My Profile](public/screenshots/01_Admin/08_My_Profile/my_profile_light.png) | ![My Profile Dark](public/screenshots/01_Admin/08_My_Profile/my_profile_dark.png) |

</details>
<details>
<summary>Reports</summary>

**Reports Overview**

| Light                                                              | Dark                                                                   |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| ![Reports Overview](SCREENS/01_Reports/reports_overview_light.png) | ![Reports Overview Dark](SCREENS/01_Reports/reports_overview_dark.png) |

**Revenue Report**

| Light                                                                | Dark                                                                     |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| ![Revenue Report](SCREENS/01_Reports/report_revenue_sales_light.png) | ![Revenue Report Dark](SCREENS/01_Reports/report_revenue_sales_dark.png) |

**Doctor Performance Report**

| Light                                                                    | Dark                                                                         |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| ![Doctor Report](SCREENS/01_Reports/report_doctor_performance_light.png) | ![Doctor Report Dark](SCREENS/01_Reports/report_doctor_performance_dark.png) |

**Receptionist Performance Report**

| Light                                                                                | Dark                                                                                     |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| ![Receptionist Report](SCREENS/01_Reports/report_receptionist_performance_light.png) | ![Receptionist Report Dark](SCREENS/01_Reports/report_receptionist_performance_dark.png) |

**Cancellation Report**

| Light                                                                    | Dark                                                                         |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| ![Cancellation Report](SCREENS/01_Reports/report_cancellation_light.png) | ![Cancellation Report Dark](SCREENS/01_Reports/report_cancellation_dark.png) |

**No-show Report**

| Light                                                         | Dark                                                              |
| ------------------------------------------------------------- | ----------------------------------------------------------------- |
| ![No-show Report](SCREENS/01_Reports/report_noshow_light.png) | ![No-show Report Dark](SCREENS/01_Reports/report_noshow_dark.png) |

**Follow-ups Report**

| Light                                                              | Dark                                                                   |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| ![Followups Report](SCREENS/01_Reports/report_followups_light.png) | ![Followups Report Dark](SCREENS/01_Reports/report_followups_dark.png) |

</details>

<details>
<summary>Settings — Package Templates</summary>

| Light                                                              | Dark                                                             |
| ------------------------------------------------------------------ | ---------------------------------------------------------------- |
| ![Packages Light](SCREENS/02_Settings/settings_packages_light.png) | ![Packages Dark](SCREENS/02_Settings/settings_packages_dark.png) |

</details>

<details>
<summary>Appointments — Arrived Status</summary>

![Arrived Appointment](SCREENS/03_Appointments/appointment_card_arrived_dark.png)

</details>

---

## Tech Stack

| Layer          | Technology                      |
| -------------- | ------------------------------- |
| Framework      | Next.js 16.2.6 (App Router)     |
| Language       | TypeScript — strict mode        |
| Database       | Supabase Postgres               |
| Auth           | Supabase Auth + `@supabase/ssr` |
| Storage        | Supabase Storage                |
| Styling        | Tailwind CSS + shadcn/ui        |
| Forms          | React Hook Form + Zod v4        |
| Tables         | TanStack Table v8               |
| Charts         | Recharts                        |
| Error Tracking | Sentry (optional)               |
| Email          | Resend                          |
| Testing        | Vitest v4 + Playwright 1.59     |
| Deployment     | Vercel                          |

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

- **RLS as primary guard** — Row-Level Security on all 23 tables is the outermost security layer. Middleware and server-side RBAC are secondary.
- **Server Actions only** — all mutations go through Next.js Server Actions. No writable API routes exist.
- **Session caching** — a `cf_page_visibility` cookie (httpOnly, 1h TTL) caches accessible page slugs to avoid a DB round-trip on every navigation.
- **Postgres-native billing** — billing RPCs are `SECURITY DEFINER` functions so they are atomic and cannot partially succeed.
- **Audit trail** — patient deletions, billing events, and staff changes write immutable records to `audit_logs` inside the same transaction.

---

## User Roles

| Role           | Dashboard | Patients | Appointments | Medical Notes | Revenue | Reports | Settings |
| -------------- | :-------: | :------: | :----------: | :-----------: | :-----: | :-----: | :------: |
| `admin`        |     ✓     |    ✓     |      ✓       |       ✓       |    ✓    |    ✓    |    ✓     |
| `receptionist` |     ✓     |    ✓     |      ✓       |   read-only   |    —    |    ✓    |    —     |
| `doctor`       |     ✓     |    ✓     |      ✓       |       ✓       |    —    |    —    |    —     |
| `manager`      |     ✓     |    —     |      —       |       —       |    ✓    |    ✓    |    ✓     |

Doctor-facing performance reports (`/reports/doctors`, `/reports/receptionists`) are restricted to `admin` and `manager`. Admins can grant **per-user page visibility overrides** through Settings → Staff — allowing, for example, a receptionist to access revenue pages without a full role change.

---

## Core Modules

### Appointments

The appointment lifecycle is enforced by a database-level trigger (`enforce_appointment_transition`):

```
pending ──► confirmed ──► arrived ──► in_session ──► completed
   │            │            │             │
   │            ├────────────┴─────────────┴──► cancelled
   │            │            │             │
   │            └────────────┴─────────────┴──► no_show
   │
   └──► cancelled
```

Reception can also charge a walk-in or same-day booking with a direct `pending → completed` shortcut. Backwards steps (`arrived → confirmed`, `in_session → arrived`) are routed through the `undo_appointment_status` RPC so slot uniqueness is preserved.

Invalid status transitions are rejected at the database level. Appointments with any billing data (`paid_at`, `paid_amount`, `total_amount`) or that are currently `arrived` / `in_session` cannot be soft-deleted — preventing audit trail gaps and accidental loss of in-progress visits.

### Billing

Billing operations are handled by Postgres RPCs for atomicity:

| RPC                                                     | Purpose                                                                            |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `complete_appointment_billing`                          | Direct payment — sets paid fields, records services, debits deposits, writes audit |
| `complete_appointment_billing_with_previous_settlement` | Same as above + closes an outstanding insurance settlement                         |
| `undo_appointment_billing`                              | Full reversal in a single transaction                                              |
| `undo_appointment_billing_with_previous_settlement`     | Undo variant for settlement-linked appointments                                    |

### Follow-ups

Scheduled after appointments. Displayed in pending and completed views. Staff can record outcomes inline via a quick modal without leaving the follow-ups page.

### Medical Notes

Doctor-authored notes attached to patient records. Each note can carry file attachments stored in Supabase Storage. RLS scopes read access to the note's author, doctors assigned to the patient, doctors in the same department, admins, and read-only access for receptionists; create/edit/delete remain admin- and doctor-only.

### Patient Management

Every patient receives an auto-assigned file number (`CF-NNNN`). Soft-deleted patients go to a recycle bin with restore capability. The patient profile aggregates appointments, billing history, medical notes, documents, and active packages in a single view.

### Patient Packages

Patients can hold multi-session packages tracked by `patient_packages` (with `total_sessions` / `used_sessions` and an optional per-session price). Admins and managers maintain reusable per-department package templates under `Settings → Packages`, and appointments may reference a specific package and session number.

### Staff Management

Staff are invited via email tokens. Admins can assign roles, set department membership, manage per-user page visibility, upload documents, and deactivate accounts.

---

## Reports & Printing

The reports module lives under `/reports` and is open to `admin`, `manager`, and `receptionist`. Each report is backed by a dedicated `security invoker` Postgres RPC scoped to the caller's clinic, so the same access rules that protect raw tables also protect the reports.

| Report | Route | Backing RPC | Access |
| --- | --- | --- | :---: |
| Cancellations | `/reports/cancellations` | `get_cancellation_report` | admin, manager, receptionist |
| No-shows | `/reports/no-shows` | `get_no_show_report` | admin, manager, receptionist |
| Doctor performance | `/reports/doctors` | `get_doctor_performance_report` | admin, manager |
| Receptionist performance | `/reports/receptionists` | `get_receptionist_performance_report` | admin, manager |
| Follow-ups | `/reports/follow-ups` | follow-ups dashboard query | admin, manager, receptionist |
| Revenue summary | `/reports/revenue` | `revenue_summary` | admin, manager, receptionist |

Each report has a date-range filter and report-specific filters (doctor, outcome, etc.). A **Print** action on every report opens a clinic-branded print layout stripped of navigation chrome.

---

## Security

- **RLS on all 23 tables** — `clinic_id` column on every core table, enforced by Row-Level Security. Cross-clinic data leakage is impossible at the database layer.
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

| Variable                        | Required | Purpose                                                 |
| ------------------------------- | :------: | ------------------------------------------------------- |
| `NEXT_PUBLIC_SUPABASE_URL`      |    ✓     | Supabase project URL                                    |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` |    ✓     | Supabase public anon key                                |
| `SUPABASE_SERVICE_ROLE_KEY`     |    ✓     | Service role key — server-only, never expose to browser |
| `NEXT_PUBLIC_SENTRY_DSN`        |    —     | Sentry DSN; Sentry is a no-op if omitted                |
| `SENTRY_AUTH_TOKEN`             |    —     | Source map upload during build (optional)               |
| `RESEND_API_KEY`                |    —     | Transactional email                                     |

---

## Deployment

The project deploys to **Vercel** as a Next.js App Router application. Vercel auto-detects the framework and runs `next build`.

1. Push to GitHub and import the project in the [Vercel Dashboard](https://vercel.com)
2. Set the environment variables listed above under Project → Settings → Environment Variables
3. Deploy

**Supabase setup checklist:**

- [ ] All 50 migrations applied (`supabase db push`)
- [ ] Email auth enabled in Authentication → Providers
- [ ] Storage bucket `clinic-files` created with RLS policies
- [ ] Admin account seeded
- [ ] `SUPABASE_SERVICE_ROLE_KEY` not committed to git

---

## Project Structure

```
clinicflow-crm/
├── app/
│   ├── (auth)/             ← Login, password reset, email confirmation
│   └── (protected)/        ← All authenticated pages (role-gated)
├── actions/                ← Server Actions — all mutations live here (18 files)
├── components/             ← React components organized by domain
├── lib/
│   ├── rbac.ts             ← Session validation & role enforcement
│   ├── page-permissions.ts ← Role → accessible page slug mapping
│   └── supabase/           ← Client factory functions (server / admin / client / middleware)
├── supabase/
│   └── migrations/         ← 50 SQL migration files
├── tests/
│   ├── unit/               ← Vitest — 270 tests, 46 files
│   └── e2e/                ← Playwright specs
├── types/
│   └── database.ts         ← Generated Supabase TypeScript types
├── public/screenshots/     ← UI screenshots used in this README (admin, manager, reception, doctor)
├── SCREENS/                ← Additional screenshots (reports, settings, in-visit statuses)
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
