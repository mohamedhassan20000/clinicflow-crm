import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { MARKETING_LOCALE_COOKIE, THEME_COOKIE, type Locale } from "@/lib/i18n/config";
import { resolveLocaleFrom, resolveThemeFrom, type Theme } from "@/lib/i18n/resolve";

export type UiPreferences = {
  userId: string;
  theme: Theme | null;
  locale: Locale | null;
};

/**
 * Per-request memoized read of the signed-in account's stored UI preferences (§4.5).
 *
 * `cache()` dedupes across the root layout, the protected/operator layout, and the Preferences page
 * in the same render, so the store costs one query per request rather than one per consumer.
 *
 * Returns `null` for anonymous requests. A signed-in user with no row yet returns null theme/locale
 * — rows are created lazily on first write, and the resolvers fall back from there.
 */
export const loadUiPreferences = cache(async (): Promise<UiPreferences | null> => {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const { data } = await supabase
    .from("user_ui_preferences")
    .select("theme, locale")
    .eq("user_id", user.id)
    .maybeSingle();

  return {
    userId: user.id,
    theme: data?.theme === "dark" || data?.theme === "light" ? data.theme : null,
    locale: data?.locale === "ar" || data?.locale === "en" ? data.locale : null,
  };
});

/** The active UI language for this request. Authenticated: stored row -> 'en'. Anonymous: marketing cookie -> 'en'. */
export async function resolveLocale(): Promise<Locale> {
  const [preferences, cookieStore] = await Promise.all([loadUiPreferences(), cookies()]);
  return resolveLocaleFrom({
    isAuthenticated: preferences !== null,
    storedLocale: preferences?.locale,
    marketingCookie: cookieStore.get(MARKETING_LOCALE_COOKIE)?.value,
  });
}

/** The active theme for this request: stored row -> device cookie hint -> light. */
export async function resolveTheme(): Promise<Theme> {
  const [preferences, cookieStore] = await Promise.all([loadUiPreferences(), cookies()]);
  return resolveThemeFrom({
    storedTheme: preferences?.theme,
    cookieTheme: cookieStore.get(THEME_COOKIE)?.value,
  });
}
