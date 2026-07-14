"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { MARKETING_LOCALE_COOKIE, isLocale, type Locale } from "@/lib/i18n/config";

/**
 * P2A — the two locale writes (§4.1, §4.5). They are deliberately separate mechanisms because they
 * describe two different things: who you *are* (an account) and what this *browser* is reading.
 */

/**
 * Writes the signed-in account's own UI language.
 *
 * Keyed on `auth.users.id`, so this one action serves **both** a clinic user (from Preferences) and
 * the Platform Admin (from the operator-header switcher). `profiles` structurally cannot hold the
 * Platform Admin's language — a platform admin has no `profiles` row.
 *
 * Self-only RLS means this can only ever write the caller's own row: one user's language change
 * leaves every other user untouched, in the same clinic and across clinics, and a platform admin's
 * language changes nothing for any clinic user.
 */
export async function updateOwnLocale(locale: Locale) {
  if (!isLocale(locale)) throw new Error("Unsupported language.");

  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) throw new Error("Authentication required.");

  // Only `locale` is supplied, so a language change never disturbs the stored theme.
  const { error: writeError } = await supabase
    .from("user_ui_preferences")
    .upsert({ user_id: user.id, locale }, { onConflict: "user_id" });
  if (writeError) throw new Error("Could not save your language.");

  // No locale cookie is written here, and that is the point: an authenticated account resolves its
  // language from its row only. Mirroring it into the marketing cookie would leak one user's
  // language into the next anonymous visitor on the same browser.
  revalidatePath("/", "layout");
}

/**
 * Writes the anonymous/marketing locale cookie — the public site's language for this browser.
 *
 * Independent of any account by design: it is never read for a signed-in user, and signing in does
 * not adopt it.
 */
export async function setMarketingLocale(locale: Locale) {
  if (!isLocale(locale)) throw new Error("Unsupported language.");

  const cookieStore = await cookies();
  cookieStore.set(MARKETING_LOCALE_COOKIE, locale, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365, // 1 year
    sameSite: "lax",
  });

  revalidatePath("/", "layout");
}
