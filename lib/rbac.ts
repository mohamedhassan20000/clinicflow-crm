import "server-only";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { requireActiveSubscription } from "@/lib/billing/subscriptions";

export type UserRole = "admin" | "receptionist" | "manager" | "doctor";

export type AuthedUser = {
  id: string;
  email: string;
  role: UserRole;
  fullName: string;
  avatarUrl: string | null;
  clinicId: string;
  departmentId: string | null;
  mustChangePassword: boolean;
};

export type PlatformAdmin = {
  id: string;
  email: string;
};

export async function getAuthedUser(): Promise<AuthedUser | null> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: profile } = await supabase
    .from("profiles")
    .select(
      "role, full_name, avatar_url, clinic_id, department_id, must_change_password, is_active, is_deleted, deleted_at",
    )
    .eq("id", user.id)
    .single();

  if (!profile) return null;
  if (!profile.is_active || profile.is_deleted || profile.deleted_at) return null;

  return {
    id: user.id,
    email: user.email ?? "",
    role: profile.role as UserRole,
    fullName: profile.full_name,
    avatarUrl: profile.avatar_url ?? null,
    clinicId: profile.clinic_id,
    departmentId: profile.department_id ?? null,
    mustChangePassword: profile.must_change_password,
  };
}

export async function requireUser(): Promise<AuthedUser> {
  const user = await getAuthedUser();
  if (!user) redirect("/login");
  return user;
}

export async function requireRole(
  roles: UserRole[] | UserRole,
): Promise<AuthedUser> {
  const user = await requireUser();
  const allowed = Array.isArray(roles) ? roles : [roles];
  if (!allowed.includes(user.role)) redirect("/dashboard");
  return user;
}

/**
 * Billing-aware guard for every new or touched mutating Server Action. Keeping
 * this separate from requireRole preserves read-only access needed to explain
 * and resolve an expired subscription.
 */
export async function requireMutationRole(
  roles: UserRole[] | UserRole,
): Promise<AuthedUser> {
  const user = await requireRole(roles);
  await requireActiveSubscription(user.clinicId);
  return user;
}

export async function requireMutationUser(): Promise<AuthedUser> {
  const user = await requireUser();
  await requireActiveSubscription(user.clinicId);
  return user;
}

/**
 * Resolves the platform role independently from clinic RBAC. A platform admin
 * does not need a clinic profile and gains no tenant clinical-data access.
 */
export async function requirePlatformAdmin(): Promise<PlatformAdmin> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: platformAdmin } = await supabase
    .from("platform_admins")
    .select("user_id")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!platformAdmin) redirect("/dashboard");

  return {
    id: user.id,
    email: user.email ?? "",
  };
}
