"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { z } from "zod";
import { createClient as createSupabaseJs } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

const signInSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const CHANGE_PASSWORD_ACTION_VERSION = "trace-forced-password-2026-05-06-2-debug";

function authTrace(
  traceId: string,
  step: string,
  details: Record<string, unknown> = {},
) {
  console.info("[forced-password-change]", {
    traceId,
    actionVersion: CHANGE_PASSWORD_ACTION_VERSION,
    step,
    ...details,
  });
}

function authTraceError(
  traceId: string,
  step: string,
  details: Record<string, unknown> = {},
) {
  console.error("[forced-password-change]", {
    traceId,
    actionVersion: CHANGE_PASSWORD_ACTION_VERSION,
    step,
    ...details,
  });
}

function errorMessage(error: unknown) {
  if (!error) return null;
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(error);
}

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
  debug?: ForcedPasswordDebug;
};

export type ForcedPasswordDebug = {
  actionVersion: string;
  traceId: string;
  rpcSucceeded: boolean | null;
  rpcError: string | null;
  profileMustChangePassword: boolean | null;
  adminProfileMustChangePassword: boolean | null;
  profileFlagCleared: boolean | null;
  finalRedirectTarget: string | null;
  finalStep: string;
};

function forcedPasswordDebug(
  traceId: string,
  overrides: Partial<ForcedPasswordDebug> = {},
): ForcedPasswordDebug {
  return {
    actionVersion: CHANGE_PASSWORD_ACTION_VERSION,
    traceId,
    rpcSucceeded: null,
    rpcError: null,
    profileMustChangePassword: null,
    adminProfileMustChangePassword: null,
    profileFlagCleared: null,
    finalRedirectTarget: null,
    finalStep: "started",
    ...overrides,
  };
}

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
  const { data, error } = await supabase.auth.signInWithPassword(parsed.data);

  if (error || !data.user) {
    return { error: "Invalid email or password." };
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("must_change_password, is_active, is_deleted, deleted_at")
    .eq("id", data.user.id)
    .single();

  if (!profile) return { error: "Profile not found. Contact your administrator." };
  if (!profile.is_active || profile.is_deleted || profile.deleted_at) {
    return { error: "Your account is inactive. Contact your administrator." };
  }

  // Client will navigate after awaiting — ensures fresh session cookies
  // are fully committed before middleware runs on the next request.
  return {
    ok: true,
    redirectTo: profile.must_change_password ? "/change-password" : "/dashboard",
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
  const traceId = crypto.randomUUID();
  authTrace(traceId, "action_start");
  let debug = forcedPasswordDebug(traceId);

  const raw = {
    password: formData.get("password"),
    confirmPassword: formData.get("confirmPassword"),
  };

  const parsed = changePasswordSchema.safeParse(raw);
  if (!parsed.success) {
    authTrace(traceId, "validation_failed", {
      fields: Object.keys(parsed.error.flatten().fieldErrors),
    });
    debug = forcedPasswordDebug(traceId, { finalStep: "validation_failed" });
    return { fieldErrors: parsed.error.flatten().fieldErrors, debug };
  }

  try {
    const supabase = await createClient();
    const {
      data: { user },
      error: getUserError,
    } = await supabase.auth.getUser();
    authTrace(traceId, "get_user_before_update", {
      userId: user?.id ?? null,
      error: errorMessage(getUserError),
    });

    if (!user) {
      debug = forcedPasswordDebug(traceId, { finalStep: "missing_session" });
      return {
        error:
          `Trace ${traceId}: Your session expired. Sign in again with your temporary password to set a new password.`,
        debug,
      };
    }

    const { data: updateData, error } = await supabase.auth.updateUser({
      password: parsed.data.password,
    });
    authTrace(traceId, "auth_update_user_result", {
      userId: user.id,
      updatedUserId: updateData.user?.id ?? null,
      error: errorMessage(error),
    });

    if (error) {
      debug = forcedPasswordDebug(traceId, {
        finalStep: "auth_update_user_failed",
      });
      return {
        error: `Trace ${traceId}: Failed to update password: ${error.message}`,
        debug,
      };
    }

    authTrace(traceId, "clear_rpc_before_call", {
      userId: user.id,
      migrationDependentPath: "clear_own_must_change_password",
    });
    const { data: rpcData, error: rpcError } = await supabase.rpc(
      "clear_own_must_change_password",
    );
    debug = forcedPasswordDebug(traceId, {
      rpcSucceeded: !rpcError,
      rpcError: errorMessage(rpcError),
      finalStep: "clear_rpc_result",
    });
    authTrace(traceId, "clear_rpc_result", {
      userId: user.id,
      data: rpcData ?? null,
      error: errorMessage(rpcError),
      rpcSucceeded: !rpcError,
    });

    if (rpcError) {
      return {
        error:
          `Trace ${traceId}: Password updated, but the forced-password flag clear failed: ${rpcError.message}`,
        debug,
      };
    }

    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("must_change_password")
      .eq("id", user.id)
      .single();

    const adminClient = createAdminClient();
    const { data: adminProfile, error: adminProfileError } = await adminClient
      .from("profiles")
      .select("must_change_password")
      .eq("id", user.id)
      .single();

    const profileMustChangePassword = profile?.must_change_password ?? null;
    const adminProfileMustChangePassword =
      adminProfile?.must_change_password ?? null;
    const profileFlagCleared =
      adminProfileMustChangePassword === false ||
      (adminProfileMustChangePassword === null &&
        profileMustChangePassword === false);
    debug = {
      ...debug,
      profileMustChangePassword,
      adminProfileMustChangePassword,
      profileFlagCleared,
      finalStep: "final_profile_verify_result",
    };
    authTrace(traceId, "final_profile_verify_result", {
      userId: user.id,
      mustChangePassword: profileMustChangePassword,
      error: errorMessage(profileError),
      adminMustChangePassword: adminProfileMustChangePassword,
      adminError: errorMessage(adminProfileError),
      profileFlagCleared,
    });

    if (
      profileError ||
      adminProfileError ||
      !profile ||
      !adminProfile ||
      !profileFlagCleared
    ) {
      return {
        error:
          `Trace ${traceId}: Password updated, but final verification still sees must_change_password=${adminProfileMustChangePassword ?? profileMustChangePassword ?? "unknown"}, error=${errorMessage(adminProfileError) ?? errorMessage(profileError) ?? "none"}.`,
        debug,
      };
    }

    revalidatePath("/dashboard");
    const { error: signOutError } = await supabase.auth.signOut();
    debug = {
      ...debug,
      finalRedirectTarget: "/login?password_changed=1",
      finalStep: "success_ready_to_redirect",
    };
    authTrace(traceId, "sign_out_result", {
      userId: user.id,
      error: errorMessage(signOutError),
      finalRedirectTarget: debug.finalRedirectTarget,
    });
    return {
      ok: true,
      redirectTo: "/login?password_changed=1",
      debug,
    };
  } catch (err) {
    authTraceError(traceId, "unexpected_exception", {
      error: errorMessage(err),
    });
    debug = { ...debug, finalStep: "unexpected_exception" };
    return {
      error:
        `Trace ${traceId}: Unexpected forced password error: ${errorMessage(err) ?? "unknown error"}`,
      debug,
    };
  }
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
