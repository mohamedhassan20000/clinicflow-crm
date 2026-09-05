import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { createWorkerServer } from "../src/server.ts";
import { CLINIC_A, connectedSession, testConfig } from "./harness.ts";

async function listen(server: ReturnType<typeof createWorkerServer>): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

async function close(server: ReturnType<typeof createWorkerServer>): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("outbound media HTTP boundary", () => {
  it("accepts a small storage reference and never needs media bytes in JSON", async () => {
    const harness = await connectedSession();
    // This suite needs Node's real fetch for its localhost request; the session
    // harness only replaces fetch to observe application callbacks.
    harness.restore();
    const config = testConfig();
    const server = createWorkerServer(config, harness.sessions, harness.store.asStore());
    try {
      const path = `${CLINIC_A}/conversation/photo.png`;
      harness.store.outboundMedia.set(`whatsapp-outbound:${path}`, Buffer.from("image"));
      const port = await listen(server);
      const response = await fetch(`http://127.0.0.1:${port}/v1/sessions/${CLINIC_A}/messages`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.apiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          recipient: "+20100000000",
          body: "caption",
          media: {
            kind: "image",
            mimeType: "image/png",
            bucket: "whatsapp-outbound",
            storagePath: path,
            fileName: "photo.png",
            voiceNote: false,
          },
        }),
      });

      assert.equal(response.status, 200);
      assert.equal(harness.socket.sends.length, 1);
      assert.equal(Buffer.isBuffer(harness.socket.sends[0]?.content.image), true);
    } finally {
      await close(server).catch(() => undefined);
      harness.restore();
    }
  });

  it("keeps the worker request-body ceiling at 64 KB", async () => {
    const harness = await connectedSession();
    harness.restore();
    const config = testConfig();
    const server = createWorkerServer(config, harness.sessions, harness.store.asStore());
    try {
      const port = await listen(server);
      const response = await fetch(`http://127.0.0.1:${port}/v1/sessions/${CLINIC_A}/messages`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.apiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ recipient: "+20100000000", body: "x".repeat(65 * 1024) }),
      });

      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: "invalid_body" });
      assert.equal(harness.socket.sends.length, 0);
    } finally {
      await close(server).catch(() => undefined);
      harness.restore();
    }
  });

  it("returns a media-specific rejection before session lookup", async () => {
    const harness = await connectedSession();
    harness.restore();
    const config = testConfig();
    const server = createWorkerServer(config, harness.sessions, harness.store.asStore());
    try {
      const port = await listen(server);
      const response = await fetch(`http://127.0.0.1:${port}/v1/sessions/${CLINIC_A}/messages`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.apiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          recipient: "+20100000000",
          body: "",
          media: {
            kind: "image",
            mimeType: "image/png",
            bucket: "whatsapp-outbound",
            storagePath: "another-clinic/photo.png",
            fileName: "photo.png",
            voiceNote: false,
          },
        }),
      });

      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: "MEDIA_REQUEST_REJECTED" });
      assert.equal(harness.socket.sends.length, 0);
    } finally {
      await close(server).catch(() => undefined);
      harness.restore();
    }
  });
});
