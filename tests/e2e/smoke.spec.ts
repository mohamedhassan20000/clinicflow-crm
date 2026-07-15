import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import type { Database } from "@/types/database";

const LOCAL_SUPABASE_URL =
  process.env.LOCAL_SUPABASE_URL ?? "http://127.0.0.1:54321";
function requireTestEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} must be set in .env.local before running E2E tests.`);
  return v;
}

const LOCAL_SUPABASE_SECRET_KEY = requireTestEnv("LOCAL_SUPABASE_SECRET_KEY");

const suffix = `e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const password = "SmokeTest12345";
const calendarDate = new Date();
const calendarDay = `${calendarDate.getFullYear()}-${String(calendarDate.getMonth() + 1).padStart(2, "0")}-${String(calendarDate.getDate()).padStart(2, "0")}`;
const calendarMonth = calendarDay.slice(0, 7);
const today = new Date();
today.setDate(today.getDate() + 1);
const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

const ids = {
  clinic: randomUUID(),
  dept: randomUUID(),
  doctor: "",
  receptionist: "",
  forced: "",
  operator: "",
  legacyClinic: randomUUID(),
  emptyClinic: randomUUID(),
  emptyAdmin: "",
  emptyManager: "",
  emptyDoctor: "",
  emptyReceptionist: "",
  billingPatient: randomUUID(),
  settlementPatient: randomUUID(),
  billingAppointment: randomUUID(),
  settlementAppointment: randomUUID(),
  calendarAppointment: randomUUID(),
  service: randomUUID(),
};

const emails = {
  receptionist: `${suffix}-receptionist@example.com`,
  forced: `${suffix}-forced@example.com`,
  doctor: `${suffix}-doctor@example.com`,
  operator: `${suffix}-operator@example.com`,
  emptyAdmin: `${suffix}-empty-admin@example.com`,
  emptyManager: `${suffix}-empty-manager@example.com`,
  emptyDoctor: `${suffix}-empty-doctor@example.com`,
  emptyReceptionist: `${suffix}-empty-receptionist@example.com`,
};

const service = createClient<Database>(
  LOCAL_SUPABASE_URL,
  LOCAL_SUPABASE_SECRET_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

async function must<T>(
  result: PromiseLike<{ data: T | null; error: { message: string } | null }>,
) {
  const { data, error } = await result;
  if (error) throw new Error(error.message);
  return data;
}

async function createAuthUser(email: string) {
  const { data, error } = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(error?.message ?? "User setup failed");
  return data.user.id;
}

async function cleanup() {
  if (ids.operator) await service.from("platform_admins").delete().eq("user_id", ids.operator);
  await service.from("clinic_invitations").delete().like("email", `${suffix}-%`);
  await service.from("clinics").delete().eq("id", ids.legacyClinic);
  await service.from("subscriptions").delete().eq("clinic_id", ids.emptyClinic);
  await service.from("profiles").delete().eq("clinic_id", ids.emptyClinic);
  await service.from("clinics").delete().eq("id", ids.emptyClinic);
  await service.from("subscriptions").delete().eq("clinic_id", ids.clinic);
  await service.from("clinic_working_hours").delete().eq("clinic_id", ids.clinic);
  await service.from("appointment_services").delete().eq("clinic_id", ids.clinic);
  await service.from("outstanding_settlements").delete().eq("clinic_id", ids.clinic);
  await service.from("patient_deposits").delete().eq("clinic_id", ids.clinic);
  await service.from("medical_notes").delete().in("patient_id", [
    ids.billingPatient,
    ids.settlementPatient,
  ]);
  await service.from("appointments").delete().in("id", [
    ids.billingAppointment,
    ids.settlementAppointment,
    ids.calendarAppointment,
  ]);
  await service.from("patients").delete().in("id", [
    ids.billingPatient,
    ids.settlementPatient,
  ]);
  await service.from("services").delete().eq("clinic_id", ids.clinic);
  await service.from("profiles").delete().eq("clinic_id", ids.clinic);
  await service.from("departments").delete().eq("clinic_id", ids.clinic);
  await service.from("clinics").delete().eq("id", ids.clinic);
}

async function seedSmokeData() {
  const probe = await service.from("clinics").select("id").limit(1);
  if (probe.error) {
    throw new Error(`Local Supabase unavailable: ${probe.error.message}`);
  }

  ids.receptionist = await createAuthUser(emails.receptionist);
  ids.forced = await createAuthUser(emails.forced);
  ids.doctor = await createAuthUser(emails.doctor);
  ids.operator = await createAuthUser(emails.operator);

  await cleanup();

  await must(service.from("platform_admins").insert({ user_id: ids.operator }));

  await must(service.from("clinics").insert({
    id: ids.clinic,
    name: `Smoke Clinic ${suffix}`,
    onboarding_completed_at: new Date().toISOString(),
  }));
  await must(service.from("clinics").insert({
    id: ids.legacyClinic,
    name: `Legacy Clinic ${suffix}`,
    onboarding_completed_at: null,
    working_hours_start: null,
    working_hours_end: null,
  }));
  await must(service.from("clinic_invitations").insert({
    clinic_name: `Smoke Clinic ${suffix}`,
    owner_name: "Operator History Fixture",
    phone: "+96555555555",
    email: `${suffix}-history@example.com`,
    status: "accepted",
    accepted_clinic_id: ids.clinic,
    accepted_at: new Date().toISOString(),
    email_sent_at: new Date().toISOString(),
  }));
  const planResult = await service.from("plans").select("id").eq("slug", "basic").single();
  if (planResult.error) throw new Error(planResult.error.message);
  await must(service.from("subscriptions").insert({
    clinic_id: ids.clinic,
    plan_id: planResult.data.id,
    status: "trialing",
    trial_ends_at: new Date(Date.now() + 14 * 86_400_000).toISOString(),
  }));
  await must(service.from("departments").insert({
    id: ids.dept,
    clinic_id: ids.clinic,
    name: `Smoke Dept ${suffix}`,
    color: "#0d9488",
  }));
  await must(service.from("clinic_working_hours").insert(
    Array.from({ length: 7 }, (_, dayOfWeek) => [
      {
        clinic_id: ids.clinic,
        day_of_week: dayOfWeek,
        shift_start: dayOfWeek === 0 ? "08:00" : "09:00",
        shift_end: "12:00",
      },
      {
        clinic_id: ids.clinic,
        day_of_week: dayOfWeek,
        shift_start: "13:00",
        shift_end: dayOfWeek === 0 ? "18:00" : "17:00",
      },
    ]).flat(),
  ));
  await must(service.from("profiles").insert([
    {
      id: ids.receptionist,
      clinic_id: ids.clinic,
      full_name: "Smoke Receptionist",
      role: "receptionist",
      must_change_password: false,
    },
    {
      id: ids.forced,
      clinic_id: ids.clinic,
      full_name: "Forced Change User",
      role: "receptionist",
      must_change_password: true,
    },
    {
      id: ids.doctor,
      clinic_id: ids.clinic,
      department_id: ids.dept,
      full_name: "Smoke Doctor",
      role: "doctor",
      must_change_password: false,
    },
  ]));
  await must(service.from("services").insert({
    id: ids.service,
    clinic_id: ids.clinic,
    department_id: ids.dept,
    name: "Smoke Consultation",
    price: 50,
  }));
  const fxTime = new Date().toISOString();
  await must(service.from("fx_rates").upsert([
    { currency_code: "USD", rate: 1, provider: "e2e", provider_timestamp: fxTime, fetched_at: fxTime },
    { currency_code: "KWD", rate: 0.307, provider: "e2e", provider_timestamp: fxTime, fetched_at: fxTime },
  ]));
  await must(service.from("patients").insert([
    {
      id: ids.billingPatient,
      clinic_id: ids.clinic,
      full_name: "Billing Smoke Patient",
      date_of_birth: "1990-01-01",
      phone: "05551234567",
      email: `${suffix}-billing@example.com`,
      created_by: ids.receptionist,
      department_id: ids.dept,
      national_id: `${suffix}B`,
      file_number: `${suffix}-B`,
      assigned_doctor_id: ids.doctor,
    },
    {
      id: ids.settlementPatient,
      clinic_id: ids.clinic,
      full_name: "Settlement Smoke Patient",
      date_of_birth: "1991-01-01",
      phone: "05551234568",
      email: `${suffix}-settlement@example.com`,
      created_by: ids.receptionist,
      department_id: ids.dept,
      national_id: `${suffix}S`,
      file_number: `${suffix}-S`,
      assigned_doctor_id: ids.doctor,
    },
  ]));
  await must(service.from("appointments").insert([
    {
      id: ids.billingAppointment,
      clinic_id: ids.clinic,
      patient_id: ids.billingPatient,
      doctor_id: ids.doctor,
      department_id: ids.dept,
      scheduled_at: `${day}T09:00:00.000+03:00`,
      duration_minutes: 30,
      status: "confirmed",
      created_by: ids.receptionist,
    },
    {
      id: ids.settlementAppointment,
      clinic_id: ids.clinic,
      patient_id: ids.settlementPatient,
      doctor_id: ids.doctor,
      department_id: ids.dept,
      scheduled_at: `${day}T10:00:00.000+03:00`,
      duration_minutes: 30,
      status: "completed",
      total_amount: 100,
      paid_amount: 25,
      outstanding_amount: 75,
      payment_method: "cash",
      paid_at: new Date().toISOString(),
      created_by: ids.receptionist,
    },
    {
      id: ids.calendarAppointment,
      clinic_id: ids.clinic,
      patient_id: ids.billingPatient,
      doctor_id: ids.doctor,
      department_id: ids.dept,
      scheduled_at: `${calendarDay}T11:30:00.000+03:00`,
      duration_minutes: 30,
      status: "pending",
      created_by: ids.receptionist,
    },
  ]));
  await must(service.from("appointment_services").insert({
    clinic_id: ids.clinic,
    appointment_id: ids.settlementAppointment,
    service_id: ids.service,
    name: "Smoke Consultation",
    price: 100,
    quantity: 1,
  }));

  // WS0 (BUG-1 regression): a brand-new clinic with zero operational data must
  // render every role dashboard instead of the error boundary.
  ids.emptyAdmin = await createAuthUser(emails.emptyAdmin);
  ids.emptyManager = await createAuthUser(emails.emptyManager);
  ids.emptyDoctor = await createAuthUser(emails.emptyDoctor);
  ids.emptyReceptionist = await createAuthUser(emails.emptyReceptionist);
  await must(service.from("clinics").insert({
    id: ids.emptyClinic,
    name: `Empty Clinic ${suffix}`,
    onboarding_completed_at: new Date().toISOString(),
  }));
  await must(service.from("subscriptions").insert({
    clinic_id: ids.emptyClinic,
    plan_id: planResult.data.id,
    status: "trialing",
    trial_ends_at: new Date(Date.now() + 14 * 86_400_000).toISOString(),
  }));
  await must(service.from("profiles").insert([
    { id: ids.emptyAdmin, clinic_id: ids.emptyClinic, full_name: "Empty Admin", role: "admin", must_change_password: false },
    { id: ids.emptyManager, clinic_id: ids.emptyClinic, full_name: "Empty Manager", role: "manager", must_change_password: false },
    { id: ids.emptyDoctor, clinic_id: ids.emptyClinic, full_name: "Empty Doctor", role: "doctor", must_change_password: false },
    { id: ids.emptyReceptionist, clinic_id: ids.emptyClinic, full_name: "Empty Receptionist", role: "receptionist", must_change_password: false },
  ]));
}

async function deleteAuthUsers() {
  for (const id of [
    ids.receptionist,
    ids.forced,
    ids.doctor,
    ids.operator,
    ids.emptyAdmin,
    ids.emptyManager,
    ids.emptyDoctor,
    ids.emptyReceptionist,
  ].filter(Boolean)) {
    await service.auth.admin.deleteUser(id);
  }
}

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole("button", { name: /sign in|تسجيل الدخول/i }).click();
  await expect(page).toHaveURL(/\/(dashboard|change-password)/);
}

async function loginOperator(page: Page) {
  await page.goto("/login");
  await page.locator('input[type="email"]').fill(emails.operator);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole("button", { name: /sign in|تسجيل الدخول/i }).click();
  await expect(page).toHaveURL(/\/operator/);
}

async function delayNextMutation(page: Page) {
  await page.evaluate(() => {
    const originalFetch = window.fetch.bind(window);
    let delayed = false;
    window.fetch = async (...args) => {
      const init = args[1];
      const request = args[0] instanceof Request ? args[0] : null;
      const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
      if (!delayed && method === "POST") {
        delayed = true;
        await new Promise((resolve) => setTimeout(resolve, 750));
      }
      return originalFetch(...args);
    };
  });
}

/**
 * Generated calendar-treatment screenshots (Pre-P2 WS5).
 *
 * This **must never point back into `docs/reviews/assets/`**. It did until P2C, and the consequence
 * was a standing trap: every `pnpm test:e2e` run silently overwrote 13 *tracked, approved* review
 * artifacts belonging to a sub-phase that had already shipped, and only a manual `git restore` kept
 * them out of the next diff. Three consecutive phases carried that landmine (recorded in
 * `docs/reviews/P2B_PHASE_REVIEW.md` §7); one forgotten restore would have replaced another
 * sub-phase's evidence with a screenshot of whatever the tree happened to look like that day.
 *
 * `test-results/` is Playwright's own output directory and is already gitignored, so a run can no
 * longer reach a tracked file. The approved WS5 artifacts stay where they are, read-only by virtue
 * of nothing writing to them. A unit test (`tests/unit/lib/p2c-i18n.test.ts`) asserts this path
 * never drifts back under `docs/`.
 */
const WS5_SCREENSHOT_DIR = "test-results/ws5-calendar-treatment";
const WS5_BASELINE_CSS = `
  [data-calendar-grid] {
    border-color: color-mix(in oklab, var(--border) 40%, transparent) !important;
    background: color-mix(in oklab, var(--card) 40%, transparent) !important;
  }
  [data-calendar-hour-label] {
    font-size: 9px !important;
    font-weight: 400 !important;
    opacity: .5 !important;
  }
  [data-calendar-day-header]:not([data-today="true"]) {
    background: color-mix(in oklab, var(--muted) 30%, transparent) !important;
    color: var(--muted-foreground) !important;
    font-weight: 500 !important;
  }
  [data-calendar-today-body] { background: transparent !important; }
  [data-calendar-now-indicator] { display: none !important; }
  [data-calendar-non-working] {
    background: color-mix(in oklab, var(--muted) 40%, transparent) !important;
    background-image: none !important;
  }
  [data-calendar-event] { opacity: .72 !important; box-shadow: none !important; }
`;

async function setScreenshotTheme(page: Page, theme: "light" | "dark") {
  await page.evaluate((nextTheme) => {
    document.documentElement.classList.toggle("dark", nextTheme === "dark");
    document.documentElement.style.colorScheme = nextTheme;
  }, theme);
}

async function captureWs5Pair(
  page: Page,
  view: "week" | "day" | "month",
  theme: "light" | "dark",
) {
  await setScreenshotTheme(page, theme);
  const nowIndicator = page.locator("[data-calendar-now-indicator]").first();
  if (view !== "month" && await nowIndicator.count()) {
    await nowIndicator.scrollIntoViewIfNeeded();
  }
  const screenshotChrome = await page.addStyleTag({
    content: "nextjs-portal { display: none !important; }",
  });
  const baseline = await page.addStyleTag({ content: WS5_BASELINE_CSS });
  await page.screenshot({
    path: `${WS5_SCREENSHOT_DIR}/${view}-${theme}-before.png`,
    animations: "disabled",
  });
  await baseline.evaluate((node) => (node as HTMLElement).remove());
  await page.screenshot({
    path: `${WS5_SCREENSHOT_DIR}/${view}-${theme}-after.png`,
    animations: "disabled",
  });
  await screenshotChrome.evaluate((node) => (node as HTMLElement).remove());
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await seedSmokeData();
});

test.beforeEach(async ({ page }, testInfo) => {
  await page.context().addCookies([
    {
      name: "cf_marketing_locale",
      value: "en",
      url: testInfo.project.use.baseURL as string,
    },
  ]);
});

test.afterAll(async () => {
  await cleanup();
  await deleteAuthUsers();
});

test("login page accepts input and protects app routes", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: /welcome back/i })).toBeVisible();
  await page.getByLabel(/email/i).fill("not-an-email");
  await page.locator('input[type="password"]').fill("x");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page.getByText(/enter a valid email/i)).toBeVisible();

  await page.goto("/appointments");
  await expect(page).toHaveURL(/\/login/);
});

test("dashboard shell renders on a deep protected page and signs out", async ({ page }) => {
  await login(page, emails.receptionist);
  await page.goto(`/patients/${ids.settlementPatient}`);
  await expect(page.getByTestId("dashboard-header")).toBeVisible();
  const navigation = page.getByRole("navigation", { name: /clinicflow navigation/i });
  await expect(navigation).toBeVisible();
  await expect(navigation.getByRole("link", { name: "Patients", exact: true })).toBeVisible();

  // MP7: the brand row is the single collapse control; it must stay aligned with
  // the header, remain keyboard-operable, and never navigate.
  const sidebar = page.getByTestId("dashboard-sidebar");
  const brandRow = sidebar.getByTestId("sidebar-brand-row");
  const toggle = sidebar.getByRole("button", { name: "Collapse navigation" });
  const header = page.getByTestId("dashboard-header");
  const assertDividerBaseline = async () => {
    const [brandBox, headerBox] = await Promise.all([
      brandRow.boundingBox(),
      header.boundingBox(),
    ]);
    expect(brandBox, "sidebar brand-row bounding box").not.toBeNull();
    expect(headerBox, "dashboard header bounding box").not.toBeNull();
    expect(Math.abs((brandBox!.y + brandBox!.height) - (headerBox!.y + headerBox!.height))).toBeLessThan(0.1);
    const [brandBorder, sidebarBorder] = await Promise.all([
      brandRow.evaluate((element) => getComputedStyle(element).borderBottomColor),
      sidebar.evaluate((element) => getComputedStyle(element).borderInlineEndColor),
    ]);
    expect(brandBorder).toBe(sidebarBorder);
  };

  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-controls", "dashboard-navigation");
  await expect(toggle).toHaveAttribute("title", "Collapse navigation");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(toggle.locator("img")).toHaveAttribute("alt", "ClinicFlow");
  await expect(toggle.locator("a")).toHaveCount(0);
  const box = await toggle.boundingBox();
  expect(box, "brand-toggle bounding box").not.toBeNull();
  const sidebarBox = await sidebar.boundingBox();
  expect(sidebarBox, "sidebar bounding box").not.toBeNull();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  expect(sidebarBox!.width - box!.width).toBeGreaterThanOrEqual(0);
  expect(sidebarBox!.width - box!.width).toBeLessThanOrEqual(1);
  await assertDividerBaseline();

  // The whole row, including its inline end, belongs to the button.
  const hit = await page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y);
    return el?.closest("button")?.getAttribute("aria-label") ?? el?.tagName ?? null;
  }, { x: box!.x + box!.width - 4, y: box!.y + box!.height / 2 });
  expect(hit).toBe("Collapse navigation");

  await toggle.focus();
  await expect(toggle).toBeFocused();
  const focusOutline = await toggle.evaluate((element) => {
    const styles = getComputedStyle(element);
    return { style: styles.outlineStyle, width: styles.outlineWidth };
  });
  expect(focusOutline.style).not.toBe("none");
  expect(Number.parseFloat(focusOutline.width)).toBeGreaterThanOrEqual(2);

  const urlBeforeToggle = page.url();
  await toggle.click();
  await assertDividerBaseline(); // sampled while the 200 ms width transition is active
  await expect(sidebar).toHaveAttribute("data-collapsed", "true");
  expect(page.url()).toBe(urlBeforeToggle);
  const expandToggle = sidebar.getByRole("button", { name: "Expand navigation" });
  await expect(expandToggle).toBeVisible();
  await expect(expandToggle).toHaveAttribute("aria-expanded", "false");
  await expect(expandToggle).toHaveAttribute("title", "Expand navigation");
  await assertDividerBaseline();

  // Native button semantics cover both required keys without custom handlers.
  await expandToggle.focus();
  await page.keyboard.press("Enter");
  await expect(sidebar).toHaveAttribute("data-collapsed", "false");
  const collapseToggle = sidebar.getByRole("button", { name: "Collapse navigation" });
  await collapseToggle.focus();
  await page.keyboard.press("Space");
  await expect(sidebar).toHaveAttribute("data-collapsed", "true");
  await sidebar.getByRole("button", { name: "Expand navigation" }).click();
  await expect(sidebar).toHaveAttribute("data-collapsed", "false");

  // The authenticated header belongs to document flow: scrolling moves it out
  // of view, and returning to the top restores its original aligned position.
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" }));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await expect.poll(async () => (await header.boundingBox())?.y ?? 0).toBeLessThan(-1);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await expect.poll(async () => (await header.boundingBox())?.y ?? -1).toBe(0);
  await assertDividerBaseline();

  // Tablet, dark theme, and fractional zoom all use the same top-band token.
  await page.setViewportSize({ width: 768, height: 720 });
  await assertDividerBaseline();
  await page.getByRole("button", { name: /switch to dark mode/i }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await assertDividerBaseline();
  for (const zoom of [1.1, 1.25]) {
    await page.evaluate((value) => { document.body.style.zoom = String(value); }, zoom);
    await assertDividerBaseline();
  }
  await page.evaluate(() => { document.body.style.zoom = ""; });

  // Below md the desktop rail disappears and the sheet brand is deliberately inert.
  await page.setViewportSize({ width: 767, height: 720 });
  await expect(sidebar).toBeHidden();
  await page.getByRole("button", { name: "Open navigation" }).click();
  const mobileSidebar = page.getByTestId("mobile-sidebar");
  await expect(mobileSidebar).toBeVisible();
  await expect(mobileSidebar.getByTestId("sidebar-brand-row").getByText("ClinicFlow")).toBeVisible();
  await expect(mobileSidebar.getByRole("button", { name: /navigation/i })).toHaveCount(0);
  await expect(mobileSidebar.locator("[aria-expanded]")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(mobileSidebar).toBeHidden();

  await page.setViewportSize({ width: 1280, height: 720 });

  await page.getByRole("button", { name: /open user menu/i }).click();
  await page.getByRole("menuitem", { name: /sign out/i }).click();
  await expect(page).toHaveURL(/\/login/);
});

test("display currency preference (Settings → Preferences) applies on money surfaces", async ({ page }) => {
  // WS4: a receptionist reaches Preferences from the header user menu (not the
  // header selector, which is gone) and changes display currency there.
  await login(page, emails.receptionist);
  await expect(page.getByLabel("Display currency")).toHaveCount(0); // removed from header
  await page.getByRole("button", { name: /open user menu/i }).click();
  await page.getByRole("menuitem", { name: /preferences/i }).click();
  await expect(page).toHaveURL(/\/preferences/);
  await expect(page.getByRole("heading", { name: "Preferences" })).toBeVisible();

  await page.getByRole("combobox", { name: "Display currency" }).click();
  await page.getByPlaceholder(/search currency/i).fill("United States");
  const [currencyUpdate] = await Promise.all([
    page.waitForResponse(
      (response) => response.request().method() === "POST" && response.ok(),
    ),
    page.getByRole("option", { name: /US Dollar/ }).click(),
  ]);
  expect(currencyUpdate.ok()).toBe(true);
  await expect
    .poll(async () => {
      const profile = await service
        .from("profiles")
        .select("display_currency")
        .eq("id", ids.receptionist)
        .single();
      return profile.data?.display_currency;
    })
    .toBe("USD");
  await page.goto(`/patients/${ids.settlementPatient}`);
  await expect(page.getByText(/≈.*US\$/).first()).toBeVisible();
  await expect(page.getByText(/KWD|د\.ك/).first()).toBeVisible();
});

test("operator shell renders and persists theme without a clinic profile", async ({ page }) => {
  await loginOperator(page);

  await expect(
    page.getByRole("navigation", {
      name: /clinicflow operator navigation/i,
    }),
  ).toBeVisible();

  await expect(page.getByText(/registration mode:/i)).toBeVisible();
  await expect(page.getByText(/active clinics/i)).toBeVisible();

  await expect(
    page
      .getByTestId("dashboard-sidebar")
      .getByRole("link", { name: /clinics/i }),
  ).toBeVisible();

  await page.getByRole("button", { name: /switch to dark mode/i }).click();

  await expect(page.locator("html")).toHaveClass(/dark/);

  await expect
    .poll(async () => {
      const cookies = await page.context().cookies();
      return cookies.find((cookie) => cookie.name === "theme")?.value;
    })
    .toBe("dark");

  await page.goto("/operator/clinics");
  await expect(page).toHaveURL(/\/operator\/clinics/);
  await expect(page.locator("html")).toHaveClass(/dark/);

  await page.reload();
  await expect(page.locator("html")).toHaveClass(/dark/);

  const invitationEmail = `${suffix}-sa-invite@example.com`;
  await page.goto("/operator/invitations");
  await page.getByPlaceholder("Clinic name").fill("Saudi E2E Clinic");
  await page.getByPlaceholder("Owner name").fill("Saudi Owner");
  // WS3: searchable country combobox — type-ahead + keyboard select.
  await page.getByRole("combobox", { name: "Country calling code" }).click();
  await page.getByPlaceholder(/search country/i).fill("Saudi");
  await page.getByRole("option", { name: /Saudi Arabia/ }).click();
  await page.getByPlaceholder("Local number").fill("0501234567");
  await page.getByPlaceholder("owner@example.com").fill(invitationEmail);
  await page.getByRole("checkbox", { name: /override/i }).check();
  await page.getByRole("button", { name: "Create & issue" }).click();
  await expect(page.getByText(invitationEmail)).toBeVisible();
  const invitation = await service.from("clinic_invitations").select("phone").eq("email", invitationEmail).single();
  expect(invitation.data?.phone).toBe("+966501234567");
  await service.from("clinic_invitations").delete().eq("email", invitationEmail);

  // WS3 (BUG-3): a non-registry country (🇬🇧 +44) now works end-to-end.
  const gbEmail = `${suffix}-gb-invite@example.com`;
  await page.getByPlaceholder("Clinic name").fill("London E2E Clinic");
  await page.getByPlaceholder("Owner name").fill("London Owner");
  const phoneCountry = page.getByRole("combobox", { name: "Country calling code" });
  await phoneCountry.click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(page.getByRole("option", { name: /Kuwait.*KW.*\+965/i })).toBeVisible();
  const countrySearch = page.getByPlaceholder(/search country/i);
  await countrySearch.fill("united");
  await expect(page.getByRole("option", { name: /United Kingdom/i })).toBeVisible();
  await countrySearch.fill("United Kingdom");
  await countrySearch.press("ArrowDown");
  await countrySearch.press("Enter");
  await expect(phoneCountry).toContainText("+44");
  await page.getByPlaceholder("Local number").fill("2079460000");
  await page.getByPlaceholder("owner@example.com").fill(gbEmail);
  await page.getByRole("checkbox", { name: "Override the weekly limit" }).check();
  await page.getByRole("button", { name: "Create & issue" }).click();
  await expect(page.getByText(gbEmail)).toBeVisible();
  const gbInvitation = await service.from("clinic_invitations").select("phone").eq("email", gbEmail).single();
  expect(gbInvitation.data?.phone).toBe("+442079460000");
  await service.from("clinic_invitations").delete().eq("email", gbEmail);
});

test("MP6/P2A: the operator header drops Preferences and now fills the language slot; clinic users keep Preferences", async ({ browser }) => {
  const operatorContext = await browser.newContext();
  const doctorContext = await browser.newContext();
  const operatorPage = await operatorContext.newPage();
  const doctorPage = await doctorContext.newPage();

  try {
    // Operator (Platform Admin): /preferences is a clinic-user route they cannot use, so the entry
    // is gone (MP6). P2A fills the position MP6 reserved — and the placeholder-free rule ends here:
    // the control that landed is a real switcher, asserted below to actually change the language.
    await loginOperator(operatorPage);
    // The theme toggle stays: the Platform Admin's theme is their own (§6.C). Asserted before the
    // menu opens, since the dropdown makes the rest of the page inert.
    await expect(operatorPage.getByRole("button", { name: /switch to (dark|light) mode/i })).toBeVisible();
    await expect(
      operatorPage.getByTestId("dashboard-header").getByTestId("language-switcher-account"),
    ).toBeVisible();

    await operatorPage.getByRole("button", { name: /open user menu/i }).click();
    await expect(operatorPage.getByRole("menuitem", { name: /sign out/i })).toBeVisible();
    await expect(operatorPage.getByRole("menuitem", { name: /preferences/i })).toHaveCount(0);
    await expect(operatorPage.locator('a[href="/preferences"]')).toHaveCount(0);
    await operatorPage.keyboard.press("Escape");

    // Clinic user (doctor): Preferences is untouched and still opens.
    await login(doctorPage, emails.doctor);
    // §6.A: the clinic dashboard header gets NO language control — clinic users switch in Preferences.
    await expect(
      doctorPage.getByTestId("dashboard-header").getByTestId("language-switcher-account"),
    ).toHaveCount(0);

    await doctorPage.getByRole("button", { name: /open user menu/i }).click();
    await doctorPage.getByRole("menuitem", { name: /preferences/i }).click();
    await expect(doctorPage).toHaveURL(/\/preferences/);
    await expect(doctorPage.getByRole("heading", { name: "Preferences" })).toBeVisible();
    // P2A: the formerly read-only "English (US)" card is now a real per-user control.
    await expect(doctorPage.getByTestId("language-switcher-account")).toBeVisible();
  } finally {
    await operatorContext.close();
    await doctorContext.close();
  }
});

/** Drives the header toggle to a known theme, whatever the account's stored theme currently is. */
async function setDashboardTheme(page: Page, theme: "light" | "dark") {
  const toggle = page.getByRole("button", {
    name: theme === "dark" ? /switch to dark mode/i : /switch to light mode/i,
  });
  // The account may already be in the target theme — under P2A the stored preference can arrive in a
  // context that has never written a theme cookie, which is the whole point of the store.
  const switched = (await toggle.count()) > 0;
  if (switched) await toggle.click();

  if (theme === "dark") await expect(page.locator("html")).toHaveClass(/dark/);
  else await expect(page.locator("html")).not.toHaveClass(/dark/);

  // The toggle updates the DOM optimistically, so the class alone does not prove the preference was
  // stored. `setTheme` writes the cookie hint only after the row write succeeds, so waiting for the
  // cookie is what makes a subsequent reload assert persistence rather than a race.
  if (switched) {
    await expect
      .poll(async () => {
        const cookies = await page.context().cookies();
        return cookies.find((cookie) => cookie.name === "theme")?.value;
      })
      .toBe(theme);
  }
}

test("P2A: theme follows the user, not the browser, and stays private to each account", async ({ browser }) => {
  // Before P2A this test asserted the *device* semantics: a fresh browser context always started
  // light, because the theme lived in a cookie. §4.5 deliberately replaced that — the theme is now a
  // property of the account — so the assertions below encode the new contract, including the two
  // gaps the polish sprint documented and left open.
  const receptionistContext = await browser.newContext();
  const doctorContext = await browser.newContext();
  const receptionistPage = await receptionistContext.newPage();
  const doctorPage = await doctorContext.newPage();

  try {
    await login(receptionistPage, emails.receptionist);
    await login(doctorPage, emails.doctor);

    await setDashboardTheme(receptionistPage, "dark");

    // A second user on the same browser gets their own theme — not the one the receptionist chose.
    await doctorPage.reload();
    await expect(doctorPage.locator("html")).not.toHaveClass(/dark/);

    await receptionistPage.reload();
    await expect(receptionistPage.locator("html")).toHaveClass(/dark/);

    // ...and the receptionist's theme follows them to a second device: a brand-new context, with no
    // theme cookie at all, still renders dark because the preference belongs to the account.
    const secondDevice = await browser.newContext();
    const secondDevicePage = await secondDevice.newPage();
    try {
      await login(secondDevicePage, emails.receptionist);
      await expect(secondDevicePage.locator("html")).toHaveClass(/dark/);
    } finally {
      await secondDevice.close();
    }

    // Switching back persists just as durably, and still leaves the doctor alone.
    await setDashboardTheme(receptionistPage, "light");
    await receptionistPage.reload();
    await expect(receptionistPage.locator("html")).not.toHaveClass(/dark/);
    await doctorPage.reload();
    await expect(doctorPage.locator("html")).not.toHaveClass(/dark/);
  } finally {
    await receptionistContext.close();
    await doctorContext.close();
  }
});

test("WS7 operator report filters persist in the URL and exports match active filters", async ({ page }) => {
  await loginOperator(page);
  const clinic = await service.from("clinics").select("country, name").eq("id", ids.clinic).single();
  if (clinic.error) throw new Error(clinic.error.message);

  await page.goto("/operator/reports/clinics");
  await expect(page.getByRole("heading", { name: "Clinics report" })).toBeVisible();
  await page.getByRole("combobox", { name: "Country" }).click();
  await page.getByPlaceholder(/search country/i).fill(clinic.data.country);
  await page.getByRole("option", { name: clinic.data.country, exact: true }).click();
  await page.locator('input[type="date"][name="createdFrom"]').fill("");
  await page.locator('input[type="date"][name="createdTo"]').fill("");
  await page.getByRole("button", { name: "Apply filters" }).click();

  await expect.poll(() => new URL(page.url()).searchParams.get("country")).toBe(clinic.data.country);
  await expect.poll(() => new URL(page.url()).searchParams.has("createdFrom")).toBe(true);
  expect(new URL(page.url()).searchParams.get("createdFrom")).toBe("");
  await expect(page.getByText(clinic.data.name)).toBeVisible();

  await page.reload();
  await expect(page.getByRole("combobox", { name: "Country" })).toContainText(clinic.data.country);
  await expect(
    page.locator('input[type="date"][name="createdFrom"]'),
  ).toHaveValue("");
  const sortLink = page.getByRole("link", { name: "Sort by Clinic ascending" });
  const sortHref = await sortLink.getAttribute("href");
  expect(new URL(sortHref!, "http://localhost").searchParams.get("sort")).toBe("name");
  await sortLink.focus();
  await expect(sortLink).toBeFocused();
  await page.keyboard.press("Enter");
  await expect
    .poll(() => new URL(page.url()).searchParams.get("sort"), { timeout: 15_000 })
    .toBe("name");
  expect(new URL(page.url()).searchParams.get("country")).toBe(clinic.data.country);
  expect(new URL(page.url()).searchParams.get("page")).toBe("1");

  const renderDurations: number[] = [];
  for (let sample = 0; sample < 20; sample += 1) {
    const startedAt = performance.now();
    const renderResponse = await page.request.get(page.url());
    expect(renderResponse.ok()).toBe(true);
    renderDurations.push(performance.now() - startedAt);
  }
  renderDurations.sort((a, b) => a - b);
  const p95Render = renderDurations[Math.ceil(renderDurations.length * 0.95) - 1]!;
  console.info(`WS7 filtered report p95: ${p95Render.toFixed(1)}ms`);
  expect(p95Render).toBeLessThan(1_000);

  const exportHref = await page.getByRole("link", { name: /Export filtered CSV/ }).getAttribute("href");
  expect(exportHref).toBeTruthy();
  const response = await page.request.get(exportHref!);
  expect(response.ok()).toBe(true);
  expect(response.headers()["content-type"]).toContain("text/csv");
  const csv = await response.text();
  expect(csv).toContain(clinic.data.name);
  expect(csv).not.toMatch(/Patient|National ID|Medical note|Phone|Email/i);

  const clearFilters = page.getByRole("link", { name: "Clear filters" });
  await expect(clearFilters).toHaveAttribute("href", /[?&]country=all(?:&|$)/);
  await clearFilters.focus();
  await expect(clearFilters).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(
    (url) => url.searchParams.get("country") === "all",
    { timeout: 15_000 },
  );
  await expect(page.getByRole("combobox", { name: "Country" })).toContainText("All");
});

test("MP0 operator clinic history and Invitations report render with recoverable failures", async ({ page }) => {
  await loginOperator(page);

  await page.goto("/operator/invitations");
  await expect(page.getByRole("heading", { name: "Invitations", exact: true })).toBeVisible();
  await expect(page.getByText(`${suffix}-history@example.com`)).toBeVisible();
  await expect(page.getByText("Operator page could not be loaded")).toHaveCount(0);

  await page.goto("/operator/reports/invitations");
  await expect(page.getByRole("heading", { name: "Invitations report" })).toBeVisible();
  await page.locator('select[name="status"]').selectOption("all");
  await page.locator('select[name="emailSent"]').selectOption("yes");
  await page.locator('input[type="date"][name="createdFrom"]').fill("");
  await page.locator('input[type="date"][name="createdTo"]').fill("");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("emailSent")).toBe("yes");
  await expect.poll(() => new URL(page.url()).searchParams.get("status")).toBe("all");
  await expect(page.getByText(`Smoke Clinic ${suffix}`)).toBeVisible();

  await page.reload();
  await expect(page.locator('select[name="emailSent"]')).toHaveValue("yes");
  const sortLink = page.getByRole("link", { name: "Sort by Created ascending" });
  await sortLink.click();
  await expect.poll(() => new URL(page.url()).searchParams.get("dir")).toBe("asc");

  const exportHref = await page
    .getByRole("link", { name: "Export filtered CSV" })
    .getAttribute("href");
  expect(exportHref).toBeTruthy();
  const exportResponse = await page.request.get(exportHref!);
  expect(exportResponse.ok()).toBe(true);
  const csv = await exportResponse.text();
  expect(csv).toContain(`Smoke Clinic ${suffix}`);
  expect(csv).not.toMatch(/Owner|Phone|Email address|Patient|National ID|Medical note/i);

  await page.goto(`/operator/clinics/${ids.clinic}`);
  for (const heading of [
    "Clinic profile",
    "Current subscription",
    "Invitation lineage",
    "Coupon redemptions",
    "Feature overrides",
    "Usage history",
    "Audit timeline",
    "Payments & contracts",
  ]) {
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
  }
  await expect(page.getByText("Operator page could not be loaded")).toHaveCount(0);

  await page.goto(`/operator/clinics/${ids.legacyClinic}`);
  await expect(page.getByRole("heading", { name: `Legacy Clinic ${suffix}` })).toBeVisible();
  await expect(page.getByText("No working hours configured")).toBeVisible();
  await expect(page.getByText("No linked clinic invitation")).toBeVisible();
  await expect(page.getByText("No coupon redemptions")).toBeVisible();
  await expect(page.getByText("No overrides — plan defaults apply.")).toBeVisible();
  await expect(page.getByText("No usage recorded")).toBeVisible();

  await page.goto(`/operator/clinics/${randomUUID()}`);
  await expect(page.getByRole("heading", { name: "Operator page not found" })).toBeVisible();

  await page.goto("/operator/clinics/not-a-uuid");
  await expect(
    page.getByRole("heading", { name: "Operator page could not be loaded" }),
  ).toBeVisible();
  await expect(page.getByText(/^Error ID:/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Go to Mission Control" })).toHaveAttribute(
    "href",
    "/operator",
  );
});

test("WS6 operator clinic detail returns to the filtered list by keyboard on mobile and both themes", async ({ page }) => {
  await loginOperator(page);
  const clinicResult = await service.from("clinics").select("country").eq("id", ids.clinic).single();
  if (clinicResult.error) throw new Error(clinicResult.error.message);
  const country = clinicResult.data.country;

  await page.goto(`/operator/clinics?q=Smoke%20Clinic&country=${country}`);
  await expect(page.getByLabel("Search clinics")).toHaveValue("Smoke Clinic");
  await expect(page.getByLabel("Country code")).toHaveValue(country);
  // P2A: the operator's theme is stored on their account, so a fresh context no longer implies
  // light — an earlier test may have left them dark. Drive the starting theme instead of assuming
  // it; this test is about both themes rendering correctly, not about what the default is.
  await setDashboardTheme(page, "light");

  const clinicLink = page.getByRole("link", { name: `Smoke Clinic ${suffix}` });
  await clinicLink.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/operator/clinics/${ids.clinic}`));
  await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toBeVisible();

  const back = page.getByRole("link", { name: "Back to clinics" });
  const backUrl = new URL(await back.getAttribute("href") ?? "", "http://localhost");
  expect(backUrl.pathname).toBe("/operator/clinics");
  expect(backUrl.searchParams.get("q")).toBe("Smoke Clinic");
  expect(backUrl.searchParams.get("country")).toBe(country);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(back).toBeVisible();
  const lightMetrics = await page.evaluate(() => ({ body: document.body.scrollWidth, viewport: window.innerWidth }));
  expect(lightMetrics.body).toBeLessThanOrEqual(lightMetrics.viewport);
  await page.getByRole("button", { name: /switch to dark mode/i }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(back).toBeVisible();

  await back.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Search clinics")).toHaveValue("Smoke Clinic");
  await expect(page.getByLabel("Country code")).toHaveValue(country);
});

test("WS6 patient detail and report preserve the filtered patient return path", async ({ page }) => {
  await login(page, emails.receptionist);
  const listPath = `/patients?name=Settlement&page=1&dept=${ids.dept}`;
  await page.goto(listPath);

  const patientRow = page.getByRole("link", { name: /Settlement Smoke Patient/ });
  await patientRow.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/patients/${ids.settlementPatient}`));

  const patientUrl = page.url();
  const detailReturn = new URL(patientUrl).searchParams.get("returnTo");
  expect(detailReturn).toBe(listPath);
  await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toBeVisible();

  await page.locator(`a[href*="/patients/${ids.settlementPatient}/appointments-report"]`).click();
  await expect(page).toHaveURL(new RegExp(`/patients/${ids.settlementPatient}/appointments-report`));
  const reportBack = page.getByRole("link", { name: "Back to patient" });
  expect(await reportBack.getAttribute("href")).toBe(new URL(patientUrl).pathname + new URL(patientUrl).search);

  await page.locator('input[type="date"]').first().fill("2026-07-01");
  await page.getByRole("button", { name: "Apply filter" }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("returnTo")).toBe(new URL(patientUrl).pathname + new URL(patientUrl).search);

  await reportBack.focus();
  await page.keyboard.press("Enter");
  const listBack = page.getByRole("link", { name: "Back to patients" });
  await listBack.focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => new URL(page.url()).searchParams.get("name")).toBe("Settlement");
  await expect.poll(() => new URL(page.url()).searchParams.get("dept")).toBe(ids.dept);
  await expect(page.getByRole("link", { name: /Settlement Smoke Patient/ })).toBeVisible();
});

test("a fresh empty clinic renders every role dashboard without the error boundary", async ({ page }) => {
  const roles = [
    { email: emails.emptyAdmin, heading: "Dashboard", money: /Revenue collected/i },
    { email: emails.emptyManager, heading: "Analytics", money: null },
    { email: emails.emptyDoctor, heading: "My Dashboard", money: null },
    { email: emails.emptyReceptionist, heading: "Dashboard", money: null },
  ] as const;
  for (const role of roles) {
    const errors: string[] = [];
    const onPageError = (error: Error) => errors.push(error.message);
    page.on("pageerror", onPageError);
    await login(page, role.email);
    await expect(page.getByRole("heading", { name: role.heading, exact: true })).toBeVisible();
    await expect(page.getByText("Something went wrong")).toHaveCount(0);
    if (role.money) {
      // BUG-1: compact money formatting (maximumFractionDigits: 0) must not throw
      await expect(page.getByText(role.money)).toBeVisible();
    }
    expect(errors, `client errors for ${role.email}: ${errors.join("; ")}`).toEqual([]);
    page.off("pageerror", onPageError);
    await page.getByRole("button", { name: /open user menu/i }).click();
    await page.getByRole("menuitem", { name: /sign out/i }).click();
    await expect(page).toHaveURL(/\/login/);
  }
});

test("forced password users are redirected to change-password", async ({ page }) => {
  await login(page, emails.forced);
  await expect(page).toHaveURL(/\/change-password/);
  await expect(
    page.getByRole("heading", { name: /set a new password/i }),
  ).toBeVisible();
});

test("WS5 calendar readability is consistent across views, themes, and mobile", async ({ page }) => {
  await mkdir(WS5_SCREENSHOT_DIR, { recursive: true });
  await login(page, emails.receptionist);

  // Freeze only the browser clock so the current-time indicator is deterministic;
  // server range/query behavior and stored appointment timestamps stay untouched.
  await page.addInitScript(({ frozen }) => {
    const NativeDate = Date;
    const FrozenDate = new Proxy(NativeDate, {
      construct(target, args) {
        return Reflect.construct(target, args.length === 0 ? [frozen] : args);
      },
      apply(target, thisArg, args) {
        if (args.length === 0) return new NativeDate(frozen).toString();
        return Reflect.apply(target, thisArg, args);
      },
    });
    Object.defineProperty(FrozenDate, "now", {
      value: () => new NativeDate(frozen).getTime(),
    });
    Object.defineProperty(globalThis, "Date", { value: FrozenDate });
  }, { frozen: `${calendarDay}T09:30:00.000Z` });

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/appointments?week=${calendarDay}`);
  await expect(page.locator('[data-calendar-view="week"]')).toBeVisible();
  await expect(page.getByRole("separator", { name: /current time/i })).toBeAttached();
  expect(await page.locator('[data-calendar-non-working="break"]').count()).toBeGreaterThan(0);
  expect(await page.locator("[data-calendar-event]").count()).toBeGreaterThan(0);
  await expect(page.locator('[data-calendar-today-body="true"]')).toHaveCount(1);

  const hourLabelStyle = await page.locator("[data-calendar-hour-label]").first().evaluate((node) => {
    const style = getComputedStyle(node);
    return { fontSize: parseFloat(style.fontSize), fontWeight: Number(style.fontWeight), opacity: Number(style.opacity) };
  });
  expect(hourLabelStyle.fontSize).toBeGreaterThanOrEqual(11);
  expect(hourLabelStyle.fontWeight).toBeGreaterThanOrEqual(500);
  expect(hourLabelStyle.opacity).toBe(1);

  await page.locator("[data-calendar-event]").first().scrollIntoViewIfNeeded();
  await captureWs5Pair(page, "week", "light");
  await captureWs5Pair(page, "week", "dark");

  await page.goto(`/appointments?view=day&date=${calendarDay}`);
  await expect(page.locator('[data-calendar-view="day"]')).toBeVisible();
  await expect(page.getByRole("separator", { name: /current time/i })).toBeAttached();
  await page.locator("[data-calendar-event]").first().scrollIntoViewIfNeeded();
  await captureWs5Pair(page, "day", "light");
  await captureWs5Pair(page, "day", "dark");

  await page.goto(`/appointments?view=month&month=${calendarMonth}`);
  await expect(page.locator('[data-calendar-view="month"]')).toBeVisible();
  await expect(page.locator('[aria-current="date"]')).toBeVisible();
  expect(await page.locator("[data-calendar-event]").count()).toBeGreaterThan(0);
  await captureWs5Pair(page, "month", "light");
  await captureWs5Pair(page, "month", "dark");

  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto(`/appointments?view=day&date=${calendarDay}`);
  const responsiveGrid = page.locator("[data-calendar-grid]");
  await expect(responsiveGrid).toBeVisible();
  const responsiveMetrics = await responsiveGrid.evaluate((node) => ({
    clientWidth: node.clientWidth,
    scrollWidth: node.scrollWidth,
    bodyWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
  }));
  expect(responsiveMetrics.scrollWidth).toBeGreaterThanOrEqual(responsiveMetrics.clientWidth);
  expect(responsiveMetrics.bodyWidth).toBeLessThanOrEqual(responsiveMetrics.viewportWidth);
  await setScreenshotTheme(page, "light");
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
  await page.screenshot({
    path: `${WS5_SCREENSHOT_DIR}/day-light-responsive-320.png`,
    animations: "disabled",
  });
});

test("appointment billing dialog submits once and shows pending feedback", async ({ page }) => {
  await login(page, emails.receptionist);
  await page.goto(`/appointments?view=day&date=${day}`);
  const appointment = page.getByText("Billing Smoke Patient");
  await expect(appointment).toBeVisible();
  await appointment.click();

  await page.getByRole("button", { name: /^complete$/i }).first().click();
  const dialog = page.getByRole("dialog", {
    name: /invoice.*complete appointment/i,
  });
  await expect(dialog).toBeVisible();
  await page.getByRole("button", { name: /custom line/i }).click();
  await dialog.getByPlaceholder("Custom service").fill("Smoke E2E line");
  await dialog.locator('input[type="number"]').first().fill("50");
  await page.getByLabel(/patient paid now/i).fill("50");

  const submit = page.getByRole("button", { name: /complete.*charge/i });
  await expect(submit).toBeEnabled();
  await delayNextMutation(page);
  await submit.click();
  await expect(submit).toBeDisabled();
  await expect(page.getByText(/appointment completed & charged/i)).toBeVisible();
});

test("settlement dialog validates totals and disables while submitting", async ({ page }) => {
  await login(page, emails.receptionist);
  await page.goto(`/patients/${ids.settlementPatient}`);
  const patientHeading = page.getByRole("heading", { level: 1 });
  await expect(patientHeading.getByText("Settlement Smoke Patient", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: /settle outstanding/i }).click();
  const dialog = page.getByRole("dialog", {
    name: /settle outstanding balance/i,
  });
  await expect(dialog).toBeVisible();
  await page.getByLabel(/amount/i).fill("80");
  await expect(page.getByText(/combined total exceeds outstanding/i)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /record payment/i })).toBeDisabled();

  await page.getByLabel(/amount/i).fill("75");
  const submit = page.getByRole("button", { name: /record payment/i });
  await expect(submit).toBeEnabled();
  await delayNextMutation(page);
  await submit.click();
  await expect(submit).toBeDisabled();
  await expect.poll(async () => {
    const result = await service.from("outstanding_settlements")
      .select("amount")
      .eq("clinic_id", ids.clinic)
      .eq("patient_id", ids.settlementPatient);
    return result.data?.reduce((sum, row) => sum + Number(row.amount), 0) ?? 0;
  }, { timeout: 15_000 }).toBe(75);
});

test("P2A: the language switcher really switches, and one account's language reaches no other", async ({ browser }) => {
  const operatorContext = await browser.newContext();
  const doctorContext = await browser.newContext();
  const receptionistContext = await browser.newContext();
  const operatorPage = await operatorContext.newPage();
  const doctorPage = await doctorContext.newPage();
  const receptionistPage = await receptionistContext.newPage();

  try {
    // Everyone starts on the English default.
    await loginOperator(operatorPage);
    await login(doctorPage, emails.doctor);
    await login(receptionistPage, emails.receptionist);
    for (const page of [operatorPage, doctorPage, receptionistPage]) {
      await expect(page.locator("html")).toHaveAttribute("lang", "en");
      await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
    }

    // The Platform Admin switches the operator dashboard to Arabic from the header slot. No sign-out,
    // no full reload — the root re-resolves lang/dir.
    await operatorPage.getByTestId("language-switcher-account").click();
    await operatorPage.getByRole("option", { name: "العربية" }).click();
    await expect(operatorPage.locator("html")).toHaveAttribute("lang", "ar");
    await expect(operatorPage.locator("html")).toHaveAttribute("dir", "rtl");
    // It survives a reload, i.e. it was persisted to the account and not just to the DOM.
    await operatorPage.reload();
    await expect(operatorPage.locator("html")).toHaveAttribute("lang", "ar");

    // The Platform Admin's language has absolutely no effect on any clinic user (§6.A).
    await doctorPage.reload();
    await expect(doctorPage.locator("html")).toHaveAttribute("lang", "en");

    // A clinic user switches their own language in Preferences.
    await doctorPage.goto("/preferences");
    await doctorPage.getByTestId("language-switcher-account").click();
    await doctorPage.getByRole("option", { name: "العربية" }).click();
    await expect(doctorPage.locator("html")).toHaveAttribute("lang", "ar");
    await expect(doctorPage.locator("html")).toHaveAttribute("dir", "rtl");

    // A Doctor on Arabic and a Receptionist on English use the same clinic simultaneously. There is
    // no clinic language: one user's choice moves nobody else.
    await receptionistPage.reload();
    await expect(receptionistPage.locator("html")).toHaveAttribute("lang", "en");
    await expect(receptionistPage.locator("html")).toHaveAttribute("dir", "ltr");

    // ...and no clinic user's language reaches the operator dashboard either.
    await operatorPage.reload();
    await expect(operatorPage.locator("html")).toHaveAttribute("lang", "ar");
  } finally {
    await operatorContext.close();
    await doctorContext.close();
    await receptionistContext.close();
  }
});

test("P2A: the anonymous marketing locale is independent of every account", async ({ page, browser }) => {
  // An anonymous visitor reads the marketing site in Arabic...
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("lang", "ar");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");

  // ...and that cookie must not become the language of the account they then sign in to. The
  // receptionist's stored preference is English, and it wins.
  await login(page, emails.receptionist);
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");

  // The marketing site stays Arabic for anonymous visitors on this browser.
  const anonContext = await browser.newContext();
  const anonPage = await anonContext.newPage();
  await anonPage.goto("/");
  await expect(anonPage.locator("html")).toHaveAttribute("lang", "ar"); // a fresh browser has no cookie
  await anonContext.close();
});

/* ────────────────────────────────────────────────────────────────────────────
 * P2B — RTL retrofit
 *
 * The retrofit's whole risk profile is that it is invisible in English. `pe-4` and `pr-4` render
 * identically under `dir="ltr"`, so the entire English suite — snapshots included — stays green
 * whether the conversion is right, wrong, or absent. These tests are therefore the only ones that
 * can actually fail on a bad retrofit: they drive a real browser in `dir="rtl"` and read back
 * *computed geometry*, not class names.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Switches the signed-in account to a locale through the real control, as a user would. */
async function setAccountLocale(page: Page, locale: "en" | "ar") {
  await page.goto("/preferences");
  await page.getByTestId("language-switcher-account").click();
  await page.getByRole("option", { name: locale === "ar" ? "العربية" : "English" }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", locale);
  await expect(page.locator('[data-sonner-toast][data-type="error"]')).toHaveCount(0);
}

/** The five highest-traffic clinic surfaces (§8, P2B "spot-check RTL rendering"). */
const RTL_PAGES = ["/dashboard", "/patients", "/appointments", "/settings/staff", "/revenue"] as const;

test("P2C: Arabic locale renders translated staff copy and keeps the authenticated session", async ({ page }, testInfo) => {
  await login(page, emails.receptionist);
  await setAccountLocale(page, "ar");
  await page.goto("/dashboard");

  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByText("حجز موعد", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Book appointment", { exact: true })).toHaveCount(0);
  await expect(page.getByTestId("dashboard-sidebar")).toBeVisible();

  await page.evaluate(() => document.fonts.ready);
  const typography = await page.evaluate(() => {
    const heading = document.querySelector("main h1");
    const action = Array.from(document.querySelectorAll("a, button")).find(
      (element) => element.textContent?.trim() === "حجز موعد",
    );
    if (!(heading instanceof HTMLElement) || !(action instanceof HTMLElement)) {
      throw new Error("Arabic dashboard typography probes are missing");
    }
    const headingStyle = getComputedStyle(heading);
    const actionStyle = getComputedStyle(action);
    return {
      actionFamily: actionStyle.fontFamily,
      actionWeight: Number(actionStyle.fontWeight),
      headingFamily: headingStyle.fontFamily,
      headingWeight: Number(headingStyle.fontWeight),
    };
  });
  expect(typography.headingFamily.toLowerCase()).toContain("thmanyah");
  expect(typography.actionFamily.toLowerCase()).toContain("thmanyah");
  expect(typography.headingFamily.toLowerCase()).not.toContain("plex");
  expect(typography.actionFamily.toLowerCase()).not.toContain("plex");
  expect(typography.headingWeight).toBe(700);
  expect(typography.actionWeight).toBeGreaterThanOrEqual(500);
  expect(typography.actionWeight).toBeLessThanOrEqual(700);

  if (process.env.ARABIC_TYPOGRAPHY_VISUALS === "1") {
    await page.screenshot({
      path: testInfo.outputPath("arabic-dashboard-typography.png"),
      animations: "disabled",
      fullPage: true,
    });
  }

  await setAccountLocale(page, "en");
  await page.goto("/dashboard");
  await expect(page.getByText("Book appointment", { exact: true }).first()).toBeVisible();
});

test("P2B: every high-traffic page is direction-safe — sidebar flips, nothing overflows", async ({ page }) => {
  await login(page, emails.doctor);

  // Locale now lives on the *account* (P2A), and these specs run serially — an earlier test
  // legitimately leaves this doctor in Arabic. Drive the starting locale rather than assume it.
  await setAccountLocale(page, "en");

  // ── Baseline: English. Record where things sit, so "RTL mirrors LTR" is a measured claim.
  const ltr: Record<string, { sidebarStart: number; overflow: number }> = {};
  for (const path of RTL_PAGES) {
    await page.goto(path);
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");

    const sidebar = page.getByTestId("dashboard-sidebar");
    const box = await sidebar.boundingBox();
    if (!box) throw new Error(`no sidebar on ${path}`);

    ltr[path] = {
      sidebarStart: box.x,
      overflow: await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    };

    // In English the sidebar hugs the left edge.
    expect(box.x, `${path} sidebar should start at the left edge in LTR`).toBeLessThan(8);
    expect(ltr[path].overflow, `${path} must not scroll horizontally in LTR`).toBeLessThanOrEqual(1);
  }

  // ── Switch to Arabic. Same account, same session, no sign-out.
  await setAccountLocale(page, "ar");

  for (const path of RTL_PAGES) {
    await page.goto(path);
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.locator("html")).toHaveAttribute("lang", "ar");

    const viewport = page.viewportSize();
    if (!viewport) throw new Error("no viewport");

    const sidebar = page.getByTestId("dashboard-sidebar");
    const box = await sidebar.boundingBox();
    if (!box) throw new Error(`no sidebar on ${path} in RTL`);

    // The sidebar must have crossed to the right edge. This is the single loudest RTL signal: if
    // the shell's insets were still physical, the sidebar would not move at all.
    expect(box.x + box.width, `${path} sidebar should reach the right edge in RTL`).toBeGreaterThan(
      viewport.width - 8,
    );
    expect(box.x, `${path} sidebar should not be on the left in RTL`).toBeGreaterThan(viewport.width / 2);

    // Horizontal overflow is how a missed physical property announces itself: a stray `left-0` or an
    // unflipped margin pushes content past the viewport and the page gains a scrollbar it never had
    // in English.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${path} must not scroll horizontally in RTL`).toBeLessThanOrEqual(1);
  }
});

test("P2B: logical properties and directional icons actually resolve under dir=rtl", async ({ page }) => {
  await login(page, emails.receptionist);
  await setAccountLocale(page, "en");

  // The calendar's day-nav chevrons are the retrofit's canonical directional icons, and unlike the
  // patient pagination they are always rendered regardless of how much data the clinic has.
  await page.goto("/appointments?view=day");
  const chevron = page.locator('[aria-label="Next day"] svg');
  await expect(chevron).toBeVisible();

  // Tailwind v4 compiles `rotate-180` to the standalone `rotate` property, not to `transform`.
  // LTR: the chevron is not mirrored.
  expect(await chevron.evaluate((node) => getComputedStyle(node).rotate)).toBe("none");

  await setAccountLocale(page, "ar");
  await page.goto("/appointments?view=day");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");

  // RTL: `rtl:rotate-180` must have produced a real half-turn, so "next" points the other way.
  const rotated = await page
    .locator('[aria-label="في اليوم التالي"] svg')
    .evaluate((node) => getComputedStyle(node).rotate);
  expect(rotated).toBe("180deg");

  // And a logical spacing utility must resolve to the mirrored physical side. `ms-auto` is
  // margin-left in English; under dir=rtl the very same class must compute to margin-right.
  const mirrored = await page.evaluate(() => {
    const probe = document.createElement("div");
    // `rtl:-scale-x-100` is the mirror used for diagonal glyphs (ArrowUpRight, Send, ExternalLink),
    // where a 180° rotation would point them down-left instead of flipping them.
    probe.className = "ms-4 pe-8 text-end rtl:-scale-x-100";
    document.body.appendChild(probe);
    const style = getComputedStyle(probe);
    const result = {
      marginLeft: style.marginLeft,
      marginRight: style.marginRight,
      paddingLeft: style.paddingLeft,
      paddingRight: style.paddingRight,
      textAlign: style.textAlign,
      scale: style.scale,
    };
    probe.remove();
    return result;
  });

  // ms-4 → margin-inline-start → margin-RIGHT in RTL (and 0 on the left).
  expect(mirrored.marginRight).toBe("16px");
  expect(mirrored.marginLeft).toBe("0px");
  // pe-8 → padding-inline-end → padding-LEFT in RTL.
  expect(mirrored.paddingLeft).toBe("32px");
  expect(mirrored.paddingRight).toBe("0px");
  // text-end → right in English, left here.
  expect(mirrored.textAlign).toMatch(/^(right|end)$/);
  // The horizontal-flip mirror resolves under dir=rtl (x negated, y untouched).
  expect(mirrored.scale).toMatch(/^-1 1$/);
});

test("P2B: the mobile nav drawer opens from the inline start in both directions", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, emails.doctor);
  await setAccountLocale(page, "en");

  // English: the drawer is anchored to the left.
  await page.goto("/dashboard");
  await page.getByRole("button", { name: "Open navigation" }).click();
  const ltrDrawer = page.locator('[data-slot="sheet-content"]');
  await expect(ltrDrawer).toBeVisible();
  await expect(ltrDrawer).toHaveAttribute("data-side", "inline-start");

  const ltrBox = await ltrDrawer.boundingBox();
  if (!ltrBox) throw new Error("no drawer in LTR");
  expect(ltrBox.x, "drawer should hug the left edge in English").toBeLessThan(8);
  await page.keyboard.press("Escape");

  // Arabic: the *same* `inline-start` anchor must now resolve to the right edge. A physical
  // `side="left"` would have left the drawer exactly where it was.
  await setAccountLocale(page, "ar");
  await page.goto("/dashboard");
  await page.getByRole("button", { name: "افتح التنقل" }).click();

  const rtlDrawer = page.locator('[data-slot="sheet-content"]');
  await expect(rtlDrawer).toBeVisible();
  const rtlBox = await rtlDrawer.boundingBox();
  if (!rtlBox) throw new Error("no drawer in RTL");
  expect(rtlBox.x + rtlBox.width, "drawer should hug the right edge in Arabic").toBeGreaterThan(390 - 8);
});

test("P2B: the marketing site is direction-safe for an anonymous visitor", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("language-switcher-marketing").click();
  await page.getByRole("option", { name: "English" }).click();
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  const ltrOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(ltrOverflow).toBeLessThanOrEqual(1);

  await page.getByTestId("language-switcher-marketing").click();
  await page.getByRole("option", { name: "العربية" }).click();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");

  const rtlOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(rtlOverflow, "the landing page must not scroll horizontally in RTL").toBeLessThanOrEqual(1);
});
