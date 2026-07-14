/**
 * P2C — the structural translator type.
 *
 * next-intl's `useTranslations(ns)` (client) and `await getTranslations(ns)` (server) return
 * translators with the same call shape but different nominal types. Copy builders like
 * `getMarketingCopy` must accept either, so they depend on this structural type rather than on
 * next-intl's, and stay unit-testable with a plain function stub.
 *
 * `raw` is typed as a generic accessor because message files legitimately carry structured values —
 * a list of FAQ entries, a set of feature cards. Those are content, not markup, and belong in the
 * message file where a translator can see all of them at once.
 *
 * Interpolated values are `string` on purpose. Numbers, dates, and money are formatted by
 * `lib/datetime.ts` / `lib/currency/` before they reach a message, so digit shaping stays in one
 * place (§4.4). Passing a raw number here would let ICU pick its own numbering system for Arabic
 * and quietly overrule the clinic's `digits` setting.
 */
export type MessageTranslator = {
  (key: string, values?: Record<string, string>): string;
  raw: <T>(key: string) => T;
};
