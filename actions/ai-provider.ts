"use server";

import { createClient as createSupabaseJs } from "@supabase/supabase-js";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { AI_ASSISTANT_FEATURE } from "@/lib/ai/authorization";
import {
  activateAnthropicCredential,
  AiProviderConfigurationError,
  getAiProviderSettings,
  revokeActiveAiProviderConnection,
  testStoredAiProviderConnection,
  updateAiProviderPolicy,
  type AiProviderHealth,
} from "@/lib/ai/platform/provider-connections";
import { setAiAutoByokFallback } from "@/lib/supabase/admin";
import { getEntitlements, hasAiProviderMode, hasFeature } from "@/lib/entitlements";
import { actionError } from "@/lib/i18n/action-errors";
import { isPrimaryClinicAdmin } from "@/lib/primary-admin";
import { checkRateLimit } from "@/lib/rate-limit";
import { requireMutationRole, type AuthedUser } from "@/lib/rbac";
import type { Database } from "@/types/database";

const credentialSchema = z.object({
  apiKey: z.string().trim().min(20).max(512),
  currentPassword: z.string().min(1).max(1_024).optional(),
});
const modeSchema = z.object({
  mode: z.enum(["managed", "byok_strict", "hybrid"]),
  hybridAccepted: z.boolean(),
  currentPassword: z.string().min(1).max(1_024),
});
const passwordSchema = z.string().min(1).max(1_024);
const autoFallbackSchema = z.object({ enabled: z.boolean() });

export type AiProviderActionResult = {
  success?: boolean;
  error?: string;
  health?: AiProviderHealth;
  operation?: "created" | "rotated";
};

function createThrowawayAuthClient() {
  return createSupabaseJs<Database>(
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

async function requirePrimaryAiAdmin(): Promise<AuthedUser> {
  const user = await requireMutationRole("admin");
  if (!(await isPrimaryClinicAdmin(user.id, user.clinicId))) {
    throw new AiProviderConfigurationError("policy_invalid");
  }
  const entitlements = await getEntitlements(user.clinicId);
  if (!hasFeature(entitlements, AI_ASSISTANT_FEATURE)) {
    throw new AiProviderConfigurationError("policy_invalid");
  }
  return user;
}

async function operationAllowed(user: AuthedUser, operation: string): Promise<boolean> {
  const result = await checkRateLimit(
    `ai-provider-${operation}`,
    `${user.clinicId}:${user.id}`,
    { limit: 5, windowSeconds: 15 * 60, failureMode: "closed" },
  );
  return result.allowed;
}

async function verifyCurrentPassword(user: AuthedUser, password: string): Promise<boolean> {
  const verifier = createThrowawayAuthClient();
  const result = await verifier.auth.signInWithPassword({
    email: user.email,
    password,
  });
  if (!result.error) await verifier.auth.signOut();
  return !result.error && result.data.user?.id === user.id;
}

async function genericFailure(): Promise<AiProviderActionResult> {
  return { error: await actionError("aiProvider.couldNotCompleteRequest") };
}

export async function saveAiProviderCredential(
  _previous: AiProviderActionResult | null,
  formData: FormData,
): Promise<AiProviderActionResult> {
  const parsed = credentialSchema.safeParse({
    apiKey: formData.get("apiKey"),
    currentPassword: formData.get("currentPassword") || undefined,
  });
  if (!parsed.success) {
    return { error: await actionError("aiProvider.enterValidCredential") };
  }
  try {
    const user = await requirePrimaryAiAdmin();
    if (!(await operationAllowed(user, "credential-write"))) {
      return { error: await actionError("aiProvider.tooManyRequests") };
    }
    const current = await getAiProviderSettings(user.clinicId);
    if (
      current.connection &&
      (!parsed.data.currentPassword ||
        !(await verifyCurrentPassword(user, parsed.data.currentPassword)))
    ) {
      return { error: await actionError("aiProvider.reauthenticationFailed") };
    }
    const result = await activateAnthropicCredential({
      connectionId: crypto.randomUUID(),
      clinicId: user.clinicId,
      actorId: user.id,
      secret: parsed.data.apiKey,
    });
    if (!result.ok) {
      return {
        error: await actionError(`aiProvider.health.${result.health}`),
        health: result.health,
      };
    }
    revalidatePath("/settings/ai");
    return {
      success: true,
      health: "valid",
      operation: current.connection ? "rotated" : "created",
    };
  } catch {
    return genericFailure();
  }
}

export async function testAiProviderCredential(): Promise<AiProviderActionResult> {
  try {
    const user = await requirePrimaryAiAdmin();
    if (!(await operationAllowed(user, "credential-test"))) {
      return { error: await actionError("aiProvider.tooManyRequests") };
    }
    const health = await testStoredAiProviderConnection({
      clinicId: user.clinicId,
      actorId: user.id,
    });
    revalidatePath("/settings/ai");
    return health === "valid"
      ? { success: true, health }
      : { error: await actionError(`aiProvider.health.${health}`), health };
  } catch {
    return genericFailure();
  }
}

export async function setAiProviderMode(
  _previous: AiProviderActionResult | null,
  formData: FormData,
): Promise<AiProviderActionResult> {
  const parsed = modeSchema.safeParse({
    mode: formData.get("mode"),
    hybridAccepted: formData.get("hybridAccepted") === "on",
    currentPassword: formData.get("currentPassword"),
  });
  if (!parsed.success || (parsed.data.mode === "hybrid" && !parsed.data.hybridAccepted)) {
    return { error: await actionError("aiProvider.acceptHybridDisclosure") };
  }
  try {
    const user = await requirePrimaryAiAdmin();
    if (!(await operationAllowed(user, "mode-write"))) {
      return { error: await actionError("aiProvider.tooManyRequests") };
    }
    if (!(await verifyCurrentPassword(user, parsed.data.currentPassword))) {
      return { error: await actionError("aiProvider.reauthenticationFailed") };
    }
    const entitlements = await getEntitlements(user.clinicId);
    if (!hasAiProviderMode(entitlements, parsed.data.mode)) {
      return { error: await actionError("aiProvider.modeNotIncluded") };
    }
    await updateAiProviderPolicy({
      clinicId: user.clinicId,
      actorId: user.id,
      mode: parsed.data.mode,
      hybridAccepted: parsed.data.hybridAccepted,
    });
    revalidatePath("/settings/ai");
    return { success: true };
  } catch {
    return genericFailure();
  }
}

export async function revokeAiProviderCredential(
  _previous: AiProviderActionResult | null,
  formData: FormData,
): Promise<AiProviderActionResult> {
  const parsed = passwordSchema.safeParse(formData.get("currentPassword"));
  if (!parsed.success) {
    return { error: await actionError("aiProvider.reauthenticationFailed") };
  }
  try {
    const user = await requirePrimaryAiAdmin();
    if (!(await operationAllowed(user, "credential-revoke"))) {
      return { error: await actionError("aiProvider.tooManyRequests") };
    }
    if (!(await verifyCurrentPassword(user, parsed.data))) {
      return { error: await actionError("aiProvider.reauthenticationFailed") };
    }
    await revokeActiveAiProviderConnection({ clinicId: user.clinicId, actorId: user.id });
    revalidatePath("/settings/ai");
    return { success: true };
  } catch {
    return genericFailure();
  }
}

/**
 * Clinic control over the automatic managed→BYOK handover (P12/G1).
 *
 * Not treated as a sensitive credential mutation: it neither reveals nor changes
 * a credential, and it can only ever be the difference between "AI keeps working
 * on the key you already connected" and "AI stops". It is still primary-admin
 * only, still rate limited, and still audited by the RPC, because it does change
 * who pays for a turn.
 */
export async function setAiAutoByokFallbackPreference(
  _previous: AiProviderActionResult | null,
  formData: FormData,
): Promise<AiProviderActionResult> {
  const parsed = autoFallbackSchema.safeParse({
    enabled: formData.get("autoByokFallbackEnabled") === "on",
  });
  if (!parsed.success) return genericFailure();
  try {
    const user = await requirePrimaryAiAdmin();
    if (!(await operationAllowed(user, "auto-fallback-write"))) {
      return { error: await actionError("aiProvider.tooManyRequests") };
    }
    const result = await setAiAutoByokFallback({
      clinicId: user.clinicId,
      actorId: user.id,
      enabled: parsed.data.enabled,
    });
    if (result.error) return genericFailure();
    revalidatePath("/settings/ai");
    return { success: true };
  } catch {
    return genericFailure();
  }
}
