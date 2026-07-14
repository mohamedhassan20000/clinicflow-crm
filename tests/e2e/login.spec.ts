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

test("marketing layout stays contained and legible at the responsive acceptance widths", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const widths = [320, 360, 390, 430, 768, 1024, 1440, 1920, 2560];

  await page.setViewportSize({ width: widths[0], height: 844 });
  await page.goto("/");
  await page.waitForLoadState("networkidle");

  for (const width of widths) {
    await page.setViewportSize({ width, height: width < 768 ? 844 : 960 });
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.getByRole("heading", { level: 1, name: /a clearer clinic day/i })).toBeVisible();

    const header = page.locator("header").first();
    const headerRow = header.locator(":scope > div");
    const hero = page.locator("section.marketing-hero");
    const heroContent = hero.locator(":scope > div").nth(1);
    const heroFrame = hero.locator(".marketing-product-frame");
    const heroImage = heroFrame.locator("img");
    const workflowFrame = page.locator("#product .marketing-product-frame").first();
    const workflowImage = workflowFrame.locator("img");
    const desktopNav = header.getByRole("navigation", { name: "Main navigation" });
    const mobileMenu = header.getByRole("button", { name: "Open navigation menu" });

    await expect.poll(() => heroImage.evaluate((image) => {
      const element = image as HTMLImageElement;
      return element.complete && element.naturalWidth > 0;
    })).toBe(true);
    await workflowImage.scrollIntoViewIfNeeded();
    await expect.poll(() => workflowImage.evaluate((image) => {
      const element = image as HTMLImageElement;
      return element.complete && element.naturalWidth > 0;
    })).toBe(true);
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));

    expect(await page.evaluate(() => ({
      documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
      viewportWidth: window.innerWidth,
    }))).toEqual({ documentWidth: width, bodyWidth: width, viewportWidth: width });

    const headerGeometry = await headerRow.evaluate((row) => {
      const rowBox = row.getBoundingClientRect();
      const children = Array.from(row.children)
        .filter((child) => getComputedStyle(child).display !== "none")
        .map((child) => child.getBoundingClientRect())
        .sort((a, b) => a.left - b.left);
      return {
        left: rowBox.left,
        right: rowBox.right,
        overlaps: children.some((box, index) => index > 0 && box.left < children[index - 1].right - 0.5),
      };
    });
    expect(headerGeometry.left).toBeGreaterThanOrEqual(0);
    expect(headerGeometry.right).toBeLessThanOrEqual(width);
    expect(headerGeometry.overlaps).toBe(false);

    if (width >= 1280) {
      await expect(desktopNav).toBeVisible();
      await expect(mobileMenu).toBeHidden();
    } else {
      await expect(desktopNav).toBeHidden();
      await expect(mobileMenu).toBeVisible();
      const [themeBox, menuBox] = await Promise.all([
        header.getByRole("button", { name: /switch marketing pages to/i }).boundingBox(),
        mobileMenu.boundingBox(),
      ]);
      expect(themeBox?.width).toBeGreaterThanOrEqual(44);
      expect(themeBox?.height).toBeGreaterThanOrEqual(44);
      expect(menuBox?.width).toBeGreaterThanOrEqual(44);
      expect(menuBox?.height).toBeGreaterThanOrEqual(44);

    }

    const [heroBox, contentBox, frameBox] = await Promise.all([
      hero.boundingBox(),
      heroContent.boundingBox(),
      heroFrame.boundingBox(),
    ]);
    expect(heroBox).not.toBeNull();
    expect(contentBox).not.toBeNull();
    expect(frameBox).not.toBeNull();
    expect(heroBox!.x).toBeCloseTo(0, 0);
    expect(heroBox!.width).toBeCloseTo(width, 0);
    expect(contentBox!.width).toBeLessThanOrEqual(1920);
    expect(frameBox!.x).toBeGreaterThanOrEqual(0);
    expect(frameBox!.x + frameBox!.width).toBeLessThanOrEqual(width);

    const heroPattern = await hero.evaluate((node) => {
      const style = getComputedStyle(node, "::before");
      return { width: Number.parseFloat(style.width), opacity: style.opacity, mask: style.maskImage };
    });
    expect(heroPattern.width).toBeCloseTo(width, 0);
    expect(heroPattern.opacity).toBe("0.07");
    expect(heroPattern.mask).toContain("0.5");

    const imageGeometry = await heroImage.evaluate((image) => {
      const box = image.getBoundingClientRect();
      const element = image as HTMLImageElement;
      return {
        ratio: box.width / box.height,
        naturalRatio: element.naturalWidth / element.naturalHeight,
        objectFit: getComputedStyle(image).objectFit,
      };
    });
    expect(imageGeometry.objectFit).toBe("contain");
    expect(imageGeometry.ratio).toBeCloseTo(width < 768 ? 390 / 844 : 3 / 2, 2);
    expect(imageGeometry.naturalRatio).toBeCloseTo(width < 768 ? 390 / 844 : 3 / 2, 2);

    const [workflowBox, workflowImageGeometry] = await Promise.all([
      workflowFrame.boundingBox(),
      workflowImage.evaluate((image) => {
        const box = image.getBoundingClientRect();
        return { ratio: box.width / box.height, objectFit: getComputedStyle(image).objectFit };
      }),
    ]);
    expect(workflowBox?.x).toBeGreaterThanOrEqual(0);
    expect(workflowBox ? workflowBox.x + workflowBox.width : width + 1).toBeLessThanOrEqual(width);
    expect(workflowImageGeometry.objectFit).toBe("contain");
    expect(workflowImageGeometry.ratio).toBeCloseTo(width < 768 ? 390 / 844 : 3 / 2, 2);

    const cohort = page.getByRole("heading", { name: /limited clinic cohort/i }).locator("xpath=ancestor::section");
    const cohortBox = await cohort.boundingBox();
    const expectedMinimum = width >= 1536 ? 768 : width >= 1024 ? 704 : width >= 768 ? 640 : width >= 640 ? 576 : 512;
    expect(cohortBox?.height).toBeGreaterThanOrEqual(expectedMinimum);

    if (width >= 1920) {
      expect(frameBox!.width).toBeGreaterThan(1000);
      expect((await workflowFrame.boundingBox())?.width).toBeGreaterThan(1000);
    }

    if (process.env.RESPONSIVE_VISUALS === "1") {
      await page.screenshot({
        path: testInfo.outputPath(`marketing-responsive-${width}.png`),
        animations: "disabled",
        fullPage: false,
      });
      await heroFrame.screenshot({
        path: testInfo.outputPath(`marketing-screenshot-${width}.png`),
        animations: "disabled",
      });
      await cohort.screenshot({
        path: testInfo.outputPath(`marketing-cohort-${width}.png`),
        animations: "disabled",
      });
      await workflowFrame.screenshot({
        path: testInfo.outputPath(`marketing-workflow-${width}.png`),
        animations: "disabled",
      });
    }
  }
});

test("mobile marketing screenshots remain fully contained at the phone capture sizes", async ({ page }) => {
  test.setTimeout(60_000);
  const viewports = [
    { width: 320, height: 568 },
    { width: 360, height: 800 },
    { width: 390, height: 844 },
    { width: 430, height: 932 },
  ];

  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    for (const asset of ["dashboard", "reports"]) {
      const picture = page.locator(`source[srcset="/marketing/${asset}-mobile.avif"]`).locator("xpath=..");
      const image = picture.locator("img");
      await image.scrollIntoViewIfNeeded();
      await expect.poll(() => image.evaluate((element) => {
        const rendered = element as HTMLImageElement;
        return rendered.complete && rendered.naturalWidth > 0;
      })).toBe(true);

      const geometry = await image.evaluate((element) => {
        const rendered = element as HTMLImageElement;
        const rectangle = rendered.getBoundingClientRect();
        return {
          currentSrc: rendered.currentSrc,
          naturalWidth: rendered.naturalWidth,
          naturalHeight: rendered.naturalHeight,
          left: rectangle.left,
          right: rectangle.right,
          ratio: rectangle.width / rectangle.height,
          objectFit: getComputedStyle(rendered).objectFit,
        };
      });
      expect(geometry.currentSrc).toContain(`/marketing/${asset}-mobile.avif`);
      expect(geometry.naturalWidth).toBe(390);
      expect(geometry.naturalHeight).toBe(844);
      expect(geometry.left).toBeGreaterThanOrEqual(0);
      expect(geometry.right).toBeLessThanOrEqual(viewport.width);
      expect(geometry.ratio).toBeCloseTo(390 / 844, 2);
      expect(geometry.objectFit).toBe("contain");
    }

    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width);
  }
});

test("landing-page back-to-top control is accessible and returns focus users to the top", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  const backToTop = page.getByRole("button", { name: "Back to top", includeHidden: true });
  await expect(backToTop).toBeHidden();
  await expect(backToTop).toHaveAttribute("tabindex", "-1");

  await page.evaluate(() => window.scrollTo({ top: Math.max(1_200, window.innerHeight * 2), behavior: "instant" }));
  await expect(backToTop).toBeVisible();
  await expect(backToTop).toHaveAttribute("tabindex", "0");

  const buttonBox = await backToTop.boundingBox();
  expect(buttonBox).not.toBeNull();
  expect(buttonBox!.x + buttonBox!.width).toBeLessThanOrEqual(390 - 15);
  expect(buttonBox!.y + buttonBox!.height).toBeLessThanOrEqual(844 - 15);

  await backToTop.focus();
  await expect(backToTop).toBeFocused();
  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(() => window.scrollY), { timeout: 5_000 }).toBeLessThan(10);
  await expect(backToTop).toBeHidden();
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
  await page.evaluate(() => window.scrollTo({ top: 1_200, behavior: "instant" }));
  await expect(page.getByRole("button", { name: "Back to top" })).toHaveCSS("transition-duration", "0s");
});

test("marketing and legal pages default light and toggle independently of the dashboard cookie", async ({ page }) => {
  await page.goto("/");
  await page.context().addCookies([{ name: "theme", value: "dark", url: new URL(page.url()).origin }]);
  await page.reload();

  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(page.locator("main.marketing-page")).toHaveClass(/\blight\b/);
  await expect(page.locator("main.marketing-page")).toHaveCSS("color-scheme", "light");
  await expect(page.getByRole("heading", { level: 1, name: /a clearer clinic day/i })).toBeVisible();

  await page.getByRole("button", { name: "Switch marketing pages to dark mode" }).click();
  await expect(page.locator("main.marketing-page")).toHaveClass(/\bdark\b/);
  await expect(page.locator("main.marketing-page")).toHaveCSS("color-scheme", "dark");
  await expect(page.locator("html")).toHaveClass(/dark/);

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
