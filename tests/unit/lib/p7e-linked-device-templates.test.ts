import { describe, expect, it } from "vitest";
import {
  AUTOMATED_TEMPLATE_APPROVAL_STATES,
  pickAutomatedTemplate,
} from "@/lib/messaging/automated-send";

/**
 * P7E — which stored template an automated send may actually use, per transport.
 *
 * Template approval is a Cloud API rule: Meta reviews a template before a WABA
 * may send it, and that gate must stay exactly as strict as it was. A linked
 * device sends from the clinic's own WhatsApp account, where there is no
 * catalogue and no reviewer — so refusing to send a clinic's own reminder text
 * there would silently break reminders for every QR-connected clinic.
 */

type Row = Parameters<typeof pickAutomatedTemplate>[0][number];

function template(overrides: Partial<Row>): Row {
  return {
    id: "template-1",
    name: "appointment_reminder",
    language: "en",
    variables: ["patient_name"],
    approval_status: "approved",
    channel: "whatsapp",
    ...overrides,
  } as Row;
}

describe("automated template selection", () => {
  it("loads every state a transport could possibly use", () => {
    expect([...AUTOMATED_TEMPLATE_APPROVAL_STATES]).toEqual([
      "approved",
      "submitted",
      "draft",
    ]);
  });

  it("keeps the Cloud API gate strict", () => {
    const candidates = [
      template({ id: "draft", approval_status: "draft" }),
      template({ id: "submitted", approval_status: "submitted" }),
    ];
    expect(pickAutomatedTemplate(candidates, "en", "meta")).toBeNull();
    expect(pickAutomatedTemplate(candidates, "en", "dialog360")).toBeNull();
    // An unspecified transport reads as Cloud API — the strict side.
    expect(pickAutomatedTemplate(candidates, "en")).toBeNull();
    expect(
      pickAutomatedTemplate([...candidates, template({ id: "ok" })], "en", "meta")?.id,
    ).toBe("ok");
  });

  it("lets a linked device use the clinic's own unreviewed template", () => {
    const picked = pickAutomatedTemplate(
      [template({ id: "draft", approval_status: "draft" })],
      "en",
      "linked_device",
    );
    expect(picked?.id).toBe("draft");
  });

  it("still refuses a template the clinic's own provider rejected", () => {
    expect(
      pickAutomatedTemplate(
        [template({ id: "rejected", approval_status: "rejected" })],
        "en",
        "linked_device",
      ),
    ).toBeNull();
  });

  it("prefers the clinic locale on either transport", () => {
    const candidates = [
      template({ id: "en", language: "en", approval_status: "draft" }),
      template({ id: "ar", language: "ar", approval_status: "draft" }),
    ];
    expect(pickAutomatedTemplate(candidates, "ar", "linked_device")?.id).toBe("ar");
  });

  it("ignores templates belonging to another channel", () => {
    expect(
      pickAutomatedTemplate(
        [template({ id: "email", channel: "email", approval_status: "draft" })],
        "en",
        "linked_device",
      ),
    ).toBeNull();
  });
});
