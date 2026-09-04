import "server-only";
import { access } from "node:fs/promises";
import type { Browser, Page } from "puppeteer-core";
import type { Locale } from "@/lib/i18n/config";
import type { DocumentOrientation } from "@/components/documents/engine/types";
import {
  buildDocumentHtml,
  type ServerDocumentRender,
} from "@/lib/documents/pdf/html";
import { DocumentIssueError } from "@/lib/documents/issuance";

const LOCAL_CHROME_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
] as const;

export type ChromiumPdfResult = {
  pdf: Uint8Array;
  pageCount: number;
};

export type ChromiumPdfRenderInput = {
  renderDocument: ServerDocumentRender;
  locale: Locale;
  title: string;
  orientation?: DocumentOrientation;
};

async function existingPath(paths: readonly string[]): Promise<string | null> {
  for (const path of paths) {
    try {
      await access(path);
      return path;
    } catch {
      // Continue to the next explicit candidate.
    }
  }
  return null;
}

function chromiumLaunchArgs(
  executablePath: string,
  serverlessArgs: readonly string[],
): string[] {
  if (!LOCAL_CHROME_PATHS.includes(executablePath as (typeof LOCAL_CHROME_PATHS)[number])) {
    return [...serverlessArgs];
  }
  // Sparticuz's single-process/headless-shell flags target its Lambda binary
  // and can prevent a full desktop Chrome build from starting on macOS/Linux.
  return ["--no-sandbox", "--disable-setuid-sandbox"];
}

export async function resolveChromiumExecutablePath(): Promise<string> {
  const configured = process.env.CHROME_EXECUTABLE_PATH?.trim();
  if (configured) {
    await access(configured);
    return configured;
  }
  const local = await existingPath(LOCAL_CHROME_PATHS);
  if (local) return local;
  const { default: chromium } = await import("@sparticuz/chromium");
  return chromium.executablePath();
}

async function blockExternalRequests(page: Page): Promise<void> {
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    const protocol = new URL(request.url()).protocol;
    if (protocol === "data:" || protocol === "about:") void request.continue();
    else void request.abort("blockedbyclient");
  });
}

export async function renderDocumentPdf({
  renderDocument,
  locale,
  title,
  orientation = "portrait",
}: ChromiumPdfRenderInput): Promise<ChromiumPdfResult> {
  let html: string;
  try {
    html = await buildDocumentHtml({ renderDocument, locale, title });
  } catch (error) {
    throw new DocumentIssueError("server-html-render", error);
  }

  let browser: Browser | null = null;
  try {
    const [{ default: puppeteer }, { default: chromium }, executablePath] = await Promise.all([
      import("puppeteer-core"),
      import("@sparticuz/chromium"),
      resolveChromiumExecutablePath(),
    ]);
    browser = await puppeteer.launch({
      executablePath,
      args: chromiumLaunchArgs(executablePath, chromium.args),
      headless: true,
    });
    const page = await browser.newPage();
    await blockExternalRequests(page);
    await page.setJavaScriptEnabled(false);
    await page.emulateMediaType("print");
    await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.evaluate(() => document.fonts.ready);
    const pdf = await page.pdf({
      format: "A4",
      landscape: orientation === "landscape",
      preferCSSPageSize: true,
      printBackground: true,
      tagged: true,
    });
    const pdfBytes = new Uint8Array(pdf);
    const { PDFDocument } = await import("pdf-lib");
    const renderedDocument = await PDFDocument.load(pdfBytes);
    return { pdf: pdfBytes, pageCount: renderedDocument.getPageCount() };
  } catch (error) {
    throw error instanceof DocumentIssueError
      ? error
      : new DocumentIssueError("chromium-pdf", error);
  } finally {
    await browser?.close();
  }
}
