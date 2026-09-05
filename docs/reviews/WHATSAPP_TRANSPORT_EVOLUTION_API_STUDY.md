# ClinicFlow WhatsApp Transport and Evolution API Study

**Decision date:** 2026-08-21  
**Decision status:** Recommended architecture; no transport migration performed  
**Scope:** Product and technical architecture, provider eligibility, safe cutover, and voice-note verification

## Executive decision

Choose **Option D: a hybrid product strategy**, with this implementation decision:

- Keep ClinicFlow's current custom Baileys linked-device worker for eligible small clinics.
- Make ClinicFlow's existing direct Meta Cloud API integration the preferred official transport for larger or operationally demanding clinics.
- Retain 360dialog for existing customers and for cases where paid BSP onboarding/support is worth the extra dependency; do not make it the default while direct Meta onboarding is available.
- Do **not** add Evolution API now, for either Baileys or Meta Cloud API.

This is also **Option A for the current linked-device implementation**: keep the custom worker. Evolution's Baileys channel would replace code ClinicFlow has already hardened, while retaining most ClinicFlow-specific work around tenancy, conversations, policy, media authorization, webhook ingestion, patient linking, and product UX. Evolution's Meta channel would be an additional proxy in front of the official API that ClinicFlow already integrates directly.

The strongest current blocker is security/version posture. Evolution's latest stable release is `v2.3.7` (2025-12-05), and the audited `main` package still declares `baileys: 7.0.0-rc.9`. That version is in the affected range of critical advisory **CVE-2026-48063 / GHSA-qvv5-jq5g-4cgg**; the patched Baileys releases are `6.7.22` and `7.0.0-rc12`. ClinicFlow pins `baileys: 6.7.24`, which is beyond the patched 6.x boundary. This finding is a dated source snapshot, not a claim that Evolution will remain behind. [Evolution package](https://github.com/evolution-foundation/evolution-api/blob/main/package.json), [GitHub advisory](https://github.com/advisories/GHSA-qvv5-jq5g-4cgg), [Evolution releases](https://github.com/evolution-foundation/evolution-api/releases)

No deployment, provider migration, session reset, QR logout, or connection-flow refactor was performed as part of this study.

## Decision summary

| Question | Answer |
|---|---|
| Is Evolution API technically capable? | Yes. It is a substantial multi-instance WhatsApp gateway with Baileys and Meta channels, persistence, webhooks, media, and event-bus integrations. |
| Does Evolution impose a 100-clinic/patient/session limit? | No documented limit. Its Community tier states no message, instance, or feature limits. The proposed 100-active-patient threshold is a ClinicFlow business/risk policy only. |
| Does Evolution Baileys remove ClinicFlow's Baileys maintenance? | It transfers most protocol work to Evolution, but does not eliminate it. ClinicFlow would now track Evolution releases, their Baileys pin, webhook contract, storage schema, operational defects, and security response. |
| Does Evolution Meta add meaningful capability over ClinicFlow direct Meta? | Not enough to justify another stateful control plane and data processor. It wraps the same official platform and ClinicFlow would still own product policy and domain ingestion. |
| Is direct Meta the scalable destination? | Yes. Meta operates the transport/session plane; ClinicFlow retains its provider-neutral domain model and webhook pipeline. |
| Is 360dialog still useful? | Yes, where BSP support/onboarding is valuable. It adds a per-number platform fee and vendor dependency, so it should be an explicit commercial choice. |
| Was the voice-note pipeline defective? | Yes. A nonempty but effectively silent WebM recording transcoded successfully and was accepted. A narrow validation fix was made and tested. |

## Scope and evidence standard

The repository was treated as the source of truth for ClinicFlow behavior. Evolution claims below were checked against its current documentation, current repository source, current package manifest, release history, and selected current issue reports. Issue reports are used only as operational signals, not proof that every installation is affected.

“Evolution Cloud API” in this document means **Evolution API's `WHATSAPP-BUSINESS` channel wrapping Meta's official Cloud API**, not Evolution's separately hosted commercial service.

The provider landscape can change quickly. Re-run the dated checks—especially Baileys security, Evolution stable versions, licensing, Meta policies, and 360dialog prices—before approving a future migration.

## ClinicFlow baseline

ClinicFlow already has a provider-neutral application boundary:

```text
reminders / inbox / AI / notifications
                 |
        lib/messaging/send.ts
                 |
    +------------+-------------+
    |            |             |
linked_device   meta       dialog360
    |            |             |
custom worker  Graph API   360dialog API
```

The application currently supports exactly three WhatsApp provider values: `linked_device`, `meta`, and `dialog360`. `resolveActiveChannels` and the database activation function enforce one selected WhatsApp transport per clinic. The same conversation/message domain is reused across providers.

No fourth WhatsApp provider is currently supported by ClinicFlow. Adding Twilio, another BSP, or an automation platform would require a new adapter, provisioning flow, credential model, webhook verifier, billing/support policy, and migration path. None offers a missing capability strong enough to justify that work today: direct Meta covers the official low-dependency path and 360dialog already covers the managed-BSP path.

### What the custom linked-device worker already owns

- QR-based multi-device pairing and durable encrypted auth state.
- One live Baileys socket per connected clinic inside the worker process.
- Restore, reconnect, heartbeat ownership, stale-owner adoption, and logout/start race protection.
- `messaging-history.set` ingestion with `syncFullHistory`, bounded text history, durable Postgres spool, idempotency, retries, and explicit `complete` / `partial` / `unavailable` outcomes.
- Contact/name persistence and LID-to-phone mapping only when WhatsApp asserts the relationship; it never interprets opaque LID digits as phone numbers.
- Inbound message, receipt, image, and document handling.
- Private-bucket outbound media references, clinic-scoped authorization, MIME sniffing, and bytes fetched inside the worker rather than placed in the 64 KiB API body.
- Sent-message cache for Baileys `getMessage` retry repair.
- Signed callbacks, restricted logging, session encryption, tenant scoping, and active/passive worker ownership.

This is not yet documented as horizontally load-balanced socket ownership. The current topology is intentionally one active worker owner per session/deployment with heartbeat-based failover. Scaling it safely requires explicit sharding or a lease-aware session scheduler, not simply adding replicas behind a load balancer.

### What stays ClinicFlow-owned under every provider

- Clinic identity, patient matching/linking, conversations, messages, inbox behavior, AI state, reminders, and notification policy.
- Provider eligibility and the 24-hour/template policy shown to users.
- Exactly-one-active-provider enforcement.
- Webhook verification, replay/idempotency, media authorization, durable ingestion, observability, and audit controls.
- Product onboarding, upgrade messaging, migration state, and support tooling.

## Provider comparison

### Product and protocol behavior

| Capability | Custom Baileys worker | Evolution + Baileys | Evolution + Meta Cloud | Direct Meta Cloud | 360dialog |
|---|---|---|---|---|---|
| Onboarding | QR in ClinicFlow | REST create/connect, QR/base64/pairing code | Meta credentials/onboarding through Evolution | Embedded Signup, coexistence flow where eligible, or manual app credentials | 360dialog integrated onboarding / Hub |
| Keeps normal phone app | Yes; linked device | Yes; linked device | Standard Cloud registration: generally no. Coexistence can retain the Business app when eligible | Same | Same official-platform rules |
| Multiple clinics | One session per clinic, ClinicFlow-owned | One Evolution instance per clinic | One Evolution instance per number | One provider channel per clinic/number | One channel/API key per number |
| Session persistence | Encrypted auth rows in ClinicFlow | Provider files, Redis, or Prisma auth state | Meta owns messaging session; Evolution stores access/config state | Meta owns it; ClinicFlow stores encrypted credentials | Meta/360dialog own it; ClinicFlow stores API key/config |
| Reconnect | ClinicFlow bounded lifecycle and ownership checks | Source reconnects most close reasons immediately; no owner lease/backoff was found in the audited path | Official API; no Baileys socket | Official API | Official API through BSP |
| Existing chat history | Text history when phone provides it; durable import semantics | `syncFullHistory`, DB persistence, `MESSAGES_SET`, and history handler; volume still determined by WhatsApp | No general linked-device history. A separate coexistence onboarding flow can provide limited initial context and needs explicit implementation | Same | Same official-platform behavior |
| Contacts | Phone sync/contact events | Contact set/upsert/update and optional DB persistence | Webhook contacts are participants, not a phone address-book sync | Same | Same |
| LID/PN | Explicit safe directory and PN fallback | Current source includes LID mapping; recent releases and issues show continuing churn | Official `wa_id` / phone number model | Official `wa_id` / phone number model | Official model |
| Text/media/voice | Text, images, documents, browser voice-note normalization | Broad text/media/audio endpoints and optional S3 | Broad Evolution facade over Meta | Meta supports text, templates, audio, images, documents, video | Meta-compatible messaging API |
| ClinicFlow media today | Linked-device media enabled | Requires a new Evolution adapter and security model | ClinicFlow Cloud provider policy currently disables media | Currently disabled by ClinicFlow provider policy | Currently disabled by ClinicFlow provider policy |
| Receipts/status | Baileys updates mapped into ClinicFlow | Message updates and receipt events/webhooks | Meta statuses through Evolution | `wamid` status webhooks | Meta-compatible statuses |
| Provider message identity | Baileys stanza ID plus ClinicFlow idempotency | Raw Baileys keys/IDs in Evolution event envelopes | Meta message IDs through Evolution envelope | Stable `wamid` returned by Graph API and status webhooks | Meta-compatible IDs |
| Official policy | Unofficial WhatsApp Web automation risk | Same | Official Business Platform rules | Official Business Platform rules | Official Business Platform rules |
| 24-hour/template restrictions | Not imposed by Cloud API | Not imposed by Cloud API | Yes | Yes | Yes |
| Primary failure domain | ClinicFlow worker/Baileys/WhatsApp Web | Evolution process + DB/cache + Baileys/WhatsApp Web | Evolution + Meta | Meta + ClinicFlow adapter | Meta + 360dialog + ClinicFlow adapter |

Meta's official collection confirms Cloud API is Meta-hosted, supports text/media/templates, returns a `wamid`, and reports sent/delivered/read/failed status through webhooks. [Meta official Cloud API collection](https://www.postman.com/meta/whatsapp-business-platform/collection/wlk6lh4/whatsapp-cloud-api), [messages](https://www.postman.com/meta/whatsapp-business-platform/folder/o48mro7/messages), [status notifications](https://www.postman.com/meta/whatsapp-business-platform/request/rgtfq23/message-status-update-notifications)

### Ownership, operations, and cost

| Dimension | Custom Baileys | Evolution + Baileys | Evolution + Meta | Direct Meta | 360dialog |
|---|---|---|---|---|---|
| Protocol maintenance | ClinicFlow tracks Baileys | Evolution tracks most integration work; ClinicFlow tracks Evolution's lag/contract | Evolution tracks Graph facade | ClinicFlow tracks Graph API versions | 360dialog tracks facade; ClinicFlow tracks BSP contract |
| Stateful infrastructure | Worker + existing ClinicFlow DB/storage | Evolution API + PostgreSQL/MySQL + usually Redis + optional S3/queue | Same Evolution control plane even though Meta owns transport | Existing web/API + DB/secret storage | Existing web/API + DB/secret storage |
| Horizontal scaling | Not currently load-balanced; explicit ownership/failover | Not proven for active Baileys sockets. Official Swarm example uses one replica | REST tier is more scalable, but Evolution remains an extra hop/state store | Stateless API/webhook consumers can scale conventionally | Same, subject to BSP limits |
| Failure isolation | Sessions share a worker process; ownership rows isolate restarts | Instances are objects in one Node process; process/DB/Redis failures can affect many | Evolution outage affects all routed official traffic | Removes self-hosted transport gateway | Adds BSP-wide failure/dependency |
| Direct platform fee | Infrastructure only | Infrastructure + operations | Infrastructure + Meta usage | Meta usage | Per-number subscription + Meta usage |
| Vendor lock-in | Baileys/WhatsApp Web behavior | Evolution API contract, schema, operational model, and trademark/activation services | Evolution plus Meta | Meta Graph API and app review | 360dialog API/Hub/billing plus Meta |
| Support | ClinicFlow engineering | Community unless paid Evolution support/managed service | Same | Meta partner/business support path | Paid plan support |

360dialog's current client pricing lists a per-number monthly subscription—currently 49 EUR / 59 USD regular, 99 EUR / 119 USD premium, and 249 EUR / 299 USD high-throughput—plus Meta usage. Partner contracts can price differently, so commercial terms must be obtained for ClinicFlow rather than inferred from the public table. [360dialog current pricing](https://docs.360dialog.com/docs/pricing)

## Evolution API source audit

### Architecture and instance lifecycle

Evolution is a Node/TypeScript/Express service with Prisma, Postgres/MySQL, Redis/local cache, optional S3/MinIO, and several event transports. It supports `WHATSAPP-BAILEYS`, `WHATSAPP-BUSINESS`, and an Evolution channel. An instance is created over REST with a name, integration, optional token/number, webhook settings, and `qrcode: true`; the response includes connection status and QR raw/base64 data. [Create Instance](https://docs.evolutionfoundation.com.br/en/evolution-api/create-instance)

The current Baileys service:

- Selects auth persistence from a provider-files backend, Redis when `CACHE_REDIS_SAVE_INSTANCES` is enabled, or Prisma when instance persistence is enabled.
- Saves credentials on `creds.update`.
- Creates a WASocket per active instance, fetches the current WhatsApp Web version, uses a database-backed `getMessage`, sets a 350 ms retry delay and four message retries, and optionally enables full history.
- Serializes event work through an instance-level promise queue.
- Generates QR images and pairing codes, enforces a configured QR count, and prints QR/session information to the terminal log.
- Reconnects on most socket closures by directly calling `connectToWhatsapp` again. No exponential reconnect backoff or distributed session-owner lease was found in this audited path.

[Current Baileys service source](https://github.com/evolution-foundation/evolution-api/blob/main/src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts)

### Messages, history, contacts, media, and LID behavior

Evolution has broad surface coverage: chats, contacts, message upserts/updates/deletes, receipts, groups, media download/reupload, audio conversion, S3/MinIO storage, and events to webhooks or queues. Environment controls allow persistence of instances, new messages, message updates, contacts, chats, history, labels, and WhatsApp-number checks. [Current environment example](https://github.com/evolution-foundation/evolution-api/blob/main/env.example)

Its history handler consumes `messaging-history.set`, receives chats/contacts/messages plus progress, can store them in Prisma, and emits downstream events. This is useful, but it does not make history complete: the paired phone/WhatsApp protocol still decides what is sent. ClinicFlow would also need to map Evolution history batches into its existing durable import semantics and preserve its no-side-effects rules for historical messages.

The latest source has LID/PN logic (including Baileys' signal-repository mapping and alternate JIDs), and release notes show repeated LID fixes. Current issue reports still describe LID-related missing inbound events, audio, presence, and delivery behavior. Those reports are evidence of protocol churn, not a measured defect rate. [LID tracking issue](https://github.com/evolution-foundation/evolution-api/issues/1872), [current inbound webhook report](https://github.com/evolution-foundation/evolution-api/issues/2647)

### Webhook delivery and security

Evolution supports per-instance/global webhook event selection, per-event URLs, retries, arbitrary configured headers, and an optional generated bearer JWT when a `jwt_key` header is configured. Supported events include QR, connection, message set/upsert/update/delete, send, contacts, chats, groups, presence, and labels. [Webhook documentation](https://docs.evolutionfoundation.com.br/evolution-api/configuration/webhooks)

Important ClinicFlow security gaps in the audited current source:

- No body-bound HMAC signature or timestamp/replay contract was found in the webhook controller. A bearer/custom header authenticates the sender but does not cryptographically bind the body or prevent replay by itself.
- The outgoing webhook envelope includes an `apikey` field. A global/instance credential must never be propagated into ClinicFlow logs or domain events.
- The current Baileys source contains direct `console.log` calls for raw message objects and, for on-demand history, entire message arrays. That is unacceptable for clinic PHI unless removed or proven unreachable under a reviewed build.
- QR/pairing details are printed to terminal logs.
- Session credentials are persisted as provider files, Redis data, or Prisma JSON. No ClinicFlow-equivalent application-level AES-GCM envelope was found in the audited auth path. Database/disk encryption is not a substitute for per-secret envelope encryption.
- Evolution's REST API uses a high-privilege API key, with optional per-instance tokens. It would need private networking, ingress ACLs, rate limiting, rotation, strict tenant-to-instance authorization, and secrets-manager storage.

ClinicFlow could build a hardened adapter around these issues, but doing so erodes the expected maintenance savings.

### Storage and scaling

Evolution can persist operational data in Postgres/MySQL, cache/store instances in Redis, place media in S3/MinIO, and publish events through webhook, WebSocket, RabbitMQ, SQS, Kafka, NATS, or Pusher. That is a capable general gateway, but ClinicFlow needs only a narrow WhatsApp transport.

No trustworthy per-connected-instance CPU/RAM benchmark or hard instance capacity was found. The NVM guide recommends a server with at least 4 GB available for Evolution API, but that is not a per-instance sizing guarantee. A future proof of concept would need 10/50/100-session soak tests measuring idle RSS, reconnect CPU, history-sync peaks, DB write amplification, Redis size, media bandwidth, event lag, and blast radius. [Evolution NVM guide](https://docs.evolutionfoundation.com.br/evolution-api/install/nvm)

The official Swarm example declares `replicas: 1`. Redis and Postgres make state shareable, but live Baileys sockets remain in-process. No distributed owner election or session sharding contract comparable to ClinicFlow's worker ownership rows was found. Horizontal API scaling must therefore be considered **unproven for active Baileys sessions**, not impossible. [Official Swarm example](https://github.com/evolution-foundation/evolution-api/blob/main/Docker/swarm/evolution_api_v2.yaml)

### License, maturity, and release posture

Evolution source declares Apache-2.0. Its current licensing documentation says Community is free, self-hosted, and has no instance/message/feature limits. Starting with 2.4.0, activation collects operator email/phone, version, a generated installation ID, server IP, aggregate message counters, and enabled-feature names; periodic heartbeat is part of the supported branded product. It states that message content, contacts, media, tokens, and private configuration are not collected. [Licensing and telemetry](https://docs.evolutionfoundation.com.br/en/licensing/index)

There is an important maturity boundary:

- Latest stable shown by the project: `v2.3.7`, released 2025-12-05.
- 2.4.0 is documented/released as an RC validation line with activation behavior and should not be assumed production-stable.
- Stable/main currently pins the vulnerable Baileys RC described in the executive decision; a patched dependency exists on later development work but is not the stable package audited here.
- The repository is active and has a large community, but the gap between current stable and current protocol/security fixes is material for healthcare messaging.

This is a **“re-evaluate after release gates”** position, not a permanent rejection. Evolution becomes a plausible candidate after a stable release pins a patched supported Baileys, removes PHI/credential logging, documents webhook authenticity/replay protection, and demonstrates safe multi-replica socket ownership.

## What Evolution would replace—and what it would not

| ClinicFlow layer | Evolution + Baileys effect | Still required in ClinicFlow |
|---|---|---|
| WASocket construction and QR generation | Replaced | Evolution instance provisioning adapter and product QR/status UI |
| Auth-state serialization | Replaced by Evolution backend | Encryption posture, tenant mapping, backup/restore policy, credential deletion audit |
| Reconnect/session process | Replaced | Ownership model, capacity planning, health/recovery UX, incident response |
| Baileys event normalization | Mostly replaced | Evolution envelope parser, versioned contract, dedupe, patient identity rules |
| History parsing/persistence | Partly replaced | ClinicFlow conversation import, idempotency, completion semantics, no-automation rules |
| Contacts/LID mapping | Partly replaced | Patient-safe resolution, conflict policy, durable linking, UI |
| Media fetch/transcode | Potentially replaced | Clinic authorization, private storage policy, scanning, retention, inbox records |
| Outbound send | Replaced at transport call | Provider router, service-window/template policy, outbox/idempotency, audit |
| Signed worker callbacks | Not equivalently replaced | HMAC/replay layer or a private authenticated event bus |
| ClinicFlow conversations/messages | Not replaced | Entire domain model and UI |
| Meta and 360dialog adapters | Not replaced | Keep unless deliberately migrated |

For Evolution + Meta, only the provider call/webhook facade changes. Meta still owns the official transport, and nearly every ClinicFlow-owned row above remains. That is why Evolution's Meta channel has the weakest value proposition here.

## Provider eligibility policy

### Metric and threshold

Start with a clear product policy:

```text
whatsapp_linked_device_max_active_patients = 100
```

Store it in ClinicFlow's existing plan/capability limits, with an operator override and audit trail. Do not hard-code it in the worker and do not present it as an Evolution or WhatsApp technical limit.

For the first release, define **active patient** as a patient belonging to the clinic who is active and not soft-deleted/archived. This is explainable and queryable. It is only an admission/risk proxy: a clinic with 30 patients can send more WhatsApp traffic than one with 300 patients.

Add monitoring metrics without making them initial hard gates:

- Unique WhatsApp conversations in rolling 30 and 90 days.
- Inbound/outbound messages over rolling 30 days and peak hourly rate.
- Media bytes, history-import size, reconnect frequency, and delivery failure rate.
- Number of sessions per worker and per-session memory.

After enough production data, replace or supplement the census threshold with a “messaging-active patients in 90 days” measure. Do not use total patient rows; it punishes clinics for historical/archived records and correlates poorly with socket load.

### Eligibility states

| State | Rule | Product behavior |
|---|---|---|
| `eligible` | `< 80` active patients | QR option available |
| `approaching_limit` | `80–99` | QR available; explain official upgrade path |
| `migration_required` | `>= 100` and already linked | Keep running and reconnecting; persistent warning and guided migration CTA |
| `official_only` | `>= 100` and no valid existing linked identity | Do not issue a new QR; offer direct Meta and, where applicable, 360dialog |
| `override` | Time-bounded support exception | QR permitted with reason, actor, expiry, and audit event |

Crossing the threshold must **never automatically disconnect**, log out, delete auth, clear a session, or switch a provider. An existing linked session is grandfathered and automatic recovery remains allowed. If its auth is deliberately logged out/revoked and a fresh pairing is required, the current eligibility policy applies.

This protects small-clinic simplicity while making the official platform the long-term path for higher-value, higher-volume clinics.

## Safe provider cutover

ClinicFlow must preserve one active WhatsApp transport per clinic at every point. Meta's coexistence feature may technically permit the Business app and Cloud API together, but ClinicFlow should still have one outbound/inbound authority.

Use a user-confirmed, scheduled state machine:

1. **Assess** — show policy, Cloud API restrictions, billing, templates, history limitations, and whether Meta coexistence is available. Do not alter the linked session.
2. **Prepare pending official channel** — complete business/account authorization and store credentials in `pending`; do not activate outbound sends. Some Meta onboarding actions can change number registration, so the UI must identify the exact irreversible step before it happens.
3. **Preflight** — verify WABA/phone identity, webhook subscription, template state, permissions, and sender uniqueness without sending a production message.
4. **Schedule and freeze** — user explicitly starts cutover; pause new outbound jobs/AI sends for that clinic and drain or cancel the old outbox deterministically.
5. **Checkpoint** — record old provider, last provider message IDs/timestamps, pending jobs, and rollback metadata. Keep conversation rows unchanged.
6. **Quiesce old transport** — stop ClinicFlow routing and close the live worker socket without deleting its stored identity. This is a migration action the user confirms, not an automatic threshold action.
7. **Atomically activate** — use the existing activation RPC so the official provider becomes active and every other WhatsApp provider is non-active in the same transaction.
8. **Verify** — run a controlled inbound message, outbound service-window reply, receipt, and permitted media/template test. Resume jobs only after success.
9. **Finalize** — after an explicit cooling-off period, ask the clinic whether to remove the old linked-device identity. Never silently log it out.

There is no honest guarantee of zero interruption when moving the same number between WhatsApp product modes. Rollback is easy before the irreversible Meta number-registration step; after it, returning to linked-device may require a new phone-app setup and QR. The UI and runbook must say this plainly.

## Recommended UX

Keep the existing two-card model and make the distinction product-led:

### Connect with QR

- Label: **Quick connection for small clinics**.
- Explain that it links ClinicFlow as a device, keeps the phone app, has no Meta template onboarding, and is intended below the plan's active-patient threshold.
- Show current active-patient count, policy limit, and operational status.
- At 80%, show an amber “plan your official connection” notice.
- Above the threshold, never disconnect an existing clinic. Show `Migration required for the next new connection` and a guided upgrade action.
- If no existing identity is valid above the limit, disable “Generate QR” and link directly to official onboarding.

### WhatsApp Business Platform

- Label: **Official connection for growing clinics** and mark it recommended for scale/reliability.
- Explain the service window, template approval, Meta billing, business verification, and history differences before onboarding.
- Prefer direct Meta in the primary flow.
- Put 360dialog behind “Need managed onboarding/support?” or retain it as a legacy/admin choice rather than a third equal card.

Do not expose “Evolution API” as a clinic-facing provider. It is infrastructure, not a product choice customers should need to understand.

## Voice-note defect and narrow fix

### Confirmed pre-fix behavior

The browser path is correct in shape:

```text
MediaRecorder
  -> WebM/Opus (Chrome) or MP4/AAC (Safari)
  -> private storage reference
  -> worker ffmpeg
  -> OGG/Opus
  -> Baileys { audio, mimetype: "audio/ogg; codecs=opus", ptt: true }
```

The defect was validation, not the `ptt` send shape. The worker accepted any ffmpeg exit code `0` with nonzero output bytes.

Reproduction with local ffmpeg/ffprobe 9.0.1:

- A 1.25 s 440 Hz WebM/Opus recording became OGG/Opus, 48 kHz, mono, about 1.2565 s, with audible peak near -17.6 dBFS.
- A 1.25 s silent WebM/Opus recording also exited successfully and produced a nonempty OGG/Opus file, with peak near -90.3 dBFS.
- The old worker would send both as successful voice notes. This matches a plausible “delivered but inaudible” symptom.

### Fix applied

Only `services/whatsapp-worker/src/outbound-media.ts` and focused tests were changed:

- Force WhatsApp-compatible Opus output to 48 kHz mono.
- Use `ffprobe` over a pipe to require an Opus audio stream, 48 kHz sample rate, and one channel.
- Use ffmpeg `astats` over a pipe to require nonzero decoded samples/duration and reject effectively silent output at or below -80 dBFS peak.
- Keep bounded output, diagnostic buffers, timeouts, no shell interpolation, and no shared temporary filenames.
- Keep the existing Baileys send shape with `ptt: true` unchanged.

Focused type checking and ten voice/media tests pass, including real WebM/Opus generation, OGG/Opus conversion, stream inspection, nonzero decoded samples, audible acceptance, and silent rejection.

## Conditions that would justify revisiting Evolution

Run a time-boxed proof of concept only after all of these gates are met:

1. A stable Evolution release uses a Baileys version outside all current critical advisory ranges.
2. Raw messages, history contents, API keys, QR codes, and pairing codes are absent from production logs.
3. Webhooks have a documented body-bound signature, timestamp, replay protection, and credential-rotation story—or delivery occurs over a private authenticated queue.
4. Session secrets have an accepted encryption-at-rest design.
5. Multi-replica ownership is documented and chaos-tested so one session cannot be live in two pods.
6. A compatibility suite proves ClinicFlow behavior for QR rotation, reconnect, logout races, LID/PN, history completeness states, contacts, message IDs, receipts, media, voice, retries, and provider activation.
7. A 10/50/100-session soak test produces acceptable resource and failure-isolation numbers.
8. The migration removes more maintained code/risk than the adapter, webhook, data-processing, and operations it adds.

Until then, Evolution is useful reference implementation and a potential future gateway, but not a justified replacement for ClinicFlow's current worker.

## Source ledger

Primary/current sources used:

- [Evolution API repository](https://github.com/evolution-foundation/evolution-api)
- [Evolution current package manifest](https://github.com/evolution-foundation/evolution-api/blob/main/package.json)
- [Evolution Baileys service](https://github.com/evolution-foundation/evolution-api/blob/main/src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts)
- [Evolution environment reference](https://github.com/evolution-foundation/evolution-api/blob/main/env.example)
- [Evolution Create Instance](https://docs.evolutionfoundation.com.br/en/evolution-api/create-instance)
- [Evolution webhook documentation](https://docs.evolutionfoundation.com.br/evolution-api/configuration/webhooks)
- [Evolution licensing/telemetry](https://docs.evolutionfoundation.com.br/en/licensing/index)
- [Evolution releases](https://github.com/evolution-foundation/evolution-api/releases)
- [Evolution official Swarm example](https://github.com/evolution-foundation/evolution-api/blob/main/Docker/swarm/evolution_api_v2.yaml)
- [Baileys critical advisory](https://github.com/advisories/GHSA-qvv5-jq5g-4cgg)
- [Meta official WhatsApp Business Platform collection](https://www.postman.com/meta/whatsapp-business-platform/overview)
- [Meta official Cloud API collection](https://www.postman.com/meta/whatsapp-business-platform/collection/wlk6lh4/whatsapp-cloud-api)
- [Meta official webhook subscriptions](https://www.postman.com/meta/whatsapp-business-platform/folder/ozgs3jn/webhook-subscriptions)
- [Meta platform pricing](https://business.whatsapp.com/products/platform-pricing)
- [360dialog messaging API](https://docs.360dialog.com/partner/messaging-and-calling/waba-integration)
- [360dialog webhook delivery behavior](https://docs.360dialog.com/partner/messaging/sending-and-receiving-messages/receiving-messages-via-webhook)
- [360dialog current pricing](https://docs.360dialog.com/docs/pricing)

Repository evidence reviewed includes `lib/messaging/provider.ts`, `lib/messaging/send.ts`, `lib/messaging/provider-policy.ts`, the three WhatsApp adapters, channel activation migrations, linked-device migrations, worker source/tests, settings UI, and prior Phase 8 review reports.
