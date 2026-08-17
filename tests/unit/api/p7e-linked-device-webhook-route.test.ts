import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P7E — the pairing worker's callback route.
 *
 * The route is the tenant boundary for everything a linked device receives, so
 * these cases are all about what it refuses: an unsigned caller, a caller
 * claiming a clinic it cannot prove, and a clinic whose pairing is not the
 * active channel. What survives goes through the same pipeline as Cloud API
 * traffic, bound to the sender identity on the *stored* channel rather than the
 * one the payload claimed.
 */

const mocks = vi.hoisted(() => ({
  rateLimit: vi.fn(),
  verify: vi.fn(),
  parse: vi.fn(),
  readClinicId: vi.fn(),
  process: vi.fn(),
  scopedClient: vi.fn(),
}));

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
vi.mock("@/lib/messaging/webhook-http", () => ({
  enforceWebhookRateLimit: mocks.rateLimit,
  unauthorizedWebhookResponse: () => Response.json({ error: "Unauthorized" }, { status: 401 }),
  unavailableWebhookResponse: () =>
    Response.json({ error: "Webhook temporarily unavailable" }, { status: 503 }),
}));
vi.mock("@/lib/messaging/webhooks", () => ({ processMessagingWebhookEvents: mocks.process }));
vi.mock("@/lib/messaging/whatsapp-linked-device", () => ({
  linkedDeviceWhatsAppProvider: { verifySignature: mocks.verify },
  parseLinkedDeviceCallback: mocks.parse,
  readLinkedDeviceCallbackClinicId: mocks.readClinicId,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createClinicScopedAdminClient: mocks.scopedClient,
}));

import { POST } from "@/app/api/webhooks/whatsapp/linked-device/route";

/** A clinic-scoped read returning one channel row (or an error). */
function channelLookup(result: { data: unknown; error: unknown }) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: () => Promise.resolve(result),
  };
  return { from: () => chain };
}

function request(body = JSON.stringify({ clinicId: "clinic-a", events: [] })) {
  return new Request("https://clinic.example/api/webhooks/whatsapp/linked-device", {
    method: "POST",
    body,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rateLimit.mockResolvedValue(null);
  mocks.verify.mockResolvedValue(true);
  mocks.readClinicId.mockReturnValue("clinic-a");
  mocks.parse.mockReturnValue([{ kind: "ignored", reason: "test" }]);
  mocks.process.mockResolvedValue({ inbound: 1, echoes: 0, statuses: 0, ignored: 0 });
  mocks.scopedClient.mockReturnValue(
    channelLookup({ data: { sender_identity: "+201111111111", status: "active" }, error: null }),
  );
});

describe("linked-device callback route", () => {
  it("rejects an unsigned or badly signed callback before reading anything", async () => {
    mocks.verify.mockResolvedValue(false);
    const response = await POST(request());
    expect(response.status).toBe(401);
    expect(mocks.readClinicId).not.toHaveBeenCalled();
    expect(mocks.scopedClient).not.toHaveBeenCalled();
    expect(mocks.process).not.toHaveBeenCalled();
  });

  it("rejects a signed callback that names no clinic", async () => {
    mocks.readClinicId.mockReturnValue(null);
    const response = await POST(request());
    expect(response.status).toBe(401);
    expect(mocks.process).not.toHaveBeenCalled();
  });

  it("asks the worker to retry when the channel cannot be read", async () => {
    mocks.scopedClient.mockReturnValue(channelLookup({ data: null, error: { message: "down" } }));
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(mocks.process).not.toHaveBeenCalled();
  });

  it("acknowledges but drops traffic for a clinic with no active pairing", async () => {
    mocks.scopedClient.mockReturnValue(channelLookup({ data: null, error: null }));
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ignored: true });
    expect(mocks.process).not.toHaveBeenCalled();
  });

  it("drops traffic for a pairing that is no longer the active channel", async () => {
    mocks.scopedClient.mockReturnValue(
      channelLookup({ data: { sender_identity: "+201111111111", status: "pending" }, error: null }),
    );
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(mocks.process).not.toHaveBeenCalled();
  });

  it("processes verified traffic through the shared pipeline, scoped to the stored identity", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    // The clinic is read through the clinic-scoped admin client, so the lookup
    // itself cannot span tenants.
    expect(mocks.scopedClient).toHaveBeenCalledWith("clinic-a");
    // The sender identity handed to the parser and the pipeline is the stored
    // one, never a value taken from the payload.
    expect(mocks.parse).toHaveBeenCalledWith(expect.any(String), "+201111111111");
    expect(mocks.process).toHaveBeenCalledWith({
      provider: "linked_device",
      clinicId: "clinic-a",
      senderIdentity: "+201111111111",
      events: [{ kind: "ignored", reason: "test" }],
    });
  });

  it("honours the webhook rate limiter", async () => {
    mocks.rateLimit.mockResolvedValue(Response.json({ error: "slow down" }, { status: 429 }));
    const response = await POST(request());
    expect(response.status).toBe(429);
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it("reports a processing failure without leaking its cause", async () => {
    mocks.process.mockRejectedValue(new Error("boom: token=abc"));
    const response = await POST(request());
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("token=abc");
  });
});
