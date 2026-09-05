# P6C — Per-clinic 360dialog → Meta Tech Provider migration runbook

**Audience:** ClinicFlow operations / support. **Goal:** move one clinic off the
360dialog BSP onto the Meta-direct channel with **zero message loss**, while both
providers coexist per-clinic during the transition. The P3B 360dialog flow is
**unchanged** and remains the path for un-migrated clinics.

> Honesty rules (binding): never quote a Meta review-time estimate — only decision
> states and last-checked time. Failure reasons shown to clinics come from the
> sanitized mapping (`lib/messaging/connection-state.ts`), never raw Meta payloads.

---

## 0. One-time platform prerequisites (before any clinic migrates)

Complete Meta Business verification → Tech Provider → Embedded Signup approval
(paperwork started at P3 time, §5.1/§12-HP2). Then set these environment variables:

| Variable | Where | Purpose |
|---|---|---|
| `META_APP_ID` | server | OAuth token exchange |
| `META_APP_SECRET` | server | token exchange **and** `X-Hub-Signature-256` verification |
| `META_WEBHOOK_VERIFY_TOKEN` | server | GET subscription handshake on `/api/webhooks/whatsapp` |
| `NEXT_PUBLIC_META_APP_ID` | client | Embedded Signup popup (`FB.init`) |
| `NEXT_PUBLIC_META_CONFIG_ID` | client | Embedded Signup configuration id |
| `META_BUSINESS_ID` | server | verifies that the returned WABA is shared with ClinicFlow |
| `META_SYSTEM_USER_ID` | server | system user assigned to the clinic WABA |
| `META_SYSTEM_USER_ACCESS_TOKEN` | server | debug/management/Cloud API token stored through the encrypted channel boundary |
| `META_PHONE_REGISTRATION_PIN` | server | six-digit PIN used for the required phone registration call |
| `META_GRAPH_API_VERSION` | server (optional) | pins the Graph version (default `v23.0`) |

Register the webhook callback URL `https://<domain>/api/webhooks/whatsapp` in the
Meta app with the verify token above; confirm the GET handshake returns the
challenge. Subscribe the app to the `whatsapp_business_account` object fields:
`messages`, `message_template_status_update`, `account_update`,
`account_review_update`, `phone_number_quality_update`, `phone_number_name_update`.

Apply migrations `20260728190000_p6c_channel_state_columns.sql` and
`20260728220000_p6c_review_fixes.sql`.

---

## 1. Pre-migration checks (per clinic)

1. Confirm the clinic is on `pro_ai`/entitled for WhatsApp.
2. Note the current 360dialog channel: `clinic_channels` row (`provider=dialog360`,
   `status=active`) and its `sender_identity` (phone_number_id).
3. Confirm the WhatsApp number is eligible for Embedded Signup (not active on a
   personal/Business-app WhatsApp, or ready to migrate).
4. Advise the clinic that during the number port there is a short window where the
   old BSP registration is torn down before the Meta registration completes — plan
   it in a low-traffic period. Inbound during the gap is retried by WhatsApp.

## 2. Run the in-product wizard (clinic Admin)

On **Settings → Messaging**, the Meta card ("WhatsApp Business (Meta)") appears
once the env above is set. The Admin:

1. **Step 1** — confirms clinic info (prefilled from `clinics`).
2. **Steps 2–3** — completes the **Meta-hosted Embedded Signup popup** (Meta login +
   WABA/phone connection happen entirely inside Meta's popup). ClinicFlow never sees
   the Meta password.
3. **Step 4** — on popup completion the wizard calls `completeMetaOnboarding`, which
   treats the exchanged OAuth token only as an asset claim, validates it with
   `debug_token`, verifies that the WABA is shared with ClinicFlow, assigns and
   verifies the platform system user, fetches the selected phone from the WABA,
   registers it, subscribes and verifies the app webhook, then stores the
   system-user credential through the encrypted channel boundary and reconciles.

The channel starts `status=pending`, `connection_state=connecting_to_meta`, and
**sends stay gated** until reconciliation derives `connected`. The 360dialog channel
is untouched, so the clinic keeps sending on the old provider until the switch.

## 3. Verify the Meta channel is healthy

Watch the wizard's connection-state rail advance:
`connecting_to_meta → waiting_phone_verification → business_verification_in_progress
→ templates_pending → connected`. Use **Refresh status** to force a reconciliation
poll. State refresh is hybrid: Meta webhooks (primary), plus the return-from-popup
poll, the manual refresh, and the daily cron (`runChannelStateReconciliation`).

Re-submit templates on the Meta channel. Provider-specific approvals are retained
in `message_template_provider_bindings`, so the 360dialog approval remains available
for rollback. Reconciliation also imports matching pre-approved Meta templates.
`templates_pending → connected` flips only when this WABA has an approved binding.

## 4. Cut over (zero message loss)

1. Do not manually change rows. The atomic state-transition RPC activates Meta and
   demotes 360dialog in the same database transaction only when Meta derives
   **connected** (verified phone, approved account review, verified webhook
   subscription, and an approved template binding for this WABA).
2. Confirm the retained 360dialog row and encrypted credential envelope still
   exist with `status=pending`; this is the rollback path.
3. Confirm a real inbound and a real outbound message succeed on Meta.

## 5. Rollback

If Meta verification fails (`connection_state=verification_failed` with a sanitized
reason) the atomic state transition automatically restores the retained 360dialog
row. For a manual rollback, reconnect the existing 360dialog credentials through
the unchanged Settings flow; `activate_whatsapp_provider` switches the active row
without deleting the Meta row or either encrypted credential envelope.

## 6. Post-migration

- Confirm the P6B messaging cost dashboard and delivery-failure alerting read the
  Meta channel's `outbound_messages` as before (provider column now `meta`).
- The daily reconciliation cron keeps `last_synced_at` fresh and audits any state
  transition as a `messaging:connection_state` row (the P6D activity timeline source).
