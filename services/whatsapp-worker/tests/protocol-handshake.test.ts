import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { SessionManager } from "../src/sessions.ts";
import { createWorkerServer } from "../src/server.ts";
import { WORKER_PROTOCOL_VERSION } from "../src/protocol.ts";
import { FakeStore, gatedSocketFactory, testConfig } from "./harness.ts";

/**
 * The advertisement the application pairs against.
 *
 * Account isolation only holds if *both* halves implement it, and the only
 * moment the mismatch becomes expensive is the first scan against a stale
 * worker — which writes rows whose owning account can never afterwards be
 * proved. The application therefore refuses to start a pairing until this
 * worker has said what it speaks, so what is pinned here is that the answer is
 * present, machine-readable, and free of anything about the deployment.
 */

async function workerOnLoopback() {
  const store = new FakeStore("worker-under-test");
  const sockets = gatedSocketFactory();
  sockets.release();
  const config = testConfig({ workerId: store.workerId });
  const sessions = new SessionManager(config, store.asStore(), sockets.factory);
  const server = createWorkerServer(config, sessions, store.asStore());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("the worker's compatibility advertisement", () => {
  it("publishes its protocol version and isolation capability on /healthz", async () => {
    const worker = await workerOnLoopback();
    try {
      // Unauthenticated on purpose: the application has to be able to establish
      // compatibility before it holds anything, and a liveness probe is the one
      // call it can always make.
      const response = await fetch(`http://127.0.0.1:${worker.port}/healthz`);
      assert.equal(response.status, 200);
      const body = (await response.json()) as Record<string, unknown>;

      assert.equal(body.workerProtocolVersion, WORKER_PROTOCOL_VERSION);
      assert.equal(body.linkedAccountIsolation, true);
      assert.ok(
        Number.isInteger(body.workerProtocolVersion) &&
          (body.workerProtocolVersion as number) >= 2,
        "the isolation-aware protocol is at least 2",
      );
    } finally {
      await worker.close();
    }
  });

  it("says nothing about tenants, configuration or secrets while doing so", async () => {
    const worker = await workerOnLoopback();
    try {
      const body = (await (
        await fetch(`http://127.0.0.1:${worker.port}/healthz`)
      ).json()) as Record<string, unknown>;

      // The route is public. Its whole payload is therefore fair game to
      // anyone who can reach the service, and must stay a shape — never a
      // token, an address, a phone number or a clinic id.
      assert.deepEqual(
        Object.keys(body).sort(),
        ["linkedAccountIsolation", "ok", "sessions", "workerId", "workerProtocolVersion"],
      );
      assert.equal(body.sessions, 0);
      const serialized = JSON.stringify(body);
      for (const secret of [testConfig().apiToken, testConfig().callbackSecret]) {
        assert.ok(!serialized.includes(secret));
      }
    } finally {
      await worker.close();
    }
  });
});
