import { describe, expect, it } from "vitest";
import { DEFAULT_LOCALE, isLocale, localeDirection, LOCALES } from "@/lib/i18n/config";
import { resolveLocaleFrom, resolveThemeFrom } from "@/lib/i18n/resolve";

describe("P2A locale resolution (AI_AGENT_PLAN.md §4.1)", () => {
  it("defaults to English everywhere", () => {
    expect(DEFAULT_LOCALE).toBe("en");
    expect(resolveLocaleFrom({ isAuthenticated: false })).toBe("en");
    expect(resolveLocaleFrom({ isAuthenticated: true })).toBe("en");
  });

  it("lets the user's stored locale beat the English default — the only tier that exists", () => {
    expect(resolveLocaleFrom({ isAuthenticated: true, storedLocale: "ar" })).toBe("ar");
    expect(resolveLocaleFrom({ isAuthenticated: true, storedLocale: "en" })).toBe("en");
  });

  it("falls back to English when the signed-in user has no row yet (lazy creation)", () => {
    expect(resolveLocaleFrom({ isAuthenticated: true, storedLocale: null })).toBe("en");
  });

  it("keeps the anonymous marketing cookie independent of any authenticated preference", () => {
    // Anonymous: the cookie is the only source.
    expect(resolveLocaleFrom({ isAuthenticated: false, marketingCookie: "ar" })).toBe("ar");

    // Authenticated: the marketing cookie is NOT consulted. Reading the landing page in Arabic must
    // not silently change the language of the dashboard you then sign in to.
    expect(
      resolveLocaleFrom({ isAuthenticated: true, storedLocale: "en", marketingCookie: "ar" }),
    ).toBe("en");
    expect(
      resolveLocaleFrom({ isAuthenticated: true, storedLocale: "ar", marketingCookie: "en" }),
    ).toBe("ar");

    // A signed-in user with no row still ignores the cookie and lands on the English default.
    expect(
      resolveLocaleFrom({ isAuthenticated: true, storedLocale: null, marketingCookie: "ar" }),
    ).toBe("en");
  });

  it("rejects unknown or malformed locale values instead of trusting them", () => {
    expect(resolveLocaleFrom({ isAuthenticated: true, storedLocale: "fr" })).toBe("en");
    expect(resolveLocaleFrom({ isAuthenticated: false, marketingCookie: "../../etc/passwd" })).toBe("en");
    expect(resolveLocaleFrom({ isAuthenticated: false, marketingCookie: "" })).toBe("en");
    expect(isLocale("ar")).toBe(true);
    expect(isLocale("de")).toBe(false);
  });

  it("supports exactly English and Arabic, and maps Arabic to RTL", () => {
    expect([...LOCALES]).toEqual(["en", "ar"]);
    expect(localeDirection("en")).toBe("ltr");
    expect(localeDirection("ar")).toBe("rtl");
  });
});

describe("P2A theme resolution — theme follows the user, not the browser (§4.5)", () => {
  it("prefers the stored row over the device cookie", () => {
    // The gap the polish sprint documented and left open: a second user on the same browser must
    // get their own theme, not the theme the previous user left in the cookie.
    expect(resolveThemeFrom({ storedTheme: "light", cookieTheme: "dark" })).toBe("light");
    expect(resolveThemeFrom({ storedTheme: "dark", cookieTheme: "light" })).toBe("dark");
  });

  it("uses the cookie only as a pre-render hint when there is no stored row", () => {
    expect(resolveThemeFrom({ storedTheme: null, cookieTheme: "dark" })).toBe("dark");
  });

  it("falls back to light", () => {
    expect(resolveThemeFrom({})).toBe("light");
    expect(resolveThemeFrom({ storedTheme: "neon", cookieTheme: "chartreuse" })).toBe("light");
  });
});
