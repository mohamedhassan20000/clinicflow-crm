import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  createScoped: vi.fn(),
  telemetry: vi.fn(),
  applyHealth: vi.fn(),
  claimHealth: vi.fn(),
  configureDialogWebhook: vi.fn(),
  decrypt: vi.fn(),
  getDialogWebhook: vi.fn(),
  logEvent: vi.fn(),
}));

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({
  createClinicScopedAdminClient: mocks.createScoped,
  applyMessageTemplateProviderStatus: vi.fn(),
  applyWhatsAppWebhookHealth: mocks.applyHealth,
  claimWhatsAppChannelsForHealthCheck: mocks.claimHealth,
  getWhatsAppChannelStateRow: vi.fn(),
  logMessagingEvent: mocks.logEvent,
}));
vi.mock("@/lib/messaging/webhook-telemetry", () => ({
  getWebhookRouteTelemetry: mocks.telemetry,
}));
vi.mock("@/lib/messaging/crypto", () => ({
  decryptChannelCredentials: mocks.decrypt,
}));
vi.mock("@/lib/messaging/meta-reconcile", () => ({
  reconcileMetaChannel: vi.fn(),
}));
vi.mock("@/lib/messaging/whatsapp-dialog360", () => ({
  configureDialog360Webhook: mocks.configureDialogWebhook,
  fetchDialog360Templates: vi.fn(),
  getDialog360WebhookConfiguration: mocks.getDialogWebhook,
}));
vi.mock("@/lib/messaging/whatsapp-meta", () => ({
  getMetaWabaSubscription: vi.fn(),
  subscribeMetaWabaWebhook: vi.fn(),
  testMetaConnectivity: vi.fn(),
}));

import {
  getWhatsAppHealthSnapshot,
  runWhatsAppHealthAction,
  runWhatsAppHealthChecks,
} from "@/lib/messaging/health";

type Result = { data: unknown; error: null };

function query(result: Result) {
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "eq", "in", "like", "order", "limit", "update"]) {
    builder[method] = () => builder;
  }
  builder.maybeSingle = async () => result;
  builder.then = (
    resolve: (value: Result) => unknown,
    reject: (reason: unknown) => unknown,
  ) => Promise.resolve(result).then(resolve, reject);
  return builder;
}

function scopedClient(results: Record<string, Result[]>) {
  return {
    from: (table: string) => {
      const result = results[table]?.shift();
      if (!result) throw new Error(`Unexpected table read: ${table}`);
      return query(result);
    },
  };
}

function channel(
  provider: "meta" | "dialog360",
  overrides: Record<string, unknown> = {},
) {
  return {
    id: `channel-${provider}`,
    provider,
    status: "active",
    connection_state: provider === "meta" ? "connected" : null,
    last_state_reason: null,
    business_verification_status: null,
    account_review_status: provider === "meta" ? "APPROVED" : null,
    phone_status: provider === "meta" ? "VERIFIED" : null,
    quality_rating: provider === "meta" ? "GREEN" : null,
    messaging_limit_tier: provider === "meta" ? "TIER_1K" : null,
    last_synced_at: "2026-07-28T10:00:00.000Z",
    webhook_health_status: "healthy",
    webhook_health_reason: null,
    last_verified_webhook_at: "2026-07-28T11:00:00.000Z",
    last_webhook_check_at: "2026-07-28T10:30:00.000Z",
    ...overrides,
  };
}

function metaSnapshotClient(overrides: Record<string, unknown> = {}) {
  return scopedClient({
    clinic_channels: [{ data: [channel("meta", overrides)], error: null }],
    inbound_messages: [{ data: null, error: null }],
    outbound_messages: [{ data: null, error: null }],
    message_template_provider_bindings: [
      { data: [{ approval_status: "approved" }], error: null },
    ],
    audit_logs: [{ data: [], error: null }],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.telemetry.mockResolvedValue({
    signatureFailures: 2,
    rateLimitRejections: 1,
    windowHours: 24,
  });
  mocks.applyHealth.mockResolvedValue({
    data: [{ applied: true, transitioned: false, health_status: "healthy" }],
    error: null,
  });
  mocks.logEvent.mockResolvedValue({ data: "audit-id", error: null });
  mocks.claimHealth.mockResolvedValue({ data: [], error: null });
});

describe("P6D WhatsApp health safe snapshot", () => {
  it("renders the derived subset for 360dialog and marks Meta-only checks unavailable", async () => {
    mocks.createScoped.mockReturnValue(
      scopedClient({
        clinic_channels: [{ data: [channel("dialog360")], error: null }],
        inbound_messages: [
          { data: { received_at: "2026-07-28T12:00:00.000Z" }, error: null },
        ],
        outbound_messages: [
          {
            data: {
              status: "delivered",
              status_updated_at: "2026-07-28T11:30:00.000Z",
            },
            error: null,
          },
        ],
        message_template_provider_bindings: [
          { data: [{ approval_status: "approved" }], error: null },
        ],
        message_templates: [
          { data: [{ approval_status: "approved" }], error: null },
        ],
        audit_logs: [
          {
            data: [
              {
                id: "audit-1",
                action: "messaging:webhook_health",
                new_data: {
                  provider: "dialog360",
                  from: "degraded",
                  to: "healthy",
                },
                created_at: "2026-07-28T10:45:00.000Z",
              },
            ],
            error: null,
          },
        ],
      }),
    );

    const snapshot = await getWhatsAppHealthSnapshot("clinic-a");

    expect(snapshot).toMatchObject({
      provider: "dialog360",
      meta: null,
      webhook: {
        status: "healthy",
        signatureFailures: 2,
        rateLimitRejections: 1,
      },
      templates: { approved: 1 },
      readiness: { ready: true },
    });
    expect(
      snapshot.readiness.checks
        .filter((check) =>
          ["business_verification", "quality"].includes(check.key),
        )
        .every((check) => check.status === "unavailable"),
    ).toBe(true);
  });

  it("shows the full Meta signal set and derives readiness only from real sources", async () => {
    mocks.createScoped.mockReturnValue(
      scopedClient({
        clinic_channels: [{ data: [channel("meta")], error: null }],
        inbound_messages: [{ data: null, error: null }],
        outbound_messages: [{ data: null, error: null }],
        message_template_provider_bindings: [
          {
            data: [
              { approval_status: "approved" },
              { approval_status: "submitted" },
            ],
            error: null,
          },
        ],
        audit_logs: [{ data: [], error: null }],
      }),
    );

    const snapshot = await getWhatsAppHealthSnapshot("clinic-a");

    expect(snapshot.meta).toEqual({
      businessVerificationStatus: null,
      accountReviewStatus: "APPROVED",
      phoneStatus: "VERIFIED",
      qualityRating: "GREEN",
      messagingLimitTier: "TIER_1K",
    });
    expect(snapshot.readiness.ready).toBe(true);
    expect(
      snapshot.readiness.checks.find(
        (check) => check.key === "business_verification",
      ),
    ).toMatchObject({ status: "passed", value: "APPROVED" });
  });

  it.each([
    "not_verified",
    "unverified",
    "pending",
    "rejected",
    "expired",
    "revoked",
    "",
    null,
    "complete",
    "passed",
    "approved_later",
  ])(
    "fails Meta business readiness for non-approved state %j",
    async (businessVerificationStatus) => {
      mocks.createScoped.mockReturnValue(
        metaSnapshotClient({
          business_verification_status: businessVerificationStatus,
          account_review_status: null,
        }),
      );

      const snapshot = await getWhatsAppHealthSnapshot("clinic-a");

      expect(
        snapshot.readiness.checks.find(
          (check) => check.key === "business_verification",
        ),
      ).toMatchObject({ status: "failed" });
      expect(snapshot.readiness.ready).toBe(false);
    },
  );

  it.each(["verified", "APPROVED"])(
    "passes Meta business readiness only for allow-listed state %s",
    async (businessVerificationStatus) => {
      mocks.createScoped.mockReturnValue(
        metaSnapshotClient({
          business_verification_status: businessVerificationStatus,
          account_review_status: null,
        }),
      );

      const snapshot = await getWhatsAppHealthSnapshot("clinic-a");

      expect(
        snapshot.readiness.checks.find(
          (check) => check.key === "business_verification",
        ),
      ).toMatchObject({ status: "passed" });
      expect(snapshot.readiness.ready).toBe(true);
    },
  );

  it.each([
    "UNKNOWN",
    "",
    null,
    "RED",
    "DEGRADED",
    "POOR",
    "BLOCKED",
    "BLUE",
    "GREENISH",
  ])(
    "fails Meta quality readiness for non-healthy state %j",
    async (qualityRating) => {
      mocks.createScoped.mockReturnValue(
        metaSnapshotClient({ quality_rating: qualityRating }),
      );

      const snapshot = await getWhatsAppHealthSnapshot("clinic-a");

      expect(
        snapshot.readiness.checks.find(
          (check) => check.key === "quality",
        ),
      ).toMatchObject({ status: "failed" });
      expect(snapshot.readiness.ready).toBe(false);
    },
  );

  it.each(["GREEN", "yellow"])(
    "passes Meta quality readiness only for allow-listed state %s",
    async (qualityRating) => {
      mocks.createScoped.mockReturnValue(
        metaSnapshotClient({ quality_rating: qualityRating }),
      );

      const snapshot = await getWhatsAppHealthSnapshot("clinic-a");

      expect(
        snapshot.readiness.checks.find(
          (check) => check.key === "quality",
        ),
      ).toMatchObject({ status: "passed" });
      expect(snapshot.readiness.ready).toBe(true);
    },
  );

  it("sorts audit and derived events newest-first and sends no credential/content fields", async () => {
    mocks.createScoped.mockReturnValue(
      scopedClient({
        clinic_channels: [{ data: [channel("meta")], error: null }],
        inbound_messages: [
          { data: { received_at: "2026-07-28T12:00:00.000Z" }, error: null },
        ],
        outbound_messages: [
          {
            data: {
              status: "sent",
              status_updated_at: "2026-07-28T12:30:00.000Z",
            },
            error: null,
          },
        ],
        message_template_provider_bindings: [
          { data: [{ approval_status: "approved" }], error: null },
        ],
        audit_logs: [
          {
            data: [
              {
                id: "audit-recovery",
                action: "messaging:health_action",
                new_data: {
                  action: "test_connectivity",
                  provider: "meta",
                  ignored_secret: "must-not-pass-through",
                },
                created_at: "2026-07-28T13:00:00.000Z",
              },
              {
                id: "audit-template",
                action: "messaging:template_status",
                new_data: { provider: "meta", status: "approved" },
                created_at: "2026-07-28T09:00:00.000Z",
              },
            ],
            error: null,
          },
        ],
      }),
    );

    const snapshot = await getWhatsAppHealthSnapshot("clinic-a");
    const timestamps = snapshot.timeline.map((event) =>
      new Date(event.occurredAt).valueOf(),
    );
    expect(timestamps).toEqual([...timestamps].sort((a, b) => b - a));
    expect(snapshot.timeline[0]).toMatchObject({
      type: "recovery",
      action: "test_connectivity",
    });
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("ignored_secret");
    expect(serialized).not.toContain("must-not-pass-through");
    expect(serialized).not.toContain("credentials_encrypted");
    expect(serialized).not.toContain("body");
    expect(serialized).not.toContain("recipient");
    expect(mocks.createScoped).toHaveBeenCalledWith("clinic-a");
  });

  it("keeps the timeline empty when no audit row or real derived stamp exists", async () => {
    mocks.createScoped.mockReturnValue(
      scopedClient({
        clinic_channels: [
          {
            data: [
              channel("dialog360", {
                last_synced_at: null,
                last_verified_webhook_at: null,
              }),
            ],
            error: null,
          },
        ],
        inbound_messages: [{ data: null, error: null }],
        outbound_messages: [{ data: null, error: null }],
        message_template_provider_bindings: [{ data: [], error: null }],
        message_templates: [{ data: [], error: null }],
        audit_logs: [{ data: [], error: null }],
      }),
    );

    const snapshot = await getWhatsAppHealthSnapshot("clinic-a");
    expect(snapshot.timeline).toEqual([]);
    expect(snapshot.readiness.ready).toBe(false);
  });
});

describe("P6D recovery actions", () => {
  it("detects a broken webhook within one cron run without auto-repairing it", async () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://clinic.example";
    mocks.claimHealth.mockResolvedValue({
      data: [
        {
          id: "channel-dialog360",
          clinic_id: "clinic-a",
          provider: "dialog360",
        },
      ],
      error: null,
    });
    mocks.createScoped.mockReturnValue(
      scopedClient({
        clinic_channels: [
          {
            data: [
              {
                id: "channel-dialog360",
                provider: "dialog360",
                status: "active",
                credentials_encrypted: "ciphertext",
                connection_state: null,
                updated_at: "2026-07-28T00:00:00.000Z",
              },
            ],
            error: null,
          },
        ],
      }),
    );
    mocks.decrypt.mockReturnValue({
      apiKey: "api-key",
      webhookUsername: "clinicflow-user",
      webhookSecret: "webhook-secret",
    });
    mocks.getDialogWebhook.mockResolvedValue({
      ok: true,
      configuration: {
        url: "https://wrong.example/webhook",
        headers: {},
      },
    });

    await expect(runWhatsAppHealthChecks()).resolves.toEqual({
      scanned: 1,
      healthy: 0,
      degraded: 1,
      failed: 0,
    });
    expect(mocks.applyHealth).toHaveBeenCalledWith(
      expect.objectContaining({
        clinicId: "clinic-a",
        channelId: "channel-dialog360",
        status: "degraded",
        reason: "configuration_drift",
      }),
    );
    expect(mocks.configureDialogWebhook).not.toHaveBeenCalled();
    delete process.env.NEXT_PUBLIC_SITE_URL;
  });

  it("keeps an already-correct webhook repair idempotent and audit-logs every run", async () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://clinic.example";
    const row = {
      id: "channel-dialog360",
      provider: "dialog360",
      status: "active",
      credentials_encrypted: "ciphertext",
      connection_state: null,
      updated_at: "2026-07-28T00:00:00.000Z",
    };
    mocks.createScoped.mockReturnValue(
      scopedClient({
        clinic_channels: [
          { data: [row], error: null },
          { data: [row], error: null },
          { data: [row], error: null },
          { data: [row], error: null },
        ],
      }),
    );
    mocks.decrypt.mockReturnValue({
      apiKey: "api-key",
      webhookUsername: "clinicflow-user",
      webhookSecret: "webhook-secret",
    });
    mocks.getDialogWebhook.mockResolvedValue({
      ok: true,
      configuration: {
        url: "https://clinic.example/api/webhooks/whatsapp",
        headers: {
          Authorization: `Basic ${Buffer.from(
            "clinicflow-user:webhook-secret",
          ).toString("base64")}`,
        },
      },
    });

    await expect(
      runWhatsAppHealthAction({
        clinicId: "clinic-a",
        action: "repair_webhook",
      }),
    ).resolves.toEqual({ ok: true, code: "ok" });
    await expect(
      runWhatsAppHealthAction({
        clinicId: "clinic-a",
        action: "repair_webhook",
      }),
    ).resolves.toEqual({ ok: true, code: "ok" });

    expect(mocks.configureDialogWebhook).not.toHaveBeenCalled();
    expect(mocks.applyHealth).toHaveBeenCalledTimes(2);
    expect(mocks.logEvent).toHaveBeenCalledTimes(2);
    expect(mocks.logEvent).toHaveBeenCalledWith({
      clinicId: "clinic-a",
      event: "health_action",
      recordId: "channel-dialog360",
      summary: {
        action: "repair_webhook",
        provider: "dialog360",
      },
    });
    delete process.env.NEXT_PUBLIC_SITE_URL;
  });
});
