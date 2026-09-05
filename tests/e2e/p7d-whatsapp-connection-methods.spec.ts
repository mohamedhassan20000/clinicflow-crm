import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { createCipheriv, createHmac, randomBytes, randomUUID } from "node:crypto";
import type { Database } from "@/types/database";

/**
 * P7D/P7E E2E — the two per-clinic WhatsApp connection methods on
 * /settings/messaging, and the tenant boundary between them.
 *
 * What this proves end-to-end:
 *   * both methods — "Connect with QR" and "Connect with Meta API" — are visible
 *     and distinguishable to a clinic admin,
 *   * the QR method involves no Facebook login and no Meta Embedded Signup: the
 *     page loads no facebook.com script and exposes no signup configuration,
 *   * the Meta API card exposes *this* clinic's webhook callback URL and verify
 *     token, and never a platform secret,
 *   * a channel connected by one method is reported as such by that card and
 *     deferred to by the other — the clinic always has exactly one number,
 *   * clinic B never sees clinic A's connected number or pairing,
 *   * a manager sees the connection read-only.
 *
 * The WhatsApp pairing socket itself belongs to services/whatsapp-worker and is
 * not exercised here: a real scan needs a real phone. Everything ClinicFlow owns
 * around it is covered — here, and at the unit boundary.
 */

const localUrl = process.env.LOCAL_SUPABASE_URL ?? "http://127.0.0.1:54321";
const secretKey = process.env.LOCAL_SUPABASE_SECRET_KEY;
if (!secretKey) throw new Error("LOCAL_SUPABASE_SECRET_KEY is required for P7D E2E.");

const service = createClient<Database>(localUrl, secretKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const suffix = `p7d-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const password = "P7dConnect12345!";
const credentialsKey = Buffer.alloc(32, 7).toString("base64");

type Tenant = {
  clinicId: string;
  adminId: string;
  adminEmail: string;
  managerId: string;
  managerEmail: string;
  phoneNumberId: string;
  displayPhoneNumber: string;
  /** The E.164 number a linked-device pairing would claim. */
  pairedNumber: string;
};

const clinicA: Tenant = {
  clinicId: randomUUID(),
  adminId: "",
  adminEmail: `${suffix}-a-admin@example.com`,
  managerId: "",
  managerEmail: `${suffix}-a-manager@example.com`,
  phoneNumberId: `${Date.now()}771`,
  displayPhoneNumber: "+20 100 111 1111",
  pairedNumber: "+201001111111",
};
const clinicB: Tenant = {
  clinicId: randomUUID(),
  adminId: "",
  adminEmail: `${suffix}-b-admin@example.com`,
  managerId: "",
  managerEmail: `${suffix}-b-manager@example.com`,
  phoneNumberId: `${Date.now()}772`,
  displayPhoneNumber: "+20 100 222 2222",
  pairedNumber: "+201002222222",
};

/**
 * Mirrors lib/messaging/webhook-verify-token.ts. Recomputing it here — rather
 * than importing the server-only module — proves the page really shows the
 * token derived for *this* clinic, not a shared or placeholder value.
 */
function verifyTokenFor(clinicId: string) {
  return createHmac("sha256", Buffer.from(credentialsKey, "base64"))
    .update(`clinicflow:wa-webhook-verify:v1:${clinicId}`, "utf8")
    .digest("base64url")
    .slice(0, 32);
}

/** Mirrors lib/messaging/crypto.ts so fixtures are readable by the app. */
function encryptFixtureCredentials(credentials: Record<string, string>) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(credentialsKey, "base64"), iv);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(credentials), "utf8")),
    cipher.final(),
  ]);
  return `\\x${Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), ciphertext]).toString("hex")}`;
}

async function must<T>(result: PromiseLike<{ data: T | null; error: { message: string } | null }>) {
  const { data, error } = await result;
  if (error) throw new Error(error.message);
  return data;
}

async function cleanupTenant(tenant: Tenant) {
  await service.from("clinic_channels").delete().eq("clinic_id", tenant.clinicId);
  await service
    .from("whatsapp_linked_device_sessions")
    .delete()
    .eq("clinic_id", tenant.clinicId);
  await service.from("whatsapp_linked_device_auth").delete().eq("clinic_id", tenant.clinicId);
  await service.from("subscriptions").delete().eq("clinic_id", tenant.clinicId);
  await service.from("profiles").delete().eq("clinic_id", tenant.clinicId);
  await service.from("clinics").delete().eq("id", tenant.clinicId);
  for (const id of [tenant.adminId, tenant.managerId]) {
    if (id) await service.auth.admin.deleteUser(id);
  }
}

async function clearChannels(tenant: Tenant) {
  await service.from("clinic_channels").delete().eq("clinic_id", tenant.clinicId);
  await service
    .from("whatsapp_linked_device_sessions")
    .delete()
    .eq("clinic_id", tenant.clinicId);
}

async function createUser(email: string) {
  const created = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (created.error || !created.data.user) {
    throw new Error(created.error?.message ?? "User setup failed");
  }
  return created.data.user.id;
}

async function seedTenant(tenant: Tenant, name: string) {
  tenant.adminId = await createUser(tenant.adminEmail);
  tenant.managerId = await createUser(tenant.managerEmail);
  await must(
    service.from("clinics").insert({
      id: tenant.clinicId,
      name,
      onboarding_completed_at: new Date().toISOString(),
    }),
  );
  const plan = await service.from("plans").select("id").eq("slug", "pro").single();
  if (plan.error) throw new Error(plan.error.message);
  await must(
    service.from("subscriptions").insert({
      clinic_id: tenant.clinicId,
      plan_id: plan.data.id,
      status: "trialing",
      trial_ends_at: new Date(Date.now() + 14 * 86_400_000).toISOString(),
    }),
  );
  await must(
    service.from("profiles").insert([
      {
        id: tenant.adminId,
        clinic_id: tenant.clinicId,
        full_name: `${name} Admin`,
        role: "admin",
        must_change_password: false,
      },
      {
        id: tenant.managerId,
        clinic_id: tenant.clinicId,
        full_name: `${name} Manager`,
        role: "manager",
        must_change_password: false,
      },
    ]),
  );
}

/** Seeds a connected Meta Cloud API channel, exactly as that action would. */
async function seedMetaApiChannel(tenant: Tenant) {
  await must(
    service.from("clinic_channels").insert({
      clinic_id: tenant.clinicId,
      channel: "whatsapp",
      provider: "meta",
      sender_identity: tenant.phoneNumberId,
      provider_account_id: `${tenant.phoneNumberId}-waba`,
      onboarding_flow: "manual_api",
      status: "active",
      connection_state: "connected",
      webhook_subscribed: true,
      connected_at: new Date().toISOString(),
      credentials_encrypted: encryptFixtureCredentials({
        accessToken: `${tenant.clinicId}-clinic-owned-token`,
        phoneNumberId: tenant.phoneNumberId,
        wabaId: `${tenant.phoneNumberId}-waba`,
        appId: `${tenant.phoneNumberId}-app`,
        appSecret: "a".repeat(32),
        displayPhoneNumber: tenant.displayPhoneNumber,
      }),
    }),
  );
}

/**
 * Seeds a connected linked-device pairing, exactly as the worker would after a
 * successful scan: the channel row that claims the number, plus the session row
 * the settings page reads. No device identity is seeded — that is the worker's
 * and is never needed to render this page.
 */
async function seedLinkedDeviceChannel(tenant: Tenant) {
  const now = new Date().toISOString();
  await must(
    service.from("clinic_channels").insert({
      clinic_id: tenant.clinicId,
      channel: "whatsapp",
      provider: "linked_device",
      sender_identity: tenant.pairedNumber,
      status: "active",
      connection_state: "connected",
      connected_at: now,
      credentials_encrypted: encryptFixtureCredentials({
        clinicId: tenant.clinicId,
        displayPhoneNumber: tenant.pairedNumber,
      }),
    }),
  );
  await must(
    service.from("whatsapp_linked_device_sessions").insert({
      clinic_id: tenant.clinicId,
      status: "connected",
      desired_state: "online",
      phone_number: tenant.pairedNumber,
      connected_at: now,
      worker_id: "e2e",
      last_heartbeat_at: now,
    }),
  );
}

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole("button", { name: /sign in|تسجيل الدخول/i }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 15_000 });
}

test.beforeAll(async () => {
  process.env.MESSAGING_CREDENTIALS_KEY = credentialsKey;
  await cleanupTenant(clinicA);
  await cleanupTenant(clinicB);
  await seedTenant(clinicA, `P7D Clinic A ${suffix}`);
  await seedTenant(clinicB, `P7D Clinic B ${suffix}`);
});

test.afterAll(async () => {
  await cleanupTenant(clinicA);
  await cleanupTenant(clinicB);
  delete process.env.MESSAGING_CREDENTIALS_KEY;
});

test.describe.configure({ mode: "serial" });

/** The two primary method cards, addressed independently of page order. */
const qrCard = (page: Page) => page.getByTestId("whatsapp-qr-card");
const metaApiCard = (page: Page) => page.getByTestId("whatsapp-meta-api-card");

test("offers both connection methods, not connected, with clinic-scoped webhook details", async ({
  page,
}) => {
  test.setTimeout(45_000);
  await login(page, clinicA.adminEmail);
  await page.goto("/settings/messaging");

  // Card titles render as styled text, not headings, in this design system.
  await expect(qrCard(page).getByText("Connect with QR")).toBeVisible();
  await expect(metaApiCard(page).getByText("Connect with Meta API")).toBeVisible();

  // Both start in the honest "Not connected" state.
  await expect(qrCard(page).getByText("Not connected")).toBeVisible();
  await expect(metaApiCard(page).getByText("Not connected")).toBeVisible();

  // The QR method is WhatsApp's own Linked Devices flow, and says so in the
  // clinic's words.
  await expect(qrCard(page).getByText("Settings → Linked Devices")).toBeVisible();

  // The Meta API method shows this clinic's own callback URL and verify token…
  await expect(metaApiCard(page).getByText(`clinic=${clinicA.clinicId}`)).toBeVisible();
  await expect(
    metaApiCard(page).getByText(verifyTokenFor(clinicA.clinicId), { exact: true }),
  ).toBeVisible();

  // …and never a platform secret or internal identifier.
  const body = await page.locator("body").innerText();
  for (const secret of [
    process.env.META_APP_SECRET,
    process.env.META_SYSTEM_USER_ACCESS_TOKEN,
    process.env.META_BUSINESS_ID,
    process.env.META_WEBHOOK_VERIFY_TOKEN,
  ]) {
    if (secret) expect(body).not.toContain(secret);
  }
});

test("the QR method never involves Facebook or Meta Embedded Signup", async ({ page }) => {
  test.setTimeout(45_000);
  const facebookRequests: string[] = [];
  page.on("request", (request) => {
    const host = new URL(request.url()).hostname;
    if (host.endsWith("facebook.com") || host.endsWith("facebook.net")) {
      facebookRequests.push(request.url());
    }
  });

  await login(page, clinicA.adminEmail);
  await page.goto("/settings/messaging");
  await expect(qrCard(page).getByRole("button", { name: "Generate QR code" })).toBeVisible();

  // Nothing on this page reaches Meta's SDK, and no signup configuration is
  // shipped to the browser for it to use.
  const html = await page.content();
  expect(html).not.toContain("connect.facebook.net");
  expect(html).not.toContain("WA_EMBEDDED_SIGNUP");
  expect(html).not.toContain("whatsapp_business_app_onboarding");
  expect(await page.evaluate(() => "FB" in window)).toBe(false);
  expect(facebookRequests).toEqual([]);
});

test("a channel connected by the Meta API method is owned there and deferred to by the QR card", async ({
  page,
}) => {
  test.setTimeout(45_000);
  await seedMetaApiChannel(clinicA);
  await login(page, clinicA.adminEmail);
  await page.goto("/settings/messaging");

  // The Meta API card owns it: connected, with the number and a Disconnect.
  await expect(metaApiCard(page).getByText("Connected", { exact: true })).toBeVisible();
  await expect(metaApiCard(page).getByText(clinicA.displayPhoneNumber)).toBeVisible();
  await expect(metaApiCard(page).getByRole("button", { name: "Disconnect" })).toBeVisible();

  // The QR card steps aside rather than offering a competing Connect.
  await expect(
    qrCard(page).getByText(/connected using "Connect with Meta API"/i),
  ).toBeVisible();
  await expect(qrCard(page).getByRole("button", { name: /Generate QR code/i })).toHaveCount(0);

  await clearChannels(clinicA);
});

test("a channel connected by the QR method is owned there and deferred to by the Meta API card", async ({
  page,
}) => {
  test.setTimeout(45_000);
  await seedLinkedDeviceChannel(clinicA);
  await login(page, clinicA.adminEmail);
  await page.goto("/settings/messaging");

  // The QR card owns it, shows the paired number, and offers inbox + disconnect.
  await expect(qrCard(page).getByText("Connected", { exact: true })).toBeVisible();
  await expect(qrCard(page).getByText(clinicA.pairedNumber)).toBeVisible();
  await expect(qrCard(page).getByRole("link", { name: /Open inbox/i })).toBeVisible();
  await expect(qrCard(page).getByRole("button", { name: "Disconnect" })).toBeVisible();

  // The Meta API card withdraws its credential form while the QR method owns it.
  await expect(
    metaApiCard(page).getByText(/connected using "Connect with QR"/i),
  ).toBeVisible();
  await expect(metaApiCard(page).getByLabel("Meta App ID")).toHaveCount(0);
});

test("clinic B never sees clinic A's connected WhatsApp number", async ({ page }) => {
  test.setTimeout(45_000);
  // Clinic A is still paired from the previous test; clinic B is not.
  await login(page, clinicB.adminEmail);
  await page.goto("/settings/messaging");

  await expect(qrCard(page).getByText("Not connected")).toBeVisible();
  await expect(metaApiCard(page).getByText("Not connected")).toBeVisible();
  const body = await page.locator("body").innerText();
  expect(body).not.toContain(clinicA.pairedNumber);
  expect(body).not.toContain(clinicA.displayPhoneNumber);
  expect(body).not.toContain(clinicA.phoneNumberId);
  expect(body).not.toContain(clinicA.clinicId);
  // Clinic B's own webhook details are what it is shown.
  await expect(metaApiCard(page).getByText(`clinic=${clinicB.clinicId}`)).toBeVisible();
});

test("a manager sees the connection read-only in both methods", async ({ page }) => {
  test.setTimeout(45_000);
  await login(page, clinicA.managerEmail);
  await page.goto("/settings/messaging");

  // The state is visible, but nothing that changes it is offered.
  await expect(qrCard(page).getByText(clinicA.pairedNumber)).toBeVisible();
  await expect(page.getByRole("button", { name: "Disconnect" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Generate QR code" })).toHaveCount(0);
  await expect(qrCard(page).getByText("managerConnectionReadOnly")).toHaveCount(0);
  await expect(metaApiCard(page).getByLabel("Meta App ID")).toHaveCount(0);
});
