"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { THEME_COOKIE } from "@/lib/i18n/config";

/**
 * P2A (§4.5): theme now follows the **user**, not the browser.
 *
 * The `user_ui_preferences` row is the source of truth; the cookie is downgraded to a pre-render
 * hint so the first paint has no flash. Both are written here. The row is created lazily on this
 * first write — there is no backfill, because a device cookie is not readable server-side outside a
 * request, so historical choices cannot be migrated (§4.5: document it, don't invent history).
 */
export async function setTheme(theme: "light" | "dark") {
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) throw new Error("Authentication required.");

  // Self-only RLS enforces `user_id = auth.uid()` on both the insert and the update path. The upsert
  // supplies only `theme`, so changing the theme never disturbs the stored locale.
  const { error: writeError } = await supabase
    .from("user_ui_preferences")
    .upsert({ user_id: user.id, theme }, { onConflict: "user_id" });
  if (writeError) throw new Error("Could not save your theme.");

  const cookieStore = await cookies();
  cookieStore.set(THEME_COOKIE, theme, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365, // 1 year
    sameSite: "lax",
  });

  revalidatePath("/", "layout");
}
