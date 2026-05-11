# Clinic CRM

A staff-only web-based CRM system for small-to-medium private clinics in Turkey. Built with Next.js 16, Supabase, and Tailwind CSS.

> **Academic project** — Üsküdar University, Faculty of Engineering and Natural Sciences, Software Engineering Dept.  
> Supervisor: Dr. Faezeh Rohani  
> Team: Mohamed Ibrahim · Osama Ali · Mohamed Seif

---

## Features

- **Patient management** — create, edit, search, and soft-delete patient records with auto-assigned file numbers (`CF-NNNN`)
- **Appointment scheduling** — calendar views (day / week / month), conflict detection, status transitions with a database-enforced state machine
- **Billing & settlement** — appointment billing with service line items, insurance settlement workflows, transactional Postgres RPCs for atomicity
- **Role-scoped dashboards** — admin, receptionist, doctor, and manager each see a different dashboard with relevant KPIs
- **Medical notes** — doctor-authored notes per patient with file attachments; access scoped by author and role
- **Recycle bin** — soft-delete with trash for appointments; restore and permanent-delete operations
- **Follow-ups** — post-appointment follow-up tracking per patient
- **Settings** — staff management with role assignment, departments with color coding, insurance providers, service catalog, clinic profile
- **Security** — RLS-enforced multi-tenant isolation, HTTP security headers (CSP, HSTS, X-Frame-Options), audit logging, confirmation dialogs on all destructive actions

---

## Screenshots

> _Add screenshots here_

---

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 16.2.4 (App Router) |
| Database | Supabase Postgres |
| Auth | Supabase Auth + `@supabase/ssr` |
| Styling | Tailwind CSS + shadcn/ui |
| Forms | React Hook Form + Zod |
| Testing | Vitest + Playwright |
| Deployment | Vercel |

---

## Local Setup

### Prerequisites

- Node.js 20 or later
- pnpm 9 or later (`npm install -g pnpm`)
- A [Supabase](https://supabase.com) project (free tier works)
- [Supabase CLI](https://supabase.com/docs/guides/cli) (for migrations)

### 1. Clone and install dependencies

```bash
git clone <repo-url>
cd clinic-crm
pnpm install
```

### 2. Configure environment variables

Copy the example file and fill in your values:

```bash
cp .env.example .env.local
```

| Variable | Where to find it |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase Dashboard → Project Settings → API |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase Dashboard → Project Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase Dashboard → Project Settings → API → Service Role (keep secret) |
| `NEXT_PUBLIC_SENTRY_DSN` | Optional — Sentry project DSN |
| `RESEND_API_KEY` | Optional — Resend API key for transactional email |

### 3. Set up Supabase

**Run migrations** (requires Supabase CLI linked to your project):

```bash
supabase link --project-ref <your-project-ref>
supabase db push
```

Alternatively, copy the contents of each file in `supabase/migrations/` and run them in order in the Supabase Dashboard SQL editor.

**Enable Email Auth:**

1. Go to Supabase Dashboard → Authentication → Providers
2. Enable Email provider
3. Disable email confirmation if you want immediate login (development only)

**Create the storage bucket:**

Run in the Supabase Dashboard SQL editor:

```sql
INSERT INTO storage.buckets (id, name, public)
VALUES ('clinic-files', 'clinic-files', false);
```

Then configure RLS policies on the bucket to allow authenticated users from the correct clinic to read and write their files.

**Seed admin account:**

After running migrations, create a user in Supabase Dashboard → Authentication → Users with:

```
Email:    admin@clinic.com
Password: Admin@1234
```

Then run the following in the SQL editor (replace `<user-uuid>` with the UUID from the Auth dashboard and `<clinic-uuid>` with the UUID from the `clinics` table):

```sql
UPDATE profiles
SET role = 'admin', is_active = true, clinic_id = '<clinic-uuid>'
WHERE id = '<user-uuid>';
```

### 4. Run locally

```bash
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000). The root redirects to `/login`.

---

## Running Tests

### Unit tests (Vitest)

```bash
pnpm test          # single run
pnpm test:watch    # watch mode
```

249 tests across 13 test files covering patient CRUD, appointment deletion guard, billing RPCs, medical note access control, staff boundaries, and more.

### E2E tests (Playwright)

```bash
pnpm test:e2e
```

Requires a running local Supabase instance (`supabase start`).

---

## Production Deployment (Vercel)

1. Push the repository to GitHub
2. Import the project in the [Vercel Dashboard](https://vercel.com)
3. Set all required environment variables in Vercel → Project → Settings → Environment Variables:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`
4. Deploy. Vercel auto-detects Next.js and sets the build command to `next build`.

For source map uploads to Sentry on build, also set `SENTRY_AUTH_TOKEN`.

---

## Security Notes

- The `SUPABASE_SERVICE_ROLE_KEY` bypasses RLS. It is used only in server-side actions (`createAdminClient`) and must never be exposed to the browser or committed to git.
- All mutations are implemented as Next.js Server Actions — no writable API routes exist.
- Row-Level Security policies on all 16 database tables enforce clinic-scoped data isolation. Application-layer access control is a secondary layer.
- HTTP security headers (CSP, HSTS, X-Frame-Options DENY) are set globally in `next.config.ts`.
- Appointments with billing data attached cannot be soft-deleted — the deletion guard is enforced at the server action level.
- Sensitive operations (patient deletion, billing, staff changes) write immutable records to `audit_logs`.

---

## Demo Credentials

> _Configure these in your Supabase project before sharing a demo environment._

```
Email:    admin@clinic.com
Password: Admin@1234
```

---

## Project Structure

```
clinic-crm/
├── app/
│   ├── (auth)/             ← Login, password reset pages
│   └── (protected)/        ← All authenticated pages
├── actions/                ← Server Actions (mutations only)
├── components/             ← React components by domain
├── lib/
│   ├── rbac.ts             ← Session & role enforcement
│   ├── page-permissions.ts ← Role → page mapping
│   └── supabase/           ← Client factory functions
├── supabase/
│   └── migrations/         ← 31 SQL migration files
├── tests/
│   ├── unit/               ← Vitest unit tests
│   └── e2e/                ← Playwright E2E tests
├── types/
│   └── database.ts         ← Generated Supabase TypeScript types
├── middleware.ts            ← Session refresh + page guard
└── next.config.ts          ← Security headers, Sentry config
```

For a full technical reference including architecture details, RLS philosophy, appointment lifecycle, billing RPCs, and the soft-delete/trash system, see [SYSTEM_OVERVIEW.md](./SYSTEM_OVERVIEW.md).

---

## Production Checklist

- [ ] All environment variables set in Vercel
- [ ] Supabase RLS policies verified (Dashboard → Advisors)
- [ ] Storage bucket `clinic-files` created with RLS policies
- [ ] 31 migrations applied (`supabase db push` or Dashboard SQL editor)
- [ ] Admin account created and role set to `admin`
- [ ] Email auth enabled in Supabase Authentication settings
- [ ] `SUPABASE_SERVICE_ROLE_KEY` not committed to git
- [ ] Sentry DSN configured (optional)
- [ ] Custom domain configured in Vercel (optional)
- [ ] `pnpm test` passes (249 tests)

---

## Academic Usage

This project was developed as a capstone project at Üsküdar University. It is made available for academic reference. If you use this work or derive from it, please cite the original team and institution.
