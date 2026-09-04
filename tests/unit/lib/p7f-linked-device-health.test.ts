import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  createScoped: vi.fn(),
  telemetry: vi.fn(),
}));

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({
  createClinicScopedAdminClient: mocks.createScoped,
  applyMessageTemplateProviderStatus: vi.fn(),
  applyWhatsAppWebhookHealth: vi.fn(),
  claimWhatsAppChannelsForHealthCheck: vi.fn(),
  getWhatsAppChannelStateRow: vi.fn(),
  logMessagingEvent: vi.fn(),
}));
vi.mock("@/lib/messaging/webhook-telemetry", () => ({
  getWebhookRouteTelemetry: mocks.telemetry,
}));
vi.mock("@/lib/messaging/crypto", () => ({
  decryptChannelCredentials: vi.fn(),
}));
vi.mock("@/lib/messaging/meta-reconcile", () => ({
  reconcileMetaChannel: vi.fn(),
}));
vi.mock("@/lib/messaging/whatsapp-dialog360", () => ({
  configureDialog360Webhook: vi.fn(),
  fetchDialog360Templates: vi.fn(),
  getDialog360WebhookConfiguration: vi.fn(),
}));
vi.mock("@/lib/messaging/whatsapp-meta", () => ({
  getMetaWabaSubscription: vi.fn(),
  subscribeMetaWabaWebhook: vi.fn(),
  testMetaConnectivity: vi.fn(),
}));

import { getWhatsAppHealthSnapshot } from "@/lib/messaging/health";

type Result = { data: unknown; error: unknown };

function query(result: Result) {
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "eq", "in", "like", "order", "limit"]) {
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

/** The channel row the pairing worker writes when it claims the number. */
function linkedDeviceChannel(overrides: Record<string, unknown> = {}) {
  return {
    id: "channel-linked",
    provider: "linked_device",
    status: "active",
    // Stamped once at claim time and never moved again — which is exactly why
    // health must read the session row for the live state.
    connection_state: "connected",
    last_state_reason: null,
    business_verification_status: null,
    account_review_status: null,
    phone_status: null,
    quality_rating: null,
    messaging_limit_tier: null,
    last_synced_at: null,
    webhook_health_status: "unknown",
    webhook_health_reason: null,
    last_verified_webhook_at: null,
    last_webhook_check_at: null,
    sender_identity: "+201234567890",
    connected_at: "2026-07-28T07:00:00.000Z",
    ...overrides,
  };
}

function session(overrides: Record<string, unknown> = {}) {
  return {
    status: "connected",
    phone_number: "+201234567890",
    connected_at: "2026-07-28T07:00:00.000Z",
    last_heartbeat_at: new Date(Date.now() - 10_000).toISOString(),
    worker_id: "worker-1",
    ...overrides,
  };
}

function linkedDeviceClient(input: {
  channel?: Record<string, unknown>;
  session?: Record<string, unknown> | null;
  sessionError?: unknown;
  inbound?: Result;
  outbound?: Result;
} = {}) {
  return scopedClient({
    clinic_channels: [
      { data: [linkedDeviceChannel(input.channel)], error: null },
    ],
    inbound_messages: [
      input.inbound ?? {
        data: { received_at: "2026-07-28T12:00:00.000Z" },
        error: null,
      },
    ],
    outbound_messages: [
      input.outbound ?? {
        data: {
          status: "delivered",
          status_updated_at: "2026-07-28T11:30:00.000Z",
        },
        error: null,
      },
    ],
    message_template_provider_bindings: [{ data: [], error: null }],
    audit_logs: [{ data: [], error: null }],
    whatsapp_linked_device_sessions: [
      {
        data:
          input.session === null
            ? null
            : session(input.session ?? {}),
        error: input.sessionError ?? null,
      },
    ],
  });
}

function metaChannel(overrides: Record<string, unknown> = {}) {
  return {
    id: "channel-meta",
    provider: "meta",
    status: "active",
    connection_state: "connected",
    last_state_reason: null,
    business_verification_status: null,
    account_review_status: "APPROVED",
    phone_status: "VERIFIED",
    quality_rating: "GREEN",
    messaging_limit_tier: "TIER_1K",
    last_synced_at: "2026-07-28T10:00:00.000Z",
    webhook_health_status: "healthy",
    webhook_health_reason: null,
    last_verified_webhook_at: "2026-07-28T11:00:00.000Z",
    last_webhook_check_at: "2026-07-28T10:30:00.000Z",
    sender_identity: "+201111111111",
    connected_at: "2026-07-20T07:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.telemetry.mockResolvedValue({
    signatureFailures: 2,
    rateLimitRejections: 1,
    windowHours: 24,
  });
});

describe("linked-device WhatsApp health snapshot", () => {
  it("reports a live pairing as a configured, connected channel", async () => {
    mocks.createScoped.mockReturnValue(linkedDeviceClient());

    const snapshot = await getWhatsAppHealthSnapshot("clinic-a");

    expect(snapshot.configured).toBe(true);
    expect(snapshot.provider).toBe("linked_device");
    expect(snapshot.channelStatus).toBe("active");
    expect(snapshot.connectionState).toBe("connected");
    expect(snapshot.linkedDevice).toMatchObject({
      sessionStatus: "connected",
      phoneNumber: "+201234567890",
      workerAssigned: true,
      heartbeat: "online",
    });
    expect(snapshot.readiness.ready).toBe(true);
  });

  it("carries ClinicFlow's own message timestamps", async () => {
    mocks.createScoped.mockReturnValue(linkedDeviceClient());

    const snapshot = await getWhatsAppHealthSnapshot("clinic-a");

    expect(snapshot.lastIncomingAt).toBe("2026-07-28T12:00:00.000Z");
    expect(snapshot.lastOutgoing).toEqual({
      occurredAt: "2026-07-28T11:30:00.000Z",
      status: "delivered",
    });
    expect(
      snapshot.timeline.some((event) => event.type === "inbound"),
    ).toBe(true);
    expect(
      snapshot.timeline.some(
        (event) => event.type === "connection" && event.value === "connected",
      ),
    ).toBe(true);
  });

  it("marks every Meta-only requirement unavailable, never failed", async () => {
    mocks.createScoped.mockReturnValue(linkedDeviceClient());

    const snapshot = await getWhatsAppHealthSnapshot("clinic-a");

    expect(snapshot.meta).toBeNull();
    const byKey = Object.fromEntries(
      snapshot.readiness.checks.map((check) => [check.key, check.status]),
    );
    expect(byKey).toMatchObject({
      channel: "passed",
      session: "passed",
      webhook: "unavailable",
      template: "unavailable",
      business_verification: "unavailable",
      quality: "unavailable",
    });
    expect(
      snapshot.readiness.checks.some((check) => check.status === "failed"),
    ).toBe(false);
  });

  it("does not read the shared provider-callback telemetry for a pairing", async () => {
    mocks.createScoped.mockReturnValue(linkedDeviceClient());

    const snapshot = await getWhatsAppHealthSnapshot("clinic-a");

    expect(mocks.telemetry).not.toHaveBeenCalled();
    expect(snapshot.webhook).toMatchObject({
      status: "unknown",
      lastVerifiedAt: null,
      signatureFailures: null,
      rateLimitRejections: null,
    });
  });

  it("fails readiness when the session is disconnected", async () => {
    mocks.createScoped.mockReturnValue(
      linkedDeviceClient({
        session: {
          status: "disconnected",
          phone_number: null,
          connected_at: null,
          last_heartbeat_at: null,
          worker_id: null,
        },
      }),
    );

    const snapshot = await getWhatsAppHealthSnapshot("clinic-a");

    expect(snapshot.configured).toBe(true);
    expect(snapshot.connectionState).toBe("disconnected");
    expect(snapshot.linkedDevice).toMatchObject({
      sessionStatus: "disconnected",
      heartbeat: "offline",
      workerAssigned: false,
    });
    expect(snapshot.readiness.ready).toBe(false);
    const byKey = Object.fromEntries(
      snapshot.readiness.checks.map((check) => [check.key, check.status]),
    );
    expect(byKey.channel).toBe("failed");
    expect(byKey.session).toBe("failed");
    // A disconnected pairing still must not be blamed for Meta requirements.
    expect(byKey.template).toBe("unavailable");
    expect(byKey.business_verification).toBe("unavailable");
  });

  it("treats a stale worker heartbeat as a failed session while connected", async () => {
    mocks.createScoped.mockReturnValue(
      linkedDeviceClient({
        session: {
          last_heartbeat_at: new Date(Date.now() - 5 * 60_000).toISOString(),
        },
      }),
    );

    const snapshot = await getWhatsAppHealthSnapshot("clinic-a");

    expect(snapshot.linkedDevice?.heartbeat).toBe("stale");
    expect(snapshot.readiness.ready).toBe(false);
    expect(
      snapshot.readiness.checks.find((check) => check.key === "channel")?.status,
    ).toBe("passed");
    expect(
      snapshot.readiness.checks.find((check) => check.key === "session")?.status,
    ).toBe("failed");
  });

  it("falls back to the channel's claimed number when the session row is unreadable", async () => {
    mocks.createScoped.mockReturnValue(
      linkedDeviceClient({ session: null, sessionError: null }),
    );

    const snapshot = await getWhatsAppHealthSnapshot("clinic-a");

    expect(snapshot.linkedDevice).toMatchObject({
      sessionStatus: "not_started",
      phoneNumber: "+201234567890",
      heartbeat: "offline",
    });
    expect(snapshot.readiness.ready).toBe(false);
  });

  it("never emits a phone number that is not E.164-shaped", async () => {
    mocks.createScoped.mockReturnValue(
      linkedDeviceClient({
        channel: { sender_identity: "<script>" },
        session: { phone_number: "not a number" },
      }),
    );

    const snapshot = await getWhatsAppHealthSnapshot("clinic-a");

    expect(snapshot.linkedDevice?.phoneNumber).toBeNull();
  });

  it("prefers the pairing over a leftover Meta row, matching the settings card", async () => {
    mocks.createScoped.mockReturnValue(
      scopedClient({
        clinic_channels: [
          {
            data: [metaChannel({ status: "pending" }), linkedDeviceChannel()],
            error: null,
          },
        ],
        inbound_messages: [{ data: null, error: null }],
        outbound_messages: [{ data: null, error: null }],
        message_template_provider_bindings: [{ data: [], error: null }],
        audit_logs: [{ data: [], error: null }],
        whatsapp_linked_device_sessions: [{ data: session(), error: null }],
      }),
    );

    const snapshot = await getWhatsAppHealthSnapshot("clinic-a");

    expect(snapshot.provider).toBe("linked_device");
    expect(snapshot.meta).toBeNull();
  });
});

describe("Meta health regression under provider-aware selection", () => {
  it("keeps the full Meta signal set, telemetry, and readiness rules", async () => {
    mocks.createScoped.mockReturnValue(
      scopedClient({
        clinic_channels: [{ data: [metaChannel()], error: null }],
        inbound_messages: [{ data: null, error: null }],
        outbound_messages: [{ data: null, error: null }],
        message_template_provider_bindings: [
          { data: [{ approval_status: "approved" }], error: null },
        ],
        audit_logs: [{ data: [], error: null }],
      }),
    );

    const snapshot = await getWhatsAppHealthSnapshot("clinic-a");

    expect(snapshot.provider).toBe("meta");
    expect(snapshot.linkedDevice).toBeNull();
    expect(snapshot.meta).toEqual({
      businessVerificationStatus: null,
      accountReviewStatus: "APPROVED",
      phoneStatus: "VERIFIED",
      qualityRating: "GREEN",
      messagingLimitTier: "TIER_1K",
    });
    expect(mocks.telemetry).toHaveBeenCalledWith("meta");
    expect(snapshot.webhook).toMatchObject({
      status: "healthy",
      lastVerifiedAt: "2026-07-28T11:00:00.000Z",
      signatureFailures: 2,
      rateLimitRejections: 1,
    });
    expect(snapshot.connectionState).toBe("connected");
    expect(snapshot.readiness.ready).toBe(true);
    expect(snapshot.readiness.checks.map((check) => check.key)).toEqual([
      "channel",
      "webhook",
      "template",
      "business_verification",
      "quality",
    ]);
  });

  it("still fails Meta readiness on a degraded quality rating", async () => {
    mocks.createScoped.mockReturnValue(
      scopedClient({
        clinic_channels: [
          { data: [metaChannel({ quality_rating: "RED" })], error: null },
        ],
        inbound_messages: [{ data: null, error: null }],
        outbound_messages: [{ data: null, error: null }],
        message_template_provider_bindings: [
          { data: [{ approval_status: "approved" }], error: null },
        ],
        audit_logs: [{ data: [], error: null }],
      }),
    );

    const snapshot = await getWhatsAppHealthSnapshot("clinic-a");

    expect(snapshot.readiness.ready).toBe(false);
    expect(
      snapshot.readiness.checks.find((check) => check.key === "quality")?.status,
    ).toBe("failed");
  });

  it("still marks Meta-only checks unavailable for 360dialog", async () => {
    mocks.createScoped.mockReturnValue(
      scopedClient({
        clinic_channels: [
          {
            data: [
              metaChannel({
                id: "channel-360",
                provider: "dialog360",
                connection_state: null,
                account_review_status: null,
                phone_status: null,
                quality_rating: null,
                messaging_limit_tier: null,
              }),
            ],
            error: null,
          },
        ],
        inbound_messages: [{ data: null, error: null }],
        outbound_messages: [{ data: null, error: null }],
        message_template_provider_bindings: [
          { data: [{ approval_status: "approved" }], error: null },
        ],
        message_templates: [{ data: null, error: null }],
        audit_logs: [{ data: [], error: null }],
      }),
    );

    const snapshot = await getWhatsAppHealthSnapshot("clinic-a");

    expect(snapshot.provider).toBe("dialog360");
    expect(snapshot.meta).toBeNull();
    expect(snapshot.linkedDevice).toBeNull();
    expect(mocks.telemetry).toHaveBeenCalledWith("dialog360");
    expect(snapshot.readiness.ready).toBe(true);
    const byKey = Object.fromEntries(
      snapshot.readiness.checks.map((check) => [check.key, check.status]),
    );
    expect(byKey).toMatchObject({
      channel: "passed",
      webhook: "passed",
      template: "passed",
      business_verification: "unavailable",
      quality: "unavailable",
    });
  });
});
