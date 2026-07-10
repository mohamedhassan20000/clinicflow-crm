import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { afterAll, describe, expect, it } from "vitest";
import type { Database } from "@/types/database";

const url = process.env.LOCAL_SUPABASE_URL ?? "http://127.0.0.1:54321";
function required(name: string) { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value; }
const anon = createClient<Database>(url, required("LOCAL_SUPABASE_PUBLISHABLE_KEY"), { auth: { persistSession: false, storageKey: `p1c-anon-${crypto.randomUUID()}` } });
const service = createClient<Database>(url, required("LOCAL_SUPABASE_SECRET_KEY"), { auth: { persistSession: false } });
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const userIds: string[] = [];
const invitationIds: string[] = [];
const clinicIds: string[] = [];
const couponIds: string[] = [];
const hash = (token: string) => createHash("sha256").update(token).digest("hex");

async function user(label: string) {
  const result = await service.auth.admin.createUser({ email: `p1c-${suffix}-${label}@example.com`, password: "P1cTest123", email_confirm: true, user_metadata: { signup_flow: "clinic_owner" } });
  if (result.error || !result.data.user) throw result.error;
  userIds.push(result.data.user.id); return result.data.user;
}

afterAll(async () => {
  await service.from("coupon_redemptions").delete().in("clinic_id", clinicIds);
  await service.from("coupons").delete().in("id", couponIds);
  await service.from("subscriptions").delete().in("clinic_id", clinicIds);
  await service.from("profiles").delete().in("id", userIds);
  await service.from("clinic_invitations").delete().in("id", invitationIds);
  await service.from("clinics").delete().in("id", clinicIds);
  await Promise.all(userIds.map((id) => service.auth.admin.deleteUser(id)));
});

describe("P1C public and atomic signup boundaries", () => {
  it("exposes exactly the approved public registration fields", async () => {
    const result = await anon.rpc("get_public_registration_status");
    expect(result.error).toBeNull();
    expect(Object.keys(result.data![0]).sort()).toEqual(["accepted_clinics_this_week", "registration_mode", "weekly_invite_limit"]);
  });

  it("denies direct public writes and silently deduplicates service-bound requests", async () => {
    const email = `P1C-${suffix}@Example.com`;
    const direct = await anon.rpc("request_clinic_invitation", { p_clinic_name: "Clinic", p_owner_name: "Owner", p_phone: "50000000", p_email: email });
    expect(direct.error).not.toBeNull();
    const first = await service.rpc("request_clinic_invitation", { p_clinic_name: "Clinic", p_owner_name: "Owner", p_phone: "50000000", p_email: email });
    const second = await service.rpc("request_clinic_invitation", { p_clinic_name: "Changed", p_owner_name: "Changed", p_phone: "50000001", p_email: email.toLowerCase() });
    expect(first.error).toBeNull(); expect(second.error).toBeNull(); expect(second.data).toBe(first.data);
    invitationIds.push(first.data!);
  });

  it("allows exactly one concurrent redemption and creates the complete trial graph", async () => {
    const beforeStatus = await anon.rpc("get_public_registration_status");
    const acceptedBefore = Number(beforeStatus.data![0].accepted_clinics_this_week);
    const raw = `token-${suffix}`;
    const invitedEmail = `p1c-${suffix}-race-a@example.com`;
    const invitation = await service.from("clinic_invitations").insert({ clinic_name: "Race Clinic", owner_name: "Owner", phone: "50000002", email: invitedEmail, token_hash: hash(raw), expires_at: new Date(Date.now() + 86_400_000).toISOString() }).select("id").single();
    if (invitation.error) throw invitation.error; invitationIds.push(invitation.data.id);
    const [a, b] = await Promise.all([user("race-a"), user("race-b")]);
    const args = (id: string, email: string) => ({ p_owner_id: id, p_invitation_token_hash: hash(raw), p_clinic_name: "Race Clinic", p_country: "KW", p_phone: "50000002", p_owner_name: "Owner", p_owner_email: email, p_locale: "ar" });
    const results = await Promise.all([service.rpc("create_clinic_with_owner", args(a.id, a.email!)), service.rpc("create_clinic_with_owner", args(b.id, b.email!))]);
    const success = results.filter((result) => !result.error);
    expect(success).toHaveLength(1); clinicIds.push(success[0].data!);
    const graph = await Promise.all([
      service.from("profiles").select("id").eq("clinic_id", success[0].data!),
      service.from("subscriptions").select("status, trial_ends_at").eq("clinic_id", success[0].data!),
      service.from("user_page_permissions").select("page_slug").eq("clinic_id", success[0].data!),
    ]);
    expect(graph[0].data).toHaveLength(1); expect(graph[1].data?.[0].status).toBe("trialing"); expect(graph[2].data).toHaveLength(7);
    const accepted = await service.from("clinic_invitations").select("status, accepted_at").eq("id", invitation.data.id).single();
    expect(accepted.data?.status).toBe("accepted"); expect(accepted.data?.accepted_at).not.toBeNull();
    const afterStatus = await anon.rpc("get_public_registration_status");
    expect(Number(afterStatus.data![0].accepted_clinics_this_week)).toBe(acceptedBefore + 1);
  });

  it("admits tokenless signup immediately in open mode without changing invite progress", async () => {
    const before = await anon.rpc("get_public_registration_status");
    const acceptedBefore = Number(before.data![0].accepted_clinics_this_week);
    const opened = await service.from("platform_settings").update({ registration_mode: "open" }).eq("id", true);
    if (opened.error) throw opened.error;
    const owner = await user("open");
    const result = await service.rpc("create_clinic_with_owner", {
      p_owner_id: owner.id,
      p_clinic_name: "Open Clinic", p_country: "KW", p_phone: "50000004",
      p_owner_name: "Open Owner", p_owner_email: owner.email!, p_locale: "ar",
    });
    await service.from("platform_settings").update({ registration_mode: "invite_only" }).eq("id", true);
    expect(result.error).toBeNull(); clinicIds.push(result.data!);
    const after = await anon.rpc("get_public_registration_status");
    expect(Number(after.data![0].accepted_clinics_this_week)).toBe(acceptedBefore);
  });

  it("denies authenticated callers because the signup RPC is service-role only", async () => {
    const caller = await user("ordinary");
    const signed = createClient<Database>(url, required("LOCAL_SUPABASE_PUBLISHABLE_KEY"), { auth: { persistSession: false, storageKey: `p1c-signed-${crypto.randomUUID()}` } });
    await signed.auth.signInWithPassword({ email: caller.email!, password: "P1cTest123" });
    const result = await signed.rpc("create_clinic_with_owner", { p_owner_id: caller.id, p_invitation_token_hash: "x", p_clinic_name: "Denied", p_country: "KW", p_phone: "50000003", p_owner_name: "Denied", p_owner_email: caller.email!, p_locale: "ar" });
    expect(result.error).not.toBeNull();
    const lookup = await signed.rpc("find_resumable_clinic_owner", {
      p_email: caller.email!,
    });
    expect(lookup.error).not.toBeNull();
  });

  it("returns the same clinic for an idempotent retry by the same owner", async () => {
    const owner = await user("idempotent");
    const opened = await service.from("platform_settings").update({ registration_mode: "open" }).eq("id", true);
    if (opened.error) throw opened.error;
    const args = {
      p_owner_id: owner.id, p_clinic_name: "Idempotent Clinic", p_country: "KW",
      p_phone: "50000008", p_owner_name: "Owner", p_owner_email: owner.email!, p_locale: "ar",
    };
    const first = await service.rpc("create_clinic_with_owner", args);
    const second = await service.rpc("create_clinic_with_owner", { ...args, p_clinic_name: "Ignored Retry Name" });
    await service.from("platform_settings").update({ registration_mode: "invite_only" }).eq("id", true);
    expect(first.error).toBeNull(); expect(second.error).toBeNull();
    expect(second.data).toBe(first.data); clinicIds.push(first.data!);
    const clinics = await service.from("clinics").select("id, name").eq("id", first.data!);
    expect(clinics.data).toEqual([{ id: first.data, name: "Idempotent Clinic" }]);
  });

  it("rejects expired and revoked tokens through the public validation boundary", async () => {
    const rows = await service.from("clinic_invitations").insert([
      { clinic_name: "Expired", owner_name: "Owner", phone: "50000005", email: `expired-${suffix}@example.com`, status: "pending", token_hash: hash(`expired-${suffix}`), expires_at: new Date(Date.now() - 1000).toISOString() },
      { clinic_name: "Revoked", owner_name: "Owner", phone: "50000006", email: `revoked-${suffix}@example.com`, status: "revoked", revoked_at: new Date().toISOString() },
    ]).select("id");
    if (rows.error) throw rows.error; invitationIds.push(...rows.data.map((row) => row.id));
    const expired = await anon.rpc("validate_clinic_signup", { p_token_hash: hash(`expired-${suffix}`) });
    expect(expired.data?.[0]).toMatchObject({ allowed: false, reason: "INVITATION_INVALID" });
  });

  it("skips an expected invalid invitation coupon without bricking signup", async () => {
    const owner = await user("coupon-skip");
    const raw = `coupon-skip-${suffix}`;
    const invitation = await service.from("clinic_invitations").insert({
      clinic_name: "Rollback Clinic", owner_name: "Owner", phone: "50000007",
      email: owner.email!, token_hash: hash(raw), expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    }).select("id").single();
    if (invitation.error) throw invitation.error; invitationIds.push(invitation.data.id);
    const coupon = await service.from("coupons").insert({
      code: `P1C${suffix.replace(/[^A-Za-z0-9]/g, "").toUpperCase()}SKIP`.slice(0, 64),
      kind: "months_free", months: 1, invitation_id: invitation.data.id,
      expires_at: new Date(Date.now() - 1000).toISOString(),
    }).select("id").single();
    if (coupon.error) throw coupon.error; couponIds.push(coupon.data.id);
    const result = await service.rpc("create_clinic_with_owner", {
      p_owner_id: owner.id, p_invitation_token_hash: hash(raw), p_clinic_name: "Coupon Skip Clinic",
      p_country: "KW", p_phone: "50000007", p_owner_name: "Owner", p_owner_email: owner.email!, p_locale: "ar",
    });
    expect(result.error).toBeNull(); clinicIds.push(result.data!);
    const [profile, invitationAfter, redemptions] = await Promise.all([
      service.from("profiles").select("id").eq("id", owner.id),
      service.from("clinic_invitations").select("status, accepted_at").eq("id", invitation.data.id).single(),
      service.from("coupon_redemptions").select("id").eq("coupon_id", coupon.data.id),
    ]);
    expect(profile.data).toHaveLength(1);
    expect(invitationAfter.data?.status).toBe("accepted");
    expect(redemptions.data).toHaveLength(0);
  });

  it("rolls back the entire database graph on an unexpected provisioning failure", async () => {
    const owner = await user("rollback");
    const raw = `rollback-${suffix}`;
    const invitation = await service.from("clinic_invitations").insert({
      clinic_name: "Rollback Clinic", owner_name: "Owner", phone: "50000009",
      email: owner.email!, token_hash: hash(raw), expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    }).select("id").single();
    if (invitation.error) throw invitation.error; invitationIds.push(invitation.data.id);
    const plan = await service.from("plans").update({ is_active: false }).eq("slug", "basic");
    if (plan.error) throw plan.error;
    const result = await service.rpc("create_clinic_with_owner", {
      p_owner_id: owner.id, p_invitation_token_hash: hash(raw), p_clinic_name: "Rollback Clinic",
      p_country: "KW", p_phone: "50000009", p_owner_name: "Owner", p_owner_email: owner.email!, p_locale: "ar",
    });
    await service.from("plans").update({ is_active: true }).eq("slug", "basic");
    expect(result.error?.message).toContain("BASIC_PLAN_NOT_FOUND");
    const [profile, invitationAfter] = await Promise.all([
      service.from("profiles").select("id").eq("id", owner.id),
      service.from("clinic_invitations").select("status, accepted_at").eq("id", invitation.data.id).single(),
    ]);
    expect(profile.data).toHaveLength(0);
    expect(invitationAfter.data).toMatchObject({ status: "pending", accepted_at: null });
  });
});
