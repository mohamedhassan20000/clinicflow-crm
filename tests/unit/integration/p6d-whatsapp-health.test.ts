import { createClient } from "@supabase/supabase-js";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { Database } from "@/types/database";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/ai/patient-reply", () => ({
  handlePatientAiInboundMessage: vi.fn(),
}));

import { processMessagingWebhookEvents } from "@/lib/messaging/webhooks";

const url = process.env.LOCAL_SUPABASE_URL ?? "http://127.0.0.1:54321";
const secret = process.env.LOCAL_SUPABASE_SECRET_KEY;
const publishable = process.env.LOCAL_SUPABASE_PUBLISHABLE_KEY;
if (!secret || !publishable) {
  throw new Error(
    "LOCAL_SUPABASE_SECRET_KEY and LOCAL_SUPABASE_PUBLISHABLE_KEY are required",
  );
}
process.env.NEXT_PUBLIC_SUPABASE_URL = url;
process.env.SUPABASE_SERVICE_ROLE_KEY = secret;

const service = createClient<Database>(url, secret, {
  auth: { persistSession: false },
});
const suffix = crypto.randomUUID();
const clinicIds: string[] = [];
const authIds: string[] = [];
let channelA: string;
let templateA: string;
let userA: ReturnType<typeof createClient<Database>>;

beforeAll(async () => {
  const clinics = await service
    .from("clinics")
    .insert([
      { name: `P6D A ${suffix}` },
      { name: `P6D B ${suffix}` },
    ])
    .select("id");
  if (clinics.error) throw clinics.error;
  clinicIds.push(...clinics.data.map((row) => row.id));

  for (let index = 0; index < 2; index += 1) {
    const auth = await service.auth.admin.createUser({
      email: `p6d-${suffix}-${index}@example.com`,
      password: "P6DTesting123!",
      email_confirm: true,
    });
    if (auth.error || !auth.data.user) throw auth.error;
    authIds.push(auth.data.user.id);
  }
  const profiles = await service.from("profiles").insert([
    {
      id: authIds[0]!,
      clinic_id: clinicIds[0]!,
      full_name: "P6D Admin A",
      role: "admin",
    },
    {
      id: authIds[1]!,
      clinic_id: clinicIds[1]!,
      full_name: "P6D Admin B",
      role: "admin",
    },
  ]);
  if (profiles.error) throw profiles.error;

  const channels = await service
    .from("clinic_channels")
    .insert([
      {
        clinic_id: clinicIds[0]!,
        channel: "whatsapp",
        provider: "dialog360",
        sender_identity: `p6d-phone-a-${suffix}`,
        status: "active",
      },
      {
        clinic_id: clinicIds[1]!,
        channel: "whatsapp",
        provider: "meta",
        sender_identity: `p6d-phone-b-${suffix}`,
        provider_account_id: `p6d-waba-b-${suffix}`,
        status: "pending",
        connection_state: "templates_pending",
      },
    ])
    .select("id, clinic_id");
  if (channels.error) throw channels.error;
  channelA = channels.data.find(
    (row) => row.clinic_id === clinicIds[0],
  )!.id;

  const template = await service
    .from("message_templates")
    .insert({
      clinic_id: clinicIds[0]!,
      channel: "whatsapp",
      name: `p6d_template_${suffix.replaceAll("-", "_")}`,
      language: "en",
      body: "Operational fixture",
      approval_status: "approved",
    })
    .select("id")
    .single();
  if (template.error) throw template.error;
  templateA = template.data.id;
  const binding = await service
    .from("message_template_provider_bindings")
    .insert({
      clinic_id: clinicIds[0]!,
      template_id: templateA,
      provider: "dialog360",
      provider_template_id: `p6d-provider-template-${suffix}`,
      approval_status: "approved",
    });
  if (binding.error) throw binding.error;

  const outbound = await service.from("outbound_messages").insert({
    clinic_id: clinicIds[0]!,
    channel: "whatsapp",
    provider: "dialog360",
    recipient: "+12025550123",
    related_type: "manual",
    status: "delivered",
    provider_message_id: `p6d-out-${suffix}`,
    body_preview: "must-not-enter-health-report",
  });
  if (outbound.error) throw outbound.error;

  const inbound = await processMessagingWebhookEvents({
    provider: "dialog360",
    clinicId: clinicIds[0]!,
    events: [
      {
        kind: "inbound",
        phoneNumberId: `p6d-phone-a-${suffix}`,
        sender: "+12025550124",
        providerMessageId: `p6d-in-${suffix}`,
        body: "must-not-enter-health-report",
        receivedAt: "2026-07-28T12:00:00.000Z",
      },
    ],
  });
  expect(inbound.inbound).toBe(1);

  userA = createClient<Database>(url, publishable, {
    auth: { persistSession: false },
  });
  const signedIn = await userA.auth.signInWithPassword({
    email: `p6d-${suffix}-0@example.com`,
    password: "P6DTesting123!",
  });
  if (signedIn.error) throw signedIn.error;
});

afterAll(async () => {
  await service.from("audit_logs").delete().in("clinic_id", clinicIds);
  await service
    .from("inbound_messages")
    .delete()
    .in("clinic_id", clinicIds);
  await service
    .from("outbound_messages")
    .delete()
    .in("clinic_id", clinicIds);
  await service
    .from("message_template_provider_bindings")
    .delete()
    .in("clinic_id", clinicIds);
  await service
    .from("message_templates")
    .delete()
    .in("clinic_id", clinicIds);
  await service.from("conversations").delete().in("clinic_id", clinicIds);
  await service
    .from("clinic_channels")
    .delete()
    .in("clinic_id", clinicIds);
  await service.from("profiles").delete().in("id", authIds);
  await service.from("clinics").delete().in("id", clinicIds);
  for (const id of authIds) await service.auth.admin.deleteUser(id);
});

describe("P6D live WhatsApp health boundaries", () => {
  it("writes one degrade transition for repeated identical failures", async () => {
    const first = await service.rpc("apply_whatsapp_webhook_health", {
      p_clinic_id: clinicIds[0]!,
      p_channel_id: channelA,
      p_status: "degraded",
      p_reason: "configuration_drift",
      p_checked_at: "2026-07-28T12:05:00.000Z",
    });
    const repeated = await service.rpc("apply_whatsapp_webhook_health", {
      p_clinic_id: clinicIds[0]!,
      p_channel_id: channelA,
      p_status: "degraded",
      p_reason: "configuration_drift",
      p_checked_at: "2026-07-28T12:06:00.000Z",
    });
    expect(first.error).toBeNull();
    expect(first.data?.[0]).toMatchObject({
      applied: true,
      transitioned: true,
      health_status: "degraded",
    });
    expect(repeated.data?.[0]).toMatchObject({
      applied: true,
      transitioned: false,
    });

    const audits = await service
      .from("audit_logs")
      .select("id")
      .eq("clinic_id", clinicIds[0]!)
      .eq("action", "messaging:webhook_health")
      .contains("new_data", { to: "degraded" });
    expect(audits.error).toBeNull();
    expect(audits.data).toHaveLength(1);
  });

  it("reconciles operator health stamps with raw lifecycle rows without content", async () => {
    const verified = await service.rpc("apply_whatsapp_webhook_health", {
      p_clinic_id: clinicIds[0]!,
      p_channel_id: channelA,
      p_status: "healthy",
      p_verified_at: "2026-07-28T12:10:00.000Z",
    });
    expect(verified.error).toBeNull();

    const [report, rawInbound, rawOutbound] = await Promise.all([
      service.rpc("operator_whatsapp_health_report"),
      service
        .from("inbound_messages")
        .select("received_at")
        .eq("clinic_id", clinicIds[0]!)
        .order("received_at", { ascending: false })
        .limit(1)
        .single(),
      service
        .from("outbound_messages")
        .select("status, status_updated_at")
        .eq("clinic_id", clinicIds[0]!)
        .order("status_updated_at", { ascending: false })
        .limit(1)
        .single(),
    ]);
    expect(report.error).toBeNull();
    const row = report.data?.find(
      (candidate) => candidate.channel_id === channelA,
    );
    expect(row).toMatchObject({
      clinic_id: clinicIds[0],
      provider: "dialog360",
      webhook_health_status: "healthy",
      last_verified_webhook_at: "2026-07-28T12:10:00+00:00",
      approved_templates: 1,
      last_inbound_at: rawInbound.data?.received_at,
      last_outbound_at: rawOutbound.data?.status_updated_at,
      last_outbound_status: rawOutbound.data?.status,
    });
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain("must-not-enter-health-report");
    expect(serialized).not.toContain("recipient");
    expect(serialized).not.toContain("sender");
    expect(serialized).not.toContain("credential");
  });

  it("denies authenticated/anonymous channel and RPC reads across clinics", async () => {
    const directChannels = await userA
      .from("clinic_channels")
      .select("id, clinic_id");
    expect(directChannels.error).toBeNull();
    expect(directChannels.data).toEqual([]);

    const visibleAudits = await userA
      .from("audit_logs")
      .select("clinic_id")
      .eq("action", "messaging:webhook_health");
    expect(visibleAudits.error).toBeNull();
    expect(
      visibleAudits.data?.every((row) => row.clinic_id === clinicIds[0]),
    ).toBe(true);

    const anonymous = createClient<Database>(url, publishable, {
      auth: { persistSession: false },
    });
    const deniedWrite = await anonymous.rpc(
      "apply_whatsapp_webhook_health",
      {
        p_clinic_id: clinicIds[1]!,
        p_channel_id: channelA,
        p_status: "healthy",
      },
    );
    const deniedReport = await anonymous.rpc(
      "operator_whatsapp_health_report",
    );
    expect(deniedWrite.error).not.toBeNull();
    expect(deniedReport.error).not.toBeNull();
  });
});
