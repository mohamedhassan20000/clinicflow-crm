# ClinicFlow WhatsApp worker

Holds one long-lived WhatsApp **linked-device** session per clinic — the same
kind of session WhatsApp Web uses — so a clinic can connect the number they
already have by scanning a QR code inside ClinicFlow.

## Why this is a separate service

A linked device is an authenticated websocket that must stay open. The
ClinicFlow application is deployed to Vercel, where no process is guaranteed to
outlive a request: a socket opened inside a route handler is torn down moments
later, mid-handshake, and the clinic would be asked to scan again constantly.
This worker is therefore an always-on Node process on a platform that supports
one (Fly.io, Railway, Render, a small VM, or a container on any host).

The application never opens a WhatsApp socket. It asks this worker to do things
over a private HTTP API, and reads the state the worker publishes to the shared
Supabase database.

## Topology

Run **exactly one instance**. Two instances against the same database would each
try to hold the same clinic's session. The worker defends against that — it
refuses a session another instance is still heart-beating (see
`whatsapp_linked_device_sessions.worker_id` / `last_heartbeat_at`) — but a single
instance is the supported and tested topology. Scale vertically; each session is
a websocket and some signal-protocol state, not a CPU-bound workload.

## Tenant isolation

* Sessions are stored in a `Map` keyed by clinic id. There is no global socket
  and no code path that resolves a socket by anything else.
* Device identities live in `whatsapp_linked_device_auth`, keyed by clinic and
  encrypted with the same AES-256-GCM key the application uses for channel
  credentials. The database only ever holds ciphertext.
* A paired number is claimed in `clinic_channels`, whose global unique
  `sender_identity` index means one WhatsApp number belongs to exactly one
  clinic. A pairing that would take another clinic's number is undone.
* The HTTP API is addressed per clinic and is not public. Bind it to a private
  network; the bearer token is the last line of defence, not the first.

## Running locally

The worker is not part of the pnpm workspace — it has its own dependency tree so
that its image never drags in the Next.js application. It is still driven from
the repository root:

```bash
pnpm whatsapp:worker:install     # first time only
pnpm whatsapp:worker:dev         # reads services/whatsapp-worker/.env
```

Two terminals is the whole local setup:

```
Terminal 1:  pnpm dev:https              # ClinicFlow on https://localhost:3000
Terminal 2:  pnpm whatsapp:worker:dev    # worker on http://127.0.0.1:8787
```

`WHATSAPP_WORKER_URL`, `WHATSAPP_WORKER_TOKEN`, `WHATSAPP_WORKER_CALLBACK_SECRET`
and `MESSAGING_CREDENTIALS_KEY` must match between `.env.development.local` (the
application) and `services/whatsapp-worker/.env` (this service). Both files are
git-ignored.

Because `pnpm dev:https` serves a mkcert-issued certificate, the worker needs
that CA to trust its callback target locally — hence `NODE_EXTRA_CA_CERTS` in the
worker's `.env`. Nothing equivalent is needed in production.

Requires Node 22+. `npm run dev` executes the TypeScript sources directly through
Node's type stripping, which is why this codebase avoids constructor parameter
properties: strip-only mode cannot desugar them.

## Deploying to Railway

One Railway service, built from **this directory** — not the repository root, and
never a second copy of the Next.js application.

| Setting | Value |
| --- | --- |
| Root directory | `services/whatsapp-worker` |
| Builder | Dockerfile (`Dockerfile`, checked in) |
| Start command | `node dist/index.js` |
| Health check path | `/healthz` |
| Replicas | **1** — see *Topology* above |
| Port | injected by Railway as `PORT`; the process binds it |

`railway.json` in this directory already declares all of that, including
`numReplicas: 1` and `overlapSeconds: 0`. The overlap matters: Railway's default
rolling deploy runs the old and new instances together, and two workers against
one database would contend for the same clinic sessions.

Required environment variables in the Railway service:

```
SUPABASE_URL                     production Supabase project URL
SUPABASE_SERVICE_ROLE_KEY        production service-role key
MESSAGING_CREDENTIALS_KEY        the EXISTING production key from Vercel — never a new one
WHATSAPP_WORKER_TOKEN            shared with Vercel
WHATSAPP_WORKER_CALLBACK_SECRET  shared with Vercel
CLINICFLOW_APP_URL               https://clinicflow.fit
```

`PORT` is injected by Railway; set it only if it is not.

`MESSAGING_CREDENTIALS_KEY` is load-bearing across both deployables. Every stored
channel credential and every device identity is sealed with it, so it must be
copied from Vercel verbatim. Generating a fresh one here would make every
existing pairing and every stored Meta credential permanently unreadable.

A redeploy is invisible to clinics: the outgoing instance closes its sockets,
releases its ownership stamp on the session rows, and leaves `desired_state` at
`online`; the incoming instance restores every one of them from the encrypted
state in the database, and a reconcile sweep adopts anything the outgoing
instance was still holding at boot. Nobody rescans.

## API

All routes except `/healthz` require `Authorization: Bearer $WHATSAPP_WORKER_TOKEN`.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/healthz` | Liveness; reports instance id and session count only. |
| `POST` | `/v1/sessions/:clinicId/start` | Start or restore that clinic's pairing. Idempotent. |
| `GET` | `/v1/sessions/:clinicId` | Coarse status for that clinic. |
| `POST` | `/v1/sessions/:clinicId/logout` | Unlink the device and destroy the stored identity. |
| `POST` | `/v1/sessions/:clinicId/messages` | Send `{ recipient, body }` through that clinic's session. |

Inbound traffic is delivered the other way, to
`POST $CLINICFLOW_APP_URL/api/webhooks/whatsapp/linked-device`, signed with
HMAC-SHA256 over `timestamp.body` using `WHATSAPP_WORKER_CALLBACK_SECRET`.

## What this transport can and cannot do

It carries one-to-one text conversations: inbound patient messages, outbound
ClinicFlow messages, delivery/read receipts, and a mirror of messages the clinic
sends from the phone itself. Media arrives as a bracketed marker
(`[image]`, `[document]`, …) rather than silently vanishing; group, status and
broadcast chats are ignored.

It is **not** the WhatsApp Cloud API. There is no template catalogue, no
approval workflow, no 24-hour service window, no message pricing and no WABA
quality rating — those are Cloud API constructs and do not exist on a linked
device. ClinicFlow templates are rendered and sent as ordinary text.

Using a personal/business WhatsApp account this way is subject to WhatsApp's
terms. This is an unofficial transport; the Meta Cloud API method remains the
officially supported one and is offered alongside it.
