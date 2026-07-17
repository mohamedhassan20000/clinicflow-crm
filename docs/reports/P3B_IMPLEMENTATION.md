# P3B Implementation Report — WhatsApp (360dialog) Integration

**Date:** 2026-07-17  
**Branch:** `feat/p3a-messaging-core` (continued in place as requested)  
**Status:** Complete; approved review findings addressed; ready to begin P3C  
**Scope:** P3B only

## Outcome

P3B connects a clinic-owned 360dialog WhatsApp number, sends through the P3A messaging abstraction, authenticates and rate-limits WhatsApp/Resend callbacks, resolves provider identifiers to exactly one clinic, persists inbound conversations idempotently, and synchronizes delivery and WhatsApp template approval state.

The approved P3B review hardening is also complete: unauthenticated webhook failures no longer expose whether a routing identifier, template, message, or channel exists, and the 360dialog connect flow now compensates provider configuration when database persistence fails.

No inbox UI, template-management UI, reminders/cron work, notification center, AI behavior, or Meta Tech Provider migration was added. Those remain P3C, P3D, P5, and P6C work respectively.

## Implementation

### 360dialog adapter and connection flow

- Added `lib/messaging/whatsapp-dialog360.ts` and registered it with `lib/messaging/send.ts`.
- Sends text messages through `POST /messages` with the clinic's decrypted `D360-API-KEY`.
- Added 360dialog template submission through `POST /v1/configs/templates`; provider states normalize to the existing `template_approval_status` enum.
- Added a localized `/settings/messaging` surface:
  - both Admin and Manager can view safe connection metadata;
  - only Admin can connect or rotate credentials;
  - the active subscription must include the `whatsapp` feature;
  - hosted signup opens from the server-only `DIALOG360_SIGNUP_URL`;
  - the post-signup form accepts the generated API key, numeric `phone_number_id`, and display number;
  - credentials are encrypted by the P3A AES-256-GCM boundary and are never returned or prefilled.
- On connection, ClinicFlow generates a per-clinic webhook username and 256-bit secret, configures them as a Basic `Authorization` header at 360dialog, then stores the API key, routing id, display number, and webhook credential in the encrypted channel envelope.
- Before mutating 360dialog, the connect flow reads and holds the existing webhook URL/header configuration. If the ClinicFlow database upsert fails after provider registration, it restores that exact prior provider configuration. Failure to snapshot aborts before mutation; failure of the compensating restore emits a sanitized high-severity Sentry event containing no API key or webhook secret.

### Webhook routes and tenant routing

- Added:
  - `POST /api/webhooks/whatsapp`
  - `POST /api/webhooks/resend`
- Every route uses the shared fail-closed rate-limit boundary before payload processing.
- WhatsApp callbacks are authenticated with the per-clinic Basic credential configured at 360dialog. Decoding rejects non-canonical base64 and comparison is constant-time. This follows 360dialog's supported custom-header/Basic-auth webhook model; the provider does not define a webhook-body HMAC scheme.
- Resend callbacks use its timestamp-bounded Svix HMAC signature.
- Unsigned or invalidly signed callbacks return `401` and perform no message mutation.
- Pre-authentication malformed/unknown WhatsApp routing cases share the same generic `401` response as an invalid signature. Genuine database or credential-envelope faults retain a generic `503` plus `Retry-After` so provider retries and operational alerting still work without exposing the failed lookup.
- Webhook rejection and rate-limit responses are explicitly non-cacheable; rate-limit bodies no longer disclose whether the limiter backend is available.
- WhatsApp message callbacks resolve the non-secret `phone_number_id` stored as `clinic_channels.sender_identity`; the database guarantees `(provider, sender_identity)` is globally unique for WhatsApp.
- Template callbacks that omit phone metadata resolve the globally unique `provider_template_id`, then load the owning clinic's active WhatsApp channel before authentication.
- Cross-tenant lookups are limited to reviewed helpers in `lib/supabase/admin.ts`; all subsequent reads/writes use `createClinicScopedAdminClient(clinicId)`.

### Persistence and idempotency

- Inbound WhatsApp messages normalize the sender to E.164, exact-match an active patient when possible, reuse an existing sender/patient conversation, otherwise create an unlinked conversation for later P3C triage, and advance the 24-hour window.
- `(clinic_id, provider_message_id)` uniqueness makes inbound replay idempotent; repeated delivery returns success with a replay count and creates no second message.
- Delivery status updates resolve globally unique `(provider, provider_message_id)` values and update only the owning clinic. Monotonic ordering prevents late `sent` callbacks from regressing `delivered`/`read`, and prevents a late failure from replacing a delivered state.
- Template approval callbacks update only the template owner and use the existing `draft → submitted → approved/rejected` enum.

## Files

### Added for P3B

- `actions/messaging.ts`
- `app/(protected)/settings/messaging/page.tsx`
- `app/api/webhooks/whatsapp/route.ts`
- `app/api/webhooks/resend/route.ts`
- `components/settings/whatsapp-connection-card.tsx`
- `lib/messaging/channel-management.ts`
- `lib/messaging/webhook-http.ts`
- `lib/messaging/webhooks.ts`
- `lib/messaging/whatsapp-dialog360.ts`
- `lib/validations/messaging.ts`
- `tests/fixtures/messaging/dialog360-inbound.json`
- `tests/fixtures/messaging/dialog360-status.json`
- `tests/fixtures/messaging/dialog360-template-status.json`
- `tests/unit/api/p3b-webhook-routes.test.ts`
- `tests/unit/components/whatsapp-connection-card.test.tsx`
- `tests/unit/integration/p3b-whatsapp-webhook.test.ts`
- `tests/unit/lib/p3b-channel-management.test.ts`
- `tests/unit/lib/p3b-dialog360-adapter.test.ts`
- `docs/reports/P3B_IMPLEMENTATION.md`

### Updated for P3B

- `.env.example`
- `components/settings/settings-nav.tsx`
- `components/settings/settings-page-header.tsx`
- `lib/messaging/send.ts`
- `lib/messaging/types.ts`
- `lib/supabase/admin.ts`
- `messages/en.json`, `messages/ar.json`
- `messages/action-errors/en.json`, `messages/action-errors/ar.json`
- `supabase/migrations/20260717090000_p3a_messaging_layer.sql`
- `tests/unit/components/settings-nav.test.tsx`

The branch also retains the pre-existing uncommitted P3A implementation and unrelated plan/review edits exactly as part of the current working tree.

## Migrations

No new P3B migration was added, matching the plan. The still-uncommitted P3A `messaging_layer` migration was amended before review with two constraints required by P3B routing:

- unique WhatsApp `(provider, sender_identity)` for exact `phone_number_id → clinic_id` resolution;
- unique non-null `message_templates.provider_template_id` for template webhook resolution.

`types/database.ts` already reflects the uncommitted P3A messaging schema.

## Tests added

- Recorded 360dialog fixtures for inbound text, delivery status, and template approval.
- Adapter coverage for sends, provider failures without key leakage, Basic authentication, malformed/tampered/unsigned rejection, webhook configuration, fixture parsing, and template submission.
- Channel-management coverage for encrypted-only persistence and fail-before-provider behavior when the platform key is missing or another clinic owns the phone-number identity.
- Channel-management compensation coverage for snapshot failure, restoration after database failure, and secret-free high-severity alerting when restoration fails.
- Route coverage for unsigned `401` across both providers, rate-limit short-circuiting, two distinct phone-number ids routing to their owning clinics, and template callbacks without phone metadata.
- Route coverage proving malformed/unknown WhatsApp routing cases are indistinguishable from invalid signatures.
- Settings coverage for safe status-only rendering, empty password fields, hosted-signup link safety, Manager read-only behavior, and settings navigation.
- Local-Supabase integration coverage for two-clinic routing, same provider message id safely existing once per clinic, replay producing one row, delivery-state monotonicity, and template approval persistence.

## Validation

- `supabase db reset` — pass; all migrations applied from a clean database.
- `supabase db lint --local --level warning` — pass for P3B; reports only two pre-existing unused-variable warnings in billing functions (`v_service_id`).
- P3A + P3B messaging integration tests — 2 files, 9 tests passed.
- Full integration suite — 15 files, 100 tests passed.
- Full unit/component suite — 133 files, 719 tests passed.
- `pnpm typecheck` — pass.
- `pnpm lint` — pass with 26 pre-existing warnings after P3B warnings were removed; no errors.
- `pnpm lint:rtl` — pass.
- `pnpm lint:i18n` — pass.
- `pnpm i18n:missing` — pass.
- `pnpm i18n:unused` — pass.
- `git diff --check` — pass.
- `pnpm build` — pass.

## Assumptions and deferred items

- `DIALOG360_SIGNUP_URL` is the BSP-hosted onboarding URL supplied for the deployment. After hosted signup, the clinic Admin enters the API key and phone-number id issued for that channel. Partner-API automation and Meta Embedded Signup remain P6C, not P3B.
- Production must provision `MESSAGING_CREDENTIALS_KEY`, `DIALOG360_SIGNUP_URL`, `NEXT_PUBLIC_SITE_URL`, `RESEND_WEBHOOK_SECRET`, and the existing Upstash rate-limit variables. `NEXT_PUBLIC_SITE_URL` must be HTTPS outside localhost.
- No live provider smoke test was possible without real clinic-owned 360dialog/Resend webhook credentials. Protocol behavior is covered with recorded provider-shape fixtures and the documented provider contracts; a production/staging credential smoke remains an operational deployment check.
- Queued/asynchronous webhook acknowledgement was not introduced because it would change the plan's architecture. Current fixture and local database processing remains below the provider's five-second response target; queueing can be evaluated separately if production latency requires it.
- P3C owns inbox/thread/reply UI, realtime, triage, and 24-hour freeform enforcement. P3D owns template CRUD UI, reminders, cron routes, and notifications. None were started here.

## External protocol references

- 360dialog messages: <https://docs.360dialog.com/docs/messaging-api/api-reference/messages>
- 360dialog webhooks: <https://docs.360dialog.com/docs/messaging/webhook>
- 360dialog templates: <https://docs.360dialog.com/docs/resources/templates>
- 360dialog hosted onboarding: <https://docs.360dialog.com/partner/integrations-and-api-development/integration-best-practices/integrated-onboarding/basic-integrated-onboarding>

## Cycle-3 review fixes touching P3B (2026-07-18)

Two P3-phase-review findings landed on P3B-owned surfaces (recorded here; consolidated evidence in `docs/reviews/P3_PHASE_REVIEW.md` cycle 3 and the `docs/reports/P3D_IMPLEMENTATION.md` cycle-3 addendum):

- **P3-M1 (ambiguous WhatsApp outcome).** The 360dialog adapter `send` (`lib/messaging/whatsapp-dialog360.ts`) now classifies thrown fetch errors (timeout/network) and a 2xx-without-message-id as `{ ok:false, ambiguous:true }`, distinct from a definite HTTP rejection. Downstream, `sendMessage` keeps the row queued and the automated sender does not fall back to Email on ambiguous — preventing WhatsApp+Email duplicates.
- **P3-M3 (template state transitions).** `submitWhatsAppTemplate`/`saveMessageTemplate`/`deleteMessageTemplate` (`actions/messaging.ts`) are now single guarded conditional writes; submit claims `submitted` before the provider call and reverts on failure; delete removes the provider template first via the new `deleteDialog360Template` adapter helper; and the webhook `persistTemplateStatus` (`lib/messaging/webhooks.ts`) applies provider states only through a legal-transition map gated on `provider_template_id`, so a stale/late event cannot regress newer local state. Provider calls stay behind the 360dialog adapter.

## Repository state

Nothing was committed, pushed, merged, or opened as a pull request. All P3A/P3B work remains uncommitted on the current branch for review.
