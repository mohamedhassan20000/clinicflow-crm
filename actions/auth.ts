"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { z } from "zod";
import { createClient as createSupabaseJs } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { getAuthedUser } from "@/lib/rbac";

const signInSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const changePasswordSchema = z
  .object({
    password: z
      .string()
      .min(8, "Password must be at least 8 characters")
      .regex(/[A-Z]/, "Must contain an uppercase letter")
      .regex(/[0-9]/, "Must contain a number"),
    confirmPassword: z.string(),
  })
  .refine((d) => d.password === d.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

export type AuthActionResult = {
  ok?: boolean;
  redirectTo?: string;
  error?: string;
  fieldErrors?: Record<string, string[]>;
};

export async function signIn(
  formData: FormData,
): Promise<AuthActionResult> {
  const raw = {
    email: formData.get("email"),
    password: formData.get("password"),
  };

  const parsed = signInSchema.safeParse(raw);
  if (!parsed.success) {
    return { fieldErrors: parsed.error.flatten().fieldErrors };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);

  if (error) {
    return { error: "Invalid email or password." };
  }

  // Fetch profile to determine where to redirect
  const user = await getAuthedUser();
  if (!user) return { error: "Profile not found. Contact your administrator." };

  // Client will navigate after awaiting — ensures fresh session cookies
  // are fully committed before middleware runs on the next request.
  return {
    ok: true,
    redirectTo: user.mustChangePassword ? "/change-password" : "/dashboard",
  };
}

export async function signOut(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}

export async function changePassword(
  _prev: AuthActionResult | null,
  formData: FormData,
): Promise<AuthActionResult> {
  const raw = {
    password: formData.get("password"),
    confirmPassword: formData.get("confirmPassword"),
  };

  const parsed = changePasswordSchema.safeParse(raw);
  if (!parsed.success) {
    return { fieldErrors: parsed.error.flatten().fieldErrors };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({
    password: parsed.data.password,
  });

  if (error) {
    return { error: "Failed to update password. Please try again." };
  }

  const { error: clearFlagError } = await supabase.rpc(
    "clear_own_must_change_password",
  );
  if (clearFlagError) {
    return {
      error:
        "Password updated, but we could not clear the password change requirement. Please contact your administrator.",
    };
  }

  revalidatePath("/dashboard");
  await supabase.auth.signOut();
  return { ok: true, redirectTo: "/login?password_changed=1" };
}

const forgotSchema = z.object({
  email: z.string().email("Enter a valid email address."),
});

const resetSchema = z
  .object({
    password: z
      .string()
      .min(8, "Password must be at least 8 characters")
      .regex(/[A-Z]/, "Must contain an uppercase letter")
      .regex(/[0-9]/, "Must contain a number"),
    confirmPassword: z.string(),
  })
  .refine((d) => d.password === d.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

async function siteOrigin(): Promise<string> {
  // Honour an explicit env when set (production); otherwise fall back to the
  // request headers so this works on previews + localhost.
  const envUrl = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "");
  if (envUrl) return envUrl;
  const h = await headers();
  const proto = h.get("x-forwarded-proto") ?? "https";
  const host = h.get("x-forwarded-host") ?? h.get("host");
  if (!host) throw new Error("Cannot resolve site origin.");
  return `${proto}://${host}`;
}

export async function requestPasswordReset(
  _prev: AuthActionResult | null,
  formData: FormData,
): Promise<AuthActionResult> {
  const parsed = forgotSchema.safeParse({ email: formData.get("email") });
  if (!parsed.success) {
    return { fieldErrors: parsed.error.flatten().fieldErrors };
  }

  const origin = await siteOrigin();
  const redirectTo = `${origin}/auth/confirm?next=/reset-password`;

  // @supabase/ssr forces flowType: 'pkce' for every client it builds
  // (createServerClient.js line 31), and the PKCE verifier cookie can't
  // round-trip across deployment URLs. For this one call we use the raw
  // supabase-js client with implicit flow so the email link returns tokens
  // directly in the URL hash — no verifier needed.
  const supabase = createSupabaseJs(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      auth: {
        flowType: "implicit",
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    },
  );

  // Always return ok regardless of whether the email exists, to prevent
  // account enumeration. Supabase silently no-ops for unknown addresses.
  await supabase.auth.resetPasswordForEmail(parsed.data.email, { redirectTo });

  return { ok: true };
}

export async function setNewPassword(
  _prev: AuthActionResult | null,
  formData: FormData,
): Promise<AuthActionResult> {
  const raw = {
    password: formData.get("password"),
    confirmPassword: formData.get("confirmPassword"),
  };
  const parsed = resetSchema.safeParse(raw);
  if (!parsed.success) {
    return { fieldErrors: parsed.error.flatten().fieldErrors };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return {
      error:
        "Reset link expired or invalid. Request a new password reset email.",
    };
  }

  const { error } = await supabase.auth.updateUser({
    password: parsed.data.password,
  });
  if (error) {
    return { error: "Failed to update password. Please try again." };
  }

  // Sign out so the user is forced to log back in with the new password.
  await supabase.auth.signOut();
  redirect("/login?reset=1");
}
