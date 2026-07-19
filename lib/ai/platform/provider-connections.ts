import "server-only";

import { createAnthropic } from "@ai-sdk/anthropic";
import { APICallError, generateText } from "ai";
import {
  decryptAiCredential,
  encryptAiCredential,
  type AiCredentialProvider,
} from "@/lib/ai/platform/credential-crypto";
import type { AiCredentialMode } from "@/lib/ai/platform/types";
import {
  activateAiProviderConnection,
  createClinicScopedAdminClient,
  recordAiProviderConnectionTest,
  revokeAiProviderConnection,
  setAiProviderPolicy,
} from "@/lib/supabase/admin";

export const HYBRID_DISCLOSURE_VERSION = "p45b-hybrid-disclosure-v1" as const;
export const INITIAL_BYOK_PROVIDER = "anthropic" as const;
const CREDENTIAL_TEST_MODEL = "claude-haiku-4-5";

export type AiProviderHealth =
  | "valid"
  | "invalid"
  | "insufficient_scope"
  | "quota"
  | "provider_unavailable";

export type AiProviderConnectionMetadata = {
  id: string;
  provider: AiCredentialProvider;
  maskedFingerprint: string;
  healthStatus: AiProviderHealth;
  lastErrorCode: Exclude<AiProviderHealth, "valid"> | null;
  activatedAt: string;
  testedAt: string;
  rotatedAt: string | null;
};

export type AiProviderSettings = {
  mode: AiCredentialMode;
  hybridDisclosureVersion: string | null;
  hybridAcceptedAt: string | null;
  connection: AiProviderConnectionMetadata | null;
};

type ActiveCredentialRow = {
  id: string;
  provider: AiCredentialProvider;
  credential_encrypted: string;
  encryption_key_version: number;
  masked_fingerprint: string;
  health_status: AiProviderHealth;
  last_error_code: Exclude<AiProviderHealth, "valid"> | null;
  activated_at: string;
  tested_at: string;
  rotated_at: string | null;
};

export class AiProviderConfigurationError extends Error {
  constructor(
    public readonly reason:
      | "connection_missing"
      | "connection_unhealthy"
      | "credential_unavailable"
      | "policy_invalid"
      | "database_unavailable",
  ) {
    super(`AI provider configuration unavailable: ${reason}`);
    this.name = "AiProviderConfigurationError";
  }
}

function metadata(row: ActiveCredentialRow): AiProviderConnectionMetadata {
  return {
    id: row.id,
    provider: row.provider,
    maskedFingerprint: row.masked_fingerprint,
    healthStatus: row.health_status,
    lastErrorCode: row.last_error_code,
    activatedAt: row.activated_at,
    testedAt: row.tested_at,
    rotatedAt: row.rotated_at,
  };
}

async function loadPolicyAndConnection(clinicId: string): Promise<{
  mode: AiCredentialMode;
  hybridDisclosureVersion: string | null;
  hybridAcceptedAt: string | null;
  connection: ActiveCredentialRow | null;
}> {
  const client = createClinicScopedAdminClient(clinicId);
  const [policyResult, connectionResult] = await Promise.all([
    client
      .from("ai_clinic_provider_policies")
      .select("credential_mode, hybrid_disclosure_version, hybrid_accepted_at")
      .eq("clinic_id", clinicId)
      .maybeSingle(),
    client
      .from("ai_provider_connections")
      .select(
        "id, provider, credential_encrypted, encryption_key_version, masked_fingerprint, health_status, last_error_code, activated_at, tested_at, rotated_at",
      )
      .eq("clinic_id", clinicId)
      .eq("lifecycle_status", "active")
      .maybeSingle(),
  ]);
  if (policyResult.error || connectionResult.error) {
    throw new AiProviderConfigurationError("database_unavailable");
  }
  const rawMode = policyResult.data?.credential_mode ?? "managed";
  if (rawMode !== "managed" && rawMode !== "byok_strict" && rawMode !== "hybrid") {
    throw new AiProviderConfigurationError("policy_invalid");
  }
  const connection = connectionResult.data as ActiveCredentialRow | null;
  return {
    mode: rawMode,
    hybridDisclosureVersion: policyResult.data?.hybrid_disclosure_version ?? null,
    hybridAcceptedAt: policyResult.data?.hybrid_accepted_at ?? null,
    connection,
  };
}

/** Safe projection for the primary-admin settings surface. */
export async function getAiProviderSettings(clinicId: string): Promise<AiProviderSettings> {
  const result = await loadPolicyAndConnection(clinicId);
  return {
    mode: result.mode,
    hybridDisclosureVersion: result.hybridDisclosureVersion,
    hybridAcceptedAt: result.hybridAcceptedAt,
    connection: result.connection ? metadata(result.connection) : null,
  };
}

/** Runtime-only resolution. The plaintext exists only in this returned request scope. */
export async function resolveAiProviderCredential(clinicId: string): Promise<
  | { mode: "managed" }
  | {
      mode: "byok_strict" | "hybrid";
      provider: AiCredentialProvider;
      connectionId: string;
      secret: string;
    }
> {
  const result = await loadPolicyAndConnection(clinicId);
  if (result.mode === "managed") return { mode: "managed" };
  if (
    result.mode === "hybrid" &&
    (result.hybridDisclosureVersion !== HYBRID_DISCLOSURE_VERSION || !result.hybridAcceptedAt)
  ) {
    throw new AiProviderConfigurationError("policy_invalid");
  }
  if (!result.connection) throw new AiProviderConfigurationError("connection_missing");
  if (result.connection.health_status !== "valid") {
    throw new AiProviderConfigurationError("connection_unhealthy");
  }
  try {
    return {
      mode: result.mode,
      provider: result.connection.provider,
      connectionId: result.connection.id,
      secret: decryptAiCredential(
        {
          clinicId,
          provider: result.connection.provider,
          credentialId: result.connection.id,
        },
        result.connection.credential_encrypted,
      ),
    };
  } catch {
    throw new AiProviderConfigurationError("credential_unavailable");
  }
}

export function classifyProviderHealth(error: unknown): Exclude<AiProviderHealth, "valid"> {
  if (APICallError.isInstance(error)) {
    if (error.statusCode === 401) return "invalid";
    if (error.statusCode === 403) return "insufficient_scope";
    if (error.statusCode === 402 || error.statusCode === 429) return "quota";
  }
  return "provider_unavailable";
}

export async function testAnthropicCredential(secret: string): Promise<AiProviderHealth> {
  try {
    const anthropic = createAnthropic({ apiKey: secret });
    await generateText({
      model: anthropic(CREDENTIAL_TEST_MODEL),
      prompt: "Reply with OK.",
      maxOutputTokens: 1,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(15_000),
    });
    return "valid";
  } catch (error) {
    return classifyProviderHealth(error);
  }
}

/** Validates before encrypting, then atomically activates and retires the old key. */
export async function activateAnthropicCredential(input: {
  connectionId: string;
  clinicId: string;
  actorId: string;
  secret: string;
}): Promise<{ ok: true } | { ok: false; health: Exclude<AiProviderHealth, "valid"> }> {
  const health = await testAnthropicCredential(input.secret);
  if (health !== "valid") return { ok: false, health };
  const envelope = encryptAiCredential(
    {
      clinicId: input.clinicId,
      provider: INITIAL_BYOK_PROVIDER,
      credentialId: input.connectionId,
    },
    input.secret,
  );
  const result = await activateAiProviderConnection({
    connectionId: input.connectionId,
    clinicId: input.clinicId,
    actorId: input.actorId,
    provider: INITIAL_BYOK_PROVIDER,
    credentialEncrypted: envelope.encrypted,
    encryptionKeyVersion: envelope.keyVersion,
    maskedFingerprint: envelope.maskedFingerprint,
  });
  if (result.error) throw result.error;
  return { ok: true };
}

export async function testStoredAiProviderConnection(input: {
  clinicId: string;
  actorId: string;
}): Promise<AiProviderHealth> {
  const resolved = await loadPolicyAndConnection(input.clinicId);
  if (!resolved.connection) throw new AiProviderConfigurationError("connection_missing");
  let secret: string;
  try {
    secret = decryptAiCredential(
      {
        clinicId: input.clinicId,
        provider: resolved.connection.provider,
        credentialId: resolved.connection.id,
      },
      resolved.connection.credential_encrypted,
    );
  } catch {
    throw new AiProviderConfigurationError("credential_unavailable");
  }
  const health = await testAnthropicCredential(secret);
  const result = await recordAiProviderConnectionTest({
    connectionId: resolved.connection.id,
    clinicId: input.clinicId,
    actorId: input.actorId,
    healthStatus: health,
    errorCode: health === "valid" ? null : health,
  });
  if (result.error) throw result.error;
  return health;
}

export async function updateAiProviderPolicy(input: {
  clinicId: string;
  actorId: string;
  mode: AiCredentialMode;
  hybridAccepted: boolean;
}): Promise<void> {
  if (input.mode === "hybrid" && !input.hybridAccepted) {
    throw new AiProviderConfigurationError("policy_invalid");
  }
  const result = await setAiProviderPolicy({
    clinicId: input.clinicId,
    actorId: input.actorId,
    credentialMode: input.mode,
    hybridDisclosureVersion: input.mode === "hybrid" ? HYBRID_DISCLOSURE_VERSION : null,
  });
  if (result.error) throw result.error;
}

export async function revokeActiveAiProviderConnection(input: {
  clinicId: string;
  actorId: string;
}): Promise<void> {
  const resolved = await loadPolicyAndConnection(input.clinicId);
  if (!resolved.connection) throw new AiProviderConfigurationError("connection_missing");
  const result = await revokeAiProviderConnection({
    connectionId: resolved.connection.id,
    clinicId: input.clinicId,
    actorId: input.actorId,
  });
  if (result.error) throw result.error;
}
