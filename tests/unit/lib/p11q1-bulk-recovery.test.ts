import { describe, expect, it } from "vitest";
import ar from "@/messages/ar.json";
import en from "@/messages/en.json";
import {
  BULK_FAILURE_LABEL_KEYS,
  BULK_STALE_AFTER_SECONDS,
  bulkFailureLabelKey,
  interruptedResendRisk,
} from "@/lib/messaging/bulk-send-plan";

/**
 * P11Q.1 — the duplicate-risk boundary, and the words staff read.
 *
 * The first half of this file is the single most safety-critical decision in the
 * bulk feature: whether an interrupted recipient may be sent to again. It is
 * pure, so it can be reasoned about completely.
 */

describe("P11Q.1 — when an interrupted send may be retried", () => {
  const CLAIMED = "2026-08-17T09:00:00.000Z";

  it("is safe when nothing was written after the claim", () => {
    expect(
      interruptedResendRisk({ claimedAt: CLAIMED, outboundCreatedAt: [] }),
    ).toBe("safe_to_resend");
  });

  it("is safe when the only outbound message predates the claim", () => {
    expect(
      interruptedResendRisk({
        claimedAt: CLAIMED,
        outboundCreatedAt: ["2026-08-17T08:59:59.000Z", "2026-08-01T10:00:00.000Z"],
      }),
    ).toBe("safe_to_resend");
  });

  /**
   * The case that would send a patient the same message twice: the send path
   * got far enough to write an outbound row, so WhatsApp may well have accepted
   * it before the process died.
   */
  it("refuses when an outbound message exists at or after the claim", () => {
    expect(
      interruptedResendRisk({
        claimedAt: CLAIMED,
        outboundCreatedAt: ["2026-08-17T09:00:01.000Z"],
      }),
    ).toBe("duplicate_risk");
    // Exactly at the claim instant counts as after it.
    expect(
      interruptedResendRisk({ claimedAt: CLAIMED, outboundCreatedAt: [CLAIMED] }),
    ).toBe("duplicate_risk");
  });

  it("refuses when there is no claim anchor to reason from", () => {
    expect(interruptedResendRisk({ claimedAt: null, outboundCreatedAt: [] })).toBe(
      "duplicate_risk",
    );
    expect(
      interruptedResendRisk({ claimedAt: "not-a-date", outboundCreatedAt: [] }),
    ).toBe("duplicate_risk");
  });

  it("waits long enough that a live send is never called interrupted", () => {
    expect(BULK_STALE_AFTER_SECONDS).toBeGreaterThanOrEqual(120);
  });
});

describe("P11Q.1 — failure codes are localized, never rendered raw", () => {
  function lookup(catalog: typeof en, key: string): string | undefined {
    return key
      .split(".")
      .reduce<unknown>(
        (node, part) => (node as Record<string, unknown> | undefined)?.[part],
        catalog.inbox.bulk,
      ) as string | undefined;
  }

  it("maps every stable code to a key that exists in both catalogs", () => {
    for (const [code, key] of Object.entries(BULK_FAILURE_LABEL_KEYS)) {
      expect(lookup(en, key), `en ${code}`).toBeTruthy();
      expect(lookup(ar, key), `ar ${code}`).toBeTruthy();
    }
  });

  it("covers every SendErrorCode the send path can return", () => {
    // Kept in step with lib/messaging/types.ts by hand, and asserted here so a
    // new code cannot reach staff as a raw enum.
    for (const code of [
      "INVALID_INPUT",
      "EMAIL_SUBJECT_REQUIRED",
      "CHANNEL_LOOKUP_FAILED",
      "NO_ACTIVE_CHANNEL",
      "NOT_ENTITLED",
      "SUBSCRIPTION_INACTIVE",
      "USAGE_LIMIT_REACHED",
      "CREDENTIALS_UNAVAILABLE",
      "CONVERSATION_NOT_FOUND",
      "CONVERSATION_CLOSED",
      "SERVICE_WINDOW_CLOSED",
      "TEMPLATE_NOT_APPROVED",
      "TEMPLATE_PARAMETERS_INVALID",
      "MEDIA_UNSUPPORTED",
      "MEDIA_UNAVAILABLE",
      "MEDIA_REQUEST_REJECTED",
      "MEDIA_STORAGE_FETCH_FAILED",
      "MEDIA_TRANSCODE_FAILED",
      "MEDIA_BAILEYS_SEND_FAILED",
      "RECORD_FAILED",
      "PROVIDER_SEND_FAILED",
      "PROVIDER_SEND_AMBIGUOUS",
    ]) {
      expect(BULK_FAILURE_LABEL_KEYS, code).toHaveProperty(code);
    }
  });

  it("covers every skip and interruption reason the runner can write", () => {
    for (const code of [
      "not_whatsapp",
      "no_address",
      "conversation_closed",
      "interrupted",
      "interrupted_dismissed",
    ]) {
      expect(BULK_FAILURE_LABEL_KEYS, code).toHaveProperty(code);
    }
  });

  it("falls back to one honest sentence for an unknown code", () => {
    expect(bulkFailureLabelKey("SOMETHING_NEW")).toBe("failureReason.generic");
    expect(bulkFailureLabelKey(null)).toBeNull();
  });

  it("never renders the raw code as its own label", () => {
    for (const [code, key] of Object.entries(BULK_FAILURE_LABEL_KEYS)) {
      expect(lookup(en, key)).not.toBe(code);
      expect(lookup(en, key)).not.toMatch(/^[A-Z_]+$/);
      expect(lookup(ar, key)).not.toMatch(/^[A-Z_]+$/);
    }
  });

  it("writes the Arabic sentences in Arabic", () => {
    const arabicScript = /[؀-ۿ]/;
    for (const key of Object.values(BULK_FAILURE_LABEL_KEYS)) {
      expect(arabicScript.test(lookup(ar, key)!), key).toBe(true);
    }
  });
});
