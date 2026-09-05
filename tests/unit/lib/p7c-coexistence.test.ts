import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deriveConnectionState } from "@/lib/messaging/connection-state";
import {
  META_COEXISTENCE_WEBHOOK_FIELDS,
  metaWhatsAppProvider,
  provisionMetaEmbeddedSignup,
  requestMetaSmbDataSync,
} from "@/lib/messaging/whatsapp-meta";

/**
 * P7C — WhatsApp Business App Coexistence ("Connect WhatsApp Business").
 *
 * These cover the parts that differ from the P6C Cloud-API-only flow and that
 * would silently misbehave if they regressed: the skipped phone registration,
 * the extra webhook fields, the state rules for a number that lives on the
 * Business app, and the guarantee that Business-app mirror traffic is never
 * mistaken for a new patient message.
 */

const OAUTH_TOKEN = "oauth-user-token";
const WABA_ID = "112233445566";
const PHONE_NUMBER_ID = "551234567890";

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status });
}

/**
 * A Graph double that answers the whole provisioning lifecycle successfully.
 * `phoneFields` overrides just the selected phone row so a test can flip
 * is_on_biz_app without restating the rest.
 */
function stubGraph(phoneFields: Record<string, unknown> = {}) {
  const calls: { url: string; method: string }[] = [];
  vi.mocked(fetch).mockImplementation((input, init) => {
    const url = String(input);
    calls.push({ url, method: (init?.method ?? "GET").toUpperCase() });

    if (url.includes("debug_token")) {
      return Promise.resolve(
        jsonResponse({
          data: {
            is_valid: true,
            app_id: "meta-app-id",
            scopes: ["whatsapp_business_management"],
            granular_scopes: [
              { scope: "whatsapp_business_management", target_ids: [WABA_ID] },
            ],
          },
        }),
      );
    }
    if (url.includes("client_whatsapp_business_accounts")) {
      return Promise.resolve(jsonResponse({ data: [{ id: WABA_ID }] }));
    }
    if (url.includes("assigned_users")) {
      return Promise.resolve(jsonResponse({ data: [{ id: "system-user-id" }] }));
    }
    if (url.includes("phone_numbers")) {
      return Promise.resolve(
        jsonResponse({
          data: [
            {
              id: PHONE_NUMBER_ID,
              display_phone_number: "+15551234567",
              verified_name: "Clinic",
              code_verification_status: "NOT_VERIFIED",
              quality_rating: "GREEN",
              platform_type: "CLOUD_API",
              is_on_biz_app: true,
              ...phoneFields,
            },
          ],
        }),
      );
    }
    if (url.includes("subscribed_apps")) {
      return Promise.resolve(
        jsonResponse({ data: [{ whatsapp_business_api_data: { id: "meta-app-id" } }] }),
      );
    }
    if (url.includes("smb_app_data")) {
      return Promise.resolve(jsonResponse({ success: true }));
    }
    return Promise.resolve(jsonResponse({}));
  });
  return calls;
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
  vi.stubEnv("META_APP_ID", "meta-app-id");
  vi.stubEnv("META_BUSINESS_ID", "business-id");
  vi.stubEnv("META_SYSTEM_USER_ID", "system-user-id");
  vi.stubEnv("META_SYSTEM_USER_ACCESS_TOKEN", "system-user-token");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("P7C Coexistence provisioning", () => {
  it("skips Cloud API phone registration — the number is already registered", async () => {
    vi.stubEnv("META_PHONE_REGISTRATION_PIN", "123456");
    const calls = stubGraph();

    const result = await provisionMetaEmbeddedSignup({
      oauthAccessToken: OAUTH_TOKEN,
      phoneNumberId: PHONE_NUMBER_ID,
      wabaId: WABA_ID,
      flow: "coexistence",
    });

    expect(result.ok).toBe(true);
    expect(calls.some((call) => call.url.includes("/register"))).toBe(false);
  });

  it("still registers the phone on the standard Embedded Signup flow", async () => {
    vi.stubEnv("META_PHONE_REGISTRATION_PIN", "123456");
    const calls = stubGraph();

    const result = await provisionMetaEmbeddedSignup({
      oauthAccessToken: OAUTH_TOKEN,
      phoneNumberId: PHONE_NUMBER_ID,
      wabaId: WABA_ID,
    });

    expect(result.ok).toBe(true);
    expect(calls.some((call) => call.url.includes("/register"))).toBe(true);
  });

  it("connects without a registration PIN configured, which coexistence never uses", async () => {
    vi.stubEnv("META_PHONE_REGISTRATION_PIN", "");
    stubGraph();

    await expect(
      provisionMetaEmbeddedSignup({
        oauthAccessToken: OAUTH_TOKEN,
        phoneNumberId: PHONE_NUMBER_ID,
        wabaId: WABA_ID,
        flow: "coexistence",
      }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("subscribes the Business-app webhook fields, so the clinic's traffic reaches us", async () => {
    const calls = stubGraph();

    await provisionMetaEmbeddedSignup({
      oauthAccessToken: OAUTH_TOKEN,
      phoneNumberId: PHONE_NUMBER_ID,
      wabaId: WABA_ID,
      flow: "coexistence",
    });

    const subscribe = calls.find(
      (call) => call.method === "POST" && call.url.includes("subscribed_apps"),
    );
    expect(subscribe).toBeDefined();
    for (const field of META_COEXISTENCE_WEBHOOK_FIELDS) {
      expect(decodeURIComponent(subscribe!.url)).toContain(field);
    }
  });

  it("refuses when Meta says the number is not on the WhatsApp Business app", async () => {
    stubGraph({ is_on_biz_app: false });

    const result = await provisionMetaEmbeddedSignup({
      oauthAccessToken: OAUTH_TOKEN,
      phoneNumberId: PHONE_NUMBER_ID,
      wabaId: WABA_ID,
      flow: "coexistence",
    });

    expect(result.ok).toBe(false);
  });

  it("requests both the contacts and history backfill within the 24h window", async () => {
    const calls = stubGraph();

    const result = await requestMetaSmbDataSync({
      accessToken: "system-user-token",
      phoneNumberId: PHONE_NUMBER_ID,
      wabaId: WABA_ID,
    });

    expect(result).toEqual({ contacts: true, history: true });
    expect(calls.filter((call) => call.url.includes("smb_app_data"))).toHaveLength(2);
  });
});

describe("P7C Coexistence connection state", () => {
  const base = { coexistence: true, webhookSubscribed: true };

  it("reaches connected without template approval or Cloud API phone verification", () => {
    // A coexistence number already talks to patients; gating it on templates
    // would report a working connection as unfinished.
    expect(
      deriveConnectionState({ ...base, phoneStatus: "NOT_VERIFIED", approvedTemplateCount: 0 }),
    ).toEqual({ state: "connected", reason: null });
  });

  it("does not claim connected before our webhook subscription is confirmed", () => {
    expect(
      deriveConnectionState({ ...base, webhookSubscribed: false, phoneStatus: "NOT_VERIFIED" })
        .state,
    ).toBe("connecting_to_meta");
  });

  it("still fails on a banned or restricted number", () => {
    expect(deriveConnectionState({ ...base, phoneStatus: "BANNED" })).toEqual({
      state: "verification_failed",
      reason: "phone_number_banned",
    });
  });

  it("fails once Meta reports the number left the Business app", () => {
    expect(
      deriveConnectionState({ ...base, phoneOnBusinessApp: false, phoneStatus: "CONNECTED" })
        .state,
    ).toBe("verification_failed");
  });

  it("leaves the standard flow's template gate untouched", () => {
    expect(
      deriveConnectionState({
        phoneStatus: "CONNECTED",
        businessVerificationStatus: "verified",
        webhookSubscribed: true,
        approvedTemplateCount: 0,
      }).state,
    ).toBe("templates_pending");
  });
});

describe("P7C Coexistence webhook parsing", () => {
  it("never turns Business-app mirror traffic into inbound patient messages", async () => {
    // smb_message_echoes carries messages the clinic sent from their own phone,
    // and history carries their past threads. Neither is a new inbound message.
    for (const field of ["smb_message_echoes", "history", "smb_app_state_sync"]) {
      const events = await metaWhatsAppProvider.parseWebhook(
        new Request("https://clinic.example/api/webhooks/whatsapp", {
          method: "POST",
          body: JSON.stringify({
            entry: [
              {
                id: WABA_ID,
                changes: [
                  {
                    field,
                    value: {
                      metadata: { phone_number_id: PHONE_NUMBER_ID },
                      messages: [
                        { from: "15550001111", id: "wamid.echo", type: "text", text: { body: "hi" } },
                      ],
                    },
                  },
                ],
              },
            ],
          }),
        }),
      );

      expect(events.every((event) => event.kind !== "inbound")).toBe(true);
    }
  });
});
