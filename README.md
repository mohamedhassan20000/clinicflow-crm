# ClinicFlow

Staff-only CRM for small and medium private clinics in Turkey.
Graduation project — Üsküdar University, Software Engineering, 2025–2026.

🔗 **Live demo:** https://clinic-crm-brown.vercel.app

---

## Stack

- **Next.js 16** (App Router) · **React 19** · **TypeScript** (strict)
- **Supabase** — Postgres + Auth + RLS + Storage
- **Tailwind 4** + **shadcn/ui** (Radix, Nova preset)
- **React Hook Form** + **Zod**
- **TanStack Table v8** · **nuqs** for URL state
- **Sentry** for error tracking
- **Vitest** (unit) + **Playwright** (E2E)
- **Vercel** for hosting

Palette: Optimistic Teal. Fonts: Inter (body) + Plus Jakarta Sans (headings). Timezone: `Europe/Istanbul`.

---

## Getting started

```bash
pnpm install
cp .env.example .env.local   # then fill in Supabase + Sentry keys
pnpm dev
```

Open http://localhost:3000 — you'll be redirected to `/login`.

### Required env vars

| Variable | Where to find it |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Settings → API |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase → Settings → API (publishable / anon) |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Settings → API (server-only, Phase 1+) |
| `NEXT_PUBLIC_SENTRY_DSN` | Sentry → Project Settings → Client Keys (optional) |

---

## Scripts

| Script | Purpose |
|---|---|
| `pnpm dev` | Dev server on :3000 |
| `pnpm build` | Production build |
| `pnpm start` | Run the production build |
| `pnpm lint` | ESLint |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm test` | Vitest (unit) |
| `pnpm test:e2e` | Playwright (E2E smoke) |
| `pnpm db:types` | Regenerate `types/database.ts` from Supabase |

---

## Roles

| Role | Access |
|---|---|
| `admin` | Full access — patients, appointments, medical notes, settings, staff management |
| `receptionist` | Patient records (no medical notes), appointment scheduling |
| `manager` | Read-only — full dashboard with KPIs, no data entry |

Demo credentials (seeded in Phase 1):

```
admin@clinic.com · Admin@1234
```

---

## Project structure

```
app/               Next.js App Router routes
  (auth)/          Login + change-password (unauthenticated)
  (protected)/     Dashboard + modules (Phase 1+)
components/        React components (ui/ = shadcn generated)
actions/           Server Actions (mutations) — all domains
lib/
  supabase/        Browser, server, admin, proxy clients
  datetime.ts      Europe/Istanbul helpers
  rbac.ts          Role-guard helpers
tests/
  unit/            Vitest
  e2e/             Playwright
supabase/migrations/  SQL migrations (applied via Supabase MCP)
proxy.ts           Auth/RBAC proxy (Next.js 16 rename of middleware.ts)
```

---

## Phase status

- [x] **Phase 0** — Foundation (scaffold, theme, login shell, Supabase clients, Sentry, CI, deploy)
- [ ] Phase 1 — Auth + Schema + RLS
- [ ] Phase 2 — Patient Management
- [ ] Phase 3 — Appointment Scheduling
- [ ] Phase 4 — Role-Scoped Dashboards
- [ ] Phase 5 — Settings & Access Management
- [ ] Phase 6 — Polish & QA

See `_docs/` for the full PRD and build plan.
