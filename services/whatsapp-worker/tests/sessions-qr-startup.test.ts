import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BROWSER_IDENTITY, SessionManager } from "../src/sessions.ts";
import { CLINIC_A, FakeStore, fakeSocket, testConfig, waitFor } from "./harness.ts";

/**
 * The bug this suite exists to prevent: a real device, freshly cleared, asked
 * for a QR code and never got one. The row sat at `status = starting`,
 * `qr_payload = null`, `last_error = null` indefinitely, and the worker logged
 * nothing after adopting the session. Two defects produced that, and both are
 * pinned here.
 *
 *  1. `Browsers.appropriate()` resolves the *host* operating system, and
 *     `baileys@6.7.24`'s `getWebInfo` turns an `os` of `Mac OS` or `Windows`
 *     into `webSubPlatform = DARWIN | WIN32` whenever `syncFullHistory` is set —
 *     announcing the native Desktop client inside a web-companion registration.
 *     WhatsApp terminates the stream with 428 before `pair-device`, so no code
 *     is ever issued. Reproduced against the live service: on a macOS host,
 *     `syncFullHistory: true` closed with 428 every run and `false` produced a
 *     code every run; with `Browsers.ubuntu` both produced a code.
 *
 *  2. `onClose` bounded its unpaired retries with `qrRounds`, which only moves
 *     when a code actually arrives — so a socket refused *before* any code
 *     reopened forever, rewriting `starting` each pass, logging nothing and
 *     recording no error. That is what made (1) invisible.
 */

describe("QR startup", () => {
  it("registers as a web companion, not as the desktop client", () => {
    // `Utils/validate-connection.ts` keys its desktop sub-platform swap on
    // exactly these two strings. Anything else keeps `WEB_BROWSER`.
    assert.ok(
      !["Mac OS", "Windows"].includes(BROWSER_IDENTITY[0]),
      `browser identity "${BROWSER_IDENTITY[0]}" makes Baileys claim the WhatsApp Desktop sub-platform`,
    );
  });

  it("is the same identity wherever the worker runs", () => {
    // The whole point of pinning it: no dependence on the container's OS.
    assert.deepEqual(BROWSER_IDENTITY, ["Ubuntu", "ClinicFlow", "22.04.4"]);
  });

  it("gives up, visibly, when the socket keeps closing before a code arrives", async () => {
    const store = new FakeStore("worker-under-test");
    const sockets: ReturnType<typeof fakeSocket>[] = [];
    const manager = new SessionManager(testConfig({ workerId: store.workerId }), store.asStore(), async () => {
      const socket = fakeSocket();
      sockets.push(socket);
      return socket;
    });

    await manager.start(CLINIC_A);
    await waitFor(() => sockets.length === 1, "the first socket");

    // WhatsApp refusing the registration: the stream ends with 428 and no code
    // was ever emitted on this socket.
    const refuse = async (index: number) => {
      sockets[index]!.emit("connection.update", {
        connection: "close",
        lastDisconnect: { error: { output: { statusCode: 428 } } },
      });
    };

    await refuse(0);
    await waitFor(() => sockets.length === 2, "a second attempt");
    await refuse(1);
    await waitFor(() => sockets.length === 3, "a third attempt");
    await refuse(2);

    // The budget is spent. The clinic is told, rather than left polling a row
    // that says `starting` for as long as the process lives.
    await waitFor(
      () => store.row(CLINIC_A)?.status === "error",
      "the refused pairing to be reported",
    );
    assert.equal(store.row(CLINIC_A)?.last_error, "pairing_failed");
    assert.equal(store.row(CLINIC_A)?.desired_state, "offline");
    assert.equal(sockets.length, 3, "no fourth socket was opened");

    await manager.shutdown();
  });

  it("still offers the full five codes to a clinic that is merely slow to scan", async () => {
    const store = new FakeStore("worker-under-test");
    const sockets: ReturnType<typeof fakeSocket>[] = [];
    const manager = new SessionManager(testConfig({ workerId: store.workerId }), store.asStore(), async () => {
      const socket = fakeSocket();
      sockets.push(socket);
      return socket;
    });

    await manager.start(CLINIC_A);
    await waitFor(() => sockets.length === 1, "the first socket");

    // A code was shown and expired unscanned — the pre-existing behaviour, which
    // the qr-less budget must not shorten.
    for (let round = 1; round <= 4; round += 1) {
      sockets[round - 1]!.emit("connection.update", { qr: "2@a-code" });
      await waitFor(
        () => store.row(CLINIC_A)?.status === "awaiting_scan",
        `the code for round ${round}`,
      );
      sockets[round - 1]!.emit("connection.update", {
        connection: "close",
        lastDisconnect: { error: { output: { statusCode: 428 } } },
      });
      await waitFor(() => sockets.length === round + 1, `attempt ${round + 1}`);
    }

    assert.equal(store.row(CLINIC_A)?.status, "starting");
    assert.equal(store.row(CLINIC_A)?.last_error, null);

    await manager.shutdown();
  });
});
