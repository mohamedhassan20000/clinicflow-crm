import "server-only";

import { createClient } from "@/lib/supabase/server";
import {
  getRolePageSlugs,
  type PageSlug,
} from "@/lib/page-permissions";
import type { AuthedUser } from "@/lib/rbac";

export type PageVisibilityState = "visible" | "hidden" | "lookup_failed";

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

/**
 * Resolves one page from the persisted customization source. Unlike the shell
 * helper above, authorization-sensitive callers need to distinguish a saved
 * denial from an infrastructure failure so they can fail closed safely.
 */
export async function getPageVisibilityState(
  user: AuthedUser,
  pageSlug: PageSlug,
): Promise<PageVisibilityState> {
  const roleSlugs = new Set(getRolePageSlugs(user.role));
  if (pageSlug === "dashboard") return "visible";
  if (!roleSlugs.has(pageSlug)) return "hidden";

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("user_page_permissions")
    .select("is_visible")
    .eq("user_id", user.id)
    .eq("clinic_id", user.clinicId)
    .eq("page_slug", pageSlug)
    .maybeSingle();

  if (!error) return data?.is_visible === false ? "hidden" : "visible";
  if (!isMissingPermissionsTable(error)) return "lookup_failed";

  const { data: fallback, error: fallbackError } = await supabase
    .from("user_customizations")
    .select("access")
    .eq("profile_id", user.id)
    .eq("clinic_id", user.clinicId)
    .eq("feature", "_visible")
    .eq("page", pageSlug)
    .maybeSingle();

  if (fallbackError) return "lookup_failed";
  return fallback?.access === "hidden" ? "hidden" : "visible";
}
