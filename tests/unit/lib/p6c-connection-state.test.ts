import { describe, expect, it } from "vitest";
import {
  deriveConnectionState,
  isTerminalConnectionState,
  sanitizeFailureReason,
} from "@/lib/messaging/connection-state";

describe("P6C connection-state machine", () => {
  it("returns connecting_to_meta from empty/unknown signals (never invents progress)", () => {
    expect(deriveConnectionState({})).toEqual({ state: "connecting_to_meta", reason: null });
    expect(
      deriveConnectionState({ phoneStatus: "SOME_UNKNOWN_STATUS", businessVerificationStatus: "???" }),
    ).toEqual({ state: "connecting_to_meta", reason: null });
  });

  it("reaches waiting_phone_verification only from a pending phone signal", () => {
    expect(deriveConnectionState({ phoneStatus: "PENDING" }).state).toBe("waiting_phone_verification");
    expect(deriveConnectionState({ phoneStatus: "UNVERIFIED" }).state).toBe("waiting_phone_verification");
  });

  it("reaches business_verification_in_progress when phone is up but review is not verified", () => {
    expect(
      deriveConnectionState({ phoneStatus: "CONNECTED", businessVerificationStatus: "pending" }).state,
    ).toBe("business_verification_in_progress");
    // Phone connected, no verification signal yet → still in review, not connected.
    expect(deriveConnectionState({ phoneStatus: "CONNECTED" }).state).toBe(
      "business_verification_in_progress",
    );
  });

  it("distinguishes templates_pending from connected by the approved-template count", () => {
    const base = {
      phoneStatus: "CONNECTED",
      businessVerificationStatus: "verified",
      webhookSubscribed: true,
    };
    expect(deriveConnectionState({ ...base, approvedTemplateCount: 0 }).state).toBe("templates_pending");
    expect(deriveConnectionState({ ...base, approvedTemplateCount: 2 }).state).toBe("connected");
  });

  it("accepts the documented APPROVED account review and requires a verified webhook subscription", () => {
    expect(
      deriveConnectionState({
        phoneStatus: "VERIFIED",
        accountReviewStatus: "APPROVED",
        approvedTemplateCount: 1,
        webhookSubscribed: true,
      }).state,
    ).toBe("connected");
    expect(
      deriveConnectionState({
        phoneStatus: "VERIFIED",
        accountReviewStatus: "APPROVED",
        approvedTemplateCount: 1,
        webhookSubscribed: false,
      }).state,
    ).toBe("verification_failed");
  });

  it("fails on a blocked phone or a rejected verification/review, with a sanitized reason", () => {
    expect(deriveConnectionState({ phoneStatus: "BANNED" })).toEqual({
      state: "verification_failed",
      reason: "phone_number_banned",
    });
    expect(
      deriveConnectionState({ phoneStatus: "CONNECTED", businessVerificationStatus: "rejected" }),
    ).toEqual({ state: "verification_failed", reason: "business_verification_rejected" });
    expect(
      deriveConnectionState({ phoneStatus: "CONNECTED", accountReviewStatus: "REJECTED" }).state,
    ).toBe("verification_failed");
  });

  it("collapses unknown/raw provider failure text to a generic code (no raw text escapes)", () => {
    expect(sanitizeFailureReason("policy 4.2 violation dossier #A1")).toBe("generic");
    expect(sanitizeFailureReason("EXPIRED_CREDENTIAL")).toBe("business_verification_expired");
    expect(sanitizeFailureReason(null)).toBe("generic");
    // A rejected review with a hostile internal reason must not surface that text.
    const derived = deriveConnectionState({
      businessVerificationStatus: "rejected",
      failureReason: "raw meta dossier text that must never reach a client",
    });
    expect(derived.state).toBe("verification_failed");
    // The keyword-less hostile string collapses to the generic code — a closed-set
    // value — so no raw provider text can reach the client.
    expect(derived.reason).toBe("generic");
    expect(JSON.stringify(derived)).not.toContain("dossier");
  });

  it("is total and deterministic — same signals always derive the same state", () => {
    const signals = {
      phoneStatus: "CONNECTED",
      businessVerificationStatus: "verified",
      approvedTemplateCount: 1,
      webhookSubscribed: true,
    };
    expect(deriveConnectionState(signals)).toEqual(deriveConnectionState(signals));
  });

  it("marks connected and verification_failed as terminal", () => {
    expect(isTerminalConnectionState("connected")).toBe(true);
    expect(isTerminalConnectionState("verification_failed")).toBe(true);
    expect(isTerminalConnectionState("templates_pending")).toBe(false);
    expect(isTerminalConnectionState("connecting_to_meta")).toBe(false);
  });
});
