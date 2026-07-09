# ClinicFlow → Multi-Tenant SaaS: Platform, Arabic-First i18n, Per-Tenant WhatsApp & AI Assistant Agent — Feasibility & Implementation Plan

**Status:** Approved plan — implementation not started
**Date:** 2026-07-09
**Scope of this document:** Planning only. No code changes accompany this document.
**Supersedes:** The earlier single-clinic AI-agent plan direction. In particular, the previously proposed "patient portal prerequisite" phase is **explicitly retired** — WhatsApp is now the patient channel (see §5, §6).

---

## Roadmap Summary (decision table)

| Phase | Duration (dev-days) | Deliverable | Depends on |
|---|---|---|---|
| **P0 — Tenant hardening & per-clinic config** | 8–12 | ⛔ BLOCKING security fixes (clinics RLS policies, admin-client wrapper), per-clinic timezone/currency/locale columns and threading | — |
| **P1 — SaaS foundation** | 15–20 | Self-serve clinic signup + setup wizard, Paddle + Tap billing, `plans`/`subscriptions`/`usage_counters`, entitlements/feature flags, operator panel, rate limiting, data export | P0 |
| **P2 — Arabic-first i18n & RTL** | 12–18 | `next-intl` (Arabic default), full RTL retrofit (87 files / 339 occurrences), Arabic typography, localized zod errors — staff UI fully Arabic | P0 (parallelizable with P1) |
| **P3 — Messaging layer + manual WhatsApp inbox + notifications** | 15–20 | Channel-abstracted `outbound_messages` (WhatsApp via BSP, SMS, email), inbound webhook, **staff manual WhatsApp inbox**, appointment reminders, invoice follow-up sequences, in-app notification center, template management | P0, P1 (usage counters) |
| **P4 — Doctor AI assistant (read-only)** | 10–14 | Staff chat UI, patient-summary/search tools, audit logging, AI entitlement gating | P0, P1; P2 for Arabic answers |
| **P5 — Patient WhatsApp AI + preliminary booking** | 12–16 | AI auto/suggested replies in the P3 inbox, availability checks, pending-slot booking with caps, cancellation | P3, P4 |
| **P6 — Hardening, eval & Tech Provider migration** | 10–15 | Prompt-injection test suite, eval sets (ar/en), load & cost dashboards, Meta Tech Provider / Embedded Signup migration | P3–P5 |
| **Total** | **~82–115** (≈ 5–7 months, single developer) | | |

**Recommended v1 cut line:** ship **P0–P4 including the manual WhatsApp inbox**. P5 (patient AI booking) may slip without blocking launch — clinics get real patient messaging on day one via the staff inbox, and the AI layer plugs into the same infrastructure later.

---

## 1. Executive Summary

**Verdict: Feasible as a staged build.** The codebase is a genuinely solid foundation for a multi-tenant SaaS: every one of the 23 application tables already has row-level security scoped by `clinic_id` (via `auth_clinic_id()`), transactional business logic already lives in `SECURITY DEFINER` Postgres RPCs that re-verify clinic ownership, storage buckets are clinic-scoped, and the appointment state machine (`pending → confirmed → arrived → in_session → completed`) with its partial unique index design is *already* the right shape for AI-driven preliminary booking. What is missing is the commercial layer (onboarding, billing, entitlements), internationalization (the app is English-only, LTR, hardcoded to Istanbul time and Turkish lira), any messaging channel at all, and the agent itself.

**Total effort estimate: ~82–115 developer-days (~5–7 months for a single developer)**, sequenced P0–P6 above. This is an honest estimate that budgets for the two commonly underestimated items: the RTL/i18n retrofit (87 of 176 TSX files contain physical-direction CSS) and Meta's WhatsApp Business verification bureaucracy (mitigated by launching on a BSP).

**Top 5 risks:**

1. **Meta verification & Embedded Signup approval timeline (external, uncontrollable).** Becoming a Meta Tech Provider with Embedded Signup takes weeks to months. Mitigation: launch on a BSP (360dialog) in P3; migrate in P6. (§5, §12-HP2)
2. **RTL/i18n retrofit breadth.** 87 files, 339 physical-direction class occurrences, zero logical properties today, plus every zod validation message in `lib/validations/` and every date/currency call site (~50 files). Mitigation: codemod + regeneration strategy in §4. (§12-HP3)
3. **Service-role client as single point of tenant-leak failure.** ~40 call sites of `createAdminClient()` bypass RLS and rely solely on developers remembering `.eq("clinic_id", ...)`. One omission = silent cross-tenant PHI leak = end of a healthcare SaaS's reputation. Fixed in P0 as a blocking item. (§2.4, §12-HP8)
4. **PHI through LLM + WhatsApp across multiple jurisdictions.** Saudi PDPL, UAE PDPL, Egypt PDPL each constrain processing/transfer of health data. Mitigation: data minimization, provider zero-data-retention agreements, per-clinic consent flows, and a data-residency decision before Saudi launch. (§9)
5. **Unit economics.** WhatsApp template messages, LLM tokens, and SMS are all per-message costs paid by the platform. Without hard per-tenant caps wired into `usage_counters` from day one, a single busy clinic on a flat plan can be unprofitable. (§11, §12-HP7)

---

## 2. Current System Analysis

### 2.1 Architecture as found

Single Next.js 16 (App Router, React 19, TypeScript) application, deployed on Vercel. There is **no REST API layer** — the backend is Next.js Server Actions in [/actions](../actions/) (18 files) calling **Supabase** (Postgres + Auth + Storage) directly, with the security-critical logic pushed into Postgres RLS policies and `SECURITY DEFINER` RPCs across 52 migrations in [supabase/migrations/](../supabase/migrations/). The single existing Route Handler is [app/(protected)/appointments/export/route.ts](../app/(protected)/appointments/export/route.ts).

```mermaid
flowchart TD
    B[Browser] --> MW["middleware.ts → lib/supabase/middleware.ts\n(session refresh, page gating)"]
    MW --> RSC["RSC pages — app/(protected)/*\nfetch via lib/supabase/server.ts (RLS)"]
    MW --> AUTH["app/(auth)/* — login, password flows"]
    RSC --> SA["Server Actions — /actions/*.ts\nzod validate → requireRole → Supabase"]
    SA --> RLS["Supabase Postgres\nRLS: auth_clinic_id(), auth_role()"]
    SA --> RPC["SECURITY DEFINER RPCs\n(billing, status transitions, reports)"]
    SA --> ADMIN["lib/supabase/admin.ts\nservice role — BYPASSES RLS ⚠"]
    RLS --> ST["Storage: avatars / clinic-assets / patient-assets"]
    SA -.unwired.-> RESEND["lib/email/resend.ts (Resend, never called)"]
    SENTRY[Sentry via instrumentation.ts] -.-> SA
```

- **Auth:** Supabase Auth (email/password, cookie sessions). Guards in [lib/rbac.ts](../lib/rbac.ts) — `getAuthedUser()` (line 18), `requireUser()` (line 46), `requireRole()` (line 52). Roles enum `user_role = admin | receptionist | manager | doctor`. **Patients have no accounts** — they are data records only.
- **UI:** Tailwind CSS v4 + shadcn/ui ([components.json](../components.json) — note `"rtl": false`), react-hook-form + zod (schemas in [lib/validations/](../lib/validations/)), data fetched in Server Components, mutations via server actions returning `{ error?, fieldErrors?, success? }`.
- **Testing:** Vitest 4 ([vitest.config.ts](../vitest.config.ts), mock pattern in [tests/unit/helpers/server-action-mocks.ts](../tests/unit/helpers/server-action-mocks.ts)); Playwright ([playwright.config.ts](../playwright.config.ts), not run in CI). CI: [.github/workflows/ci.yml](../.github/workflows/ci.yml) (lint, typecheck, unit tests, build smoke).
- **Ops:** Sentry wired ([instrumentation.ts](../instrumentation.ts), `sentry.*.config.ts`). **No rate limiting, no cron/queues, no feature flags, no notifications of any kind.** Resend email is scaffolded in [lib/email/resend.ts](../lib/email/resend.ts) but never invoked anywhere.

### 2.2 Data model (relevant subset, actual names)

All tenant tables carry `clinic_id`. Baseline schema: [supabase/migrations/20260504000000_baseline_schema.sql](../supabase/migrations/20260504000000_baseline_schema.sql).

| Table | Purpose | Notes |
|---|---|---|
| `clinics` | Tenant root | Columns: name, phone, logo_url, address, `reminder_lead_hours` (1–168, default 24), working hours, `time_format` (12h/24h, added `20260514155418`). **No timezone/currency/locale/country columns.** |
| `profiles` | Staff users (FK → `auth.users`) | `role` distinguishes admin/receptionist/manager/doctor |
| `patients` | Patient records (no accounts) | `phone` column — becomes the WhatsApp identity key (§5.4) |
| `appointments` | Core booking table | Status enum `pending, confirmed, arrived, in_session, completed, cancelled, no_show`; transitions in `STATUS_TRANSITIONS` ([lib/validations/appointment.ts:112](../lib/validations/appointment.ts#L112)), enforced by DB trigger. Has dormant `reminder_sent_at` + partial index `idx_appointments_reminder` (baseline line 441) — ready-made for P3 reminders. |
| `doctor_schedules`, `clinic_working_hours` | Availability inputs | `20260514120000_doctor_schedules_clinic_working_hours.sql` |
| `medical_notes`, `medical_note_attachments`, `patient_documents`, `follow_ups` | Clinical history | RLS scoped by role + author + clinic |
| `patient_packages`, `package_templates`, `services`, `departments`, `insurance_providers` | Catalog/packages | |
| `patient_deposits`, `outstanding_settlements`, `appointment_services` | **Patient** billing (not SaaS billing) | Transactional RPCs `complete_appointment_billing` etc. (`20260506050000`) |
| `audit_logs` | Audit trail (baseline line 198) | Generic trigger `write_audit_log()`; reusable for agent tool-call auditing (§6.6) |
| `feedback`, `staff_invitations`, `user_page_permissions`, `user_customizations` | Misc | |

**Key booking mechanics (reused heavily later):**

- Availability: `getAvailableTimeSlots(doctorId, dateIso)` in [actions/time-slots.ts:32](../actions/time-slots.ts#L32) — doctor schedule → clinic shifts → 08:00–18:00 fallback; 15-minute slots; 15-minute buffer around active appointments; pending appointments do **not** block slots.
- Creation: `createAppointment` in [actions/appointments.ts:213](../actions/appointments.ts#L213) — zod validation, past-time and closed-day checks, reference validation, overlap + buffer conflict check, insert defaulting to `pending`.
- Concurrency: partial unique index `appointments_doctor_active_slot_key` `WHERE status = 'confirmed' AND deleted_at IS NULL` ([20260516000000_allow_pending_same_slot.sql](../supabase/migrations/20260516000000_allow_pending_same_slot.sql)) — only **confirmed** appointments claim a slot exclusively. Pending is deliberately non-exclusive. This is exactly "preliminary booking with human confirmation" already, and the AI agent inherits it for free (with a pile-up cap added in P5 — §12-HP1).

### 2.3 Tenant-isolation audit results

Audited: every table's RLS policies, every `SECURITY DEFINER` RPC, every service-role call site, and storage policies.

**Strong (verified):**

- All 23 tables have `ENABLE ROW LEVEL SECURITY` with policies scoping by `clinic_id = auth_clinic_id()` (tables without their own `clinic_id` — `feedback`, `medical_notes` — scope via joins to `appointments`/`patients`). Doctor read-scoping added in `20260505220000_scope_patient_and_appointment_rls_for_doctors.sql`; role-only write policies on `services`/`insurance_providers` were fixed in `20260506000000`.
- Every business RPC re-resolves `v_clinic_id := auth_clinic_id()` and filters all reads/writes by it — spot-verified on `complete_appointment_billing`, `undo_appointment_billing`, `settle_patient_outstanding` (`20260506050000`), `start_appointment_session` (`20260519007000`), `undo_appointment_status` (`20260517000000`).
- Storage: `clinic-assets` and `patient-assets` object policies require the path's clinic-id segment to equal `auth_clinic_id()` (policies in `20260505210000`, `20260506110000`, `20260511130000`); `avatars` is per-user (`auth.uid()` path match).

**⛔ Flaw 1 — cross-tenant `clinics` policies (BLOCKING).** Baseline lines 586–587, never dropped:

- `clinics_select_admin_all` — `FOR SELECT USING (auth_role() = 'admin')`: **any admin of any clinic can read every clinic row** (names, phones, addresses, logos of all customers).
- `clinics_insert_admin` — `FOR INSERT WITH CHECK (auth_role() = 'admin')`: any admin can insert arbitrary clinic rows.

Harmless in a single-clinic deployment; disqualifying in a SaaS. Fixed first thing in P0.

**⛔ Flaw 2 — ~40 unscoped-by-design service-role call sites (BLOCKING as policy, not as active leak).** [lib/supabase/admin.ts](../lib/supabase/admin.ts) `createAdminClient()` bypasses RLS. Call sites: [lib/cache/reference-data.ts](../lib/cache/reference-data.ts) (4), [actions/settings.ts](../actions/settings.ts) (staff provisioning, lines 77/286/321/366), [actions/page-permissions.ts](../actions/page-permissions.ts) (7), [actions/patients.ts](../actions/patients.ts) (12), [actions/appointments.ts](../actions/appointments.ts) (lines 528, 741), [actions/package-templates.ts](../actions/package-templates.ts#L100), [lib/primary-admin.ts](../lib/primary-admin.ts#L8), [app/(protected)/patients/[id]/page.tsx](../app/(protected)/patients/[id]/page.tsx#L101), [app/(protected)/settings/staff/page.tsx](../app/(protected)/settings/staff/page.tsx#L24). Every site currently filters by `clinic_id` correctly — but there is no defense-in-depth; one future omission leaks PHI across tenants silently. Fixed in P0 with a scoped wrapper + lint ban.

**No self-serve onboarding.** There is no signup route (auth routes are login/forgot/reset/change-password only), no `createClinic` action, no seed script — clinics and their first admin are provisioned by manual DB insert today.

**No SaaS commercial layer.** Zero matches repo-wide for subscriptions, plans, entitlements, feature flags, Stripe/Paddle, or super-admin/operator tooling. `lib/primary-admin.ts` is clinic-scoped, not a platform role.

### 2.4 Hardcoding audit (i18n/TZ/currency)

- [lib/datetime.ts:4](../lib/datetime.ts#L4): `export const CLINIC_TZ = "Europe/Istanbul"` — baked into all six shared formatters, plus Monday-first week start.
- [components/reports/report-formatters.ts:17](../components/reports/report-formatters.ts#L17): `formatCurrency` hardcodes `Intl.NumberFormat("en-GB", { currency: "TRY" })`.
- Spread: **159 lines** of TZ/locale API usage and **58 currency lines across 18 files**; ~50 files total touch date/currency formatting. Heaviest: [components/revenue/revenue-report.tsx](../components/revenue/revenue-report.tsx) (28 lines), [components/appointments/billing-dialog.tsx](../components/appointments/billing-dialog.tsx) (21).
- Known correctness inconsistency: `createAppointment` does closed-day/overlap math with **local-server-timezone** `Date` methods, while `getAvailableTimeSlots` uses explicit Istanbul TZ. Properly fixed by P0's per-clinic timezone work.
- RTL: **87 of 176** TSX files in `app/` + `components/` contain **339 occurrences** of physical-direction classes (`ml-/mr-/pl-/pr-/left-/right-/text-left/text-right/border-l|r/rounded-l|r`); **zero** logical-property usage (`ms-/me-/ps-/pe-`) exists. [components.json](../components.json) has `"rtl": false`; root layout is `lang="en"` with no `dir`. No i18n library installed.

### 2.5 Gaps summary (what the SaaS needs that doesn't exist)

| Gap | Needed by | Planned in |
|---|---|---|
| Fix 2 cross-tenant `clinics` policies; admin-client guardrails | Any external customer | **P0 (blocking)** |
| Per-clinic timezone/currency/locale/country | Kuwait launch (`Asia/Kuwait`, KWD, ar) | P0 |
| Clinic signup + setup wizard | Selling at all | P1 |
| Subscriptions/plans/entitlements/usage counters | Selling at all; AI as add-on tier | P1 |
| Rate limiting; operator panel; per-clinic data export | SaaS operations | P1 |
| Arabic/RTL + i18n | Target market | P2 |
| Any outbound/inbound messaging channel | Reminders, patient contact | P3 |
| Cron/background execution | Reminders, follow-up sequences | P3 |
| In-app staff notifications | Inbox, reminders visibility | P3 |
| Agent infrastructure (LLM client, tools, conversations, eval) | AI assistant | P4–P6 |

---

## 3. SaaS Foundation Plan (Requirement 1)

### 3.1 ⛔ Tenant-isolation remediation (first tasks of P0 — BLOCKING, must be complete before any SaaS customer onboarding)

1. **Migration `fix_clinics_cross_tenant_policies`:** `DROP POLICY clinics_select_admin_all` and `DROP POLICY clinics_insert_admin` on `public.clinics`. Reads are already covered by `clinics_select_own` (`id = auth_clinic_id()`); inserts move exclusively to the new signup RPC (§3.2), so no authenticated-role insert policy is needed at all.
2. **Scoped admin-client wrapper** in [lib/supabase/admin.ts](../lib/supabase/admin.ts): add `createClinicScopedAdminClient(clinicId: string)` returning a thin proxy whose `.from(table)` pre-applies `.eq("clinic_id", clinicId)` for tenant tables (allow-list of exceptions: `auth.admin.*` operations, `user_page_permissions` keyed by `user_id`). Migrate the ~40 call sites listed in §2.3 to it.
3. **Lint rule:** ESLint `no-restricted-imports`/`no-restricted-syntax` entry in [eslint.config.mjs](../eslint.config.mjs) banning direct `createAdminClient()` outside `lib/supabase/admin.ts` and an explicit allow-list file — CI ([.github/workflows/ci.yml](../.github/workflows/ci.yml)) already runs `pnpm lint`, so violations fail the pipeline.
4. **Acceptance criterion / test:** extend [tests/unit/integration/rls-security.test.ts](../tests/unit/integration/rls-security.test.ts) with a **two-clinic fixture**: create clinic A and clinic B with an admin each; assert admin-A cannot select clinic B's row, cannot insert a clinics row, and cannot read B's patients/appointments/notes/storage paths. This two-clinic denial suite becomes a permanent CI fixture reused by every later phase.

### 3.2 Self-serve clinic onboarding

Today: manual DB inserts (§2.3). Plan:

- **New route group** `app/(public)/signup/` (parallel to `app/(auth)/`): clinic registration form (clinic name, country, phone, owner name/email/password, locale).
- **New RPC `create_clinic_with_owner(...)` (SECURITY DEFINER, single transaction):** insert `clinics` row (with new per-clinic config columns, §3.5), create the owner `profiles` row bound to the new Supabase Auth user, seed default `user_page_permissions`. Called from a new `signUpClinic` action in [actions/auth.ts](../actions/auth.ts). Email verification via Supabase Auth (already configured for password flows).
- **Setup wizard** `app/(protected)/onboarding/` shown until complete: steps reuse existing actions verbatim — working hours (`upsertClinicWorkingHours`), departments/services/insurance (CRUD in [actions/settings.ts](../actions/settings.ts)), doctors & staff invites (`createStaff`, `staff_invitations` table), doctor schedules (`upsertDoctorSchedule`). New columns `clinics.onboarding_completed_at`; middleware gate in [lib/supabase/middleware.ts](../lib/supabase/middleware.ts) (same pattern as the existing `must_change_password` gate).

### 3.3 Subscription billing (Paddle primary + Tap Payments fallback)

**Provider comparison (Arab-market lens):**

| Provider | Coverage for our sellers/buyers | Model | Notes |
|---|---|---|---|
| **Stripe** | Not generally available for merchants in Kuwait/Saudi/Egypt (UAE supported) — *verify current country list at execution* | PSP | Fine only if founder incorporates in a Stripe-supported country |
| **Paddle** ✅ primary | Merchant of record — sells globally regardless of founder's incorporation country; handles VAT (KSA 15%, Egypt 14%) and invoicing | MoR, ~5% + fees (approx., as of 2026-07-09 — verify at https://www.paddle.com/pricing) | Best fit: founder doesn't need a local payment license; subscription tooling built in |
| **Tap Payments** ✅ fallback/local | GCC-native (Kuwait HQ) — KNET (Kuwait), mada (Saudi), local cards | PSP, per-txn ~2.x% (approx., as of 2026-07-09 — verify at https://www.tap.company) | Needed because many Kuwaiti/Saudi clinics pay by KNET/mada, which MoRs handle poorly |
| Paymob | Egypt/KSA strong | PSP | Candidate when Egypt becomes a focus market |
| Moyasar | Saudi-only | PSP | Too narrow as primary |

**Recommendation:** Paddle as the default checkout (webhooks → `subscriptions` table), Tap as an alternative checkout for GCC clinics wanting KNET/mada, both normalized into the same subscription model. Start Paddle-only in P1; add Tap when the first customer asks for KNET (realistically within the first Kuwaiti sales conversations).

**New tables (migration `saas_billing`):**

```sql
plans            (id, slug 'basic'|'pro'|'pro_ai', name_ar, name_en, monthly_price_usd,
                  features jsonb, limits jsonb, is_active)
subscriptions    (id, clinic_id FK unique, plan_id FK, provider 'paddle'|'tap'|'manual',
                  provider_subscription_id, status 'trialing'|'active'|'past_due'|'cancelled',
                  trial_ends_at, current_period_start/end, created_at, updated_at)
usage_counters   (id, clinic_id FK, period_start date, metric
                  'ai_messages'|'wa_messages'|'sms_messages'|'emails',
                  used int, limit_snapshot int, unique(clinic_id, period_start, metric))
```

All three RLS'd: clinics read their own `subscriptions`/`usage_counters`; writes only via SECURITY DEFINER RPCs (`increment_usage(clinic_id, metric, amount)` with atomic `insert ... on conflict do update`) and webhook handlers using the scoped admin wrapper. **14-day trial** default (`status = 'trialing'`, `trial_ends_at`), enforced in middleware alongside the auth gates.

Webhook route: `app/api/webhooks/paddle/route.ts` (signature-verified), the second-ever route handler pattern after `appointments/export`.

### 3.4 Entitlements = feature flags (approved mechanism for selling AI as an add-on)

No third-party flag service. `plans.features jsonb` (e.g. `{"ai_assistant": true, "whatsapp": true, "sms": false}`) + `plans.limits jsonb` (e.g. `{"ai_messages_month": 1000, "staff_seats": 10}`).

- **New module `lib/entitlements.ts`:** `getEntitlements(clinicId)` (cached with `unstable_cache` + tag, same pattern as [lib/cache/reference-data.ts](../lib/cache/reference-data.ts)), `hasFeature(ents, "ai_assistant")`, `checkUsageLimit(clinicId, "ai_messages")`.
- Enforced in three places, mirroring existing RBAC layering: middleware (hide gated pages — extends the existing page-visibility mechanism in [lib/page-permissions.ts](../lib/page-permissions.ts) by adding entitlement-conditional slugs), server actions (guard at top, next to `requireRole`), and the agent/messaging send paths (hard usage caps, §6.7/§11).

### 3.5 Per-clinic configuration (fixes the TZ inconsistency properly)

**Migration `clinic_localization_columns`:** `ALTER TABLE clinics ADD COLUMN timezone text NOT NULL DEFAULT 'Asia/Kuwait', currency char(3) NOT NULL DEFAULT 'KWD', locale text NOT NULL DEFAULT 'ar', country char(2) NOT NULL DEFAULT 'KW', week_start smallint NOT NULL DEFAULT 6 /* Saturday */, digits text NOT NULL DEFAULT 'latin' CHECK (digits IN ('latin','arabic'))` (joins the existing `time_format` column from `20260514155418`).

**Code threading:**

- Refactor [lib/datetime.ts](../lib/datetime.ts): every formatter takes a `ClinicLocale` object (`{ tz, locale, weekStart, timeFormat, digits }`) instead of reading the `CLINIC_TZ` constant; delete `CLINIC_TZ`. Same for `formatCurrency`/`formatPercent` in [components/reports/report-formatters.ts](../components/reports/report-formatters.ts) (currency becomes a parameter).
- Serve the object from the existing [contexts/clinic-settings-context.tsx](../contexts/clinic-settings-context.tsx) (client) — it already carries `timeFormat`, so this extends an established pattern — and from a `getClinicLocale()` helper for server actions/RSCs.
- Sweep the ~50 direct `toLocale*`/`Intl.*` call sites (§2.4 list) to the shared helpers. This is mechanical but wide; budgeted 4–6 days inside P0.
- Fix `createAppointment`'s local-server-TZ math ([actions/appointments.ts:213](../actions/appointments.ts#L213) internals: `isPastScheduledAt`, closed-day weekday check, `validateAppointmentSlot` day bounds) to use the clinic timezone — eliminating the Istanbul-vs-server-TZ inconsistency.

### 3.6 Operational must-haves

- **Rate limiting (previously missing entirely):** Upstash Redis (Vercel Marketplace) sliding-window limiter in a new `lib/rate-limit.ts`; applied to auth actions in [actions/auth.ts](../actions/auth.ts) (login, password reset), the signup route, all webhook routes, and (later) agent/messaging endpoints. Per-IP for public routes, per-clinic for authenticated.
- **Per-clinic data export ("can I get my data out?"):** extend the existing export pattern ([app/(protected)/appointments/export/route.ts](../app/(protected)/appointments/export/route.ts)) into `app/(protected)/settings/export/route.ts` — admin-only ZIP of CSVs (patients, appointments, notes metadata, invoices) + signed URLs for documents. Sales objection-killer and practical PDPL data-portability answer.
- **Operator (super-admin) panel:** a **new `platform_admins` table** (`user_id` FK) — deliberately *not* a new value in the clinic `user_role` enum, keeping tenant RBAC untouched. New route group `app/(operator)/` with its own guard (`requirePlatformAdmin()` added to [lib/rbac.ts](../lib/rbac.ts)) and layout, listing tenants, subscription status, usage counters, and message-delivery health. RLS: `platform_admins`-only policies on the SaaS tables; tenant PHI stays invisible to the operator except aggregate counts.
- **Backups/monitoring posture:** Supabase PITR add-on (paid tier) before first paying customer; Sentry env separation (staging/prod DSNs); uptime check on `/api/health` (new trivial route); weekly `pg_dump` to founder-controlled storage as belt-and-braces. Documented as an ops runbook item, not code.

---

## 4. Arabic-First / i18n & RTL Plan (Requirement 2)

**Founder decision baked in:** the staff dashboard itself ships fully Arabic (RTL, Arabic default) in v1 — not just patient-facing surfaces.

### 4.1 i18n architecture

- **Library: `next-intl`** — the de-facto App Router standard; first-class Server Component and server-action support; message catalogs `messages/ar.json` (default) + `messages/en.json`.
- **Routing strategy: no URL locale prefix.** The app is authenticated-only (public surface = login + signup); locale is per-clinic (`clinics.locale`, §3.5) with per-user override (new `profiles.locale` nullable column). `next-intl`'s cookie/request-config mode: a `getRequestConfig` in `i18n/request.ts` resolves user → clinic → `ar` default. Root layout ([app/layout.tsx](../app/layout.tsx)) sets `<html lang={locale} dir={locale === 'ar' ? 'rtl' : 'ltr'}>`.
- **Server actions & zod:** validation messages in [lib/validations/](../lib/validations/) are currently hardcoded English strings. Plan: replace literal messages with **message keys** (`"validation.appointment.pastTime"`), and translate at the edge — a small `translateFieldErrors(fieldErrors, t)` helper applied where actions' `{ error, fieldErrors }` results are rendered (forms use react-hook-form; the resolver path stays untouched). This avoids threading `t()` into every schema and keeps schemas serializable. One shared zod error map for generic messages (`required`, `too_long`), registered in a `lib/validations/error-map.ts`.

### 4.2 RTL as default direction

Current state (measured): 87/176 TSX files, 339 physical-direction occurrences, 0 logical properties, `"rtl": false` in [components.json](../components.json).

**Approved approach — logical-properties codemod + shadcn regeneration (from §12-HP3):**

1. Flip `components.json` to `"rtl": true` and re-add the shadcn primitives in [components/ui/](../components/ui/) (they are generated code; regeneration converts them to RTL-safe variants). Diff-review each against local customizations.
2. Codemod the app-owned 87 files: mechanical class mapping `ml-→ms-`, `mr-→me-`, `pl-→ps-`, `pr-→pe-`, `left-→start-`, `right-→end-`, `text-left→text-start`, `text-right→text-end`, `border-l→border-s`, `border-r→border-e`, `rounded-l→rounded-s`, `rounded-r→rounded-e` (Tailwind v4 supports all logical utilities natively). Script + manual review of the ~10% of cases where physical direction is intentional (e.g., chart axes in [components/dashboard/analytics-section-charts.tsx](../components/dashboard/analytics-section-charts.tsx), print layouts in the reports pages).
3. Icon mirroring inventory: directional lucide icons (`ChevronLeft/Right`, `ArrowLeft/Right` in nav, calendars [components/appointments/week-calendar.tsx](../components/appointments/week-calendar.tsx) etc.) get an `rtl:rotate-180` utility or logical swap; non-directional icons untouched.
4. Recharts (dashboards, [components/revenue/revenue-report.tsx](../components/revenue/revenue-report.tsx)) does not auto-RTL: keep charts LTR internally with translated labels — standard practice, called out so it isn't "discovered" mid-phase.
5. String extraction: all UI copy in the 36 `page.tsx` routes + 126 components into `messages/en.json`, then professional Arabic translation (MSA for UI chrome). Budget real translation cost: ~1,000–1,500 strings.

**Honest effort: 12–18 days** for retrofit + extraction + translation integration + RTL QA pass across all 36 pages in both directions. This is the estimate most tempting to shrink; don't.

### 4.3 Arabic typography (distinctive, not Cairo/Tajawal)

Loaded via `next/font/local` (self-hosted — also avoids Google Fonts latency in GCC), wired in [app/layout.tsx](../app/layout.tsx) where DM Sans/Instrument Serif/Geist Mono load today.

| Option | Type | Licensing (approx., as of 2026-07-09 — verify with foundry) | Notes |
|---|---|---|---|
| **IBM Plex Sans Arabic** ✅ primary | Free (OFL) | $0 | Premium, neutral, excellent weights; pairs with IBM Plex Sans for Latin — coherent bilingual system |
| **Readex Pro** | Free (OFL) | $0 | Softer/rounder; good fallback or marketing-site face |
| Rubik Arabic | Free (OFL) | $0 | Friendly; slightly less "clinical trust" |
| **29LT Zarid Sans** (29LT) | Paid | Web licenses typically ~$100–500/style tier by pageviews — verify at https://29lt.com | Distinctive premium option if founder buys a license; strong Arabic-first design |
| **TPTQ Greta Arabic** (TPTQ Arabic) | Paid | ~€100–500/style web license — verify at https://tptq-arabic.com | Editorial-grade; excellent legibility at small sizes |

**Recommended stack:** IBM Plex Sans Arabic (primary UI) + IBM Plex Sans (Latin) + Geist Mono (kept for numerals/code), with 29LT Zarid Sans as the paid upgrade path for brand distinction. CSS: `font-family: var(--font-plex-arabic), var(--font-plex-latin), system-ui`.

### 4.4 Localization details clinics will notice

- **Digits:** Latin digits (0-9) by default even in Arabic UI (regional b2b software norm in Kuwait/GCC), with per-clinic toggle `clinics.digits = 'arabic'` rendering Arabic-Indic (٠-٩) via `Intl.NumberFormat(locale + '-u-nu-arab')` — flows through the §3.5 formatter refactor for free.
- **Dates:** Gregorian default; **Hijri as a display option** for the Saudi market via `Intl.DateTimeFormat('ar-SA-u-ca-islamic-umalqura')` — shown alongside (not instead of) Gregorian on appointment surfaces. Deferred to the Saudi-launch milestone; the formatter API from §3.5 is designed to accept a calendar parameter so this is additive.
- **Currency:** per-clinic (§3.5): KWD (3 decimal places — note `formatCurrency`'s current `maximumFractionDigits: 2` must become currency-aware), SAR, EGP, AED.
- **WhatsApp & agent RTL:** message templates stored per clinic in their own wording/dialect (§7.4); AI agent replies in the **patient's language — Arabic by default**, with a dialect-tolerant system prompt (understands Gulf/Egyptian/Levantine input, replies in clear polite Arabic mirroring the patient's register; §6.5). Template bodies are validated for Unicode bidi correctness (numbers/times embedded in Arabic text get LRM marks where needed — a `lib/messaging/bidi.ts` helper).

---

## 5. Messaging & WhatsApp Architecture (Requirement 3)

**Constraint:** the founder owns no WhatsApp number and must never need one. Every clinic connects **its own** number; patients message the clinic, not the platform.

### 5.1 Model comparison

**Model A — Meta Tech Provider + Embedded Signup (the end-state).**
The SaaS registers as a Meta Tech Provider (Meta Business verification of the founder's company required: registered legal entity, website, business documents). Once approved, clinics complete **Embedded Signup** inside our dashboard: a Meta-hosted popup where the clinic creates/connects its own WABA and phone number (the number must not be active on personal/Business-app WhatsApp, or must be migrated). We store per-tenant assets (WABA ID, phone-number ID, and a system-user access token we generate for their WABA) and receive all their inbound traffic on **our single webhook**, routing by `phone_number_id → clinic_id`. Conversation/template charges are billed by Meta to the **clinic's** WABA payment method (clinic attaches their card) — cleanest cost attribution; alternatively we onboard them under our billing and re-bill via `usage_counters`. **Realistic timeline: 4–10 weeks** for business verification + Tech Provider/Embedded Signup approval (approx., as of 2026-07-09 — verify at https://developers.facebook.com/docs/whatsapp/embedded-signup), before the first clinic can connect. Zero per-message middleman margin.

**Model B — BSP-mediated (360dialog / Twilio).**
A Business Solution Provider fronts the Meta relationship. 360dialog: ~€49/month per connected number, no per-message markup (Meta pass-through) (approx., as of 2026-07-09 — verify at https://www.360dialog.com/pricing). Twilio: per-message markup (~$0.005/msg) on top of Meta fees plus per-number costs (verify at https://www.twilio.com/whatsapp/pricing). Clinics still connect their own numbers, but through the BSP's hosted signup — live in **days**, minimal Meta bureaucracy for us. Tradeoffs: per-number monthly cost eats margin; platform dependency; migration later requires number/WABA porting (supported, but a project).

**Model C — no WhatsApp (email/SMS only).** Not viable as an end-state in this market — WhatsApp is the dominant patient channel in GCC/Egypt — but must work as the **day-one state of every new clinic** before their WhatsApp is connected.

**Recommendation (approved): launch on 360dialog in P3, architect every internal interface against our own channel abstraction (never the BSP SDK directly), migrate to Tech Provider + Embedded Signup in P6** once Meta verification completes and customer count justifies reclaiming the €49/number/month.

### 5.2 Channel abstraction — `outbound_messages` and `lib/messaging/`

**New tables (migration `messaging_layer`):**

```sql
clinic_channels    (id, clinic_id FK, channel 'whatsapp'|'sms'|'email',
                    provider 'dialog360'|'meta'|'unifonic'|'resend',
                    credentials_encrypted bytea,        -- pgsodium/vault, §9.2
                    sender_identity text,               -- phone number / from-address
                    status 'pending'|'active'|'error', connected_at)
outbound_messages  (id, clinic_id FK, channel, provider, recipient text,
                    template_id FK nullable, body_preview text,   -- minimal PHI, §9.3
                    related_type 'appointment'|'invoice'|'agent'|'manual' , related_id uuid,
                    status 'queued'|'sent'|'delivered'|'read'|'failed', provider_message_id,
                    error text, cost_micro int, created_at, status_updated_at)
inbound_messages   (id, clinic_id FK, channel, sender text, patient_id FK nullable,
                    conversation_id FK, body text, provider_message_id, received_at)
conversations      (id, clinic_id FK, patient_id FK nullable, channel,
                    window_expires_at timestamptz,      -- 24h service window
                    status 'open'|'closed', assigned_to FK profiles nullable, last_message_at)
message_templates  (id, clinic_id FK, channel, name, language 'ar'|'en', body,
                    variables jsonb, provider_template_id,
                    approval_status 'draft'|'submitted'|'approved'|'rejected')
```

All RLS'd by `clinic_id` (two-clinic denial tests extended accordingly).

**New module `lib/messaging/`:** `provider.ts` (interface: `send(message)`, `parseWebhook(req)`, `verifySignature(req)`), adapters `whatsapp-dialog360.ts`, `whatsapp-meta.ts` (P6), `sms-unifonic.ts`, `email-resend.ts` (finally wiring the dormant [lib/email/resend.ts](../lib/email/resend.ts)), and `send.ts` — the single entry point that resolves the clinic's active channel by preference order (WhatsApp → SMS → email), checks entitlements + `usage_counters`, records the `outbound_messages` row, and dispatches. **A clinic works on day one with email/SMS before WhatsApp is connected.**

Webhooks: `app/api/webhooks/whatsapp/route.ts` (inbound messages + delivery statuses; routes by phone-number-id → `clinic_channels`), `app/api/webhooks/unifonic/route.ts`, `app/api/webhooks/resend/route.ts` (delivery events). All signature-verified (§9.2) and rate-limited (§3.6).

### 5.3 Manual WhatsApp inbox (first-class P3 deliverable)

Staff answer patient WhatsApp/SMS messages from the dashboard **before any AI exists** — and the P5 agent later plugs into this exact surface as a suggested/auto-reply layer.

Scope: inbound webhook → `conversations` threading per patient (§5.4 identity) → **inbox UI** at `app/(protected)/inbox/` (new `PageSlug` "inbox" in [lib/page-permissions.ts](../lib/page-permissions.ts), visible to admin/receptionist by default) — conversation list with unread badges + thread view + reply box; replies allowed inside the 24-hour service window, template-picker outside it; every reply recorded in `outbound_messages`; realtime updates via Supabase Realtime (the CSP in [next.config.ts](../next.config.ts) already allows `wss://*.supabase.co`). Estimate and acceptance criteria in P3 (§8).

### 5.4 Patient identity & safety rules (kept from prior direction)

- **Identity = phone number** matched against `patients.phone` within the clinic. Unmatched senders get a polite triage flow (name + "are you an existing patient?") and land in the inbox as unlinked conversations for staff to link/create.
- **Lightweight verification before any medical content:** phone match alone permits logistics only (booking, hours, directions). Before the agent (or a template) includes appointment details tied to history, or any medical info: DOB confirmation challenge, verified per conversation and cached on `conversations` (`identity_verified_at` column). Staff in the manual inbox see a "verified" badge.
- **24-hour window vs templates:** freeform replies only within `window_expires_at`; outside it, only `approval_status = 'approved'` templates. Enforced in `lib/messaging/send.ts`, not in UI alone.
- **Minimal PHI in bodies:** templates carry appointment time + doctor name + clinic name; never diagnoses, notes, or balances. Deep detail lives behind "call the clinic" or a future authenticated link.

---

## 6. AI Assistant Agent (updated for the SaaS context)

### 6.1 Approach

**Anthropic Claude via the Vercel AI SDK (v6) tool-calling loop**, model strings through the Vercel AI Gateway (`"anthropic/claude-..."`) for provider observability and fallback. Why this pattern over alternatives:

- **Pure RAG chatbot:** can answer FAQs but cannot check real availability or create bookings; wrong tool for transactional flows.
- **Hardcoded flows (menu bots):** reliable but can't handle free-text Arabic dialect input, and duplicate the booking logic the codebase already has.
- **Third-party bot platforms:** monthly per-seat cost, poor Arabic dialect handling, and — decisive here — they can't enforce our RLS/RBAC inside their tools.

Tool calling reuses the *actual* production code paths (§6.3), so the agent can never invent an availability answer — it reports what `getAvailableTimeSlots` returns.

### 6.2 Where the agent lives

- **`lib/ai/`** — `client.ts` (model config per task tier, §11), `prompts/` (doctor + patient system prompts, ar/en), `tools/` (one file per tool), `redact.ts` (PHI minimization pre-LLM), `guardrails.ts` (injection defenses, refusal patterns).
- **Staff surface:** streaming route handler `app/api/agent/chat/route.ts` (server actions can't stream; precedent for route handlers exists in `appointments/export`) + `useChat` UI at `app/(protected)/assistant/` — new `PageSlug` "assistant", gated by `hasFeature("ai_assistant")` (§3.4) and role, plus a contextual launcher on the patient profile page [app/(protected)/patients/[id]/page.tsx](../app/(protected)/patients/[id]/page.tsx) (slide-in `Sheet` from [components/ui/sheet.tsx](../components/ui/sheet.tsx)).
- **Patient surface: WhatsApp, via the P3 inbox** — *this replaces the retired patient-portal prerequisite*. Inbound message → `lib/ai/agent-loop.ts` invoked from the webhook handler (Vercel Fluid Compute; no streaming needed for WhatsApp) → reply drafted → per-clinic mode: `ai_mode = 'suggest'` (staff approves in inbox) or `'auto'` (sends directly, logged, escapes to human on low confidence or explicit request — "أريد التحدث مع موظف").
- **Conversation state:** staff chats in new `agent_conversations` / `agent_messages` tables (clinic-scoped, RLS'd); patient-side state rides the existing `conversations`/`inbound_messages` from §5.2. Streaming for staff; graceful fallback message + Sentry capture on model/tool errors, never a stack trace to a patient.

### 6.3 Tool contracts

Every tool: zod-validated params, **authorization enforced inside the tool at the data layer** (§9.1), audit-logged (§6.6). Tools call refactored **callable cores** of existing actions — P4/P5 tasks extract the logic from the FormData-shaped actions (e.g., `validateAppointmentSlot`, the body of `getAvailableTimeSlots`) into `lib/booking/` functions used by both the actions and the tools, so there is exactly one booking implementation.

| Tool | Persona | Underlying code path | Auth inside tool |
|---|---|---|---|
| `get_patient_summary(patient_id)` | doctor/staff | patient row + recent `appointments`, `medical_notes`, `follow_ups`, `patient_packages` via RLS client | `requireRole(["admin","doctor"])`; RLS doctor-scoping (`20260505220000`) filters rows automatically |
| `search_patient_visits(patient_id, query, date_range)` | doctor/staff | `medical_notes` + `appointments` filtered text search | same |
| `list_doctor_appointments(date_range)` | doctor | logic from [actions/doctor-dashboard.ts](../actions/doctor-dashboard.ts) | doctor's own `id` from session, never a parameter |
| `check_availability(doctor_id?, date, service?)` | both | core of `getAvailableTimeSlots` ([actions/time-slots.ts:32](../actions/time-slots.ts#L32)) — role gate widened from admin/receptionist to include the agent contexts | staff session or verified patient conversation |
| `create_preliminary_booking(slot, doctor_id, service?)` | patient | core of `createAppointment` ([actions/appointments.ts:213](../actions/appointments.ts#L213)); status always `pending`; pile-up caps from §12-HP1 | patient identity from the conversation record only — `patient_id` is **not** a model-visible parameter |
| `list_my_appointments()` / `cancel_my_appointment(id)` | patient | RLS-scoped select; cancel = `pending`-only self-cancel (confirmed cancellations route to staff) | conversation-bound patient id; DOB-verified (§5.4) |
| `answer_clinic_faq(question)` | patient | new `clinic_faq` table (per-clinic Q&A managed in settings) — retrieval, no medical answers | clinic scope from channel routing |

### 6.4 Human-in-the-loop and write limits

Bookings created by the agent are **always `pending`** — the existing state machine (`STATUS_TRANSITIONS`, DB trigger `enforce_appointment_transition`) means staff confirm via the normal appointments UI, and only `confirmed` rows claim slots exclusively. The agent has **zero tools** that modify or delete medical records, complete billing, or transition statuses beyond patient self-cancel of own pending bookings.

### 6.5 System-prompt design (per persona)

- **Doctor assistant (ar/en per user locale):** clinical *information retrieval and summarization only*; cites which notes/dates a summary came from; refuses diagnosis, treatment recommendations, and drug dosing ("I can show you the record; clinical judgment is yours"); refuses any patient outside tool results (tools already enforce this — the prompt is defense-in-depth, never the enforcement).
- **Patient assistant (Arabic by default, dialect-tolerant):** understands Gulf/Egyptian/Levantine dialect input, replies in clear courteous Arabic (or the patient's language); scope = clinic info, hours, prices from `services`, booking, own appointments; **hard refusals**: no medical advice, no diagnosis, no information about other patients, no staff information beyond doctor names/specialties; escalates to human on medical questions, complaints, and emergencies (emergency keywords → immediate canned response with clinic phone + local emergency number by `clinics.country`).

### 6.6 Audit

Every tool invocation writes to the existing `audit_logs` table (baseline line 198) via a new `log_agent_tool_call` RPC: `actor_id` (staff id, or null + conversation id for patients), `action = 'agent_tool:<name>'`, `table_name`, `record_id`, params-summary in `new_data` (post-redaction). The existing `audit_logs_select_admin_manager` policy gives clinic admins visibility for free.

### 6.7 Per-tenant limits & language

Every agent turn: `checkUsageLimit(clinicId, "ai_messages")` before the model call; over-limit behavior = degrade-to-human (patient side: "a staff member will reply shortly" + inbox flag; staff side: upgrade prompt). Counted via `increment_usage` into `usage_counters` (§3.3) — the same table pricing tiers read. Responses default to Arabic per §4.4.

---

## 7. Notifications & Reminders (Requirement 4)

### 7.1 Scheduling: Vercel Cron → route handlers

**Recommendation: Vercel Cron** hitting `app/api/cron/reminders/route.ts` and `app/api/cron/invoice-followups/route.ts` (secured by `CRON_SECRET` header check). Justification vs `pg_cron` + Supabase Edge Functions: the send logic must live where `lib/messaging/` lives (one runtime, one deploy, Sentry coverage via existing [instrumentation.ts](../instrumentation.ts)); Edge Functions would duplicate provider adapters in a second codebase. `pg_cron` remains the documented fallback if Vercel cron granularity (per-minute available on paid plans — verify at execution) ever binds.

### 7.2 Appointment reminders

For **confirmed** appointments only. Per-clinic configurable offsets stored in a new `clinics.reminder_offsets int[] DEFAULT '{24,3}'` (hours) — generalizing the existing dormant `reminder_lead_hours` column. The cron job queries exactly the ready-made partial index `idx_appointments_reminder` (baseline line 441: `scheduled_at WHERE status='confirmed' AND reminder_sent_at IS NULL`), extended with a `reminders_sent jsonb` per-offset marker; sends via `lib/messaging/send.ts` using the clinic's approved reminder template in the clinic's language; stamps `reminder_sent_at`. Idempotent (re-runs skip stamped rows).

### 7.3 Invoice/unpaid follow-up sequence

Data source: `appointments.outstanding_amount` + `outstanding_settlements`. **Sequence (per clinic, defaults):** D0 invoice notification on completion (hooked where `updateAppointmentStatus` completes billing) → D+3 gentle reminder → D+7 final reminder. **Stop conditions:** outstanding settled (`settle_patient_outstanding` RPC path), appointment cancelled/refunded, patient opted out, or max 3 messages. State machine in a new `followup_sequences` table (`clinic_id, appointment_id, step, next_run_at, stopped_reason`), advanced by the cron job. Per-clinic on/off + wording via `message_templates`.

### 7.4 Template management UI

`app/(protected)/settings/templates/` (following the existing settings CRUD pattern of [app/(protected)/settings/services/](../app/(protected)/settings/services/)): clinics edit their templates **in their own wording/dialect** (ar default + optional en variant), variables validated against the allowed set, WhatsApp templates submitted to the provider from here with `approval_status` tracked (`draft → submitted → approved/rejected` — webhook updates from the BSP). Bidi-correctness lint from §4.4 applied on save.

### 7.5 Staff in-app notification center

New `notifications` table (`clinic_id, recipient_id FK profiles nullable = role-broadcast, type, title, body, link, read_at`), RLS per recipient/clinic. Bell + dropdown in the [app/(protected)/layout.tsx](../app/(protected)/layout.tsx) header (next to the existing user chip), backed by Supabase Realtime (CSP already permits it). Emitters: new inbound patient message (inbox), agent escalation, booking pending confirmation, reminder-send failures, subscription events.

### 7.6 Recording & attribution

Every send of any kind goes through `lib/messaging/send.ts` → one `outbound_messages` row with provider, status lifecycle (sent/delivered/read/failed via webhooks), and `cost_micro`. This single table feeds: usage counters (billing tiers), the operator panel's delivery-health view, and the audit story ("what did we send this patient and when").

---

## 8. Revised Phased Roadmap

Summary table at the top of this document. Common to every phase: unit tests follow the [tests/unit/helpers/server-action-mocks.ts](../tests/unit/helpers/server-action-mocks.ts) pattern; new tables get RLS + two-clinic denial tests; CI additions to [.github/workflows/ci.yml](../.github/workflows/ci.yml) where noted.

### P0 — Tenant hardening & per-clinic config (8–12 days) — ⛔ BLOCKING before any customer onboarding

- **Goal:** make multi-tenant isolation airtight and localization tenant-configurable.
- **In scope:** the four §3.1 remediation tasks (policies migration, `createClinicScopedAdminClient`, lint ban, two-clinic denial tests); `clinic_localization_columns` migration (§3.5); refactor [lib/datetime.ts](../lib/datetime.ts) + [components/reports/report-formatters.ts](../components/reports/report-formatters.ts) to `ClinicLocale`-parameterized helpers; sweep ~50 call sites; fix `createAppointment` server-TZ math. **Out:** any new features.
- **Migrations:** `fix_clinics_cross_tenant_policies`, `clinic_localization_columns`.
- **Tests:** two-clinic RLS denial suite (extends `tests/unit/integration/rls-security.test.ts`); unit tests for datetime/currency helpers across `Asia/Kuwait`/`Asia/Riyadh`/`Africa/Cairo` and KWD (3 dp)/SAR/EGP; regression: booking conflict tests in `tests/unit/actions/` still green with clinic TZ ≠ server TZ.
- **Acceptance:** cross-tenant denial suite passes in CI; `grep -r "createAdminClient()" actions/ lib/ app/` returns only allow-listed sites; no `CLINIC_TZ` constant remains; a clinic set to `Asia/Kuwait` shows correct slot times when the server runs UTC.

### P1 — SaaS foundation (15–20 days)

- **Goal:** a clinic can sign up, trial, subscribe, and be operated.
- **In scope:** signup route group + `create_clinic_with_owner` RPC + wizard (§3.2); `saas_billing` migration + Paddle checkout/webhooks (§3.3); `lib/entitlements.ts` + gating hooks (§3.4); rate limiting (`lib/rate-limit.ts`, Upstash); operator panel `app/(operator)/` + `platform_admins`; data-export route (§3.6). **Out:** Tap Payments (added on first KNET request), dunning emails (P3 delivers channels).
- **Migrations:** `saas_billing`, `platform_admins`, `onboarding_completed_at`.
- **Tests:** signup-RPC unit tests (rollback on partial failure); webhook signature + idempotency tests with fixture payloads; entitlement gate tests (Basic clinic denied `ai_assistant`); Playwright: signup → wizard → dashboard happy path (add to `tests/e2e/`).
- **Acceptance:** a stranger can self-serve from signup to a working, isolated clinic in <10 minutes; trial expiry locks mutating actions; operator panel lists tenants/usage without exposing PHI.

### P2 — Arabic-first i18n & RTL (12–18 days; parallelizable with P1 after P0)

- **Goal:** entire staff UI ships Arabic/RTL by default; English secondary.
- **In scope:** `next-intl` setup (§4.1); zod message-key refactor across [lib/validations/](../lib/validations/); shadcn regeneration with `"rtl": true`; logical-properties codemod of 87 files; icon mirroring; string extraction + Arabic translation; typography stack (§4.3); digits/date/currency polish (§4.4, minus Hijri). **Out:** Hijri (Saudi milestone), marketing site.
- **Migrations:** `profiles.locale` (nullable).
- **Tests:** i18n snapshot tests for representative pages in `ar`+`en` (extend `tests/unit/pages/`); CI grep-gate failing on new physical-direction classes; Playwright smoke in Arabic locale; visual QA checklist of all 36 pages in RTL.
- **Acceptance:** default new clinic experience is fully Arabic RTL with zero mirrored-layout defects on the 36 pages; language toggle flips instantly; no hardcoded English strings in components (lint/extraction check).

### P3 — Messaging layer, manual WhatsApp inbox & notifications (15–20 days)

- **Goal:** clinics communicate with patients (manually) and notifications run automatically.
- **In scope:** `messaging_layer` migration + `lib/messaging/` with `dialog360`/`unifonic`/`resend` adapters (§5.2); WhatsApp connect flow in settings (360dialog hosted signup) + `clinic_channels` credential encryption; webhook routes with signature verification; **manual inbox** (§5.3) — *sub-estimate 5–7 of these days*: threading, inbox UI, 24h-window enforcement, template picker, realtime, unlinked-sender triage; Vercel Cron + reminders (§7.2); invoice follow-up sequences (§7.3); template management UI (§7.4); notification center (§7.5). **Out:** any AI; Tech Provider migration.
- **Migrations:** `messaging_layer`, `followup_sequences`, `notifications`, `clinics.reminder_offsets`.
- **Tests:** provider adapters unit-tested against recorded fixture payloads (send, status callback, signature failure); window-enforcement tests (freeform blocked at 24h+1min); reminder job idempotency (run twice → one send); sequence stop-condition tests; Playwright: staff replies to a (mocked-webhook) patient message.
- **Acceptance (manual inbox):** a patient WhatsApp message to a connected clinic number appears in that clinic's inbox in <5s with correct patient linking; staff reply is delivered and its status reaches `delivered` in `outbound_messages`; a clinic with no WhatsApp still sends reminders via SMS/email; every send has an `outbound_messages` row with cost attribution.
- **Acceptance (notifications):** confirmed appointment triggers reminders at configured offsets in the clinic's language/timezone; unpaid invoice sequence sends D0/D+3/D+7 and stops on settlement.

### P4 — Doctor AI assistant, read-only (10–14 days)

- **Goal:** doctors/staff query patient history in natural language (Arabic/English).
- **In scope:** `lib/ai/` foundation (client, prompts, guardrails, redaction); `agent_conversations`/`agent_messages` migration; extraction of callable cores into `lib/booking/` and patient-summary helpers; doctor tools (§6.3 rows 1–4); streaming route + `app/(protected)/assistant/` chat UI + patient-profile Sheet launcher; audit RPC (§6.6); entitlement + usage-cap wiring. **Out:** all write tools; patient-facing anything.
- **Migrations:** `agent_conversations_messages`, `clinic_faq` (schema only, content UI in P5).
- **Tests:** LLM fully mocked (deterministic tool-call fixtures); per-tool authorization tests — doctor A cannot summarize doctor B's-department patient (asserting the `20260505220000` RLS scoping through the tool); redaction unit tests; Playwright: staff chat happy path with mocked model.
- **Acceptance:** doctor asks in Arabic "لخص لي تاريخ المريض فلان" and receives a summary citing real notes/dates; every tool call appears in `audit_logs`; Basic-plan clinics see the upgrade gate; usage cap degrades gracefully.

### P5 — Patient WhatsApp AI + preliminary booking (12–16 days)

- **Goal:** the AI answers patients in the P3 inbox and books pending appointments safely.
- **In scope:** webhook → agent loop with suggest/auto modes (§6.2); patient tools (§6.3 rows 5–8) incl. `create_preliminary_booking` on the shared `lib/booking/` core; **pending pile-up controls** (§12-HP1: per-patient pending cap of 1 active AI booking + per-slot pending cap + auto-expiry of unconfirmed AI-created pendings after clinic-configurable TTL, via the P3 cron); DOB verification step (§5.4); FAQ content UI in settings; confirmation/cancellation message flows (booking → "pending, the clinic will confirm" → confirmation template on staff confirm, hooked into `updateAppointmentStatus`); escalation to human. **Out:** payments over WhatsApp, rescheduling negotiation (post-v1).
- **Migrations:** `conversations.identity_verified_at`, `appointments.expires_at` (AI-created pendings) or `pending_booking_holds` table (decide at implementation; the former is simpler), FAQ content columns.
- **Tests:** booking-tool concurrency test (two simultaneous bookings, same slot → both pending, staff confirm one, second is displaced via the existing `getConflictingPendingAppointments` flow in [actions/appointments.ts](../actions/appointments.ts)); cap tests; identity-gating tests (unverified sender gets no appointment details); Arabic-dialect fixture conversations; end-to-end with mocked provider + mocked LLM.
- **Acceptance:** a verified patient books a real free slot via WhatsApp in Arabic; the slot appears as `pending` for staff exactly like a receptionist-created one; caps prevent >N pendings per slot and >1 active AI pending per patient; agent never reveals data of another patient in adversarial tests.

### P6 — Hardening, evaluation & Tech Provider migration (10–15 days)

- **Goal:** production confidence and margin recovery.
- **In scope:** prompt-injection test suite (adversarial ar/en corpora run in CI against mocked-tool agent asserting no unauthorized tool calls); evaluation set (~50 doctor + ~50 patient realistic queries, graded rubric, run per prompt/model change); load tests on webhook + agent routes; cost dashboards in the operator panel (per-clinic LLM/WA/SMS from `usage_counters` + `outbound_messages.cost_micro`); Meta Business verification → Tech Provider + Embedded Signup ([§5.1 Model A] — start the verification paperwork *at P3 time*, execute the technical migration here); per-clinic migration runbook off 360dialog.
- **Tests/acceptance:** injection suite green in CI; eval score threshold documented and met; a pilot clinic migrated to Embedded Signup with zero message loss; alerting fires on delivery-failure spikes.

---

## 9. Security, Privacy & Compliance (blocking requirements)

### 9.1 Authorization inside every tool, at the data layer

The model is **never** trusted to self-restrict. Every agent tool: (1) resolves identity server-side — staff via `getAuthedUser()` from [lib/rbac.ts](../lib/rbac.ts), patients via the conversation record's `patient_id` + `identity_verified_at`; (2) queries through the **RLS-respecting client** ([lib/supabase/server.ts](../lib/supabase/server.ts)) or clinic-scoped RPCs — **never** the service-role client; (3) re-checks role exactly as actions do (`requireRole(["admin","doctor"])` etc.). Patient tools never accept `patient_id` as a model-visible parameter (§6.3). RLS remains the backstop: even a buggy tool cannot cross clinic or doctor-scope boundaries because the doctor-scoping policies (`20260505220000`) and clinic policies filter at the database.

### 9.2 Per-tenant secrets & webhook integrity

- `clinic_channels.credentials_encrypted`: WhatsApp/BSP tokens encrypted at rest (Supabase Vault / pgsodium), decrypted only inside `lib/messaging/` server code; never logged, never sent to the client, excluded from Sentry via `beforeSend` scrubbing in [sentry.server.config.ts](../sentry.server.config.ts).
- All webhooks verify provider signatures (Meta `X-Hub-Signature-256`, 360dialog/Unifonic equivalents) before parsing; unsigned → 401 + rate-limit counter.

### 9.3 PHI/PII handling with the LLM and messaging providers

- **Data minimization:** `lib/ai/redact.ts` strips national IDs, file numbers, and contact details from tool outputs before they enter the model context; summaries reference notes by date/author, not by document dump, unless the doctor explicitly opens a note.
- **Provider agreements:** use Anthropic API / Vercel AI Gateway **zero-data-retention** options and execute a DPA before real patient data flows (verify current ZDR/DPA availability at execution — https://privacy.anthropic.com). No training on our data.
- **Retention:** `agent_messages` and `inbound_messages` retention configurable per clinic (default 24 months, PDPL-friendly); patient can request deletion via the clinic (export/delete supported by the P1 data-export machinery).
- **Minimal PHI in message bodies** (§5.4); `outbound_messages.body_preview` stores a truncated, redacted preview only.

### 9.4 Prompt-injection & abuse defenses

Patient free text is **untrusted input**: tool results and patient messages are delimited and role-tagged; the patient persona has an allow-listed tool set (no doctor tools mounted at all — enforced in code by constructing the tool array per persona, not by prompt); instructions embedded in patient messages ("ignore your rules…", Arabic variants) covered by the P6 injection suite; low-confidence or out-of-scope → human escalation. Rate limiting per sender phone and per clinic (§3.6); usage caps (§6.7) bound the blast radius of abuse economically.

### 9.5 Jurisdictional notes (practical level — not legal advice)

- **Kuwait (first market):** DPPR (CITRA regulation) — consent-based processing, breach notification; health data treated as sensitive. Keep clinic-facing consent language in onboarding + patient WhatsApp opt-in recorded on first contact.
- **Saudi Arabia (second):** **PDPL** — sensitive-data rules for health data, data-transfer restrictions that make **data residency a pre-launch decision**: evaluate Supabase region options or a KSA-hosted read/write strategy before Saudi go-live (flagged as an open question, §13).
- **UAE:** federal PDPL + free-zone regimes (DIFC/ADGM); health data additionally under ICP/DoH rules for providers.
- **Egypt:** PDPL (Law 151/2020) — licensing requirements for sensitive-data processing; verify before Egypt push.
- Common posture that satisfies all four practically: explicit consent, minimization, retention limits, export/delete capability, breach-notification runbook, and documented sub-processors (Supabase, Vercel, Anthropic, BSP, Resend, Unifonic).

### 9.6 Human-in-the-loop & audit (recap)

Agent bookings are always `pending` until staff confirm through existing flows; the agent never modifies or deletes medical records (§6.4); every tool call is written to `audit_logs` (§6.6); every message send/receive is recorded (§7.6). Clinic admins can already read their audit trail via the existing RLS policy.

---

## 10. Testing & Quality Strategy

- **Deterministic LLM testing:** the model is mocked in all unit/E2E tests — fixtures of tool-call sequences (Vercel AI SDK supports mock language models); assertions run on *tool inputs/outputs and side effects*, not on prose.
- **Tool authorization tests (the most important suite):** every tool × every persona × cross-boundary attempt, using the established `vi.doMock` pattern from [tests/unit/helpers/server-action-mocks.ts](../tests/unit/helpers/server-action-mocks.ts) plus live-DB RLS assertions in `tests/unit/integration/`.
- **Multi-tenant fixtures:** the P0 two-clinic fixture becomes a shared helper (`tests/unit/helpers/two-clinic-fixture.ts`) reused by messaging, billing, and agent suites — every new table ships with a cross-tenant denial test.
- **i18n:** snapshot tests in `ar` + `en` for representative pages (extend `tests/unit/pages/`); CI grep-gate against physical-direction class regressions.
- **Webhooks:** recorded fixture payloads per provider incl. signature-failure and replay cases; idempotency asserted (same `provider_message_id` twice → one row).
- **E2E (Playwright, `tests/e2e/`):** signup→wizard (P1), Arabic-locale smoke (P2), inbox reply (P3), staff chat (P4), WhatsApp booking with mocked provider+model (P5). Recommend adding a nightly E2E job to CI (currently E2E is never run in CI).
- **Evaluation set (P6):** ~100 realistic doctor/patient queries (both languages, incl. dialects), rubric-graded; run on every prompt or model-tier change; injection corpus run in CI.

---

## 11. Cost & Operations

**Model tiers:** Claude **Haiku 4.5** for patient FAQ/routing/booking dialogue (fast, cheap, fine for constrained tool flows); Claude **Sonnet-tier** for doctor clinical summaries (quality matters, volume is low). Prompt caching on the static system prompt + tool definitions cuts input cost substantially on multi-turn chats.

**Reference prices (all approximate, as of 2026-07-09 — verify at execution):**
LLM: Haiku 4.5 ≈ $1 / $5 per M input/output tokens; Sonnet ≈ $3 / $15 (https://docs.claude.com/en/docs/about-claude/pricing). WhatsApp: Meta per-template-message pricing varies by country/category — utility messages roughly $0.005–0.05, marketing higher; free within the 24h service window; Kuwait falls in Meta's "Middle East" rate group (https://developers.facebook.com/docs/whatsapp/pricing). 360dialog ≈ €49/month per number, Meta fees pass-through (https://www.360dialog.com/pricing). Unifonic GCC SMS ≈ $0.02–0.04/msg (https://www.unifonic.com). Font licensing (if 29LT/TPTQ purchased) ≈ $300–1,500 one-time/annual depending on pageview tier.

**Per-conversation LLM cost sketch:** patient booking dialogue ≈ 6–10 turns × (~2.5k cached input + ~1.5k uncached + ~300 output) tokens on Haiku ≈ **$0.01–0.03**; doctor summary ≈ 1–3 turns with ~6–10k input on Sonnet ≈ **$0.05–0.15**.

**Per-clinic monthly unit economics (approximate, for tier sanity-checking):**

| Usage profile | Reminders (WA) | Patient AI convos | Doctor AI queries | Est. LLM | Est. WA/BSP | Est. SMS fallback | Total est. cost |
|---|---|---|---|---|---|---|---|
| Low (solo clinic, ~150 appts/mo) | ~300 msgs | ~50 | ~100 | ~$8 | ~€49 + ~$4 | ~$2 | **~$65–75** |
| Medium (~500 appts/mo) | ~1,000 | ~200 | ~400 | ~$30 | ~€49 + ~$15 | ~$5 | **~$105–125** |
| High (multi-doctor, ~1,500 appts/mo) | ~3,000 | ~600 | ~1,200 | ~$90 | ~€49 + ~$45 | ~$15 | **~$200–250** |

Implication: **Basic** (no AI, email/SMS reminders) can price low; **Pro** (WhatsApp + inbox) must clear ~$60–130 cost; **Pro+AI** needs the `ai_messages` cap (§3.4) and pricing ≥ ~2× the high-profile cost to hold margin — final prices are a founder decision (§13). The €49/number BSP fee is the single biggest fixed unit cost and is what the P6 Tech Provider migration eliminates.

**Monitoring:** Sentry (already wired) for errors; operator-panel dashboards from `usage_counters` + `outbound_messages` (delivery rates, cost per clinic, AI usage vs cap); alert thresholds on delivery-failure rate and per-clinic cost anomalies.

---

## 12. Hard Problems and Recommended Solutions

**HP1 — Pending-booking pile-up on the same slot by the agent.**
Only `confirmed` appointments claim slots exclusively ([20260516000000_allow_pending_same_slot.sql](../supabase/migrations/20260516000000_allow_pending_same_slot.sql)); `getAvailableTimeSlots` doesn't count pendings as blocking. An AI accepting many patients could stack unlimited pendings on one attractive slot, burying staff in displacement work (the existing `confirmAndDisplaceConflicts` flow handles displacement one-at-a-time).
*Candidates:* (a) make AI bookings exclusive holds — rejected: breaks the deliberate human-confirmation design; (b) per-slot pending cap + per-patient cap + TTL auto-expiry; (c) real-time "soft hold" with 15-minute reservation.
**Recommendation (approved): (b)** — cap AI-created pendings per slot (default 2, clinic-configurable), one active AI pending per patient, TTL auto-expiry via the P3 cron (default 24h, then a "still want this?" template). Implemented inside the shared `lib/booking/` core in P5. **Cost:** ~2 days inside P5.

**HP2 — WhatsApp verification bureaucracy for small clinics.**
Meta requires business verification and a clean number; small Kuwaiti clinics have neither patience nor Meta Business Manager literacy — this can stall activation for weeks per customer.
*Candidates:* (a) Tech Provider Embedded Signup only — clean but blocked on our own approval; (b) BSP-hosted signup now (360dialog handles clinic-side friction) + concierge onboarding (we do it with them on a call); (c) SMS/email-first onboarding so the product works before WhatsApp exists.
**Recommendation (approved): (b)+(c) together in P3, migrate to (a) in P6.** The channel abstraction (§5.2) makes WhatsApp an upgrade, not a prerequisite. **Cost:** built into P3; concierge time is a sales cost.

**HP3 — RTL retrofit cost.**
87 files / 339 occurrences / 0 logical properties, plus generated shadcn primitives and all string extraction — a classic 3× underestimate.
*Candidates:* (a) big-bang manual rewrite; (b) codemod for the mechanical 90% + shadcn regeneration + focused manual pass + CI grep-gate; (c) CSS `:dir()` overrides layered on top — rejected: permanent double-maintenance.
**Recommendation (approved): (b)**, as specified in §4.2. **Cost:** 12–18 days (P2) + ~$500–1,500 professional translation + optional font license.

**HP4 — Payment provider coverage gaps across Arab countries.**
Stripe is unavailable to merchants in most target countries; local PSPs (Tap/Paymob/Moyasar) don't do merchant-of-record, leaving VAT/invoicing on the founder.
*Candidates:* (a) Paddle MoR only — global reach, but weak local rails (KNET/mada); (b) local PSP only — coverage gaps + tax burden; (c) Paddle primary + Tap fallback for GCC local rails.
**Recommendation (approved): (c)**, normalized into one `subscriptions` model (§3.3). **Cost:** ~3 days extra in/after P1 for the second provider; Paddle's ~5% MoR fee is the price of not needing local entities.

**HP5 — PHI + LLM provider data agreements.**
Clinic health data flowing to a US LLM provider is the #1 diligence question from any serious clinic, and PDPL-sensitive.
*Candidates:* (a) send full records, rely on provider terms; (b) minimization + redaction + ZDR/DPA; (c) regional/self-hosted models — rejected for v1: quality/ops cost.
**Recommendation (approved): (b)** — `lib/ai/redact.ts`, ZDR via Anthropic/AI Gateway, DPA executed before pilot, documented sub-processor list (§9.3, §9.5). **Cost:** ~2 days engineering + contract legwork.

**HP6 — Per-tenant WhatsApp token security.**
A leaked clinic token lets an attacker impersonate the clinic to its patients.
*Candidates:* (a) plaintext columns behind RLS — insufficient for this asset class; (b) Supabase Vault/pgsodium encryption, decrypt only in `lib/messaging/`, scrubbed from logs/Sentry; (c) external KMS — overkill at this scale.
**Recommendation (approved): (b)** (§9.2), plus token-rotation support in the connect flow. **Cost:** ~1–2 days in P3.

**HP7 — AI cost control per tenant.**
Flat-price plans + per-message LLM/WA costs = a busy clinic can be individually unprofitable, or a runaway conversation loop can burn real money.
*Candidates:* (a) pure metered billing — accurate but hostile pricing UX in this market; (b) tier caps in `usage_counters` with hard stop + degrade-to-human + upsell; (c) unlimited with anomaly alerts — gambling.
**Recommendation (approved): (b)** (§3.4, §6.7), plus per-conversation turn caps and a circuit breaker on repeated model errors. **Cost:** ~2 days across P1/P4.

**HP8 — Service-role call sites as a silent cross-tenant leak vector.**
~40 RLS-bypassing call sites guarded only by convention (§2.3 Flaw 2); the failure mode is invisible until a customer sees another clinic's data.
*Candidates:* (a) eliminate the admin client entirely — impossible: `auth.admin` APIs and cross-user reads need it; (b) scoped wrapper + lint ban + allow-list + two-clinic CI tests; (c) second RLS role with limited bypass — elegant but heavy Postgres surgery.
**Recommendation (approved): (b)** — `createClinicScopedAdminClient` (§3.1). **Cost:** ~2–3 days in P0. Blocking.

---

## 13. Open Questions for the Founder

Decided already (baked into this plan): staff UI fully Arabic in v1; Kuwait → Saudi → GCC/Egypt launch order; all HP recommendations approved; manual inbox is a first-class P3 deliverable.

Still open:

1. **Pricing points** for Basic / Pro / Pro+AI (cost floors in §11; suggested anchors: ~$49 / ~$99 / ~$149–199/month — pure founder call against Kuwaiti willingness-to-pay).
2. **Data residency for Saudi launch:** accept EU-region Supabase with PDPL transfer safeguards, or invest in a KSA-region deployment before Saudi go-live? (Affects P-timeline after v1; §9.5.)
3. **AI reply mode default:** launch patient AI as `suggest` (staff approves every AI reply — safer, slower) or `auto` with escalation? Recommendation: `suggest` for each clinic's first 2 weeks, then opt-in `auto`.
4. **Trial policy:** 14-day free trial (planned default) vs. demo-clinic sandbox vs. founder-led onboarding only for the first ~10 customers.
5. **Font licensing budget:** ship free IBM Plex Sans Arabic v1, or purchase 29LT Zarid Sans (~$300–1,500) for brand distinction at launch?
6. **Hijri calendar priority:** confirmed as Saudi-milestone (not v1) — acceptable?
7. **Legal:** which entity/ jurisdiction will contract with clinics (affects Paddle onboarding, DPAs, and the Meta Business verification in P6 — the verification should start as early as P3).

---

*All file paths, line numbers, table names, policy names, and counts in this document were verified against the repository as of 2026-07-09 (branch `docs/fix-readme-current-implementation`). External market figures are approximate, dated, and marked for re-verification at execution time.*
