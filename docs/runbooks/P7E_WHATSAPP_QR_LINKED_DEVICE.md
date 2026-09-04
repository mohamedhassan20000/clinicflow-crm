# P7E — WhatsApp "Connect with QR" (Linked Devices)

A clinic can now connect the WhatsApp number they already use by scanning a QR
code inside ClinicFlow, exactly the way WhatsApp Web is linked. This runbook
covers what has to exist for that to work in production.

The other method — "Connect with Meta API", where a clinic supplies its own
Cloud API credentials — is unchanged and independent. A clinic uses one or the
other; the two cards defer to each other and the database keeps exactly one
active WhatsApp transport per clinic.

## What was added

| Piece | Where |
| --- | --- |
| Pairing service (one always-on Node process) | `services/whatsapp-worker/` |
| Provider adapter + worker client | `lib/messaging/whatsapp-linked-device.ts`, `lib/messaging/linked-device.ts` |
| Inbound callback | `app/api/webhooks/whatsapp/linked-device/route.ts` |
| Server actions | `actions/messaging-linked-device.ts` |
| UI | `components/settings/whatsapp-qr-connect-card.tsx` |
| Schema | `supabase/migrations/20260817120000_*`, `20260817121000_*` |

## Why a separate service

A linked device is a long-lived authenticated websocket to WhatsApp. The
application runs on Vercel, where no process is guaranteed to outlive a request:
a socket opened in a route handler is torn down mid-handshake and the clinic
would be asked to scan again constantly. The socket therefore lives in a worker
on a platform that supports always-on processes (Fly.io, Railway, Render, a small
VM, or any container host). The application never opens a WhatsApp socket.

## Migrations

Two files, in order. They are split because Postgres will not let a value added
by `ALTER TYPE` be *used* in the same transaction:

1. `20260817120000_p7e_linked_device_provider_enum.sql` — adds `linked_device` to
   `public.messaging_provider`.
2. `20260817121000_p7e_whatsapp_linked_device.sql` — widens the channel/provider
   check and `activate_whatsapp_provider`, and creates
   `whatsapp_linked_device_sessions` (one row per clinic; coarse status and the
   current pairing code) and `whatsapp_linked_device_auth` (the encrypted device
   identity). Both new tables have RLS enabled with **zero** policies —
   service-role only, exactly like `clinic_channels`.

```bash
supabase db push          # remote
supabase db push --local  # local
pnpm db:types             # only if you regenerate; the types are hand-maintained here
```

## Environment

### Application (Vercel)

| Variable | Notes |
| --- | --- |
| `WHATSAPP_WORKER_URL` | Origin of the worker. HTTPS everywhere except a loopback worker in local dev. |
| `WHATSAPP_WORKER_TOKEN` | Bearer token the app presents to the worker. ≥32 chars. |
| `WHATSAPP_WORKER_CALLBACK_SECRET` | HMAC secret the worker signs inbound callbacks with. ≥32 chars. |

Leave all three unset and the QR card renders as unavailable. The Meta API method
is unaffected.

### Worker

`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `MESSAGING_CREDENTIALS_KEY`,
`WHATSAPP_WORKER_TOKEN`, `WHATSAPP_WORKER_CALLBACK_SECRET`, `CLINICFLOW_APP_URL`,
`PORT`, optional `WORKER_ID` / `LOG_LEVEL`. See
`services/whatsapp-worker/.env.example`.

Two of these **must match the application exactly**:

* `WHATSAPP_WORKER_TOKEN` and `WHATSAPP_WORKER_CALLBACK_SECRET` — the two sides
  of the trust boundary.
* `MESSAGING_CREDENTIALS_KEY` — device identities are sealed with it. Change it
  and every stored pairing becomes unreadable and every clinic must rescan.

Generate secrets with `openssl rand -base64 48` (and `-base64 32` for the
credentials key).

## Deploying the worker (Railway)

One Railway service, built from `services/whatsapp-worker` — never the repository
root, which would build a second copy of the Next.js application.

| Setting | Value |
| --- | --- |
| Root directory | `services/whatsapp-worker` |
| Builder | Dockerfile |
| Start command | `node dist/index.js` |
| Health check | `/healthz` |
| Replicas | 1 |
| Restart policy | on failure |

`services/whatsapp-worker/railway.json` declares all of it, including
`numReplicas: 1` and `overlapSeconds: 0`. The overlap setting is not cosmetic:
Railway's default rolling deploy runs old and new instances concurrently, and two
workers against one database contend for the same clinic sessions.

Run **exactly one instance**. The worker refuses a session another instance is
still heart-beating (`worker_id` / `last_heartbeat_at` on
`whatsapp_linked_device_sessions`), and on graceful shutdown it releases that
stamp so the replacement adopts the sessions immediately rather than waiting out
the 90-second stale window. A reconcile sweep every 60 seconds picks up anything
still held at boot. Adoption is a single conditional `UPDATE` against
`worker_id`, so two workers racing for one clinic cannot both win it.

A third route exists for development only — `handoff_to` lets a worker ask the
holder to release a session rather than wait for a shutdown or a crash. It is
off unless `WHATSAPP_DEV_TAKEOVER` says otherwise; see the section above.

`GET /healthz` is unauthenticated and reports only the instance id and session
count; every other route needs the bearer token. Railway gives the service a
public HTTPS origin — that origin, and nothing else, goes into Vercel as
`WHATSAPP_WORKER_URL`. It is never hardcoded in source.

Local equivalent, for reference:

```bash
pnpm whatsapp:worker:install
pnpm whatsapp:worker:dev     # or: build && node dist/index.js, Node 22+
```

## Local development against the real linked device (P11K)

The worker's `.env` points at the **same Supabase project the deployed worker
uses**, because testing the real WhatsApp flow needs the real session and auth
rows. That makes a laptop worker and the Railway worker two workers against one
database, and the single-owner rule refuses the second one:

```
session is held by another worker; will retry
```

That refusal is correct — it is what stops two sockets opening on one linked
device. The supported way past it is to ask for the session rather than take it.

```bash
# services/whatsapp-worker/.env
WORKER_ID=local-dev            # required, and must differ from the deployed id
WHATSAPP_DEV_TAKEOVER=1
```

```bash
pnpm whatsapp:worker:dev       # asks; the deployed worker answers within ~90s
pnpm dev                       # WHATSAPP_WORKER_URL=http://127.0.0.1:8787
```

What happens, in order:

1. The local worker's restore is refused, and records `handoff_to = local-dev`
   on the clinic's row. Railway keeps its socket and keeps sending; nothing is
   interrupted.
2. Railway's next heartbeat tick (≤30s) sees the request, **closes its socket
   first**, then releases ownership.
3. The local worker's next reconcile sweep (≤60s) wins the row through the same
   fenced compare-and-swap every adoption uses, and opens the socket.

No QR is rescanned, nothing is logged out, and no row is edited by hand. Total
time is roughly 30–90 seconds.

**Giving it back.** Stop the local worker with `Ctrl-C`. Its graceful shutdown
releases ownership and withdraws any outstanding request, and Railway adopts the
clinic on its next reconcile (≤60s). Nothing else is required. If the laptop dies
without a shutdown, the 90-second stale window frees the session and a stranded
request expires after ten minutes.

**Never** set `WHATSAPP_DEV_TAKEOVER` on a deployed worker, and never give two
workers the same `WORKER_ID` — with one id each reads the other's stamp as its
own and both open a socket. A takeover-enabled worker refuses to boot if it finds
its own id already live.

## Production cutover checklist

In this order. Nothing here is reversible by itself, but the QR card stays
unavailable — and the Meta API method unaffected — until the Vercel variables
land, so the last step is the switch.

1. **Database.** The two P7E migrations must be on the production project before
   the worker starts, or every write it makes fails. Note the CLI is normally
   linked to the *dev* project (`supabase/.temp/project-ref`); relink before
   pushing, and confirm the target:

   ```bash
   supabase link --project-ref <production-ref>
   supabase db push --dry-run     # confirm only the two P7E files are pending
   supabase db push
   ```

2. **Railway.** Create the service from this repository with the settings above,
   then set its variables:

   | Variable | Value |
   | --- | --- |
   | `SUPABASE_URL` | production Supabase project URL |
   | `SUPABASE_SERVICE_ROLE_KEY` | production service-role key |
   | `MESSAGING_CREDENTIALS_KEY` | **copied verbatim from Vercel** |
   | `WHATSAPP_WORKER_TOKEN` | freshly generated, ≥32 chars |
   | `WHATSAPP_WORKER_CALLBACK_SECRET` | freshly generated, ≥32 chars |
   | `CLINICFLOW_APP_URL` | `https://clinicflow.fit` |

   `PORT` is injected by Railway. Deploy, then confirm `GET <origin>/healthz`
   answers `{"ok":true,...}` and that an unauthenticated `GET /v1/sessions/<uuid>`
   answers 401.

3. **Vercel.** Add to the ClinicFlow project (Production scope):

   | Variable | Value |
   | --- | --- |
   | `WHATSAPP_WORKER_URL` | the Railway HTTPS origin |
   | `WHATSAPP_WORKER_TOKEN` | the same value as Railway |
   | `WHATSAPP_WORKER_CALLBACK_SECRET` | the same value as Railway |

   Redeploy. The QR card becomes available at that point.

`MESSAGING_CREDENTIALS_KEY` is the one value that must **not** be regenerated for
this rollout. It already exists in Vercel and already seals every stored channel
credential; a new key on either side makes those credentials — and every future
pairing — permanently unreadable. Copy the existing one into Railway.

## Worker/web compatibility handshake (account isolation)

Account isolation lives in both halves. The worker resolves the authenticated
WhatsApp account from the Baileys `socket.user.id` and stamps it on every row it
writes; the application refuses to interpret anything not so stamped. A worker
that predates that contract still pairs happily and writes account-less rows —
and a row written then can never afterwards be proved to belong to an account,
so it can never be adopted into one.

That window opens only when someone presses "Connect with QR" between the two
deploys, so the refusal lives in front of the scan:

- the worker advertises `workerProtocolVersion` and `linkedAccountIsolation` on
  its unauthenticated `GET /healthz`
  (`services/whatsapp-worker/src/protocol.ts`);
- the application requires `REQUIRED_WORKER_PROTOCOL_VERSION`
  (`lib/messaging/worker-protocol.ts`) and probes `/healthz` before it calls
  `/start`.

An old or non-advertising worker means the admin sees "WhatsApp service update
required before pairing." and **nothing happens**: no auth state, no session
mutation, no channel, no ownership change, no logout, no wipe. An unreachable
worker still reads as "unavailable", not as out of date — the two send an
operator to different places.

Bump both constants together, and only for a change that must not be paired
across.

### Account-isolation release order

The account-isolation migrations
(`20260907120000_whatsapp_linked_account_isolation.sql`,
`20260907121000_overdue_pending_no_show_transition.sql`) are **not yet applied
hosted**. When they are:

1. Confirm no clinic currently has a paired linked device.
2. Apply both migrations.
3. Deploy the **entire** current `services/whatsapp-worker` tree as one
   internally consistent release.
4. Verify `GET <worker-origin>/healthz` reports
   `workerProtocolVersion >= 2` and `linkedAccountIsolation: true`.
5. Deploy the web application.
6. Only then allow QR pairing.
7. Pair an account; verify `whatsapp_linked_device_sessions.authenticated_account_id`
   is populated and a `whatsapp_linked_accounts` row exists.
8. Verify newly created conversations, contacts and LID mappings all carry that
   account.
9. Verify the pre-existing NULL-scoped rows are untouched in the database and
   absent from the active Inbox.

Legacy NULL-scoped rows are deliberately never adopted into any account: the
production rows are mixed across several WhatsApp accounts with no trustworthy
per-row provenance, so inventing an owner for them would be a disclosure. They
are retained for audit only, and disappear from the active Inbox for good once a
real account is paired. There is no archive surface and none is planned.

## Restart / redeploy behaviour

Sessions survive. On `SIGTERM` the worker closes its sockets but logs nothing
out and touches no stored identity, so `desired_state` stays `online`. On boot it
reads every clinic marked `online`, restores the encrypted identity from
`whatsapp_linked_device_auth`, and reopens each socket — no clinic rescans.

During the gap (seconds), outbound sends through a linked device fail with a
409 from the worker, which the send path records as a normal provider failure.
Inbound messages sent during the gap are delivered by WhatsApp when the socket
reconnects.

## Operating notes

* **A clinic unlinked ClinicFlow from their phone.** WhatsApp closes the socket
  with a logged-out reason; the worker destroys the stored identity, removes the
  channel and marks the session `disconnected`. The clinic sees "Not connected"
  and can scan again.
* **A pairing that nobody scans.** The worker offers up to five successive codes
  (~5 minutes) before settling on an error the card explains, with a
  "Show a new code" button.
* **A number another clinic already holds.** The global unique
  `clinic_channels.sender_identity` index refuses the claim; the worker undoes
  the pairing rather than taking the number.
* **Rotating the shared secrets.** Update the worker and the application together
  and restart both; sessions are unaffected (they do not depend on these).

## Capability boundaries — do not oversell these

A linked device is the clinic's own WhatsApp account, not the Cloud API. It
carries one-to-one text conversations, delivery/read receipts and a mirror of
messages sent from the phone. Media arrives as a bracketed marker
(`[image]`, `[document]`, …); group, status and broadcast chats are ignored.

There is **no** template catalogue, **no** approval workflow, **no** 24-hour
service window, **no** per-message pricing and **no** WABA quality rating — those
are Cloud API constructs that do not exist here. ClinicFlow templates are
rendered and sent as ordinary text, and the service-window gate in
`lib/messaging/send.ts` is deliberately skipped for this transport. Cost
reporting for linked-device sends is null, so the P6B messaging-cost and P6D
WhatsApp-health surfaces cover Meta/360dialog channels only.

Using a personal or business WhatsApp account this way is subject to WhatsApp's
terms. This is an unofficial transport; the Meta Cloud API method remains the
officially supported one and is offered alongside it.

## Retired from the clinic UI

`/settings/messaging` no longer mounts the Meta Embedded Signup wizard, the
Coexistence card, or the 360dialog connection card. Their server-side code is
untouched for channels that already went through them; only the clinic-facing
entry points are gone. `NEXT_PUBLIC_META_CONFIG_ID` and
`NEXT_PUBLIC_META_COEXISTENCE_CONFIG_ID` are no longer read by any page.

The Content-Security-Policy in `next.config.ts` still allows
`connect.facebook.net` and `*.facebook.com` frames. Nothing clinic-facing loads
them any more, so tightening that is available as a follow-up — it is left in
place here because the retained wizard component would break if it is ever
rendered again.
