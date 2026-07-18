import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { createCipheriv, randomBytes, randomUUID } from "node:crypto";
import type { Database } from "@/types/database";

const localUrl = process.env.LOCAL_SUPABASE_URL ?? "http://127.0.0.1:54321";
const secretKey = process.env.LOCAL_SUPABASE_SECRET_KEY;
if (!secretKey) throw new Error("LOCAL_SUPABASE_SECRET_KEY is required for P3C E2E.");

const service = createClient<Database>(localUrl, secretKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const suffix = `p3c-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const password = "P3cInbox12345!";
const email = `${suffix}@example.com`;
const ids = {
  clinic: randomUUID(),
  user: "",
  patient: randomUUID(),
};
const phoneNumberId = `${Date.now()}360`;
const sender = "+96551111111";
const webhookUsername = "clinicflow-p3c-e2e";
const webhookSecret = "p3c-e2e-webhook-secret";
const credentialsKey = Buffer.alloc(32, 7).toString("base64");

function encryptFixtureCredentials(credentials: Record<string, string>) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(credentialsKey, "base64"), iv);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(credentials), "utf8")),
    cipher.final(),
  ]);
  const envelope = Buffer.concat([
    Buffer.from([1]),
    iv,
    cipher.getAuthTag(),
    ciphertext,
  ]);
  return `\\x${envelope.toString("hex")}`;
}

async function must<T>(result: PromiseLike<{ data: T | null; error: { message: string } | null }>) {
  const { data, error } = await result;
  if (error) throw new Error(error.message);
  return data;
}

async function cleanup() {
  await service.from("inbound_messages").delete().eq("clinic_id", ids.clinic);
  await service.from("outbound_messages").delete().eq("clinic_id", ids.clinic);
  await service.from("conversations").delete().eq("clinic_id", ids.clinic);
  await service.from("clinic_channels").delete().eq("clinic_id", ids.clinic);
  await service.from("patients").delete().eq("clinic_id", ids.clinic);
  await service.from("subscriptions").delete().eq("clinic_id", ids.clinic);
  await service.from("profiles").delete().eq("clinic_id", ids.clinic);
  await service.from("clinics").delete().eq("id", ids.clinic);
  if (ids.user) await service.auth.admin.deleteUser(ids.user);
}

async function login(page: Page) {
  await page.goto("/login");
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole("button", { name: /sign in|تسجيل الدخول/i }).click();
  try {
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 10_000 });
  } catch (error) {
    throw new Error(`${String(error)}\nVisible page text:\n${await page.locator("body").innerText()}`);
  }
}

test.beforeAll(async () => {
  process.env.MESSAGING_CREDENTIALS_KEY = credentialsKey;
  await cleanup();
  const created = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (created.error || !created.data.user) throw new Error(created.error?.message ?? "User setup failed");
  ids.user = created.data.user.id;
  await must(service.from("clinics").insert({
    id: ids.clinic,
    name: `P3C E2E Clinic ${suffix}`,
    onboarding_completed_at: new Date().toISOString(),
  }));
  const plan = await service.from("plans").select("id").eq("slug", "pro").single();
  if (plan.error) throw new Error(plan.error.message);
  await must(service.from("subscriptions").insert({
    clinic_id: ids.clinic,
    plan_id: plan.data.id,
    status: "trialing",
    trial_ends_at: new Date(Date.now() + 14 * 86_400_000).toISOString(),
  }));
  await must(service.from("profiles").insert({
    id: ids.user,
    clinic_id: ids.clinic,
    full_name: "P3C Receptionist",
    role: "receptionist",
    must_change_password: false,
  }));
  await must(service.from("patients").insert({
    id: ids.patient,
    clinic_id: ids.clinic,
    full_name: "P3C Patient",
    national_id: `${Date.now()}P3C`,
    date_of_birth: "1990-01-01",
    phone: sender,
    email: `${suffix}-patient@example.com`,
    file_number: `${suffix}-P`,
    created_by: ids.user,
  }));
  await must(service.from("clinic_channels").insert({
    clinic_id: ids.clinic,
    channel: "whatsapp",
    provider: "dialog360",
    sender_identity: phoneNumberId,
    status: "active",
    connected_at: new Date().toISOString(),
    credentials_encrypted: encryptFixtureCredentials({
      apiKey: "p3c-e2e-dialog360-api-key",
      phoneNumberId,
      displayPhoneNumber: "+96550000000",
      webhookUsername,
      webhookSecret,
    }),
  }));
});

test.afterAll(async () => {
  await cleanup();
  delete process.env.MESSAGING_CREDENTIALS_KEY;
});

test("mocked webhook appears in real time and staff reply reaches delivered lifecycle", async ({ page }) => {
  test.setTimeout(30_000);
  await login(page);
  await page.goto("/inbox");
  await expect(page.getByRole("heading", { level: 1, name: "Inbox" })).toBeVisible();
  await expect(page.locator("[data-realtime-status]")).toHaveAttribute(
    "data-realtime-status",
    "subscribed",
  );

  const authorization = `Basic ${Buffer.from(`${webhookUsername}:${webhookSecret}`).toString("base64")}`;
  const inboundResponse = await page.request.post("/api/webhooks/whatsapp", {
    headers: { authorization },
    data: {
      object: "whatsapp_business_account",
      entry: [{
        id: "waba-p3c-e2e",
        changes: [{
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            metadata: { phone_number_id: phoneNumberId },
            contacts: [{ wa_id: sender.slice(1), profile: { name: "P3C Patient" } }],
            messages: [{
              from: sender.slice(1),
              id: `wamid.${suffix}.inbound`,
              timestamp: String(Math.floor(Date.now() / 1000)),
              type: "text",
              text: { body: "Please confirm my appointment" },
            }],
          },
        }],
      }],
    },
  });
  expect(inboundResponse.ok()).toBe(true);
  await expect(inboundResponse.json()).resolves.toMatchObject({ ok: true, inbound: 1 });
  await expect(page.getByText("Please confirm my appointment").last()).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText("P3C Patient").first()).toBeVisible();

  await page.getByRole("textbox", { name: "Reply message" }).fill("Your appointment is confirmed.");
  await page.getByRole("button", { name: "Send reply" }).click();
  await expect(page.getByText("Reply sent.")).toBeVisible();

  const outbound = await expect.poll(async () => {
    const result = await service
      .from("outbound_messages")
      .select("id, status, provider_message_id, related_id")
      .eq("clinic_id", ids.clinic)
      .eq("provider_message_id", "wamid.p3c-e2e-reply")
      .maybeSingle();
    return result.data;
  }).not.toBeNull();
  void outbound;

  const statusResponse = await page.request.post("/api/webhooks/whatsapp", {
    headers: { authorization },
    data: {
      object: "whatsapp_business_account",
      entry: [{
        id: "waba-p3c-e2e",
        changes: [{
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            metadata: { phone_number_id: phoneNumberId },
            statuses: [{
              id: "wamid.p3c-e2e-reply",
              status: "delivered",
              timestamp: String(Math.floor(Date.now() / 1000)),
              recipient_id: sender.slice(1),
            }],
          },
        }],
      }],
    },
  });
  expect(statusResponse.ok()).toBe(true);
  await expect.poll(async () => {
    const result = await service
      .from("outbound_messages")
      .select("status")
      .eq("provider_message_id", "wamid.p3c-e2e-reply")
      .single();
    return result.data?.status;
  }).toBe("delivered");
});
