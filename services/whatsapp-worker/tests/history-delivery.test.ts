import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CLINIC_A, connectedSession, postedEvents, waitFor } from "./harness.ts";

/**
 * P8 review · H2 — history delivery has to be durable, not best-effort.
 *
 * The failure this suite exists to prevent: WhatsApp pushes a full history sync
 * essentially **once, at the initial link**. There is no "run it again". Before
 * these fixes an interpreted batch lived only in worker memory and in one
 * in-flight POST, and three things composed badly:
 *
 *   * a batch that failed to post was logged and dropped;
 *   * the poster stopped at the first failed batch and abandoned every batch
 *     behind it;
 *   * the session was then marked `complete` with the counts the *worker* had
 *     parsed, so a clinic was told "300 chats imported" over six threads.
 *
 * What is asserted below is the replacement contract: enqueue before deliver,
 * retry from a durable row, never report `complete` while anything is
 * outstanding, count only what the application says it stored, and keep live
 * traffic moving throughout.
 */

const PATIENT_PN = "201111111111@s.whatsapp.net";
const OTHER_PN = "201222222222@s.whatsapp.net";

function historyMessage(remoteJid: string, id: string, at: number, fromMe = false) {
  return {
    key: { remoteJid, id, fromMe },
    messageTimestamp: at,
    message: { conversation: "مساء الخير" },
  } as never;
}

/** A sync large enough to be split across several callback batches. */
function largeBatch(count: number, isLatest = true) {
  const at = Math.floor(Date.parse("2026-06-01T10:00:00Z") / 1000);
  return {
    chats: [{ id: PATIENT_PN, name: "Fatima Ahmed", conversationTimestamp: at }],
    contacts: [{ id: PATIENT_PN, jid: PATIENT_PN, name: "Fatima Ahmed" }],
    messages: Array.from({ length: count }, (_, index) =>
      historyMessage(PATIENT_PN, `BULK-${index}`, at + index),
    ),
    isLatest,
  };
}

describe("history delivery — durability", () => {
  it("spools every interpreted batch before any of it is posted", async () => {
    const session = await connectedSession();
    try {
      // Nothing may leave until there is a row to recover from.
      session.responder.status = 503;
      await session.history(largeBatch(4));
      await waitFor(() => session.store.batches.size > 0, "the batches to be spooled");

      const rows = [...session.store.batches.values()];
      assert.ok(rows.length > 0);
      assert.ok(rows.every((row) => row.clinicId === CLINIC_A));
      // Every event the worker interpreted is accounted for by a durable row.
      const spooledEvents = rows.flatMap((row) => row.payload as Array<{ kind: string }>);
      assert.equal(spooledEvents.filter((event) => event.kind === "inbound").length, 4);
      assert.equal(spooledEvents.filter((event) => event.kind === "history_chat").length, 1);
    } finally {
      session.restore();
    }
  });

  it("splits a large sync into batches small enough to be answered", async () => {
    const session = await connectedSession();
    try {
      await session.history(largeBatch(60));
      await waitFor(
        () => session.store.row(CLINIC_A)?.history_status === "complete",
        "the import to complete",
      );
      // 61 events over a 25-event history batch size: never one enormous body
      // the receiver has to persist sequentially inside a single client timeout.
      const bodies = session.posted.filter((request) =>
        request.body.events.some((event) => event.kind === "inbound"),
      );
      assert.ok(bodies.length >= 3, `expected several batches, got ${bodies.length}`);
      assert.ok(bodies.every((request) => request.body.events.length <= 25));
    } finally {
      session.restore();
    }
  });

  it("does not report complete while a batch is still outstanding", async () => {
    const session = await connectedSession();
    try {
      session.responder.status = 503;
      await session.history(largeBatch(4));
      await waitFor(() => session.store.batches.size > 0, "the batches to be spooled");
      await new Promise((resolve) => setTimeout(resolve, 50));

      // The phone said this was its last batch, and the counts the worker parsed
      // were non-zero — the old code would have written `complete` here.
      assert.equal(session.store.row(CLINIC_A)?.history_status, "importing");
      assert.equal(session.store.row(CLINIC_A)?.history_chats_imported, 0);
      assert.equal(session.store.row(CLINIC_A)?.history_messages_imported, 0);
      assert.ok([...session.store.batches.values()].some((row) => row.status === "pending"));
    } finally {
      session.restore();
    }
  });

  it("retries a refused batch from the spool and then completes", async () => {
    const session = await connectedSession();
    try {
      // Each post makes up to three attempts of its own, so refusing four
      // requests outlives them and leaves the batch pending rather than lost.
      session.responder.failFirst = 4;
      await session.history(largeBatch(2));
      await waitFor(
        () => [...session.store.batches.values()].some((row) => row.status === "pending"),
        "the batch to survive its first pass",
        8_000,
      );
      assert.equal(session.store.row(CLINIC_A)?.history_status, "importing");

      // The next pass is what the paced reconcile sweep runs — and what a fresh
      // process runs on boot.
      await session.sessions.drainPendingHistory();
      assert.equal(session.store.row(CLINIC_A)?.history_status, "complete");
      const rows = [...session.store.batches.values()];
      assert.ok(rows.every((row) => row.status === "delivered"));
      assert.equal(session.store.row(CLINIC_A)?.history_chats_imported, 1);
      assert.equal(session.store.row(CLINIC_A)?.history_messages_imported, 2);
    } finally {
      session.restore();
    }
  });

  it("reports partial — never complete — when a batch exhausts its attempts", async () => {
    const session = await connectedSession();
    try {
      // A 4xx is a decision, not a hiccup: it is not retried inside the request.
      session.responder.status = 400;
      session.store.maxHistoryAttempts = 1;
      await session.history(largeBatch(2));
      await waitFor(
        () => session.store.row(CLINIC_A)?.history_status === "partial",
        "the import to report partial",
      );
      assert.notEqual(session.store.row(CLINIC_A)?.history_status, "complete");
      assert.ok([...session.store.batches.values()].some((row) => row.status === "failed"));
    } finally {
      session.restore();
    }
  });

  it("does not abandon the batches behind one that fails", async () => {
    const session = await connectedSession();
    try {
      // Refuse enough requests to consume the first batch's in-request attempts,
      // then accept. Every remaining batch must still be delivered — the old
      // poster returned at the first failure and dropped the rest of the import.
      session.responder.failFirst = 3;
      await session.history(largeBatch(60));
      // The first pass loses exactly one batch and carries every other one —
      // that is the regression: the old poster returned at the first failure and
      // abandoned the rest of the import.
      await waitFor(
        () =>
          [...session.store.batches.values()].filter((row) => row.status === "delivered").length >=
          2,
        "the batches behind the failure to be delivered",
        15_000,
      );
      // `drainPendingHistory` waits for the pass already running, then takes a
      // fresh one for whatever it left — which is what the paced sweep does.
      await session.sessions.drainPendingHistory();
      assert.equal(session.store.row(CLINIC_A)?.history_status, "complete");
      const delivered = postedEvents(session.posted).filter(
        (event) => event.kind === "inbound",
      );
      const ids = new Set(delivered.map((event) => event.providerMessageId));
      assert.equal(ids.size, 60);
    } finally {
      session.restore();
    }
  });

  it("recovers a spooled batch after a restart", async () => {
    const session = await connectedSession();
    try {
      session.responder.status = 503;
      await session.history(largeBatch(3));
      await waitFor(() => session.store.batches.size > 0, "the batches to be spooled");
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.ok([...session.store.batches.values()].some((row) => row.status === "pending"));

      // A new process, the same durable spool, no socket for this clinic yet.
      // The batch carries the number it was captured on, so it can still be
      // delivered — this is the restart-safety property.
      session.responder.status = 200;
      const clinics = await session.store.listClinicsWithPendingHistory();
      assert.deepEqual(clinics, [CLINIC_A]);
      await session.sessions.drainPendingHistory();
      assert.ok(
        [...session.store.batches.values()].every((row) => row.status === "delivered"),
        "every spooled batch should have been delivered by the boot drain",
      );
    } finally {
      session.restore();
    }
  });

  it("counts what the application stored, not what the worker parsed", async () => {
    const session = await connectedSession();
    try {
      // The same chat appearing in three batches used to be counted three times,
      // because the worker added its own per-batch tally. The counters now come
      // from the callback's answer.
      session.responder.summary = {
        inbound: 0,
        echoes: 0,
        replays: 0,
        historyChats: 1,
          attachments: 0,
      };
      await session.history({
        chats: [
          { id: PATIENT_PN, name: "Fatima" },
          { id: OTHER_PN, name: "Omar" },
        ],
        contacts: [],
        messages: [],
        isLatest: true,
      });
      await waitFor(
        () => session.store.row(CLINIC_A)?.history_status === "complete",
        "the import to complete",
      );
      // Two chats interpreted, one reported as imported by the application (the
      // other was held for staff review under the H4 privacy rule).
      assert.equal(session.store.row(CLINIC_A)?.history_chats_imported, 1);
    } finally {
      session.restore();
    }
  });

  it("keeps delivering live messages while history is stuck", async () => {
    const session = await connectedSession();
    try {
      session.responder.status = 503;
      await session.history(largeBatch(4));
      await waitFor(() => session.store.batches.size > 0, "the batches to be spooled");

      session.responder.status = 200;
      const before = session.posted.length;
      await session.upsert({
        type: "notify",
        messages: [
          {
            key: { remoteJid: OTHER_PN, id: "LIVE-1", fromMe: false },
            messageTimestamp: Math.floor(Date.now() / 1000),
            message: { conversation: "انا في الطريق" },
          },
        ],
      });
      const live = session.posted
        .slice(before)
        .flatMap((request) => request.body.events)
        .filter((event) => event.kind === "inbound" && event.historical !== true);
      assert.equal(live.length, 1);
      assert.equal(live[0]?.providerMessageId, "LIVE-1");
    } finally {
      session.restore();
    }
  });
});
