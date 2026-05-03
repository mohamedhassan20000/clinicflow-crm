import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import {
  PAGE_VISIBILITY_KEY,
  FEATURE_REGISTRY,
  buildCustomizationMap,
  getEffectiveAccess,
  type AccessLevel,
  type CustomizationMap,
} from "@/lib/customizations";

// React cache() deduplicates within a single request — the layout, page, and
// any nested server components all share the same result without extra DB hits.
export const fetchUserCustomizationMap = cache(async (
  userId: string,
): Promise<CustomizationMap> => {
  const supabase = await createClient();
  const { data } = await supabase
    .from("user_customizations")
    .select("page, feature, access")
    .eq("profile_id", userId);
  return buildCustomizationMap(
    (data ?? []) as { page: string; feature: string; access: AccessLevel }[],
  );
});

/** Returns true if the page is visible for this user. Admins always see everything. */
export function isPageVisible(
  map: CustomizationMap,
  pageKey: string,
  role: string,
): boolean {
  if (role === "admin") return true;
  const override = map[pageKey]?.[PAGE_VISIBILITY_KEY];
  if (override !== undefined) return override !== "hidden";
  return true;
}

/** Returns effective access for a feature. Admins always get read_edit. */
export function featureAccess(
  map: CustomizationMap,
  pageKey: string,
  featureKey: string,
  role: string,
): AccessLevel {
  if (role === "admin") return "read_edit";
  return getEffectiveAccess(map, pageKey, featureKey, role);
}

/** Returns the list of page keys that are hidden for this user. */
export function getHiddenPages(map: CustomizationMap, role: string): string[] {
  if (role === "admin") return [];
  return FEATURE_REGISTRY.map((p) => p.key).filter(
    (key) => !isPageVisible(map, key, role),
  );
}
