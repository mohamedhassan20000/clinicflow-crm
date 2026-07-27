import { expect, test, type Page } from "@playwright/test";

async function ensureEnglishLanding(page: Page) {
  if (await page.locator("html").getAttribute("lang") !== "en") {
    await page.getByTestId("language-switcher-marketing").click();
    await page.getByRole("option", { name: "English" }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    const closeToast = page.getByRole("button", { name: "Close toast" }).last();
    if (await closeToast.isVisible()) {
      await closeToast.click();
      await expect(closeToast).toBeHidden();
    }
  }
}

async function openEnglishLanding(page: Page) {
  const response = await page.goto("/");
  await ensureEnglishLanding(page);
  return response;
}

test.beforeEach(async ({ page }, testInfo) => {
  await page.context().addCookies([
    {
      name: "cf_marketing_locale",
      value: "en",
      url: testInfo.project.use.baseURL as string,
    },
  ]);
});

test("landing reloads to Arabic while login preserves selected English", async ({ page }) => {
  await page.context().clearCookies();

  await page.goto("/login");
  await expect(page.locator("html")).toHaveAttribute("lang", "ar");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.locator(".forced-dark-scope")).toHaveCSS("color-scheme", "dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "ar");
  await expect(page.locator(".forced-dark-scope")).toHaveCSS("color-scheme", "dark");

  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("lang", "ar");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.locator("main.marketing-page")).toHaveClass(/\blight\b/);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "ar");
  await expect(page.locator("main.marketing-page")).toHaveClass(/\blight\b/);

  await page.getByTestId("language-switcher-marketing").click();
  await page.getByRole("option", { name: "English" }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect.poll(() => new URL(page.url()).searchParams.has("landingLocale")).toBe(false);
  await page.getByRole("link", { name: "Log in" }).first().click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await expect(page.locator(".forced-dark-scope")).toHaveCSS("color-scheme", "dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator(".forced-dark-scope")).toHaveCSS("color-scheme", "dark");

  await Promise.all([
    page.waitForURL((url) => url.pathname === "/"),
    page.getByRole("link", { name: "ClinicFlow home" }).filter({ visible: true }).click(),
  ]);
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect.poll(() => new URL(page.url()).searchParams.has("landingLocale")).toBe(false);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "ar");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.locator("main.marketing-page")).toHaveClass(/\blight\b/);
});

test("anonymous root renders the marketing site", async ({ page }) => {
  const response = await openEnglishLanding(page);
  expect(response?.ok()).toBeTruthy();
  await expect(page.getByRole("heading", { level: 1, name: /everything you need to manage your clinic/i })).toBeVisible();
  await expect(page.locator("#early-access")).toBeVisible();
  await expect(page.getByRole("link", { name: "Log in" }).first()).toHaveAttribute("href", "/login");
  await expect(page.getByAltText(/administrator dashboard showing daily appointments/i)).toBeVisible();
  await expect(page.getByRole("link", { name: "Privacy Policy" })).toHaveAttribute("href", "/privacy");
  await expect(page.getByRole("link", { name: "Terms of Service" })).toHaveAttribute("href", "/terms");
  await expect(page.locator(".marketing-hero-eyebrow")).toHaveCount(0);
  const englishHeroLineHeight = await page.locator(".marketing-hero-title").evaluate((heading) => {
    const style = getComputedStyle(heading);
    return Number.parseFloat(style.lineHeight) / Number.parseFloat(style.fontSize);
  });
  expect(englishHeroLineHeight).toBeCloseTo(1.25, 1);
  await expect(page.getByText("4 of 10 clinic spots taken this week").first()).toBeVisible();
  await expect(page.getByRole("progressbar", { name: "Weekly early-access cohort progress" })).toHaveAttribute("aria-valuenow", "4");
  await expect(page.getByRole("progressbar", { name: "Weekly early-access cohort progress" })).toHaveAttribute("aria-valuemax", "10");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test("FAQ keeps at most one answer open in both locales", async ({ page }, testInfo) => {
  for (const locale of ["en", "ar"] as const) {
    await page.context().addCookies([
      {
        name: "cf_marketing_locale",
        value: locale,
        url: testInfo.project.use.baseURL as string,
      },
    ]);
    if (locale === "en") {
      await openEnglishLanding(page);
    } else {
      await page.goto("/");
    }

    const faqItems = page.locator("#faq [data-marketing-faq-item]");
    await expect(faqItems).toHaveCount(locale === "ar" ? 8 : 9);

    const firstButton = faqItems.nth(0).getByRole("button");
    const secondButton = faqItems.nth(1).getByRole("button");
    const firstPanel = faqItems.nth(0).locator("[data-marketing-faq-panel]");

    await firstButton.click();
    await expect(firstButton).toHaveAttribute("aria-expanded", "true");
    await expect(firstPanel).toHaveCSS("transition-duration", "0.5s");
    await expect(page.locator('#faq button[aria-expanded="true"]')).toHaveCount(1);

    await secondButton.click();
    await expect(firstButton).toHaveAttribute("aria-expanded", "false");
    await expect(secondButton).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator('#faq button[aria-expanded="true"]')).toHaveCount(1);
  }
});

test("Arabic marketing typography uses only Thmanyah at the intended weights", async ({ page }, testInfo) => {
  await page.context().addCookies([
    {
      name: "cf_marketing_locale",
      value: "ar",
      url: testInfo.project.use.baseURL as string,
    },
  ]);
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("lang", "ar");
  await page.evaluate(() => document.fonts.ready);
  await expect(page.getByText("٤ من ١٠ عيادات انضمت إلينا هذا الأسبوع").first()).toBeVisible();
  await expect(page.getByRole("progressbar", { name: "التقدم الأسبوعي لمجموعة الوصول المبكر" })).toHaveAttribute("aria-valuenow", "4");
  await expect(page.getByRole("progressbar", { name: "التقدم الأسبوعي لمجموعة الوصول المبكر" })).toHaveAttribute("aria-valuemax", "10");
  await expect(page.locator(".marketing-hero source")).toHaveAttribute(
    "srcset",
    "/marketing/dashboard-ar-mobile.avif",
  );
  await expect(page.locator(".marketing-hero img")).toHaveAttribute(
    "src",
    /dashboard-ar-desktop\.avif/,
  );

  const styles = await page.evaluate(() => {
    const read = (selector: string) => {
      const element = document.querySelector(selector);
      if (!(element instanceof HTMLElement)) throw new Error(`Missing typography probe: ${selector}`);
      const style = getComputedStyle(element);
      return {
        family: style.fontFamily,
        lineHeight: Number.parseFloat(style.lineHeight),
        size: Number.parseFloat(style.fontSize),
        weight: Number(style.fontWeight),
      };
    };

    return {
      body: read(".marketing-hero-body"),
      button: read(".marketing-hero-actions a"),
      hero: read(".marketing-hero-title"),
      sectionHeading: read("#product-title"),
    };
  });

  for (const style of Object.values(styles)) {
    expect(style.family.toLowerCase()).toContain("thmanyah");
    expect(style.family.toLowerCase()).not.toContain("plex");
  }
  expect(styles.hero.weight).toBe(700);
  expect(styles.sectionHeading.weight).toBe(700);
  expect(styles.button.weight).toBeGreaterThanOrEqual(500);
  expect(styles.button.weight).toBeLessThanOrEqual(700);
  expect(styles.body.weight).toBe(400);
  expect(styles.hero.lineHeight / styles.hero.size).toBeCloseTo(1.4, 1);

  const aiPlanGap = await page.locator("#pricing article").filter({ hasText: "خطة Pro + AI" }).evaluate((card) => {
    const lastFeature = card.querySelector("li:last-child");
    const cta = card.querySelector("button");
    if (!lastFeature || !cta) throw new Error("Arabic AI plan spacing probes are missing");
    return cta.getBoundingClientRect().top - lastFeature.getBoundingClientRect().bottom;
  });
  expect(aiPlanGap).toBeGreaterThanOrEqual(30);
  const pricingCardHeights = await page.locator("#pricing article").evaluateAll((cards) =>
    cards.map((card) => card.getBoundingClientRect().height),
  );
  expect(Math.max(...pricingCardHeights) - Math.min(...pricingCardHeights)).toBeLessThanOrEqual(1);

  if (process.env.ARABIC_TYPOGRAPHY_VISUALS === "1") {
    await page.screenshot({
      path: testInfo.outputPath("arabic-marketing-typography.png"),
      animations: "disabled",
      fullPage: true,
    });
  }
});

test("hero descender stays inside ordinary text bounds at every acceptance width and theme", async ({ page }) => {
  test.setTimeout(90_000);
  const widths = [320, 360, 390, 430, 768, 1024, 1440, 1920, 2560];

  for (const width of widths) {
    await page.setViewportSize({ width, height: width < 768 ? 844 : 960 });
    await openEnglishLanding(page);
    await page.waitForLoadState("networkidle");

    for (const theme of ["light", "dark"] as const) {
      if (theme === "dark") {
        await page.getByRole("button", { name: "Switch marketing pages to dark mode" }).click();
        await expect(page.locator("main.marketing-page")).toHaveClass(/\bdark\b/);
      }

      const geometry = await page.locator(".marketing-hero-title .marketing-accent").evaluate((accent) => {
        const text = accent.firstChild;
        const heading = accent.closest("h1");
        if (!(text instanceof Text) || !heading) throw new Error("Hero accent text is missing");

        const yIndex = text.data.lastIndexOf("y");
        if (yIndex < 0) throw new Error("Hero descender glyph is missing");

        const range = document.createRange();
        range.setStart(text, yIndex);
        range.setEnd(text, yIndex + 1);

        const glyphBox = range.getBoundingClientRect();
        const accentBox = accent.getBoundingClientRect();
        const headingBox = heading.getBoundingClientRect();
        const accentStyle = getComputedStyle(accent);
        const headingStyle = getComputedStyle(heading);
        const paddingBottom = Number.parseFloat(accentStyle.paddingBlockEnd);

        let nearestClipBottom = Number.POSITIVE_INFINITY;
        for (let ancestor = accent.parentElement; ancestor; ancestor = ancestor.parentElement) {
          const style = getComputedStyle(ancestor);
          if (["hidden", "clip"].includes(style.overflowY)) {
            nearestClipBottom = Math.min(nearestClipBottom, ancestor.getBoundingClientRect().bottom);
          }
        }

        return {
          accentBottom: accentBox.bottom,
          backgroundClip: accentStyle.backgroundClip,
          backgroundImage: accentStyle.backgroundImage,
          glyphBottom: glyphBox.bottom,
          glyphLeft: glyphBox.left,
          glyphRight: glyphBox.right,
          headingBottom: headingBox.bottom,
          headingLeft: headingBox.left,
          headingOverflow: headingStyle.overflow,
          headingRight: headingBox.right,
          nearestClipBottom,
          paddingBottom,
          textColor: accentStyle.color,
          textFillColor: accentStyle.webkitTextFillColor,
        };
      });

      expect(geometry.backgroundImage).toBe("none");
      expect(geometry.backgroundClip).toBe("border-box");
      expect(geometry.textFillColor).toBe(geometry.textColor);
      expect(geometry.paddingBottom).toBeGreaterThan(0);
      expect(geometry.headingOverflow).toBe("visible");
      expect(geometry.glyphLeft).toBeGreaterThanOrEqual(geometry.headingLeft);
      expect(geometry.glyphRight).toBeLessThanOrEqual(geometry.headingRight);
      // A Range box is taller than the painted glyph, so keeping the entire range plus the safety
      // padding inside both boxes proves the visible descender cannot be clipped at block-end.
      expect(geometry.glyphBottom + geometry.paddingBottom).toBeLessThanOrEqual(geometry.accentBottom + 0.5);
      expect(geometry.glyphBottom + geometry.paddingBottom).toBeLessThan(geometry.nearestClipBottom);
    }
  }
});

test("marketing layout stays contained and legible at the responsive acceptance widths", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const widths = [320, 360, 390, 430, 768, 1024, 1440, 1920, 2560];

  await page.setViewportSize({ width: widths[0], height: 844 });
  await openEnglishLanding(page);
  await page.waitForLoadState("networkidle");

  for (const width of widths) {
    await page.setViewportSize({ width, height: width < 768 ? 844 : 960 });
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.getByRole("heading", { level: 1, name: /everything you need to manage your clinic/i })).toBeVisible();

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
      const sourceAsset = `${asset}-ar`;
      const picture = page.locator(`source[srcset="/marketing/${sourceAsset}-mobile.avif"]`).locator("xpath=..");
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
      expect(geometry.currentSrc).toContain(`/marketing/${sourceAsset}-mobile.avif`);
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
  await openEnglishLanding(page);

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
  await openEnglishLanding(page);
  await page.context().addCookies([
    { name: "theme", value: "dark", url: new URL(page.url()).origin },
  ]);
  await page.reload();
  await ensureEnglishLanding(page);

  const heroEarlyAccessButton = page
    .getByRole("button", { name: "Request early access" })
    .filter({ visible: true })
    .first();
  await page.waitForLoadState("networkidle");
  await heroEarlyAccessButton.click();
  const earlyAccessButton = page.getByRole("button", {
    name: "Request an invitation",
  });
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
    await openEnglishLanding(page);

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
  await openEnglishLanding(page);

  await expect(page.locator(".marketing-float")).toHaveCSS("animation-name", "none");
  await expect(page.locator(".marketing-card").first()).toHaveCSS("transition-duration", "0s");
  await page.evaluate(() => window.scrollTo({ top: 1_200, behavior: "instant" }));
  await expect(page.getByRole("button", { name: "Back to top" })).toHaveCSS("transition-duration", "0s");
});

test("marketing and legal pages default light and toggle independently of the dashboard cookie", async ({ page }) => {
  await openEnglishLanding(page);
  await page.context().addCookies([{ name: "theme", value: "dark", url: new URL(page.url()).origin }]);
  await page.reload();
  await ensureEnglishLanding(page);

  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(page.locator("main.marketing-page")).toHaveClass(/\blight\b/);
  await expect(page.locator("main.marketing-page")).toHaveCSS("color-scheme", "light");
  await expect(page.getByRole("heading", { level: 1, name: /everything you need to manage your clinic/i })).toBeVisible();

  await page.getByRole("button", { name: "Switch marketing pages to dark mode" }).click();
  await expect(page.locator("main.marketing-page")).toHaveClass(/\bdark\b/);
  await expect(page.locator("main.marketing-page")).toHaveCSS("color-scheme", "dark");
  await expect(page.locator("html")).toHaveClass(/dark/);

  await page.goto("/privacy");
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(page.locator("main.marketing-page")).toHaveClass(/\blight\b/);
  await expect(page.locator("main.marketing-page")).toHaveCSS("color-scheme", "light");
});

test("marketing legal pages carry their document-specific notices", async ({ page }) => {
  await page.goto("/privacy");
  await expect(page.getByRole("heading", { level: 1, name: "Privacy Policy" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "About ClinicFlow’s role" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Pending legal review" })).toHaveCount(0);
  await page.goto("/terms");
  await expect(page.getByRole("heading", { level: 1, name: "Terms of Service" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "ClinicFlow Liability Limitations" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Pending legal review" })).toHaveCount(0);
});

test("mobile marketing navigation is keyboard accessible", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openEnglishLanding(page);

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
  await expect(page.locator("aside .pulse-dot")).toHaveCount(0);
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
    await expect(page.getByRole("heading", { level: 1, name: /everything you need to manage your clinic/i })).toBeVisible();
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
