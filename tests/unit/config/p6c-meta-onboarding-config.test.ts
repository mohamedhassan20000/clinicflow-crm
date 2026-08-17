import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("P6C Meta onboarding production configuration", () => {
  it("allows the Embedded Signup SDK and Facebook connection origins in CSP", () => {
    const config = readFileSync("next.config.ts", "utf8");
    expect(config).toContain(
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://connect.facebook.net",
    );
    expect(config).toContain("https://graph.facebook.com");
    expect(config).toContain(
      "frame-src 'self' https://www.facebook.com https://web.facebook.com",
    );
  });

  /**
   * P7E retired Embedded Signup from the clinic-facing page: the two methods a
   * clinic is offered are the linked-device QR pairing and its own Meta Cloud
   * API credentials. The wizard component is retained for the channels that
   * already went through it, and keeps its honest disabled placeholder, but the
   * settings page must not mount it — clicking "Connect with QR" must never
   * reach a Facebook login.
   */
  it("offers only the two per-clinic methods and mounts no Embedded Signup surface", () => {
    const page = readFileSync(
      "app/(protected)/settings/messaging/page.tsx",
      "utf8",
    );
    const wizard = readFileSync(
      "components/settings/whatsapp-onboarding-wizard.tsx",
      "utf8",
    );
    expect(page).toContain("<WhatsAppQrConnectCard");
    expect(page).toContain("<MetaApiConnectCard");
    expect(page).not.toContain("<WhatsAppOnboardingWizard");
    expect(page).not.toContain("NEXT_PUBLIC_META_CONFIG_ID");
    expect(page).not.toContain("NEXT_PUBLIC_META_COEXISTENCE_CONFIG_ID");
    expect(wizard).toContain('t("metaNotConfigured")');
    expect(wizard).not.toContain('t("qualityRatingLabel")');
    expect(wizard).not.toContain('t("messagingLimitLabel")');
  });

  /**
   * The QR card is the surface that replaced the Embedded Signup one, so it is
   * pinned here: no Facebook SDK, no popup protocol, no signup configuration.
   */
  it("keeps the QR connection card free of any Meta login machinery", () => {
    const card = readFileSync(
      "components/settings/whatsapp-qr-connect-card.tsx",
      "utf8",
    );
    for (const forbidden of [
      "connect.facebook.net",
      "FB.login",
      "WA_EMBEDDED_SIGNUP",
      "whatsapp_business_app_onboarding",
      "config_id",
      "META_COEXISTENCE",
    ]) {
      expect(card).not.toContain(forbidden);
    }
  });

  it("documents the linked-device pairing service configuration", () => {
    const example = readFileSync(".env.example", "utf8");
    for (const key of [
      "WHATSAPP_WORKER_URL",
      "WHATSAPP_WORKER_TOKEN",
      "WHATSAPP_WORKER_CALLBACK_SECRET",
    ]) {
      expect(example).toContain(`${key}=`);
    }
  });

  it("documents every required server and public Meta environment variable", () => {
    const example = readFileSync(".env.example", "utf8");
    for (const key of [
      "NEXT_PUBLIC_META_APP_ID",
      "NEXT_PUBLIC_META_CONFIG_ID",
      "META_APP_ID",
      "META_APP_SECRET",
      "META_WEBHOOK_VERIFY_TOKEN",
      "META_BUSINESS_ID",
      "META_SYSTEM_USER_ID",
      "META_SYSTEM_USER_ACCESS_TOKEN",
      "META_PHONE_REGISTRATION_PIN",
      "META_GRAPH_API_VERSION",
    ]) {
      expect(example).toContain(`${key}=`);
    }
  });
});
