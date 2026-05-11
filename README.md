# ClinicFlow

A staff-only clinic management system built with Next.js 16, Supabase, and Tailwind CSS. Handles patient records, appointment scheduling, billing, and role-based access control for small-to-medium private clinics.

---

## Features

- **Patient management** — create, edit, soft-delete, and restore patient records with auto-assigned file numbers (`CF-NNNN`)
- **Appointment scheduling** — day, week, and month calendar views; conflict detection; database-enforced status state machine
- **Billing & settlement** — service line items, insurance settlement workflows, transactional Postgres RPCs for atomicity
- **Role-scoped dashboards** — admin, receptionist, doctor, and manager each see a tailored dashboard with relevant KPIs
- **Medical notes & attachments** — doctor-authored notes per patient with file attachments; access enforced by author and role
- **Recycle bin** — soft-delete trash for appointments with restore and permanent-delete operations
- **Follow-up tracking** — post-appointment follow-up scheduling and management
- **Settings** — staff with role assignment, departments with color coding, insurance providers, service catalog, clinic profile, per-user page visibility overrides

---

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 16.2.4 (App Router) |
| Language | TypeScript (strict mode) |
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

## Security

- **RLS as primary guard** — Row-Level Security policies on all 16 database tables enforce clinic-scoped data isolation. Application-layer RBAC is a secondary layer. A compromised application layer cannot leak cross-clinic data.
- **HTTP security headers** — CSP, HSTS (`max-age=63072000; includeSubDomains; preload`), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Permissions-Policy` — set globally in `next.config.ts`.
- **Server Actions only** — all mutations go through Next.js Server Actions. No writable API routes exist.
- **Billing deletion guard** — appointments with any billing data (`paid_at`, `paid_amount`, `total_amount`) cannot be soft-deleted. Enforced server-side before any DB write.
- **Audit logging** — patient deletions, billing events, and staff changes write immutable records to `audit_logs` inside the same database transaction.
- **Service role isolation** — `SUPABASE_SERVICE_ROLE_KEY` is used only in `createAdminClient()` on the server. It is never exposed to the browser.
- **Input validation** — all server actions validate with Zod before any database call. Invalid input returns field-level errors without touching the database.

---

## Architecture

See [SYSTEM_OVERVIEW.md](./SYSTEM_OVERVIEW.md) for the full technical reference covering route structure, RBAC flow, database schema, appointment lifecycle, billing RPCs, soft-delete/trash architecture, and the RLS philosophy.

Key design points:

- **Two route groups** — `(auth)/` for unauthenticated pages; `(protected)/` for all role-enforced pages
- **Session caching** — a `cf_page_visibility` cookie (httpOnly, 1h TTL) caches accessible page slugs per user to avoid a DB round-trip on every navigation
- **4 user roles** — `admin`, `receptionist`, `doctor`, `manager` — each with a defined page access matrix; admins can grant per-user overrides
- **Postgres-native billing** — billing operations use `SECURITY DEFINER` RPCs so they are atomic and cannot partially succeed
- **Batch trash operations** — `emptyAppointmentsTrash` uses 5 fixed queries (4 `.in()` dependent deletes + 1 appointments delete) regardless of trash size

---

## Testing

249 unit tests across 13 test files. Tests use a `QueryBuilder` mock that intercepts all Supabase operations and logs them to a `queryLog` for assertion — no live database required.

Coverage includes:

- Appointment deletion guard (all 4 billing block conditions)
- Batch trash empty with `.in()` verification across all dependent tables
- Patient CRUD with file number generation sequences
- Billing and settlement RPCs
- Role boundary enforcement
- Form validation short-circuits (invalid input never reaches DB)
- Medical note and attachment access control

```bash
pnpm test          # single run
pnpm test:watch    # watch mode
pnpm test:e2e      # Playwright E2E (requires local Supabase)
```

---

## Deployment

Deploys to Vercel. Vercel auto-detects Next.js and builds with `next build`.

1. Push to GitHub and import the project in the Vercel Dashboard
2. Set environment variables in Vercel → Project → Settings → Environment Variables:

| Variable | Required | Purpose |
|---|:---:|---|
| `NEXT_PUBLIC_SUPABASE_URL` | ✓ | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | ✓ | Supabase public anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | ✓ | Service role key — server-only, never expose to browser |
| `NEXT_PUBLIC_SENTRY_DSN` | — | Sentry DSN; omit to disable error tracking |
| `SENTRY_AUTH_TOKEN` | — | Source map upload during build |
| `RESEND_API_KEY` | — | Transactional email |

3. Deploy.

---

## Project Structure

```
clinicflow-crm/
├── app/
│   ├── (auth)/             ← Login, password reset, email confirmation
│   └── (protected)/        ← All authenticated pages (role-gated)
├── actions/                ← Server Actions — all mutations live here
├── components/             ← React components organized by domain
├── lib/
│   ├── rbac.ts             ← Session validation & role enforcement
│   ├── page-permissions.ts ← Role → accessible page slug mapping
│   └── supabase/           ← Client factory functions (server / admin / client / middleware)
├── supabase/
│   └── migrations/         ← 31 SQL migration files
├── tests/
│   ├── unit/               ← Vitest — 249 tests, 13 files
│   └── e2e/                ← Playwright specs
├── types/
│   └── database.ts         ← Generated Supabase TypeScript types
├── middleware.ts            ← Session refresh + page visibility guard
└── next.config.ts          ← Security headers, Sentry config
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
cp .env.example .env.local   # then fill in your Supabase credentials
```

**Apply migrations:**

```bash
supabase link --project-ref <your-project-ref>
supabase db push
```

**Create the storage bucket** (Supabase Dashboard SQL editor):

```sql
INSERT INTO storage.buckets (id, name, public)
VALUES ('clinic-files', 'clinic-files', false);
```

**Seed an admin account:**

Create a user in Supabase Dashboard → Authentication → Users, then promote them in the SQL editor:

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

---

## Production Readiness

- [x] RLS policies on all 16 tables
- [x] HTTP security headers (CSP, HSTS, X-Frame-Options DENY)
- [x] Billing deletion guard
- [x] Confirmation dialogs on all destructive actions
- [x] Audit logging for sensitive operations
- [x] Input validation (Zod) on every server action
- [x] 249 passing unit tests
- [x] Vercel deployment config
- [x] 31 database migrations

Pre-deploy checklist:

- [ ] All environment variables set in Vercel
- [ ] Supabase RLS policies verified (Dashboard → Advisors)
- [ ] Storage bucket `clinic-files` created with RLS policies
- [ ] 31 migrations applied
- [ ] Admin account seeded
- [ ] Email auth enabled in Supabase Authentication → Providers
- [ ] `SUPABASE_SERVICE_ROLE_KEY` not committed to git
- [ ] `pnpm test` passes

---

## Author

Mohamed Hassan Mohamed Ibrahim  
Software Engineering Student  
Üsküdar University — Istanbul, Türkiye

---

## License

[MIT](./LICENSE)
