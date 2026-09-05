import { describe, expect, it } from "vitest";
import {
  parseLinkedDeviceCallback,
  readLinkedDeviceCallbackAccountId,
  scopedLinkedDeviceMessageId,
} from "@/lib/messaging/whatsapp-linked-device";

const ACCOUNT_A = "+201111111111";
const ACCOUNT_B = "+202222222222";

describe("linked-device authenticated callback identity", () => {
  it("accepts only normalized worker-observed PN identity", () => {
    expect(readLinkedDeviceCallbackAccountId(JSON.stringify({ sessionPhone: ACCOUNT_A })))
      .toBe(ACCOUNT_A);
    expect(readLinkedDeviceCallbackAccountId(JSON.stringify({ sessionPhone: "201111111111" })))
      .toBeNull();
    expect(readLinkedDeviceCallbackAccountId("not-json")).toBeNull();
  });

  it("namespaces identical Baileys ids by account", () => {
    const a = scopedLinkedDeviceMessageId(ACCOUNT_A, "BAILEYS-ID");
    const b = scopedLinkedDeviceMessageId(ACCOUNT_B, "BAILEYS-ID");
    expect(a).not.toBe(b);
    expect(a).toHaveLength(b.length);
  });

  it("binds every parsed event to the proved callback account", () => {
    const [event] = parseLinkedDeviceCallback(JSON.stringify({
      clinicId: "clinic",
      sessionPhone: ACCOUNT_A,
      events: [{
        kind: "inbound",
        sender: "+209999999999",
        providerMessageId: "same-id",
        body: "hello",
        receivedAt: "2026-09-02T12:00:00.000Z",
      }],
    }), ACCOUNT_A);
    expect(event).toMatchObject({
      kind: "inbound",
      phoneNumberId: ACCOUNT_A,
      providerMessageId: scopedLinkedDeviceMessageId(ACCOUNT_A, "same-id"),
    });
  });
});
