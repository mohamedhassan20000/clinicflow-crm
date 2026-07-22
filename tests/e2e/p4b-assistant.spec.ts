import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import type { Database } from "@/types/database";

const localUrl = process.env.LOCAL_SUPABASE_URL ?? "http://127.0.0.1:54321";
const secretKey = process.env.LOCAL_SUPABASE_SECRET_KEY;
if (!secretKey) throw new Error("LOCAL_SUPABASE_SECRET_KEY is required for P4B E2E.");

const service = createClient<Database>(localUrl, secretKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const suffix = `p4b-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const password = "P4bAssistant12345!";
const email = `${suffix}@example.com`;
const managerEmail = `${suffix}-manager@example.com`;
const ids = {
  clinic: randomUUID(),
  doctor: "",
  manager: "",
  patient: randomUUID(),
};

async function must<T>(result: PromiseLike<{ data: T | null; error: { message: string } | null }>) {
  const { data, error } = await result;
  if (error) throw new Error(error.message);
  return data;
}

async function cleanup() {
  await service.from("agent_messages").delete().eq("clinic_id", ids.clinic);
  await service.from("agent_conversations").delete().eq("clinic_id", ids.clinic);
  await service.from("patients").delete().eq("clinic_id", ids.clinic);
  await service.from("subscriptions").delete().eq("clinic_id", ids.clinic);
  await service.from("profiles").delete().eq("clinic_id", ids.clinic);
  await service.from("clinics").delete().eq("id", ids.clinic);
  if (ids.doctor) await service.auth.admin.deleteUser(ids.doctor);
  if (ids.manager) await service.auth.admin.deleteUser(ids.manager);
}

async function login(page: Page, accountEmail = email) {
  await page.goto("/login");
  await page.locator('input[type="email"]').fill(accountEmail);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole("button", { name: /sign in|تسجيل الدخول/i }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 10_000 });
}

async function setAccountLocale(page: Page, locale: "en" | "ar") {
  await page.goto("/preferences");
  await page.getByTestId("language-switcher-account").click();
  await page
    .getByRole("option", { name: locale === "ar" ? "العربية" : "English" })
    .click();
  await expect(page.locator("html")).toHaveAttribute("lang", locale);
  await expect(page.locator("html")).toHaveAttribute(
    "dir",
    locale === "ar" ? "rtl" : "ltr",
  );
}

async function assertCapabilityPanelA11y(
  page: Page,
  locale: "en" | "ar",
) {
  const labels = locale === "ar"
    ? { toggle: "ماذا يمكنني أن أطلب؟", close: "إغلاق" }
    : { toggle: "What can I ask?", close: "Close" };

  await expect(page.locator("html")).toHaveAttribute("lang", locale);
  await expect(page.locator("html")).toHaveAttribute(
    "dir",
    locale === "ar" ? "rtl" : "ltr",
  );
  const capabilityToggle = page.getByRole("button", { name: labels.toggle });
  await capabilityToggle.click();
  await expect(capabilityToggle).toHaveAttribute("aria-expanded", "true");
  const capabilityPanelId = await capabilityToggle.getAttribute("aria-controls");
  expect(capabilityPanelId).toBeTruthy();
  await expect(page.locator(`[id="${capabilityPanelId}"]`)).toBeVisible();
  const capabilityA11y = await new AxeBuilder({ page })
    .include(`[id="${capabilityPanelId}"]`)
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(
    capabilityA11y.violations.filter(
      ({ impact }) => impact === "critical" || impact === "serious",
    ),
  ).toEqual([]);
  await page.getByRole("button", { name: labels.close }).click();
  await expect(capabilityToggle).toBeFocused();
}

function mockAssistantStream(text: string) {
  return [
    { type: "start", messageId: "assistant-e2e" },
    { type: "start-step" },
    { type: "text-start", id: "text-1" },
    { type: "text-delta", id: "text-1", delta: text },
    { type: "text-end", id: "text-1" },
    { type: "finish-step" },
    { type: "finish", finishReason: "stop" },
  ].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
}

test.beforeAll(async () => {
  await cleanup();
  const created = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error || !created.data.user) throw new Error(created.error?.message ?? "User setup failed");
  ids.doctor = created.data.user.id;
  const manager = await service.auth.admin.createUser({
    email: managerEmail,
    password,
    email_confirm: true,
  });
  if (manager.error || !manager.data.user) {
    throw new Error(manager.error?.message ?? "Manager setup failed");
  }
  ids.manager = manager.data.user.id;
  await must(service.from("clinics").insert({
    id: ids.clinic,
    name: `P4B E2E Clinic ${suffix}`,
    onboarding_completed_at: new Date().toISOString(),
  }));
  const plan = await service.from("plans").select("id").eq("slug", "pro_ai").single();
  if (plan.error) throw new Error(plan.error.message);
  await must(service.from("subscriptions").insert({
    clinic_id: ids.clinic,
    plan_id: plan.data.id,
    status: "trialing",
    trial_ends_at: new Date(Date.now() + 14 * 86_400_000).toISOString(),
  }));
  await must(service.from("profiles").insert({
    id: ids.doctor,
    clinic_id: ids.clinic,
    full_name: "P4B Test Doctor",
    role: "doctor",
    must_change_password: false,
  }));
  await must(service.from("profiles").insert({
    id: ids.manager,
    clinic_id: ids.clinic,
    full_name: "P4.8 Test Manager",
    role: "manager",
    must_change_password: false,
  }));
  await must(service.from("patients").insert({
    id: ids.patient,
    clinic_id: ids.clinic,
    full_name: "P4B Test Patient",
    national_id: `${Date.now()}44`,
    date_of_birth: "1992-02-02",
    phone: "+96551112222",
    email: `${suffix}-patient@example.com`,
    file_number: `${suffix}-P`,
    created_by: ids.doctor,
    assigned_doctor_id: ids.doctor,
  }));
});

test.afterAll(cleanup);

test("staff chat streams a mocked response and patient profile opens contextual assistant", async ({ page }) => {
  await page.route("**/api/agent/chat", async (route) => {
    await route.fulfill({
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "x-vercel-ai-ui-message-stream": "v1",
      },
      body: mockAssistantStream("Your authorized schedule has been reviewed."),
    });
  });

  await login(page);
  await page.goto("/assistant");
  await expect(page.getByRole("heading", { level: 1, name: "Clinical assistant" })).toBeVisible();
  await assertCapabilityPanelA11y(page, "en");
  await page.getByRole("textbox", { name: "Message the clinical assistant" }).fill("List my appointments today");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText("Your authorized schedule has been reviewed.")).toBeVisible();

  await page.goto(`/patients/${ids.patient}`);
  await page.getByRole("button", { name: "Ask assistant" }).click();
  await expect(page.getByText("Clinical assistant · P4B Test Patient")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message the clinical assistant" })).toHaveAttribute(
    "placeholder",
    "Ask about this patient's record…",
  );

  await test.step("Arabic RTL capability panel passes the same Axe checks", async () => {
    await setAccountLocale(page, "ar");
    await page.goto("/assistant");
    await expect(
      page.getByRole("heading", { level: 1, name: "المساعد السريري" }),
    ).toBeVisible();
    await assertCapabilityPanelA11y(page, "ar");
  });
});

test("P4.8 top-level and nested launchers preserve focus and RTL placement", async ({ page }) => {
  await login(page, managerEmail);

  await test.step("English top-level dashboard launcher", async () => {
    await page.goto("/dashboard");
    const launcher = page.getByRole("button", { name: "Ask assistant" });
    await launcher.click();
    await expect(page.getByRole("heading", { name: "Dashboard assistant" })).toBeVisible();
    await page.getByRole("button", { name: "Close" }).click();
    await expect(launcher).toBeFocused();
  });

  await test.step("Arabic nested recurring-hours launcher", async () => {
    await setAccountLocale(page, "ar");
    await page.goto("/settings/staff");
    await page.getByText("P4B Test Doctor", { exact: true }).click();
    await page.getByRole("tab", { name: "جدول" }).click();
    const nestedLauncher = page.getByRole("button", { name: "اسأل المساعد" });
    await expect(nestedLauncher).toBeVisible();
    await nestedLauncher.click();
    await expect(page.getByRole("heading", { name: "مساعد جدول الطبيب" })).toBeVisible();

    const dialogs = page.getByRole("dialog");
    const assistantDialog = dialogs.last();
    const box = await assistantDialog.boundingBox();
    if (!box) throw new Error("nested assistant dialog has no layout box");
    expect(box.x, "inline-end sheet should hug the left edge in RTL").toBeLessThan(8);

    const a11y = await new AxeBuilder({ page })
      .include('[data-slot="sheet-content"]')
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(
      a11y.violations.filter(
        ({ impact }) => impact === "critical" || impact === "serious",
      ),
    ).toEqual([]);

    await page.getByRole("button", { name: "إغلاق" }).last().click();
    await expect(nestedLauncher).toBeFocused();
  });
});
