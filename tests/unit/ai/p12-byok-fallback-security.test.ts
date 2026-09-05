/**
 * P12 — the automatic handover must not become a hole in BYOK's security model.
 *
 * `resolveByokFallbackCredential` is a NEW way to reach a clinic's decrypted
 * Anthropic key, so it inherits every constraint the configured path already
 * had: clinic-scoped reads, AAD-bound decryption, healthy-connection-only, and
 * a plaintext lifetime that ends with the request.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  scopedClient: vi.fn(),
  decrypt: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createClinicScopedAdminClient: mocks.scopedClient,
  activateAiProviderConnection: vi.fn(),
  recordAiProviderConnectionTest: vi.fn(),
  revokeAiProviderConnection: vi.fn(),
  setAiProviderPolicy: vi.fn(),
}));
vi.mock("@/lib/ai/platform/credential-crypto", () => ({
  decryptAiCredential: mocks.decrypt,
  encryptAiCredential: vi.fn(),
}));
vi.mock("@ai-sdk/anthropic", () => ({ createAnthropic: vi.fn() }));
vi.mock("ai", () => ({
  APICallError: { isInstance: () => false },
  generateText: vi.fn(),
}));

import { resolveByokFallbackCredential } from "@/lib/ai/platform/provider-connections";

const CLINIC = "00000000-0000-4000-8000-000000000002";
const CONNECTION_ID = "00000000-0000-4000-8000-0000000000c1";
const SECRET = "sk-ant-clinic-owned-secret";

type Policy = { credential_mode: string; auto_byok_fallback_enabled: boolean } | null;
type Connection = Record<string, unknown> | null;

function connection(overrides: Record<string, unknown> = {}): Connection {
  return {
    id: CONNECTION_ID,
    provider: "anthropic",
    credential_encrypted: "envelope",
    encryption_key_version: 1,
    masked_fingerprint: "sk-…3f9a",
    health_status: "valid",
    last_error_code: null,
    activated_at: "2026-08-01T00:00:00Z",
    tested_at: "2026-08-01T00:00:00Z",
    rotated_at: null,
    ...overrides,
  };
}

function stub(policy: Policy, conn: Connection, options: { error?: boolean } = {}) {
  const seen: string[] = [];
  mocks.scopedClient.mockImplementation((clinicId: string) => {
    seen.push(clinicId);
    return {
      from(table: string) {
        const data = table === "ai_clinic_provider_policies" ? policy : conn;
        const chain = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: async () =>
            options.error ? { data: null, error: new Error("db down") } : { data, error: null },
        };
        return chain;
      },
    };
  });
  return seen;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.decrypt.mockReturnValue(SECRET);
});

describe("resolveByokFallbackCredential", () => {
  it("returns the clinic's own key when one is healthy and fallback is allowed", async () => {
    const seen = stub({ credential_mode: "managed", auto_byok_fallback_enabled: true }, connection());
    const resolved = await resolveByokFallbackCredential(CLINIC);
    expect(resolved).toEqual({
      provider: "anthropic",
      connectionId: CONNECTION_ID,
      secret: SECRET,
    });
    // Reads go through the clinic-scoped admin client, for this clinic only.
    expect(new Set(seen)).toEqual(new Set([CLINIC]));
  });

  it("binds decryption to this clinic, this provider and this credential id", async () => {
    stub({ credential_mode: "managed", auto_byok_fallback_enabled: true }, connection());
    await resolveByokFallbackCredential(CLINIC);
    expect(mocks.decrypt).toHaveBeenCalledWith(
      { clinicId: CLINIC, provider: "anthropic", credentialId: CONNECTION_ID },
      "envelope",
    );
  });

  it("declines when the clinic turned the automatic handover off", async () => {
    stub({ credential_mode: "managed", auto_byok_fallback_enabled: false }, connection());
    await expect(resolveByokFallbackCredential(CLINIC)).resolves.toBeNull();
    expect(mocks.decrypt).not.toHaveBeenCalled();
  });

  it("declines when there is no connection at all", async () => {
    stub({ credential_mode: "managed", auto_byok_fallback_enabled: true }, null);
    await expect(resolveByokFallbackCredential(CLINIC)).resolves.toBeNull();
  });

  it("declines an unhealthy or revoked credential rather than trying it", async () => {
    for (const health of ["invalid", "quota", "insufficient_scope", "provider_unavailable"]) {
      vi.clearAllMocks();
      mocks.decrypt.mockReturnValue(SECRET);
      stub(
        { credential_mode: "managed", auto_byok_fallback_enabled: true },
        connection({ health_status: health }),
      );
      await expect(resolveByokFallbackCredential(CLINIC)).resolves.toBeNull();
      expect(mocks.decrypt).not.toHaveBeenCalled();
    }
  });

  it("declines — never throws — when the envelope cannot be decrypted", async () => {
    stub({ credential_mode: "managed", auto_byok_fallback_enabled: true }, connection());
    mocks.decrypt.mockImplementation(() => {
      throw new Error("DECRYPT_FAILED");
    });
    await expect(resolveByokFallbackCredential(CLINIC)).resolves.toBeNull();
  });

  it("declines when the lookup itself fails, so a database blip cannot spend a key", async () => {
    stub({ credential_mode: "managed", auto_byok_fallback_enabled: true }, connection(), {
      error: true,
    });
    await expect(resolveByokFallbackCredential(CLINIC)).resolves.toBeNull();
  });

  it("returns no ciphertext, key version, or fingerprint to its caller", async () => {
    stub({ credential_mode: "managed", auto_byok_fallback_enabled: true }, connection());
    const resolved = await resolveByokFallbackCredential(CLINIC);
    expect(Object.keys(resolved ?? {}).sort()).toEqual([
      "connectionId",
      "provider",
      "secret",
    ]);
  });
});
