import { describe, expect, it } from "vitest";
import { CLINIC_TZ, isoDay } from "@/lib/datetime";

describe("datetime helpers", () => {
  it("defaults to Europe/Istanbul", () => {
    expect(CLINIC_TZ).toBe("Europe/Istanbul");
  });

  it("formats an ISO day in clinic timezone", () => {
    // 2026-04-17T00:00:00Z is 2026-04-17 03:00 in Istanbul (UTC+3).
    expect(isoDay("2026-04-17T00:00:00Z")).toBe("2026-04-17");
  });
});
