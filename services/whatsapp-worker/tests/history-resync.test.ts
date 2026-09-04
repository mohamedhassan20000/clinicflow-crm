import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  HISTORY_RESYNC_MESSAGES_PER_CHAT,
  planHistoryResync,
  type HistoryResyncAnchor,
} from "../src/history-resync.ts";
import { historyBatchKey } from "../src/sessions.ts";
import { CLINIC_A, connectedSession, waitFor } from "./harness.ts";

/**
 * On-demand history recovery for a device that is already paired.
 *
 * The mechanism under test is real and was verified against the installed
 * dependency rather than recalled: Baileys 6.7.24 exposes
 * `WASocket.fetchMessageHistory(count, oldestMsgKey, oldestMsgTimestamp)`, which
 * relays a `HISTORY_SYNC_ON_DEMAND` peer request and whose answer comes back on
 * the ordinary `messaging-history.set` event with `syncType: ON_DEMAND`.
 *
 * What these pin is everything the product must be able to promise about that
 * request: that it is scoped to the authenticated account, that it cannot run
 * without one, that it never crosses an account boundary, that it neither logs
 * out nor touches authentication state, that its answer replays idempotently
 * through the account-scoped batch key, and that a worker which has lost the
 * clinic stops asking.
 */

const SESSION_JID = "201111111111:7@s.whatsapp.net";
const ACCOUNT = "+201111111111";
const OTHER_ACCOUNT = "+209999999999";

function anchor(overrides: Partial<HistoryResyncAnchor> = {}): HistoryResyncAnchor {
  return {
    participantAddress: "+201333333333",
    providerMessageId: "WAMID-1",
    fromMe: false,
    occurredAt: "2026-06-01T10:00:00.000Z",
    ...overrides,
  };
}

describe("history resync plan", () => {
  it("asks about each conversation once, from its oldest message", () => {
    const plan = planHistoryResync({
      anchors: [
        anchor({ providerMessageId: "newer", occurredAt: "2026-06-05T10:00:00.000Z" }),
        anchor({ providerMessageId: "older", occurredAt: "2026-01-05T10:00:00.000Z" }),
      ],
    });
    assert.equal(plan.length, 1);
    assert.equal(plan[0]!.key.id, "older");
    assert.equal(plan[0]!.chatJid, "201333333333@s.whatsapp.net");
    assert.equal(plan[0]!.count, HISTORY_RESYNC_MESSAGES_PER_CHAT);
  });

  it("is bounded, so one run can never become a flood of peer requests", () => {
    const anchors = Array.from({ length: 200 }, (_, index) =>
      anchor({
        participantAddress: `+2013333${String(index).padStart(5, "0")}`,
        providerMessageId: `WAMID-${index}`,
      }),
    );
    assert.equal(planHistoryResync({ anchors, maxChats: 25 }).length, 25);
  });

  it("drops anything malformed rather than addressing a guess", () => {
    assert.equal(
      planHistoryResync({
        anchors: [
          anchor({ participantAddress: "201333333333" }),
          anchor({ participantAddress: "+2013333333331111111111111" }),
          anchor({ providerMessageId: "" }),
          anchor({ occurredAt: "not a date" }),
        ],
      }).length,
      0,
    );
  });
});

describe("history resync on a live session", () => {
  it("requests history for the authenticated account and never logs out", async () => {
    const session = await connectedSession({ sessionJid: SESSION_JID });
    try {
      session.store.resyncAnchors.set(`${CLINIC_A}:${ACCOUNT}`, [
        anchor({ participantAddress: "+201333333333", providerMessageId: "WAMID-A" }),
      ]);
      const authWritesBefore = session.store.authWrites.length;

      const outcome = await session.sessions.resyncHistory(CLINIC_A);
      assert.deepEqual(outcome, { ok: true, requested: 1, chats: 1 });

      // Scoped: the anchors were read for this clinic *and* this account.
      assert.deepEqual(session.store.anchorReads, [{ clinicId: CLINIC_A, account: ACCOUNT }]);
      assert.equal(session.socket.historyFetches.length, 1);
      assert.equal(session.socket.historyFetches[0]!.key.remoteJid, "201333333333@s.whatsapp.net");

      // No logout, no unlink, no auth mutation of any kind.
      assert.equal(session.socket.loggedOut, false);
      assert.equal(session.socket.ended, false);
      assert.equal(session.store.authWrites.length, authWritesBefore);
      assert.equal(session.store.clearAuthCalls.length, 0);
      // Observable: the clinic's own import status says something is happening.
      assert.equal(session.store.row(CLINIC_A)?.history_status, "importing");
    } finally {
      session.restore();
    }
  });

  it("cannot cross an account boundary", async () => {
    const session = await connectedSession({ sessionJid: SESSION_JID });
    try {
      // Anchors that belong to a different linked account. Nothing may reach
      // them: the read is keyed on the account the socket authenticated as.
      session.store.resyncAnchors.set(`${CLINIC_A}:${OTHER_ACCOUNT}`, [
        anchor({ participantAddress: "+201444444444", providerMessageId: "WAMID-OTHER" }),
      ]);

      const outcome = await session.sessions.resyncHistory(CLINIC_A);
      assert.deepEqual(outcome, { ok: false, code: "NO_ANCHORS" });
      assert.deepEqual(session.store.anchorReads, [{ clinicId: CLINIC_A, account: ACCOUNT }]);
      assert.equal(session.socket.historyFetches.length, 0);
    } finally {
      session.restore();
    }
  });

  it("refuses without an authenticated account bound to the session", async () => {
    const session = await connectedSession({ sessionJid: SESSION_JID });
    try {
      const live = (
        session.sessions as unknown as {
          sessions: Map<string, { authenticatedAccountId: string | null }>;
        }
      ).sessions.get(CLINIC_A)!;
      live.authenticatedAccountId = null;

      assert.deepEqual(await session.sessions.resyncHistory(CLINIC_A), {
        ok: false,
        code: "NOT_CONNECTED",
      });
      assert.equal(session.store.anchorReads.length, 0);
      assert.equal(session.socket.historyFetches.length, 0);
    } finally {
      session.restore();
    }
  });

  it("refuses for a clinic this worker no longer owns", async () => {
    const session = await connectedSession({ sessionJid: SESSION_JID });
    try {
      session.store.resyncAnchors.set(`${CLINIC_A}:${ACCOUNT}`, [anchor()]);
      // What losing the clinic on a heartbeat does: the epoch moves, and every
      // handler and caller holding the old token goes mute.
      (session.sessions as unknown as { invalidate(clinicId: string): void }).invalidate(CLINIC_A);

      assert.deepEqual(await session.sessions.resyncHistory(CLINIC_A), {
        ok: false,
        code: "NO_SESSION",
      });
      assert.equal(session.socket.historyFetches.length, 0);
    } finally {
      session.restore();
    }
  });

  it("rate-limits repeat runs instead of re-asking the phone", async () => {
    const session = await connectedSession({ sessionJid: SESSION_JID });
    try {
      session.store.resyncAnchors.set(`${CLINIC_A}:${ACCOUNT}`, [anchor()]);
      assert.equal((await session.sessions.resyncHistory(CLINIC_A)).ok, true);
      assert.deepEqual(await session.sessions.resyncHistory(CLINIC_A), {
        ok: false,
        code: "COOLDOWN",
      });
      assert.equal(session.socket.historyFetches.length, 1);
    } finally {
      session.restore();
    }
  });

  it("has no anchor to hang a request on for a clinic with no imported messages", async () => {
    const session = await connectedSession({ sessionJid: SESSION_JID });
    try {
      // The reported production shape: contacts exist, the inbox does not. The
      // API is anchored, so the honest answer is that there is nothing to
      // extend backwards from — not a fabricated success.
      assert.deepEqual(await session.sessions.resyncHistory(CLINIC_A), {
        ok: false,
        code: "NO_ANCHORS",
      });
      assert.equal(session.socket.historyFetches.length, 0);
      assert.equal(session.store.batches.size, 0);
    } finally {
      session.restore();
    }
  });

  it("spools the on-demand answer under the account-scoped batch key, once", async () => {
    const session = await connectedSession({ sessionJid: SESSION_JID });
    try {
      session.store.resyncAnchors.set(`${CLINIC_A}:${ACCOUNT}`, [anchor()]);
      await session.sessions.resyncHistory(CLINIC_A);

      // What Baileys emits for an ON_DEMAND response: the same event as the
      // link-time push, with no `isLatest`.
      const batch = {
        chats: [
          {
            id: "201333333333@s.whatsapp.net",
            conversationTimestamp: Math.floor(Date.parse("2026-05-01T10:00:00Z") / 1000),
          },
        ],
        contacts: [],
        messages: [],
        syncType: 7,
      };
      await session.history(batch);
      await waitFor(() => session.store.batches.size > 0, "the on-demand batch to be spooled");
      const row = [...session.store.batches.values()][0]!;
      assert.equal(
        row.id,
        `${CLINIC_A}:${historyBatchKey({
          clinicId: CLINIC_A,
          authenticatedAccountId: ACCOUNT,
          sessionPhone: row.sessionPhone,
          serializedPayload: JSON.stringify(row.payload),
        })}`,
      );

      // A phone that answers the same request twice adds no rows.
      const before = session.store.batches.size;
      await session.history(batch);
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(session.store.batches.size, before, "a replayed answer must add no rows");
    } finally {
      session.restore();
    }
  });
});
