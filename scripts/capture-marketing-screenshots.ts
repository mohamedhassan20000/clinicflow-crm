import { mkdir, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { chromium, type Page } from "@playwright/test";
import { createServerClient } from "@supabase/ssr";
import sharp from "sharp";
import { MARKETING_DEMO, seedMarketingDemo } from "./seed-marketing-demo";
import type { Database } from "../types/database";

const externalBaseUrl = process.env.MARKETING_BASE_URL;
const baseUrl = externalBaseUrl ?? "http://127.0.0.1:3105";
const outputDir = resolve("public/marketing");
const rawDir = resolve(".tmp/marketing-screenshots");
const assetLocale = process.env.MARKETING_CAPTURE_ASSET_LOCALE;
const demoMarket = process.env.MARKETING_DEMO_MARKET === "kw" ? "kw" : "sa";

const captures = [
  { name: "dashboard", path: "/dashboard" },
  { name: "schedule", path: "/appointments?view=week" },
  { name: "patients", path: "/patients" },
  { name: "patient-record", path: `/patients/${MARKETING_DEMO.patientIds[0]}` },
  { name: "reports", path: "/reports/revenue" },
] as const;

const captureVariants = ["desktop", "mobile"] as const;
const mobileVerificationViewports = [
  { width: 320, height: 568 },
  { width: 360, height: 800 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
] as const;

type CaptureName = (typeof captures)[number]["name"];
type CaptureVariant = (typeof captureVariants)[number];

type AvatarRegion = { left: number; top: number; width: number; height: number };

function expectedAvatarCount(name: string) {
  if (name === "patients") return 9;
  if (name === "patient-record") return 2;
  return 1;
}

async function collectVisibleAvatarRegions(
  page: Page,
  name: string,
  viewport: { width: number; height: number },
) {
  const minimum = expectedAvatarCount(name);
  await page.waitForFunction(
    ({ expected }) => {
      const images = Array.from(document.querySelectorAll<HTMLImageElement>('[data-slot="avatar-image"]'));
      return images.length >= expected && images.every((image) => image.complete && image.naturalWidth > 0);
    },
    { expected: minimum },
    { timeout: 10_000 },
  );

  const regions = await page.locator('[data-slot="avatar-image"]').evaluateAll(
    (images, captureViewport) => images.flatMap((image) => {
      const rect = image.getBoundingClientRect();
      const style = window.getComputedStyle(image);
      const left = Math.max(0, Math.floor(rect.left));
      const top = Math.max(0, Math.floor(rect.top));
      const right = Math.min(captureViewport.width, Math.ceil(rect.right));
      const bottom = Math.min(captureViewport.height, Math.ceil(rect.bottom));
      if (
        style.visibility === "hidden" ||
        style.display === "none" ||
        Number(style.opacity) === 0 ||
        right - left < 24 ||
        bottom - top < 24
      ) return [];
      return [{ left, top, width: right - left, height: bottom - top }];
    }),
    viewport,
  );

  if (regions.length === 0) {
    throw new Error(`${name} has no visible avatar regions in the capture viewport.`);
  }
  return regions;
}

async function verifyAvatarRegions(outputPath: string, label: string, regions: AvatarRegion[]) {
  for (const [index, region] of regions.entries()) {
    const crop = await sharp(outputPath).extract(region).png().toBuffer();
    const stats = await sharp(crop).stats();
    const averageDeviation = stats.channels
      .slice(0, 3)
      .reduce((total, channel) => total + channel.stdev, 0) / 3;
    if (stats.entropy < 2.5 || averageDeviation < 15) {
      throw new Error(
        `${label} avatar ${index + 1} lacks visible photographic detail ` +
        `(entropy ${stats.entropy.toFixed(2)}, deviation ${averageDeviation.toFixed(2)}).`,
      );
    }
  }
  process.stdout.write(`Verified ${regions.length} visible avatar region(s) in ${label}.\n`);
}

function selectRequestedValues<T extends string>(
  environmentValue: string | undefined,
  allowedValues: readonly T[],
  environmentName: string,
) {
  if (!environmentValue) return [...allowedValues];
  const requested = environmentValue.split(",").map((value) => value.trim()).filter(Boolean);
  const unknown = requested.filter((value) => !allowedValues.includes(value as T));
  if (unknown.length > 0) {
    throw new Error(`${environmentName} contains unsupported value(s): ${unknown.join(", ")}.`);
  }
  return requested as T[];
}

async function verifyMobileComposition(
  page: Page,
  name: CaptureName,
  viewport: (typeof mobileVerificationViewports)[number],
) {
  const documentFits = await page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  );
  if (!documentFits) {
    throw new Error(`${name} overflows horizontally at ${viewport.width}x${viewport.height}.`);
  }

  if (name === "dashboard") {
    const buckets = page.locator('[data-testid="dashboard-revenue-bucket"]');
    if (await buckets.count() !== 3) {
      throw new Error(`Dashboard revenue summary did not render all three buckets at ${viewport.width}px.`);
    }
    const layout = await buckets.evaluateAll((elements) => {
      const rectangles = elements.map((element) => element.getBoundingClientRect());
      const overlaps = rectangles.some((rectangle, index) => rectangles.slice(index + 1).some((other) => (
        rectangle.left < other.right - 0.5 &&
        rectangle.right > other.left + 0.5 &&
        rectangle.top < other.bottom - 0.5 &&
        rectangle.bottom > other.top + 0.5
      )));
      const contentOverflows = elements.some((element) => (
        element.scrollWidth > element.clientWidth + 1 ||
        Array.from(element.querySelectorAll<HTMLElement>('[data-testid="dashboard-revenue-value"]'))
          .some((value) => value.scrollWidth > value.clientWidth + 1)
      ));
      return {
        overlaps,
        contentOverflows,
        lastBottom: Math.max(...rectangles.map((rectangle) => rectangle.bottom)),
      };
    });
    if (layout.overlaps || layout.contentOverflows || layout.lastBottom > viewport.height + 1) {
      throw new Error(
        `Dashboard revenue summary failed mobile layout verification at ${viewport.width}x${viewport.height} ` +
        `(overlap=${layout.overlaps}, overflow=${layout.contentOverflows}, bottom=${layout.lastBottom.toFixed(1)}).`,
      );
    }
  }

  if (name === "reports") {
    const results = page.locator('[data-testid="revenue-report-results"]');
    const filters = page.locator('[data-testid="revenue-report-filters"]');
    const values = page.locator('[data-testid="revenue-report-results"] [data-testid="report-metric-value"]');
    const [resultsBox, filtersBox, visibleValueCount, valuesOverflow] = await Promise.all([
      results.boundingBox(),
      filters.boundingBox(),
      values.evaluateAll((elements, captureViewport) => elements.filter((element) => {
        const rectangle = element.getBoundingClientRect();
        return rectangle.top >= 0 && rectangle.bottom <= captureViewport.height &&
          rectangle.left >= 0 && rectangle.right <= captureViewport.width;
      }).length, viewport),
      values.evaluateAll((elements) => elements.some((element) => element.scrollWidth > element.clientWidth + 1)),
    ]);
    if (
      !resultsBox ||
      !filtersBox ||
      resultsBox.y >= filtersBox.y ||
      visibleValueCount < 2 ||
      valuesOverflow
    ) {
      throw new Error(
        `Revenue report failed mobile priority verification at ${viewport.width}x${viewport.height} ` +
        `(resultsY=${resultsBox?.y ?? "missing"}, filtersY=${filtersBox?.y ?? "missing"}, ` +
        `visibleValues=${visibleValueCount}, overflow=${valuesOverflow}).`,
      );
    }
  }
}

async function verifyRequestedMobileLayouts(page: Page, name: CaptureName) {
  if (name !== "dashboard" && name !== "reports") return;
  for (const viewport of mobileVerificationViewports) {
    await page.setViewportSize(viewport);
    await page.reload({ waitUntil: "networkidle" });
    await preparePage(page);
    await page.waitForTimeout(100);
    await verifyMobileComposition(page, name, viewport);
    process.stdout.write(`Verified ${name} mobile composition at ${viewport.width}x${viewport.height}.\n`);
  }
}

async function login(page: Page) {
  const publishableKey = process.env.LOCAL_SUPABASE_PUBLISHABLE_KEY;
  if (!publishableKey) throw new Error("LOCAL_SUPABASE_PUBLISHABLE_KEY is required.");

  const authCookies: { name: string; value: string }[] = [];
  const auth = createServerClient<Database>(
    process.env.LOCAL_SUPABASE_URL ?? "http://127.0.0.1:54321",
    publishableKey,
    {
      cookies: {
        getAll: () => [],
        setAll: (cookies) => {
          authCookies.push(...cookies.map(({ name, value }) => ({ name, value })));
        },
      },
    },
  );
  const { error } = await auth.auth.signInWithPassword({
    email: MARKETING_DEMO.adminEmail,
    password: MARKETING_DEMO.password,
  });
  if (error) throw new Error(`Authenticate marketing demo: ${error.message}`);

  await page.context().addCookies(
    authCookies.map(({ name, value }) => ({ name, value, url: baseUrl })),
  );
  await page.goto(`${baseUrl}/dashboard`, { waitUntil: "networkidle" });
}

async function preparePage(page: Page) {
  await page.addStyleTag({
    content: `
      nextjs-portal, [data-sonner-toaster] { display: none !important; }
      *, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }
    `,
  });
  await page.evaluate(() => {
    localStorage.setItem("clinicflow-sidebar-collapsed", "false");
    document.documentElement.classList.remove("dark");
    document.documentElement.style.colorScheme = "light";
  });
}

async function captureViewport(
  page: Page,
  name: string,
  viewport: { width: number; height: number },
  suffix: CaptureVariant,
) {
  await page.setViewportSize(viewport);
  await page.reload({ waitUntil: "networkidle" });
  await preparePage(page);
  await page.waitForTimeout(150);
  const avatarRegions = await collectVisibleAvatarRegions(page, name, viewport);
  const rawPath = resolve(rawDir, `${name}-${suffix}.png`);
  const outputPath = resolve(
    outputDir,
    `${name}-${assetLocale ? `${assetLocale}-` : ""}${suffix}.avif`,
  );
  await page.screenshot({ path: rawPath, fullPage: false, animations: "disabled" });
  await sharp(rawPath)
    .avif({ quality: suffix === "desktop" ? 62 : 58, effort: 6 })
    .toFile(outputPath);
  await verifyAvatarRegions(outputPath, `${name}-${suffix}.avif`, avatarRegions);
  const file = await stat(outputPath);
  if (file.size > 300_000) {
    throw new Error(`${name}-${suffix}.avif exceeds the 300 KB asset budget (${file.size} bytes).`);
  }
}

async function runCommand(command: string, args: string[], env = process.env) {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: process.cwd(), env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code ?? "no code"}.`));
    });
  });
}

async function startProductionServer() {
  const localPublicKey = process.env.LOCAL_SUPABASE_PUBLISHABLE_KEY;
  const localSecretKey = process.env.LOCAL_SUPABASE_SECRET_KEY;
  if (!localPublicKey || !localSecretKey) {
    throw new Error("LOCAL_SUPABASE_PUBLISHABLE_KEY and LOCAL_SUPABASE_SECRET_KEY are required.");
  }
  const localEnvironment = {
    ...process.env,
    NEXT_PUBLIC_SUPABASE_URL: process.env.LOCAL_SUPABASE_URL ?? "http://127.0.0.1:54321",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: localPublicKey,
    SUPABASE_SERVICE_ROLE_KEY: localSecretKey,
    UPSTASH_REDIS_REST_URL: "http://127.0.0.1:3011",
    UPSTASH_REDIS_REST_TOKEN: "marketing-capture-local-only",
  };
  if (process.env.SKIP_MARKETING_BUILD !== "1") {
    await runCommand("pnpm", ["build"], localEnvironment);
  }
  const child = spawn(
    process.execPath,
    ["node_modules/next/dist/bin/next", "start", "-p", "3105"],
    {
      cwd: process.cwd(),
      env: localEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout?.on("data", (chunk) => process.stdout.write(chunk));
  child.stderr?.on("data", (chunk) => process.stderr.write(chunk));

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Production server exited with ${child.exitCode}.`);
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return child;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  child.kill("SIGTERM");
  throw new Error("Timed out waiting for the local production server.");
}

async function stopProductionServer(child: ChildProcess | null) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolvePromise) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolvePromise();
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolvePromise();
    });
  });
}

async function main() {
  const parsedBase = new URL(baseUrl);
  if (parsedBase.hostname !== "127.0.0.1" && parsedBase.hostname !== "localhost") {
    throw new Error(`Refusing to capture against a non-local app (${parsedBase.hostname}).`);
  }

  const requestedNames = selectRequestedValues(
    process.env.MARKETING_CAPTURE_NAMES,
    captures.map((capture) => capture.name),
    "MARKETING_CAPTURE_NAMES",
  );
  const requestedVariants = selectRequestedValues(
    process.env.MARKETING_CAPTURE_VARIANTS,
    captureVariants,
    "MARKETING_CAPTURE_VARIANTS",
  );
  const selectedCaptures = captures.filter((capture) => requestedNames.includes(capture.name));

  if (process.env.SKIP_MARKETING_SEED !== "1") {
    await seedMarketingDemo(demoMarket);
  }
  const server = externalBaseUrl ? null : await startProductionServer();
  await mkdir(outputDir, { recursive: true });
  await rm(rawDir, { recursive: true, force: true });
  await mkdir(rawDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
    colorScheme: "light",
    reducedMotion: "reduce",
    // Local Supabase Storage runs on HTTP; production CSP correctly permits only HTTPS remotes.
    // Bypass CSP only inside this local-only capture browser so seeded demo portraits can render.
    bypassCSP: true,
  });
  const page = await context.newPage();

  try {
    await login(page);
    for (const capture of selectedCaptures) {
      await page.goto(`${baseUrl}${capture.path}`, { waitUntil: "networkidle" });
      await preparePage(page);
      if (requestedVariants.includes("mobile")) {
        await verifyRequestedMobileLayouts(page, capture.name);
      }
      if (requestedVariants.includes("desktop")) {
        await captureViewport(page, capture.name, { width: 1440, height: 960 }, "desktop");
      }
      if (requestedVariants.includes("mobile")) {
        await captureViewport(page, capture.name, { width: 390, height: 844 }, "mobile");
      }
    }
  } finally {
    await browser.close();
    await rm(rawDir, { recursive: true, force: true });
    await stopProductionServer(server);
  }

  process.stdout.write(
    `Captured ${selectedCaptures.length * requestedVariants.length} fictional demo screenshot(s) in public/marketing.\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
