import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import {
  linkedDeviceWhatsAppProvider,
  parseLinkedDeviceCallback,
  readLinkedDeviceCallbackClinicId,
  scopedLinkedDeviceMessageId,
  signLinkedDeviceCallback,
} from "@/lib/messaging/whatsapp-linked-device";

/**
 * P7E — the linked-device adapter's two edges: what it sends to a clinic's own
 * pairing worker, and what it will accept back from it.
 */

const SECRET = "callback-secret-that-is-long-enough-000000";
const WORKER = "https://worker.internal";
const TOKEN = "worker-token-that-is-long-enough-00000000";

function callbackRequest(body: string, options?: { timestamp?: string; signature?: string }) {
  const timestamp = options?.timestamp ?? String(Date.now());
  return new Request("https://clinic.example/api/webhooks/whatsapp/linked-device", {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      "x-clinicflow-timestamp": timestamp,
      "x-clinicflow-signature":
        options?.signature ?? signLinkedDeviceCallback(timestamp, body, SECRET),
    },
  });
}

beforeEach(() => {
  process.env.WHATSAPP_WORKER_URL = WORKER;
  process.env.WHATSAPP_WORKER_TOKEN = TOKEN;
  process.env.WHATSAPP_WORKER_CALLBACK_SECRET = SECRET;
  vi.restoreAllMocks();
});

afterEach(() => {
  delete process.env.WHATSAPP_WORKER_URL;
  delete process.env.WHATSAPP_WORKER_TOKEN;
  delete process.env.WHATSAPP_WORKER_CALLBACK_SECRET;
});

describe("worker callback authenticity", () => {
  const body = JSON.stringify({ clinicId: "clinic-a", events: [] });

  it("accepts a correctly signed, fresh callback", async () => {
    await expect(
      linkedDeviceWhatsAppProvider.verifySignature(callbackRequest(body), {}),
    ).resolves.toBe(true);
  });

  it("refuses a body that was altered after signing", async () => {
    const timestamp = String(Date.now());
    const signature = signLinkedDeviceCallback(timestamp, body, SECRET);
    const tampered = JSON.stringify({ clinicId: "clinic-b", events: [] });
    await expect(
      linkedDeviceWhatsAppProvider.verifySignature(
        callbackRequest(tampered, { timestamp, signature }),
        {},
      ),
    ).resolves.toBe(false);
  });

  it("refuses a signature made with a different secret", async () => {
    const timestamp = String(Date.now());
    const signature = createHmac("sha256", "someone-elses-secret")
      .update(`${timestamp}.${body}`, "utf8")
      .digest("hex");
    await expect(
      linkedDeviceWhatsAppProvider.verifySignature(
        callbackRequest(body, { timestamp, signature }),
        {},
      ),
    ).resolves.toBe(false);
  });

  it("refuses a replay from outside the timestamp window", async () => {
    const stale = String(Date.now() - 10 * 60 * 1000);
    await expect(
      linkedDeviceWhatsAppProvider.verifySignature(
        callbackRequest(body, { timestamp: stale }),
        {},
      ),
    ).resolves.toBe(false);
  });

  it("refuses everything when no callback secret is configured", async () => {
    delete process.env.WHATSAPP_WORKER_CALLBACK_SECRET;
    await expect(
      linkedDeviceWhatsAppProvider.verifySignature(callbackRequest(body), {}),
    ).resolves.toBe(false);
  });
});

describe("callback parsing", () => {
  it("reads the claimed clinic without trusting it", () => {
    expect(readLinkedDeviceCallbackClinicId(JSON.stringify({ clinicId: " c1 " }))).toBe("c1");
    expect(readLinkedDeviceCallbackClinicId("not json")).toBeNull();
    expect(readLinkedDeviceCallbackClinicId(JSON.stringify({}))).toBeNull();
  });

  it("binds inbound events to the channel's own sender identity", () => {
    const events = parseLinkedDeviceCallback(
      JSON.stringify({
        clinicId: "c1",
        // A payload claiming some other identity must not be able to set it.
        sessionPhone: "+20999999999",
        events: [
          {
            kind: "inbound",
            providerMessageId: "WA1",
            sender: "+201000000000",
            body: "hello",
            receivedAt: "2026-08-17T10:00:00.000Z",
          },
        ],
      }),
      "+201111111111",
    );
    expect(events).toEqual([
      {
        kind: "inbound",
        phoneNumberId: "+201111111111",
        sender: "+201000000000",
        providerMessageId: scopedLinkedDeviceMessageId("+201111111111", "WA1"),
        body: "hello",
        receivedAt: "2026-08-17T10:00:00.000Z",
        // P8 additions: absent on this payload, and reported as absent rather
        // than left undefined for the persistence layer to interpret.
        displayName: null,
        historical: false,
        attachments: [],
      },
    ]);
  });

  it("drops an inbound event when the channel has no sender identity", () => {
    const events = parseLinkedDeviceCallback(
      JSON.stringify({
        clinicId: "c1",
        events: [{ kind: "inbound", providerMessageId: "WA1", sender: "+201000000000", body: "x" }],
      }),
      null,
    );
    expect(events).toEqual([{ kind: "ignored", reason: "unsupported_event" }]);
  });

  it("normalizes phone echoes and receipts", () => {
    const events = parseLinkedDeviceCallback(
      JSON.stringify({
        clinicId: "c1",
        events: [
          {
            kind: "outbound_echo",
            providerMessageId: "WA2",
            recipient: "+201000000000",
            body: "sent from the phone",
            occurredAt: "2026-08-17T10:05:00.000Z",
          },
          {
            kind: "status",
            providerMessageId: "WA3",
            status: "delivered",
            occurredAt: "2026-08-17T10:06:00.000Z",
          },
        ],
      }),
      "+201111111111",
    );
    expect(events[0]).toMatchObject({ kind: "outbound_echo", recipient: "+201000000000" });
    expect(events[1]).toMatchObject({ kind: "status", status: "delivered", error: null });
  });

  it("ignores unknown kinds, unknown statuses and malformed entries", () => {
    const events = parseLinkedDeviceCallback(
      JSON.stringify({
        clinicId: "c1",
        events: [
          { kind: "wallet_transfer", providerMessageId: "WA4" },
          { kind: "status", providerMessageId: "WA5", status: "exploded" },
          { kind: "inbound", sender: "+2010" },
          null,
        ],
      }),
      "+201111111111",
    );
    expect(events).toHaveLength(4);
    expect(events.every((event) => event.kind === "ignored")).toBe(true);
  });

  it("returns nothing for a payload that is not an event batch", () => {
    expect(parseLinkedDeviceCallback("not json", "+20")).toEqual([]);
    expect(parseLinkedDeviceCallback(JSON.stringify({ clinicId: "c1" }), "+20")).toEqual([]);
  });
});

describe("sending", () => {
  const message = {
    channel: "whatsapp" as const,
    recipient: "+201000000000",
    body: "Your appointment is confirmed.",
    senderIdentity: "+201111111111",
    clientReference: "11111111-1111-4111-8111-111111111111",
  };
  const mediaMessage = {
    ...message,
    body: "caption",
    media: {
      kind: "image" as const,
      mimeType: "image/jpeg",
      bucket: "whatsapp-outbound" as const,
      storagePath: "clinic-a/2026-08/photo.jpg",
      fileName: "photo.jpg",
      voiceNote: false,
    },
  };

  it("routes the send to the clinic's own session and returns the message id", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ ok: true, providerMessageId: "WA9" }));

    const result = await linkedDeviceWhatsAppProvider.send(message, {
      clinicId: "clinic-a",
      displayPhoneNumber: "+201111111111",
    });

    expect(result).toEqual({
      ok: true,
      providerMessageId: scopedLinkedDeviceMessageId("+201111111111", "WA9"),
      costMicro: null,
    });
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    // The clinic id comes from the channel's own envelope, so a send can never
    // be routed onto another clinic's session.
    expect(url.toString()).toBe(`${WORKER}/v1/sessions/clinic-a/messages`);
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(String(init.body)) as unknown).toEqual({
      recipient: message.recipient,
      body: message.body,
      clientReference: message.clientReference,
    });
  });

  it("routes a send to the local worker when local development points at one", async () => {
    // P11K. Local testing runs a worker on the developer's own machine against
    // the real database, so `WHATSAPP_WORKER_URL` is the only thing deciding
    // which process gets the send. A reply typed into the localhost Inbox must
    // reach the socket the local worker is holding — never the deployed origin,
    // which is holding a different socket for the same clinic and would send the
    // message from production while the developer waited on their own logs.
    const deployed = "https://whatsapp-worker.example";
    process.env.WHATSAPP_WORKER_URL = "http://127.0.0.1:8787";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ ok: true, providerMessageId: "WA-LOCAL" }));

    await expect(
      linkedDeviceWhatsAppProvider.send(message, {
        clinicId: "clinic-a",
        displayPhoneNumber: "+201111111111",
      }),
    ).resolves.toMatchObject({
      ok: true,
      providerMessageId: scopedLinkedDeviceMessageId("+201111111111", "WA-LOCAL"),
    });

    const [url] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("http://127.0.0.1:8787/v1/sessions/clinic-a/messages");
    expect(url.toString().startsWith(deployed)).toBe(false);
  });

  it("refuses to send without a clinic id in the envelope", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const result = await linkedDeviceWhatsAppProvider.send(message, {});
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the complete typed media reference without bytes or a storage URL", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ ok: true, providerMessageId: "WA10" }));

    await expect(
      linkedDeviceWhatsAppProvider.send(mediaMessage, {
        clinicId: "clinic-a",
        displayPhoneNumber: "+201111111111",
      }),
    ).resolves.toMatchObject({
      ok: true,
      providerMessageId: scopedLinkedDeviceMessageId("+201111111111", "WA10"),
    });

    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      recipient: mediaMessage.recipient,
      body: "caption",
      clientReference: mediaMessage.clientReference,
      media: mediaMessage.media,
    });
  });

  it("refuses to send when the worker is not configured", async () => {
    delete process.env.WHATSAPP_WORKER_URL;
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const result = await linkedDeviceWhatsAppProvider.send(message, { clinicId: "clinic-a" });
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a refusal as final and a worker fault as ambiguous", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      Response.json({ error: "invalid_message" }, { status: 400 }),
    );
    const refused = await linkedDeviceWhatsAppProvider.send(message, { clinicId: "clinic-a" });
    expect(refused).toMatchObject({ ok: false });
    expect((refused as { ambiguous?: boolean }).ambiguous).toBeUndefined();

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      Response.json({ error: "internal" }, { status: 503 }),
    );
    const faulted = await linkedDeviceWhatsAppProvider.send(message, { clinicId: "clinic-a" });
    expect(faulted).toMatchObject({ ok: false, ambiguous: true });
  });

  it("treats unavailable storage media as a deterministic pre-send refusal", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      Response.json({ ok: false, error: "MEDIA_UNAVAILABLE" }, { status: 502 }),
    );
    const refused = await linkedDeviceWhatsAppProvider.send(mediaMessage, { clinicId: "clinic-a" });
    expect(refused).toMatchObject({
      ok: false,
      failureCode: "MEDIA_STORAGE_FETCH_FAILED",
    });
    expect((refused as { ambiguous?: boolean }).ambiguous).toBeUndefined();
  });

  it("identifies an old text-only worker rejection as a retryable request-stage failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      Response.json({ error: "invalid_message" }, { status: 400 }),
    );
    await expect(
      linkedDeviceWhatsAppProvider.send(mediaMessage, { clinicId: "clinic-a" }),
    ).resolves.toMatchObject({
      ok: false,
      failureCode: "MEDIA_REQUEST_REJECTED",
    });
  });

  it("treats a network loss as ambiguous rather than failed", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("socket hang up"));
    const result = await linkedDeviceWhatsAppProvider.send(message, { clinicId: "clinic-a" });
    expect(result).toMatchObject({ ok: false, ambiguous: true });
  });
});
