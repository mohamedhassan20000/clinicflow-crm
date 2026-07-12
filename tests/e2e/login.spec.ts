import { expect, test } from "@playwright/test";

test("anonymous root renders the marketing site", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.ok()).toBeTruthy();
  await expect(page.getByRole("heading", { level: 1, name: /your clinic/i })).toBeVisible();
  await expect(page.locator("#early-access")).toBeVisible();
  await expect(page.getByRole("link", { name: "Try ClinicFlow" })).toHaveAttribute("href", "/login");
});

test("marketing page honors reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");

  await expect(page.locator(".marketing-float")).toHaveCSS("animation-name", "none");
  await expect(page.locator(".marketing-card").first()).toHaveCSS("transition-duration", "0s");
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
