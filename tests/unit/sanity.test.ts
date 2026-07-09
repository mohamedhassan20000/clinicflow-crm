import { describe, expect, it } from "vitest";
import { DEFAULT_TIME_ZONE, isoDay } from "@/lib/datetime";

describe("datetime helpers", () => {
  it("keeps the legacy deployment timezone as the code fallback", () => {
    expect(DEFAULT_TIME_ZONE).toBe("Europe/Istanbul");
  });

  it("formats an ISO day in clinic timezone", () => {
    // 2026-04-17T00:00:00Z is 2026-04-17 03:00 in Istanbul (UTC+3).
    expect(isoDay("2026-04-17T00:00:00Z")).toBe("2026-04-17");
  });
});
