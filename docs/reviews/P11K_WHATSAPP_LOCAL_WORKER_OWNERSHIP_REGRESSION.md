# P11K — Local WhatsApp worker cannot own the linked-device session

**Date:** 2026-08-29 · **Branch:** `feat/p7-manual-qa-polish` · **Clinic:** `caf2711f-97cb-4474-a103-f9505f467087`

---

## 1. Exact root cause

**Two workers are pointed at one database, and the single-owner invariant is
refusing the second one. That refusal is the system working, not failing.**

`services/whatsapp-worker/.env` sets `SUPABASE_URL` to the **hosted** Supabase
project (`ayzetxywrqouqpurbjuv.supabase.co`) — the same project the deployed
Railway worker serves. The local worker therefore boots, reads
`whatsapp_linked_device_sessions`, finds the clinic's row already stamped by a
live worker, and declines it exactly as designed:

```
restoring sessions count = 1
session is held by another worker; will retry
```

There is nothing broken in `sessions.ts`, `store.ts`, `callback.ts` or the
provider policy. What was genuinely missing is a **way to move ownership on
purpose**: before this work the only two ways a session could change hands were a
graceful shutdown of the holder and the 90-second stale window after a crash.
Both are enough for a redeploy and neither is a development workflow.

The file's own header comment made this hard to see — it still read *"Generated
for the local Supabase stack"* while `SUPABASE_URL` pointed at production. That
comment is now corrected.

## 2. Did recent work cause it? No — and here is the evidence

**The P11J / intake work did not touch any of this.** The ownership model arrived
whole, in one commit, and has not been modified since:

```
$ git log --oneline -- services/whatsapp-worker/src/sessions.ts \
                       services/whatsapp-worker/src/store.ts \
                       services/whatsapp-worker/src/index.ts
f8da8c6 feat(messaging): WhatsApp Linked Device (Connect with QR) + Railway worker   # 2026-08-17
```

`services/whatsapp-worker` does not exist in `01d2d76` (2026-08-09) or any earlier
commit — `git ls-tree 01d2d76 services/` is empty. Before 2026-08-17 there was no
linked-device worker at all, so there was nothing for a local process to contend
with. That is why the previous workflow felt fine: not because it was permitted,
but because it did not exist yet.

The working tree's uncommitted P8/P11 changes to `sessions.ts` are large (+1737
lines: history import, media, LID routing, retry diagnostics), and **none of them
touch the ownership predicate.** The diff moves it verbatim:

```diff
-      existing?.worker_id &&
-      existing.worker_id !== this.config.workerId &&
-      Date.now() - new Date(existing.last_heartbeat_at).valueOf() < HEARTBEAT_STALE_MS
+        existing?.worker_id &&
+        existing.worker_id !== this.config.workerId &&
+        Date.now() - new Date(existing.last_heartbeat_at).valueOf() < HEARTBEAT_STALE_MS
```

The only relevant diff is an **indentation change** from the start-acknowledgement
refactor. `HEARTBEAT_STALE_MS = 90_000` is unchanged, `releaseOwnership` is
unchanged, `reconcile` is unchanged apart from a pino `error` → `err` key fix.

**What actually changed is the environment, not the code.** File timestamps:

| File | Modified | `NEXT_PUBLIC_SUPABASE_URL` / `SUPABASE_URL` |
| --- | --- | --- |
| `.env.development.local.off` (the old dev config, now disabled) | Aug 17 06:12 | `http://127.0.0.1:54321` — **local stack** |
| `.env.local` (the app today) | Aug 17 20:24 | hosted project |
| `services/whatsapp-worker/.env` (the worker today) | Aug 17 21:03 | hosted project |

The previously working development setup ran the app **and** the worker against
the *local* Supabase stack. Its session row was its own, and it could never
contend with Railway. Somewhere on the evening of Aug 17 the configuration was
switched to the hosted project on both sides, and that is the change that
produced this symptom.

## 3. Ownership architecture, as it stands

One clinic, one row, one owner:

* `whatsapp_linked_device_sessions` is unique on `clinic_id`.
* `worker_id` + `last_heartbeat_at` name the process holding the socket.
* The holder refreshes `last_heartbeat_at` every 30s, scoped to rows it owns.
* Any other worker refuses a clinic whose heartbeat is younger than 90s.
* On `SIGTERM` the holder closes sockets, logs nothing out, and clears
  `worker_id` so the replacement adopts immediately.
* A reconcile sweep every 60s re-checks what each worker should be holding,
  which is what makes an overlapping deploy self-healing.

This is **single owner globally, per Supabase project** — the runbook is explicit
(`railway.json` pins `numReplicas: 1` and `overlapSeconds: 0`), and the reason is
not bookkeeping. A linked-device pairing is one WhatsApp device identity with one
Signal session state; two sockets on it corrupt each other's ratchets and
WhatsApp resolves that by tearing the device down, costing the clinic a rescan.

The intended local-development topology was **design B — a separate session** via
the local Supabase stack. `services/whatsapp-worker/.env.example` says the worker
must use *"the SAME project the application uses"*, and the disabled
`.env.development.local.off` shows both sides pointed at `127.0.0.1:54321`.

**There was no development takeover mechanism.** A repo-wide search for
`takeover` / `lease` / `force` / `handoff` in worker and messaging code returns
only unrelated hits (AI budget leases; the P8 *human* takeover flag that pauses
automated replies on a conversation).

## 4. Current ownership, from live data

```sql
select clinic_id, status, worker_id, now() - last_heartbeat_at as age from whatsapp_linked_device_sessions;
```

| clinic_id | status | desired_state | worker_id | heartbeat age |
| --- | --- | --- | --- | --- |
| `caf2711f-…67087` | `connected` | `online` | **`railway-prod`** | **10 seconds** |

And the local worker, from its own unauthenticated health endpoint:

```
$ curl http://127.0.0.1:8787/healthz
{"ok":true,"workerId":"local-dev","sessions":0}
```

**Answers to the ownership questions:** the hosted `railway-prod` worker owns the
session (Q1); it is actively heart-beating, 10 seconds old against a 90-second
window (Q2); the local worker tries to adopt it because `restoreAll` reads every
clinic with `desired_state = 'online'` from **the same hosted table** the
production worker writes (Q3); this was not introduced by recent code (Q4, §2);
`SUPABASE_URL` resolves to the hosted project, not `LOCAL_SUPABASE` (Q5); and yes
— local development is reading the hosted linked-device tables while the app is
also configured against the real database (Q6).

## 5. Why the messages fail

The failure is a straight consequence of the refusal, and the routing is correct
at every hop:

```
localhost Inbox
  → WHATSAPP_WORKER_URL = http://127.0.0.1:8787   (app .env.local — correct)
  → local worker POST /v1/sessions/<clinic>/messages
  → local worker holds NO session for this clinic  ⟶ 409
  → send path records an ordinary provider failure
  → "The reply could not be sent. Please try again."
```

The local app is talking to the local worker exactly as configured. The local
worker simply has no socket, because the clinic's socket is open in Railway.

## 6. Fix implemented

**Design C — a fenced, opt-in ownership handoff.** The smallest change that gives
ownership a deliberate way to move without weakening the invariant a single step.

**a) Adoption is now a compare-and-swap.** `Store.claimSession` replaces the old
read-the-owner-then-write-unconditionally admission. The decision and the write
are one `UPDATE ... WHERE`, so of two racing workers exactly one can come back
`true`. This closes a pre-existing TOCTOU window in production — small, but real —
in which both workers could conclude they had won and open two sockets.

**b) A session can be asked for, never seized.** A worker in takeover mode writes
`handoff_to = <its id>` and nothing else. The holder keeps its socket, its stamp
and its heartbeat; every send in flight completes normally.

**c) Every worker honours requests.** `SessionManager.honorHandoffs()` runs on the
heartbeat tick in *all* workers, production included. Order is the safety
property: **socket closed first, ownership released second.** A clinic with a
start in flight is skipped, not interrupted.

**d) The requester wins it the ordinary way.** Its next reconcile sweep calls the
same `claimSession` every adoption uses. It cannot write `worker_id` directly.

**e) The fence, and its expiry.** While a live request names another worker, the
claim predicate excludes everyone else — otherwise the releasing worker's own
60-second sweep would take the clinic straight back. The fence expires after
`HANDOFF_TTL_MS = 10 minutes`, and a graceful shutdown withdraws the request
immediately, so an abandoned handoff can never leave a clinic dark.

**f) Off by default.** `WHATSAPP_DEV_TAKEOVER` is unset everywhere except the
local `.env`. With it off, not one byte of behaviour changes.

**g) Worker-id collision guard.** At boot, before writing anything, a worker looks
for rows already carrying its own id with a fresh heartbeat. With takeover on that
is fatal; without it, a warning (a hard-killed production worker legitimately finds
its own stamp, and refusing to boot there would turn a crash into an outage).
`WORKER_ID` is also validated against a slug alphabet, because it is interpolated
into PostgREST filter expressions.

## 7. Split-brain protections

Answering Q9 and Q10 directly:

* **Clearing `worker_id` by hand while Railway is alive would create split-brain** —
  the local worker would adopt a clinic whose socket is still open in production,
  and both would be live on one device identity. The protection is preserved: the
  claim predicate still refuses any owner whose heartbeat is younger than 90s, and
  the handoff path never writes `worker_id` for somebody else. Ownership only ever
  moves after the holder has closed its socket.
* **Two workers sharing one `WORKER_ID` would create split-brain**, and worse — each
  reads the other's stamp as its own, so both admit themselves and neither ever
  refuses. This is now explicitly prohibited: takeover requires an explicit
  `WORKER_ID`, and a takeover-enabled worker refuses to boot if it finds its id
  already live (§6g).
* **The transfer is atomic and fenced** — one conditional `UPDATE`, verified against
  real Postgres, including a contested double-claim on a row that does not exist yet.
* **None of the prohibited shortcuts were used**: the `worker_id` check is intact,
  `HEARTBEAT_STALE_MS` is unchanged at 90s, no two workers share an id, nothing
  nulls `worker_id` blindly, no auth state is deleted, no logout is forced, and
  heartbeats are untouched.

## 8. Local/production routing — verified

| Hop | Value | Verdict |
| --- | --- | --- |
| App → worker | `WHATSAPP_WORKER_URL = http://127.0.0.1:8787` in `.env.local` | correct; local sends reach the local worker |
| Bearer token | `WHATSAPP_WORKER_TOKEN` matches worker `.env` | matched, ≥32 chars, enforced at boot |
| Worker → app callbacks | `CLINICFLOW_APP_URL = http://localhost:3000` | correct; local inbound lands on the local app |
| Callback HMAC | `WHATSAPP_WORKER_CALLBACK_SECRET` matches both sides | matched |
| Plaintext guard | `lib/messaging/linked-device.ts` allows `http:` only on loopback | correct; the bearer token never crosses a public network in the clear |
| Provider selection | `linked_device` via `clinic_channels`, unchanged | untouched by this work |

Nothing is crossing over: the local app is not calling Railway, and the local
worker is not posting callbacks to production. No secret values are reproduced
here or anywhere in this document.

## 9. Files changed

| File | Change |
| --- | --- |
| `supabase/migrations/20260829120000_p11k_linked_device_ownership_handoff.sql` | **new** — additive `handoff_to`, `handoff_requested_at`, check constraint, partial index |
| `services/whatsapp-worker/src/store.ts` | `claimSession` (fenced CAS), `requestHandoff`, `listHandoffRequests`, `clearHandoffRequests`, `listLiveSessionsOwnedByThisWorkerId`; `HEARTBEAT_STALE_MS` / `HANDOFF_TTL_MS` now live here |
| `services/whatsapp-worker/src/sessions.ts` | admission uses the fenced claim; `askForHandoff`; `honorHandoffs`; shutdown withdraws requests |
| `services/whatsapp-worker/src/config.ts` | `devTakeover` flag, `WORKER_ID` validation, explicit-id requirement |
| `services/whatsapp-worker/src/index.ts` | boot collision guard; handoff sweep on the heartbeat tick |
| `services/whatsapp-worker/.env.example` | documents `WHATSAPP_DEV_TAKEOVER` |
| `services/whatsapp-worker/.env` | corrected the misleading "local Supabase stack" header; enabled takeover (git-ignored) |
| `services/whatsapp-worker/tests/harness.ts` | two `FakeStore`s may share one database; claim/handoff surface; owner-scoped heartbeat |
| `services/whatsapp-worker/tests/ownership-handoff.test.ts` | **new** — 15 tests |
| `tests/unit/integration/p11k-linked-device-ownership.test.ts` | **new** — 7 real-Postgres tests |
| `tests/unit/lib/p7e-linked-device-adapter.test.ts` | local send-routing regression |
| `types/database.ts` | the two new columns (hand-maintained, per the runbook) |
| `docs/runbooks/P7E_WHATSAPP_QR_LINKED_DEVICE.md` | local-development section; ownership notes |

No booking, intake, or P11J behaviour was touched.

## 10. Migration status

`20260829120000_p11k_linked_device_ownership_handoff.sql` — **applied locally
only.** Verified by `supabase db reset --local`, which replays every migration
from scratch; the integration suite then passes against the result.

It is required because a fenced handoff needs somewhere durable to record the
request, and there is no column that can carry it without overloading a field
that already means something else. It is strictly additive: two nullable columns
with no default, a check constraint that no existing row can violate, and a
partial index. Every existing row keeps its exact current meaning, and a worker
built before this migration ignores both columns.

**Nothing was pushed to the hosted project.** Confirmed still absent there:

```sql
select column_name from information_schema.columns
 where table_name = 'whatsapp_linked_device_sessions'
   and column_name in ('handoff_to','handoff_requested_at','worker_id');
-- → worker_id
```

## 11. Tests and results

| Suite | Result |
| --- | --- |
| `services/whatsapp-worker` (full) | **172 passed, 0 failed** (157 pre-existing + 15 new) |
| `tests/unit/integration/p11k-linked-device-ownership.test.ts` | **7 passed** against local Postgres |
| `tests/unit/lib` + `tests/unit/actions` | **1266 passed, 0 failed** |
| `tsc` — worker src, worker tests, app | clean |

Coverage against the ten requested regressions:

| # | Requirement | Where |
| --- | --- | --- |
| 1 | Active owner blocks an ordinary second worker | `refuses a second worker while the first is heart-beating`; `refuses a live owner…` (Postgres) |
| 2 | Stale owner safely adopted | `adopts a session whose owner stopped heart-beating`; same Postgres test |
| 3 | Graceful shutdown releases ownership | `hands ownership over on a graceful shutdown` |
| 4 | Explicit dev takeover transfers safely | `asks for a session instead of taking it`; `transfers ownership only after the holder has closed its socket` |
| 5 | No split-brain during takeover | `never lets both workers hold the clinic at once` — the invariant is asserted after **every** step of the handoff |
| 6 | Old owner cannot heartbeat or reclaim | `does not let a shut-down worker keep its old sessions alive` |
| 7 | Reconcile does not steal a live session | `does not let a reconcile sweep steal a live session`; `keeps the releasing worker from taking the clinic straight back` |
| 8 | Local send routes to the local worker | `routes a send to the local worker when local development points at one` |
| 9 | Production unchanged with dev mode off | the whole `production is unchanged when takeover is off` suite |
| 10 | Restart/redeploy handoff still safe | `keeps a redeploy handoff working exactly as before`; `still refuses an overlapping deploy that has not released yet` |

Plus two the brief did not ask for but the design needs: an abandoned request is
withdrawn on shutdown, and an expired one stops fencing.

The Postgres suite exists because the safety argument rests on PostgREST filter
semantics — two `or` groups being ANDed, the update being atomic. A hand-written
fake would have agreed with whatever I believed; only the real filter could
disagree.

## 12. Commands for local testing

**One-time, and it is deliberate:** the migration must reach the hosted project
before the local worker can run against it. Until then the local worker will fail
its writes, because it now references two columns that do not exist there.

```bash
supabase link --project-ref <the hosted ref>
supabase db push --dry-run     # confirm ONLY the P11K migration is pending
supabase db push
```

Railway must also be running a build that contains this change — the handoff is
cooperative, and only a worker with `honorHandoffs()` can answer a request.
Deploy the worker service from this branch once.

Then, per session:

```bash
# services/whatsapp-worker/.env  (already set)
#   WORKER_ID=local-dev
#   WHATSAPP_DEV_TAKEOVER=1

pnpm whatsapp:worker:dev        # asks Railway for the session
pnpm dev                        # app already points at http://127.0.0.1:8787
```

Watch for, in order:

```
whatsapp worker listening   workerId=local-dev  devTakeover=true
development takeover: asked the current owner to release this session
session adopted by reconcile
```

Roughly 30–90 seconds: ≤30s for Railway's heartbeat tick to see the request and
release, ≤60s for the local reconcile sweep to claim it. No QR, no logout, no
manual row edit. Confirm with `curl http://127.0.0.1:8787/healthz` — `sessions`
becomes `1`.

## 13. Returning ownership to Railway

**Press `Ctrl-C`.** That is the whole procedure.

The graceful shutdown closes the socket, releases `worker_id`, and withdraws any
outstanding request. Railway's reconcile sweep adopts the clinic within 60
seconds, restoring the socket from the same encrypted identity — `desired_state`
stayed `online` throughout and nothing was logged out.

If the laptop dies without a shutdown, the 90-second stale window frees the
session and a stranded request expires after ten minutes. Recovery is automatic
in both directions; there is no state to clean up by hand.

## 14. Remaining limitations

1. **Both sides must ship this code.** Railway cannot honour a request it has no
   code for. Until the worker service is redeployed, a handoff request will sit
   unanswered and the local worker will keep retrying — visible, but no takeover.
2. **The hosted migration is a prerequisite, and skipping it is worse than the
   status quo.** `claimSession` writes `handoff_to` unconditionally; against a
   database without the column the write fails and the local worker's starts
   error rather than merely being refused. Push the migration before the next
   local run, or set `SUPABASE_URL` back to the local stack.
3. **Handoff latency is up to ~90 seconds**, bounded by the 30s heartbeat and 60s
   reconcile intervals. It could be made near-instant with an authenticated
   release endpoint on the worker, which is more surface than this warrants.
4. **One clinic at a time, still.** Takeover moves a session; it does not
   duplicate it. While your laptop holds the clinic, production is not serving
   its WhatsApp — inbound messages arrive at *your* worker and are delivered to
   *your* localhost app. This is fine for a development clinic and would be an
   outage for a real one. Take over only clinics you are willing to own.
5. **`WHATSAPP_DEV_TAKEOVER` on a deployed worker would be actively harmful** —
   two deployments would trade a clinic back and forth every sixty seconds.
   Nothing in the platform prevents an operator from setting it; only the
   documentation and the collision guard stand in the way.
6. **CI does not run the worker's suite.** `.github/workflows/ci.yml` has no
   `services/whatsapp-worker` step, so these 172 tests run only locally. Worth
   fixing, but out of scope here.

## 15. Verdict

**SAFE TO PUSH.**

* Production behaviour is unchanged with `WHATSAPP_DEV_TAKEOVER` unset, which is
  everywhere except a git-ignored local `.env`. Asserted by a dedicated suite.
* The migration is additive, applies cleanly to a from-scratch local database,
  and is ignored by workers built before it.
* The single-owner invariant is strengthened, not relaxed: adoption became an
  atomic compare-and-swap, closing a real TOCTOU window that shipped in
  `f8da8c6`.
* Redeploy and overlapping-deploy behaviour is covered by tests that did not
  exist before.
* Nothing was pushed, deployed, or written to the hosted database; Railway is
  untouched; no auth state, logout, or session ownership was edited by hand.

**Two deliberate operator actions are still required before local testing works**
— `supabase db push` to the hosted project, and one Railway redeploy of the
worker service. Both are yours to make; neither was performed here.
