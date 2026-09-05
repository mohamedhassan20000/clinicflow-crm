import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.PORT ?? 3000);
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${PORT}`;
const localSupabaseUrl =
  process.env.LOCAL_SUPABASE_URL ?? "http://127.0.0.1:54321";
const reuseExistingServer = process.env.PLAYWRIGHT_REUSE_EXISTING_SERVER === "1";
function requireLocalKey(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} must be set in .env.local for local E2E runs.`);
  return v;
}

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : [{
        command: "pnpm tsx tests/e2e/rate-limit-server.ts",
        url: "http://127.0.0.1:3011/health",
        reuseExistingServer,
        timeout: 30_000,
      }, {
        command: "pnpm build && pnpm start",
        env: {
          ...process.env,
          NEXT_PUBLIC_SUPABASE_URL: localSupabaseUrl,
          NEXT_PUBLIC_SUPABASE_ANON_KEY: requireLocalKey("LOCAL_SUPABASE_PUBLISHABLE_KEY"),
          SUPABASE_SERVICE_ROLE_KEY: requireLocalKey("LOCAL_SUPABASE_SECRET_KEY"),
          AI_ACTION_CONFIRMATION_HMAC_KEY:
            process.env.AI_ACTION_CONFIRMATION_HMAC_KEY ??
            Buffer.alloc(32, 9).toString("base64"),
          UPSTASH_REDIS_REST_URL: "http://127.0.0.1:3011",
          UPSTASH_REDIS_REST_TOKEN: "playwright-test-token",
          DIALOG360_API_BASE_URL: "http://127.0.0.1:3011",
          MESSAGING_CREDENTIALS_KEY: Buffer.alloc(32, 7).toString("base64"),
          // The messaging settings page derives each clinic's webhook callback
          // URL from this, so it must be set for the connection-method specs.
          NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL ?? baseURL,
        },
        url: baseURL,
        reuseExistingServer,
        timeout: 180_000,
      }],
});
