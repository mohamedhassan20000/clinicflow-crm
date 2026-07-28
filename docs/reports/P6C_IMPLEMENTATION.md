# P6C — Meta Tech Provider Migration & Embedded Signup Onboarding — Implementation Report

**Branch:** `feat/p6c-tech-provider-migration` (implemented in-place on the current working tree)
**Plan reference:** `docs/AI_AGENT_PLAN.md` §P6C (lines 1305–1317), §P6 (§1278–1285), §5.1/§5.2, §9.2, §6.6.
**Scope:** P6C only. **No P6D work** (no Health/diagnostics page, no operator health report, no recovery actions). No review/commit/push/merge.

---

## 1. What was implemented

P6C ships the 360dialog → Meta Tech Provider migration **as a full in-product connect
experience**, not a bare adapter swap (plan rescope 2026-07-17). Five things land, all
honoring the two binding honesty rules — **no Meta review-time estimate is ever shown**
(decision states + last-checked time only), and **failure reasons come from a sanitized
mapping, never raw Meta payloads**.

### 1.1 `whatsapp-meta.ts` adapter (§5.2, §9.2)

A second `MessagingProvider` implementation behind the unchanged channel abstraction —
the interface was designed for this, so **only the adapter + connect flow are new**:

- **`send`** — WhatsApp Cloud API (`POST {graph}/{version}/{phone_number_id}/messages`,
  Bearer token). Same ambiguous-outcome classification as 360dialog (P3-M1): a timeout or
  2xx-without-id is `ambiguous` so callers never double-send on a fallback.
- **`verifySignature`** — `X-Hub-Signature-256` HMAC-SHA256 over the raw body using the
  **platform app secret** (Meta signs all traffic for our single app with one secret).
  Missing/malformed/tampered/wrong-secret → `false`, never a throw or a leak.
- **`parseWebhook`** — inbound, delivery-status, template-status **and** the P6C
  `channel_state` events (`account_update`, `account_review_update`,
  `phone_number_quality_update`, `phone_number_name_update`). Only known fields become a
  signal, so an unknown payload never invents a state.
- Graph helpers co-located (like the 360dialog adapter): `exchangeMetaSignupCode`
  (token exchange), `subscribeMetaWabaWebhook` / `getMetaWabaSubscription`, and
  `fetchMetaChannelState` (the reconciliation poll's read).

### 1.2 Connection-state machine (`connection-state.ts`, pure)

`deriveConnectionState(signals)` is a **pure, total** reduction of stored operational
signals into `connecting_to_meta → waiting_phone_verification →
business_verification_in_progress → templates_pending → connected`, plus
`verification_failed`. Every state is reachable **only from its defining signal**;
all-empty/all-unknown input yields the earliest honest state (`connecting_to_meta`) —
never fabricated progress. `templates_pending → connected` is gated on the P3B approved-
template count. `sanitizeFailureReason` collapses any raw Meta code/message to a **closed
set** of reason codes (`business_verification_rejected`, `phone_number_banned`, …,
`generic`); the UI localizes the code, so **no provider text ever reaches the client**.

### 1.3 Hybrid state refresh (`meta-reconcile.ts`)

One idempotent transition applier (`applyChannelStateSignals`) shared by both paths:

- **Webhooks** (primary signal) — `channel_state` events are merged over the stored
  columns and re-derived.
- **Reconciliation poll** — `reconcileMetaChannel` decrypts credentials, calls
  `fetchMetaChannelState`, and applies the snapshot, stamping `last_synced_at`. Runs
  **on return-from-popup**, on the **manual "Refresh status"** action, and on a
  **low-frequency cron** (`runChannelStateReconciliation`).

Idempotency is structural: the same signals over the same row derive the same state and
write nothing, so a replayed webhook or a repeated poll produces **one state and one audit
row**. **Every real connection-state transition writes exactly one clinic-scoped
`messaging:connection_state` audit row** via the new `log_messaging_event` RPC (§6.6) —
only on change, never one row per callback. Template approval changes likewise audit one
`messaging:template_status` row and re-derive the connection state. The applier also drives
`clinic_channels.status` (`connected → active`, `verification_failed → error`, else
`pending`) so `hasActiveWhatsAppChannel` never dispatches through a half-connected number.

### 1.4 In-product onboarding wizard (`/settings/messaging`)

A four-step Admin-only wizard (`whatsapp-onboarding-wizard.tsx`) on the existing surface:
**(1)** confirm clinic info (prefilled from `clinics`); **(2–3)** the **Meta-hosted
Embedded Signup popup** (Meta login + WABA/phone connection happen inside Meta's own popup —
the irreducible off-product moment; the wizard frames it, detects completion/abandonment,
and never proxies or stores Meta credentials); **(4)** completion — `completeMetaOnboarding`
exchanges the code for a token, writes the `provider=meta` channel through the P3A
encryption boundary, subscribes the webhook, and runs one reconciliation poll. Abandonment
leaves the channel resumable and honestly labeled. A progress rail shows **decision states
only** — no review-time estimate. The P3B 360dialog card is **unchanged** and both coexist.

### 1.5 Webhook routing + cron + runbook

- `app/api/webhooks/whatsapp/route.ts` routes Meta traffic when `X-Hub-Signature-256` is
  present (360dialog uses Basic auth) — both providers coexist per-clinic. Meta signature
  is verified with the app secret **before** any clinic lookup; a valid-signed but
  unroutable event is acknowledged 200 (no retry-storm), with WABA-only account events left
  to the poll. Adds the **Meta GET subscription handshake** (`hub.challenge` on an exact
  verify-token match).
- The reconciliation poll rides the **existing daily cron** as a fifth `allSettled` job
  (respecting the Vercel Hobby 2-cron ceiling, the P6B precedent) — no new cron.
- `docs/runbooks/P6C_360DIALOG_TO_META_MIGRATION.md` — per-clinic zero-message-loss
  migration runbook (prereqs, wizard, cutover, rollback).

**Migration** `20260728190000_p6c_channel_state_columns.sql`: non-secret operational
columns on `clinic_channels` (`connection_state`, `business_verification_status`,
`phone_status`, `quality_rating`, `messaging_limit_tier`, `last_synced_at`,
`last_state_reason`), stored **outside** the encrypted credential envelope; the table keeps
**zero authenticated RLS policies** (P3A design — verified by the RLS integration test).
Plus `log_messaging_event` — a service-role-only `SECURITY DEFINER` audit boundary.

---

## 2. Files changed

**New**
- `lib/messaging/connection-state.ts` — pure state machine + sanitized reason mapping.
- `lib/messaging/whatsapp-meta.ts` — Meta Cloud API adapter + Graph onboarding/poll helpers.
- `lib/messaging/meta-reconcile.ts` — idempotent transition applier, poll, cron job.
- `actions/messaging-onboarding.ts` — `completeMetaOnboarding`, `refreshMetaConnectionState`, `readMetaChannelState`.
- `components/settings/whatsapp-onboarding-wizard.tsx` — 4-step wizard.
- `supabase/migrations/20260728190000_p6c_channel_state_columns.sql` — columns + RPC.
- `docs/runbooks/P6C_360DIALOG_TO_META_MIGRATION.md` — migration runbook.
- `tests/unit/lib/p6c-connection-state.test.ts`, `tests/unit/lib/p6c-meta-adapter.test.ts`, `tests/unit/lib/p6c-meta-reconcile.test.ts`, `tests/unit/api/p6c-meta-webhook-route.test.ts`.
- `tests/fixtures/messaging/meta-*.json` — Meta webhook fixtures (inbound, account/review/quality).

**Modified**
- `lib/messaging/types.ts` — `channel_state` `WebhookEvent` kind.
- `lib/messaging/webhooks.ts` — process `channel_state` events; audit + re-derive on template change.
- `lib/messaging/channel-management.ts` — `connectMetaChannel`, `getMetaChannelState`.
- `lib/messaging/send.ts` — `ClinicChannelRow` narrowed to the selected columns (new columns not read here).
- `lib/supabase/admin.ts` — `logMessagingEvent`, `getWhatsAppChannelStateRow`, `countApprovedTemplates`, `writeWhatsAppChannelState`, `listActiveMetaChannels`.
- `lib/validations/messaging.ts` — `metaOnboardingCompletionSchema`.
- `app/api/webhooks/whatsapp/route.ts` — Meta provider path + GET handshake.
- `app/api/cron/reminders/route.ts` — 5th `allSettled` job: `runChannelStateReconciliation`.
- `app/(protected)/settings/messaging/page.tsx` — render the wizard.
- `types/database.ts` — hand-added the 7 columns + `log_messaging_event` (local regen drifts; surgical add per project convention).
- `messages/en.json`, `messages/ar.json`, `messages/action-errors/{en,ar}.json` — wizard + reason + error copy (EN/AR parity).
- `tests/unit/api/p3d-cron-routes.test.ts`, `tests/unit/lib/p3d-webhook-template-status.test.ts`, `tests/unit/ai/p46b-assistant-copy-parity.test.ts` — updated for the new cron job / template audit / nested settings copy.

---

## 3. Validation results

| Check | Command | Result |
|---|---|---|
| Typecheck | `tsc --noEmit` | ✅ clean (exit 0) |
| Lint | `eslint` on all changed source + test files | ✅ clean (0 errors, 0 warnings) |
| P6C unit suites | `vitest run` (4 P6C files) | ✅ **25/25** |
| Migration applies | `supabase migration up --local` | ✅ applied cleanly |
| Messaging RLS integration | `p3a-messaging-rls.test.ts` (live local Supabase) | ✅ passed — `clinic_channels` still has **no authenticated read policy** after the new columns |
| Webhook integration | `p3b-whatsapp-webhook.test.ts` (live local Supabase) | ✅ passed (19/19 with the RLS file) |
| Touched regressions | `p3d-cron-routes`, `p3d-webhook-template-status`, `p3b-webhook-routes`, `p3b-dialog360-adapter`, `p3b-channel-management`, `p3a-messaging-send`, `p46b-copy-parity` | ✅ all pass |
| Broad CI unit suite | `vitest run actions components db lib pages security ai api sanity` | ✅ **1831 passed** (the two initially-red tests — cron job count, template audit — were updated for the new job/audit and now pass) |

### Acceptance mapping (plan line 1316)

- *"Meta webhook signature fixtures (valid/tampered/unsigned → 401)"* → `p6c-meta-adapter.test.ts` (adapter-level valid/tampered/wrong-secret/unsigned) + `p6c-meta-webhook-route.test.ts` (route returns 401 before any processing on invalid signature).
- *"state-machine unit tests — every state reachable only from its defining signal, unknown payloads never invent a state"* → `p6c-connection-state.test.ts` (empty/unknown → `connecting_to_meta`; each transition gated on its signal; total & deterministic).
- *"hostile-payload fixture asserts no raw Meta text reaches the client"* → `meta-account-review-rejected.json` carries a hostile internal reason; adapter parse and state derivation both assert the text never survives (`sanitizeFailureReason` → closed-set code).
- *"reconciliation poll idempotent (same Graph response twice → one state, no duplicate transitions)"* → `p6c-meta-reconcile.test.ts` (two polls → `transitioned` once, one audit row).
- *"wizard abandonment leaves the channel in a resumable, honestly-labeled state"* → wizard returns to step 1 on incomplete popup; channel stays `pending`/`connecting_to_meta`.
- *"two-clinic fixture — clinic A's signup completion never touches clinic B's channel"* → `p6c-meta-reconcile.test.ts` isolation test + `connectMetaChannel`'s identity-owner preflight; scoped writes only ever target clinic A.
- *"pilot clinic migrated with zero message loss; both providers coexist"* → runbook §4 (cut over only once Meta reads `connected`; 360dialog untouched and re-activatable) + route coexistence by signature header.
- *"no review-time estimates, ever"* → wizard shows decision states + last-checked only; no ETA anywhere.

### How to run

```bash
npx vitest run tests/unit/lib/p6c-*.test.ts tests/unit/api/p6c-*.test.ts   # 25/25
supabase migration up --local                                              # applies the migration
eval "$(supabase status -o env | sed 's/^/export SB_/')"
LOCAL_SUPABASE_PUBLISHABLE_KEY="$SB_PUBLISHABLE_KEY" LOCAL_SUPABASE_SECRET_KEY="$SB_SECRET_KEY" \
  npx vitest run tests/unit/integration/p3a-messaging-rls.test.ts tests/unit/integration/p3b-whatsapp-webhook.test.ts
```

**Required environment for a live Meta connection** (documented in the runbook): `META_APP_ID`, `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN`, `NEXT_PUBLIC_META_APP_ID`, `NEXT_PUBLIC_META_CONFIG_ID` (optional `META_GRAPH_API_VERSION`). Absent these, the Meta wizard shows the honest "not enabled for this environment" placeholder and the 360dialog path remains fully functional.

---

## 4. Scope boundaries honored

- **No change to the channel abstraction interface** — adapter + connect-flow only (plan line 1313).
- **P3B 360dialog flow unchanged** — coexists; the runbook is the only thing linking to it.
- **No new cron** — reconciliation rides the existing daily cron (2-cron Hobby ceiling).
- **No P6D** — no Health page, no operator health report, no recovery actions, no activity-timeline UI (P6C only *writes* the `messaging:` audit rows the P6D timeline will later read).
- **Honesty rules honored** — decision states only (no ETA); sanitized closed-set failure reasons (no raw Meta text to the client).
- No review, commit, push, or merge performed.

---

## 5. Implementation report path

`docs/reports/P6C_IMPLEMENTATION.md`
