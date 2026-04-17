import "server-only";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";

export type UserRole = "admin" | "receptionist" | "manager";

export type AuthedUser = {
  id: string;
  email: string;
  role: UserRole;
  fullName: string;
  clinicId: string;
  mustChangePassword: boolean;
};

/**
 * Phase 1 will replace this stub with a real query against `profiles`.
 * Keeps the contract stable so callers can be written against it today.
 */
export async function getAuthedUser(): Promise<AuthedUser | null> {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) return null;

  return {
    id: data.user.id,
    email: data.user.email ?? "",
    role: "admin",
    fullName: data.user.email ?? "",
    clinicId: "00000000-0000-0000-0000-000000000000",
    mustChangePassword: false,
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
