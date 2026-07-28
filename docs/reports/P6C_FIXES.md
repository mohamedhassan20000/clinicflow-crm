# P6C — Review Fixes

**Date:** 2026-07-28  
**Scope:** Required fixes for every Critical, High, Medium, and Low finding in
`docs/reviews/P6C_REVIEW.md`.  
**Boundaries:** P6C only. No P6D implementation, review, commit, push, or merge.

## 1. What was fixed

### Critical

- **P6C-R1 — Meta outbound dispatch:** registered `metaWhatsAppProvider` in the
  production `sendMessage` adapter map. Active Meta channels now send through the
  unchanged provider-neutral messaging boundary. Added a production-boundary test.
- **P6C-R2 — Embedded Signup CSP:** allowed the Facebook SDK in `script-src`,
  Graph/Facebook connection origins in `connect-src`, and the Facebook popup/frame
  origins in `frame-src`. Verified the header from a built production server.
- **P6C-R3 — destructive 360dialog overwrite:** changed channel uniqueness from
  `(clinic_id, channel)` to `(clinic_id, channel, provider)`. Meta first claims a
  separate pending row; the existing 360dialog row and encrypted credentials remain
  intact. The transactional state RPC activates Meta and demotes 360dialog only
  after Meta reaches `connected`; a Meta failure restores the retained 360dialog
  row. The existing 360dialog reconnect flow can atomically switch back without
  deleting Meta.
- **P6C-R4 — incomplete asset/token lifecycle:** the OAuth exchange result is now
  treated only as an OAuth user token and is never stored as a system-user token.
  Before credentials are persisted, the server:
  1. validates the OAuth token with `debug_token`, including app, scope, and WABA
     target;
  2. confirms the WABA is shared with ClinicFlow's Business Manager;
  3. assigns and verifies the platform system user;
  4. fetches the selected phone from that WABA and uses Meta's display number;
  5. registers the phone with the required six-digit PIN;
  6. subscribes the app to the WABA and verifies the subscription.
  Any failure keeps the channel pending and unsendable. Reconciliation detects,
  retries, and re-verifies subscription drift before activation.
- **P6C-R5 — unsupported/invented signals:** reconciliation now requests only
  documented WABA `account_review_status` and phone
  `verified_name,display_phone_number,code_verification_status,quality_rating`
  fields, plus `subscribed_apps`. It does not request or invent
  `business_verification_status`, phone `status`, or `messaging_limit_tier`.
  `account_review_status` and webhook subscription are persisted. An `APPROVED`
  review advances the state; rejection survives template-only re-derivation.
  Display-name approval no longer invents connectivity, and quality/limit webhook
  values are stored separately. Timestamped stale signals are ignored; unordered
  callbacks cannot regress settled success or recover a stored failure (the current
  Graph snapshot can recover it).

### High

- **P6C-R6 — pending/error refresh and phone-less callbacks:** webhook lookup and
  reconciliation now include `pending`, `active`, and `error` Meta channels.
  WABA-only account events route through stored `provider_account_id`, and phone-less
  template callbacks route through provider bindings. The daily poll is now a real
  safety net for pending/error channels.
- **P6C-R7 — Meta template lifecycle/provenance:** added
  `message_template_provider_bindings`, retaining separate 360dialog and Meta
  provider IDs/statuses for one reusable local template. Meta submission uses the
  WABA `message_templates` endpoint; reconciliation synchronizes matching
  pre-approved Meta templates; callbacks and the `connected` gate are
  provider/WABA-scoped. A transactional compatibility bridge preserves legacy
  360dialog callbacks created after the initial backfill.
- **P6C-R8 — non-atomic state/audit transitions:** connection-state compare-and-set,
  provider cutover/fallback, and audit insertion now occur in one database
  transaction. Concurrent callers use `updated_at` CAS and retry; only one can emit
  the transition. Provider template status and its audit row also share one
  transactional RPC. An audit failure rolls back the status/state write.
- **P6C-R9 — provider-scoped identity claim:** sender identity is globally unique
  across WhatsApp providers, the ownership preflight no longer filters by provider,
  and onboarding inserts the clinic-scoped pending claim before any provider
  mutation. Server-side token/WABA/phone verification proves asset ownership before
  credentials are written.

### Medium

- **P6C-R10 — reconciliation starvation/runtime:** the database atomically claims a
  fair bounded batch ordered by `last_sync_attempt_at` and stamps attempts before
  provider I/O, so failures rotate behind unattempted rows. Up to eight clinics
  reconcile concurrently. The cron returns 503 when reconciliation rejects or when
  every claimed channel fails, rather than reporting a false `ok: true`.
- **P6C-R11 — acceptance coverage:** added coverage for production Meta adapter
  selection, onboarding identity/provisioning, CSP/config, popup abandonment,
  subscription retry, documented Graph requests, signal allow-listing, pending/error
  reconciliation, WABA/template routing, Meta template submission/sync/provenance,
  atomic concurrent transitions/audits, provider coexistence/cutover, and live
  two-clinic identity/RLS boundaries.

### Low

- **P6C-R12 — environment/scope documentation:** documented all public and
  server-only Meta variables in `.env.example` and the migration runbook. The Meta
  card now always renders the honest disabled-environment placeholder when public
  config is absent. Quality-rating and messaging-limit diagnostic panels were
  removed from the P6C wizard; they remain P6D scope.

## 2. Files changed

### Runtime and configuration

- `.env.example`
- `next.config.ts`
- `actions/messaging.ts`
- `actions/messaging-onboarding.ts`
- `app/(protected)/settings/messaging/page.tsx`
- `app/api/cron/reminders/route.ts`
- `app/api/webhooks/whatsapp/route.ts`
- `components/settings/whatsapp-onboarding-wizard.tsx`
- `lib/messaging/channel-management.ts`
- `lib/messaging/connection-state.ts`
- `lib/messaging/meta-reconcile.ts`
- `lib/messaging/send.ts`
- `lib/messaging/types.ts`
- `lib/messaging/webhooks.ts`
- `lib/messaging/whatsapp-meta.ts`
- `lib/supabase/admin.ts`
- `lib/validations/messaging.ts`
- `types/database.ts`

### Database and documentation

- `supabase/migrations/20260728220000_p6c_review_fixes.sql`
- `supabase/migrations/20260728221000_p6c_template_binding_compat.sql`
- `supabase/migrations/20260728222000_p6c_template_binding_rpc_resolution.sql`
- `docs/runbooks/P6C_360DIALOG_TO_META_MIGRATION.md`
- `docs/reports/P6C_FIXES.md`

### Tests

- `tests/unit/actions/p3d-template-actions.test.ts`
- `tests/unit/api/p3d-cron-routes.test.ts`
- `tests/unit/api/p6c-meta-webhook-route.test.ts`
- `tests/unit/components/p6c-whatsapp-onboarding-wizard.test.tsx`
- `tests/unit/config/p6c-meta-onboarding-config.test.ts`
- `tests/unit/integration/p6c-review-fixes.test.ts`
- `tests/unit/lib/p3a-messaging-send.test.ts`
- `tests/unit/lib/p3b-channel-management.test.ts`
- `tests/unit/lib/p3d-webhook-template-status.test.ts`
- `tests/unit/lib/p6c-channel-management-meta.test.ts`
- `tests/unit/lib/p6c-connection-state.test.ts`
- `tests/unit/lib/p6c-meta-adapter.test.ts`
- `tests/unit/lib/p6c-meta-reconcile.test.ts`

## 3. Validation results

| Validation | Result |
|---|---|
| Diff whitespace | `git diff --check` — pass |
| TypeScript | `pnpm exec tsc --noEmit` — pass |
| Targeted ESLint | Changed P6C/runtime/test files — pass, 0 errors/warnings |
| Focused P6C + touched regressions | 13 files / **109 tests passed** |
| Full non-integration suite | 247 files / **1,870 tests passed** |
| P6C remediation migrations | Applied cleanly to local Supabase |
| Live local-Supabase P6C + existing messaging RLS/webhook suites | 3 files / **25 tests passed** |
| Production build | `pnpm build` — pass; 70 routes generated |
| Built-app CSP probe | `/settings/messaging` response includes `connect.facebook.net`, `graph.facebook.com`, `www.facebook.com`, and `web.facebook.com` in the required directives |

The live P6C database suite confirmed:

- two provider rows coexist without credential loss;
- identity collisions are rejected across providers/clinics;
- pending/error reconciliation claims rotate fairly;
- concurrent state transitions produce one state change and one audit row;
- Meta cutover demotes, rather than deletes, 360dialog;
- concurrent provider-template callbacks produce one binding transition and one
  audit row;
- provider bindings and mutation RPCs remain unavailable to anonymous clients.

No approved external Meta Tech Provider app/real clinic assets were available, so
no real external Meta signup/send is claimed. The browser production boundary,
server provisioning contract, adapter boundary, database concurrency, local
Supabase RLS, webhook persistence, build, and regressions were validated locally.

## 4. Fix report path

`docs/reports/P6C_FIXES.md`
