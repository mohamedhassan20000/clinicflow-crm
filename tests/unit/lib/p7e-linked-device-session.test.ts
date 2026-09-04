import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P7E — the application's side of a pairing: reading its state for the clinic,
 * starting it, and tearing it down.
 *
 * The interesting properties here are the ones a clinic would notice: the QR is
 * only ever offered when it is genuinely live, the pairing refuses to start
 * behind the Meta API method, and a disconnect leaves nothing behind even when
 * the worker cannot be reached.
 */

const mocks = vi.hoisted(() => ({
  scopedClient: vi.fn(),
  toDataURL: vi.fn(),
}));

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn(), addBreadcrumb: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createClinicScopedAdminClient: mocks.scopedClient }));
vi.mock("qrcode", () => ({ default: { toDataURL: mocks.toDataURL } }));

import {
  disconnectLinkedDeviceSession,
  isLinkedDeviceConfigured,
  readLinkedDeviceSession,
  startLinkedDeviceSession,
} from "@/lib/messaging/linked-device";

type TableResult = { data: unknown; error: unknown };

/**
 * A minimal clinic-scoped client stand-in. Reads are answered per table and
 * writes are recorded, so a test can assert what a disconnect actually did.
 */
function fakeClient(
  reads: Record<string, TableResult>,
  writes: Array<{ table: string; op: string; payload?: unknown }> = [],
) {
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
        update: (payload: unknown) => {
          writes.push({ table, op: "update", payload });
          return { eq: () => Promise.resolve({ error: null }) };
        },
        delete: () => {
          writes.push({ table, op: "delete" });
          const deleteChain = {
            eq: () => deleteChain,
            then: (resolve: (value: { error: null }) => unknown) => resolve({ error: null }),
          };
          return deleteChain;
        },
      });
      return chain;
    },
  };
}

const WORKER = "https://worker.internal";

beforeEach(() => {
  vi.clearAllMocks();
  process.env.WHATSAPP_WORKER_URL = WORKER;
  process.env.WHATSAPP_WORKER_TOKEN = "worker-token-that-is-long-enough-00000000";
  mocks.toDataURL.mockResolvedValue("data:image/png;base64,QRCODE");
});

afterEach(() => {
  delete process.env.WHATSAPP_WORKER_URL;
  delete process.env.WHATSAPP_WORKER_TOKEN;
  vi.restoreAllMocks();
});

describe("availability", () => {
  it("is unavailable until a worker is configured", () => {
    expect(isLinkedDeviceConfigured()).toBe(true);
    delete process.env.WHATSAPP_WORKER_URL;
    expect(isLinkedDeviceConfigured()).toBe(false);
  });

  it("refuses a plaintext worker address outside loopback", () => {
    process.env.WHATSAPP_WORKER_URL = "http://worker.public.example";
    expect(isLinkedDeviceConfigured()).toBe(false);
    process.env.WHATSAPP_WORKER_URL = "http://localhost:8080";
    expect(isLinkedDeviceConfigured()).toBe(true);
  });
});

describe("reading a pairing", () => {
  it("reports a clinic that has never paired as not started", async () => {
    mocks.scopedClient.mockReturnValue(
      fakeClient({ whatsapp_linked_device_sessions: { data: null, error: null } }),
    );
    await expect(readLinkedDeviceSession("clinic-a")).resolves.toMatchObject({
      status: "not_started",
      qrImage: null,
      phoneNumber: null,
    });
  });

  it("renders the code only while one is genuinely on offer", async () => {
    mocks.scopedClient.mockReturnValue(
      fakeClient({
        whatsapp_linked_device_sessions: {
          data: {
            status: "awaiting_scan",
            qr_payload: "2@real-pairing-payload",
            qr_expires_at: new Date(Date.now() + 30_000).toISOString(),
            phone_number: null,
            connected_at: null,
            last_error: null,
          },
          error: null,
        },
      }),
    );
    const view = await readLinkedDeviceSession("clinic-a");
    expect(view.status).toBe("awaiting_scan");
    expect(view.qrImage).toBe("data:image/png;base64,QRCODE");
    // The payload itself is rendered on the server; only the picture crosses.
    expect(mocks.toDataURL).toHaveBeenCalledWith("2@real-pairing-payload", expect.anything());
    expect(JSON.stringify(view)).not.toContain("2@real-pairing-payload");
  });

  it("never offers a code that has already lapsed", async () => {
    mocks.scopedClient.mockReturnValue(
      fakeClient({
        whatsapp_linked_device_sessions: {
          data: {
            status: "awaiting_scan",
            qr_payload: "2@stale",
            qr_expires_at: new Date(Date.now() - 1_000).toISOString(),
            phone_number: null,
            connected_at: null,
            last_error: null,
          },
          error: null,
        },
      }),
    );
    const view = await readLinkedDeviceSession("clinic-a");
    expect(view.qrImage).toBeNull();
    expect(view.qrExpiresAt).toBeNull();
  });

  it("shows the number only once the pairing is really connected", async () => {
    mocks.scopedClient.mockReturnValue(
      fakeClient({
        whatsapp_linked_device_sessions: {
          data: {
            status: "connecting",
            qr_payload: null,
            qr_expires_at: null,
            phone_number: "+201111111111",
            connected_at: "2026-08-17T09:00:00.000Z",
            last_error: null,
          },
          error: null,
        },
      }),
    );
    await expect(readLinkedDeviceSession("clinic-a")).resolves.toMatchObject({
      status: "connecting",
      phoneNumber: null,
      connectedAt: null,
    });
  });

  it("collapses a stored failure to a known code", async () => {
    mocks.scopedClient.mockReturnValue(
      fakeClient({
        whatsapp_linked_device_sessions: {
          data: {
            status: "error",
            qr_payload: null,
            qr_expires_at: null,
            phone_number: null,
            connected_at: null,
            last_error: "some raw library text",
          },
          error: null,
        },
      }),
    );
    await expect(readLinkedDeviceSession("clinic-a")).resolves.toMatchObject({
      status: "error",
      errorCode: "unknown",
    });
  });
});

describe("starting a pairing", () => {
  it("refuses while the Meta API method owns the clinic's channel", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    mocks.scopedClient.mockReturnValue(
      fakeClient({ clinic_channels: { data: { provider: "meta" }, error: null } }),
    );
    await expect(startLinkedDeviceSession("clinic-a")).resolves.toEqual({
      ok: false,
      code: "OWNED_BY_META",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("asks the worker for this clinic's session and returns the fresh view", async () => {
    // The pairing path now begins with a compatibility probe: a worker that
    // predates account isolation must not be paired against, so `/healthz` has
    // to answer with the protocol advertisement before `/start` is reached.
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input) =>
      Promise.resolve(
        String(input).endsWith("/healthz")
          ? Response.json({ ok: true, workerProtocolVersion: 2, linkedAccountIsolation: true })
          : Response.json({ ok: true }),
      ),
    );
    mocks.scopedClient.mockReturnValue(
      fakeClient({
        clinic_channels: { data: null, error: null },
        whatsapp_linked_device_sessions: {
          data: {
            status: "starting",
            qr_payload: null,
            qr_expires_at: null,
            phone_number: null,
            connected_at: null,
            last_error: null,
          },
          error: null,
        },
      }),
    );
    const started = await startLinkedDeviceSession("clinic-a");
    expect(started).toMatchObject({ ok: true });
    expect(fetchMock.mock.calls.map((call) => String(call[0] as URL))).toEqual([
      `${WORKER}/healthz`,
      `${WORKER}/v1/sessions/clinic-a/start`,
    ]);
  });

  it("reports an unreachable worker as unavailable, not as a clinic error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    mocks.scopedClient.mockReturnValue(
      fakeClient({
        clinic_channels: { data: null, error: null },
        whatsapp_linked_device_sessions: { data: null, error: null },
      }),
    );
    await expect(startLinkedDeviceSession("clinic-a")).resolves.toEqual({
      ok: false,
      code: "UNAVAILABLE",
    });
  });
});

describe("disconnecting", () => {
  it("releases the channel, the session and the stored identity even when the worker is down", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    const writes: Array<{ table: string; op: string; payload?: unknown }> = [];
    mocks.scopedClient.mockReturnValue(fakeClient({}, writes));

    const result = await disconnectLinkedDeviceSession("clinic-a");

    expect(result).toEqual({ ok: true, workerReached: false });
    expect(writes).toEqual(
      expect.arrayContaining([
        { table: "clinic_channels", op: "delete" },
        { table: "whatsapp_linked_device_auth", op: "delete" },
        expect.objectContaining({
          table: "whatsapp_linked_device_sessions",
          op: "update",
          payload: expect.objectContaining({ desired_state: "offline", phone_number: null }),
        }),
      ]),
    );
  });
});
