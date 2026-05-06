import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.PORT ?? 3000);
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${PORT}`;
const localSupabaseUrl =
  process.env.LOCAL_SUPABASE_URL ?? "http://127.0.0.1:54321";
const localSupabaseAnonKey =
  process.env.LOCAL_SUPABASE_PUBLISHABLE_KEY ??
  "sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH";
const localSupabaseServiceRoleKey =
  process.env.LOCAL_SUPABASE_SECRET_KEY ??
  "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";

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
    : {
        command: "pnpm build && pnpm start",
        env: {
          ...process.env,
          NEXT_PUBLIC_SUPABASE_URL: localSupabaseUrl,
          NEXT_PUBLIC_SUPABASE_ANON_KEY: localSupabaseAnonKey,
          SUPABASE_SERVICE_ROLE_KEY: localSupabaseServiceRoleKey,
        },
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 180_000,
      },
});
