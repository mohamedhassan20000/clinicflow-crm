import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CLINIC_A, CLINIC_B, FakeStore } from "./harness.ts";

const ACCOUNT_A = "+201111111111";
const ACCOUNT_B = "+202222222222";

describe("durable linked-account isolation", () => {
  it("reuses the same account boundary on reconnect", async () => {
    const store = new FakeStore("worker");
    store.seed(CLINIC_A, {
      authenticated_account_id: ACCOUNT_A,
      inbound_active_from: "2026-07-01T00:00:00.000Z",
    });
    store.linkedAccounts.set(`${CLINIC_A}:${ACCOUNT_A}`, "2026-07-01T00:00:00.000Z");
    const result = await store.bindLinkedAccount({
      clinicId: CLINIC_A,
      accountId: ACCOUNT_A,
      accountLid: "555000111222@lid",
      proposedBoundary: "2026-09-02T00:00:00.000Z",
    });
    assert.deepEqual(result, {
      inboundActiveFrom: "2026-07-01T00:00:00.000Z",
      changed: false,
    });
  });

  it("creates a new boundary and preserves-but-supersedes A's pending spool for B", async () => {
    const store = new FakeStore("worker");
    store.seed(CLINIC_A, {
      authenticated_account_id: ACCOUNT_A,
      inbound_active_from: "2026-07-01T00:00:00.000Z",
    });
    await store.enqueueHistoryBatches({
      clinicId: CLINIC_A,
      sessionPhone: ACCOUNT_A,
      batches: [{ batchKey: "account-a-batch", payload: [{ kind: "history_chat" }], eventCount: 1 }],
    });
    const result = await store.bindLinkedAccount({
      clinicId: CLINIC_A,
      accountId: ACCOUNT_B,
      accountLid: null,
      proposedBoundary: "2026-09-02T00:00:00.000Z",
    });
    assert.equal(result.changed, true);
    assert.equal(result.inboundActiveFrom, "2026-09-02T00:00:00.000Z");
    await store.supersedeHistoryBatches(CLINIC_A, ACCOUNT_B);
    const oldBatch = [...store.batches.values()][0];
    assert.ok(oldBatch);
    assert.equal(oldBatch.status, "superseded");
    assert.equal(oldBatch.payload.length, 1);
    assert.deepEqual(await store.claimHistoryBatches(CLINIC_A), []);
  });

  it("keeps contacts and LID aliases separate for the same recipient under A and B", async () => {
    const store = new FakeStore("worker");
    const recipient = "+209999999999";
    await store.upsertContacts(CLINIC_A, ACCOUNT_A, [{ participantAddress: recipient, displayName: "A label" }]);
    await store.upsertContacts(CLINIC_A, ACCOUNT_B, [{ participantAddress: recipient, displayName: "B label" }]);
    await store.upsertLidMappings(CLINIC_A, ACCOUNT_A, [{ lid: "555000999111@lid", phone: recipient }]);
    await store.upsertLidMappings(CLINIC_A, ACCOUNT_B, [{ lid: "555000999111@lid", phone: "+208888888888" }]);
    assert.equal(store.scopedContacts.get(store.scopeKey(CLINIC_A, ACCOUNT_A, recipient)), "A label");
    assert.equal(store.scopedContacts.get(store.scopeKey(CLINIC_A, ACCOUNT_B, recipient)), "B label");
    assert.notDeepEqual(await store.loadLidMappings(CLINIC_A, ACCOUNT_A),
      await store.loadLidMappings(CLINIC_A, ACCOUNT_B));
  });

  it("gives a clinic that has never paired the account it just scanned, and only that", async () => {
    const store = new FakeStore("worker");
    store.seed(CLINIC_A, {});
    const bound = await store.bindLinkedAccount({
      clinicId: CLINIC_A,
      accountId: ACCOUNT_A,
      accountLid: "555000111222@lid",
      proposedBoundary: "2026-09-02T00:00:00.000Z",
    });
    // Nothing preceded this scan, so nothing is inherited: the boundary is the
    // moment of pairing, and there is no previous account to have changed away
    // from. A `changed: true` here would mean legacy state had been treated as
    // an account, which is the adoption this model exists to refuse.
    assert.deepEqual(bound, {
      inboundActiveFrom: "2026-09-02T00:00:00.000Z",
      changed: false,
    });
    const session = store.sessions.get(CLINIC_A);
    assert.equal(session?.authenticated_account_id, ACCOUNT_A);
    assert.equal(session?.authenticated_account_lid, "555000111222@lid");
  });

  it("keeps two clinics that scanned different accounts entirely apart", async () => {
    const store = new FakeStore("worker");
    store.seed(CLINIC_A, {});
    store.seed(CLINIC_B, {});
    await store.bindLinkedAccount({
      clinicId: CLINIC_A,
      accountId: ACCOUNT_A,
      accountLid: null,
      proposedBoundary: "2026-09-02T00:00:00.000Z",
    });
    await store.bindLinkedAccount({
      clinicId: CLINIC_B,
      accountId: ACCOUNT_B,
      accountLid: null,
      proposedBoundary: "2026-09-03T00:00:00.000Z",
    });

    const shared = "+209999999999";
    await store.upsertContacts(CLINIC_A, ACCOUNT_A, [
      { participantAddress: shared, displayName: "clinic A label" },
    ]);
    await store.upsertLidMappings(CLINIC_A, ACCOUNT_A, [
      { lid: "555000999111@lid", phone: shared },
    ]);
    await store.enqueueHistoryBatches({
      clinicId: CLINIC_A,
      sessionPhone: ACCOUNT_A,
      batches: [{ batchKey: "a-1", payload: [{ kind: "history_chat" }], eventCount: 1 }],
    });

    assert.equal(store.sessions.get(CLINIC_B)?.authenticated_account_id, ACCOUNT_B);
    assert.equal(store.linkedAccounts.get(`${CLINIC_B}:${ACCOUNT_A}`), undefined);
    assert.equal(
      store.scopedContacts.get(store.scopeKey(CLINIC_B, ACCOUNT_B, shared)),
      undefined,
    );
    assert.deepEqual(await store.loadLidMappings(CLINIC_B, ACCOUNT_B), []);
    assert.deepEqual(await store.claimHistoryBatches(CLINIC_B), []);
  });

  it("cannot be made to read another clinic's rows by scanning the same account", async () => {
    const store = new FakeStore("worker");
    store.seed(CLINIC_A, {});
    store.seed(CLINIC_B, {});
    const shared = "+209999999999";
    await store.upsertContacts(CLINIC_A, ACCOUNT_A, [
      { participantAddress: shared, displayName: "clinic A label" },
    ]);
    await store.upsertLidMappings(CLINIC_A, ACCOUNT_A, [
      { lid: "555000999111@lid", phone: shared },
    ]);

    // Same WhatsApp number, different tenant. The account key is not a tenant
    // key and must never behave as one.
    assert.equal(
      store.scopedContacts.get(store.scopeKey(CLINIC_B, ACCOUNT_A, shared)),
      undefined,
    );
    assert.deepEqual(await store.loadLidMappings(CLINIC_B, ACCOUNT_A), []);
  });

  it("restores A's original boundary when a clinic goes A -> B -> A", async () => {
    const store = new FakeStore("worker");
    store.seed(CLINIC_A, {});
    const first = await store.bindLinkedAccount({
      clinicId: CLINIC_A,
      accountId: ACCOUNT_A,
      accountLid: null,
      proposedBoundary: "2026-07-01T00:00:00.000Z",
    });
    const toB = await store.bindLinkedAccount({
      clinicId: CLINIC_A,
      accountId: ACCOUNT_B,
      accountLid: null,
      proposedBoundary: "2026-08-01T00:00:00.000Z",
    });
    const backToA = await store.bindLinkedAccount({
      clinicId: CLINIC_A,
      accountId: ACCOUNT_A,
      accountLid: null,
      proposedBoundary: "2026-09-01T00:00:00.000Z",
    });

    assert.equal(first.inboundActiveFrom, "2026-07-01T00:00:00.000Z");
    assert.equal(toB.changed, true);
    assert.equal(toB.inboundActiveFrom, "2026-08-01T00:00:00.000Z");
    // The whole point of persisting a boundary per account: coming back to A
    // reuses A's own first-inbound line rather than proposing a new one, so the
    // clinic gets neither a re-flood of old history nor a silent gap.
    assert.equal(backToA.changed, true);
    assert.equal(backToA.inboundActiveFrom, "2026-07-01T00:00:00.000Z");
    // ...and B's boundary is still B's, untouched by the return.
    assert.equal(store.linkedAccounts.get(`${CLINIC_A}:${ACCOUNT_B}`), "2026-08-01T00:00:00.000Z");
  });

  it("supersedes rather than deletes the outgoing account's spooled history", async () => {
    const store = new FakeStore("worker");
    store.seed(CLINIC_A, {
      authenticated_account_id: ACCOUNT_A,
      inbound_active_from: "2026-07-01T00:00:00.000Z",
    });
    await store.enqueueHistoryBatches({
      clinicId: CLINIC_A,
      sessionPhone: ACCOUNT_A,
      batches: [{ batchKey: "a-1", payload: [{ kind: "history_chat" }], eventCount: 1 }],
    });
    await store.bindLinkedAccount({
      clinicId: CLINIC_A,
      accountId: ACCOUNT_B,
      accountLid: null,
      proposedBoundary: "2026-09-02T00:00:00.000Z",
    });
    await store.supersedeHistoryBatches(CLINIC_A, ACCOUNT_B);
    await store.enqueueHistoryBatches({
      clinicId: CLINIC_A,
      sessionPhone: ACCOUNT_B,
      batches: [{ batchKey: "b-1", payload: [{ kind: "history_chat" }], eventCount: 1 }],
    });

    const claimed = await store.claimHistoryBatches(CLINIC_A);
    // Only B's spool is claimable while B is active. A's rows survive for audit
    // and for a later return to A; they are never delivered as B's.
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0]?.sessionPhone, ACCOUNT_B);
  });

  it("carries the same account and boundary across a worker handoff", async () => {
    // Two stores over one map is two workers against one database — the only
    // way a handoff can be exercised at all.
    const shared = new Map();
    const outgoing = new FakeStore("worker-a", shared);
    const incoming = new FakeStore("worker-b", shared);
    outgoing.seed(CLINIC_A, {});
    const first = await outgoing.bindLinkedAccount({
      clinicId: CLINIC_A,
      accountId: ACCOUNT_A,
      accountLid: "555000111222@lid",
      proposedBoundary: "2026-07-01T00:00:00.000Z",
    });

    // The clinic did not rescan; a different process simply picked the session
    // up and re-derived the same identity from the restored Baileys socket.
    const second = await incoming.bindLinkedAccount({
      clinicId: CLINIC_A,
      accountId: ACCOUNT_A,
      accountLid: "555000111222@lid",
      proposedBoundary: "2026-09-02T00:00:00.000Z",
    });

    assert.equal(second.changed, false);
    assert.equal(second.inboundActiveFrom, first.inboundActiveFrom);
    // A boundary that moved here would re-import history the clinic has
    // already seen, or silently skip traffic it has not.
    assert.equal(shared.get(CLINIC_A)?.inbound_active_from, "2026-07-01T00:00:00.000Z");
  });
});
