import { beforeEach, describe, expect, it, vi } from "vitest";
import { deriveConnectionState } from "@/lib/messaging/connection-state";

/**
 * P7D — the pieces that decide whether a clinic-owned ("manual API") WhatsApp
 * channel is usable, and whether one clinic's webhook handshake token can ever
 * stand in for another's.
 */

describe("P7D connection state for a clinic-owned Meta channel", () => {
  it("connects on webhook subscription alone, without our template or review gates", () => {
    // A clinic running its own Cloud API account has no ClinicFlow-side approved
    // template and may report no business-verification status at all. The
    // platform gates would strand such a channel at `templates_pending` and it
    // would never activate, so `selfManaged` bypasses both.
    expect(
      deriveConnectionState({
        selfManaged: true,
        phoneStatus: "VERIFIED",
        webhookSubscribed: true,
        approvedTemplateCount: 0,
        businessVerificationStatus: null,
      }),
    ).toEqual({ state: "connected", reason: null });
  });

  it("holds at connecting until Meta confirms our subscription to their WABA", () => {
    expect(
      deriveConnectionState({
        selfManaged: true,
        phoneStatus: "VERIFIED",
        webhookSubscribed: false,
      }),
    ).toEqual({ state: "connecting_to_meta", reason: null });
  });

  it("still fails on a blocked number, which clinic ownership must not mask", () => {
    expect(
      deriveConnectionState({
        selfManaged: true,
        phoneStatus: "BANNED",
        webhookSubscribed: true,
      }),
    ).toEqual({ state: "verification_failed", reason: "phone_number_banned" });
  });

  it("still fails on a rejected account review", () => {
    expect(
      deriveConnectionState({
        selfManaged: true,
        accountReviewStatus: "REJECTED",
        webhookSubscribed: true,
      }).state,
    ).toBe("verification_failed");
  });

  it("leaves the platform-brokered gates untouched when the flag is absent", () => {
    // The pre-existing embedded-signup rule: verified phone + verified business,
    // but no approved template yet, must still read `templates_pending`.
    expect(
      deriveConnectionState({
        phoneStatus: "VERIFIED",
        businessVerificationStatus: "verified",
        webhookSubscribed: true,
        approvedTemplateCount: 0,
      }),
    ).toEqual({ state: "templates_pending", reason: null });
  });
});

describe("P7D per-clinic webhook verify token", () => {
  const KEY = Buffer.alloc(32, 7).toString("base64");

  beforeEach(() => {
    vi.resetModules();
    process.env.MESSAGING_CREDENTIALS_KEY = KEY;
  });

  async function load() {
    return import("@/lib/messaging/webhook-verify-token");
  }

  it("derives a stable token per clinic", async () => {
    const { deriveWebhookVerifyToken } = await load();
    const first = deriveWebhookVerifyToken("clinic-a");
    expect(first).toBeTruthy();
    expect(deriveWebhookVerifyToken("clinic-a")).toBe(first);
  });

  it("never lets one clinic's token verify another clinic", async () => {
    const { deriveWebhookVerifyToken, matchesWebhookVerifyToken } = await load();
    const clinicA = deriveWebhookVerifyToken("clinic-a")!;
    const clinicB = deriveWebhookVerifyToken("clinic-b")!;

    expect(clinicA).not.toBe(clinicB);
    expect(matchesWebhookVerifyToken("clinic-a", clinicA)).toBe(true);
    expect(matchesWebhookVerifyToken("clinic-b", clinicA)).toBe(false);
    expect(matchesWebhookVerifyToken("clinic-a", clinicB)).toBe(false);
  });

  it("rejects empty, absent and near-miss tokens", async () => {
    const { deriveWebhookVerifyToken, matchesWebhookVerifyToken } = await load();
    const token = deriveWebhookVerifyToken("clinic-a")!;

    expect(matchesWebhookVerifyToken("clinic-a", null)).toBe(false);
    expect(matchesWebhookVerifyToken("clinic-a", "")).toBe(false);
    expect(matchesWebhookVerifyToken("clinic-a", token.slice(0, -1))).toBe(false);
    expect(matchesWebhookVerifyToken("clinic-a", `${token}x`)).toBe(false);
    expect(matchesWebhookVerifyToken("", token)).toBe(false);
  });

  it("produces nothing without a usable platform key, rather than a weak token", async () => {
    delete process.env.MESSAGING_CREDENTIALS_KEY;
    vi.resetModules();
    const { deriveWebhookVerifyToken, matchesWebhookVerifyToken } = await load();

    expect(deriveWebhookVerifyToken("clinic-a")).toBeNull();
    expect(matchesWebhookVerifyToken("clinic-a", "anything")).toBe(false);
  });
});
