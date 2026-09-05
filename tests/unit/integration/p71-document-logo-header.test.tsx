import zlib from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import type { Browser } from "puppeteer-core";
import { DocumentPage } from "@/components/documents/engine";
import { buildDocumentHtml } from "@/lib/documents/pdf";
import { chromiumLaunchArgs, resolveChromiumExecutablePath } from "@/lib/documents/pdf/render";

/**
 * The clinic logo and the document header are shared by every document type, so
 * a silent regression in either shows up everywhere at once. This renders the
 * engine chrome in the real browser and asserts the logo is a loaded, visibly
 * sized image whose geometry is identical in screen preview and print, and that
 * the repeating `<thead>` header survives a multi-page paginated document.
 */

/**
 * A raster logo, so the exported PDF carries it as an image XObject and the
 * multi-page assertion can count one logo draw per page. Deliberately 4:1 so a
 * collapsed or distorted logo box fails loudly.
 */
async function logoDataUri() {
  const { default: sharp } = await import("sharp");
  const png = await sharp({
    create: { width: 400, height: 100, channels: 3, background: { r: 204, g: 0, b: 0 } },
  }).png().toBuffer();
  return `data:image/png;base64,${png.toString("base64")}`;
}

/** Image-draw (`/Name Do`) operators in every page content stream of a PDF. */
function logoDrawsPerPage(pdf: Uint8Array): number[] {
  const data = Buffer.from(pdf).toString("latin1");
  const objects = new Map<number, string>();
  for (const match of data.matchAll(/(\d+)\s+0\s+obj([\s\S]*?)endobj/g)) {
    objects.set(Number(match[1]), match[2]);
  }
  const draws: number[] = [];
  for (const [, body] of [...objects].sort(([a], [b]) => a - b)) {
    if (!/\/Type\s*\/Page[^s]/.test(body)) continue;
    const contents = body.match(/\/Contents\s+(\d+)\s+0\s+R/);
    if (!contents) continue;
    const stream = objects.get(Number(contents[1]))
      ?.match(/stream\r?\n([\s\S]*?)\r?\nendstream/);
    if (!stream) continue;
    const raw = Buffer.from(stream[1], "latin1");
    let content: string;
    try {
      content = zlib.inflateSync(raw).toString("latin1");
    } catch {
      content = raw.toString("latin1");
    }
    draws.push(content.match(/\/\w+\s+Do/g)?.length ?? 0);
  }
  return draws;
}

let browser: Browser | null = null;
afterAll(async () => { await browser?.close(); });

async function launch() {
  if (browser) return browser;
  const [{ default: puppeteer }, { default: chromium }, executablePath] = await Promise.all([
    import("puppeteer-core"),
    import("@sparticuz/chromium"),
    resolveChromiumExecutablePath(),
  ]);
  browser = await puppeteer.launch({
    executablePath,
    // The same decision production makes. Duplicating it here once meant a
    // macOS-only `/Applications/` probe, which on Linux CI passed Lambda flags
    // to a desktop Chrome and timed out.
    args: chromiumLaunchArgs(executablePath, chromium.args),
    headless: true,
  });
  return browser;
}

function readHeaderGeometry() {
  const logo = document.querySelector<HTMLImageElement>(".cf-doc-logo");
  const header = document.querySelector<HTMLElement>(".cf-doc-header")!;
  const grid = document.querySelector<HTMLElement>(".cf-doc-meta-grid")!;
  const pageEl = document.querySelector<HTMLElement>(".cf-document-page")!;
  const style = logo ? getComputedStyle(logo) : null;
  return {
    isImage: logo?.tagName === "IMG",
    loaded: Boolean(logo?.complete && logo.naturalWidth > 0),
    visible: Boolean(style && style.display !== "none" && style.visibility !== "hidden"
      && Number(style.opacity) > 0),
    logoWidth: logo?.getBoundingClientRect().width ?? 0,
    logoHeight: logo?.getBoundingClientRect().height ?? 0,
    headerWidth: header.getBoundingClientRect().width,
    headerHeight: header.getBoundingClientRect().height,
    metaLabels: Array.from(grid.querySelectorAll(".cf-doc-meta-label"), (n) => n.textContent),
    metaValues: Array.from(grid.querySelectorAll(".cf-doc-meta-value"), (n) => n.textContent),
    contactLines: Array.from(
      document.querySelectorAll(".cf-doc-contact-lines > p"),
      (n) => n.textContent,
    ),
    // Each identifier value is one atom: one line box, never wrapped.
    atomicValueLines: Array.from(
      grid.querySelectorAll(".cf-doc-meta-value-atomic"),
      (n) => n.getClientRects().length,
    ),
    overflowsPage: header.getBoundingClientRect().right > pageEl.getBoundingClientRect().right + 1
      || header.getBoundingClientRect().left < pageEl.getBoundingClientRect().left - 1,
  };
}

describe.each(["en", "ar"] as const)("P7-1 clinic logo and header in %s", (locale) => {
  it("renders the logo and header identically in preview and print", async () => {
    const logo = await logoDataUri();
    const html = await buildDocumentHtml({
      locale,
      title: "logo and header",
      renderDocument: (renderContextBoundary) => (
        <DocumentPage
          locale={locale}
          lifecycle="issued"
          branding={{
            name: locale === "ar" ? "عيادة كلينك فلو" : "ClinicFlow Clinic",
            logoSrc: logo,
            address: locale === "ar" ? "إسطنبول، تركيا" : "124 Medical Plaza, Istanbul",
            phone: "+90 555 000 0000",
            email: "clinic@example.com",
            website: "clinic.example.com",
            licenseNo: "MP-882-901",
            taxId: "TAX-99",
          }}
          identity={{
            title: locale === "ar" ? "الفاتورة" : "Invoice",
            documentNumber: "INV-2026-0001",
            issueDate: "09 Aug 2026",
            issueTime: "14:35",
            labels: {
              documentNumber: locale === "ar" ? "رقم الفاتورة" : "Invoice number",
              issueDate: locale === "ar" ? "تاريخ الإصدار" : "Date issued",
              issueTime: locale === "ar" ? "الوقت" : "Time",
            },
          }}
          watermark={{ enabled: false }}
          renderContextBoundary={renderContextBoundary}
        >
          {Array.from({ length: 120 }, (_, index) => <p key={index}>Body line {index + 1}</p>)}
        </DocumentPage>
      ),
    });

    const page = await (await launch()).newPage();
    await page.setViewport({ width: 1200, height: 1000 });
    try {
      await page.setContent(html, { waitUntil: "domcontentloaded" });
      await page.evaluate(() => document.fonts.ready);

      await page.emulateMediaType("screen");
      const preview = await page.evaluate(readHeaderGeometry);
      await page.emulateMediaType("print");
      const print = await page.evaluate(readHeaderGeometry);

      for (const [medium, geometry] of [["preview", preview], ["print", print]] as const) {
        expect(geometry.isImage, `${medium}: logo renders as an <img>`).toBe(true);
        expect(geometry.loaded, `${medium}: logo bytes decoded`).toBe(true);
        expect(geometry.visible, `${medium}: logo is visible`).toBe(true);
        expect(geometry.logoHeight, `${medium}: logo height`).toBeCloseTo(80, 0);
        // 4:1 art would be 320px at the fixed 80px height, so it lands on the
        // 200px max-inline-size cap — never squeezed below it.
        expect(geometry.logoWidth, `${medium}: logo width`).toBeCloseTo(200, 0);
        expect(geometry.overflowsPage, `${medium}: header inside the page box`).toBe(false);
      }

      expect(print.logoWidth).toBeCloseTo(preview.logoWidth, 0);
      expect(print.headerWidth).toBeCloseTo(preview.headerWidth, 0);
      expect(print.headerHeight).toBeCloseTo(preview.headerHeight, 0);
      expect(print.metaLabels).toEqual(preview.metaLabels);
      // Document number, tax registration, registration/licence, date, time.
      expect(preview.metaLabels).toHaveLength(5);
      expect(preview.metaValues).toContain("TAX-99");
      expect(preview.metaValues).toContain("MP-882-901");
      expect(preview.atomicValueLines).toEqual([1, 1]);

      // Address, phone, then email + website share the third line — and the
      // clinic identifiers are gone from the identity block beside the logo.
      expect(preview.contactLines).toHaveLength(3);
      expect(preview.contactLines[1]).toBe("+90 555 000 0000");
      expect(preview.contactLines[2]).toBe("clinic@example.comclinic.example.com");
      expect(preview.contactLines.join(" ")).not.toContain("MP-882-901");
      expect(preview.contactLines.join(" ")).not.toContain("TAX-99");

      // The header lives in the pagination <thead>, so Chromium repeats it on
      // every page of a multi-page PDF from a single markup instance.
      expect(await page.evaluate(() =>
        document.querySelectorAll(".cf-document-pagination > thead .cf-doc-header").length)).toBe(1);
      const pdf = await page.pdf({ format: "a4", printBackground: true });
      const { PDFDocument } = await import("pdf-lib");
      const pageCount = (await PDFDocument.load(pdf)).getPageCount();
      expect(pageCount).toBeGreaterThan(1);
      // Every exported page actually paints the clinic logo, not just page one.
      const draws = logoDrawsPerPage(pdf);
      expect(draws).toHaveLength(pageCount);
      expect(draws.every((count) => count >= 1)).toBe(true);
    } finally {
      await page.close();
    }
  }, 90_000);
});
