"use server";

import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";

export async function setTheme(theme: "light" | "dark") {
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) throw new Error("Authentication required.");
  const cookieStore = await cookies();
  cookieStore.set("theme", theme, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365, // 1 year
    sameSite: "lax",
  });
}
