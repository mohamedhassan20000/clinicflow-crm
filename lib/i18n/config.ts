/**
 * P2A — i18n configuration (AI_AGENT_PLAN.md §4, §4.1).
 *
 * Arabic is the default for anonymous/public surfaces. Signed-in accounts with no saved preference
 * retain the English application default, so changing the public first impression does not silently
 * change a user's dashboard language.
 *
 * Isomorphic on purpose — imported by both server resolution and client switchers, so it must not
 * pull in `server-only`.
 */

export const LOCALES = ["en", "ar"] as const;

export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";
export const ANONYMOUS_DEFAULT_LOCALE: Locale = "ar";

/**
 * The anonymous/marketing locale cookie. It is deliberately NOT the source of an authenticated
 * user's language: a signed-in account always resolves through `user_ui_preferences.locale`, so a
 * visitor who reads the marketing site in Arabic and then signs in still gets their own stored
 * dashboard language (§4.1, and the P2A acceptance tests).
 */
export const MARKETING_LOCALE_COOKIE = "cf_marketing_locale";

/** Pre-render hint for theme only, retained to avoid a flash (§4.5). Never a language source. */
export const THEME_COOKIE = "theme";

export const LOCALE_LABELS: Record<Locale, { native: string; english: string }> = {
  en: { native: "English", english: "English" },
  ar: { native: "العربية", english: "Arabic" },
};

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/** Root `dir` for a locale. Arabic is the only RTL locale today. */
export function localeDirection(locale: Locale): "ltr" | "rtl" {
  return locale === "ar" ? "rtl" : "ltr";
}
