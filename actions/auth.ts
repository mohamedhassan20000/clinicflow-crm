"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { z } from "zod";
import { createClient as createSupabaseJs } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import {
  deleteSignupAuthUser,
  findResumableSignupUserId,
  provisionClinicOwner,
} from "@/lib/supabase/admin";
import { checkRateLimit } from "@/lib/rate-limit";
import { hashInvitationToken, normalizeEmail, normalizePhone, requestIp } from "@/lib/signup";

const signInSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

function errorMessage(error: unknown) {
  if (!error) return null;
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(error);
}

type SupabaseErrorDetails = {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
};

function logSupabaseError(
  context: string,
  error: SupabaseErrorDetails | null | undefined,
  metadata: Record<string, string | null | undefined>,
) {
  if (!error) return;
  console.error(context, {
    code: error.code,
    message: error.message,
    details: error.details,
    hint: error.hint,
    ...metadata,
  });
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

  const loginLimit = await checkRateLimit("login", await requestIp(), {
    limit: 10, windowSeconds: 15 * 60, failureMode: "open",
  });
  if (!loginLimit.allowed) {
    return { error: "Too many sign-in attempts. Please try again later." };
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

  const { error: lastLoginError } = await supabase.rpc(
    "record_own_last_login" as never,
  );
  if (lastLoginError) {
    logSupabaseError("last_login_update_failed", lastLoginError, {
      userId: data.user.id,
    });
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
  const raw = {
    password: formData.get("password"),
    confirmPassword: formData.get("confirmPassword"),
  };

  const parsed = changePasswordSchema.safeParse(raw);
  if (!parsed.success) {
    return { fieldErrors: parsed.error.flatten().fieldErrors };
  }

  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return {
        error:
          "Your session expired. Sign in again with your temporary password to set a new password.",
      };
    }

    const { data: updateData, error } = await supabase.auth.updateUser({
      password: parsed.data.password,
    });
    const updatedUserId = updateData.user?.id;

    if (error) {
      return {
        error: `Failed to update password: ${error.message}`,
      };
    }
    if (updatedUserId && updatedUserId !== user.id) {
      return { error: "Password update returned an unexpected user." };
    }

    const { error: rpcError } = await supabase.rpc(
      "clear_own_must_change_password",
    );

    if (rpcError) {
      return {
        error:
          `Password updated, but the forced-password flag clear failed: ${rpcError.message}`,
      };
    }

    revalidatePath("/dashboard");
    await supabase.auth.signOut();
    return {
      ok: true,
      redirectTo: "/login?password_changed=1",
    };
  } catch (err) {
    return {
      error:
        `Unexpected forced password error: ${errorMessage(err) ?? "unknown error"}`,
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

  const passwordResetLimit = await checkRateLimit("password-reset", await requestIp(), {
    limit: 5, windowSeconds: 60 * 60, failureMode: "open",
  });
  if (!passwordResetLimit.allowed) return { ok: true };

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

const clinicSignupSchema = z.object({
  token: z.string().trim().optional(),
  clinicName: z.string().trim().min(1).max(200),
  country: z.enum(["KW", "SA", "AE", "EG"]),
  phone: z.string().trim().min(3).max(50),
  ownerName: z.string().trim().min(1).max(200),
  email: z.string().trim().email().max(320),
  password: z.string().min(8).regex(/[A-Z]/).regex(/[0-9]/),
  locale: z.enum(["ar", "en"]),
});

function createThrowawayAuthClient() {
  return createSupabaseJs(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    },
  );
}

export async function signUpClinic(
  _previous: AuthActionResult | null,
  formData: FormData,
): Promise<AuthActionResult> {
  const parsed = clinicSignupSchema.safeParse({
    token: formData.get("token") || undefined,
    clinicName: formData.get("clinicName"), country: formData.get("country"),
    phone: formData.get("phone"), ownerName: formData.get("ownerName"),
    email: formData.get("email"), password: formData.get("password"),
    locale: formData.get("locale"),
  });
  if (!parsed.success) return { fieldErrors: parsed.error.flatten().fieldErrors };

  const rateLimit = await checkRateLimit("clinic-signup", await requestIp(), {
    limit: 5, windowSeconds: 60 * 60, failureMode: "closed",
  });
  if (!rateLimit.allowed) return { error: "Signup is temporarily unavailable. Please try again later." };

  const email = normalizeEmail(parsed.data.email);
  const tokenHash = parsed.data.token ? hashInvitationToken(parsed.data.token) : null;
  const supabase = await createClient();
  const { data: validation, error: validationError } = await supabase.rpc(
    "validate_clinic_signup", { p_token_hash: tokenHash ?? undefined },
  );
  const state = validation?.[0];
  if (validationError || !state?.allowed) return { error: "This invitation is invalid or has expired." };
  if (state.email && normalizeEmail(state.email) !== email) return { error: "Use the email address this invitation was sent to." };

  const origin = await siteOrigin();
  const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
    email, password: parsed.data.password,
    options: {
      emailRedirectTo: `${origin}/auth/confirm?next=/onboarding`,
      data: { signup_flow: "clinic_owner", invitation_id: state.invitation_id },
    },
  });

  let owner = signUpData.user;
  let createdNow = Boolean(owner && (owner.identities?.length ?? 0) > 0);
  if (signUpError || !createdNow) {
    const resumable = await findResumableSignupUserId(email);
    if (resumable.error || !resumable.data) {
      return { error: "An account already exists for this email. Sign in or reset its password." };
    }

    const verifier = createThrowawayAuthClient();
    const verified = await verifier.auth.signInWithPassword({
      email,
      password: parsed.data.password,
    });
    if (verified.error || verified.data.user?.id !== resumable.data) {
      return { error: "An account already exists for this email. Sign in or reset its password." };
    }
    await verifier.auth.signOut();
    owner = verified.data.user;
    createdNow = false;
  }
  if (!owner) return { error: "An account already exists for this email. Sign in or reset its password." };

  const { error: provisionError } = await provisionClinicOwner({
    ownerId: owner.id, tokenHash,
    clinicName: parsed.data.clinicName, country: parsed.data.country,
    phone: normalizePhone(parsed.data.phone), ownerName: parsed.data.ownerName,
    ownerEmail: email, locale: parsed.data.locale,
  });
  if (provisionError) {
    console.error("clinic_signup_provision_failed", {
      code: provisionError.code,
      message: provisionError.message,
      ownerId: owner.id,
    });
    if (createdNow) {
      const { error: cleanupError } = await deleteSignupAuthUser(owner.id);
      if (cleanupError) console.error("signup_compensation_failed", { userId: owner.id });
    }
    return { error: "Clinic setup could not be completed. Please retry with the same details." };
  }

  redirect("/signup/complete");
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
