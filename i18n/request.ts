import {
  getRequestConfig,
  type GetRequestConfigParams,
  type RequestConfig,
} from "next-intl/server";
import { isLocale } from "@/lib/i18n/config";
import { resolveLocale } from "@/lib/preferences/server";

/**
 * P2A — next-intl request configuration.
 *
 * There is no `[locale]` URL segment and no locale prefix: language is a property of the *account*
 * (or, anonymously, of a cookie), not of the URL. Every existing route keeps its current path.
 */
export async function createI18nRequestConfig({
  locale: localeOverride,
}: GetRequestConfigParams): Promise<RequestConfig> {
  // Explicit-locale server translators are used by issued documents and PDFs.
  // They must remain independent from the signed-in user's application locale.
  const locale = isLocale(localeOverride) ? localeOverride : await resolveLocale();
  const [messages, actionErrors] = await Promise.all([
    import(`../messages/${locale}.json`).then((module) => module.default),
    import(`../messages/action-errors/${locale}.json`).then((module) => module.default),
  ]);

  return {
    locale,
    messages: { ...messages, actionErrors },
  };
}

export default getRequestConfig(createI18nRequestConfig);
