import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CallbackClient } from "../src/callback.ts";
import { SessionManager } from "../src/sessions.ts";
import { CLINIC_A, connectedSession, fakeSocket, testConfig } from "./harness.ts";

/**
 * The empty-history drain loop.
 *
 * A clinic whose linked-device channel is gone still has its interpreted history
 * sitting in the durable spool. The application answers every one of those
 * batches with `{ok: true, ignored: true}` — an acknowledgement carrying no
 * counters at all — and before this fix the worker could not tell that apart
 * from a genuinely empty batch that had been stored successfully. So it logged
 * `history batch persisted` with all-zero counts, marked the row delivered, and
 * did it again for the next four hundred and forty-five rows; the paced sweep
 * then started the whole backlog over sixty seconds later, and a restart began
 * it again from the top.
 *
 * Two things are being pinned down here, and they pull in opposite directions:
 * the storm has to stop, and the history must survive it. An ignored batch is
 * therefore neither delivered nor failed — it goes back exactly as it was found,
 * and the clinic is left alone for a while instead of being asked again every
 * minute.
 */

const SESSION_PHONE = "+201111111111";

/** `count` one-event batches in the spool, without going near a socket. */
function spool(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    batchKey: `batch-${index}`,
    payload: [
      {
        kind: "history_chat",
        participant: `+2010000${String(index).padStart(4, "0")}`,
        displayName: null,
        lastMessageAt: null,
      },
    ],
    eventCount: 1,
  }));
}

describe("history drain — a batch the application ignored", () => {
  it("tells an ignored acknowledgement apart from a persisted batch", async () => {
    // The distinction the whole fix rests on. Both answers are 200; only one of
    // them means anything was stored.
    const client = new CallbackClient(testConfig());
    const realFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ ok: true, ignored: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof globalThis.fetch;
      const ignored = await client.postHistoryBatch(CLINIC_A, SESSION_PHONE, []);
      assert.equal(ignored.ok, true);
      assert.equal(ignored.ignored, true, "an ignored acknowledgement must say so");

      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ ok: true, inbound: 3, historyChats: 1 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof globalThis.fetch;
      const stored = await client.postHistoryBatch(CLINIC_A, SESSION_PHONE, []);
      assert.equal(stored.ok, true);
      assert.equal(stored.ignored, false);
      assert.equal(stored.summary?.inbound, 3);

      // And the shape that started this: a real empty batch, stored, answering
      // with the same zeros the ignored branch does. It must NOT read as ignored.
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof globalThis.fetch;
      const emptyButStored = await client.postHistoryBatch(CLINIC_A, SESSION_PHONE, []);
      assert.equal(emptyButStored.ok, true);
      assert.equal(emptyButStored.ignored, false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("stops the pass on the first ignored batch instead of walking the backlog", async () => {
    const session = await connectedSession();
    try {
      await session.store.enqueueHistoryBatches({
        clinicId: CLINIC_A,
        sessionPhone: SESSION_PHONE,
        batches: spool(40),
      });
      session.responder.ignored = true;
      const before = session.posted.length;

      await session.sessions.drainPendingHistory();

      assert.equal(
        session.posted.length - before,
        1,
        "the pass must abandon the backlog after the first ignored answer",
      );
    } finally {
      session.restore();
    }
  });

  it("leaves ignored history pending, unattempted and recoverable", async () => {
    const session = await connectedSession();
    try {
      await session.store.enqueueHistoryBatches({
        clinicId: CLINIC_A,
        sessionPhone: SESSION_PHONE,
        batches: spool(40),
      });
      session.responder.ignored = true;
      await session.sessions.drainPendingHistory();

      const rows = [...session.store.batches.values()];
      assert.equal(rows.length, 40);
      assert.ok(
        rows.every((row) => row.status === "pending"),
        "nothing may be marked delivered on an answer that stored nothing",
      );
      assert.ok(
        rows.every((row) => row.attempts === 0),
        "an ignored batch must not burn a retry attempt — eight of those retire the row",
      );
      assert.ok(
        rows.every((row) => !row.claimed),
        "the batch the pass gave up on must not be left claimed",
      );
      // The clinic was not told anything was imported, either.
      const row = session.store.row(CLINIC_A);
      assert.equal(Number(row?.history_chats_imported ?? 0), 0);
      assert.equal(Number(row?.history_messages_imported ?? 0), 0);
    } finally {
      session.restore();
    }
  });

  it("does not re-post the spool on every sweep while the channel is inactive", async () => {
    const session = await connectedSession();
    try {
      await session.store.enqueueHistoryBatches({
        clinicId: CLINIC_A,
        sessionPhone: SESSION_PHONE,
        batches: spool(40),
      });
      session.responder.ignored = true;
      const before = session.posted.length;

      // Four sweeps' worth. The 60-second sweep is what turned this into a
      // permanent storm: the deferral is what makes the second one free.
      await session.sessions.drainPendingHistory();
      await session.sessions.drainPendingHistory();
      await session.sessions.drainPendingHistory();
      await session.sessions.drainPendingHistory();

      assert.equal(
        session.posted.length - before,
        1,
        "a deferred clinic must not be asked again on the next sweep",
      );
      assert.ok([...session.store.batches.values()].every((row) => row.status === "pending"));
    } finally {
      session.restore();
    }
  });

  it("imports the deferred history once a drain finds the channel active", async () => {
    const session = await connectedSession();
    try {
      await session.store.enqueueHistoryBatches({
        clinicId: CLINIC_A,
        sessionPhone: SESSION_PHONE,
        batches: spool(40),
      });
      session.responder.ignored = true;
      await session.sessions.drainPendingHistory();
      const afterIgnored = session.posted.length;

      // A later drain — the next worker, or this one after the clinic re-linked.
      // The deferral is in-memory by design, so a fresh manager over the same
      // spool tries again rather than inheriting a timer.
      const later = new SessionManager(
        testConfig({ workerId: session.store.workerId }),
        session.store.asStore(),
        async () => fakeSocket(),
      );
      session.responder.ignored = false;
      await later.drainPendingHistory();

      const rows = [...session.store.batches.values()];
      assert.ok(
        rows.every((row) => row.status === "delivered"),
        "every deferred batch must still be there to import",
      );
      assert.equal(
        session.posted.length - afterIgnored,
        40,
        "all forty batches reach the application once it is listening",
      );
    } finally {
      session.restore();
    }
  });

  it("drains a healthy spool in full, unchanged", async () => {
    const session = await connectedSession();
    try {
      await session.store.enqueueHistoryBatches({
        clinicId: CLINIC_A,
        sessionPhone: SESSION_PHONE,
        batches: spool(12),
      });
      const before = session.posted.length;

      await session.sessions.drainPendingHistory();

      assert.equal(session.posted.length - before, 12);
      const rows = [...session.store.batches.values()];
      assert.ok(rows.every((row) => row.status === "delivered"));
      assert.ok(rows.every((row) => row.attempts === 1));
    } finally {
      session.restore();
    }
  });

  it("stops draining promptly when the worker is shutting down", async () => {
    const session = await connectedSession();
    const stubbed = globalThis.fetch;
    try {
      await session.store.enqueueHistoryBatches({
        clinicId: CLINIC_A,
        sessionPhone: SESSION_PHONE,
        batches: spool(60),
      });
      // A real POST is a network round-trip; the drain is only interruptible
      // between them, so the stand-in has to take long enough for a shutdown to
      // land in the middle of the pass.
      let posts = 0;
      globalThis.fetch = (async (...args: Parameters<typeof globalThis.fetch>) => {
        posts += 1;
        await new Promise((resolve) => setTimeout(resolve, 15));
        return (stubbed as typeof globalThis.fetch)(...args);
      }) as typeof globalThis.fetch;

      const pass = session.sessions.drainPendingHistory();
      while (posts < 3) await new Promise((resolve) => setTimeout(resolve, 5));

      const atShutdown = posts;
      await session.sessions.shutdown();
      await pass;
      const afterShutdown = posts;
      await new Promise((resolve) => setTimeout(resolve, 100));

      assert.ok(
        afterShutdown - atShutdown <= 1,
        `the drain must stop within the in-flight request, posted ${afterShutdown - atShutdown} more`,
      );
      assert.equal(posts, afterShutdown, "nothing may be posted after the pass has returned");
      assert.ok(posts < 60, "the backlog must not be walked to the end on the way out");
      // Stopping is not losing: what was not posted is still pending.
      assert.ok(
        [...session.store.batches.values()].some((row) => row.status === "pending"),
        "the unposted remainder stays in the spool for the next worker",
      );
    } finally {
      globalThis.fetch = stubbed;
      session.restore();
    }
  });
});
