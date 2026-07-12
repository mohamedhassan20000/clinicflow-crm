"use server";

import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { issuanceBlocked } from "@/lib/operator";
import { requireMutationRole, requirePlatformAdmin } from "@/lib/rbac";
import { checkRateLimit } from "@/lib/rate-limit";
import { createClient } from "@/lib/supabase/server";
import { requestClinicInvitation } from "@/lib/supabase/admin";
import { hashInvitationToken, normalizeEmail, normalizePhone, requestIp } from "@/lib/signup";
import { logOperatorAction } from "@/lib/platform-audit";

export type PublicActionResult = {
  ok?: boolean;
  error?: string;
  fieldErrors?: Record<string, string[]>;
  rawToken?: string;
  invitationId?: string;
  invitationEmail?: string;
};

const requestSchema = z.object({
  clinicName: z.string().trim().min(1).max(200),
  ownerName: z.string().trim().min(1).max(200),
  phone: z.string().trim().min(3).max(50),
  phoneCountry: z.string().trim().length(2),
  email: z.string().trim().email().max(320),
});

export async function requestEarlyAccess(
  _previous: PublicActionResult | null,
  formData: FormData,
): Promise<PublicActionResult> {
  const parsed = requestSchema.safeParse({
    clinicName: formData.get("clinicName"),
    ownerName: formData.get("ownerName"),
    phone: formData.get("phone"), phoneCountry: formData.get("phoneCountry"),
    email: formData.get("email"),
  });
  if (!parsed.success) return { fieldErrors: parsed.error.flatten().fieldErrors };
  const normalizedPhone = normalizePhone(parsed.data.phone, parsed.data.phoneCountry);
  if (!normalizedPhone) return { fieldErrors: { phone: ["Enter a valid international phone number"] } };

  const limit = await checkRateLimit("early-access", await requestIp(), {
    limit: 5,
    windowSeconds: 60 * 60,
    failureMode: "closed",
  });
  if (!limit.allowed) return { error: "Requests are temporarily unavailable. Please try again later." };

  const { error } = await requestClinicInvitation({
    clinicName: parsed.data.clinicName,
    ownerName: parsed.data.ownerName,
    phone: normalizedPhone,
    email: normalizeEmail(parsed.data.email),
  });
  if (error) return { error: "We could not save your request. Please try again." };
  return { ok: true };
}

/**
 * §3.2: the weekly limit is enforced at issuance, never at acceptance. The
 * projection counts accepted-this-week plus ALL currently redeemable open
 * invitations regardless of the week they were issued in — conservative by
 * design, since each one can still be accepted. This is a soft, advisory
 * operator control: the read-then-issue sequence is deliberately not atomic
 * (two concurrent issuances may both pass), and the operator can force past
 * the block explicitly.
 */
async function issuanceQuota(supabase: Awaited<ReturnType<typeof createClient>>) {
  const [status, pendingIssued] = await Promise.all([
    supabase.rpc("get_public_registration_status"),
    supabase
      .from("clinic_invitations")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending")
      .not("token_hash", "is", null)
      .gt("expires_at", new Date().toISOString()),
  ]);
  return {
    acceptedThisWeek: Number(status.data?.[0]?.accepted_clinics_this_week ?? 0),
    pendingIssued: pendingIssued.count ?? 0,
    weeklyLimit: status.data?.[0]?.weekly_invite_limit ?? 0,
  };
}

export async function issueClinicInvitation(
  invitationId: string,
  options?: { force?: boolean },
): Promise<PublicActionResult> {
  const admin = await requirePlatformAdmin();
  const supabase = await createClient();

  const quota = await issuanceQuota(supabase);
  if (issuanceBlocked(quota, options?.force)) {
    // Conservative projection, not an exact weekly total: open invitations are
    // counted regardless of the week they were issued in, because each one
    // stays redeemable. Issuance is a soft operator control — acceptance of an
    // already-issued invitation is never blocked (§3.2).
    return {
      error: `Issuance blocked: ${quota.acceptedThisWeek} accepted this week plus ${quota.pendingIssued} open invitations (any issue week) meet the weekly limit of ${quota.weeklyLimit}. This is a soft issuance-time control — already-issued invitations stay redeemable. Re-submit with the override to issue anyway.`,
    };
  }

  const { data: settings } = await supabase.from("platform_settings")
    .select("invitation_expiry_days").eq("id", true).single();
  const rawToken = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + (settings?.invitation_expiry_days ?? 7) * 86_400_000).toISOString();
  // .select() makes the conditional update observable: zero matched rows means
  // the invitation was concurrently accepted/revoked, and the raw token must
  // not be surfaced because its hash was never persisted.
  const { data: updated, error } = await supabase.from("clinic_invitations").update({
    token_hash: hashInvitationToken(rawToken), expires_at: expiresAt,
    invited_by: admin.id, revoked_at: null, updated_at: new Date().toISOString(),
  }).eq("id", invitationId).eq("status", "pending").select("id, email");
  if (error) return { error: "Invitation could not be issued." };
  if (!updated || updated.length === 0) {
    return { error: "Invitation is no longer pending — it was accepted or revoked. Refresh the list." };
  }
  await logOperatorAction({ action: "invitation.issued", targetType: "clinic_invitation", targetId: invitationId, payload: { force: options?.force === true, expiresAt } });
  revalidatePath("/operator/invitations");
  return { ok: true, rawToken, invitationId, invitationEmail: updated[0].email };
}

export async function createClinicInvitation(
  _previous: PublicActionResult | null,
  formData: FormData,
): Promise<PublicActionResult> {
  await requirePlatformAdmin();
  const parsed = requestSchema.safeParse({
    clinicName: formData.get("clinicName"), ownerName: formData.get("ownerName"),
    phone: formData.get("phone"), phoneCountry: formData.get("phoneCountry"), email: formData.get("email"),
  });
  if (!parsed.success) return { fieldErrors: parsed.error.flatten().fieldErrors };
  const normalizedPhone = normalizePhone(parsed.data.phone, parsed.data.phoneCountry);
  if (!normalizedPhone) return { fieldErrors: { phone: ["Enter a valid international phone number"] } };
  const supabase = await createClient();
  const { data, error } = await supabase.from("clinic_invitations").insert({
    clinic_name: parsed.data.clinicName,
    owner_name: parsed.data.ownerName,
    phone: normalizedPhone,
    email: normalizeEmail(parsed.data.email),
  }).select("id").single();
  if (error || !data) return { error: "Invitation could not be created." };
  return issueClinicInvitation(data.id, { force: formData.get("force") === "true" });
}

export async function resendClinicInvitation(invitationId: string, options?: { force?: boolean }) {
  return issueClinicInvitation(invitationId, options);
}

export async function revokeClinicInvitation(invitationId: string): Promise<PublicActionResult> {
  await requirePlatformAdmin();
  const supabase = await createClient();
  const now = new Date().toISOString();
  // Zero matched rows means nothing was invalidated (already accepted, already
  // revoked, or a stale id) — never report that as a successful revocation.
  const { data: updated, error } = await supabase.from("clinic_invitations").update({
    status: "revoked", token_hash: null, expires_at: null,
    revoked_at: now, updated_at: now,
  }).eq("id", invitationId).eq("status", "pending").select("id");
  if (error) return { error: "Invitation could not be revoked." };
  if (!updated || updated.length === 0) {
    return { error: "Invitation is no longer pending — nothing was revoked. Refresh the list." };
  }
  await logOperatorAction({ action: "invitation.revoked", targetType: "clinic_invitation", targetId: invitationId });
  revalidatePath("/operator/invitations");
  return { ok: true };
}

export async function completeOnboarding(): Promise<void> {
  await requireMutationRole("admin");
  const supabase = await createClient();
  const { error } = await supabase.rpc("complete_own_onboarding");
  if (error) throw new Error("Unable to complete onboarding.");
  redirect("/dashboard");
}
