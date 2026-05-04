import "server-only";

import { createClient } from "@/lib/supabase/server";
import {
  getRolePageSlugs,
  type PageSlug,
} from "@/lib/page-permissions";
import type { AuthedUser } from "@/lib/rbac";

function isMissingPermissionsTable(error: { code?: string; message?: string } | null) {
  return (
    error?.code === "42P01" ||
    error?.message?.toLowerCase().includes("user_page_permissions") === true
  );
}

export async function getVisiblePageSlugs(user: AuthedUser): Promise<PageSlug[]> {
  const roleSlugs = new Set(getRolePageSlugs(user.role));
  const visible = new Set<PageSlug>(roleSlugs);
  visible.add("dashboard");

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("user_page_permissions")
    .select("page_slug, is_visible")
    .eq("user_id", user.id)
    .eq("clinic_id", user.clinicId);

  if (isMissingPermissionsTable(error)) {
    const { data: fallback, error: fallbackError } = await supabase
      .from("user_customizations")
      .select("page, access")
      .eq("profile_id", user.id)
      .eq("clinic_id", user.clinicId)
      .eq("feature", "_visible");

    if (fallbackError) return Array.from(visible);
    for (const permission of fallback ?? []) {
      const slug = permission.page as PageSlug;
      if (!roleSlugs.has(slug) || slug === "dashboard") continue;
      if (permission.access === "hidden") visible.delete(slug);
      else visible.add(slug);
    }
    return Array.from(visible);
  }
  if (error) return Array.from(visible);

  for (const permission of data ?? []) {
    const slug = permission.page_slug as PageSlug;
    if (!roleSlugs.has(slug) || slug === "dashboard") continue;
    if (permission.is_visible) visible.add(slug);
    else visible.delete(slug);
  }

  return Array.from(visible);
}
