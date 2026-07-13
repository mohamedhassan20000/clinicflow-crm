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
  await page.getByLabel(/email/i).fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/(dashboard|change-password)/);
}

async function loginOperator(page: Page) {
  await page.goto("/login");
  await page.getByLabel(/email/i).fill(emails.operator);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();
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

const WS5_SCREENSHOT_DIR = "docs/reviews/assets/pre-p2-ws5";
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

  // WS1 (BUG-2): the collapse toggle must be fully visible (not painted over by
  // the sticky header) and operable in both states, with a ≥44px hit target.
  const sidebar = page.getByTestId("dashboard-sidebar");
  const toggle = page.getByRole("button", { name: /collapse sidebar/i });
  await expect(toggle).toBeVisible();
  const box = await toggle.boundingBox();
  expect(box, "toggle bounding box").not.toBeNull();
  const sidebarBox = await sidebar.boundingBox();
  // Overhang design: the button straddles the sidebar edge and must extend past it
  expect(box!.x + box!.width).toBeGreaterThan(sidebarBox!.x + sidebarBox!.width);
  // Painted-over check: the point at the button's center (in the header's column)
  // must hit the button itself, not the header.
  const hit = await page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y);
    return el?.closest("button")?.getAttribute("aria-label") ?? el?.tagName ?? null;
  }, { x: box!.x + box!.width - 2, y: box!.y + box!.height / 2 });
  expect(hit).toMatch(/collapse sidebar/i);
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await toggle.click();
  await expect(sidebar).toHaveAttribute("data-collapsed", "true");
  const expandToggle = page.getByRole("button", { name: /expand sidebar/i });
  await expect(expandToggle).toBeVisible();
  await expect(expandToggle).toHaveAttribute("aria-expanded", "false");
  // Keyboard: focus + Enter toggles back to expanded
  await expandToggle.focus();
  await page.keyboard.press("Enter");
  await expect(sidebar).toHaveAttribute("data-collapsed", "false");

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
  await page.getByRole("combobox", { name: "Country calling code" }).click();
  await page.getByPlaceholder(/search country/i).fill("United Kingdom");
  await page.getByRole("option", { name: /United Kingdom/ }).click();
  await page.getByPlaceholder("Local number").fill("2079460000");
  await page.getByPlaceholder("owner@example.com").fill(gbEmail);
  await page.getByRole("checkbox", { name: "Override the weekly limit" }).check();
  await page.getByRole("button", { name: "Create & issue" }).click();
  await expect(page.getByText(gbEmail)).toBeVisible();
  const gbInvitation = await service.from("clinic_invitations").select("phone").eq("email", gbEmail).single();
  expect(gbInvitation.data?.phone).toBe("+442079460000");
  await service.from("clinic_invitations").delete().eq("email", gbEmail);
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
  await sortLink.click();
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

  await page.getByRole("link", { name: "Clear filters" }).click();
  await expect
    .poll(() => new URL(page.url()).searchParams.get("country"))
    .toBe("all");
  await expect(page.getByRole("combobox", { name: "Country" })).toContainText("All");
});

test("WS6 operator clinic detail returns to the filtered list by keyboard on mobile and both themes", async ({ page }) => {
  await loginOperator(page);
  const clinicResult = await service.from("clinics").select("country").eq("id", ids.clinic).single();
  if (clinicResult.error) throw new Error(clinicResult.error.message);
  const country = clinicResult.data.country;

  await page.goto(`/operator/clinics?q=Smoke%20Clinic&country=${country}`);
  await expect(page.getByLabel("Search clinics")).toHaveValue("Smoke Clinic");
  await expect(page.getByLabel("Country code")).toHaveValue(country);
  await expect(page.locator("html")).not.toHaveClass(/dark/);

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
