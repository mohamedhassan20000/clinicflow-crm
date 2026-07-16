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

test("English terms are complete, responsive, and theme-aware", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/terms");

  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await expect(
    page.getByRole("heading", { level: 1, name: "Terms of Service" }),
  ).toBeVisible();
  await expect(page.getByText("Last updated: July 15, 2026")).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "ClinicFlow Liability Limitations",
    }),
  ).toBeVisible();
  await expect(page.locator("article section")).toHaveCount(25);
  await expect(page.getByText("Medical disclaimer")).toBeVisible();
  await expect(page.getByText("Trial and subscription access")).toBeVisible();
  await expect(page.getByText("Export and data portability")).toBeVisible();
  await expect(page.getByText("Applicable law and disputes")).toBeVisible();
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

  await expect(
    page.getByRole("link", { name: "Back to ClinicFlow" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Privacy Policy" }),
  ).toBeVisible();
});

test("Arabic terms are complete, RTL, responsive, and theme-aware", async ({
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
  await page.goto("/terms");

  await expect(page.locator("html")).toHaveAttribute("lang", "ar");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(
    page.getByRole("heading", { level: 1, name: "شروط الخدمة" }),
  ).toBeVisible();
  await expect(page.getByText("آخر تحديث: 15 يوليو 2026")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "حدود مسؤولية ClinicFlow" }),
  ).toBeVisible();
  await expect(page.locator("article section")).toHaveCount(25);
  await expect(page.getByText("إخلاء المسؤولية الطبية")).toBeVisible();
  await expect(page.getByText("التجربة والاشتراك")).toBeVisible();
  await expect(page.getByText("التصدير وقابلية النقل")).toBeVisible();
  await expect(page.getByText("القانون واجب التطبيق وتسوية النزاعات")).toBeVisible();
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
    page.getByRole("link", { name: "سياسة الخصوصية" }),
  ).toBeVisible();
});
