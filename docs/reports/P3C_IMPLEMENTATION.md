# P3C Implementation Report — Manual WhatsApp Inbox

**Date:** 2026-07-17  
**Branch:** `feat/p3a-messaging-core` (continued in place as requested)  
**Status:** Complete after final production-readiness review remediation; ready for re-review  
**Scope:** P3C only

## Outcome

P3C adds the Admin/Receptionist WhatsApp inbox defined in `docs/AI_AGENT_PLAN.md`: clinic-scoped conversation list and thread views, unlinked-sender triage, assignment and lifecycle controls, derived unread badges, authenticated Supabase Realtime refreshes, freeform replies inside the 24-hour customer-service window, and approved-template replies outside that window.

The enforcement boundary is server-side in the shared P3A `sendMessage()` path, not only in the UI. Review remediation moved inbound threading, triage, provider acceptance, and delivery-status transitions into narrow transactional PostgreSQL functions; the P3B inbound flow preserves staff-reviewed link/unlink decisions and assignment when a later message reopens a closed conversation. Authenticated provider callbacks remain authoritative across local transport failures regardless of whether the callback arrives before or after local finalization.

No reminder scheduler, template CRUD, notification center, AI behavior, identity-verification challenge, or later-phase work was added.

## Implementation

### Inbox, threading, and Realtime

- Added `/inbox` as a `PageSlug`, protected route, sidebar destination, and Admin/Receptionist-only surface.
- Added a responsive two-pane inbox with:
  - searchable conversation summaries;
  - patient/sender identity, latest preview, assignee, closed state, and unread badge;
  - ordered inbound/outbound thread bubbles and outbound delivery status;
  - empty, loading, error, and no-match states;
  - verified/not-verified identity indicator;
  - close/reopen controls and reply lockout while closed.
- Initial server data is loaded through the authenticated RLS client. The list remains bounded to 100 WhatsApp conversations, and both the recent set and explicitly requested conversation remain WhatsApp-scoped. Each preview/latest-inbound/unread summary is derived independently in PostgreSQL through indexed lateral lookups. The selected thread is loaded by conversation id independently of the list, so a global message cap can no longer omit its newest messages. Active patient options remain bounded to 500; linked patient metadata is loaded separately when it falls outside that option set.
- Added the three P3C messaging tables to the `supabase_realtime` publication.
- The browser loads its existing SSR Supabase session, applies the access token to Realtime, then opens independent channels for `conversations`, `inbound_messages`, and `outbound_messages`. Role-aware tenant RLS is the subscription filter; a redundant client-side UUID filter was removed after it reproducibly suppressed local INSERT delivery. Updates are debounced into `router.refresh()`, with a five-second refresh backstop only while Realtime reports a degraded state.
- The CSP now permits the configured Supabase HTTP and WebSocket origins in addition to the production `*.supabase.co` allowlist, so local and non-standard Supabase origins can use Realtime.
- Unread counts are derived as inbound messages newer than the latest **sent/delivered/read** manual outbound reply. Queued and failed sends do not clear unanswered inbound activity. Opening a conversation stores a per-viewer, device-local seen timestamp; this keeps the P3C read-state model device-local without adding later-phase durable read receipts.

### Triage, ownership, and lifecycle preservation

- Unlinked conversations can be linked, changed, or unlinked from an active clinic patient.
- Linking/unlinking synchronizes the conversation and its historical inbound rows in one transaction. `patient_link_status` distinguishes automatic matching, an explicit manual link, and an explicit unlink so a later webhook cannot undo staff triage.
- The triage dialog searches bounded active patients and can open patient creation with the sender phone prefilled and a safe return URL back to the thread.
- Assignment accepts only active, non-deleted Admin/Receptionist users from the same clinic. Doctors and cross-clinic users are rejected server-side.
- A successful reply claims an unassigned conversation for the sender but never overwrites an explicit owner.
- New inbound traffic reopens a closed conversation only when the provider event is newer than the close transition, advances `last_message_at` and the 24-hour window monotonically, and preserves its assignee.
- If staff manually linked the conversation to a patient, later phone matching no longer replaces or clears that reviewed ownership.

### 24-hour enforcement and templates

- Manual WhatsApp sends must carry a valid conversation id.
- The shared send path rejects closed conversations and channel/clinic mismatches.
- Freeform messages are allowed only while `window_expires_at` is strictly in the future; the `24h + 1ms` boundary is covered by a unit test.
- Outside the window, the server requires an approved WhatsApp template owned by the clinic. Draft/submitted/rejected, wrong-channel, missing, and malformed template inputs fail closed.
- Template parameters are validated and rendered into the stored redacted preview. The 360dialog adapter sends the actual WhatsApp `template` payload with language and body parameters.
- Successful manual sends finalize their outbound row and advance `last_message_at` in one database transaction without changing assignment, patient ownership, status, or the inbound-derived service window.
- Every provider dispatch carries the outbound UUID as `biz_opaque_callback_data`. The immediate acceptance write is retried three times and never reports success if durability is uncertain; a later authenticated callback can repair a missing provider-id correlation from that opaque UUID. A callback may also recover a locally failed row that has no provider correlation, while a provider-correlated failure remains terminal. This is the minimum P3C recovery boundary, not a full outbox.
- Delivery callbacks use a row-locked monotonic transition function. Concurrent or out-of-order `sent`/`delivered`/`read` events cannot regress state, a local timeout cannot overwrite provider-confirmed state, and authenticated callback repair remains authoritative whether it arrives before or after local failure finalization.

### Authorization, localization, and privacy

- All inbox mutations re-run the Admin/Receptionist authorization boundary and operate through clinic-scoped server clients or explicitly reviewed service-role RPC boundaries.
- RLS on `conversations`, `inbound_messages`, `outbound_messages`, and P3C-consumed templates now requires both the owning clinic and an Admin/Receptionist role. Manager/Doctor direct queries and Realtime source rows are denied.
- Composite clinic foreign keys prevent a service-role bug from assigning a patient or inbox owner from another tenant.
- Navigation visibility, middleware protection, page permission defaults, and tests were updated for the new route.
- English and Arabic inbox/action-error catalogs are complete; i18n and RTL gates pass.
- The thread uses the P3A redacted `body_preview` for outbound messages because the minimal-PHI schema intentionally does not retain full outbound bodies.
- The identity badge remains **Not verified** until P5A adds the planned verification field and challenge; P3C does not persist or infer verification state.

## Files

### Added for P3C

- `app/(protected)/inbox/page.tsx`
- `app/(protected)/inbox/loading.tsx`
- `components/inbox/inbox-shell.tsx`
- `lib/messaging/inbox.ts`
- `tests/e2e/p3c-inbox.spec.ts`
- `tests/unit/actions/p3c-inbox-actions.test.ts`
- `tests/unit/components/p3c-inbox-shell.test.tsx`
- `tests/unit/lib/p3c-window-enforcement.test.ts`
- `docs/reports/P3C_IMPLEMENTATION.md`

### Updated for P3C

- `actions/messaging.ts`
- `app/(protected)/patients/new/page.tsx`
- `components/layout/sidebar.tsx`
- `lib/messaging/send.ts`
- `lib/messaging/types.ts`
- `lib/messaging/webhooks.ts`
- `lib/messaging/whatsapp-dialog360.ts`
- `lib/page-permissions.ts`
- `lib/supabase/admin.ts`
- `lib/supabase/middleware.ts`
- `lib/validations/messaging.ts`
- `messages/en.json`, `messages/ar.json`
- `messages/action-errors/en.json`, `messages/action-errors/ar.json`
- `next.config.ts`
- `package.json`
- `playwright.config.ts`
- `supabase/migrations/20260717090000_p3a_messaging_layer.sql`
- `tests/e2e/rate-limit-server.ts`
- `tests/unit/integration/p3b-whatsapp-webhook.test.ts`
- `tests/unit/integration/p3a-messaging-rls.test.ts`
- `tests/unit/integration/p3c-inbox-summary.test.ts`
- `tests/unit/lib/p3b-dialog360-adapter.test.ts`
- `tests/unit/lib/p3a-messaging-send.test.ts`
- `tests/unit/lib/dashboard-navigation.test.ts`
- `types/database.ts`

The working tree also retains all earlier uncommitted P3A/P3B files and the user's pre-existing plan/environment edits.

## Migration and transactional boundaries

No second migration file was added because the P3A/P3B/P3C work is still uncommitted and the P3A messaging migration has not shipped. The existing `20260717090000_p3a_messaging_layer.sql` was amended coherently before merge with:

- stable conversation participant identity, explicit patient-link state, and status-transition timestamp;
- tenant-composite patient/assignee foreign keys and a unique sender-thread key;
- Admin/Receptionist role-aware read RLS for the inbox content tables;
- `persist_whatsapp_inbound` for atomic threading/idempotency/activity updates;
- `set_conversation_patient` for atomic staff triage;
- `finalize_outbound_message` and `advance_outbound_message_status` for durable, monotonic outbound lifecycle updates;
- `get_inbox_conversation_summaries` for bounded but exact list summaries; and
- Realtime publication of the three inbox lifecycle tables.

All privileged functions revoke `public`/`anon`/`authenticated` execution and grant only `service_role`; the summary function is an authenticated security-invoker function whose table access remains governed by RLS.

## Production-readiness review findings resolved

1. **H1 — inbox loading correctness:** removed the global oldest-2,000-message slice. Exact database summaries are computed per bounded WhatsApp conversation, the selected thread is queried independently, requested WhatsApp conversations can be included outside the newest 100, non-WhatsApp conversations cannot enter or consume the P3C result bound, and linked patient display data no longer depends on the first 500 patient options. Full pagination/virtualization remains deferred.
2. **H2 — inbound atomicity/concurrency:** inbound replay detection, unique sender-thread resolution, patient match, message insert, reopen, and activity/window advancement now run in one transaction under a clinic+sender advisory lock. Concurrent first-contact events produce one conversation; any failure rolls back the whole event.
3. **H3 — event ordering/status monotonicity:** conversation timestamps use monotonic advancement and delayed pre-close events cannot reopen a thread. Outbound callbacks and synchronous finalization are row-locked and rank-aware. Local failure cannot regress a provider-confirmed `sent`/`delivered`/`read` state, and an authenticated callback can recover an uncorrelated local failure before continuing through normal monotonic provider transitions.
4. **H4 — durable patient ownership:** explicit automatic/manual/unlinked state prevents webhook auto-matching from overwriting a staff decision. Link/unlink and historical inbound synchronization are atomic and share the sender lock with webhook persistence. Tenant-composite foreign keys add defense in depth.
5. **H5 — database authorization:** content-table RLS now matches the approved Admin/Receptionist inbox roles. Manager/Doctor denial and cross-clinic isolation are integration-tested; Realtime inherits the same policies.
6. **H6 — outbound lifecycle durability:** immediate finalization is transactional, checked, and retried; uncertain persistence returns an error instead of false success. WhatsApp callbacks carry/consume the opaque outbound UUID to repair lost provider correlation and recover a local transport failure without weakening provider-correlated terminal failures or adding a complete outbox architecture.
7. **H7 — unread correctness:** only successfully accepted lifecycle states (`sent`, `delivered`, `read`) establish the reply boundary. Failed/queued sends remain visible in the thread but cannot clear patient unread activity.

## Tests added or updated

- Server send-window coverage for inside-window freeform, `24h + 1ms` rejection without dispatch/persistence, approved-template delivery, and closed-conversation rejection.
- Server-action coverage for shared-send reuse and automatic claim, assignee role validation, and patient-link synchronization.
- Component coverage for verified/unverified badges, closed-window template selection, and open-window freeform composition.
- 360dialog adapter coverage for the provider-native template payload.
- Database integration coverage for concurrent first-contact threading, replay idempotency, delayed inbound ordering, close/reopen behavior, explicit link/unlink preservation, assignment preservation, concurrent delivery ordering, callback correlation repair, callback-before-local-failure ordering, local-failure-before-callback recovery, and repaired `sent` → `delivered` → `read` advancement.
- Database summary coverage with 2,001 inbound rows proving the newest preview, independently loaded thread, and unread count remain correct beyond the former cap, that a later failed reply does not clear unread activity, and that neither recent nor explicitly requested non-WhatsApp conversations enter the P3C summaries.
- RLS coverage proving Admin/Receptionist access, Manager/Doctor denial, anonymous denial, cross-clinic isolation, and write denial.
- Navigation/permission coverage proving Inbox is visible only to Admin/Receptionist.
- Playwright coverage for login → empty inbox → authenticated mocked webhook → Realtime thread appearance → patient match → manual reply through the provider mock → delivered callback.

## Validation

- `supabase db reset` — pass; all migrations apply from a clean database.
- `supabase db lint --local --level warning` — pass for P3C; only the two pre-existing unused `v_service_id` warnings in legacy billing RPCs remain.
- Authenticated Realtime/RLS probe — pass (`SUBSCRIBED`, then `INSERT_RECEIVED`) after removing the redundant UUID filter.
- Focused P3 RLS/concurrency/summary integration — 3 files, 21 tests passed after the final clean reset.
- Full integration suite — 16 files, 112 tests passed.
- Full unit/component suite — 136 files, 731 tests passed.
- P3C Playwright flow — 1 test passed; fresh production build/server, real authenticated Realtime INSERT refresh, mocked provider send, and delivered callback completed in 3.8 seconds.
- `pnpm typecheck` — pass.
- `pnpm lint` — pass with 0 errors and 26 pre-existing warnings.
- `pnpm lint:rtl` — pass.
- `pnpm lint:i18n` — pass.
- `pnpm i18n:missing` — pass.
- `pnpm i18n:unused` — pass.
- `git diff --check` — pass.
- `pnpm build` — pass through the dedicated Playwright command; `/inbox` and `/settings/messaging` are included in the production route output.

## Deferred items

- P3D owns template CRUD/submission UI, reminder and follow-up scheduling, cron routes, retry operations, and the notification center. P3C only consumes already-approved templates.
- P5A owns the identity-verification challenge and `identity_verified_at` persistence. Until that field lands, all current conversations correctly display **Not verified**.
- Durable cross-device, per-user read receipts would require a read-state table/column that the P3C plan does not authorize. P3C therefore uses derived unread activity plus per-viewer device-local seen timestamps.
- The bounded initial inbox loader does not add cursor pagination or virtualization; those can be introduced when production volume justifies them without changing the messaging model.
- A complete outbox/queue, scheduled reconciliation worker, and fleet-scale delivery alerting remain deferred to P3D/P6B. P3C implements only the checked retry plus callback-correlation repair required to avoid false success and recover the approved manual WhatsApp lifecycle.
- **M4 deferred:** non-WhatsApp inbox reply composition remains out of P3C; the summary boundary now enforces the approved WhatsApp-only surface while the underlying message schema remains channel-abstracted.
- **M5 deferred:** expanded audit/retention/redaction policy work remains outside P3C. No direct new correctness or authorization defect requiring scope expansion was found during remediation.
- A live clinic-owned 360dialog staging smoke remains an operational deployment check. The automated browser flow uses the real webhook/send code with local provider-shaped mocks and encrypted fixture credentials.
- Full outbound message bodies are not persisted by the P3A minimal-PHI schema; the inbox intentionally displays its redacted preview rather than expanding storage scope.

## Repository state

Nothing was committed, pushed, merged, or opened as a pull request. All P3A, P3B, and P3C work remains uncommitted on the current branch for review.
