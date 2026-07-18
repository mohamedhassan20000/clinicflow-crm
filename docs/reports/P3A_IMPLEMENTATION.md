# P3A Implementation Report

**Sub-phase:** P3A — Messaging schema, channel abstraction, credential encryption & email adapter
**Branch:** `feat/p3a-messaging-core`
**Plan reference:** `docs/AI_AGENT_PLAN.md` §5.2, §9.2, §9.3, P3A execution split (§8)
**Date:** 2026-07-17

## Scope completed

- **`messaging_layer` migration** (`supabase/migrations/20260717090000_p3a_messaging_layer.sql`): all five §5.2 tables — `clinic_channels`, `conversations`, `message_templates`, `outbound_messages`, `inbound_messages` — with seven new enums, clinic-scoped foreign keys, `set_updated_at` triggers, and the indexes the P3B–P3D consumers need (thread ordering, per-clinic delivery views, webhook idempotency).
- **Fail-closed RLS.** The four content tables are clinic-member `SELECT`-only (`clinic_id = auth_clinic_id()`); there are **no authenticated write policies** — all writes go through `lib/messaging/` server code on the service role. `clinic_channels` has **no authenticated policies at all**, so encrypted credentials are unreachable from any client session, including the owning clinic's.
- **Tenant-integrity composite FKs** (P1A `subscriptions` precedent): `inbound_messages(conversation_id, clinic_id) → conversations(id, clinic_id)` and `outbound_messages(template_id, clinic_id) → message_templates(id, clinic_id)` make cross-clinic anchoring a constraint violation even for service-role code.
- **Webhook idempotency at the schema level:** unique partial indexes on `inbound_messages(clinic_id, provider_message_id)` and `outbound_messages(provider, provider_message_id)`.
- **Credential encryption** (`lib/messaging/crypto.ts`): AES-256-GCM with a platform key (`MESSAGING_CREDENTIALS_KEY`, base64 32 bytes), versioned envelope (`[version][IV][auth tag][ciphertext]`) stored as bytea. Encrypt/decrypt happen only inside `lib/messaging/` server code (§9.2); tampering, wrong keys, and malformed envelopes fail closed with typed errors that never carry plaintext.
- **Sentry scrubbing** (`lib/messaging/scrub.ts` + `sentry.server.config.ts` `beforeSend`): deep key-based filtering (credential/secret/token/…), value-shape filtering (`whsec_…`, `re_…`, bearer tokens, bytea envelopes), and `sanitizeProviderError` for anything persisted to `outbound_messages.error`.
- **Channel abstraction** (`lib/messaging/provider.ts`): `MessagingProvider` interface — `send`, `verifySignature`, `parseWebhook` — mirroring `lib/billing/provider.ts`; provider SDK objects never escape an adapter.
- **Email adapter:** `lib/messaging/email-resend.ts` generalizes the `lib/email/resend.ts` wiring P1.5B first used; platform Resend key, platform sender identity; Svix-format webhook signature verification (constant-time, ±5 min timestamp tolerance); delivery-event parsing (`sent`/`delivered`/`opened→read`/`bounced→failed`).
- **Single send entry point** (`lib/messaging/send.ts`): resolves the clinic's active channel in preference order (WhatsApp → email), checks entitlements (`hasFeature`) and usage caps (`checkUsageLimit`) per channel with graceful degradation to email, records the `outbound_messages` row (`queued → sent|failed`), dispatches through the adapter, and counts every successful send via the atomic `increment_usage` RPC. For a subscription-eligible clinic, the same tenant-scoped boundary provisions an active Resend email channel on first use; no WhatsApp row or per-clinic email secret is required.
- **Scoped-admin-wrapper updates** (`lib/supabase/admin.ts`): the five new tables classified as clinic-scoped; new reviewed service-role boundary `incrementClinicUsage()` for the P1A RPC (the wrapper intentionally blocks `.rpc`).
- **Plan catalog limits:** the migration merges `emails_month` / `wa_messages_month` defaults into `plans.limits` (existing keys win), because `checkUsageLimit` fails closed on a missing limit key and would otherwise deny every send.
- **Env surface:** `.env.example` documents `MESSAGING_CREDENTIALS_KEY` and `RESEND_WEBHOOK_SECRET`.
- **Types:** `types/database.ts` extended by hand for the five tables + seven enums in generated style/order (the `db:types` script targets the remote project, which does not have this migration yet).
- **Roadmap update** (`docs/AI_AGENT_PLAN.md`): status header, sub-phase table note, and P2A/P2B/P2C markers updated to reflect that P0–P2, SEO/UX production hardening, and the marketing CTA follow-up are merged on `main`; no scope or ordering changes.

## Migrations added

| Migration | Contents |
|---|---|
| `20260717090000_p3a_messaging_layer.sql` | 7 enums; `clinic_channels`, `conversations`, `message_templates`, `outbound_messages`, `inbound_messages` (+RLS, indexes, triggers, composite FKs); messaging limit defaults merged into `plans.limits` |

`supabase db reset` — passed; all migrations applied from a clean database.

## Tests added

- `tests/unit/lib/p3a-messaging-crypto.test.ts` (8) — round-trip, random IV, missing/short key, wrong key, tampered ciphertext, malformed envelopes, non-string value filtering.
- `tests/unit/lib/p3a-messaging-scrub.test.ts` (5) — key- and value-shape scrubbing at depth, immutability, circular references, `sanitizeProviderError` truncation.
- `tests/unit/lib/p3a-messaging-adapters.test.ts` — Resend send success/failure (scrubbed errors), subject requirement, valid/tampered/stale/missing Svix signatures, status-callback parsing incl. invalid JSON.
- `tests/unit/lib/p3a-messaging-send.test.ts` — input validation; full queued→sent lifecycle with usage increment; WhatsApp entitlement/cap degradation to email; tenant-scoped email provisioning with no pre-existing channel row; first-block error reporting; subscription-inactive/lookup-failure/no-channel fail-closed paths; email subject gate; credential decryption reaching the WhatsApp adapter while never persisting (explicit §9.2 test); undecryptable envelope; provider failure marking the row failed without counting usage; thrown-error sanitization; `RECORD_FAILED`; body-preview redaction/truncation.
- `tests/unit/integration/p3a-messaging-rls.test.ts` (7, two-clinic fixture) — clinic members read own content rows and zero cross-tenant rows on all four content tables; `clinic_channels` returns zero rows to every authenticated session including the owning clinic; anonymous denial on all five tables; authenticated insert/update/delete denial on all five; composite-FK cross-clinic integrity (service-role positive control); webhook-replay uniqueness; messaging limits present on all three plans.

## Validation results

| Check | Result |
|---|---|
| `supabase db reset` | ✅ all migrations apply cleanly |
| `supabase db lint --local --level warning` | ✅ only the two pre-existing legacy billing RPC warnings (same as the P1A baseline) |
| `pnpm typecheck` | ✅ |
| `pnpm lint` | ✅ 0 errors (pre-existing warnings only, none added) |
| `pnpm test` (unit) | ✅ (see final run below) |
| `pnpm test:integration` | ✅ (local Supabase, keys from `supabase status`) |
| `pnpm lint:rtl` | ✅ |
| `pnpm lint:i18n` | ✅ |
| `pnpm build` | ✅ production build |

## Assumptions & decisions (for review)

1. **App-layer AES-256-GCM instead of Vault/pgsodium.** §9.2 suggests "Supabase Vault / pgsodium" as the at-rest mechanism but simultaneously requires decryption "only inside `lib/messaging/` server code". DB-side decryption functions would contradict that stronger requirement; pgsodium TCE is deprecated on current Supabase images and Vault is disabled in this repo's local stack (`supabase/config.toml`). AES-256-GCM in `lib/messaging/crypto.ts` with a server-env key satisfies the requirement as written, matches the planned `credentials_encrypted bytea` column exactly, and is fully testable locally. The versioned envelope leaves room for a later Vault-held key.
2. **`clinic_channels` is invisible to all client sessions** (no authenticated SELECT policy) rather than clinic-readable, because RLS cannot hide a single column and the row contains ciphertext. P3B's connect flow must add a reviewed non-secret read path (view or explicit-column server read) when the UI needs channel status.
3. **Email is the baseline channel** — no plan feature flag gates it (P1A plan seeds have no `email` feature key); a clinic with an allowed subscription gets an active tenant-scoped Resend channel on first email-eligible send. It does not need a WhatsApp channel row.
4. **Plan messaging limits seeded** as basic `{emails 1000, wa 0}`, pro `{emails 3000, wa 3000}`, pro_ai `{emails 5000, wa 10000}` per month. These remain operator-tunable plan data.
5. **Channel degradation on caps:** WhatsApp over its usage cap or not entitled is skipped in favor of email; if neither can send, the first blocking reason is returned.
7. **Usage is counted after a successful dispatch**; a failed counter write is Sentry-reported but does not retro-fail a message that already left. The check-then-send window is accepted (caps are economic guardrails, not hard quotas — §12-HP7's circuit-breaker layer lands with the agent phases).
8. **`sendMessage` currently has no callers** — by design. P3B (WhatsApp), P3C (inbox replies), and P3D (reminders/follow-ups) are its consumers; wiring any of them here would exceed the P3A boundary.
9. **`related_type 'invoice'`** uses the plan's §5.2 vocabulary even though invoice follow-ups arrive in P3D; the enum is fixed now so P3D adds no schema change.

## Remaining concerns

- **`MESSAGING_CREDENTIALS_KEY` must be provisioned** in Vercel (production + preview) before P3B ships the connect flow; there is no fallback key by design (fail closed). Key rotation requires re-encrypting stored rows — a small operator script can accompany P3B if needed.
- **Svix/Resend fixtures are recorded from documented formats**, not live traffic; the webhook route should be re-verified against a live sandbox event during integration.
- The remote (hosted) Supabase project does not have this migration yet; apply it with the normal deploy flow before merging-dependent work, then `pnpm db:types` can replace the hand-written type additions verbatim.

## Cycle-3 review fix touching P3A (2026-07-18)

**P3-M1 (ambiguous provider outcome).** `lib/messaging/send.ts` and `lib/messaging/types.ts` were amended so an **ambiguous** adapter result (`{ ok:false, ambiguous:true }` — a timeout or a 2xx with no message id) no longer finalizes the `outbound_messages` row as `failed`. The row stays `queued` (only its `error` note is written, under a `status='queued'` guard) and `sendMessage` returns a new `PROVIDER_SEND_AMBIGUOUS` code, so the delivery callback can still repair it via the client reference and callers do not fall back to a second channel. Definite failures are unchanged. Full write-up and the finding-by-finding evidence live in `docs/reviews/P3_PHASE_REVIEW.md` (cycle 3) and `docs/reports/P3D_IMPLEMENTATION.md` (cycle-3 addendum).

## Deferred by design (per the P3 execution split)

- P3B: 360dialog adapter, connect flow, webhook routes + signature wiring, template sync.
- P3C: inbox UI, threading, realtime, 24h-window enforcement in `send.ts`, template picker.
- P3D: cron jobs, reminders, follow-up sequences, template management UI, notification center.
- No UI, no webhook routes, no cron, and no WhatsApp code was added.
