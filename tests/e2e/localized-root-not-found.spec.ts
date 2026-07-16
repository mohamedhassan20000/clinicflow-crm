import { expect, test } from "@playwright/test";

const UNKNOWN_PUBLIC_PATH = "/phase-6-public-path-that-does-not-exist";

test.describe("Phase 6 localized root 404", () => {
  test.describe.configure({ mode: "serial" });

  for (const { locale, direction, title, home } of [
    {
      locale: "en",
      direction: "ltr",
      title: "We couldn’t find that page.",
      home: "Back to home",
    },
    {
      locale: "ar",
      direction: "rtl",
      title: "لم نتمكن من العثور على هذه الصفحة.",
      home: "العودة إلى الصفحة الرئيسية",
    },
  ] as const) {
    test(`returns a localized real 404 for ${locale}`, async ({ page, baseURL }) => {
      const runtimeErrors: string[] = [];
      page.on("pageerror", (error) => runtimeErrors.push(error.message));
      page.on("console", (message) => {
        const expectedDocument404 =
          message.type() === "error" &&
          message.text() === "Failed to load resource: the server responded with a status of 404 (Not Found)";
        if (message.type() === "error" && !expectedDocument404) runtimeErrors.push(message.text());
      });
      page.on("requestfailed", (request) => {
        const url = new URL(request.url());
        const expectedHomePrefetchAbort =
          request.failure()?.errorText === "net::ERR_ABORTED" &&
          request.resourceType() === "fetch" &&
          url.pathname === "/" &&
          url.searchParams.has("_rsc");
        if (!expectedHomePrefetchAbort) {
          runtimeErrors.push(`${request.failure()?.errorText ?? "request failed"} ${request.resourceType()} ${request.url()}`);
        }
      });
      page.on("response", (response) => {
        if (response.status() >= 400 && new URL(response.url()).pathname !== UNKNOWN_PUBLIC_PATH) {
          runtimeErrors.push(`${response.status()} ${response.url()}`);
        }
      });

      await page.context().addCookies([{
        name: "cf_marketing_locale",
        value: locale,
        url: new URL(baseURL!).origin,
      }]);

      const response = await page.goto(UNKNOWN_PUBLIC_PATH);
      await page.waitForLoadState("networkidle");

      expect(response?.status()).toBe(404);
      await expect(page.locator("html")).toHaveAttribute("lang", locale);
      await expect(page.locator("html")).toHaveAttribute("dir", direction);
      await expect(page.getByRole("heading", { name: title })).toBeVisible();
      await expect(page.getByRole("link", { name: home })).toHaveAttribute("href", "/");
      const robots = page.locator('meta[name="robots"]');
      expect(await robots.count()).toBeGreaterThan(0);
      expect(await robots.evaluateAll((elements) =>
        elements.every((element) => /noindex/i.test(element.getAttribute("content") ?? "")),
      )).toBe(true);
      expect(runtimeErrors).toEqual([]);
    });
  }
});
