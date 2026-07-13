import { mkdir, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { chromium, type Page } from "@playwright/test";
import sharp from "sharp";
import { MARKETING_DEMO, seedMarketingDemo } from "./seed-marketing-demo";

const externalBaseUrl = process.env.MARKETING_BASE_URL;
const baseUrl = externalBaseUrl ?? "http://127.0.0.1:3105";
const outputDir = resolve("public/marketing");
const rawDir = resolve(".tmp/marketing-screenshots");

const captures = [
  { name: "dashboard", path: "/dashboard" },
  { name: "schedule", path: "/appointments?view=week" },
  { name: "patients", path: "/patients" },
  { name: "patient-record", path: `/patients/${MARKETING_DEMO.patientIds[0]}` },
  { name: "reports", path: "/reports/revenue" },
] as const;

async function login(page: Page) {
  await page.goto(`${baseUrl}/login`, { waitUntil: "networkidle" });
  await page.getByLabel(/email/i).fill(MARKETING_DEMO.adminEmail);
  await page.locator('input[type="password"]').fill(MARKETING_DEMO.password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL(/\/dashboard/);
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
  suffix: "desktop" | "mobile",
) {
  await page.setViewportSize(viewport);
  await page.reload({ waitUntil: "networkidle" });
  await preparePage(page);
  await page.waitForTimeout(150);
  const rawPath = resolve(rawDir, `${name}-${suffix}.png`);
  const outputPath = resolve(outputDir, `${name}-${suffix}.avif`);
  await page.screenshot({ path: rawPath, fullPage: false, animations: "disabled" });
  await sharp(rawPath)
    .avif({ quality: suffix === "desktop" ? 62 : 58, effort: 6 })
    .toFile(outputPath);
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

  await seedMarketingDemo();
  const server = externalBaseUrl ? null : await startProductionServer();
  await mkdir(outputDir, { recursive: true });
  await rm(rawDir, { recursive: true, force: true });
  await mkdir(rawDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
    colorScheme: "light",
    reducedMotion: "reduce",
  });
  const page = await context.newPage();

  try {
    await login(page);
    for (const capture of captures) {
      await page.goto(`${baseUrl}${capture.path}`, { waitUntil: "networkidle" });
      await preparePage(page);
      await captureViewport(page, capture.name, { width: 1440, height: 960 }, "desktop");
      await captureViewport(page, capture.name, { width: 390, height: 844 }, "mobile");
    }
  } finally {
    await browser.close();
    await rm(rawDir, { recursive: true, force: true });
    await stopProductionServer(server);
  }

  process.stdout.write(
    `Captured ${captures.length * 2} fictional demo screenshots in public/marketing.\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
