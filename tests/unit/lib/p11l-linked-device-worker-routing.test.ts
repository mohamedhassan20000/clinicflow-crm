import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P11L — which worker "Connect with QR" actually calls, and what the clinic is
 * told when that call does not succeed.
 *
 * The failure this suite exists to prevent: a developer set
 * `WHATSAPP_WORKER_URL=http://127.0.0.1:8787`, ran the worker, pressed Connect
 * with QR, and got no code and no worker output. Everyone concluded the request
 * was never made. It was — it reached the local worker over loopback and came
 * back 409, because a deployed worker against the same database still owned the
 * clinic's session, and the application collapsed that 409 into "the service is
 * unavailable" while leaving the panel spinning on a row that would never
 * change.
 *
 * These tests therefore run against a *real* HTTP server on loopback rather
 * than a mocked `fetch`: the properties that broke were the address, the method,
 * the path and the header — the four things a `fetch` mock is least able to
 * hold honest.
 */

const mocks = vi.hoisted(() => ({
  scopedClient: vi.fn(),
  toDataURL: vi.fn(),
}));

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn(), addBreadcrumb: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createClinicScopedAdminClient: mocks.scopedClient }));
vi.mock("qrcode", () => ({ default: { toDataURL: mocks.toDataURL } }));

import {
  isLinkedDeviceConfigured,
  readLinkedDeviceSession,
  startLinkedDeviceSession,
} from "@/lib/messaging/linked-device";

const CLINIC = "93000000-0000-4000-8000-000000000001";
const TOKEN = "a-local-worker-token-that-is-long-enough";

type Received = { method: string; url: string; authorization: string | undefined; host: string };

/**
 * What a worker that speaks the current protocol answers `/healthz` with. The
 * application refuses to start a pairing without it, so every stub that is
 * meant to *reach* the start path has to make the same promise a real worker
 * does.
 */
const COMPATIBLE_HEALTH = { ok: true, workerProtocolVersion: 2, linkedAccountIsolation: true };

/**
 * A worker on loopback that records what it was asked and answers as told.
 *
 * The compatibility probe is answered separately and recorded in `probes`
 * rather than `received`: it is not a pairing call, and folding it in would
 * make every "how many times was the worker asked to start" assertion below
 * off by one for a reason that has nothing to do with what they test.
 */
async function workerStub(
  reply: { status: number; body?: unknown } = { status: 200, body: { ok: true } },
  health: { status: number; body?: unknown } = { status: 200, body: COMPATIBLE_HEALTH },
) {
  const received: Received[] = [];
  const probes: Received[] = [];
  const server: Server = createServer((request: IncomingMessage, response) => {
    const entry: Received = {
      method: request.method ?? "",
      url: request.url ?? "",
      authorization: request.headers.authorization,
      host: request.headers.host ?? "",
    };
    if (entry.url === "/healthz") {
      probes.push(entry);
      const healthBody = JSON.stringify(health.body ?? { ok: health.status < 400 });
      response.writeHead(health.status, { "content-type": "application/json" });
      response.end(healthBody);
      return;
    }
    received.push(entry);
    const body = JSON.stringify(reply.body ?? { ok: reply.status < 400 });
    response.writeHead(reply.status, { "content-type": "application/json" });
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    received,
    probes,
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Reads answered per table; nothing here needs to record writes. */
function fakeClient(reads: Record<string, { data: unknown; error: unknown }>) {
  return {
    from(table: string) {
      const result = reads[table] ?? { data: null, error: null };
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      Object.assign(chain, {
        select: self,
        eq: self,
        neq: self,
        maybeSingle: () => Promise.resolve(result),
      });
      return chain;
    },
  };
}

/** No Meta channel in the way, and a session row in whatever state is given. */
function clinicWithSession(session: Record<string, unknown> | null) {
  mocks.scopedClient.mockReturnValue(
    fakeClient({
      clinic_channels: { data: null, error: null },
      whatsapp_linked_device_sessions: { data: session, error: null },
    }),
  );
}

const STARTING_ROW = {
  status: "starting",
  qr_payload: null,
  qr_expires_at: null,
  phone_number: null,
  connected_at: null,
  last_error: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.WHATSAPP_WORKER_TOKEN = TOKEN;
  mocks.toDataURL.mockResolvedValue("data:image/png;base64,QRCODE");
});

afterEach(() => {
  delete process.env.WHATSAPP_WORKER_URL;
  delete process.env.WHATSAPP_WORKER_TOKEN;
  vi.restoreAllMocks();
});

describe("which worker the application calls", () => {
  it("calls the loopback worker the server environment names, over real HTTP", async () => {
    const worker = await workerStub();
    try {
      process.env.WHATSAPP_WORKER_URL = worker.origin;
      clinicWithSession(STARTING_ROW);

      const result = await startLinkedDeviceSession(CLINIC);

      expect(result).toEqual({ ok: true, view: expect.objectContaining({ status: "starting" }) });
      expect(worker.received).toHaveLength(1);
      const call = worker.received[0]!;
      expect(call.method).toBe("POST");
      expect(call.url).toBe(`/v1/sessions/${CLINIC}/start`);
      expect(call.authorization).toBe(`Bearer ${TOKEN}`);
      // The address is the whole point: a call that went anywhere else would
      // still have satisfied every other assertion here.
      expect(call.host).toBe(worker.origin.replace("http://", ""));
    } finally {
      await worker.close();
    }
  });

  it("re-reads the address every call, so a deployed URL left in the process cannot capture one", async () => {
    const hosted = await workerStub();
    const local = await workerStub();
    try {
      // The shape of the mistake: a hosted worker configured first, a local one
      // configured after. Only the current value may be used.
      process.env.WHATSAPP_WORKER_URL = hosted.origin;
      expect(isLinkedDeviceConfigured()).toBe(true);
      process.env.WHATSAPP_WORKER_URL = local.origin;
      clinicWithSession(STARTING_ROW);

      await startLinkedDeviceSession(CLINIC);

      expect(local.received).toHaveLength(1);
      expect(hosted.received).toHaveLength(0);
    } finally {
      await Promise.all([hosted.close(), local.close()]);
    }
  });

  it("accepts a loopback worker over plain HTTP and a deployed one over HTTPS only", () => {
    process.env.WHATSAPP_WORKER_URL = "http://127.0.0.1:8787";
    expect(isLinkedDeviceConfigured()).toBe(true);
    process.env.WHATSAPP_WORKER_URL = "http://localhost:8787";
    expect(isLinkedDeviceConfigured()).toBe(true);
    // Production stays configurable — and stays encrypted.
    process.env.WHATSAPP_WORKER_URL = "https://whatsapp-worker.up.railway.app";
    expect(isLinkedDeviceConfigured()).toBe(true);
    process.env.WHATSAPP_WORKER_URL = "http://whatsapp-worker.up.railway.app";
    expect(isLinkedDeviceConfigured()).toBe(false);
  });

  it("makes no call at all when no worker is configured", async () => {
    delete process.env.WHATSAPP_WORKER_URL;
    const fetchMock = vi.spyOn(globalThis, "fetch");
    clinicWithSession(null);

    await expect(startLinkedDeviceSession(CLINIC)).resolves.toEqual({
      ok: false,
      code: "UNAVAILABLE",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("when the worker does not accept the start", () => {
  it("separates a session another worker holds from a service that is down", async () => {
    const refusing = await workerStub({ status: 409, body: { error: "owned_elsewhere" } });
    try {
      process.env.WHATSAPP_WORKER_URL = refusing.origin;
      clinicWithSession(STARTING_ROW);

      // The refusal that used to be reported as "unavailable" — which is what
      // sent a developer looking for a request that had in fact been made.
      await expect(startLinkedDeviceSession(CLINIC)).resolves.toEqual({
        ok: false,
        code: "OWNED_ELSEWHERE",
      });
      expect(refusing.received).toHaveLength(1);
    } finally {
      await refusing.close();
    }
  });

  it("reports a worker that is not running as unavailable", async () => {
    // A port nothing is listening on: connection refused, the exact shape of
    // "the operator forgot to start the worker".
    const dead = await workerStub();
    const origin = dead.origin;
    await dead.close();
    process.env.WHATSAPP_WORKER_URL = origin;
    clinicWithSession(null);

    await expect(startLinkedDeviceSession(CLINIC)).resolves.toEqual({
      ok: false,
      code: "UNAVAILABLE",
    });
  });

  it("treats a refused token as a rejection and never prints the token", async () => {
    const unauthorized = await workerStub({ status: 401, body: { error: "unauthorized" } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      process.env.WHATSAPP_WORKER_URL = unauthorized.origin;
      clinicWithSession(null);

      await expect(startLinkedDeviceSession(CLINIC)).resolves.toEqual({
        ok: false,
        code: "REJECTED",
      });

      const logged = warn.mock.calls.map((call) => String(call[0])).join("\n");
      // An operator has to be able to see *which* worker refused them.
      expect(logged).toContain(unauthorized.origin);
      expect(logged).toContain("401");
      expect(logged).not.toContain(TOKEN);
    } finally {
      await unauthorized.close();
    }
  });

  it("never asks the worker anything while the Meta API method owns the channel", async () => {
    const worker = await workerStub();
    try {
      process.env.WHATSAPP_WORKER_URL = worker.origin;
      mocks.scopedClient.mockReturnValue(
        fakeClient({ clinic_channels: { data: { provider: "meta" }, error: null } }),
      );

      await expect(startLinkedDeviceSession(CLINIC)).resolves.toEqual({
        ok: false,
        code: "OWNED_BY_META",
      });
      expect(worker.received).toHaveLength(0);
    } finally {
      await worker.close();
    }
  });
});

describe("what the panel reads back", () => {
  it("shows the code the worker published, and stops showing it when it lapses", async () => {
    clinicWithSession({
      status: "awaiting_scan",
      qr_payload: "2@a-real-pairing-payload",
      qr_expires_at: new Date(Date.now() + 30_000).toISOString(),
      phone_number: null,
      connected_at: null,
      last_error: null,
    });
    const live = await readLinkedDeviceSession(CLINIC);
    expect(live.status).toBe("awaiting_scan");
    expect(live.qrImage).toBe("data:image/png;base64,QRCODE");
    expect(live.qrExpiresAt).not.toBeNull();

    // The same row, one expiry later. The panel keeps polling — the status is
    // still transient — and the next code replaces this one.
    clinicWithSession({
      status: "awaiting_scan",
      qr_payload: "2@a-real-pairing-payload",
      qr_expires_at: new Date(Date.now() - 1).toISOString(),
      phone_number: null,
      connected_at: null,
      last_error: null,
    });
    const lapsed = await readLinkedDeviceSession(CLINIC);
    expect(lapsed.qrImage).toBeNull();
    expect(lapsed.qrExpiresAt).toBeNull();
  });

  it("carries the paired number through once the scan has completed", async () => {
    clinicWithSession({
      status: "connected",
      qr_payload: null,
      qr_expires_at: null,
      phone_number: "+96599999999",
      connected_at: "2026-08-29T18:00:00.000Z",
      last_error: null,
    });
    await expect(readLinkedDeviceSession(CLINIC)).resolves.toMatchObject({
      status: "connected",
      phoneNumber: "+96599999999",
      qrImage: null,
    });
  });
});

/**
 * The deployment-ordering guard.
 *
 * WhatsApp account isolation is implemented in both halves of this system: the
 * worker stamps an authenticated account on everything it writes, and the
 * application refuses to interpret anything unstamped. Between a web deploy and
 * a worker deploy there is a window in which an admin can press "Connect with
 * QR" against a worker that still writes account-less rows — and a row written
 * then can never afterwards be attributed to an account, so it can never be
 * adopted into one. That is a scan, not a deploy, so the refusal has to live in
 * front of the scan.
 */
describe("pairing against a worker that predates account isolation", () => {
  it("refuses before the worker is asked to start anything", async () => {
    // A worker from before the advertisement existed: healthy, answering,
    // simply silent about what it speaks.
    const outdated = await workerStub(undefined, { status: 200, body: { ok: true, workerId: "old" } });
    try {
      process.env.WHATSAPP_WORKER_URL = outdated.origin;
      clinicWithSession(null);

      await expect(startLinkedDeviceSession(CLINIC)).resolves.toEqual({
        ok: false,
        code: "WORKER_UPDATE_REQUIRED",
      });
      // The assertion that matters: it was probed and nothing else. No start,
      // so no auth state, no session mutation, no channel, no ownership change.
      expect(outdated.probes).toHaveLength(1);
      expect(outdated.received).toHaveLength(0);
    } finally {
      await outdated.close();
    }
  });

  it.each([
    ["a version below the one required", { ok: true, workerProtocolVersion: 1 }],
    ["a version that is not a number", { ok: true, workerProtocolVersion: "2" }],
    ["the capability explicitly withdrawn", { ok: true, workerProtocolVersion: 2, linkedAccountIsolation: false }],
  ])("refuses on %s", async (_label, body) => {
    const worker = await workerStub(undefined, { status: 200, body });
    try {
      process.env.WHATSAPP_WORKER_URL = worker.origin;
      clinicWithSession(null);

      await expect(startLinkedDeviceSession(CLINIC)).resolves.toEqual({
        ok: false,
        code: "WORKER_UPDATE_REQUIRED",
      });
      expect(worker.received).toHaveLength(0);
    } finally {
      await worker.close();
    }
  });

  it("still reads as unavailable — not out of date — when nothing answers", async () => {
    const worker = await workerStub(undefined, { status: 503, body: { error: "down" } });
    try {
      process.env.WHATSAPP_WORKER_URL = worker.origin;
      clinicWithSession(null);

      // An operator asked to "update the service" when the service is merely
      // restarting is sent to do the wrong thing.
      await expect(startLinkedDeviceSession(CLINIC)).resolves.toEqual({
        ok: false,
        code: "UNAVAILABLE",
      });
      expect(worker.received).toHaveLength(0);
    } finally {
      await worker.close();
    }
  });

  it("lets a compatible worker pair exactly as before", async () => {
    const worker = await workerStub();
    try {
      process.env.WHATSAPP_WORKER_URL = worker.origin;
      clinicWithSession(STARTING_ROW);

      await expect(startLinkedDeviceSession(CLINIC)).resolves.toEqual({
        ok: true,
        view: expect.objectContaining({ status: "starting" }),
      });
      expect(worker.probes).toHaveLength(1);
      expect(worker.received.map((call) => `${call.method} ${call.url}`)).toEqual([
        `POST /v1/sessions/${CLINIC}/start`,
      ]);
    } finally {
      await worker.close();
    }
  });
});
