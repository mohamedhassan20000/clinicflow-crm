import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/types/database";

const url = process.env.LOCAL_SUPABASE_URL ?? "http://127.0.0.1:54321";
function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}
const publishableKey = required("LOCAL_SUPABASE_PUBLISHABLE_KEY");
const secretKey = required("LOCAL_SUPABASE_SECRET_KEY");
type Client = SupabaseClient<Database>;

const suffix = `phase3-actions-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const password = "Phase3ActionFoundation12345";
const clinicA = randomUUID();
const clinicB = randomUUID();
const conversationA = randomUUID();
const conversationB = randomUUID();
const userIds: string[] = [];
const service = createClient<Database>(url, secretKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function sessionClient(): Client {
  return createClient<Database>(url, publishableKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      storageKey: `${suffix}-${Math.random().toString(36).slice(2)}`,
    },
  });
}

async function createUser(label: string) {
  const email = `${suffix}-${label}@example.com`;
  const created = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (created.error || !created.data.user) {
    throw created.error ?? new Error("No user returned");
  }
  userIds.push(created.data.user.id);
  const client = sessionClient();
  const login = await client.auth.signInWithPassword({ email, password });
  if (login.error) throw login.error;
  return { id: created.data.user.id, client };
}

let adminA: Awaited<ReturnType<typeof createUser>>;
let managerA: Awaited<ReturnType<typeof createUser>>;
let receptionistA: Awaited<ReturnType<typeof createUser>>;
let adminB: Awaited<ReturnType<typeof createUser>>;

beforeAll(async () => {
  [adminA, managerA, receptionistA, adminB] = await Promise.all([
    createUser("admin-a"),
    createUser("manager-a"),
    createUser("receptionist-a"),
    createUser("admin-b"),
  ]);

  const clinics = await service.from("clinics").insert([
    { id: clinicA, name: `Phase 3 A ${suffix}` },
    { id: clinicB, name: `Phase 3 B ${suffix}` },
  ]);
  if (clinics.error) throw clinics.error;
  const profiles = await service.from("profiles").insert([
    { id: adminA.id, clinic_id: clinicA, full_name: "Admin A", role: "admin" },
    { id: managerA.id, clinic_id: clinicA, full_name: "Manager A", role: "manager" },
    {
      id: receptionistA.id,
      clinic_id: clinicA,
      full_name: "Receptionist A",
      role: "receptionist",
    },
    { id: adminB.id, clinic_id: clinicB, full_name: "Admin B", role: "admin" },
  ]);
  if (profiles.error) throw profiles.error;
  const conversations = await service.from("agent_conversations").insert([
    {
      id: conversationA,
      clinic_id: clinicA,
      user_id: adminA.id,
      persona: "doctor",
      locale: "en",
    },
    {
      id: conversationB,
      clinic_id: clinicB,
      user_id: adminB.id,
      persona: "doctor",
      locale: "en",
    },
  ]);
  if (conversations.error) throw conversations.error;
}, 60_000);

afterAll(async () => {
  await service
    .from("ai_privileged_action_rate_limits")
    .delete()
    .in("clinic_id", [clinicA, clinicB]);
  await service.from("ai_action_receipts").delete().in("clinic_id", [clinicA, clinicB]);
  await service
    .from("ai_action_confirmations")
    .delete()
    .in("clinic_id", [clinicA, clinicB]);
  await service
    .from("agent_conversations")
    .delete()
    .in("clinic_id", [clinicA, clinicB]);
  await service.from("profiles").delete().in("clinic_id", [clinicA, clinicB]);
  await service.from("clinics").delete().in("id", [clinicA, clinicB]);
  await Promise.all(userIds.map((id) => service.auth.admin.deleteUser(id)));
});

describe("Phase 3 confirmation and receipt RLS", () => {
  it("denies authenticated confirmation table access and control-plane RPC calls", async () => {
    const [read, insert, rpc] = await Promise.all([
      adminA.client.from("ai_action_confirmations").select("id"),
      adminA.client.from("ai_action_confirmations").insert({
        token_hash: "a".repeat(64),
        clinic_id: clinicA,
        actor_id: adminA.id,
        conversation_id: conversationA,
        action_id: "assistant.reference_check",
        input_digest: "b".repeat(64),
        expires_at: "2026-08-13T12:10:00.000Z",
      }),
      adminA.client.rpc("issue_ai_action_confirmation", {
        p_token_hash: "c".repeat(64),
        p_clinic_id: clinicA,
        p_actor_id: adminA.id,
        p_conversation_id: conversationA,
        p_action_id: "assistant.reference_check",
        p_input_digest: "d".repeat(64),
        p_expires_at: "2026-08-13T12:10:00.000Z",
      }),
    ]);
    expect(read.error).not.toBeNull();
    expect(insert.error).not.toBeNull();
    expect(rpc.error).not.toBeNull();
  });

  it("binds issue to the exact conversation owner and clinic", async () => {
    const crossConversation = await service.rpc("issue_ai_action_confirmation", {
      p_token_hash: "e".repeat(64),
      p_clinic_id: clinicA,
      p_actor_id: adminA.id,
      p_conversation_id: conversationB,
      p_action_id: "assistant.reference_check",
      p_input_digest: "f".repeat(64),
      p_expires_at: "2099-08-13T12:10:00.000Z",
    });
    expect(crossConversation.error).not.toBeNull();
  });

  it("claims a fully bound token exactly once and rejects cross-conversation reuse", async () => {
    const tokenHash = "1".repeat(64);
    const inputDigest = "2".repeat(64);
    const claimedAt = new Date(Date.now() + 60_000);
    const replayedAt = new Date(claimedAt.getTime() + 60_000);
    const expiresAt = new Date(claimedAt.getTime() + 10 * 60_000);
    const issued = await service.rpc("issue_ai_action_confirmation", {
      p_token_hash: tokenHash,
      p_clinic_id: clinicA,
      p_actor_id: adminA.id,
      p_conversation_id: conversationA,
      p_action_id: "assistant.reference_check",
      p_input_digest: inputDigest,
      p_expires_at: expiresAt.toISOString(),
    });
    expect(issued.error).toBeNull();

    const cross = await service.rpc("claim_ai_action_confirmation", {
      p_token_hash: tokenHash,
      p_clinic_id: clinicA,
      p_actor_id: adminA.id,
      p_conversation_id: conversationB,
      p_action_id: "assistant.reference_check",
      p_input_digest: inputDigest,
      p_consumed_at: claimedAt.toISOString(),
    });
    expect(cross.error).toBeNull();
    expect(cross.data).toBe("invalid");

    const claimed = await service.rpc("claim_ai_action_confirmation", {
      p_token_hash: tokenHash,
      p_clinic_id: clinicA,
      p_actor_id: adminA.id,
      p_conversation_id: conversationA,
      p_action_id: "assistant.reference_check",
      p_input_digest: inputDigest,
      p_consumed_at: claimedAt.toISOString(),
    });
    expect(claimed.error).toBeNull();
    expect(claimed.data).toBe("claimed");

    const replay = await service.rpc("claim_ai_action_confirmation", {
      p_token_hash: tokenHash,
      p_clinic_id: clinicA,
      p_actor_id: adminA.id,
      p_conversation_id: conversationA,
      p_action_id: "assistant.reference_check",
      p_input_digest: inputDigest,
      p_consumed_at: replayedAt.toISOString(),
    });
    expect(replay.error).toBeNull();
    expect(replay.data).toBe("replayed");
  });

  it("shows in-clinic receipts to admins/managers only and never across tenants", async () => {
    const receiptId = await service.rpc("begin_ai_action_receipt", {
      p_clinic_id: clinicA,
      p_actor_id: adminA.id,
      p_conversation_id: conversationA,
      p_ai_request_id: null,
      p_action_id: "assistant.reference_check",
      p_risk_class: "normal",
      p_phase: "execute",
      p_input_digest: "3".repeat(64),
    });
    expect(receiptId.error).toBeNull();
    const finalized = await service.rpc("finalize_ai_action_receipt", {
      p_receipt_id: receiptId.data!,
      p_clinic_id: clinicA,
      p_actor_id: adminA.id,
      p_authorization_outcome: "allowed",
      p_denial_reason: null,
      p_target_table: "ai_action_confirmations",
      p_target_record_ids: [],
      p_before_digest: "4".repeat(64),
      p_after_digest: "5".repeat(64),
      p_outcome: "success",
      p_error_code: null,
    });
    expect(finalized.error).toBeNull();
    expect(finalized.data).toBe(true);

    const [adminRows, managerRows, receptionistRows, otherClinicRows] =
      await Promise.all([
        adminA.client.from("ai_action_receipts").select("id, outcome"),
        managerA.client.from("ai_action_receipts").select("id, outcome"),
        receptionistA.client.from("ai_action_receipts").select("id, outcome"),
        adminB.client.from("ai_action_receipts").select("id, outcome"),
      ]);
    expect(adminRows.error).toBeNull();
    expect(managerRows.error).toBeNull();
    expect(receptionistRows.error).toBeNull();
    expect(otherClinicRows.error).toBeNull();
    expect(adminRows.data).toContainEqual({ id: receiptId.data, outcome: "success" });
    expect(managerRows.data).toContainEqual({ id: receiptId.data, outcome: "success" });
    expect(receptionistRows.data).toEqual([]);
    expect(otherClinicRows.data).toEqual([]);
  });

  it("denies authenticated receipt inserts even to an admin", async () => {
    const forged = await adminA.client.from("ai_action_receipts").insert({
      clinic_id: clinicA,
      actor_id: adminA.id,
      conversation_id: conversationA,
      action_id: "assistant.reference_check",
      risk_class: "normal",
      phase: "execute",
      authorization_outcome: "allowed",
      input_digest: "6".repeat(64),
      outcome: "success",
    });
    expect(forged.error).not.toBeNull();
  });
});

describe("Phase 5f privileged confirmation and tenant safeguards", () => {
  it("denies authenticated access to step-up and persistent rate-limit control state", async () => {
    const [read, consume, stepUp] = await Promise.all([
      adminA.client.from("ai_privileged_action_rate_limits").select("id"),
      adminA.client.rpc("consume_ai_privileged_action_rate_limit", {
        p_clinic_id: clinicA,
        p_actor_id: adminA.id,
        p_conversation_id: conversationA,
        p_phase: "preview",
        p_occurred_at: new Date().toISOString(),
      }),
      adminA.client.rpc("verify_ai_action_step_up", {
        p_token_hash: "7".repeat(64),
        p_clinic_id: clinicA,
        p_actor_id: adminA.id,
        p_reauth_nonce_hash: "8".repeat(64),
        p_verified_at: new Date().toISOString(),
      }),
    ]);
    expect(read.error).not.toBeNull();
    expect(consume.error).not.toBeNull();
    expect(stepUp.error).not.toBeNull();
  });

  it("binds a privileged token to the same-clinic target, exact diff, and fresh step-up", async () => {
    const now = new Date();
    const expires = new Date(now.getTime() + 110_000);
    const tokenHash = "9".repeat(64);
    const inputDigest = "a".repeat(64);
    const beforeDigest = "b".repeat(64);
    const afterDigest = "c".repeat(64);
    const reauthNonceHash = "d".repeat(64);

    const crossTenantTarget = await service.rpc("issue_ai_action_confirmation", {
      p_token_hash: "e".repeat(64),
      p_clinic_id: clinicA,
      p_actor_id: adminA.id,
      p_conversation_id: conversationA,
      p_action_id: "staff.change_role",
      p_input_digest: inputDigest,
      p_expires_at: expires.toISOString(),
      p_risk_class: "privileged",
      p_target_user_id: adminB.id,
      p_before_digest: beforeDigest,
      p_after_digest: afterDigest,
    });
    expect(crossTenantTarget.error).not.toBeNull();

    const issued = await service.rpc("issue_ai_action_confirmation", {
      p_token_hash: tokenHash,
      p_clinic_id: clinicA,
      p_actor_id: adminA.id,
      p_conversation_id: conversationA,
      p_action_id: "staff.change_role",
      p_input_digest: inputDigest,
      p_expires_at: expires.toISOString(),
      p_risk_class: "privileged",
      p_target_user_id: receptionistA.id,
      p_before_digest: beforeDigest,
      p_after_digest: afterDigest,
    });
    expect(issued.error).toBeNull();

    const legacyBypass = await service.rpc("claim_ai_action_confirmation", {
      p_token_hash: tokenHash,
      p_clinic_id: clinicA,
      p_actor_id: adminA.id,
      p_conversation_id: conversationA,
      p_action_id: "staff.change_role",
      p_input_digest: inputDigest,
      p_consumed_at: now.toISOString(),
    });
    expect(legacyBypass.data).toBe("invalid");

    const steppedUp = await service.rpc("verify_ai_action_step_up", {
      p_token_hash: tokenHash,
      p_clinic_id: clinicA,
      p_actor_id: adminA.id,
      p_reauth_nonce_hash: reauthNonceHash,
      p_verified_at: now.toISOString(),
    });
    expect(steppedUp).toMatchObject({ error: null, data: true });

    const mutatedValue = await service.rpc("claim_ai_action_confirmation", {
      p_token_hash: tokenHash,
      p_clinic_id: clinicA,
      p_actor_id: adminA.id,
      p_conversation_id: conversationA,
      p_action_id: "staff.change_role",
      p_input_digest: inputDigest,
      p_consumed_at: new Date(now.getTime() + 1_000).toISOString(),
      p_target_user_id: receptionistA.id,
      p_before_digest: beforeDigest,
      p_after_digest: "f".repeat(64),
      p_reauth_nonce_hash: reauthNonceHash,
    });
    expect(mutatedValue.data).toBe("invalid");

    const claimed = await service.rpc("claim_ai_action_confirmation", {
      p_token_hash: tokenHash,
      p_clinic_id: clinicA,
      p_actor_id: adminA.id,
      p_conversation_id: conversationA,
      p_action_id: "staff.change_role",
      p_input_digest: inputDigest,
      p_consumed_at: new Date(now.getTime() + 2_000).toISOString(),
      p_target_user_id: receptionistA.id,
      p_before_digest: beforeDigest,
      p_after_digest: afterDigest,
      p_reauth_nonce_hash: reauthNonceHash,
    });
    expect(claimed).toMatchObject({ error: null, data: "claimed" });

    const replay = await service.rpc("claim_ai_action_confirmation", {
      p_token_hash: tokenHash,
      p_clinic_id: clinicA,
      p_actor_id: adminA.id,
      p_conversation_id: conversationA,
      p_action_id: "staff.change_role",
      p_input_digest: inputDigest,
      p_consumed_at: new Date(now.getTime() + 3_000).toISOString(),
      p_target_user_id: receptionistA.id,
      p_before_digest: beforeDigest,
      p_after_digest: afterDigest,
      p_reauth_nonce_hash: reauthNonceHash,
    });
    expect(replay.data).toBe("replayed");
  });

  it("enforces persistent per-conversation privileged preview and execute caps", async () => {
    const at = new Date().toISOString();
    for (let index = 0; index < 5; index += 1) {
      const allowed = await service.rpc("consume_ai_privileged_action_rate_limit", {
        p_clinic_id: clinicA,
        p_actor_id: adminA.id,
        p_conversation_id: conversationA,
        p_phase: "preview",
        p_occurred_at: at,
      });
      expect(allowed).toMatchObject({ error: null, data: true });
    }
    const previewLimited = await service.rpc("consume_ai_privileged_action_rate_limit", {
      p_clinic_id: clinicA,
      p_actor_id: adminA.id,
      p_conversation_id: conversationA,
      p_phase: "preview",
      p_occurred_at: at,
    });
    expect(previewLimited.data).toBe(false);

    for (let index = 0; index < 3; index += 1) {
      const allowed = await service.rpc("consume_ai_privileged_action_rate_limit", {
        p_clinic_id: clinicA,
        p_actor_id: adminA.id,
        p_conversation_id: conversationA,
        p_phase: "execute",
        p_occurred_at: at,
      });
      expect(allowed.data).toBe(true);
    }
    const executeLimited = await service.rpc("consume_ai_privileged_action_rate_limit", {
      p_clinic_id: clinicA,
      p_actor_id: adminA.id,
      p_conversation_id: conversationA,
      p_phase: "execute",
      p_occurred_at: at,
    });
    expect(executeLimited.data).toBe(false);
  });

  it("keeps the database manager guard aligned: manager cannot change role, admin can", async () => {
    const managerAttempt = await managerA.client
      .from("profiles")
      .update({ role: "admin" })
      .eq("id", receptionistA.id)
      .eq("clinic_id", clinicA);
    expect(managerAttempt.error).not.toBeNull();

    const adminAttempt = await adminA.client
      .from("profiles")
      .update({ role: "doctor" })
      .eq("id", receptionistA.id)
      .eq("clinic_id", clinicA);
    expect(adminAttempt.error).toBeNull();
    const restored = await adminA.client
      .from("profiles")
      .update({ role: "receptionist" })
      .eq("id", receptionistA.id)
      .eq("clinic_id", clinicA);
    expect(restored.error).toBeNull();
  });
});
