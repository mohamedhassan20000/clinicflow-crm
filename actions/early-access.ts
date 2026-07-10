"use server";

import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireMutationRole, requirePlatformAdmin } from "@/lib/rbac";
import { checkRateLimit } from "@/lib/rate-limit";
import { createClient } from "@/lib/supabase/server";
import { requestClinicInvitation } from "@/lib/supabase/admin";
import { hashInvitationToken, normalizeEmail, normalizePhone, requestIp } from "@/lib/signup";

export type PublicActionResult = {
  ok?: boolean;
  error?: string;
  fieldErrors?: Record<string, string[]>;
  rawToken?: string;
};

const requestSchema = z.object({
  clinicName: z.string().trim().min(1).max(200),
  ownerName: z.string().trim().min(1).max(200),
  phone: z.string().trim().min(3).max(50),
  email: z.string().trim().email().max(320),
});

export async function requestEarlyAccess(
  _previous: PublicActionResult | null,
  formData: FormData,
): Promise<PublicActionResult> {
  const parsed = requestSchema.safeParse({
    clinicName: formData.get("clinicName"),
    ownerName: formData.get("ownerName"),
    phone: formData.get("phone"),
    email: formData.get("email"),
  });
  if (!parsed.success) return { fieldErrors: parsed.error.flatten().fieldErrors };

  const limit = await checkRateLimit("early-access", await requestIp(), {
    limit: 5,
    windowSeconds: 60 * 60,
    failureMode: "closed",
  });
  if (!limit.allowed) return { error: "Requests are temporarily unavailable. Please try again later." };

  const { error } = await requestClinicInvitation({
    clinicName: parsed.data.clinicName,
    ownerName: parsed.data.ownerName,
    phone: normalizePhone(parsed.data.phone),
    email: normalizeEmail(parsed.data.email),
  });
  if (error) return { error: "We could not save your request. Please try again." };
  return { ok: true };
}

export async function issueClinicInvitation(invitationId: string): Promise<PublicActionResult> {
  const admin = await requirePlatformAdmin();
  const supabase = await createClient();
  const { data: settings } = await supabase.from("platform_settings")
    .select("invitation_expiry_days").eq("id", true).single();
  const rawToken = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + (settings?.invitation_expiry_days ?? 7) * 86_400_000).toISOString();
  const { error } = await supabase.from("clinic_invitations").update({
    token_hash: hashInvitationToken(rawToken), expires_at: expiresAt,
    invited_by: admin.id, revoked_at: null, updated_at: new Date().toISOString(),
  }).eq("id", invitationId).eq("status", "pending");
  if (error) return { error: "Invitation could not be issued." };
  revalidatePath("/operator/invitations");
  return { ok: true, rawToken };
}

export async function createClinicInvitation(formData: FormData): Promise<PublicActionResult> {
  await requirePlatformAdmin();
  const parsed = requestSchema.safeParse({
    clinicName: formData.get("clinicName"), ownerName: formData.get("ownerName"),
    phone: formData.get("phone"), email: formData.get("email"),
  });
  if (!parsed.success) return { fieldErrors: parsed.error.flatten().fieldErrors };
  const supabase = await createClient();
  const { data, error } = await supabase.from("clinic_invitations").insert({
    clinic_name: parsed.data.clinicName,
    owner_name: parsed.data.ownerName,
    phone: normalizePhone(parsed.data.phone),
    email: normalizeEmail(parsed.data.email),
  }).select("id").single();
  if (error || !data) return { error: "Invitation could not be created." };
  return issueClinicInvitation(data.id);
}

export async function resendClinicInvitation(invitationId: string) {
  return issueClinicInvitation(invitationId);
}

export async function revokeClinicInvitation(invitationId: string): Promise<PublicActionResult> {
  await requirePlatformAdmin();
  const supabase = await createClient();
  const now = new Date().toISOString();
  const { error } = await supabase.from("clinic_invitations").update({
    status: "revoked", token_hash: null, expires_at: null,
    revoked_at: now, updated_at: now,
  }).eq("id", invitationId).eq("status", "pending");
  if (error) return { error: "Invitation could not be revoked." };
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
