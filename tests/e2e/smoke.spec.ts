import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
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
  billingPatient: randomUUID(),
  settlementPatient: randomUUID(),
  billingAppointment: randomUUID(),
  settlementAppointment: randomUUID(),
  service: randomUUID(),
};

const emails = {
  receptionist: `${suffix}-receptionist@example.com`,
  forced: `${suffix}-forced@example.com`,
  doctor: `${suffix}-doctor@example.com`,
  operator: `${suffix}-operator@example.com`,
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
  await service.from("subscriptions").delete().eq("clinic_id", ids.clinic);
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
  ]));
  await must(service.from("appointment_services").insert({
    clinic_id: ids.clinic,
    appointment_id: ids.settlementAppointment,
    service_id: ids.service,
    name: "Smoke Consultation",
    price: 100,
    quantity: 1,
  }));
}

async function deleteAuthUsers() {
  for (const id of [ids.receptionist, ids.forced, ids.doctor, ids.operator].filter(Boolean)) {
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
  await expect(page.getByRole("navigation", { name: /clinicflow navigation/i })).toBeVisible();
  await expect(page.getByRole("link", { name: /patients/i })).toBeVisible();
  await page.getByRole("button", { name: /open user menu/i }).click();
  await page.getByRole("menuitem", { name: /sign out/i }).click();
  await expect(page).toHaveURL(/\/login/);
});

test("operator shell renders and persists theme without a clinic profile", async ({ page }) => {
  await loginOperator(page);
  await expect(page.getByRole("navigation", { name: /clinicflow operator navigation/i })).toBeVisible();
  await expect(page.getByText(/registration mode:/i)).toBeVisible();
  await expect(page.getByText(/active clinics/i)).toBeVisible();
  await expect(page.getByTestId("dashboard-sidebar").getByRole("link", { name: /clinics/i })).toBeVisible();
  await page.getByRole("button", { name: /switch to dark mode/i }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect.poll(async () => (await page.context().cookies()).find((cookie) => cookie.name === "theme")?.value).toBe("dark");
  await page.goto("/operator/clinics");
  await expect(page).toHaveURL(/\/operator\/clinics/);
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.reload();
  await expect(page.locator("html")).toHaveClass(/dark/);
});

test("forced password users are redirected to change-password", async ({ page }) => {
  await login(page, emails.forced);
  await expect(page).toHaveURL(/\/change-password/);
  await expect(
    page.getByRole("heading", { name: /set a new password/i }),
  ).toBeVisible();
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
  await expect(page.getByText("Settlement Smoke Patient")).toBeVisible();

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
