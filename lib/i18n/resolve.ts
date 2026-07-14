import { DEFAULT_LOCALE, isLocale, type Locale } from "@/lib/i18n/config";

export type Theme = "light" | "dark";

/**
 * Locale resolution (AI_AGENT_PLAN.md §4.1 as amended 2026-07-14).
 *
 *   authenticated:  user_ui_preferences.locale -> 'en'
 *   anonymous:      marketing cookie           -> 'en'
 *
 * There is deliberately **no clinic tier**. `clinics.locale` is formatting metadata only (§13-Q11)
 * and may never resolve a user's UI language — there is no clinic language, ever.
 *
 * The marketing cookie is not consulted for an authenticated account. That is what keeps the
 * anonymous marketing locale independent of every stored preference: reading the landing page in
 * Arabic must not silently change the language of the dashboard you then sign in to.
 *
 * Pure and dependency-free so the resolution rules are unit-testable without a database.
 */
export function resolveLocaleFrom(input: {
  isAuthenticated: boolean;
  storedLocale?: string | null;
  marketingCookie?: string | null;
}): Locale {
  if (input.isAuthenticated) {
    return isLocale(input.storedLocale) ? input.storedLocale : DEFAULT_LOCALE;
  }
  return isLocale(input.marketingCookie) ? input.marketingCookie : DEFAULT_LOCALE;
}

/**
 * Theme resolution (§4.5): the stored row wins for a signed-in user; the device cookie is only a
 * pre-render hint so there is no flash; `light` is the floor.
 *
 * This is what moves theme off the browser and onto the account: a second user on the same browser
 * gets their own theme, and a user's theme follows them to a second device.
 */
export function resolveThemeFrom(input: {
  storedTheme?: string | null;
  cookieTheme?: string | null;
}): Theme {
  if (input.storedTheme === "light" || input.storedTheme === "dark") return input.storedTheme;
  if (input.cookieTheme === "light" || input.cookieTheme === "dark") return input.cookieTheme;
  return "light";
}
