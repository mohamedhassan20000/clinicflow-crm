import { expect, test, type Locator, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import type { Database } from "@/types/database";

/**
 * Post-plan product completion, end to end.
 *
 * Changes 2 and 3 are user-visible claims about a browser flow, so they are
 * asserted in a browser: a "New chat" no longer loses the previous conversation,
 * an earlier conversation reopens with its persisted transcript, and the
 * contextual "Ask Assistant" sheet offers the same history rather than a
 * shortcut-only chat.
 *
 * Per project convention, run on PORT=3100. Assistant specs are not parallel-safe
 * locally — use `--workers=1`.
 */

const localUrl = process.env.LOCAL_SUPABASE_URL ?? "http://127.0.0.1:54321";
const secretKey = process.env.LOCAL_SUPABASE_SECRET_KEY;
if (!secretKey) {
  throw new Error("LOCAL_SUPABASE_SECRET_KEY is required for the history E2E.");
}

const service = createClient<Database>(localUrl, secretKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const suffix = `history-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const password = "HistoryAssistant12345!";
const adminEmail = `${suffix}-admin@example.com`;
const ids = {
  clinic: randomUUID(),
  admin: "",
  patient: randomUUID(),
  earlier: randomUUID(),
  older: randomUUID(),
};

const EARLIER_TITLE = "Which patients have O+ blood?";
const EARLIER_ANSWER = "Three patients in this clinic are O+.";
const OLDER_TITLE = "How many appointments are pending?";

async function must<T>(
  result: PromiseLike<{ data: T | null; error: { message: string } | null }>,
) {
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
  if (ids.admin) await service.auth.admin.deleteUser(ids.admin);
}

/**
 * Opens the history panel and returns it, scoped by the toggle's own
 * `aria-controls`. The panel's heading and its scroll container both expose the
 * same accessible name, so a role+name lookup is ambiguous by construction —
 * addressing it through the id the toggle points at is both unambiguous and the
 * thing a screen-reader user actually follows.
 */
async function openHistoryPanel(page: Page, scope: Locator, toggleName: string) {
  const toggle = scope.getByRole("button", { name: toggleName });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const panelId = await toggle.getAttribute("aria-controls");
  expect(panelId).toBeTruthy();
  return { toggle, panelId: panelId!, panel: page.locator(`[id="${panelId}"]`) };
}

function conversationEntry(panel: Locator, title: string) {
  return panel.getByRole("button", {
    name: new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  });
}

async function login(page: Page) {
  await page.goto("/login");
  await page.locator('input[type="email"]').fill(adminEmail);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole("button", { name: /sign in|تسجيل الدخول/i }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 });
}

test.beforeAll(async () => {
  await cleanup();
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
    name: `History E2E Clinic ${suffix}`,
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
    id: ids.admin,
    clinic_id: ids.clinic,
    full_name: "History E2E Admin",
    role: "admin",
    must_change_password: false,
  }));
  // Phase 0b: without accepted AI terms every `ai.*` key resolves false and the
  // surface renders its upgrade gate instead of the chat.
  await must(service.from("ai_commercial_terms").insert({
    clinic_id: ids.clinic,
    addon_budget_micros: 0,
    overage_mode: "hard_cap",
    overage_budget_micros: 0,
    change_reason: "pilot",
    updated_by: ids.admin,
    accepted_at: new Date().toISOString(),
  }));
  await must(service.from("patients").insert({
    id: ids.patient,
    clinic_id: ids.clinic,
    full_name: "History E2E Patient",
    national_id: `${Date.now()}77`,
    date_of_birth: "1991-03-03",
    phone: "+96551119999",
    email: `${suffix}-patient@example.com`,
    file_number: `${suffix}-P`,
    created_by: ids.admin,
    blood_type: "O+",
  }));

  // Two completed conversations, so the surface has real history to browse.
  // Before this pass only the newest of these was reachable at all.
  await must(service.from("agent_conversations").insert([
    {
      id: ids.older,
      clinic_id: ids.clinic,
      user_id: ids.admin,
      persona: "doctor",
      locale: "en",
      title: OLDER_TITLE,
      updated_at: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    },
    {
      id: ids.earlier,
      clinic_id: ids.clinic,
      user_id: ids.admin,
      persona: "doctor",
      locale: "en",
      title: EARLIER_TITLE,
      updated_at: new Date(Date.now() - 86_400_000).toISOString(),
    },
  ]));
  await must(service.from("agent_messages").insert([
    {
      conversation_id: ids.earlier,
      clinic_id: ids.clinic,
      role: "user",
      content: EARLIER_TITLE,
    },
    {
      conversation_id: ids.earlier,
      clinic_id: ids.clinic,
      role: "assistant",
      content: EARLIER_ANSWER,
    },
  ]));
});

test.afterAll(cleanup);

test("the assistant page browses, opens and continues earlier conversations", async ({
  page,
}) => {
  await login(page);
  await page.goto("/assistant");

  // The page opens on the most recent conversation, as before.
  await expect(page.getByText(EARLIER_ANSWER)).toBeVisible();

  await test.step("a new chat clears the view without losing the old conversation", async () => {
    await page.getByRole("button", { name: "New chat" }).click();
    await expect(page.getByText(EARLIER_ANSWER)).toHaveCount(0);

    const { panel } = await openHistoryPanel(page, page.locator("body"), "History");
    await expect(conversationEntry(panel, EARLIER_TITLE)).toBeVisible();
    await expect(conversationEntry(panel, OLDER_TITLE)).toBeVisible();

    // Opening one restores its persisted transcript.
    await conversationEntry(panel, EARLIER_TITLE).click();
    await expect(page.getByText(EARLIER_ANSWER)).toBeVisible();
  });

  await test.step("the history panel meets the same accessibility budget", async () => {
    const { toggle, panelId, panel } = await openHistoryPanel(
      page,
      page.locator("body"),
      "History",
    );

    const a11y = await new AxeBuilder({ page })
      .include(`[id="${panelId}"]`)
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(
      a11y.violations.filter(
        ({ impact }) => impact === "critical" || impact === "serious",
      ),
    ).toEqual([]);

    await panel.getByRole("button", { name: "Close" }).click();
    await expect(toggle).toBeFocused();
  });
});

test("the contextual Ask Assistant shortcut starts fresh and shares the same history", async ({
  page,
}) => {
  await login(page);
  await page.goto("/dashboard");
  await page.getByRole("button", { name: "Ask assistant" }).click();
  await expect(page.getByRole("heading", { name: "Dashboard assistant" })).toBeVisible();

  const sheet = page.getByRole("dialog").last();

  await test.step("it opens a new conversation, not the most recent one", async () => {
    // The regression this pass fixed: the shortcut silently continued whatever
    // conversation happened to be latest — here, the O+ one.
    await expect(sheet.getByText(EARLIER_ANSWER)).toHaveCount(0);
  });

  await test.step("it offers the same history, and can switch to an old chat", async () => {
    const { panel } = await openHistoryPanel(page, sheet, "History");
    await expect(conversationEntry(panel, EARLIER_TITLE)).toBeVisible();
    await conversationEntry(panel, EARLIER_TITLE).click();
    await expect(sheet.getByText(EARLIER_ANSWER)).toBeVisible();
  });

  await test.step("and can start another new chat from inside the shortcut", async () => {
    await sheet.getByRole("button", { name: "New chat" }).click();
    await expect(sheet.getByText(EARLIER_ANSWER)).toHaveCount(0);
  });
});

test("the history surface is localized and RTL-correct in Arabic", async ({ page }) => {
  await login(page);
  await page.goto("/preferences");
  await page.getByTestId("language-switcher-account").click();
  await page.getByRole("option", { name: "العربية" }).click();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");

  await page.goto("/assistant");
  const { panel, panelId } = await openHistoryPanel(
    page,
    page.locator("body"),
    "السجل",
  );
  await expect(panel).toBeVisible();
  await expect(conversationEntry(panel, EARLIER_TITLE)).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "بدء محادثة جديدة" }),
  ).toBeVisible();

  const a11y = await new AxeBuilder({ page })
    .include(`[id="${panelId}"]`)
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(
    a11y.violations.filter(
      ({ impact }) => impact === "critical" || impact === "serious",
    ),
  ).toEqual([]);
});
