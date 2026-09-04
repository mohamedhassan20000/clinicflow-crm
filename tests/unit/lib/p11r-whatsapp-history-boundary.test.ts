import { describe, expect, it } from "vitest";
import { inboundDisplayName, isHistoryBeforeBoundary } from "@/lib/messaging/history-boundary";

describe("WhatsApp Inbox history boundary", () => {
  it("suppresses old and timestamp-less history but admits boundary/newer activity", () => {
    const boundary = "2026-09-01T10:00:00.000Z";
    expect(isHistoryBeforeBoundary("2026-08-31T23:00:00Z", boundary)).toBe(true);
    expect(isHistoryBeforeBoundary(null, boundary)).toBe(true);
    expect(isHistoryBeforeBoundary("2026-09-01T10:00:00.000Z", boundary)).toBe(false);
    expect(isHistoryBeforeBoundary("2026-09-01T10:00:01.000Z", boundary)).toBe(false);
  });

  it("keeps rolling compatibility when no durable boundary exists yet", () => {
    expect(isHistoryBeforeBoundary("2020-01-01T00:00:00Z", null)).toBe(false);
  });

  it("lets a live directory-resolved name replace stale history metadata", () => {
    expect(inboundDisplayName("Old History Label", "WhatsApp Saved Name")).toBe(
      "WhatsApp Saved Name",
    );
    expect(inboundDisplayName(null, "WhatsApp Saved Name")).toBe("WhatsApp Saved Name");
    expect(inboundDisplayName(null, null)).toBeNull();
  });
});
