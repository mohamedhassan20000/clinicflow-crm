# P6D — WhatsApp Health, Diagnostics & Production Readiness — Implementation Report

**Date:** 2026-07-28  
**Plan reference:** `docs/AI_AGENT_PLAN.md` §P6D  
**Scope:** P6D only. No comprehensive P6 review, commit, push, or merge.

## 1. What was implemented

### 1.1 Clinic WhatsApp Health page

Added `/settings/messaging/health`, available to clinic Admin and Manager roles.
The server page reads a clinic-scoped, safe-metadata snapshot and sends no
credential envelope, provider token, sender, recipient, message body, raw provider
error, or PHI to the client.

The bilingual EN/AR dashboard presents:

- active provider and channel/connection status;
- current webhook health, last provider-side check, and last verified inbound event;
- shared provider-route signature-failure and rate-limit-rejection counts for the
  latest 24 hours (shown as unavailable, never zero, when Redis telemetry is absent);
- latest real inbound timestamp and latest real outbound timestamp/status;
- provider-binding template totals by draft/submitted/approved/rejected;
- last provider sync;
- Meta-only account/business review, phone/name, quality, and messaging-limit signals;
- explicit unavailable placeholders for those Meta-only signals on 360dialog.

The existing messaging settings page links to the Health page without replacing or
changing the P6C onboarding paths.

### 1.2 Read/retry diagnostics

Added a closed server-action registry for:

- refresh Meta connection status;
- sync provider template status;
- verify and, only on explicit operator action, repair webhook configuration drift;
- perform a provider connectivity no-op.

Every requested action is clinic-scoped, entitlement-checked, restricted to Admin
and Manager, and audit-logged as `messaging:health_action` before provider I/O.
Already-correct webhook repair is idempotent. The actions do not send messages,
submit business verification/review state, or expose credentials.

### 1.3 Webhook health and scheduled drift detection

Added non-secret webhook-health fields and service-role-only database RPCs:

- atomic health writes and transition-only `messaging:webhook_health` audits;
- a fair bounded claim for daily health checks;
- a metadata-only operator report source.

Verified Meta and 360dialog callbacks now stamp the clinic channel's last verified
event only after signature verification and clinic routing. Signature and rate-limit
rejections are counted before tenant trust as provider-route aggregates.

The existing daily messaging cron now runs a sixth independent `allSettled` job
that checks both providers for webhook drift. It records degradation within that
run but does not auto-repair; guided webhook repair remains an explicit user action.
No new cron or P6B alert threshold was added.

### 1.4 Activity timeline and readiness checklist

The dashboard timeline merges only:

- real `messaging:*` audit rows relevant to connection, template, webhook, and
  recovery actions; and
- the actual latest inbound, outbound, and sync timestamps.

Events are sorted newest-first and capped at 50. Missing history stays empty; no
historical event is synthesized.

The readiness checklist is derived from persisted sources:

- active/connected channel;
- at least one verified inbound webhook;
- at least one approved provider template;
- approved Meta account/business review;
- non-degraded Meta quality.

Meta-only checks are unavailable for 360dialog and do not falsely block its
provider-applicable readiness result. Every check links to its remediation surface.

### 1.5 Operator report

Registered the P1.5B `whatsapp-health` operator report with clinic, provider, and
webhook-health filters. The service-only report source returns connection/webhook,
template, last inbound/outbound, sync, and Meta signal metadata. It does not select
credentials, senders, recipients, message bodies, or raw errors.

Future template submissions now write the content-free
`messaging:template_status` audit event needed by the P6D activity timeline.

## 2. Files changed

### New

- `actions/messaging-health.ts`
- `app/(protected)/settings/messaging/health/page.tsx`
- `components/settings/whatsapp-health-dashboard.tsx`
- `lib/messaging/health.ts`
- `lib/messaging/webhook-telemetry.ts`
- `supabase/migrations/20260728230000_p6d_whatsapp_health.sql`
- `tests/unit/components/p6d-whatsapp-health-dashboard.test.tsx`
- `tests/unit/lib/p6d-whatsapp-health.test.ts`
- `tests/unit/lib/p6d-operator-whatsapp-health-report.test.ts`
- `tests/unit/integration/p6d-whatsapp-health.test.ts`
- `docs/reports/P6D_IMPLEMENTATION.md`

### Modified for P6D integration

- `actions/messaging.ts`
- `app/(protected)/settings/messaging/page.tsx`
- `app/api/cron/reminders/route.ts`
- `app/api/webhooks/whatsapp/route.ts`
- `lib/messaging/webhook-http.ts`
- `lib/messaging/whatsapp-dialog360.ts`
- `lib/messaging/whatsapp-meta.ts`
- `lib/operator-reports/registry.ts`
- `lib/supabase/admin.ts`
- `types/database.ts`
- `messages/en.json`
- `messages/ar.json`
- `messages/action-errors/en.json`
- `messages/action-errors/ar.json`
- `tests/unit/actions/p3d-template-actions.test.ts`
- `tests/unit/api/p3b-webhook-routes.test.ts`
- `tests/unit/api/p3d-cron-routes.test.ts`
- `tests/unit/api/p6c-meta-webhook-route.test.ts`
- `tests/unit/integration/ws7-operator-reports.test.ts`
- `tests/unit/lib/p15b-report-registry.test.ts`
- `tests/unit/lib/ws7-operator-report-params.test.ts`

The working tree already contained the uncommitted P6A–P6C implementation and review
fixes. Those changes were preserved.

## 3. Validation results

| Validation | Result |
|---|---|
| P6D migration | Applied successfully to local Supabase |
| TypeScript | `pnpm exec tsc --noEmit` — pass |
| Targeted ESLint | All P6D source/test files and touched integration files — pass |
| RTL gate | `pnpm lint:rtl` — pass; 482 files scanned |
| Message parity/unused copy | EN/AR parity test and `pnpm i18n:unused` — pass |
| Focused P6D + touched regressions | 10 files / **63 tests passed** |
| Broken-webhook cron + UI/health rerun | 3 files / **16 tests passed** |
| Live local-Supabase integration/regression | 5 files / **36 tests passed** |
| Full non-integration suite | 250 files / **1,880 tests passed** |
| Production build | `pnpm build` — pass; Health route included in 71 generated routes |
| Diff whitespace | `git diff --check` — pass |

The live database suite verified transition-only health auditing, reconciliation
against raw inbound/outbound lifecycle timestamps, service-role-only report/mutation
RPCs, anonymous/authenticated denial, messaging RLS isolation, webhook persistence,
and P6C/operator-report compatibility.

Two repository-wide i18n scanner commands remain red only on the pre-existing
uncommitted P6C onboarding component:

- `pnpm lint:i18n` reports its TypeScript callback signature as user-facing JSX;
- `pnpm i18n:missing` reports three dynamic P6C `connectionState` /
  `connectionReason` lookups even though their EN/AR keys exist.

P6D's own message lookups, catalogs, parity tests, lint, RTL checks, types, tests, and
production build are clean. The P6C component/scanners were deliberately not changed
to preserve the requested P6D-only boundary.

No live Meta/360dialog production credentials or approved external assets were
available, so provider calls were tested through adapter fixtures/mocks and local
database boundaries; no real external repair or send is claimed.

## 4. Acceptance coverage

- Provider rendering and honest 360dialog placeholders: component and snapshot tests.
- Raw lifecycle reconciliation and content-free output: live local-Supabase test.
- Idempotent, audited recovery: repeated already-correct repair test plus atomic
  transition-audit integration test.
- Broken webhook detected within one cron run: health-worker test verifies degraded
  persistence and no auto-repair.
- Tenant/service-boundary denial: live anonymous/authenticated RPC denial and scoped
  messaging RLS regressions.
- No credentials/content in snapshot or operator report: serialization and report
  projection tests.
- Readiness uses real sources: Meta and 360dialog snapshot tests.
- Timeline ordering, safe projection, 50-row bound, and honest empty state: health
  timeline tests.

## 5. Scope boundaries honored

- No duplicate P6B alerting or new alert threshold.
- No automatic remediation beyond explicit provider re-sync/repair actions.
- No unsupported 360dialog quality or messaging-limit API.
- No review-time estimate and no mutation of provider review state.
- No comprehensive P6 review started.
- No commit, push, or merge performed.

## 6. Implementation report path

`docs/reports/P6D_IMPLEMENTATION.md`
