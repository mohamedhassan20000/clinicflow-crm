import { getRequestConfig } from "next-intl/server";
import { resolveLocale } from "@/lib/preferences/server";

/**
 * P2A — next-intl request configuration.
 *
 * There is no `[locale]` URL segment and no locale prefix: language is a property of the *account*
 * (or, anonymously, of a cookie), not of the URL. Every existing route keeps its current path.
 */
export default getRequestConfig(async () => {
  const locale = await resolveLocale();
  const [messages, actionErrors] = await Promise.all([
    import(`../messages/${locale}.json`).then((module) => module.default),
    import(`../messages/action-errors/${locale}.json`).then((module) => module.default),
  ]);

  return {
    locale,
    messages: { ...messages, actionErrors },
  };
});
