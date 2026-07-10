"use server";

import { cookies } from "next/headers";
import { requireMutationUser } from "@/lib/rbac";

export async function setTheme(theme: "light" | "dark") {
  await requireMutationUser();
  const cookieStore = await cookies();
  cookieStore.set("theme", theme, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365, // 1 year
    sameSite: "lax",
  });
}
