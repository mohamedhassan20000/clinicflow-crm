import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { historyBatchKey } from "../src/sessions.ts";
import { CLINIC_A, FakeStore, connectedSession, waitFor } from "./harness.ts";

/**
 * Real-device QA regression — the history spool's batch identity.
 *
 * The spool deduplicates on `(clinic_id, batch_key)` with
 * `ignoreDuplicates: true`, and the key used to be derived from
 * clinic + phone + payload alone. Once linked-device state became account
 * scoped, a clinic that had already delivered a batch under its *pre-isolation*
 * link produced byte-identical payloads on the next link — same clinic, same
 * session phone — so the new account's rows collided with the old delivered
 * ones and were dropped without a single error. Contacts and LID pairs came
 * through because they bypass the spool entirely; conversations and messages,
 * which do not, silently never arrived.
 *
 * These pin the identity itself, which is where the bug lived. Drain, retry and
 * fencing behaviour are unchanged and stay covered by the H2 suites.
 */

const ACCOUNT_A = "+201111111111";
const ACCOUNT_B = "+202222222222";
const SESSION_PHONE = "+201111111111";
const PAYLOAD = JSON.stringify([{ kind: "history_chat", participant: "+209999999999" }]);

/** The pre-isolation derivation, reproduced so a legacy row can be planted. */
function legacyBatchKey(clinicId: string, sessionPhone: string, serializedPayload: string): string {
  return createHash("sha256")
    .update(`${clinicId}:${sessionPhone}:${serializedPayload}`, "utf8")
    .digest("hex")
    .slice(0, 64);
}

function key(authenticatedAccountId: string, serializedPayload = PAYLOAD): string {
  return historyBatchKey({
    clinicId: CLINIC_A,
    authenticatedAccountId,
    sessionPhone: SESSION_PHONE,
    serializedPayload,
  });
}

async function enqueue(store: FakeStore, batchKey: string): Promise<number> {
  return store.enqueueHistoryBatches({
    clinicId: CLINIC_A,
    sessionPhone: SESSION_PHONE,
    batches: [{ batchKey, payload: JSON.parse(PAYLOAD) as unknown[], eventCount: 1 }],
  });
}

describe("history spool batch identity", () => {
  it("A — the same payload under the same account is the same batch", async () => {
    assert.equal(key(ACCOUNT_A), key(ACCOUNT_A));
    const store = new FakeStore("worker");
    assert.equal(await enqueue(store, key(ACCOUNT_A)), 1);
    assert.equal(await enqueue(store, key(ACCOUNT_A)), 0, "a replay must add no rows");
    assert.equal(store.batches.size, 1);
  });

  it("B — the same payload under a different account is a distinct batch", async () => {
    assert.notEqual(key(ACCOUNT_A), key(ACCOUNT_B));
    const store = new FakeStore("worker");
    assert.equal(await enqueue(store, key(ACCOUNT_A)), 1);
    // The exact shape of the QA failure: identical clinic, identical session
    // phone, identical payload, different authenticated account. This row is
    // the one that used to be swallowed.
    assert.equal(await enqueue(store, key(ACCOUNT_B)), 1);
    assert.equal(store.batches.size, 2);
  });

  it("C — a legacy account-less delivered batch does not suppress a new one", async () => {
    const store = new FakeStore("worker");
    const legacy = legacyBatchKey(CLINIC_A, SESSION_PHONE, PAYLOAD);
    assert.equal(await enqueue(store, legacy), 1);
    // Left exactly as the old link left it: delivered, untouched, not requeued.
    const legacyRow = store.batches.get(`${CLINIC_A}:${legacy}`)!;
    legacyRow.status = "delivered";

    assert.notEqual(key(ACCOUNT_A), legacy);
    assert.equal(await enqueue(store, key(ACCOUNT_A)), 1);
    assert.equal(store.batches.get(`${CLINIC_A}:${legacy}`)?.status, "delivered");
    const claimed = await store.claimHistoryBatches(CLINIC_A);
    assert.equal(claimed.length, 1, "only the new account-scoped row is deliverable");
    assert.equal(claimed[0]!.id, `${CLINIC_A}:${key(ACCOUNT_A)}`);
  });

  it("D — an account-scoped replay stays idempotent across a restart", async () => {
    const store = new FakeStore("worker");
    assert.equal(await enqueue(store, key(ACCOUNT_A)), 1);
    // A reconnecting socket re-interprets the same `messaging-history.set`; a
    // fresh derivation on a fresh process must land on the same key.
    const rederived = historyBatchKey({
      clinicId: CLINIC_A,
      authenticatedAccountId: ACCOUNT_A,
      sessionPhone: SESSION_PHONE,
      serializedPayload: PAYLOAD,
    });
    assert.equal(await enqueue(store, rederived), 0);
    assert.equal(store.batches.size, 1);
  });

  it("spools live history under the account-scoped key", async () => {
    const session = await connectedSession();
    try {
      const at = Math.floor(Date.parse("2026-06-01T10:00:00Z") / 1000);
      await session.history({
        chats: [{ id: "201333333333@s.whatsapp.net", conversationTimestamp: at }],
        contacts: [],
        messages: [],
        isLatest: true,
      });
      await waitFor(() => session.store.batches.size > 0, "the batch to be spooled");
      const row = [...session.store.batches.values()][0]!;
      const account = session.store.row(CLINIC_A)?.authenticated_account_id as string;
      assert.ok(account);
      assert.equal(
        row.id,
        `${CLINIC_A}:${historyBatchKey({
          clinicId: CLINIC_A,
          authenticatedAccountId: account,
          sessionPhone: row.sessionPhone,
          serializedPayload: JSON.stringify(row.payload),
        })}`,
      );
    } finally {
      session.restore();
    }
  });

  it("fails closed rather than spooling under the legacy account-less identity", async () => {
    const session = await connectedSession();
    try {
      session.store.batches.clear();
      const manager = session.sessions as unknown as {
        enqueueHistory(
          session: { clinicId: string; phone: string | null; authenticatedAccountId: string | null },
          events: unknown[],
        ): Promise<number>;
      };
      const enqueued = await manager.enqueueHistory(
        { clinicId: CLINIC_A, phone: SESSION_PHONE, authenticatedAccountId: null },
        [{ kind: "history_chat" }],
      );
      assert.equal(enqueued, 0);
      assert.equal(session.store.batches.size, 0, "nothing may be written without an account");
    } finally {
      session.restore();
    }
  });
});
