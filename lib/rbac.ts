import "server-only";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";

export type UserRole = "admin" | "receptionist" | "manager" | "doctor";

export type AuthedUser = {
  id: string;
  email: string;
  role: UserRole;
  fullName: string;
  clinicId: string;
  departmentId: string | null;
  mustChangePassword: boolean;
};

export async function getAuthedUser(): Promise<AuthedUser | null> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: profile } = await supabase
    .from("profiles")
    .select(
      "role, full_name, clinic_id, department_id, must_change_password, is_active, is_deleted, deleted_at",
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
