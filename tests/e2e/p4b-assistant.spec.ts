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
const adminEmail = `${suffix}-admin@example.com`;
const ids = {
  clinic: randomUUID(),
  doctor: "",
  manager: "",
  admin: "",
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
  await service.from("ai_commercial_terms").delete().eq("clinic_id", ids.clinic);
  await service.from("subscriptions").delete().eq("clinic_id", ids.clinic);
  await service.from("profiles").delete().eq("clinic_id", ids.clinic);
  await service.from("clinics").delete().eq("id", ids.clinic);
  if (ids.doctor) await service.auth.admin.deleteUser(ids.doctor);
  if (ids.manager) await service.auth.admin.deleteUser(ids.manager);
  if (ids.admin) await service.auth.admin.deleteUser(ids.admin);
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

/**
 * Localized copy for the panel sections. Phase 7 (P7-01) gave the panel rendered
 * content beyond the capability items — a readable-records list and, for
 * administrative roles, the write surface with its risk vocabulary — so the Axe
 * sweep below now covers markup that did not exist when this spec was written.
 */
const PANEL_COPY = {
  en: {
    toggle: "What can I ask?",
    close: "Close",
    resources: "Records it can read",
    actions: "Changes it can make",
    actionsNote: "Nothing is saved until you confirm it on screen.",
    privileged: "Needs your password",
  },
  ar: {
    toggle: "ماذا يمكنني أن أطلب؟",
    close: "إغلاق",
    resources: "السجلات التي يمكنه قراءتها",
    actions: "التغييرات التي يمكنه إجراؤها",
    actionsNote: "لا يُحفظ أي تغيير قبل تأكيدك له على الشاشة.",
    privileged: "يتطلب كلمة المرور",
  },
} as const;

async function assertCapabilityPanelA11y(
  page: Page,
  locale: "en" | "ar",
  /**
   * Whether this account has an authorized write surface. Asserted in both
   * directions — an under-reporting panel is the failure P7-01 named.
   *
   * Since final review B-2 a doctor has one too: the action tools are mounted
   * for every role the action registry authorizes an action for, so a doctor
   * sees the clinical-authoring actions their own definitions allow. What a
   * doctor must *not* see is a privileged change, which is the second
   * parameter — that is the real boundary, and it is the one worth asserting in
   * the rendered UI.
   */
  expectActions = false,
  expectPrivileged = expectActions,
) {
  const labels = PANEL_COPY[locale];

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
  const panel = page.locator(`[id="${capabilityPanelId}"]`);
  await expect(panel).toBeVisible();

  // The generic read surface is present for every assistant-capable role.
  await expect(panel.getByText(labels.resources)).toBeVisible();

  if (expectActions) {
    await expect(panel.getByText(labels.actions)).toBeVisible();
    await expect(panel.getByText(labels.actionsNote)).toBeVisible();
  } else {
    await expect(panel.getByText(labels.actions)).toHaveCount(0);
  }

  if (expectPrivileged) {
    // A privileged change must be marked as one wherever it is listed; this is
    // the same vocabulary the confirmation card uses before re-authenticating.
    await expect(panel.getByText(labels.privileged).first()).toBeVisible();
  } else {
    // And a role with no privileged action must never see that badge — the
    // negative half of B-2, asserted on the rendered panel.
    await expect(panel.getByText(labels.privileged)).toHaveCount(0);
  }

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
  // Phase 7 (P7-01): the capability panel renders the write surface. Since
  // final review B-2 the doctor above has one too, so the distinguishing claim
  // the two accounts assert together is the *privileged* one — only an
  // administrative role sees a change that costs a re-authentication.
  const admin = await service.auth.admin.createUser({
    email: adminEmail,
    password,
    email_confirm: true,
  });
  if (admin.error || !admin.data.user) {
    throw new Error(admin.error?.message ?? "Admin setup failed");
  }
  ids.admin = admin.data.user.id;
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
  // Phase 0b: no accepted AI commercial terms means every `ai.*` feature
  // resolves false and the assistant surface renders its upgrade gate instead
  // of the chat. Seed acceptance so the assistant is actually reachable.
  await must(service.from("ai_commercial_terms").insert({
    clinic_id: ids.clinic,
    addon_budget_micros: 0,
    overage_mode: "hard_cap",
    overage_budget_micros: 0,
    change_reason: "pilot",
    updated_by: ids.doctor,
    accepted_at: new Date().toISOString(),
  }));
  await must(service.from("profiles").insert({
    id: ids.manager,
    clinic_id: ids.clinic,
    full_name: "P4.8 Test Manager",
    role: "manager",
    must_change_password: false,
  }));
  await must(service.from("profiles").insert({
    id: ids.admin,
    clinic_id: ids.clinic,
    full_name: "P7 Test Admin",
    role: "admin",
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
  // Doctor: an authorized write surface, but no privileged change (B-2).
  await assertCapabilityPanelA11y(page, "en", true, false);
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
    await assertCapabilityPanelA11y(page, "ar", true, false);
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

/**
 * Phase 7 · P7-01. The panel's whole purpose is to tell a user what they are
 * authorizing, and after five phases of write work it listed every read and said
 * nothing about the appointments the assistant can create, the documents it can
 * issue or the roles it can change. This asserts the rendered write surface for
 * an administrative role in both locales, with the same Axe budget the panel
 * already had — the sections are new markup, so the sweep is not redundant.
 */
test("P7 capability panel renders the authorized write surface in both locales", async ({
  page,
}) => {
  await login(page, adminEmail);

  await test.step("English", async () => {
    await setAccountLocale(page, "en");
    await page.goto("/assistant");
    await assertCapabilityPanelA11y(page, "en", true);
  });

  await test.step("Arabic RTL", async () => {
    await setAccountLocale(page, "ar");
    await page.goto("/assistant");
    await assertCapabilityPanelA11y(page, "ar", true);
  });
});
