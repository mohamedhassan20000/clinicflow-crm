import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const marketingPage = readFileSync("components/marketing/marketing-page.tsx", "utf8");
const productScreenshot = readFileSync("components/marketing/product-screenshot.tsx", "utf8");
const mobileMenu = readFileSync("components/marketing/mobile-marketing-menu.tsx", "utf8");
const styles = readFileSync("app/globals.css", "utf8");

describe("marketing responsive layout correction", () => {
  it("separates the full-width hero from its readable content container", () => {
    expect(marketingPage).toContain("marketing-hero relative flex");
    expect(marketingPage).toContain("w-full items-center");
    expect(marketingPage).toContain("mx-auto grid w-full max-w-[120rem]");
    expect(marketingPage).toContain("2xl:grid-cols-[.72fr_1.28fr]");
    expect(styles).toContain(".marketing-hero::before");
    expect(styles).toContain("inset-inline: 0");
    expect(styles).toContain("rgb(0 0 0 / 50%) 100%");
  });

  it("keeps desktop navigation collapsed until the wide-header breakpoint", () => {
    expect(marketingPage).toContain("text-[var(--m-muted)] xl:flex");
    expect(marketingPage).toContain("hidden items-center gap-2 xl:flex");
    expect(mobileMenu).toContain("xl:hidden");
    expect(marketingPage).toContain("gap-3 px-3 sm:px-5 lg:px-10 2xl:px-16");
  });

  it("renders mobile screenshots at their full portrait ratio without cropping", () => {
    expect(productScreenshot).toContain('media="(max-width: 767px)"');
    expect(productScreenshot).toContain('srcSet={mobile} type="image/avif"');
    expect(productScreenshot).toContain("avoid a second lossy pass");
    expect(productScreenshot).toContain("aspect-[390/844]");
    expect(productScreenshot).toContain("object-contain");
    expect(productScreenshot).not.toContain("object-cover");
    expect(productScreenshot).toContain("md:aspect-[3/2]");
  });

  it("widens product captures and gives the post-hero section responsive depth", () => {
    expect(marketingPage).toContain('id="product"');
    expect(marketingPage).toContain("mx-auto max-w-[120rem]");
    expect(marketingPage).toContain("xl:grid-cols-[minmax(22rem,.72fr)_minmax(0,1.28fr)]");
    expect(marketingPage).toContain("min-h-[32rem]");
    expect(marketingPage).toContain("md:min-h-[40rem]");
    expect(marketingPage).toContain("lg:min-h-[44rem]");
    expect(marketingPage).toContain("2xl:min-h-[48rem]");
  });
});
