import assert from "node:assert/strict";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { SessionManager } from "../src/sessions.ts";
import { createWorkerServer } from "../src/server.ts";
import {
  CLINIC_A,
  FakeStore,
  type StoredSession,
  fakeSocket,
  gatedSocketFactory,
  testConfig,
  waitFor,
} from "./harness.ts";

/**
 * P11L — the HTTP boundary "Connect with QR" actually crosses.
 *
 * The bug this suite exists to prevent: a developer running this worker on a
 * laptop pressed Connect with QR and saw *nothing at all* — no code in the
 * settings panel and, worse, not one line in the worker's log. The request had
 * in fact arrived; the local worker's claim on the clinic was refused because a
 * deployed worker against the same database still owned the session, and both
 * the refusal in `SessionManager` and the 409 here were silent. Absent output
 * reads as "the application never called", which sends the search to the wrong
 * end of a chain that runs from a button through a server action, an HTTP call,
 * a bearer token and a conditional database write.
 *
 * So what is pinned below is not only the routing but its *visibility*: every
 * one of the three outcomes an operator has to tell apart — reached and
 * accepted, reached and refused ownership, reached and refused authentication —
 * leaves a line saying which it was, and none of them ever prints the token.
 */

const PROD = "railway-prod";
const DEV = "local-dev";

type Harness = {
  port: number;
  config: ReturnType<typeof testConfig>;
  logs: string[];
  close: () => Promise<void>;
};

/**
 * A worker listening on loopback, with its log captured.
 *
 * The server writes through pino to stdout; the tests need to assert that a
 * line was emitted at all, so the file descriptor is what is observed rather
 * than the logger, which the server module owns privately.
 */
async function workerAt(
  sessions: SessionManager,
  store: FakeStore,
  config = testConfig({ workerId: store.workerId }),
): Promise<Harness> {
  const logs: string[] = [];
  // pino writes to file descriptor 1 through sonic-boom, which never passes
  // through `process.stdout.write` — so the descriptor is what has to be
  // watched. Everything is still forwarded, so a failing run stays readable.
  const write = fs.write.bind(fs) as (...args: unknown[]) => unknown;
  (fs as { write: unknown }).write = (...args: unknown[]) => {
    if (args[0] === 1) logs.push(String(args[1]));
    return write(...args);
  };

  const server = createWorkerServer(config, sessions, store.asStore());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    config,
    logs,
    close: async () => {
      (fs as { write: unknown }).write = write;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function start(port: number, token: string, clinicId = CLINIC_A): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/v1/sessions/${clinicId}/start`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
}

/** A manager whose sockets never finish their handshake — start still admits. */
function managerFor(store: FakeStore, config = testConfig({ workerId: store.workerId })) {
  const sockets = gatedSocketFactory();
  sockets.release();
  return new SessionManager(config, store.asStore(), sockets.factory);
}

describe("the start endpoint the Connect with QR button reaches", () => {
  it("claims the clinic and says so when nothing else owns it", async () => {
    const store = new FakeStore(DEV);
    const harness = await workerAt(managerFor(store), store);
    try {
      const response = await start(harness.port, harness.config.apiToken);

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true });
      const row = store.sessions.get(CLINIC_A) as StoredSession;
      assert.equal(row.worker_id, DEV);
      assert.equal(row.status, "starting");
      assert.equal(row.desired_state, "online");
      // Reaching the worker is now an observable event in its own right.
      assert.ok(
        harness.logs.some((line) => line.includes("start requested") && line.includes(CLINIC_A)),
        "a start that arrives must be logged",
      );
    } finally {
      await harness.close();
    }
  });

  it("publishes the pairing code into the row the settings panel reads", async () => {
    const store = new FakeStore(DEV);
    const sockets: ReturnType<typeof fakeSocket>[] = [];
    const manager = new SessionManager(
      testConfig({ workerId: DEV }),
      store.asStore(),
      async () => {
        const socket = fakeSocket();
        sockets.push(socket);
        return socket;
      },
    );
    const harness = await workerAt(manager, store);
    try {
      assert.equal((await start(harness.port, harness.config.apiToken)).status, 200);
      await waitFor(() => sockets.length === 1, "the pairing socket");

      sockets[0]!.emit("connection.update", { qr: "2@a-real-pairing-payload" });
      await waitFor(
        () => (store.sessions.get(CLINIC_A) as StoredSession | undefined)?.status === "awaiting_scan",
        "the code to be published",
      );

      const row = store.sessions.get(CLINIC_A) as StoredSession;
      assert.equal(row.qr_payload, "2@a-real-pairing-payload");
      // The application renders the image from this, so an expiry it can
      // compare against is part of the contract, not a detail.
      assert.ok(
        new Date(String(row.qr_expires_at)).valueOf() > Date.now(),
        "a published code must carry a future expiry",
      );
    } finally {
      await harness.close();
    }
  });

  it("names the worker that holds the clinic when it refuses", async () => {
    // Two workers, one database: a laptop against the deployed worker's project.
    const database = new Map<string, StoredSession>();
    const prodStore = new FakeStore(PROD, database);
    const devStore = new FakeStore(DEV, database);
    const prod = managerFor(prodStore, testConfig({ workerId: PROD }));
    await prod.start(CLINIC_A);
    await waitFor(() => prod.clinicIds().includes(CLINIC_A), "the deployed worker to hold it");

    // Takeover off — the default, and the mode this flow must never depend on.
    const config = testConfig({ workerId: DEV, devTakeover: false });
    const harness = await workerAt(managerFor(devStore, config), devStore, config);
    try {
      const response = await start(harness.port, harness.config.apiToken);

      assert.equal(response.status, 409);
      assert.deepEqual(await response.json(), { error: "owned_elsewhere" });
      // Ownership is untouched: the refusal takes nothing.
      assert.equal((database.get(CLINIC_A) as StoredSession).worker_id, PROD);
      const refusal = harness.logs.find((line) =>
        line.includes("owned by another worker"),
      );
      assert.ok(refusal, "a refused claim must be logged, not silent");
      // The line has to answer "who has it", or it explains nothing.
      assert.ok(refusal.includes(PROD), "the refusal must name the holder");
      assert.ok(refusal.includes("heartbeatAgeMs"), "the refusal must age the holder's claim");
    } finally {
      await harness.close();
    }
  });

  it("logs a rejected token without ever writing the token down", async () => {
    const store = new FakeStore(DEV);
    const harness = await workerAt(managerFor(store), store);
    try {
      const response = await start(harness.port, "a-completely-wrong-token-0000000000");

      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { error: "unauthorized" });
      assert.equal(store.sessions.size, 0);
      const line = harness.logs.find((entry) => entry.includes("did not present this worker's token"));
      assert.ok(line, "an unauthenticated call must be visible server-side");
      assert.ok(line.includes("/v1/sessions/"), "the line must say what was attempted");
      assert.ok(
        !line.includes(harness.config.apiToken) && !line.includes("a-completely-wrong-token"),
        "no token, correct or presented, may reach the log",
      );
    } finally {
      await harness.close();
    }
  });

  it("answers an unrelated path without touching a session", async () => {
    const store = new FakeStore(DEV);
    const harness = await workerAt(managerFor(store), store);
    try {
      const response = await fetch(`http://127.0.0.1:${harness.port}/v1/sessions/not-a-uuid/start`, {
        method: "POST",
        headers: { authorization: `Bearer ${harness.config.apiToken}` },
      });
      assert.equal(response.status, 400);
      assert.equal(store.sessions.size, 0);
    } finally {
      await harness.close();
    }
  });
});
