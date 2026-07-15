import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }, testInfo) => {
  await page.context().addCookies([
    {
      name: "cf_marketing_locale",
      value: "en",
      url: testInfo.project.use.baseURL as string,
    },
  ]);
});

test("English privacy policy is complete, responsive, and theme-aware", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/privacy");

  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await expect(
    page.getByRole("heading", { level: 1, name: "Privacy Policy" }),
  ).toBeVisible();
  await expect(page.getByText("Last updated: July 15, 2026")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "About ClinicFlow’s role" }),
  ).toBeVisible();
  await expect(page.locator("article section")).toHaveCount(21);
  await expect(page.getByText("Retention, archiving, and deletion")).toBeVisible();
  await expect(page.getByText("Cookies and browser storage")).toBeVisible();
  await expect(page.getByText("Pending legal review")).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);

  const main = page.locator("main.marketing-page");
  await expect(main).toHaveClass(/\blight\b/);
  await page.getByRole("button", { name: /dark mode/i }).click();
  await expect(main).toHaveClass(/\bdark\b/);

  await expect(page.getByRole("link", { name: "Back to ClinicFlow" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Terms of Service" })).toBeVisible();
});

test("Arabic privacy policy is complete, RTL, responsive, and theme-aware", async ({
  page,
}) => {
  await page.goto("/");
  const origin = new URL(page.url()).origin;
  await page.context().addCookies([
    {
      name: "cf_marketing_locale",
      value: "ar",
      url: origin,
    },
  ]);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/privacy");

  await expect(page.locator("html")).toHaveAttribute("lang", "ar");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(
    page.getByRole("heading", { level: 1, name: "سياسة الخصوصية" }),
  ).toBeVisible();
  await expect(page.getByText("آخر تحديث: 15 يوليو 2026")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "حول دور ClinicFlow" }),
  ).toBeVisible();
  await expect(page.locator("article section")).toHaveCount(21);
  await expect(page.getByText("الاحتفاظ والأرشفة والحذف")).toBeVisible();
  await expect(page.getByText("ملفات الارتباط والتخزين في المتصفح")).toBeVisible();
  await expect(page.getByText("في انتظار المراجعة القانونية")).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);

  const main = page.locator("main.marketing-page");
  await expect(main).toHaveClass(/\blight\b/);
  await page.getByRole("button", { name: /الوضع مظلم/ }).click();
  await expect(main).toHaveClass(/\bdark\b/);

  await expect(
    page.getByRole("link", { name: "العودة إلى كلينيك فلو" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "شروط الخدمة" }),
  ).toBeVisible();
});
