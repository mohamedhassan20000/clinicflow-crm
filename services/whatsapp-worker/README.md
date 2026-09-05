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

Voice-note sends also require `ffmpeg` on `PATH`. The production Docker image
installs Debian's signed package before dropping to the unprivileged `node`
user; install an equivalent package for local development.

## Tests

```bash
pnpm whatsapp:worker:test        # node:test, no database and no WhatsApp
```

`tests/` runs the real `SessionManager` against an in-memory store and a socket
factory the test controls, so a handshake can be stalled or failed on demand.
That is what guards the start path: `POST /start` answers as soon as the clinic's
ownership and its `starting` row are durable, the code turns up in that row
later, a second click never opens a second socket, a pairing another live worker
holds is still refused, and a handshake that fails after the answer is written
back to the session row instead of disappearing. They run in CI alongside the
worker's typecheck.

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

`PORT` is injected by Railway; set it only if it is not. `WHATSAPP_OUTBOUND_LID_ROUTING`
is optional and defaults to on — see [Outbound addressing](#outbound-addressing).

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
| `POST` | `/v1/sessions/:clinicId/start` | Start or restore that clinic's pairing. Idempotent; see below. |
| `GET` | `/v1/sessions/:clinicId` | Coarse status for that clinic. |
| `POST` | `/v1/sessions/:clinicId/logout` | Unlink the device and destroy the stored identity. |
| `POST` | `/v1/sessions/:clinicId/messages` | Send `{ recipient, body }` through that clinic's session. |

`/start` answers as soon as two things are true: no other live worker holds this
clinic, and the session row says `starting` with this worker's id on it. The
socket comes up afterwards, on the worker's own time. This is deliberate — the
caller is a Next.js request with seconds to live, while a handshake (auth state,
protocol version, WhatsApp) can take longer than that, and a clinic used to be
told the service was unavailable moments before a perfectly good code appeared.
A `200` therefore means "accepted and recorded", not "connected"; the clinic's
panel polls the session row, where the code turns up when WhatsApp issues one and
where a handshake that fails later is recorded as `status = error`,
`last_error = unavailable`. `409 owned_elsewhere` is unchanged and still decided
before anything is written.

Inbound traffic is delivered the other way, to
`POST $CLINICFLOW_APP_URL/api/webhooks/whatsapp/linked-device`, signed with
HMAC-SHA256 over `timestamp.body` using `WHATSAPP_WORKER_CALLBACK_SECRET`.

## What this transport can and cannot do

It carries one-to-one conversations: inbound patient messages, outbound ClinicFlow
messages, delivery/read receipts, and a mirror of messages the clinic sends from the
phone itself. Inbound images, documents, ordinary audio and PTT voice notes use the
private attachment path; video and unsupported media retain their correct bracketed
marker and an explicit unavailable attachment record rather than silently vanishing or
being mislabeled. Group, status, broadcast and newsletter chats, and Meta AI, are
ignored.

A one-to-one chat is *not* one string shape. WhatsApp is migrating chat addressing
from phone-number JIDs (`<phone>@s.whatsapp.net`) to LID JIDs (`<opaque>@lid`),
and a paired device receives whichever form the server chose. Both are carried.
The digits of a LID are an opaque server identifier and are never read as a phone
number: the counterparty is resolved from what WhatsApp asserted — `sender_pn` on
the stanza, a `chats.phoneNumberShare`, or a contact record carrying both
spellings — and a LID chat that has asserted none of those yet is dropped with a
diagnostic rather than filed against a guessed number.

### Outbound addressing

The same split matters on the way out, and getting it wrong is invisible from
here: the send succeeds, WhatsApp returns a message id, and the recipient's phone
shows "Waiting for this message. This may take a while." forever.

Baileys 6.7.24 keys Signal sessions on the JID's *user part alone*
(`Signal/libsignal.ts` builds `ProtocolAddress(user, device)` and discards the
server), and this version has no LID mapping store and no session-migration step.
So a LID-addressed chat and a phone-addressed one are two unrelated session
records for the same physical device, with nothing reconciling them. Forcing every
send to `<phone>@s.whatsapp.net` while the conversation is being conducted over
LID therefore opens a second, parallel session with a device already talking to us
on the first.

An outgoing message is addressed by LID when — and only when — WhatsApp has
asserted a LID for that number on this session, using the same directory the
inbound path builds. A number with no asserted LID is sent to over the
phone-number path, which is the ordinary supported route for a contact that has
not been migrated. A LID is never derived from a phone number: the two are
unrelated identifiers, so a guess would simply address a stranger. Set
`WHATSAPP_OUTBOUND_LID_ROUTING=0` to pin every send to the phone-number path.

Sends are logged with the address kind (`pn`/`lid`), where the mapping came from,
whether the send succeeded, and whether a provider message id came back — never a
JID, a phone number, a message body or key material.

### Repairing a message the recipient could not decrypt

A recipient who cannot decrypt asks the sender to re-send, and Baileys answers
that retry receipt by asking the `getMessage` hook for the plaintext. The library
default returns `undefined`, which silently consumes every retry and re-sends
nothing — the placeholder is then permanent. The worker supplies the hook from a
small bounded in-memory cache of recently sent messages, held per clinic and kept
across reconnects (a dropped socket being exactly what produces those retries).
Nothing is persisted: message plaintext does not belong in the database for the
sake of an exchange that has stopped mattering within minutes.

#### Nothing from the Signal layer is ever printed

`libsignal`, underneath Baileys, narrates the Signal session lifecycle to the
global console and passes the session record itself as an argument — `privKey`,
`rootKey`, `chainKey`, `remoteIdentityKey`, `pendingPreKey`, formatted by
`util.inspect` and written to stdout. There is no option that disables it and
Baileys' `logger` config does not reach it. `src/log-guard.ts` replaces the
console's printing methods at process start: every argument is dropped unread,
and the only thing emitted is a fixed event name chosen by matching the literal
prefix of the first argument. The set of strings the worker can print through
that path is a constant table with no interpolation in it.
`tests/retry-diagnostics.test.ts` pushes realistic key material through every
guarded method and asserts that not one byte survives.

Messages WhatsApp had queued for a device it considered offline are flushed on the
next handshake, and arrive as upsert type `append` rather than `notify`. Those are
carried too — they are exactly the messages patients sent during a redeploy.
(Bulk history sync does not arrive on that event at all, so nothing is replayed;
the application dedupes on the provider message id regardless.)

Every inbound message — carried or dropped — is logged with the upsert type, the
address space of the chat, the direction, whether any renderable content was
found, and how the counterparty's number was established (`chat_jid`,
`asserted_stanza`, `directory`, `unresolved`). Never a JID, a phone number or a
message body. That last field is what answers "why is this conversation not
routed by LID?" from the logs: a chat reporting only `jidKind: "pn"` /
`counterpartySource: "chat_jid"` is being conducted in the phone-number address
space, so WhatsApp has asserted no LID for it and there is none to use.

### Reading the retry exchange on a real device

The repair happens inside Baileys, and Baileys reports it only through the
`logger` it is constructed with — a logger that also prints binary frames, JIDs
and Signal addresses, so it cannot simply be turned up. `src/retry-diagnostics.ts`
translates instead: the handful of retry-path messages become the worker's own
events and everything else is dropped unread. Message ids appear only as
`messageRef`, a hash salted per boot, so the lines of one run correlate with each
other and with nothing else.

A healthy repair, at `LOG_LEVEL=info`, reads:

| # | `event` | what it proves |
|---|---------|----------------|
| 1 | `outbound message dispatched` (`outcome: "sent"`, `messageRef`, `retryCacheSize`) | the send went out and the plaintext was retained under the id that went on the wire |
| 2 | `retry_receipt_received` (same `messageRef`) | the recipient could not decrypt and asked for it again |
| 3 | `retry_cache_hit` (same `messageRef`, `cacheSize`) | `getMessage` found the plaintext — the step that used to return `undefined` |
| 4 | `signal_sessions_fetched` | `assertSessions(..., force)` pulled a fresh pre-key bundle |
| 5 | `retry_forced_new_session` | a brand-new Signal session was established for the retry |
| 6 | `relay_stanza_sent` (same `messageRef`) | the message was re-encrypted and re-relayed |

Where it stops is the diagnosis:

- **stops after 1** — no retry receipt is arriving. Nothing in the cache can help;
  the fault is upstream (the stanza never reached the device, or its phone is not
  asking).
- **`retry_cache_miss` instead of 3** — the receipt arrived and the plaintext was
  gone. Either the send predates this process, or it fell out of the 256-message
  window.
- **`retry_limit_reached`** — `maxMsgRetryCount` (5) is spent for that message.
- **`retry_relay_failed`** — the re-relay threw; the placeholder stays.
- **`inbound_retry_receipt_sent`** — the opposite direction: *we* could not
  decrypt something and asked the sender to repeat it.

`LOG_LEVEL=debug` additionally shows `message carried` (the address-space line
above) and `signal_session_closed`-style events from the Signal layer.

It is **not** the WhatsApp Cloud API. There is no template catalogue, no
approval workflow, no 24-hour service window, no message pricing and no WABA
quality rating — those are Cloud API constructs and do not exist on a linked
device. ClinicFlow templates are rendered and sent as ordinary text.

Using a personal/business WhatsApp account this way is subject to WhatsApp's
terms. This is an unofficial transport; the Meta Cloud API method remains the
officially supported one and is offered alongside it.
