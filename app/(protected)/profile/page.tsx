import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";
import { ProfilePage } from "@/components/profile/profile-page";
import { getTranslations } from "next-intl/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("protected");
  return { title: t("metadataMyProfile") };
}

export default async function MyProfilePage() {
  const user = await requireUser();
  if (!user) redirect("/login");

  const supabase = await createClient();
  const { data: profile } = await supabase
    .from("profiles")
    .select(
      "id, full_name, phone, avatar_url, role, created_at, departments(name, color)",
    )
    .eq("id", user.id)
    .single();

  const { data: authUser } = await supabase.auth.getUser();
  const email = authUser.user?.email ?? "";

  if (!profile) redirect("/dashboard");

  return (
    <ProfilePage
      profile={{
        id: profile.id,
        full_name: profile.full_name,
        phone: profile.phone,
        avatar_url: profile.avatar_url,
        role: profile.role,
        email,
        created_at: profile.created_at,
        department: profile.departments
          ? { name: profile.departments.name, color: profile.departments.color }
          : null,
      }}
    />
  );
}
