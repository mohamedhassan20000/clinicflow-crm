import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/types/database";

const url = process.env.LOCAL_SUPABASE_URL ?? "http://127.0.0.1:54321";
function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}

const service = createClient<Database>(
  url,
  required("LOCAL_SUPABASE_SECRET_KEY"),
  { auth: { autoRefreshToken: false, persistSession: false } },
);
const anon = createClient<Database>(
  url,
  required("LOCAL_SUPABASE_PUBLISHABLE_KEY"),
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const suffix = `p6c-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const clinicA = randomUUID();
const clinicB = randomUUID();
const dialogA = randomUUID();
const dialogB = randomUUID();
const metaA = randomUUID();
const metaB = randomUUID();
const templateA = randomUUID();

async function cleanup() {
  await service.from("audit_logs").delete().in("clinic_id", [clinicA, clinicB]);
  await service
    .from("message_template_provider_bindings")
    .delete()
    .in("clinic_id", [clinicA, clinicB]);
  await service.from("message_templates").delete().in("clinic_id", [clinicA, clinicB]);
  await service.from("clinic_channels").delete().in("clinic_id", [clinicA, clinicB]);
  await service.from("clinics").delete().in("id", [clinicA, clinicB]);
}

beforeAll(async () => {
  await cleanup();
  const clinics = await service.from("clinics").insert([
    { id: clinicA, name: `P6C Clinic A ${suffix}` },
    { id: clinicB, name: `P6C Clinic B ${suffix}` },
  ]);
  if (clinics.error) throw clinics.error;
  const channels = await service.from("clinic_channels").insert([
    {
      id: dialogA,
      clinic_id: clinicA,
      channel: "whatsapp",
      provider: "dialog360",
      credentials_encrypted: `\\x01${"ab".repeat(40)}`,
      sender_identity: `${suffix}-dialog-a`,
      status: "active",
      webhook_subscribed: false,
    },
    {
      id: dialogB,
      clinic_id: clinicB,
      channel: "whatsapp",
      provider: "dialog360",
      credentials_encrypted: `\\x01${"bc".repeat(40)}`,
      sender_identity: `${suffix}-dialog-b`,
      status: "active",
      webhook_subscribed: false,
    },
    {
      id: metaA,
      clinic_id: clinicA,
      channel: "whatsapp",
      provider: "meta",
      provider_account_id: `${suffix}-waba-a`,
      credentials_encrypted: `\\x01${"cd".repeat(40)}`,
      sender_identity: `${suffix}-meta-a`,
      status: "pending",
      connection_state: "connecting_to_meta",
      webhook_subscribed: true,
    },
    {
      id: metaB,
      clinic_id: clinicB,
      channel: "whatsapp",
      provider: "meta",
      provider_account_id: `${suffix}-waba-b`,
      sender_identity: `${suffix}-meta-b`,
      status: "error",
      connection_state: "verification_failed",
      webhook_subscribed: false,
    },
  ]);
  if (channels.error) throw channels.error;
  const template = await service.from("message_templates").insert({
    id: templateA,
    clinic_id: clinicA,
    channel: "whatsapp",
    name: `${suffix}_reminder`,
    language: "en",
    body: "Appointment reminder",
    approval_status: "approved",
    provider_template_id: `${suffix}-dialog-template`,
  });
  if (template.error) throw template.error;
  const bindings = await service.from("message_template_provider_bindings").insert([
    {
      clinic_id: clinicA,
      template_id: templateA,
      provider: "dialog360",
      provider_template_id: `${suffix}-dialog-template`,
      approval_status: "approved",
    },
    {
      clinic_id: clinicA,
      template_id: templateA,
      provider: "meta",
      provider_account_id: `${suffix}-waba-a`,
      provider_template_id: `${suffix}-meta-template`,
      approval_status: "submitted",
    },
  ]);
  if (bindings.error) throw bindings.error;
}, 30_000);

afterAll(cleanup, 30_000);

describe("P6C review-fix database boundaries", () => {
  it("keeps 360dialog and Meta rows/credentials in parallel", async () => {
    const rows = await service
      .from("clinic_channels")
      .select("id, provider, status, credentials_encrypted")
      .eq("clinic_id", clinicA)
      .eq("channel", "whatsapp")
      .order("provider");
    expect(rows.error).toBeNull();
    expect(rows.data).toHaveLength(2);
    expect(rows.data?.map((row) => row.provider)).toEqual(["dialog360", "meta"]);
    expect(rows.data?.every((row) => row.credentials_encrypted !== null)).toBe(true);
  });

  it("enforces identity ownership across providers and clinics", async () => {
    const collision = await service
      .from("clinic_channels")
      .update({ sender_identity: `${suffix}-dialog-a` })
      .eq("id", metaB);
    expect(collision.error?.code).toBe("23505");
  });

  it("fairly claims pending/error Meta channels without letting one failed row monopolize the page", async () => {
    const first = await service.rpc("claim_meta_channels_for_reconciliation", {
      p_limit: 1,
    });
    const second = await service.rpc("claim_meta_channels_for_reconciliation", {
      p_limit: 1,
    });
    expect(first.error).toBeNull();
    expect(second.error).toBeNull();
    expect(first.data).toHaveLength(1);
    expect(second.data).toHaveLength(1);
    expect(first.data?.[0]?.id).not.toBe(second.data?.[0]?.id);
    expect(new Set([first.data?.[0]?.id, second.data?.[0]?.id])).toEqual(
      new Set([metaA, metaB]),
    );
  });

  it("applies one concurrent state transition, writes one audit row, and atomically cuts over", async () => {
    const before = await service
      .from("clinic_channels")
      .select("updated_at")
      .eq("id", metaA)
      .single();
    if (before.error || !before.data) throw before.error;
    const args: Database["public"]["Functions"]["apply_meta_channel_state"]["Args"] = {
      p_clinic_id: clinicA,
      p_channel_id: metaA,
      p_expected_updated_at: before.data.updated_at,
      p_status: "active",
      p_connection_state: "connected",
      p_business_verification_status: null,
      p_account_review_status: "APPROVED",
      p_phone_status: "VERIFIED",
      p_quality_rating: "GREEN",
      p_messaging_limit_tier: null,
      p_webhook_subscribed: true,
      p_last_state_reason: null,
      p_last_synced_at: new Date().toISOString(),
      p_last_signal_at: new Date().toISOString(),
    };
    const [first, second] = await Promise.all([
      service.rpc("apply_meta_channel_state", args),
      service.rpc("apply_meta_channel_state", args),
    ]);
    expect(first.error).toBeNull();
    expect(second.error).toBeNull();
    expect(
      [...(first.data ?? []), ...(second.data ?? [])].filter(
        (row) => row.transitioned,
      ),
    ).toHaveLength(1);

    const rows = await service
      .from("clinic_channels")
      .select("provider, status, connection_state")
      .eq("clinic_id", clinicA)
      .eq("channel", "whatsapp");
    expect(rows.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: "meta", status: "active", connection_state: "connected" }),
        expect.objectContaining({ provider: "dialog360", status: "pending" }),
      ]),
    );
    const audit = await service
      .from("audit_logs")
      .select("id")
      .eq("clinic_id", clinicA)
      .eq("action", "messaging:connection_state")
      .eq("record_id", metaA);
    expect(audit.data).toHaveLength(1);
  });

  it("atomically applies and audits one provider-scoped template transition", async () => {
    const args: Database["public"]["Functions"]["apply_message_template_provider_status"]["Args"] = {
      p_provider: "meta",
      p_provider_template_id: `${suffix}-meta-template`,
      p_status: "approved",
      p_allowed_from: ["submitted", "rejected"],
    };
    const [first, second] = await Promise.all([
      service.rpc("apply_message_template_provider_status", args),
      service.rpc("apply_message_template_provider_status", args),
    ]);
    expect(first.error).toBeNull();
    expect(second.error).toBeNull();
    expect([...(first.data ?? []), ...(second.data ?? [])]).toHaveLength(1);
    const bindings = await service
      .from("message_template_provider_bindings")
      .select("provider, approval_status")
      .eq("template_id", templateA)
      .order("provider");
    expect(bindings.data).toEqual([
      { provider: "dialog360", approval_status: "approved" },
      { provider: "meta", approval_status: "approved" },
    ]);
    const audit = await service
      .from("audit_logs")
      .select("id")
      .eq("clinic_id", clinicA)
      .eq("action", "messaging:template_status")
      .eq("record_id", templateA);
    expect(audit.data).toHaveLength(1);
  });

  it("keeps provider bindings and transition RPCs unavailable to anon", async () => {
    const read = await anon.from("message_template_provider_bindings").select("id");
    expect(read.data ?? []).toEqual([]);
    const rpc = await anon.rpc("apply_meta_channel_state", {
      p_clinic_id: clinicA,
      p_channel_id: metaA,
      p_expected_updated_at: new Date().toISOString(),
      p_status: "active",
      p_connection_state: "connected",
      p_business_verification_status: null,
      p_account_review_status: "APPROVED",
      p_phone_status: "VERIFIED",
      p_quality_rating: null,
      p_messaging_limit_tier: null,
      p_webhook_subscribed: true,
      p_last_state_reason: null,
    });
    expect(rpc.error).not.toBeNull();
  });
});
