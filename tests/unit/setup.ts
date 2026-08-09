import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";
import { createFormatter, createTranslator } from "next-intl";
import ar from "@/messages/ar.json";
import en from "@/messages/en.json";
import actionErrorsAr from "@/messages/action-errors/ar.json";
import actionErrorsEn from "@/messages/action-errors/en.json";

const englishMessages = { ...en, actionErrors: actionErrorsEn };
const arabicMessages = { ...ar, actionErrors: actionErrorsAr };

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

/**
 * jsdom ships no IntersectionObserver. The stub never reports an intersection, which is the right
 * default: components that count up or reveal on scroll must render their *final, correct* value
 * before any animation runs, and this makes the suite assert exactly that. A test that wants the
 * animation drives the callback itself (see `p2c-marketing-stats.test.tsx`).
 */
class IntersectionObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
  readonly root = null;
  readonly rootMargin = "";
  readonly thresholds: readonly number[] = [];
}

globalThis.ResizeObserver ??= ResizeObserverMock;
globalThis.IntersectionObserver ??= IntersectionObserverMock as unknown as typeof IntersectionObserver;

Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};

/**
 * P2C — every component test renders against the **real English catalog**.
 *
 * The component suite calls `render(<Thing />)` directly, with no provider tree, so once P2C moved
 * copy behind `useTranslations` the components would throw for want of an intl context. Two ways
 * out, and only one of them is worth having:
 *
 *   ✗ Stub `t` to echo its key back. Every existing assertion (`getByText("Save")`) would then have
 *     to be rewritten to match `"common.save"` — hundreds of edits that *delete* the suite's ability
 *     to notice a missing or malformed message, in exchange for nothing.
 *   ✓ Resolve keys through **next-intl's own `createTranslator`, against the real `messages/en.json`**.
 *
 * The second is what runs here. It does not mock the translation *logic* — that is genuinely
 * next-intl doing ICU resolution — only where the messages come from (a static import instead of a
 * React context). So the ~600 existing English assertions keep asserting English, and they now do it
 * *through* the catalog: a key that is missing, misspelled, or carrying a broken ICU placeholder
 * fails the test that renders it. That is what makes "English is unchanged" a property the suite can
 * check, rather than a claim in a review document.
 *
 * Arabic is asserted the same way, per-file, by re-mocking against `messages/ar.json`
 * (see `tests/unit/pages/p2c-arabic-rendering.test.tsx`).
 */
vi.mock("next-intl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-intl")>();
  return {
    ...actual,
    useLocale: () => "en",
    useTranslations: (namespace?: string) =>
      createTranslator({ locale: "en", messages: englishMessages, namespace: namespace as never }),
    useFormatter: () => createFormatter({ locale: "en" }),
    useMessages: () => englishMessages,
  };
});

vi.mock("next-intl/server", async () => ({
  getRequestConfig: <T,>(createRequestConfig: T) => createRequestConfig,
  getLocale: async () => "en",
  getMessages: async () => englishMessages,
  getTranslations: async (
    input?: string | { locale?: string; namespace?: string },
  ) => {
    const locale = typeof input === "object" && input.locale === "ar" ? "ar" : "en";
    const namespace = typeof input === "string" ? input : input?.namespace;
    return createTranslator({
      locale,
      messages: locale === "ar" ? arabicMessages : englishMessages,
      namespace: namespace as never,
    });
  },
  getFormatter: async () => createFormatter({ locale: "en" }),
  setRequestLocale: () => {},
}));
