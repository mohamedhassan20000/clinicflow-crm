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

test("MP5 calling-code columns stay aligned on a 320px light surface", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto("/");
  await page.context().addCookies([
    { name: "theme", value: "dark", url: new URL(page.url()).origin },
  ]);
  await page.reload();

  const earlyAccessButton = page
    .getByRole("button", { name: "Request early access" })
    .filter({ visible: true })
    .first();
  await page.waitForLoadState("networkidle");
  await earlyAccessButton.click();
  await expect(earlyAccessButton).toHaveAttribute("aria-expanded", "true");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toHaveCSS("color-scheme", "light");

  const trigger = dialog.getByRole("combobox", { name: "Country calling code" });
  await trigger.click();
  const search = page.getByPlaceholder("Search country or code…");
  const popover = page.locator('[data-slot="popover-content"]');

  const bounds = await popover.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
  expect(bounds!.width).toBeLessThanOrEqual(280);

  await search.fill("British Indian Ocean");
  const option = page.getByRole("option", { name: /British Indian Ocean Territory/i });
  await expect(option).toHaveAccessibleName(/British Indian Ocean Territory.*IO.*\+246/i);

  const layout = await option.locator(".phone-cc-grid").evaluate((grid) => {
    const name = grid.children.item(1);
    const code = grid.children.item(2);
    const dial = grid.children.item(3);
    const style = getComputedStyle(grid);
    return {
      display: style.display,
      columns: style.gridTemplateColumns.split(" ").length,
      nameOverflow: name ? getComputedStyle(name).textOverflow : "",
      codePosition: code ? getComputedStyle(code).position : "",
      dialAlignment: dial ? getComputedStyle(dial).textAlign : "",
      dialNumerals: dial ? getComputedStyle(dial).fontVariantNumeric : "",
    };
  });
  expect(layout).toEqual({
    display: "grid",
    columns: 4,
    nameOverflow: "ellipsis",
    codePosition: "static",
    dialAlignment: "end",
    dialNumerals: "tabular-nums",
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);

  await search.press("Escape");
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
});

test("marketing logo stays unbadged and aligned on both backgrounds", async ({ page }) => {
  for (const width of [320, 360, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 960 });
    await page.goto("/");

    const logos = page.getByRole("link", { name: "ClinicFlow home" });
    await expect(logos).toHaveCount(2);

    for (let index = 0; index < 2; index += 1) {
      const logo = logos.nth(index);
      const mark = logo.locator(":scope > img");

      await expect(logo).toHaveAttribute("href", "/");
      await expect(mark).toHaveCount(1);
      await expect(mark).toHaveAttribute("width", "34");
      await expect(mark).toHaveAttribute("height", "30");

      const geometry = await logo.evaluate((link) => {
        const image = link.querySelector(":scope > img");
        const label = link.querySelector(":scope > span");
        if (!image || !label) return null;
        const linkBox = link.getBoundingClientRect();
        const imageBox = image.getBoundingClientRect();
        const labelBox = label.getBoundingClientRect();
        return {
          linkHeight: linkBox.height,
          linkStart: linkBox.left,
          linkEnd: linkBox.right,
          imageCenter: imageBox.top + imageBox.height / 2,
          labelCenter: labelBox.top + labelBox.height / 2,
          imageBackground: getComputedStyle(image).backgroundColor,
        };
      });

      expect(geometry).not.toBeNull();
      expect(geometry!.linkHeight).toBeGreaterThanOrEqual(44);
      expect(geometry!.linkStart).toBeGreaterThanOrEqual(0);
      expect(geometry!.linkEnd).toBeLessThanOrEqual(width);
      expect(Math.abs(geometry!.imageCenter - geometry!.labelCenter)).toBeLessThan(2);
      expect(geometry!.imageBackground).toBe("rgba(0, 0, 0, 0)");
    }
  }
});

test("marketing page honors reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");

  await expect(page.locator(".marketing-float")).toHaveCSS("animation-name", "none");
  await expect(page.locator(".marketing-card").first()).toHaveCSS("transition-duration", "0s");
});

test("marketing and legal pages stay light in a dark-theme session", async ({ page }) => {
  await page.goto("/");
  await page.context().addCookies([{ name: "theme", value: "dark", url: new URL(page.url()).origin }]);
  await page.reload();

  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(page.locator("main.marketing-page")).toHaveClass(/\blight\b/);
  await expect(page.locator("main.marketing-page")).toHaveCSS("color-scheme", "light");
  await expect(page.getByRole("heading", { level: 1, name: /a clearer clinic day/i })).toBeVisible();

  await page.goto("/privacy");
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(page.locator("main.marketing-page")).toHaveClass(/\blight\b/);
  await expect(page.locator("main.marketing-page")).toHaveCSS("color-scheme", "light");
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
  await expect(page.locator(".forced-dark-scope")).toHaveCSS("color-scheme", "dark");
  await expect(page.getByRole("link", { name: /clinicflow home/i })).toBeVisible();
  await expect(page.getByRole("heading", { name: /welcome back/i })).toBeVisible();
  await expect(page.getByLabel(/email/i)).toBeVisible();
  await expect(page.locator('input[type="password"]')).toBeVisible();
  await expect(page.getByRole("button", { name: /sign in/i })).toBeVisible();
});

test("the login brand lockup opens the marketing landing page", async ({ page }) => {
  for (const [width, height] of [[1440, 900], [390, 844]] as const) {
    await page.setViewportSize({ width, height });
    await page.goto("/login");

    const lockup = page.getByRole("link", { name: "ClinicFlow home" }).filter({ visible: true });
    await expect(lockup).toHaveCount(1);
    await expect(lockup).toHaveAttribute("href", "/");

    await lockup.click();
    await page.waitForURL("**/");
    expect(new URL(page.url()).pathname).toBe("/");
    await expect(page.getByRole("heading", { level: 1, name: /a clearer clinic day/i })).toBeVisible();
  }
});

test("authentication pages stay dark in both cookie states", async ({ page }) => {
  await page.goto("/login");
  const origin = new URL(page.url()).origin;

  for (const theme of ["light", "dark"] as const) {
    await page.context().addCookies([{ name: "theme", value: theme, url: origin }]);
    await page.goto("/login");
    await expect(page.locator(".forced-dark-scope")).toHaveClass(/\bdark\b/);
    await expect(page.locator(".forced-dark-scope")).toHaveCSS("color-scheme", "dark");

    await page.goto("/signup/complete");
    await expect(page.locator(".forced-dark-scope")).toHaveClass(/\bdark\b/);
    await expect(page.locator(".forced-dark-scope")).toHaveCSS("color-scheme", "dark");
  }
});
