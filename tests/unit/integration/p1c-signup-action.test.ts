import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Database } from "@/types/database";

const url = process.env.LOCAL_SUPABASE_URL ?? "http://127.0.0.1:54321";
function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const publishableKey = required("LOCAL_SUPABASE_PUBLISHABLE_KEY");
const secretKey = required("LOCAL_SUPABASE_SECRET_KEY");
process.env.NEXT_PUBLIC_SUPABASE_URL = url;
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = publishableKey;
process.env.SUPABASE_SERVICE_ROLE_KEY = secretKey;
process.env.NEXT_PUBLIC_SITE_URL = "http://127.0.0.1:3000";

const service = createClient<Database>(url, secretKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const password = "P1cAction123";
const authUserIds: string[] = [];
const clinicIds: string[] = [];
const invitationIds: string[] = [];
let signUpClinic: typeof import("@/actions/auth")["signUpClinic"];

function publicClient() {
  return createClient<Database>(url, publishableKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storageKey: `p1c-action-${crypto.randomUUID()}`,
    },
  });
}

function signupForm(email: string, submittedPassword = password, token?: string) {
  const form = new FormData();
  form.set("clinicName", `Action Clinic ${suffix}`);
  form.set("country", "KW");
  form.set("phone", "50001000");
  form.set("ownerName", "Action Owner");
  form.set("email", email);
  form.set("password", submittedPassword);
  form.set("locale", "ar");
  if (token) form.set("token", token);
  return form;
}

async function seedOrphan(label: string, emailConfirmed = true) {
  const email = `p1c-action-${suffix}-${label}@example.com`;
  const result = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: emailConfirmed,
    user_metadata: { signup_flow: "clinic_owner" },
  });
  if (result.error || !result.data.user) throw result.error;
  authUserIds.push(result.data.user.id);
  const rawToken = `p1c-action-token-${suffix}-${label}`;
  const invitation = await service.from("clinic_invitations").insert({
    clinic_name: `Action Clinic ${suffix}`,
    owner_name: "Action Owner",
    phone: "50001000",
    email,
    token_hash: createHash("sha256").update(rawToken).digest("hex"),
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  }).select("id").single();
  if (invitation.error) throw invitation.error;
  invitationIds.push(invitation.data.id);
  return { user: result.data.user, rawToken };
}

beforeAll(async () => {
  vi.doMock("next/cache", () => ({ revalidatePath: vi.fn() }));
  vi.doMock("next/navigation", () => ({
    redirect: vi.fn((url: string) => {
      throw new Error(`REDIRECT:${url}`);
    }),
  }));
  vi.doMock("next/headers", () => ({
    headers: vi.fn(async () => new Headers({ host: "127.0.0.1:3000" })),
  }));
  vi.doMock("@/lib/rate-limit", () => ({
    checkRateLimit: vi.fn(async () => ({
      allowed: true,
      retryAfterSeconds: 0,
      backendAvailable: true,
    })),
  }));
  vi.doMock("@/lib/supabase/server", () => ({
    createClient: vi.fn(async () => publicClient()),
  }));
  ({ signUpClinic } = await import("@/actions/auth"));
});

afterAll(async () => {
  await service.from("platform_settings").update({ registration_mode: "invite_only" }).eq("id", true);
  await service.from("subscriptions").delete().in("clinic_id", clinicIds);
  await service.from("profiles").delete().in("id", authUserIds);
  await service.from("clinic_invitations").delete().in("id", invitationIds);
  await service.from("clinics").delete().in("id", clinicIds);
  await Promise.all(authUserIds.map((id) => service.auth.admin.deleteUser(id)));
  vi.doUnmock("next/cache");
  vi.doUnmock("next/navigation");
  vi.doUnmock("next/headers");
  vi.doUnmock("@/lib/rate-limit");
  vi.doUnmock("@/lib/supabase/server");
});

describe("P1C signup action secure resume", () => {
  it("resumes a seeded owner orphan only after the correct password proves control", async () => {
    const orphan = await seedOrphan("resume-correct");

    await expect(
      signUpClinic(null, signupForm(orphan.user.email!, password, orphan.rawToken)),
    ).rejects.toThrow("REDIRECT:/signup/complete");
    const profile = await service.from("profiles").select("clinic_id, role").eq("id", orphan.user.id).single();
    expect(profile.error).toBeNull();
    expect(profile.data?.role).toBe("admin");
    clinicIds.push(profile.data!.clinic_id);
  });

  it("does not resume or provision a confirmed orphan when the password is wrong", async () => {
    const orphan = await seedOrphan("resume-wrong");

    const result = await signUpClinic(null, signupForm(orphan.user.email!, "WrongPass123", orphan.rawToken));

    expect(result.error).toBe("An account already exists for this email. Sign in or reset its password.");
    const profile = await service.from("profiles").select("id").eq("id", orphan.user.id);
    expect(profile.data).toHaveLength(0);
  });

  // NOTE: the local stack runs with mailer autoconfirm (enable_confirmations =
  // false) and without email-enumeration protection, so signUp returns an
  // existing unconfirmed orphan directly instead of the production duplicate
  // signal. These tests therefore assert environment-independent outcomes
  // (resume without a duplicate clinic, no account takeover); the
  // production-only resume branches (email_not_confirmed proof, token-bound
  // password reclaim) are covered by tests/unit/actions/p1c-signup-errors.test.ts.
  it("resumes an unconfirmed orphan without creating a duplicate clinic", async () => {
    const orphan = await seedOrphan("resume-unconfirmed", false);

    await expect(
      signUpClinic(null, signupForm(orphan.user.email!, password, orphan.rawToken)),
    ).rejects.toThrow("REDIRECT:/signup/complete");

    const profile = await service.from("profiles").select("clinic_id, role").eq("id", orphan.user.id).single();
    expect(profile.error).toBeNull();
    expect(profile.data?.role).toBe("admin");
    clinicIds.push(profile.data!.clinic_id);
    const clinics = await service.from("clinics").select("id").eq("id", profile.data!.clinic_id);
    expect(clinics.data).toHaveLength(1);
  });

  it("never lets a signup retry with a different password take over an unconfirmed orphan's login", async () => {
    const orphan = await seedOrphan("resume-retry-password", false);

    const result = await signUpClinic(
      null,
      signupForm(orphan.user.email!, "DifferentPass123", orphan.rawToken),
    ).catch((error: Error) => error);

    // Whichever path the environment takes (direct resume locally, token
    // reclaim in production), the retry must never leave the orphan
    // sign-in-able with a password its owner did not just submit: exactly one
    // of the two candidate passwords may work.
    await service.auth.admin.updateUserById(orphan.user.id, { email_confirm: true });
    const relog = publicClient();
    const oldAttempt = await relog.auth.signInWithPassword({ email: orphan.user.email!, password });
    const newAttempt = await relog.auth.signInWithPassword({ email: orphan.user.email!, password: "DifferentPass123" });
    expect([oldAttempt.error, newAttempt.error].filter(Boolean)).toHaveLength(1);
    await relog.auth.signOut();

    if (result instanceof Error) {
      expect(result.message).toBe("REDIRECT:/signup/complete");
      const profile = await service.from("profiles").select("clinic_id").eq("id", orphan.user.id).single();
      expect(profile.error).toBeNull();
      clinicIds.push(profile.data!.clinic_id);
    }
  });
});
