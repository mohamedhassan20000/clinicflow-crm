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

  it("renders the honest disabled placeholder even without public Meta config and keeps P6D diagnostics out", () => {
    const page = readFileSync(
      "app/(protected)/settings/messaging/page.tsx",
      "utf8",
    );
    const wizard = readFileSync(
      "components/settings/whatsapp-onboarding-wizard.tsx",
      "utf8",
    );
    expect(page).toContain("<WhatsAppOnboardingWizard");
    expect(page).not.toContain("metaConfig || metaState.configured");
    expect(wizard).toContain('t("metaNotConfigured")');
    expect(wizard).not.toContain('t("qualityRatingLabel")');
    expect(wizard).not.toContain('t("messagingLimitLabel")');
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
