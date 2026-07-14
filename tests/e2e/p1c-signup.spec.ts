import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

const url = process.env.LOCAL_SUPABASE_URL ?? "http://127.0.0.1:54321";
function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set for P1C E2E tests.`);
  return value;
}
const service = createClient<Database>(url, required("LOCAL_SUPABASE_SECRET_KEY"), {
  auth: { persistSession: false, autoRefreshToken: false },
});
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const email = `p1c-e2e-${suffix}@example.com`;
const password = "P1cE2eTest123";
const rawToken = `p1c-e2e-token-${suffix}`;
let invitationId: string | null = null;
let expiredSessionRequestId: string | null = null;
let userId: string | null = null;
let clinicId: string | null = null;

test.describe.configure({ mode: "serial" });

test.afterAll(async () => {
  if (userId) {
    const profile = await service.from("profiles").select("clinic_id").eq("id", userId).maybeSingle();
    clinicId = clinicId ?? profile.data?.clinic_id ?? null;
  }
  if (clinicId) await service.from("clinics").delete().eq("id", clinicId);
  if (invitationId) await service.from("clinic_invitations").delete().eq("id", invitationId);
  if (expiredSessionRequestId) await service.from("clinic_invitations").delete().eq("id", expiredSessionRequestId);
  if (userId) await service.auth.admin.deleteUser(userId);
});

test("request → issued invite → verified signup → onboarding → dashboard", async ({ page }) => {
  await service.from("platform_settings").update({ registration_mode: "invite_only" }).eq("id", true);

  await page.goto("/early-access");
  await expect(page).toHaveURL(/\/#early-access$/);
  await page.getByRole("button", { name: "Request an invitation" }).click();
  await page.getByLabel("Clinic name").fill(`P1C E2E Clinic ${suffix}`);
  await page.getByLabel("Owner name").fill("P1C E2E Owner");
  await page.getByLabel("Phone").fill("50003000");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Request invitation" }).click();
  await expect(page.getByRole("heading", { name: "Request received" })).toBeVisible();

  const request = await service.from("clinic_invitations")
    .select("id, status, token_hash")
    .eq("email", email)
    .eq("status", "pending")
    .single();
  if (request.error) throw request.error;
  invitationId = request.data.id;
  expect(request.data.token_hash).toBeNull();

  const issued = await service.from("clinic_invitations").update({
    token_hash: createHash("sha256").update(rawToken).digest("hex"),
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  }).eq("id", invitationId);
  if (issued.error) throw issued.error;

  await page.goto(`/signup/${rawToken}`);
  await page.getByLabel("Clinic phone").fill("50003000");
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Create clinic" }).click();
  await expect(page).toHaveURL(/\/signup\/complete$/);
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();

  const users = await service.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const owner = users.data.users.find((user) => user.email === email);
  expect(owner).toBeTruthy();
  userId = owner!.id;
  // Local Supabase disables confirmation emails. Explicitly verify/confirm the
  // test user here so this step models production's required email-link gate.
  if (!owner!.email_confirmed_at) {
    const confirmation = await service.auth.admin.updateUserById(owner!.id, { email_confirm: true });
    if (confirmation.error) throw confirmation.error;
  }

  await page.context().clearCookies();
  await page.goto("/login");
  await page.getByLabel(/email/i).fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/onboarding$/);
  await expect(page.getByRole("heading", { name: "Build your clinic workspace" })).toBeVisible();

  await page.getByRole("button", { name: "Complete setup" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);

  const profile = await service.from("profiles").select("clinic_id").eq("id", userId).single();
  if (profile.error) throw profile.error;
  clinicId = profile.data.clinic_id;
  const clinic = await service.from("clinics").select("onboarding_completed_at").eq("id", clinicId).single();
  expect(clinic.data?.onboarding_completed_at).not.toBeNull();
});

test("expired-subscription user can submit the public root dialog", async ({ page }) => {
  expect(clinicId).toBeTruthy();
  const expiredEmail = `p15c-expired-${suffix}@example.com`;
  const expired = await service
    .from("subscriptions")
    .update({ status: "cancelled", trial_ends_at: new Date(0).toISOString() })
    .eq("clinic_id", clinicId!);
  if (expired.error) throw expired.error;

  await page.goto("/");
  await page.waitForLoadState("networkidle");
  const requestInvitation = page.getByRole("button", {
    name: "Request an invitation",
  });
  await expect(requestInvitation).toBeEnabled();
  await requestInvitation.click();
  await expect(requestInvitation).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByLabel("Clinic name").fill(`Expired Session Clinic ${suffix}`);
  await page.getByLabel("Owner name").fill("Expired Session Owner");
  await page.getByLabel("Phone").fill("50004000");
  await page.getByLabel("Email").fill(expiredEmail);
  await page.getByRole("button", { name: "Request invitation" }).click();
  await expect(page.getByRole("heading", { name: "Request received" })).toBeVisible();

  const request = await service
    .from("clinic_invitations")
    .select("id")
    .eq("email", expiredEmail)
    .eq("status", "pending")
    .single();
  if (request.error) throw request.error;
  expiredSessionRequestId = request.data.id;
});
