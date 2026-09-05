# P8 — WhatsApp linked device: the start/logout race

Date: 2026-08-18
Branch: `feat/p7-manual-qa-polish`
Scope: `services/whatsapp-worker` — `src/sessions.ts`, `src/auth-state.ts`
Status: fixed, tested, **not deployed**

---

## 1. What was observed

A clinic pressed *Generate QR code*, got no code, and pressed *Unlink*. Both
requests succeeded. The device identity came back anyway.

```
POST /v1/sessions/:clinicId/start   → 200
  whatsapp_linked_device_sessions:
    status         = starting
    desired_state  = online
    qr_payload     = null          ← no code had been issued yet

POST /v1/sessions/:clinicId/logout  → 200
  logout() ran, and called store.clearAuth()

…and immediately afterwards:
  whatsapp_linked_device_auth contains creds/state again
    created_at = 2026-08-18T03:04:30.721625Z   ← the same second the logout ran
```

Nothing had failed. `clearAuth()` deleted the rows exactly as asked. They were
re-created, a few milliseconds later, by the start the logout had raced.

## 2. Why it happened

`start()` deliberately answers early. The application calls it from inside a
request with a few seconds to live, and a Baileys handshake regularly takes
longer than that, so the two halves were separated in P7:

* **Admission** — prove the clinic is not owned by another worker, write
  `status = starting, desired_state = online`, answer the caller. Fast.
* **Opening** — load the auth state, write a device identity if this is a new
  pairing, fetch the protocol version, open the socket, wire the handlers.
  Asynchronous, unbounded, and running with nobody waiting on it.

So `status = starting, qr_payload = null` is not a stuck state. It is the
completely ordinary state of a clinic whose start has been admitted and whose
socket has not arrived yet — which is precisely when a clinic that sees no code
presses *Unlink*.

`logout()` handled the live-socket case and the nothing-here case. It had no
concept of the in-between one. Concretely, it cancelled reconnect timers and
(via `start()`'s `finally`) the `starting` map entry was eventually removed —
but the entry is a **handle, not the work**. The promise it pointed at went on
running, holding its own `LinkedDeviceAuthState`, and reached:

```ts
// src/sessions.ts, open()
const auth = await useSupabaseAuthState(this.store, clinicId, this.config.credentialsKey);
if (!auth.restored) await auth.saveCreds();   // ← re-created the rows clearAuth had just deleted
```

`auth.restored` was false — because `clearAuth()` had *just* emptied the table —
so the start dutifully wrote a brand-new identity into it. The logout made the
bug more likely rather than less.

Deleting the `starting` entry could never have fixed this, and awaiting it could
not either: the work may be blocked in a handshake that never returns, and
`/logout` cannot hang on it.

### The rest of the blast radius

`saveCreds` was the write the report caught, but it is not the only thing an
orphaned start can do. Everything below was reachable after a successful logout:

| Path | What the stale start could still do |
| --- | --- |
| `open()` → `auth.saveCreds()` | Re-create `whatsapp_linked_device_auth` (**observed**) |
| `open()` → `sessions.set()` | Publish a socket for a clinic with no pairing |
| `startUncoordinated()` → `upsertSession()` | Put `desired_state = online` back on an offline clinic |
| `onConnectionUpdate({ qr })` | Write a QR into a row that says `disconnected` |
| `onOpen()` → `activateChannel()` | Re-create the `clinic_channels` row |
| `onOpen()` → `setStatus("connected")` | Report a logged-out clinic as connected |
| `onClose()` → `setTimeout(open)` | Reconnect the pairing minutes later |
| Baileys' `creds.update` / Signal key store | Write auth on its own schedule, for the life of the socket |

The last row is why a check placed inside `open()` cannot be sufficient on its
own: Baileys keeps the auth state object and writes through it whenever it
likes, long after `open()` has returned.

## 3. The fix

### 3.1 A per-clinic epoch, and a token every start carries

Each clinic has a monotonic epoch. A start captures the epoch current when it is
created and carries that capture — a `StartToken` — through every asynchronous
hop it makes, into the `Session` it publishes, into the handlers that session
registers, into the reconnects those handlers schedule, and into the auth state
Baileys retains.

```ts
type StartToken = { clinicId: string; epoch: number };

private issueToken(clinicId: string): StartToken {
  return { clinicId, epoch: this.epochs.get(clinicId) ?? 0 };
}

private isCurrent(token: StartToken): boolean {
  return (this.epochs.get(token.clinicId) ?? 0) === token.epoch;
}

private invalidate(clinicId: string): void {
  this.epochs.set(clinicId, (this.epochs.get(clinicId) ?? 0) + 1);
}
```

`invalidate()` is one synchronous statement with no await in the middle, so it
revokes every outstanding token in a single indivisible step. There is nothing to
find, await or unwind. The stale work keeps running — it must, because it may be
wedged — but it runs **mute**.

### 3.2 Guarded writes, and a barrier for the ones already in flight

An epoch bump stops writes from being *admitted*. It cannot recall one that was
already in flight when the bump happened, and such a write could otherwise land
after the logout's own cleanup and undo it. So every state-publishing step goes
through one place, which both checks currency and records the write while it runs:

```ts
private async guarded<T>(token, action): Promise<{ ran: true; value: T } | { ran: false }>
```

and `logout()` waits for the recorded set to drain before it cleans up:

```ts
private async quiesce(clinicId: string): Promise<void>
```

Because `invalidate()` runs first, the set can only shrink from that moment, so
`quiesce()` is a genuine barrier rather than a hopeful wait. It is bounded: each
entry is a single store statement, never the start itself.

### 3.3 A revoked auth state, for the writes the manager does not initiate

`revocableAuthState()` (new, in `src/auth-state.ts`) wraps the auth state so that
every *write* it can perform — `saveCreds` and the Signal key store's `set` — is
subject to the same guard. `open()` hands Baileys the wrapper rather than the raw
state, so the object Baileys keeps for the life of the socket becomes incapable of
persisting anything once the start is revoked.

Reads stay open (a refused read would make Baileys regenerate key material rather
than stop) and `clear()` stays open (it *is* the teardown).

### 3.4 Currency checks at every asynchronous boundary

`open()` re-checks after the auth load, after the identity write, and after the
handshake. Between the last check and `sessions.set()` there is no `await`, so
publication is atomic with respect to a logout. `onConnectionUpdate` re-checks
before it will say anything at all, and `onClose` re-checks before it will
reconnect.

### 3.5 A socket that arrives after cancellation is discarded, not logged out

```ts
if (this.shuttingDown || !this.isCurrent(token)) {
  this.discard(clinicId, socket, this.shuttingDown ? "shutdown" : "cancelled");
  return;
}
```

`discard()` calls `end()`, never `logout()`: the clinic's own teardown has already
unlinked the device, and this connection was never published, never wired to a
handler and never wrote anything. It is closed before a single `ev.on` is attached
to it, so it cannot emit into the manager even in principle.

### 3.6 `logout()` in order

```
1. invalidate(clinicId)          ← synchronous; revokes every outstanding token
   cancelReconnect(clinicId)
   starting.delete(clinicId)     ← so the *next* /start builds a fresh one
   sessions.delete(clinicId)
2. await quiesce(clinicId)       ← let already-admitted writes land
3. socket.logout() / end()       ← unlink on the phone, if there was a socket
   clearAuth + removeChannel     ← now the last word
   setStatus(disconnected/offline)
```

Step 1 is the whole fix; steps 2 and 3 are what make the cleanup final.
`tearDown()` — the involuntary path, for `loggedOut` / `badSession` /
`pairing_failed` — now takes the same two steps for the same reason.

### 3.7 Teardown failures are reported

`clearAuth` and `removeChannel` failures were swallowed with `.catch(() => undefined)`.
That is how this bug stayed invisible: a `clearAuth` whose rows were re-created a
moment later looked identical to a clean teardown from the outside. Both now log,
through `releaseIdentity()`, and both are still non-fatal — a clinic must never be
left unable to finish unlinking because one delete failed.

Redaction is `describeError()`, which emits the error's **class name** and a
200-character truncation of its message, and never `{ err: error }`. pino
serializes an `Error` with its stack and its own enumerable properties, and the
errors on this path come from Baileys and PostgREST, which attach payloads, JIDs
and row contents. `Store` has already reduced PostgREST failures to their primary
message before throwing (its `safeDbError` drops `details`/`hint`, which are the
fields Postgres embeds actual values in). No credential, phone number, JID, auth
value or Signal material can reach a log line by this route.

## 4. What was deliberately preserved

| Property | How it survives |
| --- | --- |
| Fast `/start` acknowledgement | Admission is unchanged; the token adds no await. Asserted at < 1s in `sessions-start.test.ts`. |
| Idempotent concurrent starts | `starting` is still the single in-flight entry; three starts still produce one handshake. |
| `OWNED_ELSEWHERE` | The ownership read happens before any guard and is untouched. |
| Worker restore / reconcile | Both call `start()`, which issues a current token; `settle()` is unchanged. |
| Tenant isolation | Epochs are keyed by clinic id. Logging out clinic A cannot revoke clinic B's token. |
| Auth encryption | `revocableAuthState` delegates to the same `useSupabaseAuthState` writes; nothing about the AES-256-GCM envelope changed. |
| Reconnect for legitimate sessions | A live session's token stays current across reconnects — only a teardown moves the epoch. |

## 5. Tests

New: `services/whatsapp-worker/tests/sessions-logout-race.test.ts` (8 tests).

| # | Test | Asserts |
| --- | --- | --- |
| 1 | `/start` admitted, socket creation stalled, then `/logout` | Auth empty, session offline, socket discarded unwired, its later events change nothing — **the reported repro** |
| 2 | logout while `auth.saveCreds` is in flight | The write lands inside the barrier and is deleted; the stale start never even reaches the socket factory |
| 3 | logout while socket creation is in flight | Socket is `end()`ed and discarded; no QR, no status, no channel, no row touched |
| 4 | fresh `/start` after that logout | Produces a real QR normally, while the abandoned start — released afterwards — cannot overwrite it |
| 5 | concurrent start idempotency | Three starts, one handshake, one outcome; the published socket is not discarded |
| 6 | reconnect after logout | A queued reconnect for an established pairing neither fires nor opens, well past its backoff |
| 7 | teardown deletes that fail | Both are attempted and reported; the clinic still reaches `disconnected`/`offline` rather than wedging |
| 8 | tenant isolation | Logging out clinic A leaves clinic B's in-flight start free to publish its own code |

Harness additions (`tests/harness.ts`): `stagedSocketFactory` (a separate gate per
handshake, so a wedged first start and a healthy second one can coexist — the
existing `gatedSocketFactory` shares one gate across all calls), `deferred()`, and
a `FakeStore` that can stall auth writes, fail `clearAuth`/`removeChannel`, and
track `clinic_channels`.

**Verified as genuine regression tests.** With `invalidate()` stubbed to a no-op —
i.e. the "just delete the `starting` entry" approach the old code effectively
took — 5 of the 8 fail, including tests 1–4 and 6. The 3 that still pass are the
preservation tests (5, 7, 8), which is what they are there for.

### Runs

```
services/whatsapp-worker $ npm run typecheck    # clean
services/whatsapp-worker $ npm test             # 125 tests, 125 pass, 0 fail
clinic-crm $ npx vitest run tests/unit/lib/p7e-linked-device-*.test.ts \
                            tests/unit/lib/p8-linked-device-callback.test.ts \
                            tests/unit/api/p7e-linked-device-webhook-route.test.ts
                                                # 8 files, 72 tests, all pass
clinic-crm $ npx vitest run --exclude "tests/unit/integration/**"
                                                # 387 files, 3214 tests, all pass
clinic-crm $ npm run test:integration           # 57 files, 547 pass, 3 skipped
                                                # (against the local Supabase stack)
```

## 6. Not done

Not deployed, as instructed. No migration, no schema change, no API-surface
change: `/start` and `/logout` keep their request and response shapes, and the
application side of the integration was not touched.
