import { describe, expect, it } from "vitest";
import {
  getWhatsAppProviderCapabilities,
  isTemplateUsableForWhatsAppProvider,
  resolveActiveChannels,
} from "@/lib/messaging/provider-policy";

describe("WhatsApp provider policy", () => {
  it("allows linked-device freeform, reusable text templates, and media", () => {
    expect(getWhatsAppProviderCapabilities("linked_device")).toEqual({
      serviceWindowRequired: false,
      approvedTemplateRequired: false,
      mediaSupported: true,
    });
    expect(isTemplateUsableForWhatsAppProvider("linked_device", "draft")).toBe(true);
    expect(isTemplateUsableForWhatsAppProvider("linked_device", "submitted")).toBe(true);
    expect(isTemplateUsableForWhatsAppProvider("linked_device", "approved")).toBe(true);
    expect(isTemplateUsableForWhatsAppProvider("linked_device", "rejected")).toBe(false);
  });

  it.each(["meta", "dialog360"] as const)(
    "keeps the %s Cloud API window, approval, and media policy strict",
    (provider) => {
      expect(getWhatsAppProviderCapabilities(provider)).toEqual({
        serviceWindowRequired: true,
        approvedTemplateRequired: true,
        mediaSupported: false,
      });
      expect(isTemplateUsableForWhatsAppProvider(provider, "draft")).toBe(false);
      expect(isTemplateUsableForWhatsAppProvider(provider, "submitted")).toBe(false);
      expect(isTemplateUsableForWhatsAppProvider(provider, "approved")).toBe(true);
      expect(isTemplateUsableForWhatsAppProvider(provider, "rejected")).toBe(false);
    },
  );

  it("defaults a missing provider to the strict Cloud API policy", () => {
    expect(getWhatsAppProviderCapabilities(null).serviceWindowRequired).toBe(true);
    expect(getWhatsAppProviderCapabilities(null).mediaSupported).toBe(false);
    expect(isTemplateUsableForWhatsAppProvider(null, "draft")).toBe(false);
  });

  it("uses the same deterministic active-provider fallback as the send path", () => {
    const active = resolveActiveChannels([
      { channel: "whatsapp", provider: "linked_device", id: "linked" },
      { channel: "email", provider: "resend", id: "email" },
      { channel: "whatsapp", provider: "meta", id: "meta" },
    ]);
    expect(active.get("whatsapp")?.id).toBe("meta");
    expect(active.get("email")?.id).toBe("email");
  });
});
