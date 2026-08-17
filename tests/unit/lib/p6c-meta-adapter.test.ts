import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  exchangeMetaSignupCode,
  extractMetaPhoneNumberId,
  fetchMetaChannelState,
  fetchMetaTemplates,
  metaWhatsAppProvider,
  provisionMetaEmbeddedSignup,
  submitMetaTemplate,
} from "@/lib/messaging/whatsapp-meta";

const inbound = readFileSync("tests/fixtures/messaging/meta-inbound.json", "utf8");
const accountUpdate = readFileSync("tests/fixtures/messaging/meta-account-update.json", "utf8");
const reviewRejected = readFileSync(
  "tests/fixtures/messaging/meta-account-review-rejected.json",
  "utf8",
);
const phoneQuality = readFileSync(
  "tests/fixtures/messaging/meta-phone-quality.json",
  "utf8",
);
const APP_SECRET = "meta-app-secret";
const credentials = {
  accessToken: "meta-system-user-token",
  phoneNumberId: "551234567890",
  wabaId: "waba-meta-1",
};

function signed(body: string, secret = APP_SECRET) {
  const digest = createHmac("sha256", secret).update(body, "utf8").digest("hex");
  return new Request("https://clinic.example/api/webhooks/whatsapp", {
    method: "POST",
    body,
    headers: { "x-hub-signature-256": `sha256=${digest}`, "content-type": "application/json" },
  });
}

beforeEach(() => {
  process.env.META_GRAPH_API_BASE_URL = "https://graph.test";
  process.env.META_APP_SECRET = APP_SECRET;
  process.env.META_APP_ID = "meta-app-id";
  process.env.META_BUSINESS_ID = "business-1";
  process.env.META_SYSTEM_USER_ID = "system-user-1";
  process.env.META_SYSTEM_USER_ACCESS_TOKEN = "system-user-token";
  process.env.META_PHONE_REGISTRATION_PIN = "123456";
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  delete process.env.META_GRAPH_API_BASE_URL;
  delete process.env.META_APP_SECRET;
  delete process.env.META_APP_ID;
  delete process.env.META_BUSINESS_ID;
  delete process.env.META_SYSTEM_USER_ID;
  delete process.env.META_SYSTEM_USER_ACCESS_TOKEN;
  delete process.env.META_PHONE_REGISTRATION_PIN;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("P6C Meta WhatsApp adapter", () => {
  it("sends through the Cloud API without leaking the token", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ messages: [{ id: "wamid.meta-out-1" }] }), { status: 200 }),
    );
    const result = await metaWhatsAppProvider.send(
      {
        channel: "whatsapp",
        recipient: "+15559998888",
        body: "See you tomorrow",
        senderIdentity: "551234567890",
        clientReference: "11111111-1111-4111-8111-111111111111",
      },
      credentials,
    );
    expect(result).toEqual({ ok: true, providerMessageId: "wamid.meta-out-1", costMicro: null });
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(String(url)).toBe("https://graph.test/v23.0/551234567890/messages");
    expect((init?.headers as Record<string, string>).authorization).toContain("Bearer");

    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "bad token" } }), { status: 401 }),
    );
    const failed = await metaWhatsAppProvider.send(
      { channel: "whatsapp", recipient: "+1", body: "x", senderIdentity: "1" },
      credentials,
    );
    expect(failed.ok).toBe(false);
    expect(JSON.stringify(failed)).not.toContain(credentials.accessToken);
  });

  it("classifies a network timeout as ambiguous (no channel fallback)", async () => {
    vi.mocked(fetch).mockRejectedValue(
      Object.assign(new Error("timed out"), { name: "TimeoutError" }),
    );
    const result = await metaWhatsAppProvider.send(
      { channel: "whatsapp", recipient: "+1", body: "x", senderIdentity: "1" },
      credentials,
    );
    expect(result).toMatchObject({ ok: false, ambiguous: true });
  });

  it("verifies X-Hub-Signature-256, rejecting unsigned and tampered requests (401 posture)", async () => {
    await expect(metaWhatsAppProvider.verifySignature(signed(inbound), {})).resolves.toBe(true);
    // Tampered body: signature no longer matches.
    const tampered = signed(inbound);
    const badBody = new Request(tampered.url, {
      method: "POST",
      body: accountUpdate,
      headers: tampered.headers,
    });
    await expect(metaWhatsAppProvider.verifySignature(badBody, {})).resolves.toBe(false);
    // Wrong secret.
    await expect(
      metaWhatsAppProvider.verifySignature(signed(inbound, "wrong-secret"), {}),
    ).resolves.toBe(false);
    // Unsigned.
    await expect(
      metaWhatsAppProvider.verifySignature(
        new Request("https://clinic.example/x", { method: "POST", body: inbound }),
        {},
      ),
    ).resolves.toBe(false);
  });

  it("parses inbound, account, and review events; a rejected review never leaks raw text", async () => {
    expect(extractMetaPhoneNumberId(JSON.parse(inbound))).toBe("551234567890");

    await expect(
      metaWhatsAppProvider.parseWebhook(new Request("https://x", { method: "POST", body: inbound })),
    ).resolves.toMatchObject([
      { kind: "inbound", phoneNumberId: "551234567890", providerMessageId: "wamid.meta-inbound-1" },
    ]);

    await expect(
      metaWhatsAppProvider.parseWebhook(
        new Request("https://x", { method: "POST", body: accountUpdate }),
      ),
    ).resolves.toMatchObject([
      {
        kind: "channel_state",
        phoneNumberId: "551234567890",
        signals: { businessVerificationStatus: "verified", phoneStatus: "CONNECTED" },
      },
    ]);

    const events = await metaWhatsAppProvider.parseWebhook(
      new Request("https://x", { method: "POST", body: reviewRejected }),
    );
    expect(events).toMatchObject([
      { kind: "channel_state", signals: { accountReviewStatus: "REJECTED" } },
    ]);
    // The hostile internal reason in the fixture must not survive parsing.
    expect(JSON.stringify(events)).not.toContain("dossier");
  });

  it("keeps messaging limit and quality signals distinct", async () => {
    const events = await metaWhatsAppProvider.parseWebhook(
      new Request("https://x", { method: "POST", body: phoneQuality }),
    );
    expect(events).toMatchObject([{
      kind: "channel_state",
      signals: {
        qualityRating: null,
        messagingLimitTier: "TIER_1K",
      },
    }]);
  });

  it("exchanges the signup code for a token and never returns the code", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ access_token: "exchanged-token" }), { status: 200 }),
    );
    await expect(exchangeMetaSignupCode("auth-code-xyz")).resolves.toEqual({
      ok: true,
      accessToken: "exchanged-token",
    });
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "invalid code" } }), { status: 400 }),
    );
    const failed = await exchangeMetaSignupCode("auth-code-xyz");
    expect(failed.ok).toBe(false);
  });

  it("verifies asset ownership and completes the required system-user, registration, and subscription lifecycle", async () => {
    vi.mocked(fetch).mockImplementation((input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("debug_token")) {
        return Promise.resolve(new Response(JSON.stringify({
          data: {
            app_id: "meta-app-id",
            is_valid: true,
            scopes: ["whatsapp_business_management"],
            granular_scopes: [{
              scope: "whatsapp_business_management",
              target_ids: ["waba-meta-1"],
            }],
          },
        }), { status: 200 }));
      }
      if (url.includes("client_whatsapp_business_accounts")) {
        return Promise.resolve(new Response(JSON.stringify({
          data: [{ id: "waba-meta-1" }],
        }), { status: 200 }));
      }
      if (url.includes("assigned_users") && init?.method === "POST") {
        return Promise.resolve(new Response(JSON.stringify({ success: true }), { status: 200 }));
      }
      if (url.includes("assigned_users")) {
        return Promise.resolve(new Response(JSON.stringify({
          data: [{ id: "system-user-1" }],
        }), { status: 200 }));
      }
      if (url.includes("phone_numbers")) {
        return Promise.resolve(new Response(JSON.stringify({
          data: [{
            id: "551234567890",
            display_phone_number: "+1 555 123 4567",
            code_verification_status: "VERIFIED",
          }],
        }), { status: 200 }));
      }
      if (url.includes("/register")) {
        return Promise.resolve(new Response(JSON.stringify({ success: true }), { status: 200 }));
      }
      if (url.includes("subscribed_apps") && init?.method === "POST") {
        return Promise.resolve(new Response(JSON.stringify({ success: true }), { status: 200 }));
      }
      if (url.includes("subscribed_apps")) {
        return Promise.resolve(new Response(JSON.stringify({
          data: [{
            whatsapp_business_api_data: { id: "meta-app-id" },
          }],
        }), { status: 200 }));
      }
      return Promise.resolve(new Response("{}", { status: 404 }));
    });

    const result = await provisionMetaEmbeddedSignup({
      oauthAccessToken: "oauth-user-token",
      phoneNumberId: "551234567890",
      wabaId: "waba-meta-1",
    });
    expect(result).toEqual({
      ok: true,
      channel: {
        accessToken: "system-user-token",
        phoneNumberId: "551234567890",
        wabaId: "waba-meta-1",
        displayPhoneNumber: "+1 555 123 4567",
      },
    });
    const registration = vi.mocked(fetch).mock.calls.find(([input]) =>
      String(input).includes("/register"),
    );
    expect(registration?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ messaging_product: "whatsapp", pin: "123456" }),
    });
  });

  it("rejects a client-supplied WABA that is not bound to the OAuth token", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      data: {
        app_id: "meta-app-id",
        is_valid: true,
        scopes: ["whatsapp_business_management"],
        granular_scopes: [{
          scope: "whatsapp_business_management",
          target_ids: ["different-waba"],
        }],
      },
    }), { status: 200 }));
    const result = await provisionMetaEmbeddedSignup({
      oauthAccessToken: "oauth-user-token",
      phoneNumberId: "551234567890",
      wabaId: "waba-meta-1",
    });
    expect(result.ok).toBe(false);
    expect(vi.mocked(fetch)).toHaveBeenCalledOnce();
  });

  it("reconciliation fetch returns a normalized snapshot from WABA + phone reads", async () => {
    vi.mocked(fetch).mockImplementation((input: unknown) => {
      const url = String(input);
      if (url.includes("subscribed_apps")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: [{
                whatsapp_business_api_data: { id: "meta-app-id" },
              }],
            }),
            { status: 200 },
          ),
        );
      }
      if (url.includes("waba-meta-1")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ account_review_status: "APPROVED" }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            code_verification_status: "VERIFIED",
            display_phone_number: "+15551234567",
            verified_name: "Clinic",
            quality_rating: "GREEN",
          }),
          { status: 200 },
        ),
      );
    });
    const snapshot = await fetchMetaChannelState(credentials);
    expect(snapshot).toEqual({
      ok: true,
      snapshot: {
        businessVerificationStatus: null,
        accountReviewStatus: "APPROVED",
        phoneStatus: "VERIFIED",
        qualityRating: "GREEN",
        messagingLimitTier: null,
        webhookSubscribed: true,
        // Meta omitted is_on_biz_app here, so the snapshot reports "unknown"
        // rather than guessing either way.
        phoneOnBusinessApp: null,
      },
    });
    const requested = vi.mocked(fetch).mock.calls.map(([input]) => String(input)).join("\n");
    expect(requested).toContain("fields=account_review_status");
    expect(requested).toContain(
      "fields=verified_name,display_phone_number,code_verification_status,quality_rating,platform_type,is_on_biz_app",
    );
    expect(requested).not.toContain("business_verification_status");
    expect(requested).not.toContain("messaging_limit_tier");
  });

  it("submits and synchronizes provider-scoped Meta templates through the WABA endpoints", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "template-meta-1", status: "PENDING" }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          data: [{
            id: "template-meta-1",
            name: "appointment_reminder",
            language: "en",
            status: "APPROVED",
          }],
        }), { status: 200 }),
      );
    await expect(
      submitMetaTemplate(
        {
          name: "appointment_reminder",
          language: "en",
          body: "Reminder {{1}}",
          category: "UTILITY",
        },
        credentials,
      ),
    ).resolves.toEqual({
      ok: true,
      providerTemplateId: "template-meta-1",
      status: "submitted",
    });
    await expect(fetchMetaTemplates(credentials)).resolves.toEqual({
      ok: true,
      templates: [{
        providerTemplateId: "template-meta-1",
        name: "appointment_reminder",
        language: "en",
        status: "approved",
      }],
    });
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain(
      "waba-meta-1/message_templates",
    );
  });
});
