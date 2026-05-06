import { expect, test } from "@playwright/test";

test("root redirects to /login", async ({ page }) => {
  const response = await page.goto("/");
  expect(page.url()).toContain("/login");
  expect(response?.ok()).toBeTruthy();
});

test("login page renders brand and form", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("link", { name: /clinicflow home/i })).toBeVisible();
  await expect(page.getByRole("heading", { name: /welcome back/i })).toBeVisible();
  await expect(page.getByLabel(/email/i)).toBeVisible();
  await expect(page.locator('input[type="password"]')).toBeVisible();
  await expect(page.getByRole("button", { name: /sign in/i })).toBeVisible();
});
