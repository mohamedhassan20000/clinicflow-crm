import { expect, test } from "@playwright/test";

test("anonymous root renders the marketing site", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.ok()).toBeTruthy();
  await expect(page.getByRole("heading", { level: 1, name: /a clearer clinic day/i })).toBeVisible();
  await expect(page.locator("#early-access")).toBeVisible();
  await expect(page.getByRole("link", { name: "Log in" }).first()).toHaveAttribute("href", "/login");
  await expect(page.getByAltText(/administrator dashboard showing daily appointments/i)).toBeVisible();
  await expect(page.getByRole("link", { name: "Privacy Policy" })).toHaveAttribute("href", "/privacy");
  await expect(page.getByRole("link", { name: "Terms of Service" })).toHaveAttribute("href", "/terms");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test("marketing layout stays contained at the acceptance widths", async ({ page }) => {
  for (const width of [360, 768, 1440]) {
    await page.setViewportSize({ width, height: width === 360 ? 800 : 960 });
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: /a clearer clinic day/i })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  }
});

test("marketing page honors reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");

  await expect(page.locator(".marketing-float")).toHaveCSS("animation-name", "none");
  await expect(page.locator(".marketing-card").first()).toHaveCSS("transition-duration", "0s");
});

test("marketing page renders a coherent dark-theme session", async ({ page }) => {
  await page.goto("/");
  await page.context().addCookies([{ name: "theme", value: "dark", url: new URL(page.url()).origin }]);
  await page.reload();

  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(page.locator("main.marketing-page")).toHaveCSS("color-scheme", "dark");
  await expect(page.getByRole("heading", { level: 1, name: /a clearer clinic day/i })).toBeVisible();
});

test("marketing legal placeholders carry the legal-review notice", async ({ page }) => {
  await page.goto("/privacy");
  await expect(page.getByRole("heading", { level: 1, name: "Privacy Policy" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Pending legal review" })).toBeVisible();
  await page.goto("/terms");
  await expect(page.getByRole("heading", { level: 1, name: "Terms of Service" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Pending legal review" })).toBeVisible();
});

test("mobile marketing navigation is keyboard accessible", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  const menu = page.getByRole("button", { name: "Open navigation menu" });
  await menu.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("link", { name: "Features" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
});

test("login page renders brand and form", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("link", { name: /clinicflow home/i })).toBeVisible();
  await expect(page.getByRole("heading", { name: /welcome back/i })).toBeVisible();
  await expect(page.getByLabel(/email/i)).toBeVisible();
  await expect(page.locator('input[type="password"]')).toBeVisible();
  await expect(page.getByRole("button", { name: /sign in/i })).toBeVisible();
});
