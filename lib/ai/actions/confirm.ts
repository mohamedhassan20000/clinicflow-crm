import "server-only";

import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  claimAiActionConfirmation,
  issueAiActionConfirmation,
  verifyAiActionStepUp,
} from "@/lib/supabase/admin";
import {
  ActionConfirmationError,
  canonicalActionInput,
} from "@/lib/ai/actions/canonical";
import type {
  ActionConfirmationStore,
  ConfirmationClaimOutcome,
  PrivilegedConfirmationBinding,
} from "@/lib/ai/actions/types";

const TOKEN_VERSION = 1;
export const ACTION_CONFIRMATION_TTL_MS = 10 * 60 * 1_000;
export const PRIVILEGED_ACTION_CONFIRMATION_TTL_MS = 2 * 60 * 1_000;

// The canonicaliser is shared with the preview-diff comparison so a field is
// "changed" for the admin's eyes exactly when it is changed for the digest the
// confirm token is bound to (Phase 5f F2).
export {
  ACTION_INPUT_MAX_BYTES,
  ActionConfirmationError,
  canonicalActionInput,
  sameCanonicalValue,
} from "@/lib/ai/actions/canonical";

type ConfirmationPayload = {
  v: typeof TOKEN_VERSION;
  actionId: string;
  inputDigest: string;
  userId: string;
  clinicId: string;
  conversationId: string;
  nonce: string;
  exp: number;
  privileged?: PrivilegedConfirmationBinding;
};

export function actionDigest(value: unknown): string {
  return createHash("sha256")
    .update(canonicalActionInput(value), "utf8")
    .digest("hex");
}

function confirmationKey(): Buffer {
  const raw = process.env.AI_ACTION_CONFIRMATION_HMAC_KEY?.trim();
  if (!raw) throw new ActionConfirmationError("configuration");
  const key = Buffer.from(raw, "base64");
  if (key.length < 32) throw new ActionConfirmationError("configuration");
  return key;
}

function signingMaterial(payload: ConfirmationPayload, canonicalInput: string): string {
  return [
    "clinicflow-ai-action-confirmation",
    JSON.stringify(payload),
    canonicalInput,
  ].join("\u0000");
}

function signature(payload: ConfirmationPayload, canonicalInput: string): Buffer {
  return createHmac("sha256", confirmationKey())
    .update(signingMaterial(payload, canonicalInput), "utf8")
    .digest();
}

export function confirmationTokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function encodeToken(payload: ConfirmationPayload, canonicalInput: string): string {
  return `${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}.${signature(payload, canonicalInput).toString("base64url")}`;
}

function parseToken(token: string): { payload: ConfirmationPayload; signature: Buffer } {
  const [encodedPayload, encodedSignature, extra] = token.split(".");
  if (!encodedPayload || !encodedSignature || extra !== undefined || token.length > 2_500) {
    throw new ActionConfirmationError("invalid");
  }
  try {
    const payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    ) as Partial<ConfirmationPayload>;
    const provided = Buffer.from(encodedSignature, "base64url");
    if (
      payload.v !== TOKEN_VERSION ||
      typeof payload.actionId !== "string" ||
      typeof payload.inputDigest !== "string" ||
      typeof payload.userId !== "string" ||
      typeof payload.clinicId !== "string" ||
      typeof payload.conversationId !== "string" ||
      typeof payload.nonce !== "string" ||
      typeof payload.exp !== "number" ||
      !Number.isSafeInteger(payload.exp) ||
      (payload.privileged !== undefined &&
        (typeof payload.privileged !== "object" ||
          typeof payload.privileged.targetUserId !== "string" ||
          typeof payload.privileged.beforeDigest !== "string" ||
          typeof payload.privileged.afterDigest !== "string")) ||
      provided.length !== 32
    ) {
      throw new ActionConfirmationError("invalid");
    }
    return { payload: payload as ConfirmationPayload, signature: provided };
  } catch (error) {
    if (error instanceof ActionConfirmationError) throw error;
    throw new ActionConfirmationError("invalid");
  }
}

/**
 * Reads the expiry from a token that has already passed execute-time
 * verification. Callers must not use this as an authorization check.
 */
export function actionConfirmationExpiresAt(token: string): string {
  return new Date(parseToken(token).payload.exp).toISOString();
}

export const databaseActionConfirmationStore: ActionConfirmationStore = {
  async issue(input) {
    const { error } = await issueAiActionConfirmation(input);
    if (error) throw new Error("AI action confirmation issue failed.");
  },
  async claim(input) {
    const { data, error } = await claimAiActionConfirmation(input);
    if (error) throw new Error("AI action confirmation claim failed.");
    if (
      data !== "claimed" &&
      data !== "invalid" &&
      data !== "expired" &&
      data !== "replayed"
    ) {
      throw new Error("AI action confirmation claim returned an invalid state.");
    }
    return data as ConfirmationClaimOutcome;
  },
  async verifyStepUp(input) {
    const { data, error } = await verifyAiActionStepUp(input);
    if (error) throw new Error("AI action step-up verification failed.");
    return data === true;
  },
};

export async function issueActionConfirmation(input: {
  actionId: string;
  actionInput: unknown;
  userId: string;
  clinicId: string;
  conversationId: string;
  now?: Date;
  ttlMs?: number;
  privilegedBinding?: PrivilegedConfirmationBinding;
  store?: ActionConfirmationStore;
}): Promise<{ token: string; expiresAt: string; inputDigest: string }> {
  const now = input.now ?? new Date();
  const canonicalInput = canonicalActionInput(input.actionInput);
  const inputDigest = createHash("sha256")
    .update(canonicalInput, "utf8")
    .digest("hex");
  const payload: ConfirmationPayload = {
    v: TOKEN_VERSION,
    actionId: input.actionId,
    inputDigest,
    userId: input.userId,
    clinicId: input.clinicId,
    conversationId: input.conversationId,
    nonce: randomBytes(24).toString("base64url"),
    exp: now.getTime() + (input.ttlMs ?? ACTION_CONFIRMATION_TTL_MS),
    ...(input.privilegedBinding
      ? { privileged: input.privilegedBinding }
      : {}),
  };
  const token = encodeToken(payload, canonicalInput);
  const expiresAt = new Date(payload.exp).toISOString();
  await (input.store ?? databaseActionConfirmationStore).issue({
    tokenHash: confirmationTokenHash(token),
    clinicId: input.clinicId,
    actorId: input.userId,
    conversationId: input.conversationId,
    actionId: input.actionId,
    inputDigest,
    expiresAt,
    riskClass: input.privilegedBinding ? "privileged" : undefined,
    privilegedBinding: input.privilegedBinding,
  });
  return { token, expiresAt, inputDigest };
}

export async function verifyAndClaimActionConfirmation(input: {
  token: string;
  actionId: string;
  actionInput: unknown;
  userId: string;
  clinicId: string;
  conversationId: string;
  now?: Date;
  reauthNonce?: string;
  store?: ActionConfirmationStore;
}): Promise<{
  inputDigest: string;
  idempotencyKey: string;
  privilegedBinding?: PrivilegedConfirmationBinding;
}> {
  const now = input.now ?? new Date();
  const canonicalInput = canonicalActionInput(input.actionInput);
  const currentDigest = createHash("sha256")
    .update(canonicalInput, "utf8")
    .digest("hex");
  const parsed = parseToken(input.token);
  const expected = signature(parsed.payload, canonicalInput);
  if (!timingSafeEqual(parsed.signature, expected)) {
    throw new ActionConfirmationError("invalid");
  }
  if (
    parsed.payload.actionId !== input.actionId ||
    parsed.payload.inputDigest !== currentDigest ||
    parsed.payload.userId !== input.userId ||
    parsed.payload.clinicId !== input.clinicId ||
    parsed.payload.conversationId !== input.conversationId
  ) {
    throw new ActionConfirmationError("invalid");
  }
  if (parsed.payload.exp <= now.getTime()) {
    throw new ActionConfirmationError("expired");
  }

  const tokenHash = confirmationTokenHash(input.token);
  const reauthNonceHash = input.reauthNonce
    ? createHash("sha256").update(input.reauthNonce, "utf8").digest("hex")
    : undefined;
  const claim = await (input.store ?? databaseActionConfirmationStore).claim({
    tokenHash,
    clinicId: input.clinicId,
    actorId: input.userId,
    conversationId: input.conversationId,
    actionId: input.actionId,
    inputDigest: currentDigest,
    consumedAt: now.toISOString(),
    privilegedBinding: parsed.payload.privileged,
    reauthNonceHash,
  });
  if (claim !== "claimed") {
    throw new ActionConfirmationError(claim);
  }
  return {
    inputDigest: currentDigest,
    idempotencyKey: `ai-action:${tokenHash}`,
    ...(parsed.payload.privileged
      ? { privilegedBinding: parsed.payload.privileged }
      : {}),
  };
}

export async function verifyPrivilegedActionStepUp(input: {
  token: string;
  userId: string;
  clinicId: string;
  now?: Date;
  store?: ActionConfirmationStore;
}): Promise<string> {
  const parsed = parseToken(input.token);
  const now = input.now ?? new Date();
  if (
    !parsed.payload.privileged ||
    parsed.payload.userId !== input.userId ||
    parsed.payload.clinicId !== input.clinicId ||
    parsed.payload.exp <= now.getTime()
  ) {
    throw new ActionConfirmationError(
      parsed.payload.exp <= now.getTime() ? "expired" : "invalid",
    );
  }
  const store = input.store ?? databaseActionConfirmationStore;
  if (!store.verifyStepUp) throw new ActionConfirmationError("configuration");
  const reauthNonce = randomBytes(32).toString("base64url");
  const verified = await store.verifyStepUp({
    tokenHash: confirmationTokenHash(input.token),
    clinicId: input.clinicId,
    actorId: input.userId,
    reauthNonceHash: createHash("sha256")
      .update(reauthNonce, "utf8")
      .digest("hex"),
    verifiedAt: now.toISOString(),
  });
  if (!verified) throw new ActionConfirmationError("invalid");
  return reauthNonce;
}
