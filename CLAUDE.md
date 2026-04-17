# Clinic CRM — Project Instructions

> Read this file before doing anything else in every session.

@AGENTS.md

---

## Project Overview

A staff-only web-based CRM system for small-to-medium private clinics in Turkey.

---

## Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 15 (App Router) |
| Database + Auth | Supabase (Postgres + Auth + RLS + Storage) |
| Styling | Tailwind CSS + shadcn/ui |
| Forms | React Hook Form + Zod |
| Tables | TanStack Table v8 |
| Error tracking | Sentry |
| Language | TypeScript (strict mode) |
| Email (Phase 2) | Resend |

---

## Core Rules — Never Break These

- **Patients are records only** — no patient login, no patient portal, no patient-facing pages of any kind
- **No landing page** — `/` redirects immediately to `/login`
- **Role-scoped dashboard** — every role (admin, receptionist, manager) sees a different dashboard after login
- **RLS is the primary access control layer** — middleware is secondary
- **All mutations via Server Actions only** — no direct API routes for data writes
- **Never hard-delete data** — soft delete only (`is_deleted = true` flag)
- **All sensitive operations must write to `audit_logs`**
- **`clinic_id` on every core table** — architecture supports multi-tenant, UI does not (Phase 1)

---

## User Roles

| Role | Key Access |
|---|---|
| `admin` | Full access — patients, appointments, medical notes, staff management, all settings |
| `receptionist` | Patient records (no medical notes), appointment scheduling |
| `manager` | Read-only — full dashboard with KPIs, no data entry |

---

## Seed Admin Account

```
Email:    admin@clinic.com
Password: Admin@1234
```

---

## Implementation Phases

Execute one phase at a time. Stop after each phase and wait for approval before continuing.

| Phase | Scope |
|---|---|
| 0 | Scaffolding — Next.js 15 + Supabase + shadcn/ui + Tailwind + Sentry setup |
| 1 | Auth & Middleware — Login page, Supabase Auth, RBAC middleware, role-based redirect |
| 2 | Database Schema & RLS — All migrations + RLS policies + seed data |
| 3 | Patient Management — List, detail, create/edit, medical notes, search |
| 4 | Appointment Scheduling — Booking form, conflict detection, insurance dropdown, calendar view |
| 5 | Role-Scoped Dashboards — Admin, Receptionist, Manager dashboards |
| 6 | Settings & Access Management — Staff CRUD, departments, insurance providers, clinic settings |
| 7 | Polish & Testing — Skeletons, toasts, Sentry check, CSV export, responsive audit |

---

## Page Map

| Page | Route | Roles |
|---|---|---|
| Login | `/login` | All |
| Dashboard | `/dashboard` | All (role-scoped content) |
| Patients list | `/patients` | Admin, Receptionist |
| Patient detail | `/patients/[id]` | Admin, Receptionist |
| Appointments calendar | `/appointments` | Admin, Receptionist |
| New appointment | `/appointments/new` | Admin, Receptionist |
| Settings — Staff | `/settings/staff` | Admin |
| Settings — Departments | `/settings/departments` | Admin |
| Settings — Insurance | `/settings/insurance` | Admin |
| Settings — Clinic | `/settings/clinic` | Admin |

---

## Full PRD

See `PRD.md` in the same folder.
