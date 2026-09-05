import { describe, expect, it } from "vitest";

import { formatInboxTimestamp } from "@/lib/i18n/message-timestamp";

/**
 * P11O — Inbox message stamps are day-first.
 *
 * The application's English locale is plain `"en"`, which `Intl` reads as US
 * English, so `dateStyle: "short"` rendered the 30th of August as `8/30/26`.
 * Arabic was already day-first and must stay exactly as it was.
 */

const AUGUST_30 = new Date("2026-08-30T09:05:00Z");
const MARCH_2 = new Date("2026-03-02T09:05:00Z");

describe("formatInboxTimestamp", () => {
  it("writes an English date day first", () => {
    const text = formatInboxTimestamp(AUGUST_30, "en", "UTC");
    expect(text.startsWith("30/08/26")).toBe(true);
    expect(text).not.toContain("8/30");
  });

  it("keeps day and month unambiguous when both are single digits", () => {
    // The 2nd of March, never the 3rd of February.
    const text = formatInboxTimestamp(MARCH_2, "en", "UTC");
    expect(text.startsWith("02/03/26")).toBe(true);
  });

  it("keeps the two-digit year", () => {
    expect(formatInboxTimestamp(AUGUST_30, "en", "UTC")).not.toContain("2026");
  });

  it("leaves Arabic — already day first — alone", () => {
    const text = formatInboxTimestamp(AUGUST_30, "ar", "UTC");
    expect(text).toContain("30");
    expect(text.indexOf("30")).toBeLessThan(text.indexOf("8"));
  });

  it("keeps the locale's clock convention", () => {
    // 09:05 UTC in Cairo is 12:05 pm; the swap changes ordering, not the hour
    // convention and not the instant.
    const text = formatInboxTimestamp(AUGUST_30, "en", "Africa/Cairo");
    expect(text.toLowerCase()).toContain("12:05");
    expect(text.toLowerCase()).toContain("pm");
  });

  it("falls back rather than throwing on a malformed locale", () => {
    expect(() => formatInboxTimestamp(AUGUST_30, "not a locale", "UTC")).not.toThrow();
  });
});
