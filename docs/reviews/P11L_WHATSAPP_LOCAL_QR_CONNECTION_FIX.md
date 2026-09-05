# P11L — "Connect with QR" reaches the local worker again

**Date:** 2026-08-29 · **Branch:** `feat/p7-manual-qa-polish`
**Local clinic:** `93000000-0000-4000-8000-000000000001` (Health Care Pro, seeded)
**Deployed clinic:** `caf2711f-97cb-4474-a103-f9505f467087` (untouched)

---

## 1. Exact broken boundary

**Not the one everyone was looking at.** The reported symptom — "pressing Connect
with QR produces no worker log at all, therefore the app never reaches the
worker" — was the wrong inference. The request reached the worker every time.

The boundary that failed is inside the worker, one layer past the HTTP handler:

```
button → server action → lib/messaging/linked-device.ts → POST /v1/sessions/:id/start
       → services/whatsapp-worker/src/server.ts        ✅ reached
       → SessionManager.start()                        ✅ reached
       → Store.claimSession()                          ❌ refused
       → 409 owned_elsewhere → "the service is unavailable" → no QR
```

Proved by hand against the worker the developer already had running, before any
change was made:

```
$ curl -s -X POST -H "authorization: Bearer $WHATSAPP_WORKER_TOKEN" \
    http://127.0.0.1:8787/v1/sessions/caf2711f-.../start
{"error":"owned_elsewhere"}   HTTP 409
```

And the reason it looked like nothing happened: **none of that path logged
anything.** `server.ts` logged neither the arrival of a start nor the 409 it
answered with, `SessionManager` logged nothing when a claim was refused, and the
401 branch was silent too. Three of the four possible outcomes of pressing the
button produced an empty log, which is indistinguishable from a request that was
never made — and that is what sent the investigation to the wrong end of the
chain.

## 2. Exact root cause

**The local worker and the deployed Railway worker were pointed at the same
database, so they contended for the same clinic session row, and the local one
always lost.**

`whatsapp_linked_device_sessions` holds exactly one row per clinic, and ownership
is one `worker_id` column defended by a compare-and-swap in `Store.claimSession`.
That is the correct design — two workers holding sockets on one linked device
corrupt each other's Signal ratchets — but it means "who owns this clinic" is
decided per *database*, not per environment.

At the time of investigation the hosted row read:

```json
{"clinic_id":"caf2711f-…","status":"disconnected","desired_state":"offline",
 "worker_id":"railway-prod","last_heartbeat_at":"2026-08-29T17:57:43+00:00"}
```

— heart-beaten by `railway-prod` every 30 s (confirmed by polling: 17:57:13 →
17:57:43). The seat was therefore permanently occupied, even though the session
itself was disconnected and serving nothing. `HEARTBEAT_STALE_MS` (90 s) never
elapsed, so the local worker's claim could never match.

Configuration at fault:

| Variable | Where | Was | Should be for local QR |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | app | hosted project | local stack `127.0.0.1:54321` |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | `services/whatsapp-worker/.env` | hosted project | local stack `127.0.0.1:54321` |
| `WHATSAPP_WORKER_URL` | app | `http://127.0.0.1:8787` ✅ | unchanged |
| `WHATSAPP_WORKER_TOKEN` / `_CALLBACK_SECRET` / `MESSAGING_CREDENTIALS_KEY` | both | already matched ✅ | unchanged |

`WHATSAPP_WORKER_URL` was never the problem. It was correct, it was being read,
and the call was landing on loopback. What was wrong was the **database** on the
far side of both processes.

Two smaller defects rode along and are also fixed:

- **The 409 was reported to the clinic as "the service is unavailable."**
  `callWorker` collapsed every non-5xx failure into `REJECTED`, and the action
  mapped `REJECTED` and `UNAVAILABLE` to the same sentence. So the one message
  that would have named the real situation was replaced by the one that
  described the situation everybody then went looking for.
- **A failed start left the dialog spinning forever.** The action returned the
  stored row as its view; for a clinic that had never paired that row is
  `not_started`, which `QrPanel` renders as a spinner and which the poll does not
  treat as transient. The toast was the only signal, and it disappears.

## 3. Did a recent diff cause it?

**Partly — and the archaeology matters, because the "original working behaviour"
being asked for never ran against the hosted database.**

- `services/whatsapp-worker` was introduced whole in `f8da8c6`
  (2026-08-17, *feat(messaging): WhatsApp Linked Device + Railway worker*). It
  does not exist in `01d2d76` or earlier, so there was no ownership contention to
  have before that date.
- The local dev server *used* to be pointed at the local Supabase stack by
  `.env.development.local`. That file is present in the working tree as
  **`.env.development.local.off`** — renamed, therefore not loaded. Its own header
  says exactly why it exists: *"`next dev` loads `.env.development.local` before
  `.env.local`, and `.env.local` points NEXT_PUBLIC_SUPABASE_URL at the hosted
  ClinicFlow dev project."* Renaming it silently moved the whole dev server onto
  the hosted project.
- `services/whatsapp-worker/.env` was edited in the same period to point
  `SUPABASE_URL` at the hosted project, with a comment describing the change as
  deliberate and recommending `WHATSAPP_DEV_TAKEOVER=1` as the way through. The
  prior copy is preserved as `.env.save`.
- P11K (`docs/reviews/P11K_WHATSAPP_LOCAL_WORKER_OWNERSHIP_REGRESSION.md`)
  diagnosed the same collision and answered it by **adding** the takeover
  mechanism. P11L answers it the way it was asked to be answered here: by not
  colliding in the first place. Takeover is left in place, off, and unused.

No committed application or worker source caused this. The ownership predicate is
byte-identical to `f8da8c6`.

## 4. Files changed

**Source (committable):**

| File | Change |
|---|---|
| `lib/messaging/linked-device.ts` | `OWNED_ELSEWHERE` split out of `REJECTED`; `reportWorkerFailure()` records origin + path + code + status to a Sentry breadcrumb and `console.warn` on every failed worker call, and never the token |
| `actions/messaging-linked-device.ts` | maps `OWNED_ELSEWHERE` to its own sentence; a failed start now returns an `error` view instead of the unchanged row, so the panel shows a reason and a Regenerate button rather than a spinner |
| `messages/action-errors/{en,ar}.json` | `thisClinicsWhatsAppSessionIsHeldByAnotherService` |
| `services/whatsapp-worker/src/server.ts` | logs `start requested` on arrival; logs a rejected token with method + path and nothing else |
| `services/whatsapp-worker/src/sessions.ts` | `logRefusedClaim()` — a refused claim now names the holding worker, the age of its heartbeat, the row's status/desired state and whether takeover is on |
| `tests/unit/lib/p7e-linked-device-session.test.ts` | Sentry mock gains `addBreadcrumb` |

**Tests added:**

| File | Covers |
|---|---|
| `services/whatsapp-worker/tests/p11l-start-endpoint.test.ts` | the real worker HTTP server on loopback: claim → 200 + `starting` row, QR published with a future expiry, 409 with the holder named in the log, 401 logged without the token, malformed clinic id |
| `tests/unit/lib/p11l-linked-device-worker-routing.test.ts` | the app against a real loopback HTTP server: exact method/path/`Authorization`, address re-read per call, loopback-HTTP vs HTTPS-only policy, 409/500/401 mapping, no call when unconfigured or Meta-owned, QR read-back and expiry |
| `tests/unit/actions/p11l-linked-device-start-action.test.ts` | failure → terminal `error` view, per-code message keys, entitlement gate |
| `tests/unit/components/p11l-whatsapp-qr-connect-card.test.tsx` | QR rendered, awaiting_scan → connected via the poll, error surface with Regenerate, polling stops once settled |

**Local configuration (git-ignored, this machine only):**

| File | Change |
|---|---|
| `.env.development.local` | recreated: local Supabase URL/keys, `NEXT_PUBLIC_SITE_URL=http://localhost:3000`, and the four worker secrets mirroring the worker's `.env` |
| `services/whatsapp-worker/.env` | `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` → local stack; misleading header comment replaced. Previous copy backed up as `.env.bak.<epoch>` |

**No migration.** `20260829120000_p11k_linked_device_ownership_handoff.sql` already
provides everything used here; nothing in this work needed a schema change.

## 5. Local worker routing — before / after

|  | Before | After |
|---|---|---|
| App resolves `WHATSAPP_WORKER_URL` | `http://127.0.0.1:8787` | `http://127.0.0.1:8787` (unchanged, and now regression-tested) |
| HTTP call made | yes — `POST /v1/sessions/:id/start` on loopback | same |
| Auth | `Bearer` token, matched worker's | same |
| App's database | hosted `ayzetxywrqouqpurbjuv` | local `127.0.0.1:54321` |
| Worker's database | hosted `ayzetxywrqouqpurbjuv` | local `127.0.0.1:54321` |
| Contends with `railway-prod` | yes, always lost | no — different database |
| `WHATSAPP_DEV_TAKEOVER` | `0`, and the only documented way out was `1` | `0`, and irrelevant |
| Railway | untouched | untouched |

Next.js confirms the override is loaded on boot:

```
- Environments: .env.development.local, .env.local
```

`.env.development.local` wins where both define a key, which is precisely why the
hosted Supabase values in `.env.local` no longer reach the dev server. **An env
change requires a dev-server restart** — Next reports the file set once, at boot.

## 6. QR flow — before / after

**Before:** press Connect with QR → spinner → toast "The WhatsApp connection
service is unavailable right now" → dialog spins indefinitely → no QR → no
worker log line of any kind.

**After**, verified against the running local stack:

```
$ curl -s -X POST -H "authorization: Bearer …" \
    http://127.0.0.1:8787/v1/sessions/93000000-0000-4000-8000-000000000001/start
{"ok":true}   HTTP 200

$ # the row the settings panel polls, 10 s later
{"clinic_id":"93000000-…","status":"awaiting_scan","worker_id":"local-dev",
 "qr_expires_at":"2026-08-29T18:02:53.65+00:00"}
qr_payload length: 237
```

A real WhatsApp pairing payload, owned by `local-dev`, with a live expiry. The
worker then exercised the rest of the lifecycle unattended — nobody was there to
scan it — and reported each stage:

```
"code expired unscanned"  qrRounds=4
"code expired unscanned"  qrRounds=8
"session ended"           reason=pairing_failed
```

which is refresh, expiry, a bounded retry budget, and a visible terminal failure
that lands in the row as `status=error` for the panel to render.

### The full chain, driven through the application

Not curl this time: a real signed-in admin session (`dev-admin@…`, local
Supabase), the real `startWhatsAppQrSession` Server Action on the running dev
server, and the real `readWhatsAppQrSession` poll the panel runs.

```
$ # settings page, authenticated
page: 200   mentions "Health Care Pro": true   has qr card: true   # ← local DB

$ # press Connect with QR
startWhatsAppQrSession: HTTP 200

$ # the worker, at that instant
{"level":30,"clinicId":"93000000-0000-4000-8000-000000000001","msg":"start requested"}

$ # what the panel reads back six seconds later
readWhatsAppQrSession: HTTP 200
{"status":"awaiting_scan",
 "qrImage":"data:image/png;base64,<6343 chars>",
 "qrExpiresAt":"2026-08-29T18:50:48.737+00:00",
 "phoneNumber":null,"connectedAt":null,"errorCode":null}
```

Every boundary in the chain is accounted for: the action ran, the application
resolved the loopback worker, the HTTP call landed (the worker's own log proves
it), `SessionManager.start()` claimed the clinic, WhatsApp issued a code, the row
carried it, and the view handed the panel a rendered PNG with a live expiry.
Scanning within that window is the only step a machine cannot perform here.

Restart behaviour is unchanged and now environment-local: a session with
`desired_state=online` in the local database is restored by the local worker's
boot sweep, and one in the hosted database is restored by Railway's. Neither can
see the other.

## 7. Tests and results

```
$ pnpm whatsapp:worker:test
ℹ tests 177   ℹ pass 177   ℹ fail 0      # incl. the 5 new start-endpoint tests

$ npx vitest run --exclude "tests/unit/integration/**"
Test Files  436 passed (436)
Tests       4146 passed | 2 skipped (4148)

$ npx tsc --noEmit                        # clean
$ pnpm whatsapp:worker:typecheck          # clean
$ npx eslint <changed files>              # clean
$ node scripts/check-messages.mjs missing # 4260 leaf messages, parity ok
$ node scripts/check-messages.mjs unused  # no unreferenced keys
$ node scripts/check-i18n-strings.mjs     # no hardcoded user-facing strings
```

The two worker-side suites use **real HTTP** against the real
`createWorkerServer` on `127.0.0.1`, and the app-side routing suite uses a real
`node:http` listener rather than a `fetch` mock — deliberately, because the four
properties that actually broke (address, method, path, header) are the four a
`fetch` mock is least able to keep honest.

The 409 log assertion reads file descriptor 1 rather than `process.stdout.write`,
because pino writes through sonic-boom and never touches the stream wrapper.

## 8. Migration status

**None required, none written.** The last linked-device migration,
`supabase/migrations/20260829120000_p11k_linked_device_ownership_handoff.sql`, is
already applied locally and covers `handoff_to` / `handoff_requested_at`. No
schema change was made and no hosted database was written to.

## 9. Local testing — exact commands and environment

```bash
# 1. Local Supabase must be up; this is the database both halves now share.
supabase start
supabase db reset          # only if the schema is behind
pnpm dev:seed-clinic       # Health Care Pro + dev-admin@clinicflow.example.invalid

# 2. Worker — services/whatsapp-worker/.env
#      PORT=8787
#      WORKER_ID=local-dev
#      SUPABASE_URL="http://127.0.0.1:54321"
#      SUPABASE_SERVICE_ROLE_KEY=<supabase status -o env: SERVICE_ROLE_KEY>
#      CLINICFLOW_APP_URL="http://localhost:3000"
#      WHATSAPP_WORKER_TOKEN / _CALLBACK_SECRET / MESSAGING_CREDENTIALS_KEY  (≥32 chars, mirrored below)
#      WHATSAPP_DEV_TAKEOVER=0
pnpm whatsapp:worker:dev

# 3. App — .env.development.local  (loaded BEFORE .env.local; restart dev after editing)
#      NEXT_PUBLIC_SUPABASE_URL="http://127.0.0.1:54321"
#      NEXT_PUBLIC_SUPABASE_ANON_KEY=<supabase status -o env: PUBLISHABLE_KEY>
#      SUPABASE_SERVICE_ROLE_KEY=<supabase status -o env: SECRET_KEY>
#      NEXT_PUBLIC_SITE_URL="http://localhost:3000"
#      WHATSAPP_WORKER_URL="http://127.0.0.1:8787"
#      WHATSAPP_WORKER_TOKEN / _CALLBACK_SECRET / MESSAGING_CREDENTIALS_KEY  (identical to the worker's)
pnpm dev
```

Then: sign in as `dev-admin@clinicflow.example.invalid` / `ClinicFlowDev123!` →
**Settings → Messaging → Connect with QR**. The worker prints
`{"msg":"start requested","clinicId":"93000000-…"}` the instant the button is
pressed. Scan within the window; the panel polls to `connected` and shows the
number.

If it refuses, the log now says which worker holds the clinic and how old its
heartbeat is — which is the whole diagnosis, in one line.

**Do not** point `services/whatsapp-worker/.env` at the hosted project to "test
against the real device". That is the configuration this document exists about.

## 10. Push safety

**SAFE TO PUSH.**

- Source changes are additive: one new failure code, one new message key, four
  log statements, one view correction. No behaviour changes for a correctly
  configured deployment — a healthy worker returns 200 and none of the new
  branches are taken.
- Every environment-specific value lives in git-ignored `.env*` files.
  `WHATSAPP_WORKER_URL` remains fully configurable and no localhost address is
  hard-coded in production code; the HTTPS-only rule for non-loopback hosts is
  unchanged and now tested.
- Single-owner protection is untouched: `claimSession`, `HEARTBEAT_STALE_MS`,
  `HANDOFF_TTL_MS` and the handoff fence are byte-identical. The new code only
  *describes* a refusal it does not influence.
- `WHATSAPP_DEV_TAKEOVER` is off and unused by this flow.
- No secret is logged. The failure line carries an origin, a path, a code and an
  HTTP status; the 401 line carries a method and a path. Both are asserted
  token-free by tests.
- Railway was not changed, the production WhatsApp device was not logged out, no
  hosted row was written, and no migration was added.

**Not pushed. Not deployed.** Working tree only.

---

# P11M — Addendum: one database, one owner, and the handoff that was never deployed

**Date:** 2026-08-29 · **Branch:** `feat/p7-manual-qa-polish` · **Working tree only**

**This section supersedes §2's configuration table, §5, and §9 above.** P11L
resolved the local/Railway ownership collision by *separating the databases* —
it pointed the dev server and the local worker at `127.0.0.1:54321`. That
answered the question as asked at the time, but it also removed the thing local
development is for: `pnpm dev` stopped showing real clinics, and the local worker
stopped being able to drive the real linked device. The requirement now is the
opposite one: **both halves on the hosted project, and the ownership conflict
solved properly rather than avoided.**

---

## 11. Root cause

Two independent defects, one of which is a blocker that no amount of local code
can clear.

### 11.1 `Store.upsertSession` was a second way to become the owner

`claimSession` is documented as the only write that may *take* a session, and
the single-owner invariant rests entirely on that being true. It was not. Every
status write went through `upsertSession`, which put this instance's id in the
payload unconditionally:

```ts
.upsert({ clinic_id, worker_id: this.config.workerId, last_heartbeat_at: now, ...patch })
```

On the common path this is a no-op — the row was claimed a moment earlier, so
the stamp rewrites the same value — and that is precisely why it survived
review. Two paths are not on the common path:

- **`logout()`** reaches its no-live-socket branch for any clinic the
  application names, held by anyone. Pressing *Disconnect* is enough.
- **`recordStartFailure()`** lands after a start that was admitted and then
  lost the socket, by which time ownership may have moved.

Either one hands this worker a row it never claimed.

### 11.2 The same line produced the self-handoff constraint violation

A worker that has *asked* for a session it does not hold leaves
`handoff_to = <its own id>` on a row still owned by somebody else. That is the
normal, correct intermediate state of a handoff. The moment one of the two paths
above stamped `worker_id` with that same id, the row read
`handoff_to = worker_id`, which P11K's check constraint refuses:

```
new row for relation "whatsapp_linked_device_sessions" violates check constraint
"whatsapp_linked_device_sessions_handoff_not_self"      SQLSTATE 23514
```

So the clinic's *Disconnect* failed with a 500 raised by a constraint that was
doing exactly its job. The constraint was never the bug; the write was.

The worker's own test suite could not see any of this, because `FakeStore`
imitated the table without imitating its constraints — it accepted the row
Postgres rejects, and reported green for the one defect it existed to catch.

### 11.3 The blocker: P11K's handoff has never been deployed

This is the part that no local change can fix, and it is why "local safely takes
ownership from `railway-prod`" does not work today.

The handoff is **cooperative by design**, and correctly so: a requester writes
`handoff_to` and takes nothing, and the *holder* closes its socket and releases
ownership on its next heartbeat tick (`SessionManager.honorHandoffs`). That
ordering is the whole safety property — it is what guarantees there is never an
instant with two sockets on one linked device. It also means **the handoff only
works if the holder runs the code.**

`honorHandoffs` has never been committed:

```
$ git log --all --oneline -S "honorHandoffs" -- services/whatsapp-worker/src/sessions.ts
(no output)
```

Every line of P11K — `honorHandoffs`, `requestHandoff`, `listHandoffRequests`,
`WHATSAPP_DEV_TAKEOVER` — exists only in this working tree. `HEAD` contains none
of it. The deployed Railway worker therefore reads `handoff_to` never, and a
request written against it stands until it expires.

Confirmed against the live hosted project rather than inferred. The local worker
was pointed at hosted with `WHATSAPP_DEV_TAKEOVER=1` and the real start endpoint
driven:

```
$ curl -s -X POST -H "authorization: Bearer $WHATSAPP_WORKER_TOKEN" \
    http://127.0.0.1:8787/v1/sessions/caf2711f-.../start
{"error":"owned_elsewhere"}   HTTP 409

# the worker's own log, at that instant
"start requested"                                              clinicId=caf2711f-…
"refused to start: this clinic's session is owned by another worker"
                       heldBy=railway-prod  heartbeatAgeMs=27516  devTakeover=true
"development takeover: asked the current owner to release this session"
```

The request was recorded on the hosted row. Then, 112 seconds and **at least
three `railway-prod` heartbeat ticks later**:

```json
{"worker_id":"railway-prod","hb_age":"00:00:19","handoff_to":"local-dev",
 "request_age":"00:01:51","status":"disconnected","desired_state":"offline"}
```

Still held, still heart-beating, request untouched. `railway-prod` cannot honour
a handoff because the code that reads the column is not in its image.

### 11.4 Why the seat never frees on its own

`HEARTBEAT_STALE_MS` (90 s) is the other way a session changes hands, and it
never elapses here. `railway-prod` refreshes `last_heartbeat_at` every 30 s for
every clinic in its in-memory session map — and clinic `caf2711f-…` is in that
map even though its row reads `status=disconnected, desired_state=offline` and
there is **no `clinic_channels` row for WhatsApp at all**. Railway is holding a
seat for a clinic it is not serving, forever.

Worth stating plainly, because it changes what to expect from the first
successful local start: **there is no linked WhatsApp session on the hosted
project right now.** `clinic_channels` has no `whatsapp` row,
`phone_number` is null, and `whatsapp_linked_device_auth` holds a single
`creds/state` blob from the pairing attempt at 18:57 that never completed. So the
first local connection will be a **fresh QR scan**, not a silent restore. The
restore-without-rescan path is real and unchanged — it simply has nothing to
restore yet.

---

## 12. Files changed

**Source (committable):**

| File | Change |
|---|---|
| `services/whatsapp-worker/src/store.ts` | `upsertSession` → `writeSessionState`. A row this worker owns is updated in place (`WHERE clinic_id AND worker_id = self`) with a fresh heartbeat, as before. A row it does not own gets the clinic-visible columns and **nothing else**: no `worker_id`, no `last_heartbeat_at`, no `handoff_to`. `claimSession` is now the only write in the worker that contains `worker_id`. |
| `supabase/migrations/20260829200000_p11m_linked_device_handoff_self_normalize.sql` | **new** — a `before insert or update` trigger that collapses `handoff_to = worker_id` to `NULL`. A worker holding a session has by definition answered any request naming itself; this is the same conclusion `claimSession` already draws in SQL, applied to every writer. The P11K check constraint is deliberately kept — it is now unreachable, and it documents the invariant should the trigger ever be dropped. |
| `services/whatsapp-worker/tests/harness.ts` | every `FakeStore` session write goes through one `commit()`, which throws SQLSTATE 23514 exactly where Postgres does; `writeSessionState` mirrors the store's owned/not-owned split |

`sessions.ts`, `config.ts`, `index.ts`, `server.ts` and the whole application
side are **untouched**. The ownership predicate, `HEARTBEAT_STALE_MS`,
`HANDOFF_TTL_MS` and the handoff fence are byte-identical to P11K.

**Tests added:**

| File | Covers |
|---|---|
| `services/whatsapp-worker/tests/ownership-handoff.test.ts` (+4) | the 23514 violation via `logout()` on a requested clinic; that a status write never takes a session; that an owner's heartbeat still moves forward; and **three full local → production → local cycles**, each with a fresh laptop process, asserting after every step that no two managers hold the clinic, no two sockets are live, and `handoff_to ≠ worker_id` |
| `services/whatsapp-worker/tests/p11m-ownership-database.test.ts` | **new** — the real `Store` against real Postgres/PostgREST on the local stack: stale-heartbeat adoption, the fence, request-without-touching-the-holder, self-request refusal, the trigger, the owned/not-owned write split, and three full handoff cycles. Skips itself when the local stack is not up, and refuses to run against any non-loopback URL. |

---

## 13. Tests and results

```
$ pnpm whatsapp:worker:test
ℹ tests 181   ℹ pass 181   ℹ fail 0        # 177 before, +4 new ownership cases

$ TEST_SUPABASE_SERVICE_ROLE_KEY=<local service role> \
    node --test --experimental-strip-types tests/p11m-ownership-database.test.ts
ℹ tests 10    ℹ pass 10    ℹ fail 0        # real Postgres + PostgREST

$ pnpm whatsapp:worker:typecheck            # clean
```

**The two new regression tests were confirmed to fail against the old code.**
`FakeStore.writeSessionState` was temporarily reverted to the unconditional
`worker_id` stamp and the suite re-run:

```
✖ does not violate the self-handoff constraint when logging out a requested clinic
✖ never takes a session through a status write
  Error: new row … violates check constraint "whatsapp_linked_device_sessions_handoff_not_self"
    code: '23514'
ℹ pass 17   ℹ fail 2
```

That is the reported bug, reproduced in the suite, then fixed.

One result deserves calling out: **`claimSession` chains two `.or()` filters**,
and whether PostgREST ANDs two `or=` parameters — rather than letting the second
replace the first — is a property of PostgREST, not of this codebase. A fake
store agrees with whatever its author assumed; if the second group were being
dropped, every fence assertion in the in-memory suite would still pass and the
fence would not exist in production. `fences the releasing worker out with the
second predicate group` puts that question to the real server: with the seat
free and only the fence standing, `railway-prod`'s equivalent is refused and the
requester wins. It passes.

**Normal QR pairing, re-verified end to end** after the store refactor, against
the local stack with a clinic nobody owned:

```
$ curl -X POST .../v1/sessions/93000000-…/start
{"ok":true}   HTTP 200

$ # the row the settings panel polls
awaiting_scan | local-qr-test | qr_len=237 | expires 2026-08-29T19:22:58Z | desired_state=online
```

A real 237-character WhatsApp pairing payload with a live expiry. Unchanged.

The app suite and `tsc --noEmit` were run as a regression check; no application
source was modified.

---

## 14. Migration and deployment status

| | Status |
|---|---|
| `20260829120000_p11k_…_ownership_handoff.sql` (`handoff_to`, `handoff_requested_at`, not-self check, partial index) | **already applied on hosted** — verified directly against `information_schema` and `pg_constraint`. Nothing to do. |
| `20260829200000_p11m_…_handoff_self_normalize.sql` (the trigger) | **applied locally. NOT applied to hosted** — see below. |
| Railway worker deployment | **REQUIRED, and not done.** See below. |

### The P11M migration on hosted

Not applied, deliberately: the brief was not to deploy, and a trigger on a
production table is a schema change. It is **not required for correctness** — the
worker-side split in §12 already makes the violating row unbuildable by any
worker. It is defence in depth, so that the application, a future worker, or an
operator at a `psql` prompt cannot recreate the state either. Purely additive,
idempotent, rewrites no existing row. Say the word and it takes one statement.

### The Railway deployment — the one thing that is genuinely blocking

**A one-time deployment of the current worker code to Railway is required** for
"local safely takes ownership from `railway-prod`" to work at all. Not because
of anything in this change, but because P11K's holder-side half
(`honorHandoffs`) has never been committed or deployed (§11.3), and a
cooperative handoff cannot be performed by one side alone. This was not done —
the brief was explicit — and it is reported here as the outstanding item.

There is one partial workaround that needs **no code deployment**, and its limit
should be understood before it is relied on: **restarting the Railway service
once** from the dashboard. On `SIGTERM` even the pre-P11K worker releases
ownership, and on boot its `restoreAll` reads `desired_state` — which for this
clinic is `offline` — so it restores nothing, holds nothing, and stops
heart-beating that row entirely. Ninety seconds later the seat is stale and the
local worker claims it cleanly, through the ordinary fenced claim, with no
handoff involved. That is enough to link the device from localhost today.

Its limit: it works **once, while the clinic is offline**. Once the device is
linked from localhost the row goes `desired_state=online`, and after that a
restarted Railway instance will restore the clinic whenever the laptop is not
holding it — which is correct and is exactly what "Railway can recover" means.
But it also means the *next* time the laptop wants the session while Railway is
actively holding it, the seat is occupied by a worker that still cannot hear a
handoff request. Only the deployment fixes that permanently.

Everything else the brief asked for behaves correctly with the deployment in
place, and is proven by the cycle tests in §13:

| Requirement | Behaviour |
|---|---|
| Local start takes ownership from `railway-prod` safely | asks via `handoff_to`; the holder closes its socket **then** releases; local wins the same fenced claim every adoption uses |
| Never two sockets | asserted after every step of every cycle; the release order is what guarantees it |
| Restores the existing session without a new QR | unchanged — nothing is logged out and no identity is destroyed by a handoff (nothing to restore *yet*, see §11.4) |
| `Ctrl+C` releases so Railway can restore | `shutdown()` releases ownership and withdraws any outstanding request; `desired_state` stays `online`; Railway's reconcile adopts within 60 s |
| Local crash recovery | no release, heartbeat stops, `HEARTBEAT_STALE_MS` (90 s) elapses, Railway's reconcile adopts |
| `handoff_to` never equals `worker_id` | unreachable from the worker (§12) and normalised by the database (§14) |
| Normal QR when nothing is linked | re-verified, §13 |

---

## 15. Local configuration — restored to hosted

Git-ignored, this machine only. Previous copies kept as
`.env.development.local.localsupabase.bak.<epoch>` and
`services/whatsapp-worker/.env.localsupabase.bak.<epoch>`.

| File | Now |
|---|---|
| `.env.development.local` | Supabase overrides **removed** — the dev server reads the hosted project from `.env.local`. Retains only `NEXT_PUBLIC_SITE_URL=http://localhost:3000` and `WHATSAPP_WORKER_URL=http://127.0.0.1:8787`. |
| `services/whatsapp-worker/.env` | `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` → **hosted**; `PORT=8787`; `WORKER_ID=local-dev`; `WHATSAPP_DEV_TAKEOVER=1` |

The three shared secrets (`WHATSAPP_WORKER_TOKEN`,
`WHATSAPP_WORKER_CALLBACK_SECRET`, `MESSAGING_CREDENTIALS_KEY`) were verified
byte-identical across `.env.local` and the worker's `.env` by hash. The comment
in the old worker `.env` calling `MESSAGING_CREDENTIALS_KEY` "LOCAL-ONLY" was
wrong and has been corrected — it is the same key the hosted credentials are
encrypted with, which is what makes a hosted session decryptable from the laptop.

Resolved through Next's own loader (`@next/env`), so this is what `next dev`
sees rather than what the files appear to say:

```
NEXT_PUBLIC_SUPABASE_URL = https://ayzetxywrqouqpurbjuv.supabase.co
WHATSAPP_WORKER_URL      = http://127.0.0.1:8787
NEXT_PUBLIC_SITE_URL     = http://localhost:3000
- Environments: .env.development.local, .env.local
```

**An env change requires a dev-server restart.** Next reports the file set once,
at boot.

### Running it

```
Terminal 1:  pnpm dev                    # localhost:3000, hosted database
Terminal 2:  pnpm whatsapp:worker:dev    # 127.0.0.1:8787, hosted database, local-dev
```

Until Railway is redeployed or restarted, *Connect with QR* will answer
`owned_elsewhere` and the worker will log which instance holds the clinic and
how old its heartbeat is — which is the whole diagnosis, in one line.

---

## 16. Push and production safety

- **No hosted schema was changed and no hosted row was left modified.** The
  handoff request written during the §11.3 verification was withdrawn by the
  worker's own shutdown path; the row was re-read afterwards and is byte-for-byte
  as it was found: `worker_id=railway-prod`, `handoff_to=null`,
  `status=disconnected`, `desired_state=offline`.
- **Railway was not touched.** Not deployed, not restarted, not reconfigured.
- **The production WhatsApp device was not logged out** and no auth row was
  deleted.
- The source change is a strict *narrowing* of what a write may touch. It removes
  an ownership bypass and adds nothing; no path gains a capability.
- Single-owner protection is unchanged and now covered by real-database tests.
- **Not pushed. Not deployed.** Working tree only.
